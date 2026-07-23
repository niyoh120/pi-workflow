import type { Mode, WorkflowState } from "./types.js";
import { promptForMode } from "./prompts.js";

/**
 * Exhaustiveness check for closed unions (typically `Mode`).
 * Place at the `default` branch of a switch over a closed union so the
 * compiler flags any unhandled member when the union grows.
 */
export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}

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
export function modeLabel(mode: Mode): string {
	switch (mode) {
		case "idle":
			return "Idle";
		case "explore":
			return "Explore Mode";
		case "init":
			return "Init Mode";
		case "plan":
			return "Plan Mode";
		case "work":
			return "Work Mode";
		case "commit":
			return "Commit Mode";
		default:
			return assertNever(mode);
	}
}

/** Map internal mode to a compact TUI status label. */
export function modeStatusLabel(mode: Mode): string {
	switch (mode) {
		case "idle":
			return "○ Idle";
		case "explore":
			return "🔎 Explore";
		case "init":
			return "⚙ Init";
		case "plan":
			return "🧭 Plan";
		case "work":
			return "⚒ Work";
		case "commit":
			return "🚀 Commit";
		default:
			return assertNever(mode);
	}
}

/** Build the current workflow status text block for runtime message/tool-result injection. */
export function currentStatusText(s: WorkflowState): string {
	return [
		`mode: ${s.mode}`,
		`planPath: ${s.planPath ?? "none"}`,
		`planRunId: ${s.planRunId ?? "none"}`,
		`workRunId: ${s.workRunId ?? "none"}`,
		`worktreePath: ${s.worktreePath ? promptLine(s.worktreePath) : "none"}`,
		`worktreeBranch: ${s.worktreeBranch ? promptLine(s.worktreeBranch) : "none"}`,
		`initReturnMode: ${s.initReturnMode ?? "none"}`,
		`initTargetPath: ${s.initTargetPath ? promptLine(s.initTargetPath) : "none"}`,
		"",
		"todos:",
		todoText(s),
	].join("\n");
}

function promptLine(value: string): string {
	return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function worktreeRuntimeNotice(state: WorkflowState): string {
	if (!state.worktreePath) return "";
	const displayWorktreePath = promptLine(state.worktreePath);
	return [
		"# Active Git Worktree",
		`工作目录：${displayWorktreePath}`,
		state.worktreeBranch ? `分支：${promptLine(state.worktreeBranch)}` : undefined,
		"所有文件工具 read/edit/write 必须使用 worktree 下的绝对路径。",
		"bash 已自动在 active worktree 中执行；直接使用 bash 即可。",
		"代码改动只写入 worktree；不要写主目录文件。",
	]
		.filter(Boolean)
		.join("\n");
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
		worktreeRuntimeNotice(state),
		"# Current Workflow State",
		currentStatusText(state),
	]
		.filter(Boolean)
		.join("\n\n");
}
