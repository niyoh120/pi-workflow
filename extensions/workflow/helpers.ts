import type { Mode, WorkflowState } from "./types.js";
import { promptForMode } from "./prompts.js";

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

/** Build the current workflow status text block for runtime message/tool-result injection. */
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

/** Build the mode-specific workflow runtime message body. */
export function buildModeMessageBody(
	mode: Mode,
	state: WorkflowState,
): string | undefined {
	const modePrompt = promptForMode(mode);
	if (!modePrompt) return undefined;

	return [
		modePrompt,
		"# Current Workflow State",
		currentStatusText(state),
	].join("\n\n");
}

/** Build the hidden workflow mode custom message injected before model calls. */
export function buildWorkflowModeMessage(
	mode: Mode,
	state: WorkflowState,
): { customType: string; content: string; display: boolean } | undefined {
	const content = buildModeMessageBody(mode, state);
	if (!content) return undefined;

	return {
		customType: "workflow-mode",
		content,
		display: false,
	};
}
