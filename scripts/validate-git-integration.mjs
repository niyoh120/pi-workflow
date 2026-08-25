/**
 * Regression validation: /wf-merge git integration (Merge Mode).
 *
 * Three focused scenarios against throwaway git repositories, using the real
 * git-integration.ts module (direct import — it keeps no local value imports)
 * and the real worktree validators from worktree.ts (type-only local imports):
 *
 *  1. Ordinary feature branch: --target/default-master resolution, dirty
 *     source rejection, default-ff via expected-old update-ref, source
 *     checkout retained on the feature branch, refs equal, defaultStrategy
 *     finalize enforcement (source-level).
 *  2. Workflow-style worktree conflict rebase: default target resolves the
 *     base branch, rebase conflict leaves the source worktree detached, the
 *     merge-aware validator still accepts it (strict rejects), and after
 *     resolving + `rebase --continue` the finalize runs `merge --ff-only` in
 *     the target checkout while the worktree/branch are retained.
 *  3. Failure & recovery: concurrent target movement fails the default ff
 *     closed; in-progress rebase cancellation aborts; `rebase --quit` residue
 *     is recovered by the guarded forced reattach (in-flight conflict
 *     resolution discarded, strict validation passes again).
 *
 * Run: node scripts/validate-git-integration.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	console.error("validate-git-integration.mjs requires Node >= 22.19 for native TypeScript loading.");
	process.exit(1);
}

const CWD = process.cwd();
let runs = 0;
let failures = 0;

function assert(condition, msg) {
	runs++;
	if (!condition) {
		console.error(`  FAIL: ${msg}`);
		failures++;
	} else {
		console.log(`  PASS: ${msg}`);
	}
}

/** git argv runner with a no-op editor and deterministic identity. */
function git(cwd, args, opts = {}) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_EDITOR: "true",
			GIT_AUTHOR_NAME: "Test Author",
			GIT_AUTHOR_EMAIL: "author@example.com",
			GIT_COMMITTER_NAME: "Test Committer",
			GIT_COMMITTER_EMAIL: "committer@example.com",
		},
		timeout: 60_000,
	}).trim();
}

function gitOk(cwd, args) {
	try {
		git(cwd, args);
		return true;
	} catch {
		return false;
	}
}

function commitFile(cwd, file, content, message) {
	fs.writeFileSync(path.join(cwd, file), content, "utf8");
	git(cwd, ["add", file]);
	git(cwd, ["commit", "-m", message]);
}

/** Remove a throwaway repo AND its sibling workflow-worktree dirs
 *  (`<repo>-wf-*`), which live outside the repo temp dir. */
function cleanupRepo(repo) {
	const parent = path.dirname(repo);
	const prefix = `${path.basename(repo)}-wf-`;
	for (const entry of fs.existsSync(parent) ? fs.readdirSync(parent) : []) {
		if (entry.startsWith(prefix)) {
			fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
		}
	}
	fs.rmSync(repo, { recursive: true, force: true });
}

// ── Load the real modules ───────────────────────────────────────────────────

const gitIntegration = await import(
	pathToFileURL(path.join(CWD, "extensions/workflow/git-integration.ts")).href
);
const worktreeMod = await import(
	pathToFileURL(path.join(CWD, "extensions/workflow/worktree.ts")).href
);

const {
	parseMergeCommandArgs,
	runMergePreflight,
	finalizeDefaultFf,
	verifyDefaultCompletion,
	cancelActiveMergeGit,
	detectSequencer,
	resolveDefaultTargetBranch,
} = gitIntegration;
const { validateWorktreeState, validateMergeWorktreeState } = worktreeMod;

assert(typeof parseMergeCommandArgs === "function", "git-integration.ts exports parseMergeCommandArgs");
assert(typeof runMergePreflight === "function", "git-integration.ts exports runMergePreflight");
assert(typeof finalizeDefaultFf === "function", "git-integration.ts exports finalizeDefaultFf");
assert(typeof verifyDefaultCompletion === "function", "git-integration.ts exports verifyDefaultCompletion");
assert(typeof cancelActiveMergeGit === "function", "git-integration.ts exports cancelActiveMergeGit");
assert(typeof validateMergeWorktreeState === "function", "worktree.ts exports validateMergeWorktreeState");

// ── 0. command parsing ──────────────────────────────────────────────────────

