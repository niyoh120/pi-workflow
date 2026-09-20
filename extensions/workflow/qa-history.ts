/**
 * qa-history.ts — per-work-run QA round persistence for the runtime QA loop.
 *
 * Why this exists: each workflow_qa round spawns a FRESH QA agent that cannot
 * see the previous round's findings, and the parent Work agent fixes defects
 * between rounds. This module persists each round's verdict + full QA report
 * + a workspace diff fingerprint + a hash of every QA task input, keyed by
 * work run, so the next round can:
 *
 *  1. inject the previous round's findings/evidence into the new QA task and
 *     require per-item re-disposition with FRESH execution evidence;
 *  2. focus the new round on the files/todos that changed since.
 *
 * There is deliberately NO unchanged-diff short circuit (unlike
 * Implementation Review): services, data, and environment change even when
 * the diff does not, and the user explicitly re-triggers QA after fixing a
 * BLOCKED round. Every authorized workflow_qa call executes a real QA round.
 *
 * The verdict remains TRANSIENT: this file lives beside session state but is
 * separate from WorkflowState and never gates /workflow:commit. Workflow
 * agents block direct reads of .pi/workflow/, so the QA child only ever sees
 * what the workflow_qa tool puts into its task.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { qaHistoryPath } from "./paths.js";
import type { ReviewerContextBasis, TodoItem } from "./types.js";
import { serializeReviewerContextBasis } from "./model-context.js";
import { normalizeWorkFeedback } from "./review-history.js";

// ── Bounds ──────────────────────────────────────────────────────────────

/** Keep at most this many rounds per work run (only the newest is injected). */
export const MAX_QA_ROUNDS = 3;
/** Budget for the previous round's QA report injected into the new task.
 *  Explicitly adopts the shared head/tail retention policy. */
export const QA_PREVIOUS_ROUND_TEXT_BUDGET = 60_000;

// ── Types ───────────────────────────────────────────────────────────────

/** Persisted verdict values stay PASS/FAIL; BLOCKED/SKIPPED nuance lives in
 *  the report text channel. */
export type QaVerdictValue = "PASS" | "FAIL";

/** Context from the previous QA round, injected into the new QA task.
 *  Assembled by the workflow_qa tool from the persisted QA history. Pure
 *  data — defined here (not in qa-agent.ts) so the history module and the
 *  agent share one shape without a runtime cycle. */
export interface PreviousQaRoundInput {
	/** Previous round number (1-based). */
	round: number;
	/** Previous round's verdict. */
	verdict: string;
	/** Previous QA agent's full report (already bounded head+tail). */
	qaText: string;
	/** Files whose tracked diff or untracked content changed since that round. */
	changedFiles: string[];
	/** True when the delta could not be computed (review everything). */
	deltaUnknown: boolean;
	/** True when todos changed since that round. */
	todosChanged: boolean;
}

export interface QaRoundRecord {
	workRunId: string;
	round: number;
	at: string;
	verdict: QaVerdictValue;
	verdictReason?: string;
	model: string;
	elapsedMs: number;
	turns: number;
	toolCalls: number;
	madeRepoToolCall: boolean;
	/** Full QA report as surfaced by workflow_qa (evidence summaries/paths are
	 *  kept here; artifact files stay in the QA scratch subtree). */
	qaText: string;
	diffFingerprint: string;
	deltaUnknown: boolean;
	fileHashes: Record<string, string>;
	untrackedHashes: Record<string, string>;
	todoHash: string;
	/** Hash of the authoritative QA inputs (requirements/plan/todos/model/
	 *  protocol/context basis) plus any present non-authoritative feedback. */
	taskInputHash: string;
}

export interface QaHistory {
	workRunId: string;
	rounds: QaRoundRecord[];
}

// ── Persistence ─────────────────────────────────────────────────────────

/** Load the QA history for a session. Missing/corrupt/invalid → undefined. */
export function loadQaHistory(
	cwd: string,
	sessionKey: string,
): QaHistory | undefined {
	const p = qaHistoryPath(cwd, sessionKey);
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<QaHistory>;
		if (!parsed || typeof parsed !== "object") return undefined;
		const workRunId =
			typeof parsed.workRunId === "string" ? parsed.workRunId : "";
		const rounds = Array.isArray(parsed.rounds)
			? (parsed.rounds as unknown[]).filter(isQaRoundRecord)
			: [];
		return { workRunId, rounds };
	} catch {
		return undefined;
	}
}

function isQaRoundRecord(v: unknown): v is QaRoundRecord {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.workRunId === "string" &&
		typeof o.round === "number" &&
		(o.verdict === "PASS" || o.verdict === "FAIL" || typeof o.verdict === "undefined") &&
		typeof o.qaText === "string"
	);
}

/**
 * Append (or replace, when the work run changed) a QA round. Atomic
 * temp-file + rename write; caps rounds at MAX_QA_ROUNDS (keeps the newest).
 * A new work runId discards the previous run's rounds.
 */
export function saveQaRound(
	cwd: string,
	sessionKey: string,
	round: QaRoundRecord,
): void {
	const existing = loadQaHistory(cwd, sessionKey);
	const history: QaHistory =
		existing && existing.workRunId === round.workRunId
			? { workRunId: round.workRunId, rounds: [...existing.rounds, round] }
			: { workRunId: round.workRunId, rounds: [round] };
	if (history.rounds.length > MAX_QA_ROUNDS) {
		history.rounds = history.rounds.slice(history.rounds.length - MAX_QA_ROUNDS);
	}
	const p = qaHistoryPath(cwd, sessionKey);
	const dir = path.dirname(p);
	fs.mkdirSync(dir, { recursive: true });
	const tmpFile = path.join(
		dir,
		`.tmp-qa-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// ── Pure helpers ────────────────────────────────────────────────────────

/**
 * Hash of every QA task input: authoritative inputs (requirements, plan,
 * approved + current todos, the configured QA model, the current QA protocol
 * text, the structured context basis) plus, when present, the
 * non-authoritative feedback. The hash feeds the history record so a later
 * round can tell whether the standing scope changed. Every QA round executes
 * regardless — this never short-circuits. Pure.
 */
export function computeQaTaskInputHash(input: {
	requirements: string[];
	planMarkdown?: string;
	approvedTodos?: TodoItem[];
	todos: TodoItem[];
	qaModel: string;
	/** Current QA protocol text (buildQaProtocolText, single constant source). */
	protocolText: string;
	/** Structured context basis (configured/baseline/effective/compaction). */
	qaContext?: ReviewerContextBasis;
	/** Optional non-authoritative feedback on prior-round findings. */
	feedback?: string;
}): string {
	const feedback = normalizeWorkFeedback(input.feedback);
	const body = {
		requirements: input.requirements,
		planMarkdown: input.planMarkdown ?? "",
		approvedTodos: (input.approvedTodos ?? []).map((t) => [
			t.id,
			t.title,
			t.status,
			t.notes ?? "",
		]),
		todos: input.todos.map((t) => [t.id, t.title, t.status, t.notes ?? ""]),
		qaModel: input.qaModel,
		protocolText: input.protocolText,
		...(input.qaContext !== undefined
			? { qaContext: serializeReviewerContextBasis(input.qaContext) }
			: {}),
		...(feedback !== undefined ? { feedback } : {}),
	};
	return crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex");
}
