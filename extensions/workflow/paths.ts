import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

export function workflowDir(cwd: string): string {
  return path.join(cwd, ".pi", "workflow");
}

/** Ensure the .pi/workflow directory exists. Only called when writing. */
export function ensureWorkflowDir(cwd: string): void {
  fs.mkdirSync(workflowDir(cwd), { recursive: true });
}

/** Directory for all plan documents (shared across sessions, randomized filenames).
 *  Pure path function — callers that write a new plan must create the
 *  directory (see writeNewPlan). Readers/cleaners must tolerate a missing dir. */
export function planDir(cwd: string): string {
  return path.join(workflowDir(cwd), "plan");
}

export function configPath(cwd: string): string {
  return path.join(workflowDir(cwd), "config.json");
}

/** Global config path: ~/.pi/agent/workflow/config.json
 *  Pure path function — callers that write must create the parent directory
 *  (see writeRawJsonAtomic, which already mkdirs). Readers tolerate a missing file. */
export function globalConfigPath(agentDir: string): string {
  return path.join(agentDir, "workflow", "config.json");
}

// ── Session-scoped paths ──────────────────────

/** Session-scoped directory path. Does NOT create the directory —
 *  mkdirSync is only done in saveState() when actually writing. */
export function sessionDir(cwd: string, sessionKey: string): string {
  return path.join(workflowDir(cwd), "sessions", sessionKey);
}

/** Session-scoped runtime state path. Does NOT create directories. */
export function sessionStatePath(cwd: string, sessionKey: string): string {
  return path.join(sessionDir(cwd, sessionKey), "state.json");
}

/**
 * Session-scoped review-round history path. Separate from state.json so the
 * transient review verdict stays out of WorkflowState (it never gates
 * /wf-commit). Managed exclusively by the workflow_review tool. Does NOT create
 * directories.
 */
export function reviewHistoryPath(cwd: string, sessionKey: string): string {
  return path.join(sessionDir(cwd, sessionKey), "review-history.json");
}

/**
 * Session-scoped plan-review round history path. Separate from state.json so
 * the transient plan-review verdict stays out of WorkflowState (approval is
 * always user-confirmed). Managed exclusively by the workflow_plan_review
 * tool. Does NOT create directories.
 */
export function planReviewHistoryPath(cwd: string, sessionKey: string): string {
  return path.join(sessionDir(cwd, sessionKey), "plan-review-history.json");
}

/**
 * Derive a safe session key for filesystem use.
 * Hashes the session identity so raw ids/paths never become path segments directly.
 */
export function deriveSessionKey(sessionManager: {
  getSessionId?: () => string;
  getSessionFile?: () => string | null;
}): string {
  const identity = sessionManager.getSessionId?.()
    ?? sessionManager.getSessionFile?.()
    ?? "unknown";
  // Use first 16 hex chars of SHA-256 for a compact, safe directory name.
  const hash = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
  // Prefix with a short sanitized label from the identity for human readability.
  const label = identity
    .replace(/[\\/]/g, "-")
    .split("-")
    .pop()!
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
  return `${label}-${hash}`;
}

/** Generate a random plan filename like plan-a3b9f2c1.md */
export function generatePlanFilename(): string {
  return `plan-${crypto.randomBytes(4).toString("hex")}.md`;
}