/**
 * implementation-review-agent — mandatory Plan Implementation Reviewer.
 *
 * Spawns a FRESH child AgentSession (via the shared independent reviewer
 * runner) that verifies the Work agent's implementation against the
 * authoritative inputs:
 *  - Approved-Plan Work: original user requirements + Final Plan + approved
 *    todo snapshot + current todos.
 *  - Direct Work: Work-lifecycle user requirements + current todos.
 *
 * The reviewer explores the actual checkout/worktree itself (read, grep, find,
 * ls, bash, git diff) and does NOT receive the parent Work agent's execution
 * summary, pre-selected diff, test claims, or prior review output. It produces
 * a structured coverage matrix + correctness/verification findings + a
 * machine-parseable final verdict line.
 *
 * PASS records the current workRunId + workspace fingerprint so todo/code
 * changes invalidate it. The caller computes the fingerprint AFTER the child
 * session is fully disposed (the shared runner guarantees cleanup-before-return).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelSpec, TodoItem } from "./types.js";
import {
	type ReviewBranchEntry,
	type PlanReviewAgentResult,
	extractUserRequirements,
	runIndependentReviewer,
	type ReviewerSafetyRoots,
} from "./plan-review-agent.js";

// ── Verdict ─────────────────────────────────────────────────────────────────

export type ImplementationVerdict = "PASS" | "FAIL";

export interface VerdictParseResult {
	verdict: ImplementationVerdict;
	/** Raw verdict line as emitted by the reviewer (for diagnostics). */
	rawLine?: string;
	/** Reason when the format is missing/conflicting (fail-closed → FAIL). */
	reason?: string;
}

/** The exact machine-parseable final verdict line the reviewer must emit. */
export const VERDICT_LINE_PREFIX = "IMPLEMENTATION_REVIEW_VERDICT:";

/**
 * Parse the reviewer's final verdict line. Fail-closed: a missing, malformed,
 * or conflicting verdict yields FAIL so no unreliable review can produce PASS.
 *
 * Pure function — no I/O — so it can be unit-tested with fixture text.
 */
export function parseImplementationVerdict(text: string): VerdictParseResult {
	if (!text || typeof text !== "string") {
		return { verdict: "FAIL", reason: "empty reviewer output" };
	}
	const lines = text.split("\n");
	const verdictLines = lines.filter((l) =>
		l.trim().startsWith(VERDICT_LINE_PREFIX),
	);
	if (verdictLines.length === 0) {
		return {
			verdict: "FAIL",
			reason: `missing '${VERDICT_LINE_PREFIX} PASS|FAIL' final line`,
		};
	}
	if (verdictLines.length > 1) {
		// Multiple verdict lines: only PASS if every line agrees on PASS.
		const values = new Set(
			verdictLines.map((l) => {
				const rest = l.slice(VERDICT_LINE_PREFIX.length).trim().toUpperCase();
				return rest.split(/\s+/)[0] ?? "";
			}),
		);
		if (values.size === 1 && values.has("PASS")) {
			return { verdict: "PASS", rawLine: verdictLines[0] };
		}
		return {
			verdict: "FAIL",
			reason: `conflicting verdict lines: ${verdictLines.join(" | ")}`,
		};
	}
	const line = verdictLines[0];
	const rest = line.slice(VERDICT_LINE_PREFIX.length).trim().toUpperCase();
	const value = rest.split(/\s+/)[0] ?? "";
	if (value === "PASS") return { verdict: "PASS", rawLine: line };
	if (value === "FAIL") return { verdict: "FAIL", rawLine: line };
	return {
		verdict: "FAIL",
		reason: `unrecognized verdict value '${value}' in line: ${line}`,
	};
}

// ── Todo formatting ─────────────────────────────────────────────────────────

/**
 * Format a todo list for the reviewer task. Uses the stable id/title/status
 * shape so the reviewer can cross-reference plan coverage and completion
 * claims. Pure function.
 */
export function formatTodosForReview(todos: TodoItem[] | undefined): string {
	if (!todos || todos.length === 0) return "(empty)";
	return todos
		.map((t) => {
			const notes = t.notes ? ` — ${t.notes}` : "";
			return `- [${t.status}] ${t.id}: ${t.title}${notes}`;
		})
		.join("\n");
}

// ── Task builders ───────────────────────────────────────────────────────────

/**
 * Build the authoritative task for an Approved-Plan Work implementation
 * review. Includes: user requirements (plan lifecycle), Final Plan, approved
 * todo snapshot, and current todos. Excludes the parent Work agent's
 * summaries, diffs, and test claims. Pure function.
 */
