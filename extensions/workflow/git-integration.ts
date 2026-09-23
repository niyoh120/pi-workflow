import { execFileSync as nodeExecFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Git integration helpers for /workflow:merge (Merge Mode).
 *
 * Design constraints:
 *  - argv-only git invocations via execFileSync (no shell interpolation);
 *  - NO local value imports (only node builtins) so the no-build validation
 *    scripts can import this module directly via Node type stripping. Keep
 *    this invariant when editing — worktree validation lives in worktree.ts
 *    and re-implements its own sequencer probe for the same reason;
 *  - every helper is synchronous and injectable (GitDeps) for regression
 *    scripts running against throwaway repositories.
 */

// ── exec plumbing ───────────────────────────────────────────────────────────

export interface GitDeps {
	execFileSync?: typeof nodeExecFileSync;
	existsSync?: typeof fs.existsSync;
	realpathSync?: typeof fs.realpathSync;
}

function execGit(cwd: string, args: string[], deps: GitDeps = {}): string {
	const execFileSync = deps.execFileSync ?? nodeExecFileSync;
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 120_000,
	}).trim();
}

/** Trimmed stdout, or null when git exited non-zero. Distinguishable from "". */
function gitStdout(cwd: string, args: string[], deps: GitDeps = {}): string | null {
	try {
		return execGit(cwd, args, deps);
	} catch {
		return null;
	}
}

/** True when git exited zero. */
function gitSuccess(cwd: string, args: string[], deps: GitDeps = {}): boolean {
	try {
		execGit(cwd, args, deps);
		return true;
	} catch {
		return false;
	}
}

function depsExists(deps: GitDeps): typeof fs.existsSync {
	return deps.existsSync ?? fs.existsSync;
}

function depsRealpath(deps: GitDeps): typeof fs.realpathSync {
	return deps.realpathSync ?? fs.realpathSync;
}

/** Path equality on realpath when resolvable, otherwise on normalize+resolve. */
function samePath(a: string, b: string, deps: GitDeps = {}): boolean {
	const realpath = depsRealpath(deps);
	const norm = (p: string): string => {
		try {
			return realpath(p);
		} catch {
			return path.resolve(path.normalize(p));
		}
	};
	return norm(a) === norm(b);
}

function gitErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		const stderr = (err as Error & { stderr?: string }).stderr;
		const stderrText =
			typeof stderr === "string" && stderr.trim() ? stderr.trim() : "";
		return stderrText || err.message;
	}
	return String(err);
}

// ── /workflow:merge command parsing ───────────────────────────────────────────────

export interface ParsedMergeCommand {
	/** Explicit `--target`/`--target=` value, when provided. */
	targetBranch?: string;
	/** Raw trailing natural-language user instructions (verbatim, options stripped). */
	instructions?: string;
}

export type ParseMergeCommandResult =
	| { ok: true; value: ParsedMergeCommand }
	| { ok: false; error: string };

/**
 * Parse `/workflow:merge [--target <branch>] [--target=<branch>] [--] [instructions]`.
 *
 * Options must precede the instructions; the first non-option token starts the
 * verbatim instruction tail (so natural language after that point — including
 * stray dashes — is preserved). `--` ends option parsing and the remainder is
 * taken verbatim.
 */
export function parseMergeCommandArgs(raw: string): ParseMergeCommandResult {
	const s = typeof raw === "string" ? raw : "";
	let targetBranch: string | undefined;
	let instructions: string | undefined;
	let i = 0;

	const isSpace = (ch: string | undefined): boolean =>
		ch !== undefined && /\s/.test(ch);

	while (i < s.length) {
		while (i < s.length && isSpace(s[i])) i++;
		if (i >= s.length) break;

		if (s.startsWith("--target=", i)) {
			let j = i + "--target=".length;
			let k = j;
			while (k < s.length && !isSpace(s[k])) k++;
			if (k === j) {
				return { ok: false, error: '--target= requires a branch name, e.g. --target=main.' };
			}
			targetBranch = s.slice(j, k);
			i = k;
		} else if (s.startsWith("--target", i)) {
			let k = i + "--target".length;
			if (k < s.length && !isSpace(s[k])) {
				// e.g. --targetfoo — an unknown option, not --target.
				let end = k;
				while (end < s.length && !isSpace(s[end])) end++;
				return {
					ok: false,
					error: `Unrecognized option: ${s.slice(i, end)}. Use --target <branch> to specify the target branch, or -- to end options.`,
				};
			}
			let j = k;
			while (j < s.length && isSpace(s[j])) j++;
			let m = j;
			while (m < s.length && !isSpace(s[m])) m++;
			if (m === j) {
				return { ok: false, error: "--target requires a branch name, e.g. --target main." };
			}
			targetBranch = s.slice(j, m);
			i = m;
		} else if (s.startsWith("--", i) && (i + 2 >= s.length || isSpace(s[i + 2]))) {
			// Bare `--` ends option parsing; the remainder is verbatim instructions.
			const rest = s.slice(i + 2).trim();
			instructions = instructions ? `${instructions}\n${rest}` : rest;
			break;
		} else if (s[i] === "-") {
			let end = i;
			while (end < s.length && !isSpace(s[end])) end++;
			return {
				ok: false,
				error: `Unrecognized option: ${s.slice(i, end)}. Use --target <branch> to specify the target branch, or -- to end options.`,
			};
		} else {
			// First natural-language token starts the verbatim instruction tail.
			instructions = s.slice(i);
			break;
		}
	}

	const value: ParsedMergeCommand = {};
	if (targetBranch !== undefined) value.targetBranch = targetBranch;
	if (instructions !== undefined && instructions.trim()) {
		value.instructions = instructions;
	}
	return { ok: true, value };
}

