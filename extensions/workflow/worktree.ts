import { execFileSync as nodeExecFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowState } from "./types.js";

export interface WorktreeDeps {
	execFileSync?: typeof nodeExecFileSync;
	existsSync?: typeof fs.existsSync;
	realpathSync?: typeof fs.realpathSync;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	baseBranch: string;
}

export type WorktreeValidation =
	| { ok: true }
	| { ok: false; reason: string };

function execGit(
	cwd: string,
	args: string[],
	deps: WorktreeDeps = {},
): string {
	const execFileSync = deps.execFileSync ?? nodeExecFileSync;
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 120_000,
	}).trim();
}

function gitPath(cwd: string, value: string, realpath: typeof fs.realpathSync): string {
	return realpath(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function slugName(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "repo";
}

const WORKRUN_ID_PREFIX_RE = /^([a-fA-F0-9]{8})/;

/**
 * Suffix tag marking a branch as workflow-owned. Used by state validation and
 * deleteWorktreeBranch to scope safe deletion.
 */
export const WORKTREE_BRANCH_SUFFIX_RE = /@wf-([a-fA-F0-9]{8})$/;

function workRunIdPrefix(workRunId: string): string {
	return workRunId.replace(/[^a-fA-F0-9-]/g, "").slice(0, 8) || "worktree";
}

/**
 * Whether a branch belongs to the given work run. Accepts both the legacy
 * `wf/<8hex>` form and the semantic `<slug>@wf-<8hex>` form. Pure helper
 * shared by state normalization and worktree validation so the matching rule
 * stays in one place.
 */
export function branchMatchesWorkRun(branch: string, workRunId: string): boolean {
	const prefix = workRunIdPrefix(workRunId);
	return branch === `wf/${prefix}` || branch.endsWith(`@wf-${prefix}`);
}

/**
 * Build the full workflow branch name: `<semantic>@wf-<8hex>`.
 * Falls back to a workflow-only name when no semantic part is provided.
 */
export function buildWorktreeBranchName(
	workRunId: string,
	semantic?: string,
): string {
	const tag = `@wf-${workRunIdPrefix(workRunId)}`;
	const cleaned = (semantic ?? "").trim();
	return cleaned ? `${cleaned}${tag}` : `wf/${workRunIdPrefix(workRunId)}`;
}

/**
 * Validate a user-provided semantic branch name via git check-ref-format.
 * Returns null when valid, otherwise a denial reason.
 */
export function validateSemanticBranchName(
	cwd: string,
	semantic: string,
	deps: WorktreeDeps = {},
): string | null {
	const trimmed = semantic.trim();
	if (!trimmed) return "Branch name is empty.";
	try {
		execGit(cwd, ["check-ref-format", "--branch", trimmed], deps);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

export function generateWorktreeDirName(cwd: string, workRunId: string): string {
	const repoName = slugName(path.basename(path.resolve(cwd)));
	const suffix = workRunId.replace(/[^a-fA-F0-9-]/g, "").slice(0, 8) || "worktree";
	return `${repoName}-wf-${suffix}`;
}

export function resolveBaseRef(cwd: string, deps: WorktreeDeps = {}): string {
	try {
		const branch = execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
		return branch && branch !== "HEAD" ? branch : "HEAD";
	} catch {
		return "HEAD";
	}
}

export function plannedWorktreeInfo(
	cwd: string,
	workRunId: string,
	semantic?: string,
	deps: WorktreeDeps = {},
): WorktreeInfo {
	const realpathSync = deps.realpathSync ?? fs.realpathSync;
	const repoRoot = gitPath(
		cwd,
		execGit(cwd, ["rev-parse", "--show-toplevel"], deps),
		realpathSync,
	);
	const branch = buildWorktreeBranchName(workRunId, semantic);
	const baseBranch = resolveBaseRef(repoRoot, deps);
	return {
		path: path.resolve(
			path.dirname(repoRoot),
			generateWorktreeDirName(repoRoot, workRunId),
		),
		branch,
		baseBranch,
	};
}

export function createWorktree(
	cwd: string,
	workRunId: string,
	semantic?: string,
	deps: WorktreeDeps = {},
): WorktreeInfo {
	const realpathSync = deps.realpathSync ?? fs.realpathSync;
	const repoRoot = gitPath(
		cwd,
		execGit(cwd, ["rev-parse", "--show-toplevel"], deps),
		realpathSync,
	);
	const planned = plannedWorktreeInfo(cwd, workRunId, semantic, deps);
	const branch = planned.branch;
	const baseBranch = planned.baseBranch;
	const worktreePath = planned.path;
	const existsSync = deps.existsSync ?? fs.existsSync;

	if (semantic?.trim()) {
		const denial = validateSemanticBranchName(repoRoot, semantic, deps);
		if (denial) throw new Error(`Invalid branch name: ${denial}`);
	}

	if (existsSync(worktreePath)) {
		throw new Error(`Worktree path already exists: ${worktreePath}`);
	}

	// No pre-check for branch existence: `git worktree add -b` atomically
	// refuses if the branch already exists, avoiding both the TOCTOU window
	// and the git exit-code variance seen across versions when probing refs.
	try {
		execGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseBranch], deps);
	} catch (err) {
		// Avoid removing a concurrently-created worktree at the same deterministic path.
		// Leave partial residue for explicit recovery via /wf-reset or git worktree prune.
		throw err;
	}

	return { path: worktreePath, branch, baseBranch };
}

/**
 * Validate the worktree IDENTITY only: absolute path, real directory, an
 * actual git worktree, a different checkout than the current repo root, and
 * the same git common dir (same repository). Deliberately does NOT check
 * which branch is checked out — callers that need branch discipline use
 * validateWorktreeState (strict) or validateMergeWorktreeState (merge-aware).
 */
export function validateWorktreeIdentity(
	cwd: string,
	state: Pick<WorkflowState, "worktreePath">,
	deps: WorktreeDeps = {},
): WorktreeValidation {
	if (!state.worktreePath) return { ok: true };

	const existsSync = deps.existsSync ?? fs.existsSync;
	const realpathSync = deps.realpathSync ?? fs.realpathSync;
	if (!path.isAbsolute(state.worktreePath)) {
		return { ok: false, reason: "worktreePath is not absolute" };
	}
	if (!existsSync(state.worktreePath)) {
		return { ok: false, reason: `Worktree path does not exist: ${state.worktreePath}` };
	}

	try {
		const inside = execGit(
			state.worktreePath,
			["rev-parse", "--is-inside-work-tree"],
			deps,
		);
		if (inside !== "true") return { ok: false, reason: "Path is not a git worktree" };

		const root = gitPath(cwd, execGit(cwd, ["rev-parse", "--show-toplevel"], deps), realpathSync);
		const wtRoot = gitPath(
			state.worktreePath,
			execGit(state.worktreePath, ["rev-parse", "--show-toplevel"], deps),
			realpathSync,
		);
		if (root === wtRoot) {
			return { ok: false, reason: "worktreePath points to the current repo checkout" };
		}
		const commonDir = gitPath(cwd, execGit(cwd, ["rev-parse", "--git-common-dir"], deps), realpathSync);
		const wtCommonDir = gitPath(
			state.worktreePath,
			execGit(state.worktreePath, ["rev-parse", "--git-common-dir"], deps),
			realpathSync,
		);
		if (commonDir !== wtCommonDir) {
			return { ok: false, reason: "Worktree git common dir does not match current repo" };
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: message };
	}

	return { ok: true };
}

/**
 * Whether the checkout has a rebase sequencer in progress. Kept local (same
 * shape as git-integration.ts detectSequencer) so worktree.ts keeps only
 * type-only local imports and stays directly importable by the no-build
 * validation scripts.
 */
function hasRebaseSequencerIn(
	checkoutPath: string,
	deps: WorktreeDeps = {},
): boolean {
	const existsSync = deps.existsSync ?? fs.existsSync;
	for (const name of ["rebase-merge", "rebase-apply"]) {
		try {
			const p = execGit(checkoutPath, ["rev-parse", "--git-path", name], deps);
			const abs = path.isAbsolute(p) ? p : path.resolve(checkoutPath, p);
			if (existsSync(abs)) return true;
		} catch {
			// git failure → no sequencer evidence
		}
	}
	return false;
}

/**
 * Strict worktree validation: identity (see validateWorktreeIdentity) plus a
 * branch-checkout requirement — the worktree HEAD must be exactly
 * `state.worktreeBranch`. Used by Work/Review/Commit/reset paths where the
 * workflow-owned branch must be checked out.
 */
export function validateWorktreeState(
	cwd: string,
	state: Pick<WorkflowState, "worktreePath" | "worktreeBranch">,
	deps: WorktreeDeps = {},
): WorktreeValidation {
	const identity = validateWorktreeIdentity(cwd, state, deps);
	if (!identity.ok) return identity;
	if (!state.worktreeBranch) return { ok: true };

	try {
		const branch = execGit(
			state.worktreePath!,
			["rev-parse", "--abbrev-ref", "HEAD"],
			deps,
		);
		if (branch !== state.worktreeBranch) {
			return {
				ok: false,
				reason: `Worktree branch mismatch: expected ${state.worktreeBranch}, got ${branch}`,
			};
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: message };
	}

	return { ok: true };
}

/**
 * Merge-aware worktree validation for Merge Mode with a workflow-worktree
 * source. Identity is always required. The branch check stays strict EXCEPT in
 * the verifiable rebase-in-progress window: when the persisted merge context
 * says the source is this workflow worktree branch AND a rebase sequencer is
 * detectable in this worktree, a detached HEAD is accepted (git rebases on a
 * detached HEAD; `rebase --continue` / `--abort` must stay usable). When the
 * sequencer disappears, strict branch matching resumes automatically. Manual
 * detached HEAD, wrong worktree, branch mismatch, and common-dir mismatch all
 * stay fail-closed.
 */
export function validateMergeWorktreeState(
	cwd: string,
	state: Pick<WorkflowState, "worktreePath" | "worktreeBranch" | "mergeContext">,
	deps: WorktreeDeps = {},
): WorktreeValidation {
	const identity = validateWorktreeIdentity(cwd, state, deps);
	if (!identity.ok) return identity;
	if (!state.worktreeBranch) return { ok: true };

	try {
		const branch = execGit(
			state.worktreePath!,
			["rev-parse", "--abbrev-ref", "HEAD"],
			deps,
		);
		if (branch === state.worktreeBranch) return { ok: true };

		const mergeSource =
			state.mergeContext?.sourceKind === "workflow-worktree" &&
			state.mergeContext.sourceBranch === state.worktreeBranch;
		if (
			branch === "HEAD" &&
			mergeSource &&
			hasRebaseSequencerIn(state.worktreePath!, deps)
		) {
			return { ok: true };
		}

		return {
			ok: false,
			reason: `Worktree branch mismatch: expected ${state.worktreeBranch}, got ${branch}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: message };
	}
}

export function removeWorktree(
	cwd: string,
	state: Pick<WorkflowState, "worktreePath" | "worktreeBranch">,
	deps: WorktreeDeps = {},
): void {
	if (!state.worktreePath) {
		throw new Error("No active worktree path to remove.");
	}
	const validation = validateWorktreeState(cwd, state, deps);
	if (!validation.ok) {
		throw new Error(`Refusing to remove invalid worktree: ${validation.reason}`);
	}
	execGit(cwd, ["worktree", "remove", state.worktreePath], deps);
}

export function deleteWorktreeBranch(
	cwd: string,
	branch: string,
	deps: WorktreeDeps = {},
): void {
	// Accept both the legacy `wf/<8hex>` form and the semantic `<slug>@wf-<8hex>` form.
	const legacy = /^wf\/[a-fA-F0-9]{8}$/;
	if (!legacy.test(branch) && !WORKTREE_BRANCH_SUFFIX_RE.test(branch)) {
		throw new Error(`Refusing to delete non-workflow branch: ${branch}`);
	}
	execGit(cwd, ["branch", "-d", branch], deps);
}

export function gitStatusInWorktree(
	worktreePath: string,
	deps: WorktreeDeps = {},
): string {
	try {
		const status = execGit(worktreePath, ["status", "--short", "--branch"], deps);
		return status || "(clean)";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
