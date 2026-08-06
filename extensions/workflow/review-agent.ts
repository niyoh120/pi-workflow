/**
 * review-agent — on-demand unified Review Agent.
 *
 * Spawns a FRESH child AgentSession (via the shared independent reviewer
 * runner) that reviews the Work agent's implementation against the
 * authoritative inputs:
 *  - Approved-Plan Work: original user requirements + Final Plan + approved
 *    todo snapshot + current todos.
 *  - Direct Work: Work-lifecycle user requirements + current todos.
 *
 * When OCR is enabled (`codeReview.enabled: true`), a workspace `ocr review`
 * runs first in the validated review cwd with a FIXED, bounded code-review
 * constraint card as `--background` (no dynamic requirements/plan/todo text,
 * no file paths — see `buildOcrBackground()`); its normalized findings are
 * injected into the reviewer task, and the reviewer must disposition each
 * finding (confirm with repository evidence or explain a false positive). OCR
 * is scoped to code-level defects over the current diff; requirements, Final
 * Plan, and todo coverage stay with the independent reviewer's authoritative
 * task. When OCR is disabled, the reviewer covers requirements/plan/todos/
 * implementation/tests and error paths directly.
 *
 * The reviewer explores the actual checkout/worktree itself (read, grep, find,
 * ls, bash, git diff) and does NOT receive the parent Work agent's execution
 * summary, pre-selected diff, test claims, or prior review output. It produces
 * a structured coverage matrix + correctness/verification findings + OCR
 * finding dispositions + a machine-parseable final verdict line.
 *
 * The verdict is TRANSIENT: it only signals whether this on-demand review loop
 * can end. It is never written to WorkflowState and never gates `/commit`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelSpec, OcrFinding, TodoItem } from "./types.js";
import {
	type ReviewBranchEntry,
	type PlanReviewAgentResult,
	extractUserRequirements,
	runIndependentReviewer,
	type ReviewerSafetyRoots,
} from "./plan-review-agent.js";
import { checkOcrAvailable, buildReviewArgv, ocrCommandSummary, runOcrReview } from "./ocr-helpers.js";
import { parseOcrReviewJson, OcrParseError } from "./ocr-result.js";

// ── OCR constants (internal, no longer configurable) ────────────────────────

export const OCR_BINARY = "ocr";
export const OCR_TIMEOUT_MS = 1_800_000;

// ── Verdict ─────────────────────────────────────────────────────────────────

export type ReviewVerdict = "PASS" | "FAIL";

export interface VerdictParseResult {
	verdict: ReviewVerdict;
	/** Raw verdict line as emitted by the reviewer (for diagnostics). */
	rawLine?: string;
	/** Reason when the format is missing/conflicting (fail-closed → FAIL). */
	reason?: string;
}

/** The exact machine-parseable final verdict line the reviewer must emit. */
export const VERDICT_LINE_PREFIX = "REVIEW_VERDICT:";

/**
 * Parse the reviewer's final verdict line. Fail-closed: a missing, malformed,
 * or conflicting verdict yields FAIL so no unreliable review can produce PASS.
 *
 * Pure function — no I/O — so it can be unit-tested with fixture text.
 */
