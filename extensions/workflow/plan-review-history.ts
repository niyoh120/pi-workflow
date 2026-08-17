/**
 * plan-review-history.ts — per-plan-run plan review round persistence, hash
 * computation, and full/incremental/reused mode decisions for the optional
 * independent Plan Reviewer.
 *
 * Why this exists: each workflow_plan_review call spawns a FRESH child
 * reviewer that re-explores the repository from scratch, costing minutes and
 * a large token budget even when the plan was only lightly revised. This
 * module persists each actual reviewer round (canonical output, effective
 * verdict, successful-tool evidence, repository diff fingerprint, basis/task
 * hashes, Markdown section hashes) keyed by plan run, so the next call can:
 *
 *  1. short-circuit (reuse) when the repository, review basis (requirements,
 *     reviewer model/thinking, tool surface, reviewer protocol text) AND the
 *     full task input (Final Plan + confirmed decisions + feedback) are all
 *     unchanged — no child reviewer run at all;
 *  2. run an INCREMENTAL review when the repository and basis are unchanged
 *     but the plan/decisions/feedback changed — injecting the previous
 *     round's findings plus a Markdown section delta so the reviewer focuses
 *     on what changed instead of re-deriving everything;
 *  3. run a FULL review whenever anything could have moved the ground truth
 *     (repository fingerprint unknown/changed, basis changed, previous round
 *     missing valid verdict or successful repository inspection evidence).
 *
 * Caching is fail-safe by construction: load failures (missing file, corrupt
 * JSON, invalid schema, invalid persisted verdict) and any fingerprint
 * uncertainty degrade to "no history" → full review.
 *
 * Dependency direction: this module reuses the already-verified generic
 * exports of review-history.ts (boundedHeadTail, normalizeWorkFeedback,
 * PREVIOUS_ROUND_TEXT_BUDGET) through aliases and does NOT import
 * plan-review-agent.ts at runtime — the reviewer protocol TEXT (and its hash)
 * is passed in as a parameter by the tool layer, avoiding a runtime cycle.
 * plan-review-agent.ts consumes the shared shapes here via `import type`.
 *
 * The verdict remains TRANSIENT: this file lives beside session state but is
 * separate from WorkflowState and never gates workflow_plan_approve —
 * approval is always user-confirmed. Short-circuited calls append no new
 * round (bounded history, no nested output growth), unlike Implementation
 * Review which persists its short-circuited rounds.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { planReviewHistoryPath } from "./paths.js";
import type { GrillTurn } from "./types.js";
import {
	PREVIOUS_ROUND_TEXT_BUDGET,
	boundedHeadTail,
	normalizeWorkFeedback,
} from "./review-history.js";

// ── Bounds & aliases ────────────────────────────────────────────────────────

/** Keep at most this many ACTUAL reviewer rounds per plan run. Reused
 *  (short-circuited) calls never append a round. */
export const MAX_PLAN_REVIEW_ROUNDS = 3;

/** Plan Review adopts the same explicit budget for the previous round's
 *  reviewer text injected into an incremental task: 60,000 characters keep
 *  the opening severity findings and the trailing summary/verdict. */
export const PLAN_PREVIOUS_ROUND_TEXT_BUDGET = PREVIOUS_ROUND_TEXT_BUDGET;

/** Plan/Work share one feedback normalize contract: trim, blank→undefined,
 *  20,000-char head/tail bound. Aliased so hash and visible task text always
 *  agree across both reviewers. */
export const normalizePlanReviewFeedback = normalizeWorkFeedback;

// ── Types ───────────────────────────────────────────────────────────────────

export type PlanReviewVerdictValue = "PASS" | "FAIL";

/** How this workflow_plan_review call was served. */
export type PlanReviewMode = "full" | "incremental" | "reused";

/** Added/changed/removed Markdown section keys between two plan versions.
 *  Used ONLY to focus the incremental reviewer — the complete Final Plan
 *  always participates in the task hash and the task body, so parser noise
 *  degrades focus, never correctness. */