// ── repository / ref facts ──────────────────────────────────────────────────

/** Resolve the repository root for a directory inside a git repo. */
export function resolveRepoRoot(
	cwd: string,
	deps: GitDeps = {},
): { ok: true; root: string } | { ok: false; error: string } {
	const root = gitStdout(cwd, ["rev-parse", "--show-toplevel"], deps);
	if (!root) {
		return { ok: false, error: `Not a git repository: ${cwd}` };
	}
	return { ok: true, root };
}

/** One entry of `git worktree list --porcelain`. The main checkout is first. */
export interface WorktreeMapEntry {
	path: string;
	/** Checked-out branch name (short form), or null when detached. */
	branch: string | null;
	head: string;
}

/** Parse `git worktree list --porcelain` into entries (main checkout first). */
export function resolveWorktreeMap(
	cwd: string,
	deps: GitDeps = {},
): WorktreeMapEntry[] {
	const out = gitStdout(cwd, ["worktree", "list", "--porcelain"], deps);
	if (out === null) return [];
	const entries: WorktreeMapEntry[] = [];
	let cur: Partial<WorktreeMapEntry> | null = null;
	const flush = () => {
		if (cur && cur.path) {
			entries.push({
				path: cur.path,
				branch: cur.branch ?? null,
				head: cur.head ?? "",
			});
		}
		cur = null;
	};
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			cur = { path: line.slice("worktree ".length).trim() };
		} else if (cur && line.startsWith("HEAD ")) {
			cur.head = line.slice("HEAD ".length).trim();
		} else if (cur && line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			cur.branch = ref.replace(/^refs\/heads\//, "");
		} else if (line.trim() === "") {
			flush();
		}
		// "detached" / "locked" / "prunable" carry no data we need here.
	}
	flush();
	return entries;
}

/** Whether a local branch ref exists. */
export function localBranchExists(
	cwd: string,
	branch: string,
	deps: GitDeps = {},
): boolean {
	return gitSuccess(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], deps);
}

/** Reject malformed / dangerous branch names via git's own ref validation. */
export function isValidBranchName(
	cwd: string,
	branch: string,
	deps: GitDeps = {},
): boolean {
	const trimmed = branch.trim();
	if (!trimmed) return false;
	return gitSuccess(cwd, ["check-ref-format", "--branch", trimmed], deps);
}

