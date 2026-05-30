import { execFileSync, execSync } from "node:child_process";
import type { WorkflowState } from "./types.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Regex for valid baseline refs: 40-char hex SHA or literal "HEAD". */
const VALID_BASELINE_REF_RE = /^(?:[0-9a-f]{40}|HEAD)$/;

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

// ── Baseline creation ──────────────────────────────────────────────────────

/**
 * Create a work baseline snapshot using `git stash create`.
 * Returns the commit SHA, or "HEAD" as fallback.
 * Returns undefined if the repo has no initial commit (no HEAD to baseline against).
 */
export function createWorkBaseline(cwd: string): string | undefined {
  // No initial commit → no baseline needed (all files are new)
  if (!hasInitialCommit(cwd)) {
    return undefined;
  }

  try {
    const stashRef = execSync("git stash create", {
      cwd,
      encoding: "utf8",
      timeout: 10000,
    }).trim();

    if (stashRef && isValidBaselineRef(stashRef)) {
      return stashRef;
    }

    const headRef = execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    if (isValidBaselineRef(headRef)) {
      return headRef;
    }

    return "HEAD";
  } catch {
    try {
      const headRef = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
        timeout: 5000,
      }).trim();

      if (isValidBaselineRef(headRef)) {
        return headRef;
      }
      return "HEAD";
    } catch {
      return "HEAD";
    }
  }
}

/** Capture the current set of untracked file paths at Work mode entry. */
export function captureBaselineUntracked(cwd: string): string[] {
  const rawPaths = safeExecGit(cwd, ["ls-files", "-o", "--exclude-standard"]);
  return rawPaths
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Validate a persisted baseline ref. */
export function isValidBaselineRef(ref: string): boolean {
  return VALID_BASELINE_REF_RE.test(ref);
}

/** Clear both work baseline fields from state. */
export function clearWorkBaseline(state: WorkflowState): void {
  state.workBaselineRef = undefined;
  state.workBaselineUntracked = undefined;
}

// ── Review diff collection ─────────────────────────────────────────────────

// ── Internal helpers ────────────────────────────────────────────────────────

/** Safe git execution using argv (no string interpolation). Returns stdout or error string. */
function safeExecGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    }).toString();
  } catch {
    return `(could not run git ${args.join(" ")})`;
  }
}