console.log("\n=== 0. /wf-merge argument parsing ===");
{
	let r = parseMergeCommandArgs("--target main");
	assert(r.ok && r.value.targetBranch === "main" && !r.value.instructions, "parse: --target <branch>");

	r = parseMergeCommandArgs("--target=dev squash commits please");
	assert(
		r.ok && r.value.targetBranch === "dev" && r.value.instructions === "squash commits please",
		"parse: --target= with verbatim trailing instructions",
	);

	r = parseMergeCommandArgs("rebase 并保持  --target main");
	assert(
		r.ok && r.value.instructions === "rebase 并保持  --target main" && !r.value.targetBranch,
		"parse: options must precede instructions (tail kept verbatim)",
	);

	r = parseMergeCommandArgs("--target main -- push --force-with-lease");
	assert(
		r.ok && r.value.targetBranch === "main" && r.value.instructions === "push --force-with-lease",
		"parse: -- ends options, remainder verbatim",
	);

	r = parseMergeCommandArgs("--verbose do it");
	assert(!r.ok && /未识别的选项/.test(r.error), "parse: unknown option rejected");

	r = parseMergeCommandArgs("");
	assert(r.ok && !r.value.targetBranch && !r.value.instructions, "parse: empty input → default strategy");
}

// ── 1. ordinary feature branch scenario ─────────────────────────────────────

console.log("\n=== 1. ordinary feature branch ===");
{
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-merge-1-"));
	try {
		git(repo, ["init", "-b", "master"]);
		commitFile(repo, "README.md", "base\n", "base commit");
		git(repo, ["checkout", "-b", "feature"]);
		commitFile(repo, "feature.txt", "feature work\n", "feature commit");
		git(repo, ["checkout", "master"]);
		commitFile(repo, "master.txt", "master work\n", "master commit");
		git(repo, ["checkout", "feature"]);

		// Default target inference: master exists locally → master.
		assert(resolveDefaultTargetBranch(repo) === "master", "default target infers local master");

		// Preflight: default target + explicit --target.
		let pre = runMergePreflight(repo, { targetBranch: undefined });
		assert(pre.ok && pre.value.targetBranch === "master" && pre.value.sourceBranch === "feature",
			"preflight: ordinary source = current checkout, default target = master");
		assert(pre.ok && pre.value.sourceKind === "ordinary-branch" && pre.value.sourceCheckoutPath === repo,
			"preflight: ordinary source checkout is the repo root");
		assert(pre.ok && pre.value.sourceOnlyCommitCountBefore === 1 && pre.value.targetCheckoutPath === null,
			"preflight: baseline counts source-only commits; target not checked out");

		pre = runMergePreflight(repo, { targetBranch: "feature" });
		assert(!pre.ok && /来源分支与目标分支相同/.test(pre.error), "preflight: source == target rejected");

		pre = runMergePreflight(repo, { targetBranch: "no-such-branch" });
		assert(!pre.ok && /目标分支不存在/.test(pre.error), "preflight: missing local target rejected");

		// Dirty source rejection (no auto-stash).
		fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty\n", "utf8");
		pre = runMergePreflight(repo, {});
		assert(!pre.ok && /未提交修改/.test(pre.error), "preflight: dirty source rejected without stash");
		fs.rmSync(path.join(repo, "dirty.txt"));

		// sourceLevel assertion: defaultStrategy only accepts ff-only finalize.
		const toolsSrc = fs.readFileSync(path.join(CWD, "extensions/workflow/tools.ts"), "utf8");
		assert(
			/mc\.defaultStrategy && params\.finalize !== "ff-only"/.test(toolsSrc) &&
				/只接受 finalize="ff-only"/.test(toolsSrc),
			"tools.ts: defaultStrategy mis-passing already-integrated is rejected explicitly",
		);

		// Rebase feature onto master, then default ff.
		git(repo, ["rebase", "master"]);

		const ff = finalizeDefaultFf(repo, { sourceBranch: "feature", targetBranch: "master" });
		assert(ff.ok && ff.appliedVia === "update-ref", "default ff: applied via update-ref (target not checked out)");
		const featureHead = git(repo, ["rev-parse", "refs/heads/feature"]);
		const masterHead = git(repo, ["rev-parse", "refs/heads/master"]);
		assert(masterHead === featureHead, "default ff: master == feature head");
		assert(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) === "feature",
			"default ff: current checkout stays on feature");

		const verify = verifyDefaultCompletion(repo, {
			sourceKind: "ordinary-branch",
			sourceBranch: "feature",
			targetBranch: "master",
			sourceCheckoutPath: repo,
		});
		assert(verify.failures.length === 0, `default completion checks pass (${verify.failures.join("; ")})`);

		// Already-integrated finalize is a clean no-op.
		const ff2 = finalizeDefaultFf(repo, { sourceBranch: "feature", targetBranch: "master" });
		assert(ff2.ok && ff2.alreadyIntegrated, "default ff: already-integrated is detected as a no-op");
	} finally {
		cleanupRepo(repo);
	}
}

