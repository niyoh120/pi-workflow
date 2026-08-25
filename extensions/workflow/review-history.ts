/**
 * review-history.ts — per-work-run review round persistence, workspace diff
 * fingerprinting, and delta computation for the unified review loop.
 *
 * Why this exists: each workflow_review round spawns a FRESH reviewer that
 * cannot see the previous round's findings, so every round re-derives the
 * whole review from scratch and re-runs the expensive workspace OCR even when
 * the diff barely changed. This module persists each round's verdict + full
 * reviewer output + normalized OCR findings + a workspace diff fingerprint +
 * a hash of every review task input (authoritative inputs plus any present
 * non-authoritative Work feedback), keyed by work run, so the next
 * round can:
 *
 *  1. inject the previous round's findings/evidence into the new reviewer
 *     task (re-disposition prior findings instead of re-deriving them);
 *  2. reuse cached OCR findings when the diff fingerprint is unchanged;
 *  3. short-circuit a review whose task inputs AND diff are identical to the
 *     last round (same verdict, no re-run).
 *
 * The verdict remains TRANSIENT: this file lives beside session state but is
 * separate from WorkflowState and never gates /wf-commit. The Work agent's tools
 * block direct reads of .pi/workflow/, so the reviewer child only ever sees
 * what the workflow_review tool puts into its task.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { reviewHistoryPath } from "./paths.js";
import type { OcrFinding, TodoItem } from "./types.js";

// ── Bounds ──────────────────────────────────────────────────────────────────

/** Keep at most this many rounds per work run (only the newest is injected). */
export const MAX_REVIEW_ROUNDS = 3;
/** Budget for the previous round's reviewer text injected into the new task.
 *  Head (coverage matrix) and tail (findings + verdict) are retained. */
export const PREVIOUS_ROUND_TEXT_BUDGET = 60_000;
/** Character budget for a Work agent's free-text review feedback. Bounds the
 *  non-authoritative feedback so a disputed-finding response cannot dominate
 *  the reviewer's context. */
export const WORK_FEEDBACK_TEXT_BUDGET = 20_000;
/** Untracked-file hashing bounds. Beyond these the diff fingerprint is marked
 *  unknown so OCR caching/short-circuit are skipped (a stale cache is worse
 *  than none). */
export const MAX_UNTRACKED_FILES = 200;
export const MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;

// ── Types ───────────────────────────────────────────────────────────────────

export type ReviewVerdictValue = "PASS" | "FAIL";

/** Per-round diff snapshot: aggregate fingerprint + per-file hashes so the
 *  next round can compute the exact set of files that changed since. */
export interface WorkspaceDiffSnapshot {
	fingerprint: string;
	/** sha1 of each changed tracked file's diff section (key: relative path). */
	fileHashes: Record<string, string>;
	/** sha1 of each untracked file's content (key: relative path). */
	untrackedHashes: Record<string, string>;
	/** True when untracked-file hashing hit a bound — treat the diff as
	 *  unverifiable (no OCR cache reuse, no short-circuit, full delta). */
	unknown: boolean;
}

export interface ReviewRoundRecord {
	workRunId: string;
	round: number;
	at: string;
	verdict: ReviewVerdictValue;
	verdictReason?: string;
	model: string;
	elapsedMs: number;
	turns: number;
	toolCalls: number;
	madeRepoToolCall: boolean;
	/** Full reviewer output as surfaced by workflow_review. */
	reviewerText: string;
	ocrEnabled: boolean;
	ocrCount: number;
	ocrCounts: Record<string, number>;
	ocrRawPath?: string;
	/** Normalized OCR findings — the cache source for unchanged-diff rounds. */
	ocrFindings: OcrFinding[];
	diffFingerprint: string;
	deltaUnknown: boolean;
	fileHashes: Record<string, string>;
	untrackedHashes: Record<string, string>;
	todoHash: string;
	/** Hash of the authoritative reviewer inputs (requirements/plan/todos/OCR
	 *  flag/model) plus any present non-authoritative Work feedback. Identical
	 *  inputs + identical diff ⇒ same verdict. */
	taskInputHash: string;
	/** True when this round was short-circuited (reused the previous round). */
	shortCircuited: boolean;
}