export function parseReviewVerdict(text: string): VerdictParseResult {
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

// ── OCR background ──────────────────────────────────────────────────────────

/**
 * Build the FIXED OCR `--background` for the workspace code review.
 *
 * This is a constant, bounded, path-free code-review constraint card: it only
 * states OCR's responsibility (code-level defect scanning over the current Git
 * diff / live repository). It intentionally receives NO task dynamics — the
 * full user messages, Final Plan, todos, file lists, or execution summaries
 * must not enter `--background`, so historical/stale file paths can never be
 * fed to OCR's file-reading steps. Requirements/plan/todo coverage belongs to
 * the independent reviewer's authoritative task, not to OCR.
 *
 * Zero-argument and deterministic. Kept under 2000 characters. Pure function.
 */
export function buildOcrBackground(): string {
	return [
		"Review the current Git workspace changes for code-level defects.",
		"",
		"Focus:",
		"- runtime correctness and regressions",
		"- error, cancellation, timeout, cleanup, and recovery paths",
		"- API/type contracts and cross-module integration",
		"- security, concurrency, resource leaks, and performance hazards",
		"",
		"Evidence scope:",
		"Use the current Git diff and live repository as the source of file and symbol scope.",
		"Report concrete actionable defects with file and line evidence.",
		"",
		"The independent reviewer handles requirements, plan, and todo coverage.",
	].join("\n");
}

// ── OCR context ─────────────────────────────────────────────────────────────

/**
 * OCR status passed into the reviewer task. When `enabled` is false the task
 * explicitly records the skip reason; when true, `findings` carries the
 * normalized workspace findings the reviewer must disposition.
 */
export interface OcrContext {
	enabled: boolean;
	findings: OcrFinding[];
	counts: Record<string, number>;
	rawPath?: string;
	/** Reason OCR was skipped/disabled (used when enabled is false). */
	skippedReason?: string;
}

// ── OCR finding formatting ──────────────────────────────────────────────────

/**
 * Format the normalized OCR findings as a numbered list for the reviewer task.
 * Mirrors the compact model-visible view so the reviewer cross-references the
 * exact file/line/severity it must disposition. Pure function.
 */
export function formatOcrFindings(findings: OcrFinding[]): string {
	if (findings.length === 0) return "(no findings)";
	return findings
		.map((f, i) => {
			const loc =
				f.line === undefined
					? f.file
					: f.endLine !== undefined && f.endLine !== f.line
						? `${f.file}:${f.line}-${f.endLine}`
						: `${f.file}:${f.line}`;
			const suggestion = f.suggestion
				? `\n   suggestion: ${f.suggestion.replace(/\r\n|\n|\r/g, " ")}`
				: "";
			return `${i + 1}. [${f.severity}] ${f.rule} @ ${loc} — ${f.message}${suggestion}`;
		})
		.join("\n");
}

// ── Task builders ───────────────────────────────────────────────────────────

/**
 * Build the authoritative task for an Approved-Plan Work review. Includes:
 * user requirements (plan lifecycle), Final Plan, approved todo snapshot,
 * current todos, and (when present) the OCR findings to disposition. Excludes
 * the parent Work agent's summaries, diffs, and test claims. Pure function.
 */
export function buildApprovedReviewTask(opts: {
	requirements: string[];
	planMarkdown: string;
	approvedTodos: TodoItem[] | undefined;
	currentTodos: TodoItem[];
	ocr: OcrContext;
}): string {
	const requirements = opts.requirements.length
		? opts.requirements.map((r) => r.trim()).join("\n\n---\n\n")
		: "(none captured — infer intent from the Final Plan's Goal section, and flag the gap if material)";
	const snapshotGap =
		!opts.approvedTodos || opts.approvedTodos.length === 0
			? "\n\n⚠️ Approved todo snapshot is MISSING (older session). Compare the Final Plan against the current todos directly and flag this as a Minor coverage gap."
			: "";
	const ocrSection = renderOcrSection(opts.ocr);
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
		ocrSection,
		"",
		"# Review Assignment",
		"",
		`Verify the Work agent's implementation of the Final Plan above against the Authoritative User Requirements, the Approved Todo Snapshot, and the Current Todo List.${snapshotGap}`,
		"",
		"Explore the actual repository yourself (read, grep, find, ls, bash, git diff). Do NOT trust the parent Work agent's claims — verify every todo's completion against concrete repository evidence. Follow your system prompt. End by emitting exactly ONE final verdict line.",
	].join("\n");
}

/**
 * Build the authoritative task for a Direct Work review. Includes: Work-lifecycle
 * user requirements, current todos, and (when present) the OCR findings.
 * Pure function.
 */
export function buildDirectReviewTask(opts: {
	requirements: string[];
	currentTodos: TodoItem[];
	ocr: OcrContext;
}): string {
	const requirements = opts.requirements.length
		? opts.requirements.map((r) => r.trim()).join("\n\n---\n\n")
		: "(none captured — Direct Work had no scorable user requirements; verify the current todos are genuinely complete and flag the gap if material)";
	const ocrSection = renderOcrSection(opts.ocr);
	return [
		"# 1. Authoritative User Requirements (this Work lifecycle)",
		"",
		requirements,
		"",
		"# 2. Current Todo List",
		"",
		formatTodosForReview(opts.currentTodos),
		"",
		ocrSection,
		"",
		"# Review Assignment",
		"",
		"This is a Direct Work run (no approved plan). Verify the Work agent's implementation of the Current Todo List against the Authoritative User Requirements.",
		"",
		"Explore the actual repository yourself (read, grep, find, ls, bash, git diff). Do NOT trust the parent Work agent's claims — verify every todo's completion against concrete repository evidence. Follow your system prompt. End by emitting exactly ONE final verdict line.",
	].join("\n");
}

/**
 * Render the OCR section for the reviewer task. When OCR ran, lists findings
 * and the per-finding disposition requirement; when skipped, records the reason
 * explicitly so the reviewer reviews without OCR. Pure function.
 */
