import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadState, saveState, writeNewPlan, readPlan, writePlanReview } from "./state.js";
import { loadConfig } from "./config.js";
import { todoText } from "./helpers.js";
import type { WorkflowState, SubagentRole, ModelSpec } from "./types.js";
import { runSubagent } from "./subagent.js";
import { promptForSubagentRole } from "./prompts.js";

const TodoStatusSchema = StringEnum([
  "pending",
  "in_progress",
  "done",
  "blocked",
] as const);

export function registerTodoTool(pi: ExtensionAPI, getAgentDir: () => string): void {
  pi.registerTool({
    name: "workflow_todo",
    label: "Workflow Todo",
    description:
      "Maintain the lightweight workflow todo list for plan/work/review alignment.",
    promptSnippet:
      "workflow_todo: maintain the workflow todo list so implementation stays aligned with the plan.",
    promptGuidelines: [
      "Use workflow_todo to create and update the task list before and during implementation.",
      "Use workflow_todo status updates to keep implementation aligned with the approved plan.",
    ],
    parameters: Type.Object({
      action: StringEnum(["reset", "add", "set", "list"] as const),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.Optional(Type.String()),
            title: Type.String(),
            status: Type.Optional(TodoStatusSchema),
            notes: Type.Optional(Type.String()),
          })
        )
      ),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      status: Type.Optional(TodoStatusSchema),
      notes: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx.cwd);
      const agentDir = getAgentDir();

      if (params.action === "reset") {
        state.todos = (params.items ?? []).map((item: any, index: number) => ({
          id: item.id || `T${index + 1}`,
          title: item.title,
          status: item.status ?? "pending",
          notes: item.notes,
        }));
      }

      if (params.action === "add") {
        if (!params.title) {
          return {
            isError: true,
            content: [{ type: "text", text: "workflow_todo add requires title." }],
            details: { todos: state.todos },
          };
        }

        state.todos.push({
          id: params.id ?? `T${state.todos.length + 1}`,
          title: params.title,
          status: params.status ?? "pending",
          notes: params.notes,
        });
      }

      if (params.action === "set") {
        const item = state.todos.find((todo) => todo.id === params.id);
        if (!item) {
          return {
            isError: true,
            content: [{ type: "text", text: `Todo not found: ${params.id}` }],
            details: { todos: state.todos },
          };
        }

        if (params.title) item.title = params.title;
        if (params.status) item.status = params.status;
        if (params.notes !== undefined) item.notes = params.notes;
      }

      saveState(ctx.cwd, state);

      return {
        content: [{ type: "text", text: todoText(state) }],
        details: { todos: state.todos },
      };
    },
  });
}

type WorkflowPlanParams = {
  action: "save" | "approve" | "review_pass" | "review_fail" | "read" | "clear";
  title?: string;
  markdown?: string;
  reviewNotes?: string;
};