export interface ReviewHistory {
	workRunId: string;
	rounds: ReviewRoundRecord[];
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** Load the review history for a session. Missing/corrupt → undefined. */
export function loadReviewHistory(
	cwd: string,
	sessionKey: string,
): ReviewHistory | undefined {
	const p = reviewHistoryPath(cwd, sessionKey);
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<ReviewHistory>;
		if (!parsed || typeof parsed !== "object") return undefined;
		const workRunId =
			typeof parsed.workRunId === "string" ? parsed.workRunId : "";
		const rounds = Array.isArray(parsed.rounds)
			? (parsed.rounds as unknown[]).filter(isReviewRoundRecord)
			: [];
		return { workRunId, rounds };
	} catch {
		return undefined;
	}
}

function isReviewRoundRecord(v: unknown): v is ReviewRoundRecord {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.workRunId === "string" &&
		typeof o.round === "number" &&
		(typeof o.verdict === "string" || typeof o.verdict === "undefined") &&
		typeof o.reviewerText === "string"
	);
}

/**
 * Append (or replace, when the work run changed) a review round. Atomic
 * temp-file + rename write; caps rounds at MAX_REVIEW_ROUNDS (keeps the
 * newest). A new work runId discards the previous run's rounds.
 */
export function saveReviewRound(
	cwd: string,
	sessionKey: string,
	round: ReviewRoundRecord,
): void {
	const existing = loadReviewHistory(cwd, sessionKey);
	const history: ReviewHistory =
		existing && existing.workRunId === round.workRunId
			? { workRunId: round.workRunId, rounds: [...existing.rounds, round] }
			: { workRunId: round.workRunId, rounds: [round] };
	if (history.rounds.length > MAX_REVIEW_ROUNDS) {
		history.rounds = history.rounds.slice(history.rounds.length - MAX_REVIEW_ROUNDS);
	}
	const p = reviewHistoryPath(cwd, sessionKey);
	const dir = path.dirname(p);
	fs.mkdirSync(dir, { recursive: true });
	const tmpFile = path.join(
		dir,
		`.tmp-review-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// ── Workspace diff snapshot (git argv calls only, no shell) ─────────────────

/**
 * Compute the workspace diff snapshot in `cwd` (main checkout or active
 * worktree). Covers staged+unstaged changes vs HEAD and untracked file
 * contents — the same scope OCR reviews. Git failures (no repo, unborn HEAD)
 * degrade to "no tracked changes" rather than aborting the review loop.
 */
export function computeWorkspaceDiffSnapshot(cwd: string): WorkspaceDiffSnapshot {
	// Not a git repository (or git unavailable): diff detection is unreliable,
	// so mark the snapshot unknown — callers then skip OCR caching and the
	// same-input short-circuit (a file change without git would otherwise look
	// like "nothing changed").
	const gitDir = runGit(["rev-parse", "--git-dir"], cwd).trim();
	if (!gitDir) {
		return { fingerprint: "", fileHashes: {}, untrackedHashes: {}, unknown: true };
	}

	const head = runGit(["rev-parse", "HEAD"], cwd).trim();
	// `git diff HEAD` needs a commit. On an unborn HEAD fall back to
	// worktree-vs-index + index-vs-empty so staged files still register.
	// A diff exceeding maxBuffer must NOT be treated as "no changes" — it
	// marks the snapshot unknown so callers skip OCR caching/short-circuit.
	let unknown = false;
	let diffOut: string;
	try {
		diffOut = head
			? runGit(["diff", "HEAD", "--no-color"], cwd, 32 * 1024 * 1024)
			: [
					runGit(["diff", "--no-color"], cwd, 32 * 1024 * 1024),
					runGit(["diff", "--cached", "--no-color"], cwd, 32 * 1024 * 1024),
				].join("\n");
	} catch (err) {
		if (err instanceof GitOutputTooLargeError) {
			unknown = true;
			diffOut = "";
		} else {
			throw err;
		}
	}
	const status = runGit(["status", "--porcelain"], cwd);

	const fileHashes: Record<string, string> = {};
	for (const section of splitDiffSections(diffOut)) {
		const name = diffSectionFileName(section);
		if (name) fileHashes[name] = sha1(section);
	}

	// Untracked files: hash contents (bounded). Beyond the bounds the diff is
	// unverifiable — mark unknown so callers skip OCR caching/short-circuit.
	const untrackedHashes: Record<string, string> = {};
	const untrackedNames = runGit(["ls-files", "--others", "--exclude-standard"], cwd)
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	if (untrackedNames.length > MAX_UNTRACKED_FILES) {
		unknown = true;
	} else {
		let untrackedBytes = 0;
		for (const name of untrackedNames) {
			const content = readFileBounded(
				path.join(cwd, name),
				MAX_UNTRACKED_BYTES - untrackedBytes + 1,
			);
			if (content === undefined) {
				unknown = true;
				break;
			}
			untrackedHashes[name] = sha1(content);
			untrackedBytes += content.length;
		}
	}

	// `git diff HEAD` already covers staged + unstaged content, and untracked
	// contents are hashed above. The porcelain contributes only the changed-
	// file NAME set (a safety net for mode/type changes) with the XY status
	// column stripped, so staging a change does not perturb the fingerprint.
	// Porcelain lines are fixed `XY path` (2 status chars + space) or `?? path`
	// — slice on the RAW line: trim() would shift the path column.
	const statusNames = status
		.split("\n")
		.map((line) => (line.length > 3 ? unquoteGitPath(line.slice(3)) : ""))
		.filter(Boolean)
		.sort();

	const fingerprint = sha1(
		JSON.stringify({
			head,
			diffOut,
			statusNames,
			untracked: Object.keys(untrackedHashes)
				.sort()
				.map((k) => `${k}:${untrackedHashes[k]}`),
		}),
	);

	return { fingerprint, fileHashes, untrackedHashes, unknown };
}

function runGit(args: string[], cwd: string, maxBuffer = 16 * 1024 * 1024): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer,
			stdio: ["ignore", "pipe", "ignore"],
		}).toString();
	} catch (err) {
		// Output exceeded maxBuffer (ENOBUFS): the diff would be silently
		// truncated, which could make a real change look like "nothing
		// changed". Signal the caller to mark the snapshot unknown instead.
		if (isEnoBufsError(err)) throw new GitOutputTooLargeError(args[0] ?? "");
		// Not a git repo / unborn HEAD / transient failure — treat as
		// "no tracked changes" rather than aborting the review loop.
		return "";
	}
}

/** Error raised when a git command's stdout exceeds its maxBuffer. */
class GitOutputTooLargeError extends Error {
	constructor(command: string) {
		super(`git ${command} output exceeded maxBuffer`);
		this.name = "GitOutputTooLargeError";
	}
}

function isEnoBufsError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "ENOBUFS"
	);
}

/** Split a unified `git diff` output into per-file sections on `diff --git `. */
function splitDiffSections(diffOut: string): string[] {
	if (!diffOut.trim()) return [];
	const sections: string[] = [];
	let current: string[] = [];
	for (const line of diffOut.split("\n")) {
		if (line.startsWith("diff --git ")) {
			if (current.length) sections.push(current.join("\n"));
			current = [line];
		} else if (current.length) {
			current.push(line);
		}
	}
	if (current.length) sections.push(current.join("\n"));
	return sections;
}

/** Extract the `a/` path from a diff section's header (rename-tolerant). */
function diffSectionFileName(section: string): string | undefined {
	const header = section.split("\n")[0] ?? "";
	const spec = header.slice("diff --git ".length).trim();
	const token = spec.split(/\s+/)[0];
	if (!token) return undefined;
	const pathToken = token.startsWith("a/") ? token.slice(2) : token;
	return unquoteGitPath(pathToken);
}

/** Strip git's core.quotePath quoting from a path token. Imperfect decoding of
 *  octal escapes is acceptable — keys stay deterministic per path. */
export function unquoteGitPath(token: string): string {
	let s = token.trim();
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		s = s.slice(1, -1).replace(/\\([\\"])/g, "$1");
	}
	return s;
}

/** Read a file only when it is a regular file within `maxBytes`. */
function readFileBounded(file: string, maxBytes: number): string | undefined {
	try {
		const st = fs.statSync(file);
		if (!st.isFile() || st.size > maxBytes) return undefined;
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

// ── Pure helpers (unit-tested by the validation scripts) ────────────────────

/** Deterministic hash of a todo list (id/title/status/notes). Pure. */
export function computeTodoHash(todos: TodoItem[] | undefined): string {
	const body = (todos ?? []).map((t) => [t.id, t.title, t.status, t.notes ?? ""]);
	return crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex");
}

/** Files whose tracked diff or untracked content changed between rounds. Pure.
 *  Accepts any object carrying per-file hashes (WorkspaceDiffSnapshot or a
 *  persisted ReviewRoundRecord). */
export function filesChangedSince(
	prev: Pick<WorkspaceDiffSnapshot, "fileHashes" | "untrackedHashes">,
	curr: Pick<WorkspaceDiffSnapshot, "fileHashes" | "untrackedHashes">,
): string[] {
	const names = new Set<string>([
		...Object.keys(prev.fileHashes),
		...Object.keys(prev.untrackedHashes),
		...Object.keys(curr.fileHashes),
		...Object.keys(curr.untrackedHashes),
	]);
	const changed: string[] = [];
	for (const name of names) {
		const p = prev.fileHashes[name] ?? prev.untrackedHashes[name];
		const c = curr.fileHashes[name] ?? curr.untrackedHashes[name];
		if (p !== c) changed.push(name);
	}
	return changed.sort();
}

/** Keep the head (coverage matrix) and tail (findings + verdict) of a long
 *  reviewer output within `max` chars, with a separator between them. Pure. */
export function boundedHeadTail(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max < 24) return text.slice(0, max);
	const sep = "\n\n… [truncated] …\n\n";
	const body = max - sep.length;
	const headLen = Math.floor(body * 0.4);
	const tailLen = body - headLen;
	return `${text.slice(0, headLen)}${sep}${text.slice(text.length - tailLen)}`;
}

/**
 * Normalize a Work agent's free-text response to a prior review round's
 * disputed findings. Accepts the unknown boundary value from tool/runner
 * call sites, trims leading/trailing whitespace, maps blank strings to
 * undefined, and bounds the length with the same head/tail policy used for
 * the previous round's reviewer text.
 *
 * Reuses the generic boundedHeadTail truncation to preserve the feedback's
 * opening (problem location) and tail (supporting evidence). The 40/60 split
 * carries the same generic head/tail retention intent — it expresses NO
 * reviewer-output coverage/verdict semantics.
 *
 * Idempotent: the bounded result is within budget, so re-applying the
 * function is a no-op; tool, task builder, and task hash can all share one
 * normalized value. Pure.
 */
export function normalizeWorkFeedback(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	return boundedHeadTail(trimmed, WORK_FEEDBACK_TEXT_BUDGET);
}

/**
 * Hash of every reviewer task input: authoritative inputs (requirements,
 * plan, approved + current todos, the OCR flag, the configured review model,
 * the current reviewer protocol text) plus, when present, the non-authoritative
 * Work feedback. Two rounds with the same hash AND the same diff fingerprint
 * receive the same verdict.
 *
 * `protocolText` comes from buildImplementationReviewProtocolText() — the
 * single constant source of the reviewer's behavioral protocol — so a
 * protocol change (e.g. the verdict-transport migration to review_submit)
 * invalidates unchanged-diff reuse of rounds produced under the older
 * protocol in one shot.
 *
 * Feedback is idempotently re-normalized here so future call sites cannot
 * drift; a missing/blank feedback contributes NO key, keeping the hash body
 * byte-identical to the pre-feedback algorithm (modulo the protocolText key)
 * so pre-upgrade no-feedback review history still short-circuits only when
 * the protocol is also unchanged. Pure.
 */
export function computeTaskInputHash(input: {
	requirements: string[];
	planMarkdown?: string;
	approvedTodos?: TodoItem[];
	todos: TodoItem[];
	includeOcr: boolean;
	reviewModel: string;
	/** Current Implementation Review protocol text (single constant source). */
	protocolText: string;
	/** Optional non-authoritative Work feedback on prior-round findings. */
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
		includeOcr: input.includeOcr,
		reviewModel: input.reviewModel,
		protocolText: input.protocolText,
		...(feedback !== undefined ? { feedback } : {}),
	};
	return crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex");
}

function sha1(text: string): string {
	return crypto.createHash("sha1").update(text).digest("hex");
}