function renderOcrSection(ocr: OcrContext): string {
	if (!ocr.enabled) {
		return [
			"# OCR Workspace Findings",
			"",
			`OCR is disabled for this review (${ocr.skippedReason ?? "codeReview.enabled is false"}). Review requirements, plan/todos, implementation, tests, and error paths directly.`,
		].join("\n");
	}
	const summary =
		ocr.findings.length > 0
			? `${ocr.findings.length} finding(s)` +
				(Object.keys(ocr.counts).length > 0
					? ` — by severity: ${Object.entries(ocr.counts).map(([k, n]) => `${k}=${n}`).join(", ")}`
					: "")
			: "no findings";
	return [
		"# OCR Workspace Findings",
		"",
		`OCR reviewed the workspace changes (raw JSON: ${ocr.rawPath ?? "(unavailable)"}). ${summary}.`,
		"",
		formatOcrFindings(ocr.findings),
		...(ocr.findings.length === 0
			? []
			: [
					"",
					"Disposition EVERY OCR finding:",
					"- For each finding, verify with your own repository evidence whether it is a genuine issue or a false positive / out-of-scope.",
					"- Cite the concrete file path + line range (or command result) that confirms or refutes it.",
					"- Fold every CONFIRMED Critical/Important finding into the unified verdict (FAIL). Document dismissed findings as false positives with evidence.",
				]),
	].join("\n");
}

// ── Reviewer system prompt ──────────────────────────────────────────────────

export const REVIEWER_SYSTEM_PROMPT = `# Independent Reviewer

You are an independent senior engineer reviewing whether the Work agent's implementation genuinely satisfies the requirements, the approved plan, and the todo list, and (when provided) dispositions OCR workspace findings. The project's own rules, context files, and skills are loaded automatically. You have read-only access to the repository and the same information tools the Work agent had.

## Your mandate
Independently verify, by inspecting the ACTUAL repository at HEAD + working tree, that:
1. The plan/todos semantically cover the authoritative user requirements.
2. Every todo marked done/in_progress is actually implemented with concrete code evidence.
3. Cross-module integration points called for by the plan are wired correctly.
4. Plan-specified acceptance scenarios and error/recovery paths are genuinely handled.
5. The implementation matches the plan's confirmed key decisions.
6. When OCR findings are provided, each finding is dispositioned: confirmed as a real issue or refuted as a false positive, both backed by repository evidence.

Do NOT trust the Work agent's completion claims or summaries. Verify against evidence you gather yourself.

## Review focus
- Plan→todo coverage: does every plan requirement map to a todo? Are there todos with no plan basis (scope creep)?
- Todo completion reality: for each todo, cite the file path + line range (or command result) proving it is done. A todo marked done with no implementation evidence is a Critical finding.
- Correctness: do the implemented functions, types, integrations, and configs match what the plan and requirements demand? Cite concrete signatures, call sites, or config.
- Verification: were the plan's acceptance checks actually run? Cite the command and its observed output.
- Error/recovery paths: are plan-specified error handling and recovery branches present?
- OCR findings: for each finding, confirm or refute it with repository evidence. Confirmed Critical/Important findings contribute to FAIL.

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

## OCR Findings Disposition (when OCR findings were provided)
- F1: [finding summary] → [confirmed/refuted] → [文件:行号证据]

## Critical
- [严重问题，或 "(none)"]

## Important
- [重要问题，或 "(none)"]

## Minor
- [次要问题，或 "(none)"]

## Summary
[一段话总结实现是否真正满足计划与 todos]

REVIEW_VERDICT: PASS

## Rules
- Ground every finding in concrete repository evidence: cite file paths, line ranges, API signatures, config, or command output you actually inspected.
- Do not fabricate findings to seem thorough. Only flag genuine concerns.
- If you could not verify something, state it explicitly as an unverified assumption.
- PASS requires that every todo marked done has real implementation evidence AND no Critical findings AND no plan-coverage gaps AND no unconfirmed Critical/Important OCR findings. Any gap or unverifiable done claim → FAIL.
- The verdict line MUST be exactly \`REVIEW_VERDICT: PASS\` or \`REVIEW_VERDICT: FAIL\` on its own final line.
`;

// ── Result type ─────────────────────────────────────────────────────────────

export interface ReviewResult extends PlanReviewAgentResult {
	verdict: ReviewVerdict;
	verdictReason?: string;
	/** True when the reviewer made at least one repository tool call. A PASS
	 *  from a reviewer that never inspected the repo is rejected. */
	madeRepoToolCall: boolean;
	/** OCR run diagnostics for tool output. */
	ocr: {
		enabled: boolean;
		findings: number;
		counts: Record<string, number>;
		rawPath?: string;
	};
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

export interface RunReviewAgentOptions {
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
	/** Whether to run workspace OCR and feed findings into the reviewer task. */
	includeOcr: boolean;
	/** Parent tool AbortSignal (user cancellation / turn abort). */
	parentSignal?: AbortSignal;
	/** Streaming progress callback. */
	onProgress?: (text: string) => void;
}

/**
 * Run the unified Review Agent. When `includeOcr` is true, runs a workspace
 * `ocr review` in the validated review cwd, parses normalized findings, and
 * injects them into the reviewer task. When false, the reviewer reviews
 * directly with an explicit OCR-disabled marker.
 *
 * Assembles the authoritative task based on Work kind (Approved vs Direct),
 * delegates to the shared independent reviewer runner, and parses the verdict.
 *
 * OCR CLI absence, execution failure, or JSON parse failure throw an explicit
 * error so the caller (the workflow_review tool) surfaces a tool error and no
 * verdict is produced for this round.
 */
export async function runReviewAgent(
	opts: RunReviewAgentOptions,
): Promise<ReviewResult> {
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
		includeOcr,
	} = opts;

