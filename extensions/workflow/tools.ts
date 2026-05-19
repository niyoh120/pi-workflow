import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadState, saveState, writeNewPlan, readPlan, writePlanReview } from "./state.js";
import { loadConfig } from "./config.js";
import { todoText } from "./helpers.js";
import type { WorkflowState } from "./types.js";

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
              text: "Plan approved. Worker handoff will start after this turn.",
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
