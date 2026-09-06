/**
 * model-context.ts — per-role context-window override: pure numeric
 * parse/validation, model cloning, compaction snapshots, and diagnostics.
 *
 * Contract (single source for setRole, settings, reviewers, and status):
 *  - Config value is a number of TOKENS, optional per model role.
 *  - JSON accepts only number; UI accepts a strict decimal integer string.
 *  - Bounds: value must be a positive safe integer AND
 *      reserveTokens + keepRecentTokens < value < Pi baseline contextWindow
 *    (strictly less than the baseline — equality is an error). The baseline
 *    comes from the raw registry/child-runtime model (including Pi's own
 *    models.json overrides), independent of any workflow-cloned active model.
 *  - The dynamic lower bound is a floor, not a guarantee: system prompt,
 *    summaries, or a single huge tool result may still exceed the budget.
 *  - Invalid configured values are NEVER silently dropped or clamped — they
 *    surface as explicit errors at the apply/settings boundary so the config
 *    stays inspectable and recoverable (clear the field to inherit again).
 *
 * Main-session validation uses a trust-aware DISK snapshot of Pi settings
 * (SettingsManager.create): the live in-session SettingsManager is not exposed
 * on ExtensionContext, so a setting saved moments ago may not be reflected
 * until Pi flushes it — an accepted approximation, noted in error text.
 */

import type { Model } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ReviewerContextBasis } from "./types.js";

// ── Compaction snapshot ────────────────────────────────────────────────────

