/**
 * ocr-helpers.ts — shared OCR delegate CLI execution helpers.
 *
 * Used by the unified workflow_review tool / Review Agent. The unified review
 * is workspace-only. Delegation mode is fully local (zero LLM calls):
 * `ocr delegate preview` yields the reviewable file list and `ocr delegate
 * rule` yields the resolved review rules; both are injected into the reviewer
 * task as the Code Review Delegation spec, and the reviewer produces the
 * code-level findings itself.
 */

import { execFile, execFileSync } from "node:child_process";
import { stripTerminalControl } from "./terminal-text.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** The ocr binary name. Fixed; resolved from PATH. */
export const OCR_BINARY = "ocr";

/** Delegate commands run locally (git + file reads only); this bound is a
 *  runaway guard, not an expected duration. */
export const DELEGATE_TIMEOUT_MS = 30_000;

/** Character budget for the resolved rule text injected into the reviewer
 *  task. Beyond this the text is truncated and the task notes the truncation
 *  so the reviewer knows the rule set is partial. */
export const DELEGATE_RULE_BUDGET_CHARS = 64 * 1024;

// ── Availability ────────────────────────────────────────────────────────────

/**
 * Check whether the `ocr` CLI is available AND supports the delegate
 * subcommand (older versions without delegation mode fail here). This is a
 * capability probe, not a compatibility fallback.
 */
export function checkOcrAvailable(binary: string): boolean {
  try {
    execFileSync(binary, ["delegate", "--help"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── Argv construction ───────────────────────────────────────────────────────

/**
 * Build the full argv array for a workspace `ocr delegate preview`.
 * Workspace mode reviews the current workspace (staged + unstaged + untracked
 * changes), so no scope flags (`--from/--to/--commit`) are appended.
 */
export function buildDelegatePreviewArgv(): string[] {
  return ["delegate", "preview"];
}

/**
 * Build the full argv array for `ocr delegate rule` over the given reviewable
 * files. The files come from the parsed preview output, so they are
 * repo-relative paths as reported by the ocr CLI.
 */
export function buildDelegateRuleArgv(files: string[]): string[] {
  return ["delegate", "rule", ...files];
}

/** Human-readable summary of the ocr command for confirmation/diagnostics UI. */
export function ocrCommandSummary(binary: string, argv: string[]): string {
  function quoteArg(arg: string): string {
    const safeArg = stripTerminalControl(arg);
    if (/^[A-Za-z0-9_\/:\-=@%+.,~]+$/.test(safeArg)) return safeArg;
    return `'${safeArg.replace(/'/g, `'\\''`)}'`;
  }
  return [binary, ...argv].map(quoteArg).join(" ");
}

// ── Execution ───────────────────────────────────────────────────────────────

/** Run the ocr CLI with an argv array asynchronously (no shell interpolation). */
export async function runOcrCli(
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

// ── Preview output parsing ──────────────────────────────────────────────────

/** One reviewable file from `ocr delegate preview`. */
export interface DelegatePreviewFile {
  /** Repo-relative path as reported by the CLI. */
  path: string;
  /** Change status reported by the CLI, e.g. added / modified / deleted. */
  status: string;
  insertions?: number;
  deletions?: number;
}

/** Parsed preview result: the reviewable file list plus header metadata. */
export interface DelegatePreview {
  reviewableCount: number;
  totalCount: number;
  files: DelegatePreviewFile[];
}

const PREVIEW_HEADER_RE = /^# Files \((\d+) reviewable \/ (\d+) total\)\s*$/;
const PREVIEW_FILE_LINE_RE = /^ {2}- `([^`]+)` \[([^\]]+)\](?: \+(\d+)\/-(\d+))?\s*$/;

/**
 * Parse `ocr delegate preview` markdown output into the reviewable file list.
 *
 * Expected shape (observed CLI contract):
 * ```
 * # Files (N reviewable / M total)
 *
 * - mode: workspace
 * - total_insertions: X
 * - total_deletions: Y
 *
 *   - `path` [status] +ins/-del
 * ~~- `excluded-path` [status] +ins/-del (excluded: reason)~~
 * ```
 *
 * Excluded files are struck through (`~~`) and skipped. The header's N must
 * match the number of parsed reviewable file lines — a mismatch means the CLI
 * text contract drifted, which fails closed with an explicit error instead of
 * silently reviewing a partial file set. Pure function.
 */
export function parseDelegatePreviewOutput(output: string): DelegatePreview {
  const lines = output.split("\n");
  const headerLine = lines.find((l) => l.startsWith("# Files ("));
  if (!headerLine) {
    throw new Error(
      'ocr delegate preview output missing "# Files (N reviewable / M total)" header — CLI format may have changed.',
    );
  }
  const headerMatch = PREVIEW_HEADER_RE.exec(headerLine.trim());
  if (!headerMatch) {
    throw new Error(
      `ocr delegate preview header does not match the expected format: ${JSON.stringify(headerLine)}`,
    );
  }
  const reviewableCount = Number(headerMatch[1]);
  const totalCount = Number(headerMatch[2]);

  const files: DelegatePreviewFile[] = [];
  for (const line of lines) {
    // Struck-through lines are excluded files — skip them.
    if (line.startsWith("~~")) continue;
    const m = PREVIEW_FILE_LINE_RE.exec(line);
    if (!m) continue;
    files.push({
      path: m[1],
      status: m[2],
      ...(m[3] !== undefined ? { insertions: Number(m[3]) } : {}),
      ...(m[4] !== undefined ? { deletions: Number(m[4]) } : {}),
    });
  }

  if (files.length !== reviewableCount) {
    throw new Error(
      `ocr delegate preview parse mismatch: header declares ${reviewableCount} reviewable file(s) but ${files.length} file line(s) were parsed — CLI format may have changed.`,
    );
  }
  return { reviewableCount, totalCount, files };
}
