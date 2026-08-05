/**
 * ocr-helpers.ts — shared OCR CLI execution helpers.
 *
 * Used by the unified workflow_review tool / Review Agent. All OCR calls go
 * through these helpers. The unified review is workspace-only.
 */

import { execFileSync, execFile } from "node:child_process";
import { stripTerminalControl } from "./terminal-text.js";

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

/**
 * Build the full argv array for a workspace `ocr review`.
 * Always includes `--audience agent` and `--format json` so the model-visible
 * result can be parsed and compacted by ocr-result.ts. Adds `--background`
 * when non-empty. The unified review reviews the current workspace (staged +
 * unstaged + untracked changes), so no scope flags are appended.
 */
export function buildReviewArgv(background: string): string[] {
  const argv = ["review", "--audience", "agent", "--format", "json"];

  if (background) {
    argv.push("--background", background);
  }

  return argv;
}

/** Human-readable summary of the review command for confirmation UI. */
export function ocrCommandSummary(binary: string, argv: string[]): string {
  function quoteArg(arg: string): string {
    const safeArg = stripTerminalControl(arg);
    if (/^[A-Za-z0-9_\/:\-=@%+.,~]+$/.test(safeArg)) return safeArg;
    return `'${safeArg.replace(/'/g, `'\\''`)}'`;
  }
  return [binary, ...argv].map(quoteArg).join(" ");
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