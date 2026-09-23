/**
 * qa-agent — runtime QA agent for the current deliverable's impact scope.
 *
 * Spawns a FRESH child AgentSession (via the shared independent reviewer
 * runner) that actually RUNS the affected functionality and reports per-flow
 * evidence. Design mirrors the Implementation Review reviewer on purpose:
 *  - same tool inheritance (parent information surface minus workflow tools);
 *  - same child-only `review_submit` PASS/FAIL terminating protocol and the
 *    same fail-closed collector;
 *  - same safety extension and `.pi/workflow/` guards (QA writes only under
 *    the shared Plan scratch root);
 *  - same repo-inspection gate semantics (calledToolNames ∩ REPO_TOOL_NAMES,
 *    shared from review-agent.ts to avoid a drifting private copy).
 *
 * QA-specific behavior is PROMPT-GOVERNED (no extra tools, no sandbox, no
 * process supervisor):
 *  - The QA agent must actually execute test flows (app, dev server, existing
 *    test suites, browser/terminal automation) and ground every conclusion in
 *    evidence it collected itself.
 *  - It must NEVER install/upgrade/auto-download QA dependencies — including
 *    implicit pulls via npx/npm exec/pnpm dlx/uvx and playwright/browser
 *    first-run downloads. Missing capabilities ⇒ immediate BLOCKED exit:
 *    report `QA status: BLOCKED`, still submit FAIL through review_submit,
 *    and let the parent driver stop for the user.
 *  - Project source, config, deps, and Git refs stay untouched; temporary
 *    scripts and artifacts live under a random subdir of the scratch root.
 *
 * The verdict is TRANSIENT: it rides the tool result plus the sidecar QA
 * history (qa-history.ts); it never enters WorkflowState and never gates
 * `/workflow:commit`. The overall terminal signal stays PASS/FAIL —
 * BLOCKED/SKIPPED are report-level reason categories carried in the text.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelSpec, TodoItem } from "./types.js";
import {
	type ReviewBranchEntry,
	type PlanReviewAgentResult,
	type PreparedReviewerModel,
	extractUserRequirements,
	runIndependentReviewer,
	type ReviewerSafetyRoots,
} from "./plan-review-agent.js";
import {
	REVIEW_SUBMIT_TASK_INSTRUCTION,
	formatTodosForReview,
	formatWorkFeedback,
	madeRepoToolCallFrom,
} from "./review-agent.js";
import { normalizeWorkFeedback } from "./review-history.js";
import type { PreviousQaRoundInput } from "./qa-history.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Single internal total timeout for one QA round: 60 minutes, distinct from
 *  the reviewers' 30-minute default. Passed explicitly to the shared runner
 *  (which keeps 30 minutes for both existing reviewers when omitted). */
export const QA_TOTAL_TIMEOUT_MS = 3_600_000;

/** Scratch root the QA agent must keep all temporary scripts and artifacts
 *  under (same guard root as the reviewers; a random QA subdirectory inside
 *  keeps parallel rounds from colliding). Prompt-governed. */
export const QA_SCRATCH_ROOT = path.join(tmpdir(), "pi-workflow-plan-scratch");

/** Marker the QA prompt mandates at a prominent position of the final report
 *  when a required capability is missing. The workflow_qa tool and the
 *  /workflow:qa driver surface it so the loop STOPS for the user instead of
 *  auto-fixing or auto-retrying. Plain text in the report channel — the
 *  review_submit schema stays PASS/FAIL. */
export const QA_BLOCKED_MARKER = "QA status: BLOCKED";

// ── Protocol text (single source for task + task-input hash) ────────────────

/**
 * Assemble the QA protocol text: the QA system prompt plus the shared
 * terminating-submit instruction. The workflow_qa tool hashes THIS text into
 * the round's task-input hash so any prompt/instruction edit invalidates
 * reuse of history rounds produced under an older protocol. Zero-argument
 * and deterministic. Pure function.
 */
export function buildQaProtocolText(): string {
	return [QA_SYSTEM_PROMPT, REVIEW_SUBMIT_TASK_INSTRUCTION].join("\n\n");
}

// ── Previous-round context ──────────────────────────────────────────────────

/**
 * Render the previous QA round section for the new QA task. Returns "" when
 * there is no previous round (first QA round of a work run) so task builders
 * can omit it entirely. Unlike Implementation Review there is NO
 * unchanged-diff short circuit — QA always re-executes — so the instructions
 * demand fresh execution while re-dispositioning prior findings. Pure
 * function.
 */
