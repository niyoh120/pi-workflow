import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

export function workflowDir(cwd: string): string {
  return path.join(cwd, ".pi", "workflow");
}

export function ensureWorkflowDir(cwd: string): void {
  fs.mkdirSync(workflowDir(cwd), { recursive: true });
}

export function configPath(cwd: string): string {
  return path.join(workflowDir(cwd), "config.json");
}

/** Legacy directory-wide state path (no longer used for runtime state since session-scoped migration). */
export function legacyStatePath(cwd: string): string {
  return path.join(workflowDir(cwd), "state.json");
}

/** Directory for all plan documents (shared across sessions, randomized filenames). */
export function planDir(cwd: string): string {
  const dir = path.join(workflowDir(cwd), "plan");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Global config path: ~/.pi/agent/workflow/config.json */
export function globalConfigPath(agentDir: string): string {
  const dir = path.join(agentDir, "workflow");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "config.json");
}

// ── Session-scoped paths ──────────────────────

/** Session-scoped directory for runtime state. */
export function sessionDir(cwd: string, sessionKey: string): string {
  const dir = path.join(workflowDir(cwd), "sessions", sessionKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Session-scoped runtime state path. */
export function sessionStatePath(cwd: string, sessionKey: string): string {
  return path.join(sessionDir(cwd, sessionKey), "state.json");
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
  // Extract last segment or first token, replacing non-alphanumeric chars.
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

/** Derive a review filename from a plan filename (plan-a3b9f2c1.md → plan-a3b9f2c1.review.md) */
export function deriveReviewFilename(planFilename: string): string {
  const dotIndex = planFilename.lastIndexOf(".");
  const base = dotIndex > 0 ? planFilename.slice(0, dotIndex) : planFilename;
  return `${base}.review.md`;
}
