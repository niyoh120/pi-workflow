import fs from "node:fs";
import path from "node:path";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import {
	sessionStatePath,
	deriveSessionKey,
	planDir,
	generatePlanFilename,
} from "./paths.js";
import { branchMatchesWorkRun } from "./worktree.js";

/** Minimal session manager interface needed to derive the session key. */
export interface SessionKeySource {
	getSessionId?: () => string;
	getSessionFile?: () => string | null | undefined;
}

/** Derive the safe session key from a context-like object. */
/** Derive the safe session key from a context-like object.
 *  Accepts any object that may have a sessionManager property
 *  or is itself a session-like object. */
export function getSessionKey(ctx: any): string {
	const sm = ctx?.sessionManager ?? ctx;
	return deriveSessionKey(sm ?? {});
}

/** Normalize a raw TodoItem[] array. Shared by todos and approvedTodos so
 *  both todo fields stay in sync and reject malformed shapes consistently. */
function normalizeTodos(raw: unknown): WorkflowState["todos"] {
	return Array.isArray(raw)
		? (raw as Array<WorkflowState["todos"][number]>)
				.filter((t: any) => t && typeof t === "object")
				.map((t: any) => ({
					id: t.id ?? "",
					title: t.title ?? "",
					status:
						t.status === "pending" ||
						t.status === "in_progress" ||
						t.status === "done" ||
						t.status === "blocked"
							? t.status
							: "pending",
					notes: typeof t.notes === "string" ? t.notes : undefined,
				}))
		: [];
}

/** Normalize a raw GrillTurn[] array. Shared by grillTurns and
 *  planReviewDecisions so both review-context fields stay in sync. */
function normalizeGrillTurns(raw: unknown): WorkflowState["grillTurns"] {
	return Array.isArray(raw)
		? (raw as Array<WorkflowState["grillTurns"][number]>)
				.filter((t: any) => t && typeof t === "object")
				.map((t: any) => ({
					question: typeof t.question === "string" ? t.question : "",
					recommendedAnswer:
						typeof t.recommendedAnswer === "string"
							? t.recommendedAnswer
							: "",
					userAnswer:
						typeof t.userAnswer === "string" ? t.userAnswer : undefined,
					decisionStatus:
						t.decisionStatus === "resolved" ||
						t.decisionStatus === "open" ||
						t.decisionStatus === "needs-codebase-check"
							? t.decisionStatus
							: "open",
					notes: typeof t.notes === "string" ? t.notes : undefined,
				}))
		: [];
}

/**
 * Normalize a raw MergeContext object. Returns undefined for any malformed
 * shape — a merge context without its full baseline is useless (the default
 * finalizer and the cancel path both need source/target heads and branches),
 * so normalization fails closed and forces re-entry via /wf-merge.
 * Kept annotation-simple so the regression script can extract and eval it.
 */
function normalizeMergeContext(raw: unknown): WorkflowState["mergeContext"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const c = raw as Record<string, unknown>;
	const sourceKind =
		c.sourceKind === "workflow-worktree" || c.sourceKind === "ordinary-branch"
			? c.sourceKind
			: undefined;
	const sourceBranch =
		typeof c.sourceBranch === "string" ? c.sourceBranch.trim() : "";
	const targetBranch =
		typeof c.targetBranch === "string" ? c.targetBranch.trim() : "";
	const sourceHeadBefore =
		typeof c.sourceHeadBefore === "string" ? c.sourceHeadBefore.trim() : "";
	const targetHeadBefore =
		typeof c.targetHeadBefore === "string" ? c.targetHeadBefore.trim() : "";
	const count = c.sourceOnlyCommitCountBefore;
	const sourceOnlyCommitCountBefore =
		typeof count === "number" && Number.isFinite(count) && count >= 0
			? Math.floor(count)
			: undefined;
	const defaultStrategy =
		typeof c.defaultStrategy === "boolean" ? c.defaultStrategy : undefined;
	const returnMode =
		c.returnMode === "explore" ||
		c.returnMode === "plan" ||
		c.returnMode === "work" ||
		c.returnMode === "commit"
			? c.returnMode
			: undefined;
	if (
		!sourceKind ||
		!sourceBranch ||
		!targetBranch ||
		!sourceHeadBefore ||
		!targetHeadBefore ||
		sourceOnlyCommitCountBefore === undefined ||
		defaultStrategy === undefined ||
		!returnMode
	) {
		return undefined;
	}
	return {
		sourceKind,
		sourceBranch,
		targetBranch,
		sourceHeadBefore,
		targetHeadBefore,
		sourceOnlyCommitCountBefore,
		instructions:
			typeof c.instructions === "string" && c.instructions.trim()
				? c.instructions
				: undefined,
		defaultStrategy,
		returnMode,
	};
}

