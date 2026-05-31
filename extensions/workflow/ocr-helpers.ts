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
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, argv, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      signal,
    }, (err, stdout, stderr) => {
      if (err) {
        const errorWithOutput = err as Error & { stderr?: string; stdout?: string };
        errorWithOutput.stderr = stderr;
        errorWithOutput.stdout = stdout;
        reject(errorWithOutput);
        return;
      }
      resolve(stdout);
    });
  });
}