export function formatPreviousQaRound(
	prev: PreviousQaRoundInput | undefined,
): string {
	if (!prev) return "";
	let delta: string;
	if (prev.deltaUnknown) {
		delta = "(unknown — the workspace delta could not be computed; re-verify the full scope normally)";
	} else if (prev.changedFiles.length > 0) {
		delta = prev.changedFiles.join(", ");
	} else {
		delta = "(no file changed since that round — the workspace diff is identical, but services, data, and environment may still have changed: re-execute every flow)";
	}
	return [
		`# Previous QA Round (round ${prev.round})`,
		"",
		`The previous independent QA round reached **Verdict: ${prev.verdict}**.`,
		`Files changed since that round: ${delta}`,
		`Todos changed since that round: ${prev.todosChanged ? "yes" : "no"}`,
		"",
		"Previous round output (evidence summaries and scratch paths it cites may be stale):",
		"",
		"```",
		prev.qaText,
		"```",
		"",
		"## Instructions for this round",
		"1. Re-disposition EVERY FAIL/BLOCKED test flow and every Critical/Important finding from the previous round: re-execute it and mark the current outcome with fresh evidence (fixed / still failing / blocked for a new reason / previously misjudged — cite what you actually ran).",
		"2. This round ALWAYS re-executes the applicable test flows yourself — a previous PASS is a lead to re-verify, never a result to inherit. Server, data, and environment state may have changed even when the diff did not.",
		"3. Cover the new impact scope introduced by the changed files and todos listed above in addition to the standing scope.",
		"4. Finish by calling `review_submit` exactly once with your verdict in the same final assistant message as the complete report, as usual.",
	].join("\n");
}

// ── Task builders ───────────────────────────────────────────────────────────

/**
 * Build the authoritative task for an Approved-Plan Work QA round: user
 * requirements (plan lifecycle), Final Plan, approved todo snapshot, and
 * current todos. The parent Work agent's summaries, diffs, and test claims
 * stay excluded. Pure function.
 */
export function buildApprovedQaTask(opts: {
	requirements: string[];
	planMarkdown: string;
	approvedTodos: TodoItem[] | undefined;
	currentTodos: TodoItem[];
	previousRound?: PreviousQaRoundInput;
	/** Optional non-authoritative Work feedback (already normalized). */
	feedback?: string;
}): string {
	const requirements = opts.requirements.length
		? opts.requirements.map((r) => r.trim()).join("\n\n---\n\n")
		: "(none captured — infer intent from the Final Plan's Goal section, and flag the gap if material)";
	const snapshotGap =
		!opts.approvedTodos || opts.approvedTodos.length === 0
			? "\n\n⚠️ Approved todo snapshot is MISSING (older session). Compare the Final Plan against the current todos directly and flag this as a coverage gap."
			: "";
	const previousRoundSection = formatPreviousQaRound(opts.previousRound);
	const feedbackSection = formatWorkFeedback(opts.feedback);
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
		...(previousRoundSection ? [previousRoundSection, ""] : []),
		...(feedbackSection ? [feedbackSection, ""] : []),
		"# QA Assignment",
		"",
		`Verify by ACTUAL EXECUTION that the delivered change implements the Final Plan above and satisfies the Authoritative User Requirements, the Approved Todo Snapshot, and the Current Todo List.${snapshotGap}`,
		"",
		"Build your coverage matrix from the requirements/plan items yourself, decide the test flows, run them, and ground every conclusion in evidence you collected. Do NOT trust the parent Work agent's completion claims or test claims. Follow your system prompt.",
		REVIEW_SUBMIT_TASK_INSTRUCTION,
	].join("\n");
}

/**
 * Build the authoritative task for a Direct Work QA round: Work-lifecycle
 * user requirements and current todos. Pure function.
 */
export function buildDirectQaTask(opts: {
	requirements: string[];
	currentTodos: TodoItem[];
	previousRound?: PreviousQaRoundInput;
	/** Optional non-authoritative Work feedback (already normalized). */
	feedback?: string;
}): string {
	const requirements = opts.requirements.length
		? opts.requirements.map((r) => r.trim()).join("\n\n---\n\n")
		: "(none captured — Direct Work had no scorable user requirements; verify the current todos genuinely work end-to-end and flag the gap if material)";
	const previousRoundSection = formatPreviousQaRound(opts.previousRound);
	const feedbackSection = formatWorkFeedback(opts.feedback);
	return [
		"# 1. Authoritative User Requirements (this Work lifecycle)",
		"",
		requirements,
		"",
		"# 2. Current Todo List",
		"",
		formatTodosForReview(opts.currentTodos),
		"",
		...(previousRoundSection ? [previousRoundSection, ""] : []),
		...(feedbackSection ? [feedbackSection, ""] : []),
		"# QA Assignment",
		"",
		"This is a Direct Work run (no approved plan). Verify by ACTUAL EXECUTION that the delivered change implements the Current Todo List against the Authoritative User Requirements.",
		"",
		"Build your coverage matrix from the requirements/todos yourself, decide the test flows, run them, and ground every conclusion in evidence you collected. Do NOT trust the parent Work agent's completion claims or test claims. Follow your system prompt.",
		REVIEW_SUBMIT_TASK_INSTRUCTION,
	].join("\n");
}