/** Current checked-out branch, or null on detached HEAD / failure. */
export function resolveCurrentBranch(
	cwd: string,
	deps: GitDeps = {},
): string | null {
	const branch = gitStdout(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
	if (!branch || branch === "HEAD") return null;
	return branch;
}

/** Whether the checkout has any pending change (tracked or untracked). */
export function isCheckoutClean(
	checkoutPath: string,
	deps: GitDeps = {},
): { clean: boolean; status: string } {
	const status = gitStdout(checkoutPath, ["status", "--porcelain"], deps);
	if (status === null) {
		return { clean: false, status: "(git status failed)" };
	}
	return { clean: status === "", status: status || "(clean)" };
}

/** Bounded status text so diagnostics stay readable on large diffs. */
function boundedStatus(status: string, maxLines = 12): string {
	const lines = status.split("\n");
	if (lines.length <= maxLines) return status;
	return `${lines.slice(0, maxLines).join("\n")}\n... (${lines.length - maxLines} more)`;
}

// ── sequencer detection ─────────────────────────────────────────────────────

export type SequencerKind =
	| "rebase-merge"
	| "rebase-apply"
	| "merge"
	| "cherry-pick"
	| "revert";

const SEQUENCER_PATHS: ReadonlyArray<readonly [SequencerKind, string]> = [
	["rebase-merge", "rebase-merge"],
	["rebase-apply", "rebase-apply"],
	["merge", "MERGE_HEAD"],
	["cherry-pick", "CHERRY_PICK_HEAD"],
	["revert", "REVERT_HEAD"],
];

/**
 * Detect unfinished git operations (rebase / merge / cherry-pick / revert) in
 * a checkout. Uses `git rev-parse --git-path <name>` so linked worktrees
 * resolve their per-worktree git dir correctly.
 */
export function detectSequencer(
	checkoutPath: string,
	deps: GitDeps = {},
): SequencerKind[] {
	const exists = depsExists(deps);
	const found: SequencerKind[] = [];
	for (const [kind, name] of SEQUENCER_PATHS) {
		const p = gitStdout(checkoutPath, ["rev-parse", "--git-path", name], deps);
		if (p === null) continue;
		const abs = path.isAbsolute(p) ? p : path.resolve(checkoutPath, p);
		if (exists(abs)) found.push(kind);
	}
	return found;
}

/** Only the rebase sequencers (the ones that detach HEAD). */
export function hasRebaseSequencer(checkoutPath: string, deps: GitDeps = {}): boolean {
	const kinds = detectSequencer(checkoutPath, deps);
	return kinds.includes("rebase-merge") || kinds.includes("rebase-apply");
}

// ── target inference ────────────────────────────────────────────────────────

/**
 * Infer the default integration target for an ordinary-branch source:
 * locally-available `origin/HEAD` mapped branch → `master` → `main`.
 * Returns null when no reliable local target exists.
 */
export function resolveDefaultTargetBranch(
	cwd: string,
	deps: GitDeps = {},
): string | null {
	const remoteHead = gitStdout(
		cwd,
		["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
		deps,
	);
	if (remoteHead && remoteHead.startsWith("origin/")) {
		const mapped = remoteHead.slice("origin/".length);
		if (localBranchExists(cwd, mapped, deps)) return mapped;
	}
	for (const candidate of ["master", "main"]) {
		if (localBranchExists(cwd, candidate, deps)) return candidate;
	}
	return null;
}

// ── /workflow:merge preflight ─────────────────────────────────────────────────────

export interface MergePreflightInput {
	/** Active workflow worktree facts from session state (source of truth). */
	worktreePath?: string;
	worktreeBranch?: string;
	worktreeBaseBranch?: string;
	/** Explicit --target value from the command line, when provided. */
	targetBranch?: string;
}

export interface MergePreflightFacts {
	sourceKind: "workflow-worktree" | "ordinary-branch";
	sourceBranch: string;
	/** Absolute path of the checkout that performs the rebase. */
	sourceCheckoutPath: string;
	targetBranch: string;
	/** Checkout that has the target branch checked out, when any. */
	targetCheckoutPath: string | null;
	sourceHeadBefore: string;
	targetHeadBefore: string;
	sourceOnlyCommitCountBefore: number;
}

export type MergePreflight =
	| { ok: true; value: MergePreflightFacts }
	| { ok: false; error: string };

/**
 * Run all /workflow:merge entry checks and collect the merge baseline facts.
 *
 * Source resolution is fixed-priority: an active workflow worktree in session
 * state always wins (the worktree branch is the source); an ordinary-branch
 * source is only used when no active worktree exists (the current checkout of
 * the main repository). No automatic stash — a dirty source or target
 * checkout rejects the merge outright.
 */
export function runMergePreflight(
	cwd: string,
	input: MergePreflightInput,
	deps: GitDeps = {},
): MergePreflight {
	const rootResult = resolveRepoRoot(cwd, deps);
	if (!rootResult.ok) return { ok: false, error: rootResult.error };
	const root = rootResult.root;

	const map = resolveWorktreeMap(root, deps);

	let sourceKind: "workflow-worktree" | "ordinary-branch";
	let sourceBranch: string;
	let sourceCheckoutPath: string;
	if (input.worktreePath) {
		sourceKind = "workflow-worktree";
		if (!input.worktreeBranch) {
			return {
				ok: false,
				error: "Active worktree exists but worktreeBranch is missing; run /workflow:status to inspect or /workflow:reset to clean up.",
			};
		}
		sourceBranch = input.worktreeBranch;
		sourceCheckoutPath = input.worktreePath;
		const entry = map.find((e) => samePath(e.path, sourceCheckoutPath, deps));
		if (!entry) {
			return {
				ok: false,
				error: `Source worktree is not in the repo worktree list: ${sourceCheckoutPath}. Run /workflow:status to inspect or /workflow:reset to clean up.`,
			};
		}
		if (entry.branch !== sourceBranch) {
			return {
				ok: false,
				error: `Source worktree currently has ${entry.branch ?? "(detached HEAD)"} checked out, which does not match the state branch ${sourceBranch}; restore the worktree first or run /workflow:reset.`,
			};
		}
	} else {
		sourceKind = "ordinary-branch";
		const current = resolveCurrentBranch(root, deps);
		if (!current) {
			return {
				ok: false,
				error: "Current checkout is in detached HEAD; check out the local branch to integrate before running /workflow:merge.",
			};
		}
		sourceBranch = current;
		sourceCheckoutPath = root;
	}

	// ── target resolution ──
	let targetBranch: string;
	if (input.targetBranch !== undefined && input.targetBranch.trim()) {
		const explicit = input.targetBranch.trim();
		if (!isValidBranchName(root, explicit, deps)) {
			return { ok: false, error: `Invalid target branch name: ${explicit}` };
		}
		if (!localBranchExists(root, explicit, deps)) {
			return { ok: false, error: `Target branch does not exist (must be a local branch): ${explicit}` };
		}
		targetBranch = explicit;
	} else if (sourceKind === "workflow-worktree") {
		const base = input.worktreeBaseBranch?.trim();
		if (!base) {
			return {
				ok: false,
				error: "Cannot infer the target branch from worktree state (worktreeBaseBranch missing); specify it with --target <branch>.",
			};
		}
		if (!localBranchExists(root, base, deps)) {
			return {
				ok: false,
				error: `Worktree base branch ${base} is no longer a local branch; specify the target with --target <branch>.`,
			};
		}
		targetBranch = base;
	} else {
		const inferred = resolveDefaultTargetBranch(root, deps);
		if (!inferred) {
			return {
				ok: false,
				error: "Cannot infer the target branch (origin/HEAD-mapped branch / master / main all unavailable); specify it with --target <branch>.",
			};
		}
		targetBranch = inferred;
	}

	if (targetBranch === sourceBranch) {
		return { ok: false, error: `Source and target branches are the same: ${sourceBranch}` };
	}

	// ── cleanliness + sequencer checks ──
	const srcClean = isCheckoutClean(sourceCheckoutPath, deps);
	if (!srcClean.clean) {
		return {
			ok: false,
			error: `Source workspace has uncommitted changes (no auto-stash); commit or clean up first, then retry:\n${boundedStatus(srcClean.status)}`,
		};
	}
	const srcSequencer = detectSequencer(sourceCheckoutPath, deps);
	if (srcSequencer.length) {
		return {
			ok: false,
			error: `Source checkout has an unfinished git operation (${srcSequencer.join(", ")}); finish or abort it first, then retry.`,
		};
	}

	const targetEntry = map.find(
		(e) =>
			e.branch === targetBranch &&
			!samePath(e.path, sourceCheckoutPath, deps),
	);
	if (targetEntry) {
		const tgtClean = isCheckoutClean(targetEntry.path, deps);
		if (!tgtClean.clean) {
			return {
				ok: false,
				error: `Target branch is checked out at ${targetEntry.path} with a dirty workspace (no auto-stash); commit or clean up first, then retry:\n${boundedStatus(tgtClean.status)}`,
			};
		}
		const tgtSequencer = detectSequencer(targetEntry.path, deps);
		if (tgtSequencer.length) {
			return {
				ok: false,
				error: `Target checkout ${targetEntry.path} has an unfinished git operation (${tgtSequencer.join(", ")}); finish or abort it first, then retry.`,
			};
		}
	}

	// ── baseline facts ──
	const sourceHeadBefore = gitStdout(
		root,
		["rev-parse", "--verify", `refs/heads/${sourceBranch}`],
		deps,
	);
	if (!sourceHeadBefore) {
		return { ok: false, error: `Source branch does not exist: ${sourceBranch}` };
	}
	const targetHeadBefore = gitStdout(
		root,
		["rev-parse", "--verify", `refs/heads/${targetBranch}`],
		deps,
	);
	if (!targetHeadBefore) {
		return { ok: false, error: `Target branch does not exist: ${targetBranch}` };
	}
	const countOut = gitStdout(
		root,
		["rev-list", "--count", `${targetBranch}..${sourceBranch}`],
		deps,
	);
	const sourceOnlyCommitCountBefore = countOut === null ? undefined : Number(countOut);
	if (
		sourceOnlyCommitCountBefore === undefined ||
		!Number.isFinite(sourceOnlyCommitCountBefore) ||
		sourceOnlyCommitCountBefore < 0
	) {
		return { ok: false, error: "Cannot count source-only commits (git rev-list failed)." };
	}

	return {
		ok: true,
		value: {
			sourceKind,
			sourceBranch,
			sourceCheckoutPath,
			targetBranch,
			targetCheckoutPath: targetEntry ? targetEntry.path : null,
			sourceHeadBefore,
			targetHeadBefore,
			sourceOnlyCommitCountBefore,
		},
	};
}

// ── default fast-forward finalizer ──────────────────────────────────────────

export interface FfFinalizeInput {
	sourceBranch: string;
	targetBranch: string;
}

export interface FfFinalizeResult {
	ok: boolean;
	error?: string;
	/** Human-readable diagnostics lines for tool output. */
	diagnostics: string[];
	/** True when target already equals source (no ref movement needed). */
	alreadyIntegrated: boolean;
	/** How the ff was applied: "worktree-merge" | "update-ref" | "none". */
	appliedVia: "worktree-merge" | "update-ref" | "none";
}

/**
 * Deterministically fast-forward the target branch to the source head.
 *
 * - Target checked out in a worktree: re-verify identity/branch/clean, then
 *   `git -C <target-worktree> merge --ff-only <source>` so the worktree index
 *   and working copy stay in sync.
 * - Target not checked out anywhere: after an ancestor check, move the ref
 *   with `git update-ref -m ... <target> <sourceHead> <expectedOldTarget>`
 *   (compare-and-swap — a concurrently moved target fails closed instead of
 *   being overwritten) without touching the current source checkout.
 */
export function finalizeDefaultFf(
	cwd: string,
	opts: FfFinalizeInput,
	deps: GitDeps = {},
): FfFinalizeResult {
	const diagnostics: string[] = [];
	const sourceHead = gitStdout(
		cwd,
		["rev-parse", "--verify", `refs/heads/${opts.sourceBranch}`],
		deps,
	);
	if (!sourceHead) {
		return {
			ok: false,
			error: `Source branch no longer exists: ${opts.sourceBranch}`,
			diagnostics,
			alreadyIntegrated: false,
			appliedVia: "none",
		};
	}
	const targetHead = gitStdout(
		cwd,
		["rev-parse", "--verify", `refs/heads/${opts.targetBranch}`],
		deps,
	);
	if (!targetHead) {
		return {
			ok: false,
			error: `Target branch no longer exists: ${opts.targetBranch}`,
			diagnostics,
			alreadyIntegrated: false,
			appliedVia: "none",
		};
	}
	diagnostics.push(`source ${opts.sourceBranch}: ${sourceHead}`);
	diagnostics.push(`target ${opts.targetBranch}: ${targetHead}`);

	if (sourceHead === targetHead) {
		diagnostics.push("target already equals source head; no move needed.");
		return {
			ok: true,
			diagnostics,
			alreadyIntegrated: true,
			appliedVia: "none",
		};
	}

	if (!gitSuccess(cwd, ["merge-base", "--is-ancestor", opts.targetBranch, opts.sourceBranch], deps)) {
		return {
			ok: false,
			error:
				`Target branch ${opts.targetBranch} moved after the baseline and is no longer an ancestor of ${opts.sourceBranch};` +
				"fail-closed (no ref was modified). Rebase the source checkout again, then call workflow_merge_complete once more.",
			diagnostics,
			alreadyIntegrated: false,
			appliedVia: "none",
		};
	}

	const map = resolveWorktreeMap(cwd, deps);
	const targetEntry = map.find((e) => e.branch === opts.targetBranch);
	if (targetEntry) {
		const clean = isCheckoutClean(targetEntry.path, deps);
		if (!clean.clean) {
			return {
				ok: false,
				error: `Target worktree ${targetEntry.path} is dirty; fast-forward refused:\n${boundedStatus(clean.status)}`,
				diagnostics,
				alreadyIntegrated: false,
				appliedVia: "none",
			};
		}
		const head = gitStdout(targetEntry.path, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
		if (head !== opts.targetBranch) {
			return {
				ok: false,
				error: `Target worktree ${targetEntry.path} HEAD is ${head ?? "(unknown)"}, which does not match ${opts.targetBranch}; fast-forward refused.`,
				diagnostics,
				alreadyIntegrated: false,
				appliedVia: "none",
			};
		}
		try {
			execGit(targetEntry.path, ["merge", "--ff-only", opts.sourceBranch], deps);
		} catch (err) {
			return {
				ok: false,
				error: `Target worktree fast-forward failed: ${gitErrorMessage(err)}`,
				diagnostics,
				alreadyIntegrated: false,
				appliedVia: "worktree-merge",
			};
		}
		diagnostics.push(`Executed merge --ff-only in target worktree ${targetEntry.path}.`);
	} else {
		try {
			execGit(
				cwd,
				[
					"update-ref",
					"-m",
					`workflow:merge: fast-forward ${opts.targetBranch} to ${opts.sourceBranch}`,
					`refs/heads/${opts.targetBranch}`,
					sourceHead,
					targetHead,
				],
				deps,
			);
		} catch (err) {
			return {
				ok: false,
				error:
					`Atomic target-branch move failed (target may have moved concurrently): ${gitErrorMessage(err)}.` +
					"fail-closed (no ref was overwritten); rebase the source checkout again, then retry.",
				diagnostics,
				alreadyIntegrated: false,
				appliedVia: "update-ref",
			};
		}
		diagnostics.push("Atomically moved the target branch via update-ref (expected-old CAS).");
	}

	const newTargetHead = gitStdout(
		cwd,
		["rev-parse", "--verify", `refs/heads/${opts.targetBranch}`],
		deps,
	);
	if (newTargetHead !== sourceHead) {
		return {
			ok: false,
			error: `Post-fast-forward verification failed: target=${newTargetHead ?? "(missing)"} source=${sourceHead}`,
			diagnostics,
			alreadyIntegrated: false,
			appliedVia: targetEntry ? "worktree-merge" : "update-ref",
		};
	}
	diagnostics.push(`target ${opts.targetBranch} is now ${newTargetHead}`);
	return {
		ok: true,
		diagnostics,
		alreadyIntegrated: false,
		appliedVia: targetEntry ? "worktree-merge" : "update-ref",
	};
}

// ── completion verification ─────────────────────────────────────────────────

export interface CompletionVerifyInput {
	sourceKind: "workflow-worktree" | "ordinary-branch";
	sourceBranch: string;
	targetBranch: string;
	/** Checkout that performed the rebase. */
	sourceCheckoutPath: string;
	/** Workflow worktree path from session state (worktree source only). */
	worktreePath?: string;
}

export interface CompletionVerifyResult {
	failures: string[];
	diagnostics: string[];
}

/**
 * Strict topology/health checks for the default-strategy completion path:
 * both refs exist, target head equals source head, the source checkout is
 * still on the source branch and clean, no sequencer is running, and the
 * source branch / workflow worktree are retained.
 */
export function verifyDefaultCompletion(
	cwd: string,
	opts: CompletionVerifyInput,
	deps: GitDeps = {},
): CompletionVerifyResult {
	const failures: string[] = [];
	const diagnostics: string[] = [];

	const sourceHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.sourceBranch}`], deps);
	if (!sourceHead) failures.push(`Source branch does not exist: ${opts.sourceBranch}`);
	const targetHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.targetBranch}`], deps);
	if (!targetHead) failures.push(`Target branch does not exist: ${opts.targetBranch}`);
	if (sourceHead && targetHead) {
		diagnostics.push(`source ${opts.sourceBranch}: ${sourceHead}`);
		diagnostics.push(`target ${opts.targetBranch}: ${targetHead}`);
		if (sourceHead !== targetHead) {
			failures.push(`Target head does not match source head: ${targetHead} != ${sourceHead}`);
		}
	}

	const branch = gitStdout(opts.sourceCheckoutPath, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
	if (branch !== opts.sourceBranch) {
		failures.push(`Source checkout is currently on ${branch ?? "(unknown)"}, expected to stay on source branch ${opts.sourceBranch}`);
	} else {
		diagnostics.push(`Source checkout stayed on ${branch}`);
	}

	const clean = isCheckoutClean(opts.sourceCheckoutPath, deps);
	if (!clean.clean) {
		failures.push(`Source workspace is dirty (rebase result not fully committed?):\n${boundedStatus(clean.status)}`);
	} else {
		diagnostics.push("Source workspace is clean.");
	}

	const sequencer = detectSequencer(opts.sourceCheckoutPath, deps);
	if (sequencer.length) {
		failures.push(`Source checkout has an unfinished git operation: ${sequencer.join(", ")}`);
	} else {
		diagnostics.push("Source checkout has no unfinished git operation.");
	}

	// Target checkout (when the target branch is checked out) must be clean too.
	const map = resolveWorktreeMap(cwd, deps);
	const targetEntry = map.find((e) => e.branch === opts.targetBranch);
	if (targetEntry) {
		const tgtClean = isCheckoutClean(targetEntry.path, deps);
		if (!tgtClean.clean) {
			failures.push(`Target worktree ${targetEntry.path} is dirty:\n${boundedStatus(tgtClean.status)}`);
		} else {
			diagnostics.push(`Target worktree ${targetEntry.path} is clean.`);
		}
	} else {
		diagnostics.push(`Target branch ${opts.targetBranch} is not checked out by any worktree.`);
	}

	if (opts.sourceKind === "workflow-worktree") {
		const exists = depsExists(deps);
		if (!opts.worktreePath || !exists(opts.worktreePath)) {
			failures.push(`workflow worktree does not exist or is not recorded: ${opts.worktreePath ?? "(missing)"}`);
		} else {
			const entry = map.find((e) => samePath(e.path, opts.worktreePath!, deps));
			if (!entry) {
				failures.push(`workflow worktree ${opts.worktreePath} is not in the repo worktree list`);
			} else {
				diagnostics.push(`workflow worktree ${opts.worktreePath} preserved, checkout ${entry.branch ?? "(detached)"}.`);
			}
		}
	}

	return { failures, diagnostics };
}

// ── custom-strategy completion diagnostics ──────────────────────────────────

export interface CustomCompletionInput {
	sourceBranch: string;
	targetBranch: string;
	sourceCheckoutPath: string;
	worktreePath?: string;
}

export interface CustomCompletionResult {
	failures: string[];
	diagnostics: string[];
	/** True when the recorded workflow worktree no longer exists / is unregistered. */
	worktreeGone: boolean;
}

/**
 * Strategy-independent health checks for the custom-strategy completion path:
 * no unfinished sequencer in the source (or target) checkout, every existing
 * checkout is clean, and refs / worktree state can be re-resolved. Reports the
 * actual source/target heads and checkout state as diagnostics — the free-form
 * strategy itself has no unified topology condition to enforce.
 */
export function diagnoseCustomCompletion(
	cwd: string,
	opts: CustomCompletionInput,
	deps: GitDeps = {},
): CustomCompletionResult {
	const failures: string[] = [];
	const diagnostics: string[] = [];
	const exists = depsExists(deps);

	const sequencer = detectSequencer(opts.sourceCheckoutPath, deps);
	if (sequencer.length) {
		failures.push(`Source checkout has an unfinished git operation: ${sequencer.join(", ")}; finish or abort it first.`);
	} else {
		diagnostics.push("Source checkout has no unfinished git operation.");
	}

	const sourceHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.sourceBranch}`], deps);
	if (sourceHead) {
		diagnostics.push(`source ref ${opts.sourceBranch}: ${sourceHead}`);
	} else {
		diagnostics.push(`source ref ${opts.sourceBranch}: (missing — expected when a user instruction deleted the source branch)`);
	}
	const targetHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.targetBranch}`], deps);
	if (targetHead) {
		diagnostics.push(`target ref ${opts.targetBranch}: ${targetHead}`);
	} else {
		failures.push(`Target branch does not exist: ${opts.targetBranch}`);
	}

	const branch = gitStdout(opts.sourceCheckoutPath, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
	diagnostics.push(`Source checkout currently on: ${branch ?? "(detached HEAD or unresolvable)"}`);

	const map = resolveWorktreeMap(cwd, deps);
	// Every registered checkout of this repo should be in a sane state; a dirty
	// checkout of the source or target is a failure, other worktrees are
	// reported as diagnostics (they belong to other sessions).
	for (const entry of map) {
		const isSource = samePath(entry.path, opts.sourceCheckoutPath, deps);
		const isTarget = entry.branch === opts.targetBranch;
		const clean = isCheckoutClean(entry.path, deps);
		if (isSource || isTarget) {
			if (!clean.clean) {
				failures.push(`${isSource ? "Source" : "Target"} checkout ${entry.path} is dirty:\n${boundedStatus(clean.status)}`);
			} else {
				diagnostics.push(`${isSource ? "Source" : "Target"} checkout ${entry.path} is clean.`);
			}
		}
	}

	let worktreeGone = false;
	if (opts.worktreePath) {
		const pathExists = exists(opts.worktreePath);
		const registered = map.some((e) => samePath(e.path, opts.worktreePath!, deps));
		if (!pathExists || !registered) {
			worktreeGone = true;
			diagnostics.push(
				`workflow worktree ${opts.worktreePath} no longer exists or is not registered (expected when a user instruction deleted it; the state fields will be cleared).`,
			);
		} else {
			diagnostics.push(`workflow worktree ${opts.worktreePath} is still preserved.`);
		}
	}

	return { failures, diagnostics, worktreeGone };
}

