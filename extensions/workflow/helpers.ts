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

/** Map internal mode to user-visible label for TUI status. */
export function modeLabel(mode: string): string {
  const labels: Record<string, string> = {
    plan: "Plan Mode",
    planReview: "Plan Review Mode",
    workPending: "Work Pending",
    work: "Work Mode",
    fix: "Fix Mode",
    review: "Code Review Mode",
    commit: "Commit Mode",
  };
  return labels[mode] ?? mode;
}

/** Build the current workflow status text block to inject into the system prompt. */
export function currentStatusText(
  config: { planReview: { enabled: boolean; maxLoops: number }; codeReview: { enabled: boolean; maxLoops: number } },
  s: WorkflowState
): string {
  const workStatusText = s.workStatus
    ? `${s.workStatus}${s.workStatusError ? ` | error: ${s.workStatusError}` : ""}${s.workStatusSummary ? ` | summary: ${s.workStatusSummary}` : ""}`
    : "none";

  const pendingInfo = s.pendingWorkHandoff && s.pendingWorkHandoff.id
    ? `pendingHandoff: id=${s.pendingWorkHandoff.id.slice(-8)} planPath=${s.pendingWorkHandoff.planPath ?? "?"} createdAt=${s.pendingWorkHandoff.createdAt ?? "?"} expiresAt=${s.pendingWorkHandoff.expiresAt ?? "?"} workRunId=${s.pendingWorkHandoff.workRunId?.slice(-8) ?? "?"}`
    : "pendingHandoff: none";

  return [
    `mode: ${s.mode}`,
    `planPath: ${s.planPath ?? "none"}`,
    `planRunId: ${s.planRunId ?? "none"}`,
    `planApproved: ${s.planApproved}`,
    `planReviewEnabled: ${config.planReview.enabled}`,
    `planReviewStatus: ${s.planReviewStatus}`,
    `planReviewLoops: ${s.planReviewLoops}/${config.planReview.maxLoops}`,
    `autoCodeReview: ${s.autoCodeReview}`,
    `workRunId: ${s.workRunId ?? "none"}`,
    `codeReviewLoops: ${s.codeReviewLoops}/${config.codeReview.maxLoops}`,
    `lastReviewStatus: ${s.lastReviewStatus ?? "none"}`,
    `workStatus: ${workStatusText}`,
    pendingInfo,
    "",
    "todos:",
    todoText(s),
  ].join("\n");
}
