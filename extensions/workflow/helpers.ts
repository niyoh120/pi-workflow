import type { Mode, TodoItem, TodoStatus, WorkflowConfig, WorkflowState } from "./types.js";
import { promptForMode } from "./prompts.js";

// ── Workflow-active predicate ───────────────────────────────────────────────

/**
 * Single source of truth for whether workflow commands/tools are active for a
 * session. Workflow is active when either the session flag is on or config
 * autoEnter is on, AND the user has not explicitly disabled workflow this
 * session. `workflowExplicitlyDisabled` is the highest-priority session veto
 * and overrides autoEnter.
 *
 * Callers that already hold a loaded state + resolved config should call this
 * directly; callers that need to read both from disk should use the
 * ctx-aware wrappers in tools/commands (which surface load failures as
 * explicit errors for workflow-owned tools, or pass-through for plain Pi
 * tools).
 */
export function isWorkflowActive(
	state: Pick<WorkflowState, "workflowEnabled" | "workflowExplicitlyDisabled">,
	config: Pick<WorkflowConfig, "workflow">,
): boolean {
	return (
		(state.workflowEnabled || config.workflow.autoEnter) &&
		!state.workflowExplicitlyDisabled
	);
}

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
 *
 * LLM-visible content includes the Final Plan snapshot and the immutable
 * approved todo snapshot. Run metadata (planPath, workRunId) is carried in
 * the marker's `details`, not here — embedding planPath in content would
 * hand the model the plan file location and invite direct reads, defeating
 * Plan→Work isolation.
 */
export function buildWorkHandoffBody(
	state: WorkflowState,
	planMarkdown: string,
): string {
	// Use the immutable approvedTodos snapshot captured at approval time, not
	// the mutable live state.todos, so the reviewer and Work see the exact
	// task list the user approved.
	const approvedTodos = state.approvedTodos;
	const todoBlock =
		approvedTodos && approvedTodos.length > 0
			? formatApprovedTodosForHandoff(approvedTodos)
			: "(approved todo snapshot missing — coverage gap should be assessed during Implementation Review)";
	return [
		"# Approved-Plan Work Handoff",
		"",
		"Below is the approved plan contract and isolation boundary for this Work run.",
		"",
		"# Final Plan",
		planMarkdown.trim() || "(empty)",
		"",
		"# Approved Todo Snapshot",
		"",
		todoBlock,
	].join("\n");
}

/** Format the immutable approved todo snapshot for the handoff body. */
export function formatApprovedTodosForHandoff(todos: TodoItem[]): string {
	if (todos.length === 0) return "(empty)";
	return todos
		.map((item) => {
			const notes = item.notes
				? ` — ${item.notes.replace(/\r\n|\n|\r/g, " ")}`
				: "";
			return `- [${item.status}] ${item.id}: ${item.title}${notes}`;
		})
		.join("\n");
}

// ── Per-turn mode reminder ─────────────────────────────────────────────────

/**
 * Custom message type for the per-user-turn mode reminder. The
 * before_agent_start handler returns one reminder right after each user
 * message and Pi persists it in the session (one per user turn). While
 * workflow stays active the context handler keeps every reminder verbatim —
 * the message stream grows append-only, which preserves provider prefix
 * caching. After workflow is disabled, the context handler filters them from
 * the provider projection so stale mode constraints stop applying.
 */
export const WORKFLOW_MODE_REMINDER_CUSTOM_TYPE = "workflow-mode-reminder";

/** Hard byte cap (UTF-8) for one reminder body. Keeps per-turn token cost minimal. */
export const MODE_REMINDER_MAX_BYTES = 480;

/**
 * Build the short hidden mode reminder injected once per user turn. Pure and
 * deterministic: only the mode shapes the text — no timestamps, todos, run
 * IDs, or paths — so repeated turns in the same mode stay byte-identical for
 * provider prefix caching. Returns undefined for idle (no reminder).
 */