export function buildApprovedImplementationReviewTask(opts: {
	requirements: string[];
	planMarkdown: string;
	approvedTodos: TodoItem[] | undefined;
	currentTodos: TodoItem[];
}): string {
	const requirements = opts.requirements.length
		? opts.requirements.map((r) => r.trim()).join("\n\n---\n\n")
		: "(none captured — infer intent from the Final Plan's Goal section, and flag the gap if material)";
	const snapshotGap =
		!opts.approvedTodos || opts.approvedTodos.length === 0
			? "\n\n⚠️ Approved todo snapshot is MISSING (older session). Compare the Final Plan against the current todos directly and flag this as a Minor coverage gap."
			: "";
	return [
		"# 1. Authoritative User Requirements",
		"",
		requirements,
		"",
		"# 2. Final Plan",
		"",
		opts.planMarkdown.trim(),
		"",
		"# 3. Approved Todo Snapshot",
		"",
		formatTodosForReview(opts.approvedTodos),
		"",
		"# 4. Current Todo List",
		"",
		formatTodosForReview(opts.currentTodos),
		"",
		"# 5. Implementation Review Assignment",
		"",
		`Verify the Work agent's implementation of the Final Plan above against the Authoritative User Requirements, the Approved Todo Snapshot, and the Current Todo List.${snapshotGap}`,
		"",
		"Explore the actual repository yourself (read, grep, find, ls, bash, git diff). Do NOT trust the parent Work agent's claims — verify every todo's completion against concrete repository evidence. Follow your system prompt. End by emitting exactly ONE final verdict line.",
	].join("\n");
}

/**
 * Build the authoritative task for a Direct Work implementation review.
 * Includes: Work-lifecycle user requirements and current todos. Pure function.
 */
export function buildDirectImplementationReviewTask(opts: {
	requirements: string[];
	currentTodos: TodoItem[];
}): string {
	const requirements = opts.requirements.length
		? opts.requirements.map((r) => r.trim()).join("\n\n---\n\n")
		: "(none captured — Direct Work had no scorable user requirements; verify the current todos are genuinely complete and flag the gap if material)";
	return [
		"# 1. Authoritative User Requirements (this Work lifecycle)",
		"",
		requirements,
		"",
		"# 2. Current Todo List",
		"",
		formatTodosForReview(opts.currentTodos),
		"",
		"# 3. Implementation Review Assignment",
		"",
		"This is a Direct Work run (no approved plan). Verify the Work agent's implementation of the Current Todo List against the Authoritative User Requirements.",
		"",
		"Explore the actual repository yourself (read, grep, find, ls, bash, git diff). Do NOT trust the parent Work agent's claims — verify every todo's completion against concrete repository evidence. Follow your system prompt. End by emitting exactly ONE final verdict line.",
	].join("\n");
}

// ── Reviewer system prompt ──────────────────────────────────────────────────

export const IMPLEMENTATION_REVIEWER_SYSTEM_PROMPT = `# Independent Plan Implementation Reviewer

You are an independent senior engineer reviewing whether the Work agent's IMPLEMENTATION genuinely satisfies the approved plan and todo list. The project's own rules, context files, and skills are loaded automatically. You have read-only access to the repository and the same information tools the Work agent had.

## Your mandate
Independently verify, by inspecting the ACTUAL repository at HEAD + working tree, that:
1. The plan/todos semantically cover the authoritative user requirements.
2. Every todo marked done/in_progress is actually implemented with concrete code evidence.
3. Cross-module integration points called for by the plan are wired correctly.
4. Plan-specified acceptance scenarios and error/recovery paths are genuinely handled.
5. The implementation matches the plan's confirmed key decisions.

Do NOT trust the Work agent's completion claims or summaries. Verify against evidence you gather yourself.

## Review focus
- Plan→todo coverage: does every plan requirement map to a todo? Are there todos with no plan basis (scope creep)?
- Todo completion reality: for each todo, cite the file path + line range (or command result) proving it is done. A todo marked done with no implementation evidence is a Critical finding.
- Correctness: do the implemented functions, types, integrations, and configs match what the plan and requirements demand? Cite concrete signatures, call sites, or config.
- Verification: were the plan's acceptance checks actually run? Cite the command and its observed output.
- Error/recovery paths: are plan-specified error handling and recovery branches present?

## Constraints (HARD — do not violate)
- You are READ-ONLY for project files. Do NOT modify project files, config, memory, skills, or settings.
- You may write temporary probe scripts ONLY under the OS scratch root: ${path.join(tmpdir(), "pi-workflow-plan-scratch")}/
- You may run existing tests and read-only git inspection (git diff, git status, git log) to gather evidence.
- No git mutations, no commits, no dependency installs, no project-mutating shell commands, no background processes.
- Do NOT interact with the user. If something is ambiguous or unverifiable, report it as an explicit assumption.
- Direct reads of .pi/workflow/ are blocked by the runtime; rely on the task inputs plus your own exploration.
- Before finishing, run \`git status --short\` and account for every generated/untracked artifact. Unexplained generated files or continuously-changing artifacts are an Important finding.

## Output
Produce exactly ONE final review using this structure, then emit the verdict line, then stop (no further tool calls):

## 覆盖矩阵 (Coverage Matrix)
| Plan requirement | Todo id | Status | Evidence (file:lines / command) |
| ... | ... | ... | ... |

## Implementation Correctness
- C1: [问题描述] → [文件:行号证据] → [建议修复]

## Verification
- V1: [验收检查] → [命令与输出] → [通过/失败]

## Critical
- [严重问题，或 "(none)"]

## Important
- [重要问题，或 "(none)"]

## Minor
- [次要问题，或 "(none)"]

## Summary
[一段话总结实现是否真正满足计划与 todos]

IMPLEMENTATION_REVIEW_VERDICT: PASS

## Rules
- Ground every finding in concrete repository evidence: cite file paths, line ranges, API signatures, config, or command output you actually inspected.
- Do not fabricate findings to seem thorough. Only flag genuine concerns.
- If you could not verify something, state it explicitly as an unverified assumption.
- PASS requires that every todo marked done has real implementation evidence AND no Critical findings AND no plan-coverage gaps. Any gap or unverifiable done claim → FAIL.
- The verdict line MUST be exactly \`IMPLEMENTATION_REVIEW_VERDICT: PASS\` or \`IMPLEMENTATION_REVIEW_VERDICT: FAIL\` on its own final line.
`;