export function registerPlanTool(pi: ExtensionAPI, getAgentDir: () => string): void {
  pi.registerTool({
    name: "workflow_plan",
    label: "Workflow Plan",
    description:
      "Save, review, approve, read, or clear the active lightweight workflow plan.",
    promptSnippet:
      "workflow_plan: save the active plan, record plan-review results, or approve the plan for implementation.",
    promptGuidelines: [
      "Use workflow_plan save after producing a final implementation plan.",
      "Use workflow_plan approve only after the user explicitly confirms the final plan.",
      "Use workflow_plan review_pass or review_fail only in Plan Review Mode.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "save",
        "approve",
        "review_pass",
        "review_fail",
        "read",
        "clear",
      ] as const),
      title: Type.Optional(Type.String()),
      markdown: Type.Optional(Type.String()),
      reviewNotes: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx.cwd);
      const config = loadConfig(ctx.cwd, getAgentDir());
      const { action } = params as WorkflowPlanParams;

      if (action === "save") {
        if (!params.markdown) {
          return {
            isError: true,
            content: [
              { type: "text", text: "workflow_plan save requires markdown." },
            ],
            details: { state },
          };
        }

        const { planPath, planReviewPath } = writeNewPlan(
          ctx.cwd,
          state,
          params.markdown
        );

        state.planTitle = params.title ?? "Active Plan";
        state.planApproved = false;
        state.planReviewStatus = config.planReview.enabled ? "pending" : "none";
        state.planReviewNotes = undefined;
        state.planPath = planPath;
        state.planReviewPath = planReviewPath;
        saveState(ctx.cwd, state);

        return {
          content: [
            {
              type: "text",
              text: `Plan saved to ${state.planPath}. Plan review status: ${state.planReviewStatus}.`,
            },
          ],
          details: { state },
        };
      }

      if (action === "approve") {
        if (!state.planPath) {
          return {
            isError: true,
            content: [{ type: "text", text: "No active plan. Save a plan first." }],
            details: { state },
          };
        }

        if (config.planReview.enabled && state.planReviewStatus !== "pass") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Plan review is enabled but status is ${state.planReviewStatus}. ` +
                  `Wait for review_pass, revise the plan, or use /go --force manually.`,
              },
            ],
            details: { state },
          };
        }

        state.planApproved = true;
        saveState(ctx.cwd, state);

        return {
          content: [
            {
              type: "text",
              text: "Plan approved. Work Mode will start after this turn.",
            },
          ],
          details: { state },
        };
      }

      if (action === "review_pass") {
        state.planReviewStatus = "pass";
        state.planReviewNotes = params.reviewNotes ?? "Plan review passed.";
        if (state.planReviewPath) {
          writePlanReview(ctx.cwd, state.planReviewPath, state.planReviewNotes);
        }
        saveState(ctx.cwd, state);

        return {
          content: [{ type: "text", text: "Plan review recorded: PASS." }],
          details: { state },
        };
      }

      if (action === "review_fail") {
        state.planReviewStatus = "fail";
        state.planReviewLoops += 1;
        state.planReviewNotes = params.reviewNotes ?? "Plan review failed.";
        if (state.planReviewPath) {
          writePlanReview(ctx.cwd, state.planReviewPath, state.planReviewNotes);
        }
        saveState(ctx.cwd, state);

        return {
          content: [{ type: "text", text: "Plan review recorded: FAIL." }],
          details: { state },
        };
      }

      if (action === "read") {
        if (!state.planPath) {
          return {
            content: [{ type: "text", text: "No active plan." }],
            details: { state },
          };
        }

        const text = readPlan(ctx.cwd, state.planPath);

        return {
          content: [{ type: "text", text }],
          details: { state },
        };
      }

      if (action === "clear") {
        const cleared: WorkflowState = {
          mode: "idle",
          planApproved: false,
          planReviewStatus: "none",
          planReviewLoops: 0,
          codeReviewLoops: 0,
          autoCodeReview: false,
          todos: [],
        };
        saveState(ctx.cwd, cleared);

        return {
          content: [{ type: "text", text: "Workflow state cleared." }],
          details: { state: cleared },
        };
      }

      return {
        content: [{ type: "text", text: "Unknown workflow_plan action." }],
        details: { state },
      };
    },
  });
}

// ── workflow_subagent tool ─────────────────────

const SubagentRoleSchema = StringEnum([
  "planReview",
  "review",
  "explore",
] as const);

export function registerSubagentTool(pi: ExtensionAPI, getAgentDir: () => string): void {
  pi.registerTool({
    name: "workflow_subagent",
    label: "Workflow Subagent",
    description:
      "Spawn a role-shaped, read-only child Pi process with no parent session history. Supported roles: planReview (isolated plan review), review (isolated code review), explore (fast read-only codebase exploration). Child returns a structured result with text, status marker, exit code, and usage.",
    promptSnippet:
      "workflow_subagent: spawn a read-only child Pi process to handle review or exploration with a clean session. The child has no parent context — pass everything it needs explicitly.",
    promptGuidelines: [
      "Use workflow_subagent to get an objective review or explore the codebase without parent session history.",
      "Provide role (planReview, review, or explore), task, and relevant context.",
      "Use instructions for extra preferences (depth, format, focus).",
    ],
    parameters: Type.Object({
      role: SubagentRoleSchema,
      task: Type.String({
        description: "The focused task for the subagent.",
      }),
      context: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      modelRole: Type.Optional(
        StringEnum(["planReview", "review", "explore"] as const)
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd, getAgentDir());

      if (!config.subagent.enabled) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "workflow_subagent is disabled in configuration. Set subagent.enabled to true.",
            },
          ],
        };
      }

      const role = params.role as SubagentRole;
      const task = params.task as string;
      const rawContext = (params.context as string | undefined) ?? "";
      const instructions = (params.instructions as string | undefined) ?? "";
      const modelRole = (params.modelRole as SubagentRole | undefined) ?? role;

      // Build full task text: context + task
      let fullTask = task;
      if (rawContext.trim()) {
        fullTask = `Context provided by parent:\n${rawContext.trim()}\n\nTask:\n${task}`;
      }

      // Resolve model spec
      const modelSpec: ModelSpec | undefined =
        config.models[modelRole as keyof typeof config.models];

      // Get isolated system prompt
      const systemPrompt = promptForSubagentRole(role);
      if (!systemPrompt) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Unknown subagent role: ${role}` },
          ],
        };
      }

      // Set env for child-safe mode: PI_WORKFLOW_SUBAGENT=<role>
      const env: Record<string, string | undefined> = {
        PI_WORKFLOW_SUBAGENT: role,
      };

      const result = await runSubagent({
        cwd: ctx.cwd,
        role,
        task: fullTask,
        systemPrompt,
        modelSpec,
        subagentConfig: config.subagent,
        instructions,
        env,
        signal,
      });

      if (result.exitCode !== 0 && !result.text) {
        const text =
          `Subagent "${role}" failed (exit ${result.exitCode}).` +
          (result.stderr
            ? `\n\nstderr:\n${result.stderr.trim().slice(-2000)}`
            : "");
        return {
          content: [{ type: "text", text }],
          details: { result },
          isError: true,
        };
      }

      return {
        content: [
          { type: "text", text: result.text || "(empty response)" },
        ],
        details: { result },
      };
    },
  });
}

