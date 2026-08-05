/**
 * ocr-result.ts — OCR JSON parsing, normalization, dedup, and compaction.
 *
 * `ocr review --audience agent --format json` produces a JSON document with a
 * stable top-level shape and a `comments[]` array. Each comment carries the
 * message, a proposed fix, the original code (a duplicate of repo source we
 * drop from the model view), line range, and model-generated severity/category.
 *
 * This module normalizes that JSON into a compact, stable finding model, saves
 * the full raw JSON to a temp file, dedups exact-duplicate findings, and emits
 * a compact result for the model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { OcrFinding, OcrReviewResult, OcrSeverity } from "./types.js";

// ── Raw JSON shapes (subset we depend on) ───────────────────────────────────

interface RawComment {
	path?: unknown;
	content?: unknown;
	suggestion_code?: unknown;
	existing_code?: unknown;
	start_line?: unknown;
	end_line?: unknown;
	category?: unknown;
	severity?: unknown;
	[key: string]: unknown;
}

interface RawSummary {
	files_reviewed?: unknown;
	comments?: unknown;
	total_tokens?: unknown;
	input_tokens?: unknown;
	output_tokens?: unknown;
	elapsed?: unknown;
	[key: string]: unknown;
}

interface RawReview {
	status?: unknown;
	message?: unknown;
	summary?: RawSummary;
	tool_calls?: unknown;
	comments?: unknown;
	session_id?: unknown;
	[key: string]: unknown;
}

// ── Normalization helpers ────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
	if (typeof v === "string" && v.length > 0) return v;
	return undefined;
}

function asNonNegInt(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.trunc(v);
	if (typeof v === "string" && /^\d+$/.test(v)) {
		const n = Number(v);
		if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
	}
	return undefined;
}

function asSeverity(v: unknown): OcrSeverity | undefined {
	const s = asString(v);
	if (!s) return undefined;
	return s.toLowerCase() as OcrSeverity;
}

/** Normalize a raw comment into a finding, or undefined if it has no usable identity. */
function normalizeFinding(c: RawComment): OcrFinding | undefined {
	const file = asString(c.path);
	const message = asString(c.content);
	const rule = asString(c.category) ?? "unknown";
	const severity = asSeverity(c.severity) ?? "info";
	const line = asNonNegInt(c.start_line);
	const endLine = asNonNegInt(c.end_line);
	const suggestion = asString(c.suggestion_code);

	// A finding needs at least a message or a file to be meaningful; drop
	// truly empty entries but keep unknown-but-valid shapes.
	if (!message && !file) return undefined;

	// Normalize endLine to line when absent so the fingerprint and the
	// returned finding use the same value — otherwise two findings at the
	// same single-line location (one with endLine absent, one with endLine ===
	// line) would produce different fingerprints and fail to dedup.
	const normalizedEndLine = endLine ?? line;

	const id = findingFingerprint({
		file: file ?? "",
		message: message ?? "",
		rule,
		severity,
		line,
		endLine: normalizedEndLine,
	});

	return {
		id,
		severity,
		rule,
		file: file ?? "(unknown)",
		line,
		endLine: normalizedEndLine,
		message: message ?? "(no message)",
		suggestion,
	};
}

/** Stable sha1 fingerprint of a finding's normalized identity. */
export function findingFingerprint(f: {
	file: string;
	message: string;
	rule: string;
	severity: OcrSeverity;
	line?: number;
	endLine?: number;
}): string {
	const parts = [
		f.file ?? "",
		f.message ?? "",
		f.rule ?? "",
		f.severity ?? "",
		f.line === undefined ? "" : String(f.line),
		f.endLine === undefined ? "" : String(f.endLine),
	];
	return crypto.createHash("sha1").update(parts.join("\u0001")).digest("hex").slice(0, 16);
}

/** Dedup findings by fingerprint, preserving first occurrence order. */
export function dedupFindings(findings: OcrFinding[]): OcrFinding[] {
	const seen = new Set<string>();
	const out: OcrFinding[] = [];
	for (const f of findings) {
		if (seen.has(f.id)) continue;
		seen.add(f.id);
		out.push(f);
	}
	return out;
}

/** Tally per-severity counts from a findings list. */
export function tallyCounts(findings: OcrFinding[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const f of findings) {
		counts[f.severity] = (counts[f.severity] ?? 0) + 1;
	}
	return counts;
}

// ── Raw output persistence ──────────────────────────────────────────────────

/** Directory for saved raw OCR JSON files. Created lazily. Best-effort
 *  evicts files older than one hour so long-running sessions do not
 *  accumulate raw output indefinitely. */
function rawOutputDir(): string {
	const dir = path.join(os.tmpdir(), "pi-workflow-ocr-raw");
	fs.mkdirSync(dir, { recursive: true });
	// Best-effort cleanup: remove files older than 1 hour. Never throw — this
	// is housekeeping, not a correctness path.
	try {
		for (const name of fs.readdirSync(dir)) {
			const fp = path.join(dir, name);
			try {
				if (Date.now() - fs.statSync(fp).mtimeMs > 3_600_000) fs.unlinkSync(fp);
			} catch {
				// ignore individual file cleanup failures
			}
		}
	} catch {
		// ignore directory listing failures
	}
	return dir;
}