export function buildModeReminderBody(mode: Mode): string | undefined {
	switch (mode) {
		case "idle":
			return undefined;
		case "explore":
			return "<workflow-mode-reminder>Current mode: Explore (read-only exploration & Q&A). Project files are read-only: no edit/write of project files, no workflow_plan_save or other plan tools, no mutating shell. Tool calls from other modes in history belong to finished phases; this turn's permissions follow this reminder and the system Mode Prompt.</workflow-mode-reminder>";
		case "plan":
			return "<workflow-mode-reminder>Current mode: Plan (discussion & planning). Project is read-only, no implementation; plans are persisted only via workflow_plan_save, decisions via workflow_grill_record. Tool calls from other modes in history belong to finished phases; this turn's permissions follow this reminder and the system Mode Prompt.</workflow-mode-reminder>";
		case "work":
			return "<workflow-mode-reminder>Current mode: Work (implementation). Drive work via workflow_todo; no git write operations; on any recovery warning, mark the current todo blocked and stop. Tool calls from other modes in history belong to finished phases; this turn's permissions follow this reminder and the system Mode Prompt.</workflow-mode-reminder>";
		case "init":
			return "<workflow-mode-reminder>Current mode: Init (calibrate AGENTS.md). Writes are allowed only to the AGENTS.md at initTargetPath; call workflow_init_complete to finish or abort. Tool calls from other modes in history belong to finished phases; this turn's permissions follow this reminder and the system Mode Prompt.</workflow-mode-reminder>";
		case "merge":
			return "<workflow-mode-reminder>Current mode: Merge (branch integration). The Active Merge Context injected each turn is the single authoritative baseline; call workflow_merge_complete to finish or abort. Tool calls from other modes in history belong to finished phases; this turn's permissions follow this reminder and the system Mode Prompt.</workflow-mode-reminder>";
		case "commit":
			return "<workflow-mode-reminder>Current mode: Commit (compose and execute git commit). No code file changes, no push; write/edit is intercepted. Tool calls from other modes in history belong to finished phases; this turn's permissions follow this reminder and the system Mode Prompt.</workflow-mode-reminder>";
		default:
			return assertNever(mode);
	}
}

/** True when a provider-visible message is one of our per-turn mode reminders. */
export function isWorkflowModeReminderMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: unknown; customType?: unknown };
	return (
		m.role === "custom" && m.customType === WORKFLOW_MODE_REMINDER_CUSTOM_TYPE
	);
}

/**
 * One-line allowed-scope hint appended to tool_call guard rejections so the
 * model can re-anchor on the current mode after a stale-mode tool attempt.
 */
export function modeScopeHint(mode: Mode): string {
	switch (mode) {
		case "idle":
			return "No active workflow mode (run /workflow:enable first)";
		case "explore":
			return "Explore is read-only exploration & Q&A";
		case "plan":
			return "Plan is discussion & planning only (workflow_plan_save / workflow_grill_record)";
		case "work":
			return "Work is implementation only (tracked via workflow_todo, no git writes)";
		case "init":
			return "Init may only write the target AGENTS.md";
		case "merge":
			return "Merge is branch integration only (governed by the Active Merge Context)";
		case "commit":
			return "Commit only does git commit";
		default:
			return assertNever(mode);
	}
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
	if (s.todos.length === 0) return "No todos yet.";

	return s.todos
		.map((item) => {
			const notes = item.notes ? ` — ${item.notes}` : "";
			return `- [${item.status}] ${item.id}: ${item.title}${notes}`;
		})
		.join("\n");
}

/** Find the first in-progress todo, or the first pending todo if none in progress. */
export function nextTodo(s: WorkflowState): TodoItem | undefined {
	return (
		s.todos.find((t) => t.status === "in_progress") ??
		s.todos.find((t) => t.status === "pending")
	);
}

/** Format a single todo as a compact one-line delta entry. Newlines (LF, CRLF,
 *  CR) in notes are collapsed to spaces so the delta block stays one line
 *  per item. */
export function todoLine(item: TodoItem): string {
	const notes = item.notes ? ` — ${item.notes.replace(/\r\n|\n|\r/g, " ")}` : "";
	return `- [${item.status}] ${item.id}: ${item.title}${notes}`;
}

/**
 * Compact delta result for a todo modification: the mutation label, the
 * changed/added/next item, and a minimal status count. Full todos stay in
 * `details.todos` for overlay and state recovery. Use `todoSnapshotText`
 * for explicit reads.
 *
 * `mutation` overrides the per-item label for whole-list replacements
 * ("reset" / "replaced"); when set, the first item is reported under that
 * label and no per-item changed/added diff is emitted. `isAdd` labels a
 * single-item add as "added".
 */
export function todoDeltaText(
	s: WorkflowState,
	opts: { changedId?: string; changedTitle?: string; changedStatus?: TodoStatus; isAdd?: boolean; mutation?: "reset" | "replaced" } = {},
): string {
	const counts = todoStatusCounts(s.todos);
	const parts: string[] = ["[todo delta]"];
	if (opts.mutation) {
		// Whole-list replacement: report the first item under the mutation label.
		const first = s.todos[0];
		if (first) {
			parts.push(`${opts.mutation}: ${todoLine(first)}`);
		} else {
			parts.push(`${opts.mutation}: (empty list)`);
		}
	} else if (opts.isAdd && opts.changedId) {
		// Explicit add: the item now exists in state, but label it "added".
		const item = s.todos.find((t) => t.id === opts.changedId);
		if (item) {
			parts.push(`added: ${todoLine(item)}`);
		} else if (opts.changedTitle) {
			parts.push(`added: ${todoLine({ id: opts.changedId, title: opts.changedTitle, status: opts.changedStatus ?? "pending" })}`);
		}
	} else if (opts.changedId) {
		const changed = s.todos.find((t) => t.id === opts.changedId);
		if (changed) {
			parts.push(`changed: ${todoLine(changed)}`);
		} else if (opts.changedTitle) {
			parts.push(`changed: ${todoLine({ id: opts.changedId, title: opts.changedTitle, status: opts.changedStatus ?? "pending" })}`);
		}
	}
	const next = nextTodo(s);
	if (next) {
		parts.push(`next: ${todoLine(next)}`);
	}
	parts.push(`total: ${s.todos.length} (done=${counts.done}, in_progress=${counts.in_progress}, pending=${counts.pending}, blocked=${counts.blocked})`);
	return parts.join("\n");
}

