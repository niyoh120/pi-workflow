import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowState } from "./types.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Max file size for reading untracked text files into review context (100KB). */
const UNTRACKED_FILE_SIZE_LIMIT = 100 * 1024;

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

/** Context for code review when the repo has no initial commit. */
export interface NoCommitReviewContext {
  statusText: string;
  stagedDiff: string;
  untrackedContext: string;
}

/**
 * Collect review context for a repo with no initial commit.
 * Uses git status + git diff --cached + untracked file contents
 * (no HEAD to diff against — everything is new).
 */
export function collectNoCommitReviewContext(
  cwd: string,
  baselineUntracked?: string[],
): NoCommitReviewContext {
  const statusText = safeExecGit(cwd, ["status", "--short"]);

  // git diff --cached shows staged files' full content (all new)
  const stagedDiff = safeExecGit(cwd, ["diff", "--cached"]);

  // Untracked files
  const untracked = collectUntrackedFiles(cwd, baselineUntracked);

  return {
    statusText: statusText || "(no changes)",
    stagedDiff: stagedDiff || "(empty)",
    untrackedContext: formatUntrackedContext(untracked.contents),
  };
}

/**
 * Collect the diff for code review using the work baseline ref.
 * Uses argv-based execution to prevent command injection.
 * Falls back to `git diff HEAD` if baseline is invalid/missing.
 */
export function collectBaselineDiff(cwd: string, baselineRef?: string): {
  diffStat: string;
  diff: string;
} {
  const effectiveRef = baselineRef && isValidBaselineRef(baselineRef) ? baselineRef : undefined;

  if (!effectiveRef) {
    return {
      diffStat: safeExecGit(cwd, ["diff", "--stat", "HEAD"]),
      diff: safeExecGit(cwd, ["diff", "HEAD"]),
    };
  }

  return {
    diffStat: safeExecGit(cwd, ["diff", "--stat", effectiveRef]),
    diff: safeExecGit(cwd, ["diff", effectiveRef]),
  };
}

/**
 * Collect untracked file paths and their contents for review context.
 * Text files under 100KB are read in full; binary/large files are marked.
 */
export function collectUntrackedFiles(cwd: string, baselineUntracked?: string[]): {
  paths: string[];
  contents: Array<{ path: string; content: string; binary: boolean; large: boolean }>;
} {
  const rawPaths = safeExecGit(cwd, ["ls-files", "-o", "--exclude-standard"]);
  const paths = rawPaths
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);

  const baselineSet = new Set(baselineUntracked ?? []);
  const sessionNewPaths = paths.filter((p) => !baselineSet.has(p));

  const contents: Array<{ path: string; content: string; binary: boolean; large: boolean }> = [];

  for (const relPath of sessionNewPaths) {
    const absPath = path.join(cwd, relPath);

    try {
      const lstat = fs.lstatSync(absPath);

      if (lstat.isSymbolicLink()) {
        contents.push({ path: relPath, content: "", binary: true, large: false });
        continue;
      }
      if (!lstat.isFile()) {
        contents.push({ path: relPath, content: "", binary: true, large: false });
        continue;
      }

      if (lstat.size > UNTRACKED_FILE_SIZE_LIMIT) {
        contents.push({ path: relPath, content: "", binary: false, large: true });
        continue;
      }

      const realAbsPath = fs.realpathSync(absPath);
      const realCwd = fs.realpathSync(cwd);
      const relToCwd = path.relative(realCwd, realAbsPath);
      if (relToCwd.startsWith("..") || path.resolve(realCwd, relToCwd) !== realAbsPath) {
        contents.push({ path: relPath, content: "", binary: true, large: false });
        continue;
      }

      const buf = fs.readFileSync(absPath);
      const sampleSize = Math.min(buf.length, 8192);
      const isBinary = buf.subarray(0, sampleSize).some((b) => b === 0);
      if (isBinary) {
        contents.push({ path: relPath, content: "", binary: true, large: false });
        continue;
      }

      const text = buf.toString("utf8");
      contents.push({ path: relPath, content: text, binary: false, large: false });
    } catch {
      // File may have been deleted between ls-files and read — skip silently.
    }
  }

  return { paths, contents };
}

/** Format untracked file contents into a review context section. */
export function formatUntrackedContext(
  untracked: Array<{ path: string; content: string; binary: boolean; large: boolean }>
): string {
  if (untracked.length === 0) return "(no untracked files)";

  const lines: string[] = [];
  for (const f of untracked) {
    if (f.binary) {
      lines.push(`### ${f.path} [binary, 内容未包含]`);
    } else if (f.large) {
      lines.push(`### ${f.path} [large (>100KB), 内容未包含]`);
    } else {
      lines.push(`### ${f.path} (新增文件, untracked)`);
      lines.push(f.content);
    }
    lines.push("");
  }

  return lines.join("\n");
}

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