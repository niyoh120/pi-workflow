import fs from "node:fs";
import path from "node:path";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { statePath, ensureWorkflowDir, planDir, generatePlanFilename, deriveReviewFilename } from "./paths.js";
import { deepMerge } from "./config.js";

/** Load state from on-disk JSON. Returns default state if file is missing or corrupt. */
export function loadState(cwd: string): WorkflowState {
  ensureWorkflowDir(cwd);

  if (!fs.existsSync(statePath(cwd))) {
    return { ...DEFAULT_STATE };
  }

  try {
    return deepMerge(
      DEFAULT_STATE,
      JSON.parse(fs.readFileSync(statePath(cwd), "utf8"))
    );
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Persist current state to on-disk JSON. */
export function saveState(cwd: string, state: WorkflowState): void {
  ensureWorkflowDir(cwd);
  fs.writeFileSync(statePath(cwd), JSON.stringify(state, null, 2), "utf8");
}

/**
 * Allocate a new plan file in the plan directory.
 * Generates a random filename and writes `content` to it.
 * Returns relative paths for planPath and planReviewPath.
 */
export function writeNewPlan(
  cwd: string,
  state: WorkflowState,
  content: string
): { planPath: string; planReviewPath: string } {
  planDir(cwd);

  const planFile = generatePlanFilename();
  const reviewFile = deriveReviewFilename(planFile);

  const planAbs = path.join(planDir(cwd), planFile);
  fs.writeFileSync(planAbs, content, "utf8");

  const planRel = path.relative(cwd, planAbs);
  const reviewRel = path.relative(cwd, path.join(planDir(cwd), reviewFile));

  state.planPath = planRel;
  state.planReviewPath = reviewRel;

  return { planPath: planRel, planReviewPath: reviewRel };
}

/** Read the current plan file from disk. Returns empty string if not found. */
export function readPlan(cwd: string, planPath: string): string {
  const file = path.join(cwd, planPath);
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8");
  }
  return "";
}

/** Write the review notes to the plan's review file. */
export function writePlanReview(cwd: string, reviewPath: string, notes: string): void {
  const file = path.join(cwd, reviewPath);
  fs.writeFileSync(file, notes, "utf8");
}
