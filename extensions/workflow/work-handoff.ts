import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import { getSessionKey, loadState, saveState } from "./state.js";
import { loadConfig } from "./config.js";
import {
  captureRuntimeSnapshot,
  restoreRuntimeSnapshot,
  applyModeRuntime,
  getCurrentTurnGuardMode,
  setCurrentTurnGuardMode,
  setInvalidHandoffTurn,
  isInvalidHandoffTurn,
} from "./mode.js";
import type { WorkflowState } from "./types.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const PENDING_WORK_HANDOFF_TTL_MS = 5 * 60 * 1000;

/** Regex matching handoff markers like `[pi-workflow handoff:UUID]`. */
export const HANDOFF_MARKER_RE = /^\[pi-workflow handoff:[^\]]+\]/;

// ── Pending handoff creation / cleanup ─────────────────────────────────────

export function createPendingWorkHandoff(
  state: WorkflowState,
  now = Date.now()
): NonNullable<WorkflowState["pendingWorkHandoff"]> {
  const handoffId = crypto.randomUUID();
  const marker = `[pi-workflow handoff:${handoffId}]`;
  const workRunId = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PENDING_WORK_HANDOFF_TTL_MS).toISOString();
  const planPath = state.planPath ?? "当前计划文件";
  const expectedPrompt = `${marker} 按已确认计划实现。计划文件：${planPath}。请先读取计划和 workflow_todo，然后按 todo 顺序执行。`;

  return {
    id: handoffId,
    marker,
    planPath: state.planPath ?? "",
    planRunId: state.planRunId,
    workRunId,
    createdAt,
    expiresAt,
    expectedPrompt,
  };
}

export function clearPendingWorkHandoff(state: WorkflowState): void {
  state.pendingWorkHandoff = undefined;
}

export function isPendingWorkHandoffValid(
  state: WorkflowState,
  eventPrompt: string,
  now = Date.now()
): string | null {
  const pending = state.pendingWorkHandoff;
  if (!pending) return "No pending handoff.";

  // Pending is only valid when the durable mode is workPending.
  // Safety branches set mode=plan in-memory before trying saveState;
  // if the save fails and disk still shows workPending, this guard
  // still rejects because the in-memory state object has mode=plan.
  if (state.mode !== "workPending") {
    return `State mode is ${state.mode}, expected workPending.`;
  }

  // Validate against current state (not just pending self-fields).
  if (pending.planPath !== state.planPath) {
    return `Pending planPath (${pending.planPath}) does not match current (${state.planPath}).`;
  }
  if (pending.planRunId !== state.planRunId) {
    return `Pending planRunId (${pending.planRunId}) does not match current (${state.planRunId}).`;
  }
  if (!pending.workRunId) {
    return "Pending workRunId is missing.";
  }

  // Check expiry.
  if (now > new Date(pending.expiresAt).getTime()) {
    return `Pending handoff expired at ${pending.expiresAt}.`;
  }

  // Check prompt match.
  if (eventPrompt !== pending.expectedPrompt) {
    return `Event prompt does not match expectedPrompt.`;
  }

  return null; // valid
}

// ── Building prompts ───────────────────────────────────────────────────────

export function buildWorkKickoff(planPath: string): string {
  return `按已确认计划实现。计划文件：${planPath}。请先读取计划和 workflow_todo，然后按 todo 顺序执行。`;
}

export function buildInvalidHandoffSafetyPrompt(reason: string): string {
  return `⚠️ 计划自动切换到 Work Mode 失败：${reason}\n当前任务已取消。请检查工作流状态（/wf-status），或重新开始 /plan。当前 turn 为安全只读模式，禁止修改文件。`;
}

// ── Tool approve path ──────────────────────────────────────────────────────

/**
 * Queue approved work from tool execution context (workflow_plan approve).
 * Sends bound kickoff follow-up during current Plan turn's tool execution phase,
 * then saves state as workPending.
 */
