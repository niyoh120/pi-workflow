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
				return { ok: false, error: "--target= 需要一个分支名，例如 --target=main。" };
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
					error: `未识别的选项：${s.slice(i, end)}。使用 --target <branch> 指定目标分支，或用 -- 结束选项。`,
				};
			}
			let j = k;
			while (j < s.length && isSpace(s[j])) j++;
			let m = j;
			while (m < s.length && !isSpace(s[m])) m++;
			if (m === j) {
				return { ok: false, error: "--target 需要一个分支名，例如 --target main。" };
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
				error: `未识别的选项：${s.slice(i, end)}。使用 --target <branch> 指定目标分支，或用 -- 结束选项。`,
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
		return { ok: false, error: `当前目录不是 git 仓库：${cwd}` };
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
		return { clean: false, status: "(git status 失败)" };
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
				error: "存在 active worktree 但缺少 worktreeBranch；请先 /workflow:status 检查状态或 /workflow:reset 清理。",
			};
		}
		sourceBranch = input.worktreeBranch;
		sourceCheckoutPath = input.worktreePath;
		const entry = map.find((e) => samePath(e.path, sourceCheckoutPath, deps));
		if (!entry) {
			return {
				ok: false,
				error: `来源 worktree 不在同仓 worktree 列表中：${sourceCheckoutPath}。请先 /workflow:status 检查或 /workflow:reset 清理。`,
			};
		}
		if (entry.branch !== sourceBranch) {
			return {
				ok: false,
				error: `来源 worktree 当前 checkout 为 ${entry.branch ?? "(detached HEAD)"}，与状态分支 ${sourceBranch} 不一致；请先恢复 worktree 或 /workflow:reset。`,
			};
		}
	} else {
		sourceKind = "ordinary-branch";
		const current = resolveCurrentBranch(root, deps);
		if (!current) {
			return {
				ok: false,
				error: "当前 checkout 处于 detached HEAD；请先 checkout 到要集成的本地分支后再运行 /workflow:merge。",
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
			return { ok: false, error: `非法目标分支名：${explicit}` };
		}
		if (!localBranchExists(root, explicit, deps)) {
			return { ok: false, error: `目标分支不存在（必须是本地分支）：${explicit}` };
		}
		targetBranch = explicit;
	} else if (sourceKind === "workflow-worktree") {
		const base = input.worktreeBaseBranch?.trim();
		if (!base) {
			return {
				ok: false,
				error: "无法从 worktree 状态推断目标分支（缺少 worktreeBaseBranch）；请用 --target <branch> 指定。",
			};
		}
		if (!localBranchExists(root, base, deps)) {
			return {
				ok: false,
				error: `worktree 基线分支 ${base} 不再是本地分支；请用 --target <branch> 指定目标。`,
			};
		}
		targetBranch = base;
	} else {
		const inferred = resolveDefaultTargetBranch(root, deps);
		if (!inferred) {
			return {
				ok: false,
				error: "无法推断目标分支（origin/HEAD 映射分支 / master / main 均不可用）；请用 --target <branch> 指定。",
			};
		}
		targetBranch = inferred;
	}

	if (targetBranch === sourceBranch) {
		return { ok: false, error: `来源分支与目标分支相同：${sourceBranch}` };
	}

	// ── cleanliness + sequencer checks ──
	const srcClean = isCheckoutClean(sourceCheckoutPath, deps);
	if (!srcClean.clean) {
		return {
			ok: false,
			error: `来源工作区存在未提交修改（不自动 stash）；请先提交或清理后重试：\n${boundedStatus(srcClean.status)}`,
		};
	}
	const srcSequencer = detectSequencer(sourceCheckoutPath, deps);
	if (srcSequencer.length) {
		return {
			ok: false,
			error: `来源 checkout 存在未结束的 git 操作（${srcSequencer.join(", ")}）；请先完成或 abort 后重试。`,
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
				error: `目标分支已在 ${targetEntry.path} checkout 且工作区不干净（不自动 stash）；请先提交或清理后重试：\n${boundedStatus(tgtClean.status)}`,
			};
		}
		const tgtSequencer = detectSequencer(targetEntry.path, deps);
		if (tgtSequencer.length) {
			return {
				ok: false,
				error: `目标 checkout ${targetEntry.path} 存在未结束的 git 操作（${tgtSequencer.join(", ")}）；请先完成或 abort 后重试。`,
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
		return { ok: false, error: `来源分支不存在：${sourceBranch}` };
	}
	const targetHeadBefore = gitStdout(
		root,
		["rev-parse", "--verify", `refs/heads/${targetBranch}`],
		deps,
	);
	if (!targetHeadBefore) {
		return { ok: false, error: `目标分支不存在：${targetBranch}` };
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
		return { ok: false, error: "无法计算来源分支领先提交数（git rev-list 失败）。" };
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
			error: `来源分支已不存在：${opts.sourceBranch}`,
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
			error: `目标分支已不存在：${opts.targetBranch}`,
			diagnostics,
			alreadyIntegrated: false,
			appliedVia: "none",
		};
	}
	diagnostics.push(`source ${opts.sourceBranch}: ${sourceHead}`);
	diagnostics.push(`target ${opts.targetBranch}: ${targetHead}`);

	if (sourceHead === targetHead) {
		diagnostics.push("target 已等于 source head，无需前移。");
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
				`目标分支 ${opts.targetBranch} 在基线后发生了移动，已不是 ${opts.sourceBranch} 的 ancestor；` +
				"fail closed（未修改任何 ref）。请先在来源 checkout 重新 rebase 后再次调用 workflow_merge_complete。",
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
				error: `目标 worktree ${targetEntry.path} 不干净，拒绝 fast-forward：\n${boundedStatus(clean.status)}`,
				diagnostics,
				alreadyIntegrated: false,
				appliedVia: "none",
			};
		}
		const head = gitStdout(targetEntry.path, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
		if (head !== opts.targetBranch) {
			return {
				ok: false,
				error: `目标 worktree ${targetEntry.path} 的 HEAD 为 ${head ?? "(unknown)"}，与 ${opts.targetBranch} 不一致，拒绝 fast-forward。`,
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
				error: `目标 worktree fast-forward 失败：${gitErrorMessage(err)}`,
				diagnostics,
				alreadyIntegrated: false,
				appliedVia: "worktree-merge",
			};
		}
		diagnostics.push(`已在目标 worktree ${targetEntry.path} 执行 merge --ff-only。`);
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
					`目标分支原子前移失败（目标可能被并发移动）：${gitErrorMessage(err)}。` +
					"fail closed（未覆盖任何 ref）；请先在来源 checkout 重新 rebase 后重试。",
				diagnostics,
				alreadyIntegrated: false,
				appliedVia: "update-ref",
			};
		}
		diagnostics.push("已通过 update-ref（expected-old CAS）原子前移目标分支。");
	}

	const newTargetHead = gitStdout(
		cwd,
		["rev-parse", "--verify", `refs/heads/${opts.targetBranch}`],
		deps,
	);
	if (newTargetHead !== sourceHead) {
		return {
			ok: false,
			error: `fast-forward 后校验失败：target=${newTargetHead ?? "(missing)"} source=${sourceHead}`,
			diagnostics,
			alreadyIntegrated: false,
			appliedVia: targetEntry ? "worktree-merge" : "update-ref",
		};
	}
	diagnostics.push(`target ${opts.targetBranch} 现为 ${newTargetHead}`);
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
	if (!sourceHead) failures.push(`来源分支不存在：${opts.sourceBranch}`);
	const targetHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.targetBranch}`], deps);
	if (!targetHead) failures.push(`目标分支不存在：${opts.targetBranch}`);
	if (sourceHead && targetHead) {
		diagnostics.push(`source ${opts.sourceBranch}: ${sourceHead}`);
		diagnostics.push(`target ${opts.targetBranch}: ${targetHead}`);
		if (sourceHead !== targetHead) {
			failures.push(`目标 head 与来源 head 不一致：${targetHead} != ${sourceHead}`);
		}
	}

	const branch = gitStdout(opts.sourceCheckoutPath, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
	if (branch !== opts.sourceBranch) {
		failures.push(`来源 checkout 当前为 ${branch ?? "(unknown)"}，应停留在来源分支 ${opts.sourceBranch}`);
	} else {
		diagnostics.push(`来源 checkout 停留在 ${branch}`);
	}

	const clean = isCheckoutClean(opts.sourceCheckoutPath, deps);
	if (!clean.clean) {
		failures.push(`来源工作区不干净（rebase 结果未全部提交？）：\n${boundedStatus(clean.status)}`);
	} else {
		diagnostics.push("来源工作区干净。");
	}

	const sequencer = detectSequencer(opts.sourceCheckoutPath, deps);
	if (sequencer.length) {
		failures.push(`来源 checkout 存在未结束的 git 操作：${sequencer.join(", ")}`);
	} else {
		diagnostics.push("来源 checkout 无未结束 git 操作。");
	}

	// Target checkout (when the target branch is checked out) must be clean too.
	const map = resolveWorktreeMap(cwd, deps);
	const targetEntry = map.find((e) => e.branch === opts.targetBranch);
	if (targetEntry) {
		const tgtClean = isCheckoutClean(targetEntry.path, deps);
		if (!tgtClean.clean) {
			failures.push(`目标 worktree ${targetEntry.path} 不干净：\n${boundedStatus(tgtClean.status)}`);
		} else {
			diagnostics.push(`目标 worktree ${targetEntry.path} 干净。`);
		}
	} else {
		diagnostics.push(`目标分支 ${opts.targetBranch} 未被任何 worktree checkout。`);
	}

	if (opts.sourceKind === "workflow-worktree") {
		const exists = depsExists(deps);
		if (!opts.worktreePath || !exists(opts.worktreePath)) {
			failures.push(`workflow worktree 不存在或未记录：${opts.worktreePath ?? "(missing)"}`);
		} else {
			const entry = map.find((e) => samePath(e.path, opts.worktreePath!, deps));
			if (!entry) {
				failures.push(`workflow worktree ${opts.worktreePath} 不在同仓 worktree 列表中`);
			} else {
				diagnostics.push(`workflow worktree ${opts.worktreePath} 保留，checkout ${entry.branch ?? "(detached)"}。`);
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
		failures.push(`来源 checkout 存在未结束的 git 操作：${sequencer.join(", ")}；请先完成或 abort。`);
	} else {
		diagnostics.push("来源 checkout 无未结束 git 操作。");
	}

	const sourceHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.sourceBranch}`], deps);
	if (sourceHead) {
		diagnostics.push(`source ref ${opts.sourceBranch}: ${sourceHead}`);
	} else {
		diagnostics.push(`source ref ${opts.sourceBranch}: (不存在——若用户指令已删除来源分支属预期)`);
	}
	const targetHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.targetBranch}`], deps);
	if (targetHead) {
		diagnostics.push(`target ref ${opts.targetBranch}: ${targetHead}`);
	} else {
		failures.push(`目标分支不存在：${opts.targetBranch}`);
	}

	const branch = gitStdout(opts.sourceCheckoutPath, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
	diagnostics.push(`来源 checkout 当前：${branch ?? "(detached HEAD 或不可解析)"}`);

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
				failures.push(`${isSource ? "来源" : "目标"} checkout ${entry.path} 不干净：\n${boundedStatus(clean.status)}`);
			} else {
				diagnostics.push(`${isSource ? "来源" : "目标"} checkout ${entry.path} 干净。`);
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
				`workflow worktree ${opts.worktreePath} 已不存在或未注册（用户指令删除时属预期，将清理 state 字段）。`,
			);
		} else {
			diagnostics.push(`workflow worktree ${opts.worktreePath} 仍保留。`);
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
				error: `中止 ${kind} 失败：${gitErrorMessage(err)}。可手动执行 git -C ${opts.sourceCheckoutPath} ${op.join(" ")} 后重试取消。`,
				aborted,
				reattached: false,
				diagnostics,
			};
		}
	}
	if (aborted.length) {
		diagnostics.push(`已中止未结束操作：${aborted.join(", ")}。`);
	}

	let reattached = false;
	const head = gitStdout(opts.sourceCheckoutPath, ["rev-parse", "--abbrev-ref", "HEAD"], deps);
	if (head === "HEAD") {
		// Sequencer gone but the checkout is still detached — rebase --quit style
		// leftover. Guarded forced reattach below drops in-flight changes by design.
		if (!localBranchExists(cwd, opts.sourceBranch, deps)) {
			return {
				ok: false,
				error: `来源分支 ${opts.sourceBranch} 已不存在，无法恢复 checkout；请手动处理 git -C ${opts.sourceCheckoutPath} 的 detached HEAD 状态。`,
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
					error: `来源 worktree ${opts.sourceCheckoutPath} 不在同仓 worktree 列表中，拒绝强制 checkout；请手动处理。`,
					aborted,
					reattached: false,
					diagnostics,
				};
			}
			if (main && samePath(main.path, opts.sourceCheckoutPath, deps)) {
				return {
					ok: false,
					error: "来源路径指向主 checkout，与 workflow-worktree 状态不一致，拒绝强制 checkout；请手动处理。",
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
				`已执行 checkout -f ${opts.sourceBranch}：在途冲突解决与 index/worktree 改动已按取消语义丢弃。`,
			);
		} catch (err) {
			return {
				ok: false,
				error: `恢复来源分支 checkout 失败：${gitErrorMessage(err)}。手动恢复：git -C ${opts.sourceCheckoutPath} checkout -f ${opts.sourceBranch}`,
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
			error: `恢复后来源 checkout 为 ${finalBranch ?? "(unknown)"}，应为 ${opts.sourceBranch}；未清除 merge 状态，请手动处理。`,
			aborted,
			reattached,
			diagnostics,
		};
	}
	diagnostics.push(`来源 checkout 已恢复为 ${finalBranch}。`);

	const clean = isCheckoutClean(opts.sourceCheckoutPath, deps);
	if (!clean.clean) {
		// After a forced checkout, residue is untracked-only in practice; keep the
		// cancel recoverable and surface the residue instead of stranding the user.
		diagnostics.push(`来源工作区仍有残留（多为 untracked 文件）：\n${boundedStatus(clean.status)}`);
	} else {
		diagnostics.push("来源工作区干净。");
	}

	// Report the actual ref state — already-moved refs are not rolled back.
	const sourceHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.sourceBranch}`], deps);
	diagnostics.push(`source ref ${opts.sourceBranch}: ${sourceHead ?? "(不存在)"}`);
	const targetHead = gitStdout(cwd, ["rev-parse", "--verify", `refs/heads/${opts.targetBranch}`], deps);
	diagnostics.push(
		targetHead && sourceHead && targetHead !== sourceHead
			? `target ref ${opts.targetBranch}: ${targetHead}（与 source 不同——已完成的 ref 移动不隐式回滚）`
			: `target ref ${opts.targetBranch}: ${targetHead ?? "(不存在)"}`,
	);

	return { ok: true, aborted, reattached, diagnostics };
}
