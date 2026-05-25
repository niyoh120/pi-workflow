import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getSessionKey, loadState, saveState, writeNewPlan, readPlan, writePlanReview } from "./state.js";
import { loadConfig } from "./config.js";
import { todoText } from "./helpers.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState, SubagentRole, WorkStatus } from "./types.js";
import type { SubagentsClient } from "./subagent.js";
import { formatSubagentFailure } from "./subagent.js";
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
      const sessionKey = getSessionKey(ctx.sessionManager);
      const state = loadState(ctx.cwd, sessionKey);
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

      saveState(ctx.cwd, sessionKey, state);

      const overlay = getWorkflowOverlay();
      if (overlay) overlay.update(state.todos);

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
      const sessionKey = getSessionKey(ctx.sessionManager);
      const state = loadState(ctx.cwd, sessionKey);
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
        state.planReviewLoops = 0;
        state.planReviewNotes = undefined;
        state.planPath = planPath;
        state.planReviewPath = planReviewPath;
        saveState(ctx.cwd, sessionKey, state);

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
        saveState(ctx.cwd, sessionKey, state);

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
        saveState(ctx.cwd, sessionKey, state);

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
        saveState(ctx.cwd, sessionKey, state);

        return {
          content: [{ type: "text", text: "Plan review recorded: FAIL." }],
          details: { state },
        };
      }

      if (action === "read") {
        if (!state.planPath) {
          return {
            content: [{ type: "text", text: "No active plan. Path: none." }],
            details: { state },
          };
        }

        const text = readPlan(ctx.cwd, state.planPath);

        return {
          content: [
            {
              type: "text",
              text: `Plan path: ${state.planPath}\n\n${text}`,
            },
          ],
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
        saveState(ctx.cwd, sessionKey, cleared);

        const overlay = getWorkflowOverlay();
        if (overlay) overlay.dispose();

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

export function registerSubagentTool(
  pi: ExtensionAPI,
  getAgentDir: () => string,
  getSubagentsClient: () => SubagentsClient
): void {
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
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd, getAgentDir());
      const client = getSubagentsClient();

      // Client is always non-null after init. Detection happens inside run().

      const role = params.role as SubagentRole;
      const task = params.task as string;
      const rawContext = (params.context as string | undefined) ?? "";
      const instructions = (params.instructions as string | undefined) ?? "";

      // Build full task text: context + task
      let fullTask = task;
      if (rawContext.trim()) {
        fullTask = `Context provided by parent:\n${rawContext.trim()}\n\nTask:\n${task}`;
      }

      // Get isolated system prompt
      const systemPrompt = promptForSubagentRole(role);
      if (!systemPrompt) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown subagent role: ${role}` }],
        };
      }

      try {
        const result = await client.run({
          role,
          task: fullTask,
          systemPrompt,
          instructions,
          subagentConfig: config.subagent,
          modelSpec: config.models[role],
          signal,
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
        });

        if (result.exitCode !== 0) {
          const diag = formatSubagentFailure(result);
          return {
            content: [{ type: "text", text: diag }],
            details: { result },
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: result.text || "(empty response)" }],
          details: { result },
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Subagent execution error: ${err.message ?? String(err)}`,
            },
          ],
        };
      }
    },
  });
}

// ── workflow_status tool ────────────────────────

const WorkStatusSchema = StringEnum(["ready_for_review", "blocked"] as const);

export function registerWorkflowStatusTool(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerTool({
    name: "workflow_status",
    label: "Workflow Status",
    description:
      "Report the completion status of the current Work/Fix run. Must be called at the end of Work/Fix mode to trigger automatic code review. Status: ready_for_review (all tasks done) or blocked (needs user intervention).",
    promptSnippet:
      "workflow_status: report work completion status — ready_for_review or blocked.",
    promptGuidelines: [
      "You MUST call workflow_status at the end of Work/Fix mode with either ready_for_review or blocked.",
      "Call workflow_status({ status: 'ready_for_review', runId: currentRunId, summary: '...', tests: '...' }) when all planned tasks are complete.",
      "Call workflow_status({ status: 'blocked', runId: currentRunId, error: '...' }) when blocked by missing info, dependencies, or unresolvable issues.",
      "The runId parameter MUST match the current state.workRunId displayed in the workflow state.",
      "Do NOT print WORK_STATUS: ... in text — this tool is the only trigger for auto review.",
    ],
    parameters: Type.Object({
      status: WorkStatusSchema,
      runId: Type.String({ description: "The current workRunId from the workflow state. Must match exactly." }),
      summary: Type.Optional(Type.String()),
      tests: Type.Optional(Type.String()),
      error: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionKey = getSessionKey(ctx.sessionManager);
      const state = loadState(ctx.cwd, sessionKey);
      const config = loadConfig(ctx.cwd, getAgentDir());
      const runId = params.runId as string;

      // Only valid in work or fix mode.
      if (state.mode !== "work" && state.mode !== "fix") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `workflow_status is only valid in Work or Fix mode (current: ${state.mode}). ` +
                `Report completion directly if in another mode.`,
            },
          ],
          details: { state },
        };
      }

      // Validate run id: the tool must be called for the current work run.
      if (!state.workRunId) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "No active work run. workflow_status requires a current workRunId. " +
                "Enter Work/Fix mode first.",
            },
          ],
          details: { state },
        };
      }

      // Reject stale run IDs
      if (runId !== state.workRunId) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Stale run ID rejected. Provided: ${runId.slice(-8)}…, current: ${state.workRunId.slice(-8)}…. ` +
                `This workflow_status call belongs to a previous Work/Fix run and has been ignored. ` +
                `Re-call with the current run ID from the workflow state.`,
            },
          ],
          details: { state },
        };
      }

      const status = params.status as WorkStatus;

      // Reset code-review loop counter at the start of a new automatic review
      // sequence triggered by Work mode (not Fix mode retries).
      if (status === "ready_for_review" && state.mode === "work") {
        state.codeReviewLoops = 0;
      }

      state.workStatus = status;
      state.workStatusRunId = state.workRunId;
      state.workStatusSummary = (params.summary as string | undefined) ?? "";
      state.workStatusTests = (params.tests as string | undefined) ?? "";
      state.workStatusError = (params.error as string | undefined) ?? "";
      state.workStatusUpdatedAt = new Date().toISOString();
      saveState(ctx.cwd, sessionKey, state);

      const modeLabel = state.mode === "fix" ? "Fix Mode" : "Work Mode";

      return {
        content: [
          {
            type: "text",
            text:
              `${modeLabel} status recorded: ${status.toUpperCase()}.\n` +
              `Run: ${state.workRunId.slice(-8)}.\n` +
              (state.workStatusSummary ? `Summary: ${state.workStatusSummary}\n` : "") +
              (state.workStatusTests ? `Tests: ${state.workStatusTests}\n` : "") +
              (state.workStatusError ? `Error: ${state.workStatusError}\n` : ""),
          },
        ],
        details: { state },
      };
    },
  });
}
