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

	return {
		workflowEnabled:
			typeof obj.workflowEnabled === "boolean"
				? obj.workflowEnabled
				: DEFAULT_STATE.workflowEnabled,
		workflowExplicitlyDisabled:
			typeof obj.workflowExplicitlyDisabled === "boolean"
				? obj.workflowExplicitlyDisabled
				: DEFAULT_STATE.workflowExplicitlyDisabled,
		mode: (typeof obj.mode === "string"
			? obj.mode
			: DEFAULT_STATE.mode) as WorkflowState["mode"],
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
			obj.worktreeBranch.trim() === `wf/${worktreePrefix}`
				? obj.worktreePath.trim()
				: undefined,
		worktreeBranch:
			worktreePrefix &&
			typeof obj.worktreeBranch === "string" &&
			obj.worktreeBranch.trim() === `wf/${worktreePrefix}`
				? obj.worktreeBranch.trim()
				: undefined,
		worktreeBaseBranch:
			typeof obj.worktreeBaseBranch === "string" &&
			obj.worktreeBaseBranch.trim()
				? obj.worktreeBaseBranch
				: undefined,
		todos: Array.isArray(obj.todos)
			? (obj.todos as Array<WorkflowState["todos"][number]>)
					.filter((t: any) => t && typeof t === "object")
					.map((t: any) => ({
						id: t.id ?? "",
						title: t.title ?? "",
						status: t.status ?? "pending",
						notes: t.notes,
					}))
			: [],
		hiddenDoneIds: Array.isArray(obj.hiddenDoneIds)
			? (obj.hiddenDoneIds as string[]).filter(
					(id: any) => typeof id === "string",
				)
			: [],
		grillTurns: Array.isArray(obj.grillTurns)
			? (obj.grillTurns as Array<WorkflowState["grillTurns"][number]>)
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
			: [],
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
 *  Creates the session directory only when actually writing. */
export function saveState(
	cwd: string,
	sessionKey: string,
	state: WorkflowState,
): void {
	const spath = sessionStatePath(cwd, sessionKey);
	fs.mkdirSync(path.dirname(spath), { recursive: true });
	fs.writeFileSync(
		spath,
		JSON.stringify(normalizeState(state), null, 2),
		"utf8",
	);
}

/**
 * Allocate a new plan file in the plan directory.
 * Generates a random filename and writes `content` to it.
 * Returns relative path for planPath.
 */
export function writeNewPlan(cwd: string, content: string): string {
	const dir = planDir(cwd);
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