/** Full snapshot result for an explicit todo read, clearly marked. */
export function todoSnapshotText(s: WorkflowState): string {
	const counts = todoStatusCounts(s.todos);
	const header = `[todo snapshot] total: ${s.todos.length} (done=${counts.done}, in_progress=${counts.in_progress}, pending=${counts.pending}, blocked=${counts.blocked})`;
	if (s.todos.length === 0) return `${header}\nNo todos yet.`;
	return `${header}\n${s.todos.map(todoLine).join("\n")}`;
}

/** Tally todos by status. */
export function todoStatusCounts(todos: TodoItem[]): Record<string, number> {
	const counts: Record<string, number> = { done: 0, in_progress: 0, pending: 0, blocked: 0 };
	for (const t of todos) {
		counts[t.status] = (counts[t.status] ?? 0) + 1;
	}
	return counts;
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
		case "merge":
			return "Merge Mode";
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
		case "merge":
			return "🔀 Merge";
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
		...(s.mergeContext
			? [
					`mergeSource: ${s.mergeContext.sourceBranch} (${s.mergeContext.sourceKind})`,
					`mergeTarget: ${s.mergeContext.targetBranch}`,
					`mergeStrategy: ${s.mergeContext.defaultStrategy ? "default (rebase + ff-only)" : "custom (user instructions)"}`,
				]
			: []),
		"",
		"todos:",
		todoText(s),
	].join("\n");
}

function promptLine(value: string): string {
	return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

/**
 * Marker prefix of the canonical Merge Mode context message. The context
 * handler rebuilds this hidden user message from persisted state every
 * provider round (filtering previous copies) so the merge baseline and the
 * user authorization survive reload and compaction.
 */
export const MERGE_CONTEXT_MARKER = "<!-- workflow-merge-context -->";

/**
 * Build the canonical Active Merge Context body from persisted state. This is
 * the authoritative merge baseline for the model: source/target branches,
 * baseline heads, strategy flag, and the raw user instructions (kept at user
 * priority — never merged into the system prompt).
 */
export function buildMergeContextBody(state: WorkflowState): string {
	const mc = state.mergeContext;
	if (!mc) return "";
	const kindLabel =
		mc.sourceKind === "workflow-worktree" ? "workflow worktree" : "regular local branch";
	const lines: string[] = [
		"# Active Merge Context",
		"",
		`Source branch: \`${mc.sourceBranch}\` (${kindLabel})`,
		`Target branch: \`${mc.targetBranch}\``,
		`Baseline: sourceHeadBefore=${mc.sourceHeadBefore.slice(0, 12)} targetHeadBefore=${mc.targetHeadBefore.slice(0, 12)} commits ahead on source=${mc.sourceOnlyCommitCountBefore}`,
	];
	if (mc.defaultStrategy) {
		lines.push(
			'Strategy: default (no user instructions) — rebase source onto target, then call workflow_merge_complete(status="completed", finalize="ff-only").',
		);
	} else {
		lines.push(
			"Strategy: custom (user-authorized instructions). The instructions below are the sole authorization source this turn — only actions named verbatim are authorized:",
		);
	}
	if (mc.instructions) {
		lines.push("", "User instructions (verbatim):", "", indentBlock(mc.instructions));
	}
	lines.push(
		"",
		'This context is rebuilt from workflow state. When done call workflow_merge_complete; to abort use status="cancelled".',
	);
	return lines.join("\n");
}

function indentBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

export function worktreeRuntimeNotice(state: WorkflowState): string {
	if (!state.worktreePath) return "";
	const displayWorktreePath = promptLine(state.worktreePath);
	return [
		"# Active Git Worktree",
		`Working directory: ${displayWorktreePath}`,
		state.worktreeBranch ? `Branch: ${promptLine(state.worktreeBranch)}` : undefined,
		"All file tools (read/edit/write) must use absolute paths under the worktree.",
		"bash already executes inside the active worktree; just use bash.",
		"Write code changes only inside the worktree; do not touch files in the main checkout.",
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