/**
 * Normalize a raw JSON object into a strict WorkflowState shape.
 * Drops unknown/removed keys and fills missing fields from DEFAULT_STATE.
 */
export function normalizeState(raw: unknown): WorkflowState {
	const obj =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	const worktreePrefix =
		typeof obj.workRunId === "string"
			? obj.workRunId.match(/^[a-fA-F0-9]{8}/)?.[0]
			: undefined;
	const workRunIdStr = typeof obj.workRunId === "string" ? obj.workRunId : "";

	return {
		workflowEnabled:
			typeof obj.workflowEnabled === "boolean"
				? obj.workflowEnabled
				: DEFAULT_STATE.workflowEnabled,
		workflowExplicitlyDisabled:
			typeof obj.workflowExplicitlyDisabled === "boolean"
				? obj.workflowExplicitlyDisabled
				: DEFAULT_STATE.workflowExplicitlyDisabled,
		mode:
			typeof obj.mode === "string" &&
			(obj.mode === "idle" ||
				obj.mode === "explore" ||
				obj.mode === "init" ||
				obj.mode === "plan" ||
				obj.mode === "work" ||
				obj.mode === "merge" ||
				obj.mode === "commit")
				? obj.mode
				: DEFAULT_STATE.mode,
		planPath: typeof obj.planPath === "string" ? obj.planPath : undefined,
		planTitle: typeof obj.planTitle === "string" ? obj.planTitle : undefined,
		planRunId: typeof obj.planRunId === "string" ? obj.planRunId : undefined,
		workRunId: typeof obj.workRunId === "string" ? obj.workRunId : undefined,
		worktreePath:
			worktreePrefix &&
			typeof obj.worktreePath === "string" &&
			typeof obj.worktreeBranch === "string" &&
			obj.worktreePath.trim() &&
			path.isAbsolute(obj.worktreePath.trim()) &&
			path.basename(obj.worktreePath.trim()).endsWith(`-wf-${worktreePrefix}`) &&
			branchMatchesWorkRun(obj.worktreeBranch.trim(), workRunIdStr)
				? obj.worktreePath.trim()
				: undefined,
		worktreeBranch:
			worktreePrefix &&
			typeof obj.worktreeBranch === "string" &&
			branchMatchesWorkRun(obj.worktreeBranch.trim(), workRunIdStr)
				? obj.worktreeBranch.trim()
				: undefined,
		worktreeBaseBranch:
			typeof obj.worktreeBaseBranch === "string" &&
			obj.worktreeBaseBranch.trim()
				? obj.worktreeBaseBranch
				: undefined,
		pendingWorkKickoff:
			typeof obj.pendingWorkKickoff === "string" &&
			obj.pendingWorkKickoff.trim()
				? obj.pendingWorkKickoff.trim()
				: undefined,
		todos: normalizeTodos(obj.todos),
		approvedTodos:
			Array.isArray(obj.approvedTodos) && obj.approvedTodos.length > 0
				? normalizeTodos(obj.approvedTodos)
				: undefined,
		workStartEntryId:
			typeof obj.workStartEntryId === "string" &&
			obj.workStartEntryId.trim()
				? obj.workStartEntryId.trim()
				: undefined,
		grillTurns: normalizeGrillTurns(obj.grillTurns),
		planStartEntryId:
			typeof obj.planStartEntryId === "string" && obj.planStartEntryId.trim()
				? obj.planStartEntryId.trim()
				: undefined,
		// planReviewDecisions reuses the same GrillTurn shape as grillTurns;
		// normalize through the shared pure helper to avoid drift.
		planReviewDecisions: normalizeGrillTurns(obj.planReviewDecisions),
		// Init Mode lifecycle fields. Only honored when mode === "init" and
		// the shape matches; everything else normalizes to undefined so stale
		// values from a previous run cannot leak into another mode.
		initReturnMode:
			obj.mode === "init" &&
			typeof obj.initReturnMode === "string" &&
			(obj.initReturnMode === "explore" ||
				obj.initReturnMode === "plan" ||
				obj.initReturnMode === "work" ||
				obj.initReturnMode === "commit")
				? obj.initReturnMode
				: undefined,
		initTargetPath:
			obj.mode === "init" &&
			typeof obj.initTargetPath === "string" &&
			obj.initTargetPath.trim() &&
			path.isAbsolute(obj.initTargetPath.trim())
				? obj.initTargetPath.trim()
				: undefined,
		// Merge Mode lifecycle field. Only honored when mode === "merge" and the
		// full baseline shape survives strict validation; every other mode (and
		// any malformed context) normalizes to undefined so a stale merge
		// baseline cannot leak into another workflow.
		mergeContext:
			obj.mode === "merge"
				? normalizeMergeContext(obj.mergeContext)
				: undefined,
		// Preserve session config overrides as a plain object, stripping any
		// dangerous keys (__proto__/constructor/prototype) so a corrupt or
		// malicious state file can't pollute prototypes during later deepMerge.
		// Per-field normalization happens in normalizeConfig() after merge.
		...(() => {
			const raw = obj.sessionConfig;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
			const dangerous = ["__proto__", "constructor", "prototype"];
			const entries = Object.entries(raw as Record<string, unknown>).filter(
				([key]) => !dangerous.includes(key),
			);
			return {
				sessionConfig: Object.fromEntries(
					entries,
				) as WorkflowState["sessionConfig"],
			};
		})(),
	};
}

