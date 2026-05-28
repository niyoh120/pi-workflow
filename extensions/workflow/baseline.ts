import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowState } from "./types.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Max file size for reading untracked text files into review context (100KB). */
const UNTRACKED_FILE_SIZE_LIMIT = 100 * 1024;

/** Regex for valid baseline refs: 40-char hex SHA or literal "HEAD". */
const VALID_BASELINE_REF_RE = /^(?:[0-9a-f]{40}|HEAD)$/;

// ── Baseline creation ──────────────────────────────────────────────────────

/**
 * Create a work baseline snapshot using `git stash create`.
 * This captures the current tracked working tree content (both staged and unstaged)
 * as a dangling commit object, without modifying the stash ref stack.
 *
 * Returns the commit SHA, or "HEAD" as fallback if worktree is clean or stash create fails.
 * The returned ref is validated against a strict safe pattern before use.
 */
export function createWorkBaseline(cwd: string): string {
  try {
    // git stash create returns a commit SHA for the current working tree state,
    // or empty string if the worktree is clean (no changes to stash).
    const stashRef = execSync("git stash create", {
      cwd,
      encoding: "utf8",
      timeout: 10000,
    }).trim();

    if (stashRef && isValidBaselineRef(stashRef)) {
      return stashRef;
    }

    // Clean worktree or stash create returned nothing — fallback to HEAD.
    const headRef = execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    if (isValidBaselineRef(headRef)) {
      return headRef;
    }

    // HEAD also failed — return HEAD literal as last resort
    // (git diff HEAD will still work if repo exists).
    return "HEAD";
  } catch {
    // git stash create or rev-parse failed — try HEAD as fallback.
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

/** Capture the current set of untracked file paths at Work mode entry.
 *  Returns an array of relative paths for later scoping. */
export function captureBaselineUntracked(cwd: string): string[] {
  const rawPaths = safeExecGit(cwd, ["ls-files", "-o", "--exclude-standard"]);
  return rawPaths
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Validate a persisted baseline ref.
 *  Must be a 40-char hex SHA or the literal string "HEAD".
 *  Prevents command injection when refs are persisted in state and
 *  later used in git commands. */
export function isValidBaselineRef(ref: string): boolean {
  return VALID_BASELINE_REF_RE.test(ref);
}

/** Clear both work baseline fields from state (used at workflow exit points). */
export function clearWorkBaseline(state: WorkflowState): void {
  state.workBaselineRef = undefined;
  state.workBaselineUntracked = undefined;
}

// ── Review diff collection ─────────────────────────────────────────────────

/**
 * Collect the diff for code review using the work baseline ref.
 * Uses argv-based execution (execFileSync) to prevent command injection
 * from persisted refs. Falls back to `git diff HEAD` if baseline is invalid/missing.
 */
export function collectBaselineDiff(cwd: string, baselineRef?: string): {
  diffStat: string;
  diff: string;
} {
  const effectiveRef = baselineRef && isValidBaselineRef(baselineRef) ? baselineRef : undefined;

  if (!effectiveRef) {
    // Fallback: git diff HEAD includes both staged and unstaged changes.
    return {
      diffStat: safeExecGit(cwd, ["diff", "--stat", "HEAD"]),
      diff: safeExecGit(cwd, ["diff", "HEAD"]),
    };
  }

  // Baseline-based diff: only changes since work session start.
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
  // List current untracked files (excluding .gitignored).
  const rawPaths = safeExecGit(cwd, ["ls-files", "-o", "--exclude-standard"]);
  const paths = rawPaths
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);

  // Scope to only files that were NOT present at baseline time.
  const baselineSet = new Set(baselineUntracked ?? []);
  const sessionNewPaths = paths.filter((p) => !baselineSet.has(p));

  const contents: Array<{ path: string; content: string; binary: boolean; large: boolean }> = [];

  for (const relPath of sessionNewPaths) {
    const absPath = path.join(cwd, relPath);

    try {
      const lstat = fs.lstatSync(absPath);

      // Security: skip symlinks to prevent leaking files outside the repo.
      // Only read regular non-symlink files.
      if (lstat.isSymbolicLink()) {
        contents.push({ path: relPath, content: "", binary: true, large: false });
        continue;
      }
      if (!lstat.isFile()) {
        // Skip directories, FIFOs, sockets, etc.
        contents.push({ path: relPath, content: "", binary: true, large: false });
        continue;
      }

      // Skip large files.
      if (lstat.size > UNTRACKED_FILE_SIZE_LIMIT) {
        contents.push({ path: relPath, content: "", binary: false, large: true });
        continue;
      }

      // Security: verify realpath stays under cwd (prevents symlink escape via realpath).
      const realAbsPath = fs.realpathSync(absPath);
      const realCwd = fs.realpathSync(cwd);
      const relToCwd = path.relative(realCwd, realAbsPath);
      if (relToCwd.startsWith("..") || path.resolve(realCwd, relToCwd) !== realAbsPath) {
        contents.push({ path: relPath, content: "", binary: true, large: false });
        continue;
      }

      // Skip binary files (heuristic: check for null bytes in first 8KB).
      const buf = fs.readFileSync(absPath);
      const sampleSize = Math.min(buf.length, 8192);
      const isBinary = buf.subarray(0, sampleSize).some((b) => b === 0);
      if (isBinary) {
        contents.push({ path: relPath, content: "", binary: true, large: false });
        continue;
      }

      // Text file — read content.
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