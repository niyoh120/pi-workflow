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

export function statePath(cwd: string): string {
  return path.join(workflowDir(cwd), "state.json");
}

/** Directory for all plan documents. */
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