export interface PlanSectionDelta {
	added: string[];
	changed: string[];
	removed: string[];
}

/** Previous-round context injected into an incremental reviewer task. Shared
 *  shape: persisted here, consumed by plan-review-agent via `import type`.
 *  The section delta and decisions-changed flag travel as separate task
 *  options; this shape carries only the round's own outputs. */
export interface PreviousPlanReviewRoundInput {
	/** Round number of the source round (1-based). */
	round: number;
	/** Previous round's effective verdict (PASS/FAIL). */
	effectiveVerdict: PlanReviewVerdictValue;
	/** Previous reviewer output, already bounded head+tail. */
	reviewerText: string;
	/** True when the previous round's repository delta could not be computed. */
	deltaUnknown: boolean;
}

export interface PlanReviewRoundRecord {
	planRunId: string;
	round: number;
	at: string;
	model: string;
	thinking?: string;
	elapsedMs: number;
	turns: number;
	toolCalls: number;
	/** Canonical reviewer output as surfaced by workflow_plan_review. */
	reviewerText: string;
	/** Effective verdict: a submitted FAIL stays FAIL; a submitted PASS without
	 *  successful repo inspection evidence is downgraded to FAIL. */
	effectiveVerdict: PlanReviewVerdictValue;
	verdictReason?: string;
	/** Strict finalized-evidence flag: the round recorded at least one
	 *  successfully COMPLETED builtin repository tool call. */
	hasSuccessfulRepoInspection: boolean;
	successfulToolNames: string[];
	diffFingerprint: string;
	deltaUnknown: boolean;
	/** Hash over requirements + reviewer model/thinking + tool surface +
	 *  the actual reviewer protocol text. Any change → full review. */
	reviewBasisHash: string;
	/** Basis + complete confirmed decisions + Final Plan + normalized
	 *  feedback. Identical repository + basis + task input ⇒ reuse. */
	taskInputHash: string;
	planHash: string;
	decisionHash: string;
	sectionHashes: Record<string, string>;
	/** Whether this round ran full or incremental. */
	mode: Exclude<PlanReviewMode, "reused">;
	/** Round whose evidence an incremental round built on. */
	reusedFromRound?: number;
}

export interface PlanReviewHistory {
	planRunId: string;
	rounds: PlanReviewRoundRecord[];
}

// ── Persistence (fail-safe) ─────────────────────────────────────────────────

/**
 * Load the plan review history for a session. Missing file, corrupt JSON,
 * invalid schema, or records with a missing/invalid persisted effective
 * verdict all degrade to fewer/no rounds — callers then run a full review.
 * Never throws.
 */
export function loadPlanReviewHistory(
	cwd: string,
	sessionKey: string,
): PlanReviewHistory | undefined {
	const p = planReviewHistoryPath(cwd, sessionKey);
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<PlanReviewHistory>;
		if (!parsed || typeof parsed !== "object") return undefined;
		const planRunId =
			typeof parsed.planRunId === "string" ? parsed.planRunId : "";
		const rounds = Array.isArray(parsed.rounds)
			? (parsed.rounds as unknown[]).filter(isPlanReviewRoundRecord)
			: [];
		return { planRunId, rounds };
	} catch {
		return undefined;
	}
}

/** Structural record check. A record missing a VALID effective verdict
 *  (exactly "PASS" | "FAIL") is rejected outright — it cannot be reused and
 *  re-parsing its reviewerText would be redundant and error-prone. */
function isPlanReviewRoundRecord(v: unknown): v is PlanReviewRoundRecord {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.planRunId === "string" &&
		typeof o.round === "number" &&
		typeof o.reviewerText === "string" &&
		(o.effectiveVerdict === "PASS" || o.effectiveVerdict === "FAIL")
	);
}

/**
 * Append (or replace, when the plan run changed) a plan review round. Atomic
 * temp-file + rename write; caps rounds at MAX_PLAN_REVIEW_ROUNDS (keeps the
 * newest). A new planRunId discards the previous run's rounds. Throws on I/O
 * failure so the caller can flag "next round will full review".
 */