/**
 * Load runtime state from the session-scoped path.
 * Normalizes the result so removed/unknown keys are dropped.
 * Falls back to DEFAULT_STATE if the file is missing or corrupt.
 * Does NOT create any directories — only saveState creates dirs.
 */
export function loadState(cwd: string, sessionKey: string): WorkflowState {
	const spath = sessionStatePath(cwd, sessionKey);

	if (!fs.existsSync(spath)) {
		return { ...DEFAULT_STATE };
	}

	try {
		return normalizeState(JSON.parse(fs.readFileSync(spath, "utf8")));
	} catch {
		return { ...DEFAULT_STATE };
	}
}

/** Persist runtime state to the session-scoped path with normalization.
 *  Uses atomic temp-file + rename to prevent partial-write corruption.
 *  Creates the session directory only when actually writing. */
export function saveState(
	cwd: string,
	sessionKey: string,
	state: WorkflowState,
): void {
	const spath = sessionStatePath(cwd, sessionKey);
	const dir = path.dirname(spath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpFile = path.join(
		dir,
		`.tmp-state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	try {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify(normalizeState(state), null, 2),
			"utf8",
		);
		fs.renameSync(tmpFile, spath);
	} catch (err) {
		// Clean up temp file on failure; rethrow so callers see the error.
		try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
		throw err;
	}
}

// ── Session advisory lock ────────────────────────────────────────────────────

/**
 * Acquire a per-session advisory lock for the pending-work dispatcher.
 * Uses atomic `openSync(lockPath, "wx")` to claim; writes pid for liveness
 * checks. Returns true if the lock was acquired, false if another live
 * process holds it.
 *
 * Stale locks (pid no longer alive) are cleaned up and retried once.
 * Permission/unknown errors are treated conservatively as "locked".
 */
export function acquireDispatcherLock(
	cwd: string,
	sessionKey: string,
): boolean {
	const lockPath = sessionStatePath(cwd, sessionKey) + ".dispatch.lock";
	const dir = path.dirname(lockPath);
	fs.mkdirSync(dir, { recursive: true });

	const tryClaim = (): boolean => {
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
			fs.closeSync(fd);
			return true;
		} catch (err: any) {
			if (err?.code !== "EEXIST") return false; // permission/unknown → skip
			// Lock exists — check pid liveness.
			try {
				const raw = fs.readFileSync(lockPath, "utf8");
				const { pid } = JSON.parse(raw) as { pid?: number };
				if (typeof pid === "number" && isPidAlive(pid)) {
					return false; // live process holds lock
				}
			} catch {
				// Corrupt/unreadable lock — treat as live to be safe.
				return false;
			}
			// Dead pid — remove stale lock and retry once.
			try { fs.unlinkSync(lockPath); } catch { return false; }
			try {
				const fd = fs.openSync(lockPath, "wx");
				fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
				fs.closeSync(fd);
				return true;
			} catch {
				return false;
			}
		}
	};

	return tryClaim();
}

/** Release the per-session advisory lock. Best-effort; errors are swallowed. */
export function releaseDispatcherLock(
	cwd: string,
	sessionKey: string,
): void {
	const lockPath = sessionStatePath(cwd, sessionKey) + ".dispatch.lock";
	try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
}

/** Check whether a process with the given pid is alive. */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Allocate a new plan file in the plan directory.
 * Generates a random filename and writes `content` to it.
 * Returns relative path for planPath.
 */
export function writeNewPlan(cwd: string, content: string): string {
	const dir = planDir(cwd);
	// planDir() is now a pure path getter; create the directory at write time.
	fs.mkdirSync(dir, { recursive: true });
	const planFile = generatePlanFilename();
	const planAbs = path.join(dir, planFile);
	fs.writeFileSync(planAbs, content, "utf8");
	return path.relative(cwd, planAbs);
}

/**
 * Update the existing plan file on disk with new content.
 * Uses atomic write (temp-file + rename) to prevent partial-write corruption.
 */
export function updatePlan(
	cwd: string,
	planPath: string,
	content: string,
): void {
	if (!planPath) {
		throw new Error("updatePlan requires planPath to be set");
	}

	const planAbs = path.join(cwd, planPath);

	// Atomic write: write to temp file in same directory, then rename
	const tmpFile = path.join(
		path.dirname(planAbs),
		`.tmp-plan-update-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	fs.writeFileSync(tmpFile, content, "utf8");
	fs.renameSync(tmpFile, planAbs);
}

/** Read the current plan file from disk. Returns empty string if not found. */
export function readPlan(cwd: string, planPath: string): string {
	const file = path.join(cwd, planPath);
	if (fs.existsSync(file)) {
		return fs.readFileSync(file, "utf8");
	}
	return "";
}

/** Read the plan and return its trimmed text, or undefined when the file is
 *  missing or contains only whitespace. Used by callers that need to
 *  distinguish "no usable plan" from a valid plan body. */
export function readPlanTrimmed(cwd: string, planPath: string): string | undefined {
	const text = readPlan(cwd, planPath).trim();
	return text ? text : undefined;
}

/** Read the plan or throw an explicit error when it is missing or blank.
 *  Used by plan read/review/approve paths that must surface a clear error
 *  instead of silently proceeding with an empty plan. */
export function requirePlanMarkdown(cwd: string, planPath: string): string {
	const text = readPlanTrimmed(cwd, planPath);
	if (!text) {
		throw new Error(
			`Active plan is missing or empty: ${planPath}. Re-enter /plan and save a plan first.`,
		);
	}
	return text;
}