/** Save raw text to a temp file; returns the absolute path. Best-effort. */
export function saveRawOutput(raw: string): string {
	const dir = rawOutputDir();
	const name = `ocr-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`;
	const fp = path.join(dir, name);
	try {
		fs.writeFileSync(fp, raw, "utf8");
	} catch (e) {
		// best effort; caller still gets the path for diagnostics, but log so the
		// missing file is traceable.
		console.warn(`saveRawOutput: failed to write ${fp}: ${e instanceof Error ? e.message : String(e)}`);
	}
	return fp;
}

// ── JSON parsing ─────────────────────────────────────────────────────────────

/** Parse raw OCR JSON into a normalized, deduped result. Preserves unknown-but-valid findings.
 *  Any error (JSON parse or post-parse normalization) is wrapped in
 *  OcrParseError carrying the saved raw file path. */
export function parseOcrReviewJson(raw: string): OcrReviewResult {
	let parsed: RawReview;
	let rawPath = "";
	try {
		// Save raw BEFORE parsing so a parse error still yields a path.
		rawPath = saveRawOutput(raw);
		parsed = JSON.parse(raw) as RawReview;
	} catch (e) {
		// Even on parse failure we saved the raw file above; surface its path.
		throw new OcrParseError(
			`OCR JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
			rawPath,
		);
	}

	try {
		return normalizeReview(parsed, rawPath);
	} catch (e) {
		// Post-parse normalization error (e.g. fingerprint hashing) — the raw
		// JSON was saved successfully, so surface its path plus the real cause.
		throw new OcrParseError(
			`OCR result normalization failed: ${e instanceof Error ? e.message : String(e)}`,
			rawPath,
		);
	}
}

/** Build the normalized result from a parsed review object and the saved raw path. */
function normalizeReview(parsed: RawReview, rawPath: string): OcrReviewResult {
	const status = asString(parsed.status) ?? "unknown";
	const message = asString(parsed.message);
	const sessionId = asString(parsed.session_id);

	const rawComments = Array.isArray(parsed.comments) ? (parsed.comments as RawComment[]) : [];
	const findings = dedupFindings(
		rawComments
			.map(normalizeFinding)
			.filter((f): f is OcrFinding => f !== undefined),
	);
	const counts = tallyCounts(findings);

	const summary = parsed.summary && typeof parsed.summary === "object" ? parsed.summary : {};
	const stats: OcrReviewResult["stats"] = {};
	const filesReviewed = asNonNegInt(summary.files_reviewed);
	if (filesReviewed !== undefined) stats.filesReviewed = filesReviewed;
	const totalTokens = asNonNegInt(summary.total_tokens);
	if (totalTokens !== undefined) stats.totalTokens = totalTokens;
	const elapsed = asString(summary.elapsed);
	if (elapsed) stats.elapsed = elapsed;

	return {
		status,
		message,
		rawPath,
		findings,
		counts,
		stats: Object.keys(stats).length > 0 ? stats : undefined,
		sessionId,
	};
}

/** Error carrying the raw JSON file path for diagnostics. */
export class OcrParseError extends Error {
	readonly rawPath: string;
	constructor(message: string, rawPath: string) {
		super(message);
		this.name = "OcrParseError";
		this.rawPath = rawPath;
	}
}

// ── Compact model-visible serialization ─────────────────────────────────────

/** Compact one-line finding representation for the model. */
export function formatFinding(f: OcrFinding): string {
	const loc = formatFindingLoc(f);
	// Collapse newlines in the suggestion so the finding stays readable and
	// does not spill across lines in the compact per-finding block.
	const suggestion = f.suggestion
		? `\n  suggestion: ${f.suggestion.replace(/\r\n|\n|\r/g, " ")}`
		: "";
	return `[${f.severity}] ${f.rule} @ ${loc} — ${f.message}${suggestion}`;
}

/** Build the compact location string for a finding. Extracted from
 *  formatFinding to avoid a nested ternary. */
function formatFindingLoc(f: OcrFinding): string {
	if (f.line === undefined) return f.file;
	if (f.endLine !== undefined && f.endLine !== f.line) return `${f.file}:${f.line}-${f.endLine}`;
	return `${f.file}:${f.line}`;
}

/** Build the compact model-visible text from a normalized result. */
export function compactReviewText(result: OcrReviewResult): string {
	const header = [
		`status: ${result.status}`,
		result.message ? `message: ${result.message}` : undefined,
		result.stats?.filesReviewed !== undefined ? `files: ${result.stats.filesReviewed}` : undefined,
		result.stats?.totalTokens !== undefined ? `tokens: ${result.stats.totalTokens}` : undefined,
		result.stats?.elapsed ? `elapsed: ${result.stats.elapsed}` : undefined,
		`findings: ${result.findings.length}`,
		result.findings.length > 0
			? `by severity: ${Object.entries(result.counts).map(([k, n]) => `${k}=${n}`).join(", ")}`
			: undefined,
		`raw: ${result.rawPath}`,
	].filter(Boolean).join("\n");

	if (result.findings.length === 0) {
		return `${header}\n\n(no findings)`;
	}

	const body = result.findings.map((f, i) => `${i + 1}. ${formatFinding(f)}`).join("\n");
	return `${header}\n\n${body}`;
}