	const isApprovedWork = !!planMarkdown;

	// Authoritative requirements: plan-lifecycle for Approved Work, work-lifecycle
	// for Direct Work.
	const requirements = isApprovedWork
		? extractUserRequirements(branch, planStartEntryId)
		: extractUserRequirements(branch, workStartEntryId);

	// ── Optional OCR workspace review ──
	let ocrContext: OcrContext;
	if (includeOcr) {
		if (!checkOcrAvailable(OCR_BINARY)) {
			throw new Error(
				"ocr CLI not found. " +
					"Install alibaba/open-code-review: npm i -g @alibaba-group/open-code-review\n" +
					"Then configure LLM with ocr config set llm.url / llm.auth_token / llm.model.",
			);
		}
		const background = buildOcrBackground();
		const argv = buildReviewArgv(background);
		const cmdSummary = ocrCommandSummary(OCR_BINARY, argv);
		opts.onProgress?.("[review] running workspace OCR review");
		let rawOutput: string;
		try {
			rawOutput = await runOcrReview(OCR_BINARY, reviewCwd, argv, OCR_TIMEOUT_MS, opts.parentSignal);
		} catch (err) {
			// AbortError from cancelled signal — rethrow so the platform handles cancellation.
			if (err instanceof Error && err.name === "AbortError") throw err;
			const errMsg = err instanceof Error ? err.message : String(err);
			const stderr =
				typeof err === "object" && err !== null && "stderr" in err
					? (err as { stderr?: unknown }).stderr
					: "";
			throw new Error(
				`ocr review failed.\n\n` +
					`Command: ${cmdSummary}\n` +
					`Error: ${errMsg}\n` +
					`stderr: ${String(stderr).slice(0, 2000)}\n\n` +
					`Check ocr config and LLM connectivity: ocr llm test`,
			);
		}
		let result;
		try {
			result = parseOcrReviewJson(rawOutput);
		} catch (parseErr) {
			const rawPath = parseErr instanceof OcrParseError ? parseErr.rawPath : "";
			const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
			throw new Error(
				`Code review output could not be processed.` +
					(rawPath ? `\nRaw output saved to: ${rawPath}` : "") +
					`\nError: ${errMsg}` +
					`\n\nCommand: ${cmdSummary}`,
			);
		}
		ocrContext = {
			enabled: true,
			findings: result.findings,
			counts: result.counts,
			rawPath: result.rawPath,
		};
	} else {
		ocrContext = {
			enabled: false,
			findings: [],
			counts: {},
			skippedReason: "codeReview.enabled is false",
		};
	}

	// ── Authoritative task ──
	let task: string;
	if (isApprovedWork) {
		task = buildApprovedReviewTask({
			requirements,
			planMarkdown: planMarkdown!,
			approvedTodos,
			currentTodos,
			ocr: ocrContext,
		});
	} else {
		task = buildDirectReviewTask({
			requirements,
			currentTodos,
			ocr: ocrContext,
		});
	}

	const safetyRoots: ReviewerSafetyRoots = { primaryCwd, reviewCwd };

	const result = await runIndependentReviewer({
		ctx,
		pi,
		modelSpec,
		task,
		systemPrompt: REVIEWER_SYSTEM_PROMPT,
		reviewCwd,
		safetyRoots,
		parentSignal: opts.parentSignal,
		onProgress: opts.onProgress,
		progressLabel: "Review",
	});

	// Mark whether the reviewer actually inspected the repository. A PASS from
	// a reviewer that made zero repo tool calls is rejected (fail-closed).
	const madeRepoToolCall = (result.activeTools ?? []).some((name) =>
		REPO_TOOL_NAMES.has(name),
	) && result.toolCalls > 0;

	const parsed = parseReviewVerdict(result.text);

	return {
		...result,
		verdict: parsed.verdict,
		verdictReason: parsed.reason,
		madeRepoToolCall,
		ocr: {
			enabled: ocrContext.enabled,
			findings: ocrContext.findings.length,
			counts: ocrContext.counts,
			rawPath: ocrContext.rawPath,
		},
	};
}