/** Pi compaction parameters relevant to the window lower bound. */
export interface CompactionSnapshot {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

/** Read the compaction snapshot off a SettingsManager instance. */
export function readCompactionSnapshot(sm: SettingsManager): CompactionSnapshot {
	const s = sm.getCompactionSettings();
	return {
		enabled: !!s.enabled,
		reserveTokens: s.reserveTokens,
		keepRecentTokens: s.keepRecentTokens,
	};
}

export type CompactionSnapshotResult =
	| { ok: true; compaction: CompactionSnapshot }
	| { ok: false; error: string };

/**
 * Trust-aware DISK snapshot of Pi settings for the main session (Extension
 * exposes no live SettingsManager). Load errors are surfaced explicitly: a
 * broken settings.json must not silently degrade the window lower bound to
 * SDK defaults.
 */
export function loadDiskCompactionSnapshot(
	cwd: string,
	agentDir: string,
	projectTrusted: boolean,
): CompactionSnapshotResult {
	try {
		const sm = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const errors = sm.drainErrors();
		if (errors.length > 0) {
			const detail = errors
				.map((e) => `${e.scope}${e.path ? ` (${e.path})` : ""}: ${e.error?.message ?? String(e.error)}`)
				.join("; ");
			return {
				ok: false,
				error: `Pi settings could not be loaded from disk: ${detail}`,
			};
		}
		return { ok: true, compaction: readCompactionSnapshot(sm) };
	} catch (e) {
		return {
			ok: false,
			error: `Pi settings could not be read: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

/** Structural sanity for compaction numbers (guards hash/validate inputs). */
function isSaneTokenCount(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export function isCompactionSnapshotSane(c: CompactionSnapshot): boolean {
	return (
		isSaneTokenCount(c.reserveTokens) && isSaneTokenCount(c.keepRecentTokens)
	);
}

// ── UI input parsing ───────────────────────────────────────────────────────

export type ContextWindowParseResult =
	| { ok: true; value: number }
	| { ok: false; error: string };

/**
 * Strictly parse a UI context-window input: a plain decimal integer string.
 * Rejects decimals, signs, exponents, trailing characters, blank-adjacent
 * noise, NaN/Infinity spellings, and anything beyond the safe-integer range.
 */
export function parseContextWindowInput(raw: string): ContextWindowParseResult {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) {
		return {
			ok: false,
			error: "请输入十进制整数 token 数（例如 120000）；拒绝小数、负数、指数与尾随字符。",
		};
	}
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value)) {
		return { ok: false, error: "数值超出安全整数范围。" };
	}
	return { ok: true, value };
}

// ── Validation & cloning ───────────────────────────────────────────────────

export interface ContextWindowBounds {
	/** Exclusive lower bound (reserveTokens + keepRecentTokens). */
	minExclusive: number;
	/** Exclusive upper bound (Pi baseline window). */
	maxExclusive: number;
}

export type ContextWindowValidation =
	| { ok: true }
	| { ok: false; error: string; bounds?: ContextWindowBounds };

/**
 * Validate a configured context-window value against the Pi baseline window
 * and the compaction snapshot. Pure.
 */
export function validateContextWindowValue(
	value: unknown,
	baselineWindow: number,
	compaction: CompactionSnapshot,
): ContextWindowValidation {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		!Number.isSafeInteger(value) ||
		value <= 0
	) {
		return {
			ok: false,
			error: "contextWindow 必须是正整数 token 数（JSON 中为 number 类型）。",
		};
	}
	if (
		typeof baselineWindow !== "number" ||
		!Number.isFinite(baselineWindow) ||
		baselineWindow <= 0
	) {
		return {
			ok: false,
			error: `无法取得 Pi 基准窗口（registry 返回 ${String(baselineWindow)}），拒绝应用覆盖。`,
		};
	}
	if (!isCompactionSnapshotSane(compaction)) {
		return {
			ok: false,
			error: "无法取得合法的 Pi 压缩设置（reserveTokens / keepRecentTokens），拒绝应用覆盖。",
		};
	}
	const bounds: ContextWindowBounds = {
		minExclusive: compaction.reserveTokens + compaction.keepRecentTokens,
		maxExclusive: baselineWindow,
	};
	if (value >= baselineWindow) {
		return {
			ok: false,
			error: `contextWindow 必须严格小于 Pi 默认窗口 ${baselineWindow}（当前 ${value}）。`,
			bounds,
		};
	}
	if (value <= bounds.minExclusive) {
		return {
			ok: false,
			error: `contextWindow 必须大于压缩预留 ${compaction.reserveTokens} + 保留近期 ${compaction.keepRecentTokens} = ${bounds.minExclusive}（当前 ${value}）。`,
			bounds,
		};
	}
	return { ok: true };
}

export type PreparedContextWindowModel =
	| {
			ok: true;
			model: Model<any>;
			appliedWindow: number;
			originalWindow: number;
	  }
	| { ok: false; error: string };

/**
 * Validate a requested override and produce the shallow-cloned model. The
 * registry object itself is never mutated. Pure.
 */
export function prepareModelWithContextWindow(
	baselineModel: Model<any>,
	requested: unknown,
	compaction: CompactionSnapshot,
): PreparedContextWindowModel {
	const check = validateContextWindowValue(
		requested,
		baselineModel?.contextWindow,
		compaction,
	);
	if (!check.ok) return { ok: false, error: check.error };
	return {
		ok: true,
		model: cloneModelWithContextWindow(baselineModel, requested as number),
		appliedWindow: requested as number,
		originalWindow: baselineModel.contextWindow,
	};
}

/**
 * Shallow-clone a model with a replaced contextWindow. Provider/id/auth/
 * maxTokens/compat and every other field are carried over untouched; the
 * registry's original object stays immutable.
 */
export function cloneModelWithContextWindow<M extends { contextWindow: number }>(
	model: M,
	contextWindow: number,
): M {
	return { ...model, contextWindow };
}

/**
 * Normalize a ReviewerContextBasis into a stable serialization shape for
 * hashing: fixed key order, `configured` present only when an override
 * exists. Shared by both reviewer hash builders (plan-review basis hash and
 * implementation-review task-input hash). Pure.
 */
export function serializeReviewerContextBasis(
	basis: ReviewerContextBasis,
): Record<string, unknown> {
	return {
		...(basis.configured !== undefined ? { configured: basis.configured } : {}),
		piBaseline: basis.piBaseline,
		effective: basis.effective,
		compaction: {
			enabled: basis.compaction.enabled,
			reserveTokens: basis.compaction.reserveTokens,
			keepRecentTokens: basis.compaction.keepRecentTokens,
		},
	};
}

// ── Diagnostics / display ──────────────────────────────────────────────────

/** Human-readable acceptable range, e.g. "36385 ~ 199999 tokens". */
export function formatContextWindowRange(
	baselineWindow: number,
	compaction: CompactionSnapshot,
): string {
	if (
		typeof baselineWindow !== "number" ||
		!Number.isFinite(baselineWindow) ||
		baselineWindow <= 0 ||
		!isCompactionSnapshotSane(compaction)
	) {
		return "(unavailable — Pi baseline or compaction settings unreadable)";
	}
	const min = compaction.reserveTokens + compaction.keepRecentTokens;
	return `${min + 1} ~ ${baselineWindow - 1} tokens (both ends exclusive)`;
}

/**
 * Build the apply-boundary error shown when a role's configured window fails
 * validation: role, provider/model, input value, bounds, and the recovery
 * path (clear the field or pick a value inside the range).
 */
export function buildContextWindowApplyError(opts: {
	role: string;
	provider: string;
	model: string;
	rawValue: unknown;
	reason: string;
	baselineWindow?: number;
	compaction?: CompactionSnapshot;
}): string {
	const range =
		opts.baselineWindow !== undefined && opts.compaction
			? `可接受区间：${formatContextWindowRange(opts.baselineWindow, opts.compaction)}。`
			: "";
	const raw =
		typeof opts.rawValue === "number"
			? String(opts.rawValue)
			: JSON.stringify(opts.rawValue);
	return (
		`models.${opts.role}.contextWindow 无效（${opts.provider}/${opts.model}，输入 ${raw}）：` +
		`${opts.reason} ${range}` +
		`请清除该字段（继承 Pi 默认窗口）或改为区间内的整数。主会话校验基于磁盘设置快照，可能与本会话未落盘的内存设置短暂不一致。`
	);
}