export async function queueApprovedWorkFromTool(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string
): Promise<{ success: boolean; error?: string; handoffId?: string; workRunId?: string }> {
  const sessionKey = getSessionKey(ctx.sessionManager);
  const state = loadState(ctx.cwd, sessionKey);
  const config = loadConfig(ctx.cwd, getAgentDir());

  // Context validation.
  if (state.mode !== "plan") {
    return { success: false, error: "Approve only allowed in Plan Mode." };
  }
  const guardMode = getCurrentTurnGuardMode(sessionKey);
  if (guardMode !== "plan") {
    return { success: false, error: "Approve only allowed in Plan turn context." };
  }

  if (!state.planPath) {
    return { success: false, error: "No active plan. Save a plan first." };
  }

  if (config.planReview.enabled && state.planReviewStatus !== "pass") {
    return {
      success: false,
      error: `Plan review is enabled but status is ${state.planReviewStatus}. Wait for review_pass, revise the plan, or use /go --force manually.`,
    };
  }

  if (state.pendingWorkHandoff) {
    return { success: false, error: "Work handoff is already pending." };
  }

  // Block approve in invalid handoff turns.
  if (isInvalidHandoffTurn(sessionKey)) {
    return { success: false, error: "Handoff 已失效，在当前 turn 中不能再次批准计划。" };
  }

  // Create pending handoff.
  const pending = createPendingWorkHandoff(state);

  // Send followUp first (so if it fails, we don't save pending).
  try {
    pi.sendUserMessage(pending.expectedPrompt, { deliverAs: "followUp" });
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to queue work kickoff: ${err.message ?? String(err)}`,
    };
  }

  // Only save after send succeeds.
  state.mode = "workPending";
  state.planApproved = true;
  state.pendingWorkHandoff = pending;
  try {
    saveState(ctx.cwd, sessionKey, state);
  } catch (err: any) {
    // Save failed after send succeeded — rollback in-memory state.
    state.mode = "plan";
    state.planApproved = false;
    clearPendingWorkHandoff(state);
    return {
      success: false,
      error: `Failed to persist workPending state: ${err.message ?? String(err)}`,
    };
  }

  return {
    success: true,
    handoffId: pending.id,
    workRunId: pending.workRunId,
  };
}

// ── before_agent_start handoff handler ─────────────────────────────────────

export interface BeforeAgentStartResult {
  /** System prompt to inject, or undefined to leave unchanged. */
  systemPrompt?: string;
  /** Effective guard mode for this turn. */
  guardMode: NonNullable<ReturnType<typeof getCurrentTurnGuardMode>>;
}

/**
 * Handle before_agent_start handoff detection and finalization.
 * Must be called before any other before_agent_start logic.
 * Returns the effective guard mode and optional safety/Work system prompt.
 */
export async function handleWorkPendingBeforeAgentStart(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string,
  event: any
): Promise<BeforeAgentStartResult> {
  const sessionKey = getSessionKey(ctx.sessionManager);
  const state = loadState(ctx.cwd, sessionKey);
  const eventPrompt: string = event.prompt ?? "";

  const isMarkerPrompt = HANDOFF_MARKER_RE.test(eventPrompt);

  // ── Marker prompt branch ──
  if (isMarkerPrompt) {
    // Valid pending + matching prompt + runtime success → finalize Work.
    if (
      state.mode === "workPending" &&
      state.pendingWorkHandoff &&
      !isPendingWorkHandoffValid(state, eventPrompt)
    ) {
      // Attempt runtime switch.
      const pending = state.pendingWorkHandoff!;
      const runtimeOk = await applyModeRuntime(pi, ctx, "work", getAgentDir);

      if (!runtimeOk) {
        // Runtime switch failed — safety branch.
        clearPendingWorkHandoff(state);
        state.mode = "plan";
        state.planApproved = false;
        try { saveState(ctx.cwd, sessionKey, state); } catch { /* ok */ }

        setCurrentTurnGuardMode(sessionKey, "plan");
        setInvalidHandoffTurn(sessionKey, true);

        // Restore Plan runtime.
        try {
          await applyModeRuntime(pi, ctx, "plan", getAgentDir);
        } catch {
          // best effort
        }

        return {
          systemPrompt: buildInvalidHandoffSafetyPrompt(
            `Work Mode model/tools 切换失败。当前 plan review status: ${state.planReviewStatus}`
          ),
          guardMode: "plan",
        };
      }

      // Runtime OK — save Work state.
      // Snapshot original state for clean rollback on save failure.
      const preFinalizeState = { ...state };
      try {
        state.mode = "work";
        state.autoCodeReview = true;
        state.codeReviewLoops = 0;
        state.workRunId = pending.workRunId;
        state.workStatus = undefined;
        state.workStatusRunId = undefined;
        state.workStatusSummary = undefined;
        state.workStatusTests = undefined;
        state.workStatusError = undefined;
        state.workStatusUpdatedAt = undefined;
        clearPendingWorkHandoff(state);
        saveState(ctx.cwd, sessionKey, state);

        setCurrentTurnGuardMode(sessionKey, "work");
        return { guardMode: "work" };
      } catch (err: any) {
        // Save state failed — restore original safe state (NOT workPending).
        clearPendingWorkHandoff(state);
        Object.assign(state, preFinalizeState);
        state.mode = "plan";
        state.planApproved = false;
        state.pendingWorkHandoff = undefined;
        try { saveState(ctx.cwd, sessionKey, state); } catch { /* ok */ }

        setCurrentTurnGuardMode(sessionKey, "plan");
        setInvalidHandoffTurn(sessionKey, true);

        const snapshot = captureRuntimeSnapshot(pi, "plan");
        try {
          await restoreRuntimeSnapshot(pi, ctx, snapshot, getAgentDir);
        } catch {
          // best effort
        }

        return {
          systemPrompt: buildInvalidHandoffSafetyPrompt(
            `Work state 保存失败：${err.message ?? String(err)}`
          ),
          guardMode: "plan",
        };
      }
    }

    // Marker prompt but invalid pending / non-workPending state.
    const invalidReason =
      (state.pendingWorkHandoff
        ? isPendingWorkHandoffValid(state, eventPrompt)
        : "No pending handoff.") ?? "Unknown reason.";

    // Always restore Plan runtime first, before mutating state.
    try {
      await applyModeRuntime(pi, ctx, "plan", getAgentDir);
    } catch {
      // best effort
    }

    clearPendingWorkHandoff(state);
    state.mode = "plan";
    state.planApproved = false;
    try { saveState(ctx.cwd, sessionKey, state); } catch { /* ok */ }

    setCurrentTurnGuardMode(sessionKey, "plan");
    setInvalidHandoffTurn(sessionKey, true);

    return {
      systemPrompt: buildInvalidHandoffSafetyPrompt(invalidReason),
      guardMode: "plan",
    };
  }

  // ── Non-marker prompt branch ──

  // If we're in workPending but user input is non-marker → user interrupted.
  if (state.mode === "workPending") {
    clearPendingWorkHandoff(state);
    state.mode = "plan";
    state.planApproved = false;
    try { saveState(ctx.cwd, sessionKey, state); } catch { /* ok */ }
    setCurrentTurnGuardMode(sessionKey, "plan");
    setInvalidHandoffTurn(sessionKey, true);
    return {
      systemPrompt: buildInvalidHandoffSafetyPrompt(
        "收到非 handoff 用户输入，pending 已取消。"
      ),
      guardMode: "plan",
    };
  }

  // Normal non-pending turn — set guard to current state mode.
  const guard = state.mode;
  setCurrentTurnGuardMode(sessionKey, guard);
  return { guardMode: guard };
}

// ── Command direct start path (/go) ────────────────────────────────────────

/**
 * Start approved work directly from a command handler context (/go).
 * Assumes ctx.waitForIdle() has already been called.
 * Handles runtime/state/send failure rollback.
 */
export async function startApprovedWorkFromCommand(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string,
  force = false
): Promise<{ success: boolean; error?: string; workRunId?: string }> {
  const sessionKey = getSessionKey(ctx.sessionManager);
  const state = loadState(ctx.cwd, sessionKey);
  const config = loadConfig(ctx.cwd, getAgentDir());

  if (!state.planPath) {
    return { success: false, error: "No active plan. Save a plan first." };
  }

  if (config.planReview.enabled && state.planReviewStatus !== "pass" && !force) {
    return {
      success: false,
      error: `Plan review status is ${state.planReviewStatus}. Use /go --force to skip.`,
    };
  }

  // Snapshot original state and runtime.
  const originalState = { ...state };
  const originalSnapshot = captureRuntimeSnapshot(pi, state.mode as any);

  const workRunId = crypto.randomUUID();

  // Apply Work runtime.
  const runtimeOk = await applyModeRuntime(pi, ctx, "work", getAgentDir);
  if (!runtimeOk) {
    // Rollback any partial runtime changes.
    try { await restoreRuntimeSnapshot(pi, ctx, originalSnapshot, getAgentDir); } catch { /* ok */ }
    return { success: false, error: "Work Mode model/tools 切换失败。" };
  }

  // Save Work state.
  try {
    state.mode = "work";
    state.autoCodeReview = true;
    state.codeReviewLoops = 0;
    state.workStatus = undefined;
    state.workStatusRunId = undefined;
    state.workStatusSummary = undefined;
    state.workStatusTests = undefined;
    state.workStatusError = undefined;
    state.workStatusUpdatedAt = undefined;
    state.workRunId = workRunId;
    state.planApproved = true;
    clearPendingWorkHandoff(state);
    saveState(ctx.cwd, sessionKey, state);
  } catch (err: any) {
    // Rollback runtime.
    try {
      await restoreRuntimeSnapshot(pi, ctx, originalSnapshot, getAgentDir);
    } catch {
      // best effort
    }
    // Restore original state — replace entire object so stale new fields (workRunId etc.)
    // are not left behind after a failed Work start.
    const restored = { ...originalState, mode: originalState.mode };
    try {
      saveState(ctx.cwd, sessionKey, restored as WorkflowState);
    } catch {
      // ok
    }
    return {
      success: false,
      error: `Work state 保存失败：${err.message ?? String(err)}`,
    };
  }

  // Send kickoff.
  const kickoff = buildWorkKickoff(state.planPath ?? "当前计划文件");
  try {
    pi.sendUserMessage(kickoff);
  } catch (err: any) {
    // Rollback state + runtime.
    try {
      await restoreRuntimeSnapshot(pi, ctx, originalSnapshot, getAgentDir);
    } catch {
      // best effort
    }
    const restored2 = { ...originalState, mode: originalState.mode };
    try {
      saveState(ctx.cwd, sessionKey, restored2 as WorkflowState);
    } catch {
      // ok
    }
    return {
      success: false,
      error: `Failed to send work kickoff: ${err.message ?? String(err)}`,
    };
  }

  return { success: true, workRunId };
}
