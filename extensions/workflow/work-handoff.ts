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
import { createWorkBaseline, captureBaselineUntracked } from "./baseline.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const PENDING_WORK_HANDOFF_TTL_MS = 5 * 60 * 1000;

/** Unanchored regex matching handoff markers like `[pi-workflow handoff:UUID]` anywhere in prompt text.
 *  Capture group 1 extracts the UUID portion for precise matching against pending.marker. */
export const HANDOFF_MARKER_RE = /\[pi-workflow handoff:([^\]]+)\]/;

/** Extract the first handoff marker from a prompt string.
 *  Returns the full marker string `[pi-workflow handoff:UUID]` if found, or null if not.
 *  Used by isPendingWorkHandoffValid to compare against `pending.marker` —
 *  no longer requires exact full-prompt matching. */
export function extractHandoffMarker(prompt: string): string | null {
  const match = HANDOFF_MARKER_RE.exec(prompt);
  if (!match) return null;
  // Return the full marker string including brackets, not just the UUID.
  return `[pi-workflow handoff:${match[1]}]`;
}

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

  // Check marker presence: extract marker from prompt and compare with pending.marker.
  // No longer requires exact full-prompt matching (expectedPrompt) — only marker identity.
  const extractedMarker = extractHandoffMarker(eventPrompt);
  if (!extractedMarker) {
    return `No handoff marker found in event prompt.`;
  }
  if (extractedMarker !== pending.marker) {
    return `Extracted marker (${extractedMarker}) does not match pending.marker (${pending.marker}).`;
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
  state.pendingWorkHandoff = pending;
  try {
    saveState(ctx.cwd, sessionKey, state);
  } catch (err: any) {
    // Save failed after send succeeded — rollback in-memory state.
    state.mode = "plan";
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
  /** Current in-memory state after handoff processing, including fallback mutations. */
  state: WorkflowState;
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
    const handoffInvalidReason = isPendingWorkHandoffValid(state, eventPrompt);
    if (
      state.mode === "workPending" &&
      state.pendingWorkHandoff &&
      handoffInvalidReason === null
    ) {
      // Attempt runtime switch.
      const pending = state.pendingWorkHandoff!;
      const runtimeOk = await applyModeRuntime(pi, ctx, "work", getAgentDir);

      if (!runtimeOk) {
        // Runtime switch failed — safety branch.
        clearPendingWorkHandoff(state);
        state.mode = "plan";
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
          state,
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
        state.workBaselineRef = createWorkBaseline(ctx.cwd);
        state.workBaselineUntracked = captureBaselineUntracked(ctx.cwd);
        state.workStatus = undefined;
        state.workStatusRunId = undefined;
        state.workStatusSummary = undefined;
        state.workStatusTests = undefined;
        state.workStatusError = undefined;
        state.workStatusUpdatedAt = undefined;
        state.lastReviewNotes = undefined;
        state.lastReviewStatus = undefined;
        clearPendingWorkHandoff(state);
        saveState(ctx.cwd, sessionKey, state);

        setCurrentTurnGuardMode(sessionKey, "work");
        return { guardMode: "work", state };
      } catch (err: any) {
        // Save state failed — restore original safe state (NOT workPending).
        clearPendingWorkHandoff(state);
        Object.assign(state, preFinalizeState);
        state.mode = "plan";
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
          state,
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
    try { saveState(ctx.cwd, sessionKey, state); } catch { /* ok */ }

    setCurrentTurnGuardMode(sessionKey, "plan");
    setInvalidHandoffTurn(sessionKey, true);

    return {
      systemPrompt: buildInvalidHandoffSafetyPrompt(invalidReason),
      guardMode: "plan",
      state,
    };
  }

  // ── Non-marker prompt branch ──

  // If we're in workPending but user input is non-marker:
  //   - If handoff is expired → clear it, revert to plan
  //   - If handoff is still valid (just waiting for marker) → preserve it,
  //     inject safety prompt, and let user continue in plan-read-only mode.
  //     The marker may arrive in a subsequent turn via the followUp mechanism.
  if (state.mode === "workPending") {
    const pending = state.pendingWorkHandoff;
    const isExpired = pending && Date.now() > new Date(pending.expiresAt).getTime();

    if (isExpired) {
      // TTL expired → clear stale handoff, revert to plan mode.
      clearPendingWorkHandoff(state);
      state.mode = "plan";
      try { saveState(ctx.cwd, sessionKey, state); } catch { /* ok */ }
      setCurrentTurnGuardMode(sessionKey, "plan");
      setInvalidHandoffTurn(sessionKey, true);
      return {
        systemPrompt: buildInvalidHandoffSafetyPrompt(
          "Handoff 已过期（超过 5 分钟），pending 已取消。请 /wf-status 查看状态或 /wf-reset 清理。"
        ),
        guardMode: "plan",
        state,
      };
    }

    // Handoff still valid (not expired) but marker not yet received.
    // Preserve handoff — the followUp marker may arrive in a subsequent turn.
    // Set plan guard mode for this turn (read-only), inject waiting prompt.
    setCurrentTurnGuardMode(sessionKey, "plan");
    return {
      systemPrompt:
        `⚠️ Work Mode handoff 已排队，等待 followUp marker 到达。当前 turn 为 Plan Mode 只读。\n` +
        `如需强制执行，使用 /go --force；如需取消，使用 /wf-reset。`,
      guardMode: "plan",
      state,
    };
  }

  // Normal non-pending turn — set guard to current state mode.
  const guard = state.mode;
  setCurrentTurnGuardMode(sessionKey, guard);
  return { guardMode: guard, state };
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
  force = false,
  noReview = false
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
    state.autoCodeReview = !noReview;
    state.codeReviewLoops = 0;
    state.workBaselineRef = createWorkBaseline(ctx.cwd);
    state.workBaselineUntracked = captureBaselineUntracked(ctx.cwd);
    state.workStatus = undefined;
    state.workStatusRunId = undefined;
    state.workStatusSummary = undefined;
    state.workStatusTests = undefined;
    state.workStatusError = undefined;
    state.workStatusUpdatedAt = undefined;
    state.lastReviewNotes = undefined;
    state.lastReviewStatus = undefined;
    state.workRunId = workRunId;
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
