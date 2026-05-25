import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Mode } from "./types.js";
import { loadConfig } from "./config.js";
import { modeLabel } from "./helpers.js";

// ── Runtime mode switching ────────────────────────────────────────────────

/**
 * Switch the model to the one configured for the given role,
 * and apply thinking level. Does NOT write workflow state.
 */
export async function setRole(
  pi: ExtensionAPI,
  ctx: any,
  role: string,
  getAgentDir: () => string
): Promise<boolean> {
  try {
    const config = loadConfig(ctx.cwd, getAgentDir());
    const spec = config.models[role];

    if (!spec) {
      ctx.ui.notify(`找不到 role 配置：${role}`, "error");
      return false;
    }

    const model = ctx.modelRegistry.find(spec.provider, spec.model);
    if (!model) {
      ctx.ui.notify(`找不到模型：${spec.provider}/${spec.model}`, "error");
      return false;
    }

    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(
        `模型不可用或缺少 API key：${spec.provider}/${spec.model}`,
        "error"
      );
      return false;
    }

    if (spec.thinking) {
      pi.setThinkingLevel(spec.thinking);
    }

    return true;
  } catch (err: any) {
    ctx.ui.notify(`Runtime switch error: ${err.message ?? String(err)}`, "error");
    return false;
  }
}

/** Ensure workflow tools are active, including optional ask_user_question when available. */
export function ensureWorkflowToolsActive(pi: ExtensionAPI, cwd: string, getAgentDir: () => string): void {
  try {
    const active = pi.getActiveTools().map((tool: any) => {
      if (typeof tool === "string") return tool;
      return tool.name;
    });
  const next = new Set(active);
  next.add("workflow_todo");
  next.add("workflow_plan");
  next.add("workflow_subagent");
  next.add("workflow_status");

  try {
    const config = loadConfig(cwd, getAgentDir());
    if (config.askUserQuestion.enabled) {
      const allTools = pi.getAllTools();
      if (allTools.some((t: any) => t.name === config.askUserQuestion.toolName)) {
        next.add(config.askUserQuestion.toolName);
      }
    }
  } catch {
    // If config load or getAllTools fails, skip silently.
  }

    pi.setActiveTools([...next]);
  } catch {
    // If any part of tool activation fails, skip silently.
  }
}

/**
 * Apply runtime (model / thinking / tools / status) for a mode.
 * Does NOT write workflow state. State must be saved separately.
 */
export async function applyModeRuntime(
  pi: ExtensionAPI,
  ctx: any,
  mode: Mode,
  getAgentDir: () => string
): Promise<boolean> {
  const roleMap: Record<string, string> = {
    plan: "plan",
    planReview: "planReview",
    work: "work",
    fix: "work",
    review: "review",
    commit: "commit",
  };
  const role = roleMap[mode];
  try {
    if (role && !(await setRole(pi, ctx, role, getAgentDir))) return false;
    ensureWorkflowToolsActive(pi, ctx.cwd, getAgentDir);
    ctx.ui.setStatus("lite-sp", modeLabel(mode));
    return true;
  } catch {
    return false;
  }
}

// ── Runtime snapshot / restore ─────────────────────────────────────────────

/**
 * Best-effort snapshot of current runtime.
 *
 * Pi does NOT expose getModel() / getThinkingLevel() / getActiveTools().
 * Only setModel / setThinkingLevel / setActiveTools are write APIs.
 * Therefore captureRuntimeSnapshot only records the current mode label.
 *
 * Per the plan reviewer's guidance: "If current model/thinking/status cannot
 * be captured, the fallback should be clearly documented as 'restore to Plan
 * runtime/configured safe state,' not necessarily the exact previous runtime."
 */
export interface RuntimeSnapshot {
  /** The mode whose runtime was active before snapshot. */
  statusMode: Mode;
  /** Active tool names at snapshot time (pi.getActiveTools is readable). */
  activeTools: string[];
}

/**
 * Capture a best-effort snapshot of current runtime.
 * Pi does not expose structured "current model" or "current thinking" APIs,
 * only setModel / setThinkingLevel. We capture what we can.
 * Fallback: store the mode we intend to restore to.
 */
export function captureRuntimeSnapshot(
  pi: ExtensionAPI,
  currentMode: Mode
): RuntimeSnapshot {
  // Pi has no getModel/getThinkingLevel — only status mode and active tools are capturable.
  // restoreRuntimeSnapshot falls back to configured Plan runtime.
  let activeTools: string[] = [];
  try {
    activeTools = pi.getActiveTools().map((t: any) => (typeof t === "string" ? t : t.name));
  } catch {
    // getActiveTools may not be available in all contexts.
  }
  return { statusMode: currentMode, activeTools };
}

/**
 * Restore runtime from a previous snapshot.
 * Because Pi has no getModel / getThinkingLevel, we ALWAYS apply the
 * configured Plan runtime as a safe baseline, then set the UI status label
 * back to what the snapshot recorded.
 */
export async function restoreRuntimeSnapshot(
  pi: ExtensionAPI,
  ctx: any,
  snapshot: RuntimeSnapshot,
  getAgentDir: () => string
): Promise<void> {
  // Try to restore the snapshot's mode runtime first.
  // Only modes with a configured runtime role can be restored.
  const restorableRoles = new Set(["plan", "planReview", "work", "fix", "review", "commit"]);
  let ok = false;
  if (restorableRoles.has(snapshot.statusMode)) {
    try {
      ok = await applyModeRuntime(pi, ctx, snapshot.statusMode, getAgentDir);
    } catch {
      // fall through to Plan fallback
    }
  }
  // Plan fallback (always safe): restore to configured Plan runtime.
  if (!ok) {
    await applyModeRuntime(pi, ctx, "plan", getAgentDir);
  }
  // Restore snapshot's tool set on top of whatever runtime we landed on.
  if (snapshot.activeTools.length > 0) {
    try {
      const current = pi.getActiveTools().map((t: any) => (typeof t === "string" ? t : t.name));
      const needed = snapshot.activeTools.filter((n: string) => !current.includes(n));
      if (needed.length > 0) pi.setActiveTools([...current, ...needed]);
    } catch {
      // best effort
    }
  }
  // Status label matches the runtime we actually restored.
  ctx.ui.setStatus("lite-sp", ok ? modeLabel(snapshot.statusMode) : modeLabel("plan"));
}

// ── Per-turn in-memory guard helpers ───────────────────────────────────────

/**
 * In-memory per-session turn guard state.
 * NOT persisted to JSON state — lives only for the current Pi process.
 * Keyed by session key to avoid cross-session contamination.
 */
const guardModes = new Map<string, Mode>();
const invalidHandoffTurns = new Map<string, boolean>();

export function setCurrentTurnGuardMode(sessionKey: string, mode: Mode): void {
  guardModes.set(sessionKey, mode);
}

export function getCurrentTurnGuardMode(sessionKey: string): Mode | undefined {
  return guardModes.get(sessionKey);
}

export function clearCurrentTurnGuardMode(sessionKey: string): void {
  guardModes.delete(sessionKey);
}

export function setInvalidHandoffTurn(sessionKey: string, val: boolean): void {
  invalidHandoffTurns.set(sessionKey, val);
}

export function isInvalidHandoffTurn(sessionKey: string): boolean {
  return invalidHandoffTurns.get(sessionKey) === true;
}

export function clearInvalidHandoffTurn(sessionKey: string): void {
  invalidHandoffTurns.delete(sessionKey);
}