// ── 2. workflow-style worktree conflict rebase ──────────────────────────────

console.log("\n=== 2. worktree conflict rebase ===");
{
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-merge-2-"));
	try {
		git(repo, ["init", "-b", "master"]);
		commitFile(repo, "app.txt", "base\n", "base");

		// Workflow-owned worktree with a semantic @wf- branch name.
		const wtPath = path.join(path.dirname(repo), `${path.basename(repo)}-wf-abcd1234`);
		const wtBranch = "feat/app@wf-abcd1234";
		git(repo, ["worktree", "add", "-b", wtBranch, wtPath, "master"]);

		// Diverging conflicting edits.
		commitFile(wtPath, "app.txt", "feature-version\n", "feature edit");
		commitFile(repo, "app.txt", "master-version\n", "master edit");

		// Preflight with the workflow state shape: source = worktree branch,
		// default target = worktreeBaseBranch (master), target checked out in
		// the main checkout.
		const pre = runMergePreflight(repo, {
			worktreePath: wtPath,
			worktreeBranch: wtBranch,
			worktreeBaseBranch: "master",
		});
		assert(pre.ok, `preflight: workflow worktree source ok (${pre.ok ? "" : pre.error})`);
		assert(
			pre.ok &&
				pre.value.sourceKind === "workflow-worktree" &&
				pre.value.sourceBranch === wtBranch &&
				pre.value.targetBranch === "master" &&
				pre.value.targetCheckoutPath === repo,
			"preflight: default target is the worktree base branch, checked out in main",
		);

		// Dirty worktree source rejection.
		fs.writeFileSync(path.join(wtPath, "extra.txt"), "x\n", "utf8");
		let dirtyPre = runMergePreflight(repo, {
			worktreePath: wtPath,
			worktreeBranch: wtBranch,
			worktreeBaseBranch: "master",
		});
		assert(!dirtyPre.ok && /未提交修改/.test(dirtyPre.error), "preflight: dirty worktree source rejected");
		fs.rmSync(path.join(wtPath, "extra.txt"));

		// Detached HEAD without a merge context stays fail-closed even with a
		// rebase sequencer (validator state shape without mergeContext).
		const stateShape = {
			worktreePath: wtPath,
			worktreeBranch: wtBranch,
			mergeContext: undefined,
		};
		const mergeStateShape = {
			worktreePath: wtPath,
			worktreeBranch: wtBranch,
			mergeContext: {
				sourceKind: "workflow-worktree",
				sourceBranch: wtBranch,
				targetBranch: "master",
				sourceHeadBefore: "0".repeat(40),
				targetHeadBefore: "0".repeat(40),
				sourceOnlyCommitCountBefore: 1,
				defaultStrategy: true,
				returnMode: "work",
			},
		};

		// Start the conflicting rebase in the source worktree.
		assert(
			!gitOk(wtPath, ["rebase", "master"]),
			"rebase: conflicting rebase exits non-zero",
		);
		assert(
			git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]) === "HEAD",
			"rebase: source worktree is detached during the conflict",
		);
		assert(
			detectSequencer(wtPath).includes("rebase-merge"),
			"rebase: rebase sequencer detected in the worktree",
		);

		// Strict validator rejects the detached conflict window.
		assert(
			validateWorktreeState(repo, stateShape).ok === false,
			"strict validator: detached rebase window rejected (Work/Review semantics preserved)",
		);
		// Merge-aware validator accepts the exact workflow rebase window.
		assert(
			validateMergeWorktreeState(repo, mergeStateShape).ok === true,
			"merge-aware validator: accepts the workflow worktree during its rebase",
		);
		// Merge-aware validator rejects a mismatched source branch context.
		assert(
			validateMergeWorktreeState(repo, {
				...mergeStateShape,
				mergeContext: { ...mergeStateShape.mergeContext, sourceBranch: "other@wf-abcd1234" },
			}).ok === false,
			"merge-aware validator: rejects detached HEAD for a mismatched merge source branch",
		);

		// Resolve the conflict, continue, finalize in the target checkout.
		fs.writeFileSync(path.join(wtPath, "app.txt"), "merged-version\n", "utf8");
		git(wtPath, ["add", "app.txt"]);
		git(wtPath, ["rebase", "--continue"]);

		// Sequencer gone → strict semantics resume.
		assert(
			validateWorktreeState(repo, stateShape).ok === true,
			"strict validator: passes again after the rebase completes",
		);

		const ff = finalizeDefaultFf(repo, { sourceBranch: wtBranch, targetBranch: "master" });
		assert(ff.ok && ff.appliedVia === "worktree-merge", "default ff: target checked out → merge --ff-only in that checkout");
		assert(
			git(repo, ["rev-parse", "refs/heads/master"]) === git(repo, ["rev-parse", `refs/heads/${wtBranch}`]),
			"default ff: master == source head after the worktree merge",
		);
		assert(
			git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]) === wtBranch,
			"default ff: source worktree retained on the source branch",
		);
		const verify = verifyDefaultCompletion(repo, {
			sourceKind: "workflow-worktree",
			sourceBranch: wtBranch,
			targetBranch: "master",
			sourceCheckoutPath: wtPath,
			worktreePath: wtPath,
		});
		assert(verify.failures.length === 0, `worktree completion checks pass (${verify.failures.join("; ")})`);
		assert(fs.readFileSync(path.join(repo, "app.txt"), "utf8") === "merged-version\n",
			"default ff: target checkout content advanced to the rebased version");
	} finally {
		cleanupRepo(repo);
	}
}

