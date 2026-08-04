import { execFileSync as nodeExecFileSync } from "node:child_process";
import crypto from "node:crypto";
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


// ── Workspace fingerprint ───────────────────────────────────────────────────

/** Single NUL byte used as a path/content separator in the fingerprint hash. */
const NUL_SEP = Buffer.from([0]);

/**
 * Maximum untracked-file size hashed into the fingerprint. Files larger than
 * this (e.g. large build artifacts not covered by .gitignore) throw a clear
 * error instead of exhausting memory. Fail-closed: the caller surfaces the
 * error and records no PASS.
 */
const MAX_UNTRACKED_FILE_SIZE = 64 * 1024 * 1024; // 64 MB

export interface WorkspaceFingerprintDeps extends WorktreeDeps {
	readFileSync?: typeof fs.readFileSync;
	createHash?: typeof crypto.createHash;
}

/**
 * Compute a stable workspace fingerprint covering tracked changes (staged +
 * unstaged, deletions, mode changes) and ALL non-ignored untracked file
 * contents. New source files are typically untracked, so omitting them would
 * let unreviewed new files bypass the commit-version binding.
 *
 * Uses fixed git arguments so the diff is reproducible:
 *   git diff --binary --no-ext-diff --no-textconv --no-renames HEAD --
 * followed by sorted `git ls-files --others --exclude-standard -z` with each
 * untracked file's path and byte content fed into the hash.
 *
 * Returns a SHA-256 hex digest, or throws on git/file-read failure so the
 * caller (Implementation Review tool / agent_end / commit gate) fails closed
 * instead of recording an unreliable PASS.
 */
export function computeWorkspaceFingerprint(
	cwd: string,
	deps: WorkspaceFingerprintDeps = {},
): string {
	const execFileSync = deps.execFileSync ?? nodeExecFileSync;
	const readFileSync = deps.readFileSync ?? fs.readFileSync;
	const createHash = deps.createHash ?? crypto.createHash;
	const hash = createHash("sha256");

	// Tracked changes: staged + unstaged + deletions + mode changes.
	const diffBuf = execFileSync(
		"git",
		["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--"],
		{ cwd, encoding: null, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
	);
	hash.update(diffBuf as Buffer);
	hash.update(NUL_SEP); // delimiter between diff output and untracked-file section

	// Untracked (non-ignored) files: sorted by repo-relative path.
	const lsBuf = execFileSync(
		"git",
		["ls-files", "--others", "--exclude-standard", "-z"],
		{ cwd, encoding: null, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
	);
	const paths = parseNulDelimited(lsBuf as Buffer).sort();
	for (const relPath of paths) {
		if (!relPath) continue;
		hash.update(relPath, "utf8");
		hash.update(NUL_SEP); // separator byte
		try {
			const fullPath = path.resolve(cwd, relPath);
			const stat = fs.statSync(fullPath);
			if (stat.size > MAX_UNTRACKED_FILE_SIZE) {
				throw new Error(
					`workspace fingerprint: untracked file ${relPath} is too large (${stat.size} bytes > ${MAX_UNTRACKED_FILE_SIZE})`,
				);
			}
			const content = readFileSync(fullPath);
			hash.update(content);
		} catch (err) {
			throw new Error(
				`workspace fingerprint: failed reading untracked file ${relPath}: ${
					err instanceof Error ? err.message : String(err)
			}`,
				{ cause: err },
			);
		}
		hash.update(NUL_SEP); // separator byte
	}

	return hash.digest("hex");
}

/** Split a NUL-delimited buffer into a string array (git -z output). */
function parseNulDelimited(buf: Buffer): string[] {
	if (!buf || buf.length === 0) return [];
	const parts: string[] = [];
	let start = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0) {
			parts.push(buf.subarray(start, i).toString("utf8"));
			start = i + 1;
		}
	}
	// Trailing data without a NUL terminator — include it if non-empty.
	if (start < buf.length) {
		parts.push(buf.subarray(start).toString("utf8"));
	}
	return parts.filter((p) => p.length > 0);
}

/**
 * Compare a recorded PASS fingerprint against the current workspace. Returns
 * true when they match (PASS stays valid), false when code or untracked
 * content has changed (PASS is stale). Throws on fingerprint computation
 * failure so the caller fails closed.
 */
export function workspaceFingerprintMatches(
	cwd: string,
	recordedFingerprint: string,
	deps: WorkspaceFingerprintDeps = {},
): boolean {
	const current = computeWorkspaceFingerprint(cwd, deps);
	return current === recordedFingerprint;
}