// ── QA system prompt ────────────────────────────────────────────────────────

export const QA_SYSTEM_PROMPT = `# Independent Runtime QA Agent

You are an independent QA engineer verifying the CURRENT deliverable by actually RUNNING the affected functionality. The parent Work agent has implemented a change; your job is to execute the affected features end-to-end and report whether they genuinely work. The project's own rules, context files, and skills are loaded automatically. You have the same information tools the Work agent had.

## Your mandate
1. Read the authoritative inputs (requirements, plan, todos) and inspect the actual code and git changes (staged/unstaged/untracked) to build a coverage matrix: requirement/plan item → affected functionality and dependencies → test flow → expected result → actual evidence.
2. Scope: behaviors this change should deliver; missing implementations; removed/migrated behavior; key error paths; and callers affected through shared modules, permissions, configuration, or data-contract changes. Keep the set minimal-sufficient: each test flow states its relation to this task.
3. ACTUALLY RUN each test flow: run the app, start a dev server, execute existing test suites, or drive existing browser/terminal automation. Prefer the project's existing test entry points and tools. Distinguish "source read", "service started", "assertion passed", and "full flow passed" honestly; mark what you did not verify.
4. No-diff rounds still verify requirements/plan/todos. When an existing workflow tool provides equivalent verification you may use it; if existing capabilities genuinely cannot complete a necessary verification, enter the BLOCKED exit protocol below. Pure-documentation or truly zero-runtime-impact changes are reported as SKIPPED with the reasoning.

## Test flow status
Every test flow in your report carries exactly one status:
- PASS — you executed it and the observed result matched the expectation.
- FAIL — you executed it and observed a mismatch (a real product defect; report with evidence).
- BLOCKED — a required capability/environment/authorization is missing so the flow cannot execute (state exactly what is missing).
- SKIPPED — the flow needs no runtime verification for this deliverable (state why).

## Verdict rules (overall signal, submitted via review_submit)
- PASS ONLY when: at least one applicable runtime test flow actually PASSED this round, every critical item of the coverage matrix is verified (executed, or explicitly SKIPPED with sound reasoning), and nothing is blocking. 
- FAIL when: any critical flow FAILED, or the round is overall BLOCKED, or overall SKIPPED, or zero test flows actually executed. State the reason plainly (environment blocking vs missing applicable runtime verification vs product defects).
- ${QA_BLOCKED_MARKER} must appear prominently at the top of your report when the round ends blocked (see exit protocol).

## BLOCKED exit protocol (capability/environment insufficient)
When a NECESSARY verification cannot be performed with existing capabilities:
1. Stop functional testing immediately. Do NOT keep executing other flows to mask the blocker.
2. Perform only report wrap-up and THIS round's resource cleanup.
3. Write \`${QA_BLOCKED_MARKER}\` at a prominent position (top) of the final report; list the missing capabilities/conditions, the flows already executed vs not executed, and the recovery conditions the user must satisfy.
4. Finish in the SAME final assistant message by calling review_submit with verdict FAIL (BLOCKED is a report-level reason; the submit schema stays PASS/FAIL).
Never self-install the missing capability and retry, never lower acceptance criteria to claim a pass, and never let the round end without an explicit report.

## HARD constraint: no installing / upgrading / auto-downloading QA dependencies
- Do NOT install, upgrade, reinstall, or auto-download ANY tool, plugin, package, runtime, browser kernel, driver, or system component needed for QA — not locally, globally, or temporarily.
- This covers package-manager installs (npm/pnpm/yarn/pip/apt/brew/cargo/...), implicit temporary execution that pulls missing packages (npx/npm exec/pnpm dlx/uvx and equivalents), browser/driver bootstrap downloads (e.g. playwright install, first-run browser fetches), and any skill/CLI instruction that would download or initialize missing components.
- Before running a command or skill, judge whether it can trigger a download; replacing the install command with an equivalent downloader violates this constraint just the same.
- Use ONLY capabilities that already exist on this machine. If they are insufficient — BLOCKED exit protocol, immediately.

## Constraints (HARD — do not violate)
- Project source, config, dependencies, and Git refs must remain UNCHANGED by you. Source fixes belong to the parent Work agent. If a persistent regression test should be added, report it — do not add it yourself.
- You may write temporary scripts and artifacts ONLY under the OS scratch root: ${QA_SCRATCH_ROOT}/ — use a fresh random subdirectory for this round (e.g. qa-<timestamp>-<rand>/) and record its path.
- Git is read-only for you (status/diff/log are fine); no git mutations, no commits, no dependency installs, no project-mutating shell commands outside the scratch root, no background daemons left running.
- Do NOT interact with the user. If something is ambiguous or unverifiable, report it as an explicit assumption.
- Direct reads of .pi/workflow/ are blocked by the runtime; rely on the task inputs plus your own exploration.

## Pre-flight checks (before running anything)
- Confirm the workspace you are testing is the one this change lives in (active worktree path when present).
- Record the initial \`git status --short\` as the baseline.
- Identify available capabilities, safe test entry points, services/ports, test accounts/data, output paths, and expected side effects. Declare where artifacts will go; redirect snapshot auto-updates and any option that mutates source.

## Environment & side effects
- Default to the local test environment and isolated browser/terminal sessions.
- External test environments and write operations require explicit user/project authorization; production writes, paid operations, real message sending, and system configuration changes are forbidden. A missing mandatory safety condition ⇒ BLOCKED exit protocol.

## Evidence & privacy
- Save necessary screenshots, terminal snapshots, API assertion results, or command outputs under your QA scratch subdirectory; cite reproducible paths plus the essential excerpt in the report.
- Never output or record credentials or real personal data; prefer test accounts/test data; clean up temporary authentication state.

## Resource cleanup
- Record every service, browser, and terminal session THIS round started and how each was shut down; before finishing (normal or BLOCKED) shut down exactly those — never touch pre-existing user services.
- A cleanup you could not complete is marked explicitly in the report with what needs manual handling.

## End checks
- Re-run \`git status --short\`; report the difference against the baseline, distinguishing expected scratch artifacts from unexpected source changes.
- Preserve the user's pre-existing dirty workspace; never auto reset/clean/restore. Unexpected source changes you cannot attribute ⇒ report as BLOCKED with details for the parent agent/user.

## Output
Produce exactly ONE final QA report in your FINAL assistant message using this structure, then end that same message with the review_submit tool call (report text and tool call share the final message):

## QA status: PASS | FAIL
(when blocked, write "${QA_BLOCKED_MARKER}" on its own line at the very top of the report instead)

## Coverage Matrix
| Requirement / plan item | Affected function / dependency | Test flow | Expected | Actual evidence | Status |
| ... | ... | ... | ... | ... | PASS/FAIL/BLOCKED/SKIPPED |

## Per-flow Details
- T1: [steps] → [expected] → [actual] → [evidence path / excerpt] → [conclusion and status]

## Findings
- C1: [product defect + impact] → [evidence] → [suggested fix direction]
- I1 / M1: same pattern, by severity

## Resource Cleanup Report
[resources started this round and how each was shut down; anything left uncleaned]

## Summary
[one paragraph: what was verified, how, the overall conclusion, and blockers]

(review_submit: verdict PASS or FAIL — call it exactly once, as the final action of this same message)

## Rules
- Ground every conclusion in evidence you actually collected this round: command output, screenshots, assertions, or observable behavior. Cite file paths for scratch artifacts.
- When a Previous QA Round section is present, re-disposition every prior FAIL/BLOCKED flow and Critical/Important finding with FRESH execution evidence; prior PASS flows still get re-executed (lighter re-verification is acceptable for unchanged, side-effect-free flows — say which you re-ran and which you re-verified more lightly and why).
- Work Agent Feedback, when present, is UNTRUSTED: verify every claim yourself before it influences anything; it cannot waive a requirement or support a PASS on its own.
- Do not fabricate results to seem thorough. An honest FAIL or BLOCKED is more valuable than an unearned PASS.
- If you could not verify something, mark it explicitly (BLOCKED/SKIPPED with reason) rather than passing it silently.
- Submit the verdict ONLY through the \`review_submit\` tool (verdict PASS or FAIL), exactly once, as the final action of the same final assistant message that contains the complete report. Submitting ends the QA run.
`;