// ── cancellation / recovery ─────────────────────────────────────────────────

export interface MergeCancelInput {
	sourceKind: "workflow-worktree" | "ordinary-branch";
	sourceBranch: string;
	/** Target branch of the merge run (reported in diagnostics; never rolled back). */
	targetBranch: string;
	/** Checkout that performed the rebase (worktree path or repo root). */
	sourceCheckoutPath: string;
}

export interface MergeCancelResult {
	ok: boolean;
	error?: string;
	/** Sequencer kinds that were aborted. */
	aborted: string[];
	/** True when a guarded `checkout -f <sourceBranch>` was executed. */
	reattached: boolean;
	diagnostics: string[];
}

/**
 * Cancel an in-flight merge: abort any running rebase/merge/cherry-pick/revert
 * in the source checkout, then reattach a detached source checkout back to the
 * source branch with a guarded forced checkout.
 *
 * The forced reattach (needed after `git rebase --quit` or equivalent leaves a
 * detached dirty checkout) DROPS in-flight conflict resolution and index /
 * worktree modifications by design — it matches `rebase --abort` semantics.
 * Guards: the source branch ref must still exist; for a workflow-worktree
 * source, the path must be a registered non-main worktree of the same repo
 * (identity check) before `checkout -f` runs.
 *
 * Refs already moved by a custom strategy are NOT rolled back implicitly; the
 * actual state is reported in diagnostics.
 */