export function savePlanReviewRound(
	cwd: string,
	sessionKey: string,
	round: PlanReviewRoundRecord,
): void {
	const existing = loadPlanReviewHistory(cwd, sessionKey);
	const history: PlanReviewHistory =
		existing && existing.planRunId === round.planRunId
			? { planRunId: round.planRunId, rounds: [...existing.rounds, round] }
			: { planRunId: round.planRunId, rounds: [round] };
	if (history.rounds.length > MAX_PLAN_REVIEW_ROUNDS) {
		history.rounds = history.rounds.slice(
			history.rounds.length - MAX_PLAN_REVIEW_ROUNDS,
		);
	}
	const p = planReviewHistoryPath(cwd, sessionKey);
	const dir = path.dirname(p);
	fs.mkdirSync(dir, { recursive: true });
	const tmpFile = path.join(
		dir,
		`.tmp-plan-review-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	try {
		fs.writeFileSync(tmpFile, JSON.stringify(history, null, 2), "utf8");
		fs.renameSync(tmpFile, p);
	} catch (err) {
		// Clean up temp file on failure; rethrow so callers see the error.
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			/* best effort */
		}
		throw err;
	}
}

// ── Markdown section hashing (fenced-code-aware) ────────────────────────────

/**
 * Hash each Markdown section of the Final Plan by ATX heading.
 *
 * Boundaries (explicit):
 *  - Only line-start ATX headings count: `^#{1,6}\s+`.
 *  - Heading-like text inside fenced code blocks (``` or ~~~) is skipped by
 *    tracking open/close fences; an unclosed fence swallows the rest.
 *  - Content before the first heading lands in the `(preamble)` section.
 *  - Duplicate headings get a stable occurrence-index suffix: the first
 *    occurrence is `Text`, later ones `Text [2]`, `Text [3]`, … in order.
 *
 * Pure function — no I/O.
 */
export function computePlanSectionHashes(
	markdown: string,
): Record<string, string> {
	const hashes: Record<string, string> = {};
	if (typeof markdown !== "string" || markdown.length === 0) return hashes;
	const seen = new Map<string, number>();
	let fence: string | null = null;
	// Content before the first heading lands in the (preamble) section.
	let currentKey: string | null = "(preamble)";
	let buffer: string[] = [];
	const flush = () => {
		if (currentKey !== null) {
			hashes[currentKey] = sha1(buffer.join("\n"));
		}
		buffer = [];
	};
	const keyFor = (text: string): string => {
		const n = (seen.get(text) ?? 0) + 1;
		seen.set(text, n);
		return n === 1 ? text : `${text} [${n}]`;
	};
	const lines = markdown.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimStart();
		if (fence) {
			buffer.push(line);
			// Closing fence must match the opening marker and be at least as long.
			if (trimmed.startsWith(fence) && isFenceLine(trimmed)) fence = null;
			continue;
		}
		if (isFenceLine(trimmed)) {
			fence = fenceMarker(trimmed);
			buffer.push(line);
			continue;
		}
		const heading = matchAtxHeading(line);
		if (heading !== undefined) {
			flush();
			currentKey = keyFor(heading);
			buffer = [line];
			continue;
		}
		buffer.push(line);
	}
	// Flush the final section (also covers a heading-less document whose
	// entire body is the preamble).
	flush();
	return hashes;
}

/** Match `^#{1,6}\s+Text` and return the trimmed heading text. */
function matchAtxHeading(line: string): string | undefined {
	const m = /^(#{1,6})[ \t]+(.*)$/.exec(line);
	if (!m) return undefined;
	const text = (m[2] ?? "").trim();
	return text.length > 0 ? text : undefined;
}

/** True when the line is a fence opener/closer (>=3 backticks or tildes). */
function isFenceLine(trimmedStartLine: string): boolean {
	return /^(`{3,}|~{3,})/.test(trimmedStartLine);
}

/** Extract the fence marker (e.g. "```" / "~~~") from a fence line. */
function fenceMarker(trimmedStartLine: string): string {
	const m = /^(`{3,}|~{3,})/.exec(trimmedStartLine);
	return m ? (m[1] ?? "") : "";
}

/**
 * Compute added/changed/removed section keys between two section-hash maps.
 * Pure function.
 */
export function computePlanSectionDelta(
	prev: Record<string, string>,
	curr: Record<string, string>,
): PlanSectionDelta {
	const added: string[] = [];
	const changed: string[] = [];
	const removed: string[] = [];
	for (const key of Object.keys(curr)) {
		if (!(key in prev)) added.push(key);
		else if (prev[key] !== curr[key]) changed.push(key);
	}
	for (const key of Object.keys(prev)) {
		if (!(key in curr)) removed.push(key);
	}
	return {
		added: added.sort(),
		changed: changed.sort(),
		removed: removed.sort(),
	};
}

// ── Hashes ──────────────────────────────────────────────────────────────────

/**
 * Hash of the reviewer's ENVIRONMENT baseline: authoritative user
 * requirements, reviewer model/thinking, the sorted reconstructed tool
 * surface, and the ACTUAL reviewer protocol text (system prompt + task
 * section instructions, assembled by buildPlanReviewProtocolText()).
 * Any change here forces a full review — a stale cache must never outlive a
 * changed requirement, model, tool set, or reviewer instruction.
 *
 * Protocol text is passed as a parameter (not imported) so this module never
 * depends on the agent's prompt constants at runtime. Pure function.
 */
export function computePlanReviewBasisHash(input: {
	requirements: string[];
	reviewerModel: string;
	thinking?: string;
	requestedTools: string[];
	extensionPaths: string[];
	protocolText: string;
}): string {
	const body = {
		requirements: input.requirements,
		reviewerModel: input.reviewerModel,
		thinking: input.thinking ?? "",
		requestedTools: [...input.requestedTools].sort(),
		extensionPaths: [...input.extensionPaths].sort(),
		protocolText: input.protocolText,
	};
	return sha1(JSON.stringify(body));
}

/** Deterministic serialization of confirmed grilling decisions. */
function serializeDecisions(decisions: GrillTurn[]): unknown[] {
	return (decisions ?? []).map((d) => [
		d.question ?? "",
		d.recommendedAnswer ?? "",
		d.userAnswer ?? "",
		d.decisionStatus ?? "",
		d.notes ?? "",
	]);
}

/**
 * Hash of ONLY the confirmed decisions. Used to flag `decisionsChanged` for
 * the incremental reviewer (which must then re-verify the complete
 * requirements → decisions → plan mapping). Pure function.
 */
export function computePlanDecisionHash(decisions: GrillTurn[]): string {
	return sha1(JSON.stringify(serializeDecisions(decisions)));
}

/** Hash of the complete Final Plan text. Pure function. */
export function computePlanHash(planMarkdown: string): string {
	return sha1(typeof planMarkdown === "string" ? planMarkdown : "");
}

/**
 * Hash of the COMPLETE reviewer task input: the basis plus the full confirmed
 * decisions, the full Final Plan, and (when present) the normalized planner
 * feedback. Feedback is idempotently re-normalized here; a missing/blank
 * feedback contributes NO key so pre-upgrade history keeps hashing
 * identically. Identical repository + basis + task input ⇒ same review.
 * Pure function.
 */
export function computePlanReviewTaskInputHash(input: {
	basisHash: string;
	planMarkdown: string;
	decisions: GrillTurn[];
	/** Optional non-authoritative planner feedback (any raw form). */
	feedback?: string;
}): string {
	const feedback = normalizePlanReviewFeedback(input.feedback);
	const body = {
		basisHash: input.basisHash,
		planMarkdown: typeof input.planMarkdown === "string" ? input.planMarkdown : "",
		decisions: serializeDecisions(input.decisions),
		...(feedback !== undefined ? { feedback } : {}),
	};
	return sha1(JSON.stringify(body));
}

// ── Mode decision ───────────────────────────────────────────────────────────

export interface PlanReviewCacheDecision {
	mode: PlanReviewMode;
	/** Human-readable diagnostic surfaced in the tool output. */
	reason: string;
	/** For mode === "reused": the round whose result is reused. */
	reusedFromRound?: number;
}

/**
 * Decide how this workflow_plan_review call is served:
 *
 *  - "reused": repository + basis + task input all match the last round AND
 *    that round is cacheable (valid persisted effective verdict + successful
 *    repo inspection evidence). The caller returns the cached result with no
 *    child reviewer run.
 *  - "incremental": repository + basis match, task input (plan/decisions/
 *    feedback) changed. The reviewer gets the previous round plus a section
 *    delta and re-verifies the changed scope.
 *  - "full": anything else — no history, unknown/changed repository
 *    fingerprint, changed basis, or an unusable previous round.
 *
 * Fail-safe: every uncertainty resolves to "full". Pure function.
 */
export function decidePlanReviewMode(input: {
	history: PlanReviewHistory | undefined;
	planRunId: string;
	diffFingerprint: string;
	deltaUnknown: boolean;
	reviewBasisHash: string;
	taskInputHash: string;
}): PlanReviewCacheDecision {
	const last =
		input.history && input.history.planRunId === input.planRunId
			? input.history.rounds[input.history.rounds.length - 1]
			: undefined;
	if (!last) {
		return { mode: "full", reason: "no reusable history for this plan run" };
	}
	if (input.deltaUnknown || last.deltaUnknown) {
		return {
			mode: "full",
			reason: "repository fingerprint unknown — full review required",
		};
	}
	if (last.diffFingerprint !== input.diffFingerprint) {
		return {
			mode: "full",
			reason: "repository changed since the last review",
		};
	}
	if (last.reviewBasisHash !== input.reviewBasisHash) {
		return {
			mode: "full",
			reason: "review basis changed (requirements / model / tools / reviewer protocol)",
		};
	}
	// Belt-and-braces: the loader already rejects invalid verdicts, but the
	// decision must stay fail-safe even with a hand-edited history file.
	if (last.effectiveVerdict !== "PASS" && last.effectiveVerdict !== "FAIL") {
		return {
			mode: "full",
			reason: "previous round has no valid persisted verdict",
		};
	}
	if (!last.hasSuccessfulRepoInspection) {
		return {
			mode: "full",
			reason: "previous round lacks successful repository inspection evidence",
		};
	}
	if (last.taskInputHash === input.taskInputHash) {
		return {
			mode: "reused",
			reason: `repo evidence reused from round ${last.round}`,
			reusedFromRound: last.round,
		};
	}
	return {
		mode: "incremental",
		reason: "plan / decisions / feedback changed since the last review",
	};
}

// ── Reused-result diagnostics ───────────────────────────────────────────────

/** Diagnostics contract for a reused (short-circuited) call: zero this-round
 *  cost, evidence attributed to the cached source round. */
export interface PlanReviewReuseDiagnostics {
	round: number;
	reusedFromRound: number;
	mode: "reused";
	elapsedMs: 0;
	turns: 0;
	toolCalls: 0;
	successfulToolNames: string[];
	hasSuccessfulRepoInspection: boolean;
}

/** Build the zero-cost diagnostics for a reused round. Pure function. */
export function buildReuseDiagnostics(
	source: PlanReviewRoundRecord,
): PlanReviewReuseDiagnostics {
	return {
		round: source.round,
		reusedFromRound: source.round,
		mode: "reused",
		elapsedMs: 0,
		turns: 0,
		toolCalls: 0,
		successfulToolNames: [],
		hasSuccessfulRepoInspection: source.hasSuccessfulRepoInspection,
	};
}

/** Bound the previous round's reviewer output for task injection. Pure. */
export function boundPreviousRoundText(text: string): string {
	return boundedHeadTail(text, PLAN_PREVIOUS_ROUND_TEXT_BUDGET);
}

function sha1(text: string): string {
	return crypto.createHash("sha1").update(text).digest("hex");
}
