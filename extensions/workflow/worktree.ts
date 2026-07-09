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

type GitError = Error & { status?: number | null };

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

export function generateWorktreeBranchName(workRunId: string): string {
	return `wf/${workRunId.replace(/[^a-fA-F0-9-]/g, "").slice(0, 8) || "worktree"}`;
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
	deps: WorktreeDeps = {},
): WorktreeInfo {
	const realpathSync = deps.realpathSync ?? fs.realpathSync;
	const repoRoot = gitPath(
		cwd,
		execGit(cwd, ["rev-parse", "--show-toplevel"], deps),
		realpathSync,
	);
	const branch = generateWorktreeBranchName(workRunId);
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
	deps: WorktreeDeps = {},
): WorktreeInfo {
	const realpathSync = deps.realpathSync ?? fs.realpathSync;
	const repoRoot = gitPath(
		cwd,
		execGit(cwd, ["rev-parse", "--show-toplevel"], deps),
		realpathSync,
	);
	const planned = plannedWorktreeInfo(cwd, workRunId, deps);
	const branch = planned.branch;
	const baseBranch = planned.baseBranch;
	const worktreePath = planned.path;
	const existsSync = deps.existsSync ?? fs.existsSync;

	if (existsSync(worktreePath)) {
		throw new Error(`Worktree path already exists: ${worktreePath}`);
	}

	try {
		execGit(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`], deps);
		throw new Error(`Worktree branch already exists: ${branch}`);
	} catch (err) {
		if (err instanceof Error && err.message.includes("already exists")) throw err;
		if ((err as GitError)?.status !== 1) throw err;
	}

	try {
		execGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseBranch], deps);
	} catch (err) {
		// Avoid removing a concurrently-created worktree at the same deterministic path.
		// Leave partial residue for explicit recovery via /wf-reset or git worktree prune.
		throw err;
	}

	return { path: worktreePath, branch, baseBranch };
}

export function validateWorktreeState(
	cwd: string,
	state: Pick<WorkflowState, "worktreePath" | "worktreeBranch">,
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

		if (state.worktreeBranch) {
			const branch = execGit(
				state.worktreePath,
				["rev-parse", "--abbrev-ref", "HEAD"],
				deps,
			);
			if (branch !== state.worktreeBranch) {
				return {
					ok: false,
					reason: `Worktree branch mismatch: expected ${state.worktreeBranch}, got ${branch}`,
				};
			}
		}

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
	if (!/^wf\/[a-fA-F0-9]{8}$/.test(branch)) {
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
