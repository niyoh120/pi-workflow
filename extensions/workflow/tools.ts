import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import crypto from "node:crypto";
import { getSessionKey, loadState, saveState, writeNewPlan, updatePlan, readPlan } from "./state.js";
import { loadConfig } from "./config.js";
import { todoText } from "./helpers.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import { createWorkBaseline, captureBaselineUntracked } from "./baseline.js";
import type { WorkflowState } from "./types.js";
import { executePlanReviewSidecall } from "./sidecall.js";

const TodoStatusSchema = StringEnum([
  "pending",
  "in_progress",
  "done",
  "blocked",
] as const);

// ── workflow_todo tool ────────────────────────────────────

export function registerTodoTool(pi: ExtensionAPI, getAgentDir: () => string): void {
  pi.registerTool({
    name: "workflow_todo",
    label: "Workflow Todo",
    description:
      "Maintain the lightweight workflow todo list for plan/work alignment.",
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

      if (params.action === "reset") {
        const overlay = getWorkflowOverlay();
        if (overlay) overlay.clearBookkeeping();

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

// ── workflow_plan tool ────────────────────────────────────

export function registerPlanTool(pi: ExtensionAPI, getAgentDir: () => string): void {
  pi.registerTool({
    name: "workflow_plan",
    label: "Workflow Plan",
    description:
      "Save, approve, read, or clear the active workflow plan.",
    promptSnippet:
      "workflow_plan: save the active plan or approve it for implementation.",
    promptGuidelines: [
      "Use workflow_plan save after producing a final implementation plan.",
      "Use workflow_plan approve only after the user explicitly confirms the final plan.",
      "Use workflow_plan read to view the current plan.",
      "Use workflow_plan clear to reset workflow state.",
    ],
    parameters: Type.Object({
      action: StringEnum(["save", "approve", "read", "clear"] as const),
      title: Type.Optional(Type.String()),
      markdown: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionKey = getSessionKey(ctx.sessionManager);
      const state = loadState(ctx.cwd, sessionKey);
      const { action } = params;

      if (action === "save") {
        if (!params.markdown) {
          return {
            isError: true,
            content: [{ type: "text", text: "workflow_plan save requires markdown." }],
            details: { state },
          };
        }

        // Distinguish first save (new plan) vs revision save (update existing plan)
        const isRevision = !!state.planPath;
        if (isRevision) {
          // Revision: update existing plan file in-place
          updatePlan(ctx.cwd, state.planPath!, params.markdown);
          state.planTitle = params.title ?? state.planTitle ?? "Active Plan";
        } else {
          // First save: create new plan file
          const planPath = writeNewPlan(ctx.cwd, params.markdown);
          state.planPath = planPath;
          state.planTitle = params.title ?? "Active Plan";
          state.planRunId = crypto.randomUUID();
        }

        saveState(ctx.cwd, sessionKey, state);

        const overlay = getWorkflowOverlay();
        if (overlay) {
          overlay.clearBookkeeping();
          overlay.update(state.todos);
        }

        return {
          content: [
            {
              type: "text",
              text: isRevision
                ? `Plan updated at ${state.planPath}.`
                : `Plan created at ${state.planPath}.`,
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

        if (state.mode !== "plan") {
          return {
            isError: true,
            content: [{ type: "text", text: `Approve only allowed in Plan Mode (current: ${state.mode}).` }],
            details: { state },
          };
        }

        // Direct transition: plan → work (no handoff mechanism)
        state.mode = "work";
        state.workRunId = crypto.randomUUID();
        // Capture baseline for code review diff scope
        state.workBaselineRef = createWorkBaseline(ctx.cwd);
        state.workBaselineUntracked = captureBaselineUntracked(ctx.cwd);

        saveState(ctx.cwd, sessionKey, state);

        return {
          content: [
            {
              type: "text",
              text:
                `Plan approved. Transitioning to Work Mode.\n` +
                `Work run: ${state.workRunId.slice(-8)}.\n` +
                `Baseline: ${state.workBaselineRef ?? "none"}.\n` +
                `The next turn will activate Work Mode runtime (model/tools/status).`,
            },
          ],
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
          todos: [],
          hiddenDoneIds: [],
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

// ── workflow_subagent tool (sidecall-based) ─────────────────

/** Only planReview role remains — review and explore removed. */
const SubagentRoleSchema = StringEnum(["planReview"] as const);

export function registerSubagentTool(
  pi: ExtensionAPI,
  getAgentDir: () => string,
): void {
  pi.registerTool({
    name: "workflow_subagent",
    label: "Workflow Plan Review",
    description:
      "Request an independent plan review from a separately-configured reviewer model via a single LLM side-call. The reviewer receives the full plan text plus auto-extracted key file snippets, conversation summary, and tool inventory. Returns structured feedback with Critical/Important/Minor severity ratings.",
    promptSnippet:
      "workflow_subagent: get an objective plan review from a reviewer model.",
    promptGuidelines: [
      "Use workflow_subagent (role=planReview) to get an objective plan review after saving a plan.",
      "Provide the plan content or a brief task description.",
      "Use context for extra background (user constraints, discussion points).",
      "Use instructions for review preferences (depth, focus areas).",
    ],
    parameters: Type.Object({
      role: SubagentRoleSchema,
      task: Type.String({
        description: "Description of what to review (plan content or brief summary).",
      }),
      context: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd, getAgentDir());

      // Read the active plan from file if available
      const state = loadState(ctx.cwd, getSessionKey(ctx.sessionManager));
      const planMarkdown = state.planPath
        ? readPlan(ctx.cwd, state.planPath)
        : params.task;

      if (!planMarkdown) {
        return {
          isError: true,
          content: [{ type: "text", text: "No plan content to review. Save a plan first or provide task text." }],
          details: {},
        };
      }

      const extraContext = [
        (params.context as string | undefined) ?? "",
        (params.instructions as string | undefined) ?? "",
      ].filter(Boolean).join("\n\n");

      return executePlanReviewSidecall(ctx, pi, {
        planMarkdown,
        extraContext: extraContext || undefined,
        modelSpec: config.models.planReview,
        signal,
      });
    },
  });
}