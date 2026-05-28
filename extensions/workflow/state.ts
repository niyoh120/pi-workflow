import fs from "node:fs";
import path from "node:path";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { sessionStatePath, deriveSessionKey, ensureWorkflowDir, planDir, generatePlanFilename, deriveReviewFilename } from "./paths.js";

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
 * Normalize a raw JSON object into a strict WorkflowState shape.
 * Drops unknown/removed keys such as planApproved.
 * Fills missing fields from DEFAULT_STATE.
 */
export function normalizeState(raw: unknown): WorkflowState {
  const obj = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};

  return {
    mode:        (typeof obj.mode === "string" ? obj.mode : DEFAULT_STATE.mode) as WorkflowState["mode"],
    planPath:    typeof obj.planPath   === "string" ? obj.planPath   : undefined,
    planReviewPath: typeof obj.planReviewPath === "string" ? obj.planReviewPath : undefined,
    planTitle:   typeof obj.planTitle  === "string" ? obj.planTitle  : undefined,
    planReviewStatus: (typeof obj.planReviewStatus === "string" ? obj.planReviewStatus : DEFAULT_STATE.planReviewStatus) as WorkflowState["planReviewStatus"],
    planReviewLoops:  typeof obj.planReviewLoops === "number" ? obj.planReviewLoops : DEFAULT_STATE.planReviewLoops,
    planReviewNotes:  typeof obj.planReviewNotes === "string" ? obj.planReviewNotes : undefined,
    planRunId:   typeof obj.planRunId   === "string" ? obj.planRunId   : undefined,
    workRunId:   typeof obj.workRunId   === "string" ? obj.workRunId   : undefined,
    codeReviewLoops:  typeof obj.codeReviewLoops === "number" ? obj.codeReviewLoops : DEFAULT_STATE.codeReviewLoops,
    autoCodeReview:   typeof obj.autoCodeReview  === "boolean" ? obj.autoCodeReview  : DEFAULT_STATE.autoCodeReview,
    todos:       Array.isArray(obj.todos) ? (obj.todos as Array<WorkflowState["todos"][number]>).filter((t: any) => t && typeof t === "object").map((t: any) => ({
                   id: t.id ?? "",
                   title: t.title ?? "",
                   status: t.status ?? "pending",
                   notes: t.notes,
                 })) : [],
    pendingWorkHandoff: (obj.pendingWorkHandoff && typeof obj.pendingWorkHandoff === "object")
      ? {
          id:             String((obj.pendingWorkHandoff as any).id ?? ""),
          marker:         String((obj.pendingWorkHandoff as any).marker ?? ""),
          planPath:       String((obj.pendingWorkHandoff as any).planPath ?? ""),
          planRunId:      typeof (obj.pendingWorkHandoff as any).planRunId === "string" ? (obj.pendingWorkHandoff as any).planRunId : undefined,
          workRunId:      String((obj.pendingWorkHandoff as any).workRunId ?? ""),
          createdAt:      String((obj.pendingWorkHandoff as any).createdAt ?? ""),
          expiresAt:      String((obj.pendingWorkHandoff as any).expiresAt ?? ""),
          expectedPrompt: String((obj.pendingWorkHandoff as any).expectedPrompt ?? ""),
        }
      : undefined,
    workStatus:     typeof obj.workStatus     === "string" ? obj.workStatus     as WorkflowState["workStatus"] : undefined,
    workStatusRunId:    typeof obj.workStatusRunId    === "string" ? obj.workStatusRunId    : undefined,
    workStatusSummary:  typeof obj.workStatusSummary  === "string" ? obj.workStatusSummary  : undefined,
    workStatusTests:    typeof obj.workStatusTests    === "string" ? obj.workStatusTests    : undefined,
    workStatusUpdatedAt: typeof obj.workStatusUpdatedAt === "string" ? obj.workStatusUpdatedAt : undefined,
    workStatusError: typeof obj.workStatusError  === "string" ? obj.workStatusError  : undefined,
    lastReviewNotes: typeof obj.lastReviewNotes  === "string" ? obj.lastReviewNotes : undefined,
    lastReviewStatus: typeof obj.lastReviewStatus === "string"
      ? (obj.lastReviewStatus as WorkflowState["lastReviewStatus"])
      : undefined,
    workBaselineRef: typeof obj.workBaselineRef === "string" ? obj.workBaselineRef : undefined,
    workBaselineUntracked: Array.isArray(obj.workBaselineUntracked)
      ? (obj.workBaselineUntracked as string[]).filter((p: any) => typeof p === "string")
      : undefined,
  };
}

/**
 * Load runtime state from the session-scoped path.
 * Normalizes the result so removed/unknown keys like planApproved are dropped.
 * Falls back to DEFAULT_STATE if the file is missing or corrupt.
 */
export function loadState(cwd: string, sessionKey: string): WorkflowState {
  ensureWorkflowDir(cwd);
  const spath = sessionStatePath(cwd, sessionKey);

  if (!fs.existsSync(spath)) {
    return { ...DEFAULT_STATE };
  }

  try {
    return normalizeState(JSON.parse(fs.readFileSync(spath, "utf8")));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Persist runtime state to the session-scoped path with normalization. */
export function saveState(cwd: string, sessionKey: string, state: WorkflowState): void {
  const spath = sessionStatePath(cwd, sessionKey);
  fs.mkdirSync(path.dirname(spath), { recursive: true });
  fs.writeFileSync(spath, JSON.stringify(normalizeState(state), null, 2), "utf8");
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

/** Remove the stale review file associated with the current plan, if it exists. */
export function removeStaleReviewFile(cwd: string, reviewPath: string): void {
  const file = path.join(cwd, reviewPath);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

/**
 * Update the existing plan file on disk with new content.
 * Uses atomic write (temp-file + rename) to prevent partial-write corruption.
 * Removes stale .review.md file and clears planReviewNotes from state.
 * planPath and planReviewPath remain unchanged.
 */
export function updatePlan(
  cwd: string,
  state: WorkflowState,
  content: string
): void {
  if (!state.planPath) {
    throw new Error("updatePlan requires state.planPath to be set");
  }

  const planAbs = path.join(cwd, state.planPath);

  // Atomic write: write to temp file in same directory, then rename
  // (renameSync is only atomic on the same filesystem, so we create the
  // temp file next to the target to avoid EXDEV errors)
  const tmpFile = path.join(path.dirname(planAbs), `.tmp-plan-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmpFile, content, "utf8");
  fs.renameSync(tmpFile, planAbs);

  // Remove stale review file if it exists
  if (state.planReviewPath) {
    removeStaleReviewFile(cwd, state.planReviewPath);
  }

  // Clear stale review notes from state
  state.planReviewNotes = undefined;
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
