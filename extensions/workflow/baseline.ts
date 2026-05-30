/**
 * baseline.ts — Git repo preflight helpers.
 *
 * After removing workflow baseline state, only git utility helpers remain.
 */

import { execSync } from "node:child_process";

// ── Git repo state detection ───────────────────────────────────────────────

/** Check whether the repo has at least one commit (HEAD resolves). */
export function hasInitialCommit(cwd: string): boolean {
  try {
    execSync("git rev-parse HEAD", { cwd, encoding: "utf8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Check whether the directory has a git repo at all. */
export function gitRepoPreflight(cwd: string, ctx?: any): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd, encoding: "utf8", timeout: 5000 });
    return true;
  } catch {
    if (ctx?.ui?.notify) {
      ctx.ui.notify("当前目录不是 git 仓库。Code review 需要 git 支持。", "warn");
    }
    return false;
  }
}