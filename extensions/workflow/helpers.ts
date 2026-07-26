import type { Mode, WorkflowState } from "./types.js";
import { promptForMode } from "./prompts.js";

// ── Work handoff ─────────────────────────────────────────────────────────────

/**
 * Custom message type marking the Plan → Work isolation boundary.
 *
 * Persisted to the session as a hidden custom message by the agent_settled
 * dispatcher. The `details.workRunId` and `details.boundary` fields identify
 * the canonical marker for context slicing.
 */
export const WORK_HANDOFF_CUSTOM_TYPE = "workflow-work-handoff";

/**
 * Non-LLM custom entry type for the approval journal. Stores the immutable
 * handoff body at approval time so the dispatcher and compaction fallback
 * can reconstruct the canonical marker without re-reading the plan file.
 */
export const WORK_APPROVAL_CUSTOM_TYPE = "workflow-work-approval";

/** Data shape stored in the approval journal entry. */
export interface WorkApprovalData {
	workRunId: string;
	handoffBody: string;
}

/**
 * Build the static Approved-Plan Work handoff body at approval time.
 * Contains only immutable content: run metadata, worktree notice, and the
 * Final Plan snapshot. No todo snapshot, no dynamic state, no timestamps.
 * The full execution priority lives in WORK_PROMPT (system prompt).
 */
export function buildWorkHandoffBody(
	state: WorkflowState,
	planMarkdown: string,
): string {
	const header = [
		"# Approved-Plan Work Handoff",
		`planPath: ${state.planPath ?? "none"}`,
		`workRunId: ${state.workRunId ?? "none"}`,
	]
		.filter(Boolean)
		.join("\n");

	const worktree = worktreeRuntimeNotice(state);

	return [
		header,
		worktree || undefined,
		"",
		"以下为本次 Work 的 approved 计划契约与隔离边界。",
		"",
		"# Final Plan",
		planMarkdown.trim() || "(空)",
	]
		.filter(Boolean)
		.join("\n");
}

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

/**
 * Build the stable mode-specific system prompt body.
 * Contains only the Mode Prompt and worktree notice — no dynamic state,
 * no todos, no run IDs. Dynamic state is provided by tool results.
 */
export function buildModeMessageBody(
	mode: Mode,
	state: WorkflowState,
	todoToolName: "workflow_todo" | "update_plan" = "workflow_todo",
): string | undefined {
	const modePrompt = promptForMode(mode, todoToolName);
	if (!modePrompt) return undefined;

	return [modePrompt, worktreeRuntimeNotice(state)]
		.filter(Boolean)
		.join("\n\n");
}
