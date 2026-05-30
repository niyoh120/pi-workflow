/**
 * ocr-helpers.ts — shared OCR CLI execution helpers.
 *
 * Used by both the workflow_code_review tool and the /review command
 * (legacy or refactored). All OCR calls go through these helpers.
 */

import { execFileSync, execFile } from "node:child_process";

// ── OCR availability ────────────────────────────────────────────────────────

/** Check whether the `ocr` CLI is available in PATH or at a configured path. */
export function checkOcrAvailable(binary: string): boolean {
  try {
    execFileSync(binary, ["review", "--help"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── Argv construction ───────────────────────────────────────────────────────

export type ReviewScopeKind = "workspace" | "range" | "commit";

/**
 * Build the full argv array for `ocr review`.
 * Always includes --audience agent. Adds --background when non-empty.
 * Appends scope flags for range/commit; workspace needs no scope flags.
 */
export function buildReviewArgv(
  background: string,
  scope: ReviewScopeKind,
  from?: string,
  to?: string,
  commit?: string,
  preview?: boolean,
): string[] {
  const argv = ["review", "--audience", "agent"];

  if (background) {
    argv.push("--background", background);
  }

  if (scope === "range" && from && to) {
    argv.push("--from", from, "--to", to);
  } else if (scope === "commit" && commit) {
    argv.push("--commit", commit);
  }
  // workspace: no extra flags

  if (preview) argv.push("--preview");

  return argv;
}

/** Human-readable summary of the review command for confirmation UI. */
export function ocrCommandSummary(binary: string, argv: string[]): string {
  function quoteArg(arg: string): string {
    const safeArg = stripTerminalControlChars(arg);
    if (/^[A-Za-z0-9_\/:\-=@%+.,~]+$/.test(safeArg)) return safeArg;
    return `'${safeArg.replace(/'/g, `'\\''`)}'`;
  }
  return [binary, ...argv].map(quoteArg).join(" ");
}

/** Strip ANSI escape sequences and C0/C1 control characters. */
function stripTerminalControlChars(s: string): string {
  return s
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|P[^\x1B]*(?:\x1B\\)|[\^_][^\x1B]*(?:\x1B\\))/g, "")
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

// ── Execution ───────────────────────────────────────────────────────────────

/** Run `ocr review` with an argv array asynchronously (no shell interpolation). */
export async function runOcrReview(
  binary: string,
  cwd: string,
  argv: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, argv, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      if (err) {
        const errorWithStderr = err as Error & { stderr?: string };
        errorWithStderr.stderr = stderr;
        reject(errorWithStderr);
        return;
      }
      resolve(stdout);
    });
  });
}

// ── Output parsing ──────────────────────────────────────────────────────────

/**
 * Parse OCR output into a structured format for workflow severity classification.
 *
 * Maps heuristic patterns:
 *   Security/Defect/Critical/Bug → hasCritical
 *   Maintainability/Quality/Important → hasImportant
 */
export function parseOcrOutput(raw: string): {
  hasCritical: boolean;
  hasImportant: boolean;
  formatted: string;
} {
  const lines = raw.split("\n");
  let hasCritical = false;
  let hasImportant = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/\b(security|critical|bug|defect|npe|dead\s*loop|sql\s*injection|xss|buffer\s*overflow)\b/.test(lower)) {
      hasCritical = true;
    }
    if (/\b(important|maintainability|quality|error\s*handling|edge\s*case|test\s*gap)\b/.test(lower)) {
      hasImportant = true;
    }
  }

  return { hasCritical, hasImportant, formatted: raw };
}