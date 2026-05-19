import type { WorkflowState } from "./types.js";

/** Format todos as a markdown checklist string. */
export function todoText(s: WorkflowState): string {
  if (s.todos.length === 0) return "当前没有 todo。";

  return s.todos
    .map((item) => {
      const notes = item.notes ? ` — ${item.notes}` : "";
      return `- [${item.status}] ${item.id}: ${item.title}${notes}`;
    })
    .join("\n");
}

/** Build the current workflow status text block to inject into the system prompt. */
export function currentStatusText(
  config: { planReview: { enabled: boolean; maxLoops: number }; codeReview: { enabled: boolean; maxLoops: number } },
  s: WorkflowState
): string {
  return [
    `mode: ${s.mode}`,
    `planPath: ${s.planPath ?? "none"}`,
    `planApproved: ${s.planApproved}`,
    `planReviewEnabled: ${config.planReview.enabled}`,
    `planReviewStatus: ${s.planReviewStatus}`,
    `planReviewLoops: ${s.planReviewLoops}/${config.planReview.maxLoops}`,
    `autoCodeReview: ${s.autoCodeReview}`,
    `codeReviewLoops: ${s.codeReviewLoops}/${config.codeReview.maxLoops}`,
    "",
    "todos:",
    todoText(s),
  ].join("\n");
}