// ── 3. failure & recovery ───────────────────────────────────────────────────

console.log("\n=== 3. failure & recovery ===");
{
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-merge-3-"));
	try {
		git(repo, ["init", "-b", "master"]);
		commitFile(repo, "app.txt", "base\n", "base");

		// 3a. Concurrent target movement → default ff fails closed.
		git(repo, ["checkout", "-b", "feature"]);
		commitFile(repo, "feature.txt", "f1\n", "f1");
		git(repo, ["checkout", "master"]);
		commitFile(repo, "concurrent.txt", "concurrent\n", "concurrent move");
		git(repo, ["checkout", "feature"]);
		git(repo, ["rebase", "master"]);
		// A commit lands on master AFTER the rebase: target now contains a commit
		// the source does not have → ancestor check must fail closed.
		git(repo, ["checkout", "master"]);
		commitFile(repo, "later.txt", "later\n", "later move");
		const laterMasterHead = git(repo, ["rev-parse", "HEAD"]);
		git(repo, ["checkout", "feature"]);

		const ff = finalizeDefaultFf(repo, { sourceBranch: "feature", targetBranch: "master" });
		assert(!ff.ok && /ancestor/.test(ff.error), "concurrent target movement: ff fails closed on ancestor check");
		assert(
			git(repo, ["rev-parse", "refs/heads/master"]) === laterMasterHead,
			"concurrent target movement: master ref untouched after the failed ff",
		);
		// Re-rebase onto the current target and finalize again.
		git(repo, ["rebase", "master"]);
		const retry = finalizeDefaultFf(repo, { sourceBranch: "feature", targetBranch: "master" });
		assert(retry.ok, `re-rebase then finalize succeeds (${retry.ok ? "" : retry.error})`);
	} finally {
		cleanupRepo(repo);
	}

	// 3b. In-progress rebase → cancelled runs --abort.
	{
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-merge-3b-"));
		try {
			git(repo, ["init", "-b", "master"]);
			commitFile(repo, "app.txt", "base\n", "base");
			const wtPath = path.join(path.dirname(repo), `${path.basename(repo)}-wf-abcd1234`);
			const wtBranch = "feat/app@wf-abcd1234";
			git(repo, ["worktree", "add", "-b", wtBranch, wtPath, "master"]);
			commitFile(wtPath, "app.txt", "feature-version\n", "feature edit");
			commitFile(repo, "app.txt", "master-version\n", "master edit");

			assert(!gitOk(wtPath, ["rebase", "master"]), "3b: conflicting rebase starts");
			const cancel = cancelActiveMergeGit(repo, {
				sourceKind: "workflow-worktree",
				sourceBranch: wtBranch,
				targetBranch: "master",
				sourceCheckoutPath: wtPath,
			});
			assert(cancel.ok, `3b: cancel succeeds (${cancel.ok ? "" : cancel.error})`);
			assert(
				cancel.aborted.includes("rebase-merge") && !cancel.reattached,
				"3b: rebase aborted via --abort (no forced reattach needed)",
			);
			assert(
				git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]) === wtBranch,
				"3b: source worktree back on the source branch",
			);
			assert(
				git(wtPath, ["status", "--porcelain"]) === "",
				"3b: source worktree clean after abort",
			);
			assert(
				fs.readFileSync(path.join(wtPath, "app.txt"), "utf8") === "feature-version\n",
				"3b: pre-rebase source content restored",
			);
		} finally {
			cleanupRepo(repo);
		}
	}

	// 3c. `rebase --quit` residue → cancelled performs the guarded forced
	// reattach and discards in-flight conflict resolution.
	{
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-merge-3c-"));
		try {
			git(repo, ["init", "-b", "master"]);
			commitFile(repo, "app.txt", "base\n", "base");
			const wtPath = path.join(path.dirname(repo), `${path.basename(repo)}-wf-abcd1234`);
			const wtBranch = "feat/app@wf-abcd1234";
			git(repo, ["worktree", "add", "-b", wtBranch, wtPath, "master"]);
			commitFile(wtPath, "app.txt", "feature-version\n", "feature edit");
			commitFile(repo, "app.txt", "master-version\n", "master edit");

			assert(!gitOk(wtPath, ["rebase", "master"]), "3c: conflicting rebase starts");
			// In-flight conflict resolution the user will lose by design.
			fs.writeFileSync(path.join(wtPath, "app.txt"), "my-resolution\n", "utf8");
			git(wtPath, ["add", "app.txt"]);
			git(wtPath, ["rebase", "--quit"]);

			assert(
				git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]) === "HEAD",
				"3c: rebase --quit leaves the worktree detached",
			);
			assert(
				detectSequencer(wtPath).length === 0,
				"3c: sequencer cleared by --quit",
			);

			const cancel = cancelActiveMergeGit(repo, {
				sourceKind: "workflow-worktree",
				sourceBranch: wtBranch,
				targetBranch: "master",
				sourceCheckoutPath: wtPath,
			});
			assert(cancel.ok, `3c: guarded reattach cancel succeeds (${cancel.ok ? "" : cancel.error})`);
			assert(cancel.reattached, "3c: guarded forced checkout executed");
			assert(
				git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]) === wtBranch,
				"3c: branch abbrev restored to the source branch",
			);
			assert(
				git(wtPath, ["status", "--porcelain"]) === "",
				"3c: worktree clean after the forced reattach",
			);
			assert(
				fs.readFileSync(path.join(wtPath, "app.txt"), "utf8") === "feature-version\n",
				"3c: in-flight conflict resolution discarded (pre-rebase content back)",
			);
			assert(
				validateWorktreeState(repo, {
					worktreePath: wtPath,
					worktreeBranch: wtBranch,
				}).ok === true,
				"3c: strict validator passes after recovery",
			);

			// The reattach guard refuses a source branch that no longer exists.
			assert(!gitOk(wtPath, ["rebase", "master"]), "3c: second conflicting rebase starts");
			fs.writeFileSync(path.join(wtPath, "app.txt"), "second-resolution\n", "utf8");
			git(wtPath, ["add", "app.txt"]);
			git(wtPath, ["rebase", "--quit"]);
			git(repo, ["branch", "-D", wtBranch]);
			const guard = cancelActiveMergeGit(repo, {
				sourceKind: "workflow-worktree",
				sourceBranch: wtBranch,
				targetBranch: "master",
				sourceCheckoutPath: wtPath,
			});
			assert(
				!guard.ok && /来源分支/.test(guard.error),
				"3c: reattach guard refuses when the source branch ref is gone",
			);
		} finally {
			cleanupRepo(repo);
		}
	}
}

console.log(`\n=== Result: ${runs - failures}/${runs} passed ===`);
if (failures > 0) {
	console.error(`${failures} test(s) FAILED.`);
	process.exitCode = 1;
} else {
	console.log("All checks passed.");
}