export function cancelActiveMergeGit(
	cwd: string,
	opts: MergeCancelInput,
	deps: GitDeps = {},
): MergeCancelResult {
	const diagnostics: string[] = [];
	const aborted: string[] = [];

	const seq = detectSequencer(opts.sourceCheckoutPath, deps);
	for (const kind of seq) {
		const op: string[] =
			kind === "rebase-merge" || kind === "rebase-apply"
				? ["rebase", "--abort"]
				: kind === "merge"
					? ["merge", "--abort"]
					: kind === "cherry-pick"
						? ["cherry-pick", "--abort"]
						: ["revert", "--abort"];
		try {
			execGit(opts.sourceCheckoutPath, op, deps);
			aborted.push(kind);
		} catch (err) {
			return {
				ok: false,
				error: `Failed to abort ${kind}: ${gitErrorMessage(err)}. You can manually run git -C ${opts.sourceCheckoutPath} ${op.join(" ")} and retry the cancellation.`,
				aborted,
				reattached: false,
				diagnostics,
			};
		}
	}
	if (aborted.length) {
		diagnostics.push(`Aborted unfinished operation(s): ${aborted.join(", ")}.`);
	}

	let reattached = false;
	const head = gitStdout(opts.sourceCheckoutPath, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
	if (head === "HEAD") {
		// Sequencer gone but the checkout is still detached — rebase --quit style
		// leftover. Guarded forced reattach below drops in-flight changes by design.
		if (!localBranchExists(cwd, opts.sourceBranch, deps)) {
			return {
				ok: false,
				error: `Source branch ${opts.sourceBranch} no longer exists, cannot restore the checkout; manually resolve the detached HEAD state of git -C ${opts.sourceCheckoutPath}.`,
				aborted,
				reattached: false,
				diagnostics,
			};
		}
		if (opts.sourceKind === "workflow-worktree") {
			const map = resolveWorktreeMap(cwd, deps);
			const entry = map.find((e) => samePath(e.path, opts.sourceCheckoutPath, deps));
			const main = map[0];
			if (!entry) {
				return {
					ok: false,
					error: `Source worktree ${opts.sourceCheckoutPath} is not in the repo worktree list; forced checkout refused. Handle it manually.`,
					aborted,
					reattached: false,
					diagnostics,
				};
			}
			if (main && samePath(main.path, opts.sourceCheckoutPath, deps)) {
				return {
					ok: false,
					error: "Source path points at the main checkout, inconsistent with the workflow-worktree state; forced checkout refused. Handle it manually.",
					aborted,
					reattached: false,
					diagnostics,
				};
			}
		}
		try {
			execGit(opts.sourceCheckoutPath, ["checkout", "-f", opts.sourceBranch], deps);
			reattached = true;
			diagnostics.push(
				`Executed checkout -f ${opts.sourceBranch}: in-flight conflict resolutions and index/worktree changes were discarded per the cancellation semantics.`,
			);
		} catch (err) {
			return {
				ok: false,
				error: `Failed to restore the source branch checkout: ${gitErrorMessage(err)}. Manual recovery: git -C ${opts.sourceCheckoutPath} checkout -f ${opts.sourceBranch}`,
				aborted,
				reattached: false,
				diagnostics,
			};
		}
	}

	const finalBranch = gitStdout(opts.sourceCheckoutPath, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
	if (finalBranch !== opts.sourceBranch) {
		return {
			ok: false,
			error: `After restore the source checkout is on ${finalBranch ?? "(unknown)"}, expected ${opts.sourceBranch}; merge state was not cleared, handle it manually.`,
			aborted,
			reattached,
			diagnostics,
		};
	}
	diagnostics.push(`Source checkout restored to ${finalBranch}.`);

	const clean = isCheckoutClean(opts.sourceCheckoutPath, deps);
	if (!clean.clean) {
		// After a forced checkout, residue is untracked-only in practice; keep the
		// cancel recoverable and surface the residue instead of stranding the user.
		diagnostics.push(`Source workspace still has residue (mostly untracked files):\n${boundedStatus(clean.status)}`);
	} else {
		diagnostics.push("Source workspace is clean.");
	}

	// Report the actual ref state — already-moved refs are not rolled back.
	const sourceHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.sourceBranch}`], deps);
	diagnostics.push(`source ref ${opts.sourceBranch}: ${sourceHead ?? "(missing)"}`);
	const targetHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.targetBranch}`], deps);
	diagnostics.push(
		targetHead && sourceHead && targetHead !== sourceHead
			? `target ref ${opts.targetBranch}: ${targetHead} (differs from source — already-moved refs are never implicitly rolled back)`
			: `target ref ${opts.targetBranch}: ${targetHead ?? "(missing)"}`,
	);

	return { ok: true, aborted, reattached, diagnostics };
}
