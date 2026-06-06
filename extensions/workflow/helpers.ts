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

/** Map internal mode to user-visible label. */
export function modeLabel(mode: string): string {
	const labels: Record<string, string> = {
		idle: "Idle",
		explore: "Explore Mode",
		plan: "Plan Mode",
		work: "Work Mode",
		commit: "Commit Mode",
	};
	return labels[mode] ?? mode;
}

/** Map internal mode to a compact TUI status label. */
export function modeStatusLabel(mode: string): string {
	const labels: Record<string, string> = {
		idle: "○ Idle",
		explore: "🔎 Explore",
		plan: "🧭 Plan",
		work: "⚒ Work",
		commit: "🚀 Commit",
	};
	return labels[mode] ?? mode;
}

/** Build the current workflow status text block to inject into the system prompt. */
export function currentStatusText(s: WorkflowState): string {
	return [
		`mode: ${s.mode}`,
		`planPath: ${s.planPath ?? "none"}`,
		`planRunId: ${s.planRunId ?? "none"}`,
		`workRunId: ${s.workRunId ?? "none"}`,
		"",
		"todos:",
		todoText(s),
	].join("\n");
}