// ── Child-safe readonly guard (registered in child-safe mode) ──

/**
 * Register a minimal readonly guard for child-safe mode.
 * This is the ONLY hook registered when PI_WORKFLOW_SUBAGENT is set.
 * It blocks write/edit/mutating bash, allowing only reads and analysis.
 */
export function registerReadonlyGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    // Block write and edit
    if (event.toolName === "write" || event.toolName === "edit") {
      return {
        block: true,
        reason:
          "Read-only subagent mode: write and edit are disabled. Use read-only tools only (read, search, glob, grep, etc.).",
      };
    }

    // Block mutating bash commands
    if (event.toolName === "bash") {
      const command = String(event.input?.command ?? "");

      // Patterns that modify files
      const mutatingPatterns = [
        /^rm\b/,
        /^mv\b/,
        /^cp\b/,
        /^touch\b/,
        /^mkdir\b/,
        /^rmdir\b/,
        /^chmod\b/,
        /^chown\b/,
        /^ln\b/,
        /^truncate\b/,
        /\bprettier\b.*\s--write\b/,
        /\beslint\b.*\s--fix\b/,
        /\bruff\b.*\s--fix\b/,
        /\bblack\b/,
        /\bgofmt\b.*\s-w\b/,
        /\brustfmt\b/,
        /^npm\s+(install|i|add|update|dedupe|link|uninstall|remove|rm)\b/,
        /^pnpm\s+(install|add|update|link|remove|rm)\b/,
        /^yarn\s+(install|add|upgrade|link|remove)\b/,
        /^bun\s+(install|add|update|remove|rm)\b/,
        /^pip\s+install\b/,
        /^uv\s+add\b/,
        /^poetry\s+add\b/,
        /^cargo\s+add\b/,
        /^go\s+get\b/,
        /^git\s+(add|commit|checkout|switch|reset|clean|apply|restore|merge|rebase|cherry-pick|stash|tag|push)\b/,
        /^git\s+branch\s+(-d|-D|-m)\b/,
      ];

      // Shell redirection and heredoc
      if (/(^|[^<])>\s*[^&]/.test(command)) {
        return {
          block: true,
          reason:
            "Read-only subagent mode: shell redirection (>) is disabled. Use grep, cat, find, etc. for reading only.",
        };
      }
      if (/>>\s*/.test(command)) {
        return {
          block: true,
          reason:
            "Read-only subagent mode: shell append (>>) is disabled.",
        };
      }
      if (/<<-?\s*\w/.test(command)) {
        return {
          block: true,
          reason:
            "Read-only subagent mode: heredoc (<<) is disabled.",
        };
      }
      if (/\bapply_patch\b/.test(command)) {
        return {
          block: true,
          reason:
            "Read-only subagent mode: apply_patch is disabled.",
        };
      }
      if (/\|\s*tee\b/.test(command)) {
        return {
          block: true,
          reason:
            "Read-only subagent mode: tee is disabled.",
        };
      }

      const isMutating = mutatingPatterns.some((re) => re.test(command));
      if (isMutating) {
        return {
          block: true,
          reason: `Read-only subagent mode: mutating command blocked: ${command}`,
        };
      }
    }

    // Allow all other tools through (read, search, glob, grep, etc.)
  });
}
