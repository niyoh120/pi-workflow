import fs from "node:fs";
import path from "node:path";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { sessionStatePath, legacyStatePath, legacyMigrationMarkerPath, deriveSessionKey, ensureWorkflowDir, planDir, generatePlanFilename, deriveReviewFilename } from "./paths.js";
import { deepMerge } from "./config.js";

/** Minimal session manager interface needed to derive the session key. */
export interface SessionKeySource {
  getSessionId?: () => string;
  getSessionFile?: () => string | null;
}

/** Derive the safe session key from a context-like object. */
export function getSessionKey(ctx: { sessionManager?: SessionKeySource } | SessionKeySource): string {
  const sm = "sessionManager" in ctx ? ctx.sessionManager : ctx;
  return deriveSessionKey(sm ?? {});
}

/**
 * Load runtime state from the session-scoped path.
 * On first access, imports legacy .pi/workflow/state.json once,
 * then writes a marker so subsequent sessions start fresh.
 */
export function loadState(cwd: string, sessionKey: string): WorkflowState {
  ensureWorkflowDir(cwd);
  const spath = sessionStatePath(cwd, sessionKey);

  if (!fs.existsSync(spath)) {
    // One-shot legacy migration: import directory-wide state.json once.
    const markerPath = legacyMigrationMarkerPath(cwd);
    if (!fs.existsSync(markerPath)) {
      const lpath = legacyStatePath(cwd);
      if (fs.existsSync(lpath)) {
        try {
          const legacy = deepMerge(
            DEFAULT_STATE,
            JSON.parse(fs.readFileSync(lpath, "utf8"))
          );
          fs.mkdirSync(path.dirname(spath), { recursive: true });
          fs.writeFileSync(spath, JSON.stringify(legacy, null, 2), "utf8");
          fs.writeFileSync(markerPath, "", "utf8");
          return legacy;
        } catch {
          // Corrupt legacy JSON — write marker to prevent repeated import attempts.
          fs.writeFileSync(markerPath, "", "utf8");
          return { ...DEFAULT_STATE };
        }
      }
      // No legacy state to import. Write marker so later sessions skip the check.
      fs.writeFileSync(markerPath, "", "utf8");
    }
    return { ...DEFAULT_STATE };
  }

  try {
    return deepMerge(
      DEFAULT_STATE,
      JSON.parse(fs.readFileSync(spath, "utf8"))
    );
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Persist runtime state to the session-scoped path. */
export function saveState(cwd: string, sessionKey: string, state: WorkflowState): void {
  const spath = sessionStatePath(cwd, sessionKey);
  fs.mkdirSync(path.dirname(spath), { recursive: true });
  fs.writeFileSync(spath, JSON.stringify(state, null, 2), "utf8");
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