// ── Result type ─────────────────────────────────────────────────────────────

export interface ImplementationReviewResult extends PlanReviewAgentResult {
	verdict: ImplementationVerdict;
	verdictReason?: string;
	/** True when the reviewer made at least one repository tool call. A PASS
	 *  from a reviewer that never inspected the repo is rejected. */
	madeRepoToolCall: boolean;
}

// ── Runner ──────────────────────────────────────────────────────────────────

/** Repository-inspection tool names the reviewer is expected to use. */
const REPO_TOOL_NAMES = new Set([
	"read",
	"bash",
	"grep",
	"find",
	"ls",
]);

export interface RunImplementationReviewAgentOptions {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	modelSpec: ModelSpec;
	/** Active session branch (from sessionManager.getBranch()). */
	branch: ReviewBranchEntry[] | undefined;
	/** Session leaf captured when /plan started (Approved Work). */
	planStartEntryId?: string;
	/** Session leaf captured when /work started (Direct Work). */
	workStartEntryId?: string;
	/** Final Plan markdown (Approved Work). Undefined for Direct Work. */
	planMarkdown?: string;
	/** Immutable approved todo snapshot (Approved Work). */
	approvedTodos?: TodoItem[];
	/** Current mutable todo list. */
	currentTodos: TodoItem[];
	/** Validated effective cwd the reviewer runs in (worktree or main). */
	reviewCwd: string;
	/** Main checkout cwd (for dual workflow-root protection). */
	primaryCwd: string;
	/** Parent tool AbortSignal (user cancellation / turn abort). */
	parentSignal?: AbortSignal;
	/** Streaming progress callback. */
	onProgress?: (text: string) => void;
}

/**
 * Run the Implementation Reviewer. Assembles the authoritative task based on
 * Work kind (Approved vs Direct), delegates to the shared independent reviewer
 * runner in the validated review cwd, and parses the verdict.
 *
 * The shared runner fully disposes the child session before returning, so this
 * function does NOT compute the workspace fingerprint — the caller does that
 * AFTER receiving this result and only when verdict === PASS.
 */
export async function runImplementationReviewAgent(
	opts: RunImplementationReviewAgentOptions,
): Promise<ImplementationReviewResult> {
	const {
		ctx,
		pi,
		modelSpec,
		branch,
		planStartEntryId,
		workStartEntryId,
		planMarkdown,
		approvedTodos,
		currentTodos,
		reviewCwd,
		primaryCwd,
	} = opts;

	const isApprovedWork = !!planMarkdown;

	let task: string;
	if (isApprovedWork) {
		const requirements = extractUserRequirements(branch, planStartEntryId);
		task = buildApprovedImplementationReviewTask({
			requirements,
			planMarkdown: planMarkdown!,
			approvedTodos,
			currentTodos,
		});
	} else {
		// Direct Work: scope requirements to the Work lifecycle.
		const requirements = extractUserRequirements(branch, workStartEntryId);
		task = buildDirectImplementationReviewTask({
			requirements,
			currentTodos,
		});
	}

	const safetyRoots: ReviewerSafetyRoots = { primaryCwd, reviewCwd };

	const result = await runIndependentReviewer({
		ctx,
		pi,
		modelSpec,
		task,
		systemPrompt: IMPLEMENTATION_REVIEWER_SYSTEM_PROMPT,
		reviewCwd,
		safetyRoots,
		parentSignal: opts.parentSignal,
		onProgress: opts.onProgress,
		progressLabel: "Implementation review",
	});

	// Mark whether the reviewer actually inspected the repository. A PASS from
	// a reviewer that made zero repo tool calls is rejected (fail-closed).
	const madeRepoToolCall = (result.activeTools ?? []).some((name) =>
		REPO_TOOL_NAMES.has(name),
	) && result.toolCalls > 0;

	const parsed = parseImplementationVerdict(result.text);

	return {
		...result,
		verdict: parsed.verdict,
		verdictReason: parsed.reason,
		madeRepoToolCall,
	};
}