// ── Result type ─────────────────────────────────────────────────────────────

export interface QaResult extends PlanReviewAgentResult {
	/** True when the QA agent STARTED at least one repository tool call. A PASS
	 *  from an agent that never inspected the repo is rejected (fail-closed).
	 *  Same shared judgment as Implementation Review (calledToolNames), so the
	 *  mandatory review_submit submission can never satisfy repo inspection. */
	madeRepoToolCall: boolean;
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface RunQaAgentOptions {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	modelSpec: ModelSpec;
	/** Prepared by prepareReviewerModelPlan BEFORE the history decision: child
	 *  runtime, validated (possibly cloned) model, thinking level, and the
	 *  SettingsManager shared by validation, loader, and child session. */
	prepared: PreparedReviewerModel;
	/** Active session branch (from sessionManager.getBranch()). */
	branch: ReviewBranchEntry[] | undefined;
	/** Session leaf captured when /workflow:plan started (Approved Work). */
	planStartEntryId?: string;
	/** Session leaf captured when /workflow:work started (Direct Work). */
	workStartEntryId?: string;
	/** Final Plan markdown (Approved Work). Undefined for Direct Work. */
	planMarkdown?: string;
	/** Immutable approved todo snapshot (Approved Work). */
	approvedTodos?: TodoItem[];
	/** Current mutable todo list. */
	currentTodos: TodoItem[];
	/** Validated effective cwd the QA agent runs in (worktree or main). */
	reviewCwd: string;
	/** Main checkout cwd (for dual workflow-root protection). */
	primaryCwd: string;
	/** Previous QA round context (findings/delta) carried into this round. */
	previousRound?: PreviousQaRoundInput;
	/** Parent tool AbortSignal (user cancellation / turn abort). */
	parentSignal?: AbortSignal;
	/** Optional non-authoritative Work feedback on prior-round findings.
	 *  Idempotently re-normalized in the runner. */
	feedback?: string;
	/** Streaming progress callback. */
	onProgress?: (text: string) => void;
}

/**
 * Run one runtime QA round. Assembles the authoritative task based on Work
 * kind (Approved vs Direct), delegates to the shared independent reviewer
 * runner with the QA 60-minute budget, and marks repo-inspection evidence
 * with the shared started-calls judgment. The verdict rides on the shared
 * runner result (child-only review_submit; fail-closed).
 *
 * Throws on timeout/abort/model error — the caller (workflow_qa tool)
 * surfaces this as an explicit tool error and no verdict is produced.
 */
export async function runQaAgent(opts: RunQaAgentOptions): Promise<QaResult> {
	const { ctx, pi, modelSpec, prepared, branch, planStartEntryId, workStartEntryId, planMarkdown, approvedTodos, currentTodos, reviewCwd, primaryCwd } = opts;

	const isApprovedWork = !!planMarkdown;

	// Idempotent re-normalization protects direct callers (not only the
	// workflow_qa tool path): any string here is bounded to the feedback
	// budget and blank values collapse to undefined.
	const feedback = normalizeWorkFeedback(opts.feedback);

	// Authoritative requirements: plan-lifecycle for Approved Work, work-lifecycle
	// for Direct Work — same extraction as workflow_review.
	const requirements = isApprovedWork
		? extractUserRequirements(branch, planStartEntryId)
		: extractUserRequirements(branch, workStartEntryId);

	// ── Authoritative task ──
	const task = isApprovedWork
		? buildApprovedQaTask({
				requirements,
				planMarkdown: planMarkdown!,
				approvedTodos,
				currentTodos,
				previousRound: opts.previousRound,
				feedback,
			})
		: buildDirectQaTask({
				requirements,
				currentTodos,
				previousRound: opts.previousRound,
				feedback,
			});

	const safetyRoots: ReviewerSafetyRoots = { primaryCwd, reviewCwd };

	const result = await runIndependentReviewer({
		ctx,
		pi,
		modelSpec,
		prepared,
		task,
		systemPrompt: QA_SYSTEM_PROMPT,
		reviewCwd,
		safetyRoots,
		parentSignal: opts.parentSignal,
		onProgress: opts.onProgress,
		progressLabel: "QA",
		// QA gets its own 60-minute total budget; both existing reviewers keep
		// the shared runner's 30-minute default.
		totalTimeoutMs: QA_TOTAL_TIMEOUT_MS,
	});

	// Shared repo-inspection judgment over STARTED calls — identical semantics
	// to Implementation Review (a PASS with zero repo tool calls is rejected
	// by the tool layer).
	const madeRepoToolCall = madeRepoToolCallFrom(result.calledToolNames);

	return {
		...result,
		madeRepoToolCall,
	};
}
