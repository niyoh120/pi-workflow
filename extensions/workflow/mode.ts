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
    const spec = config.models[role as keyof typeof config.models];

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

/** Activate workflow tools when the current agent allows them.
 *  Skips when the current agent has already excluded workflow_todo
 *  (e.g. review subagents that block workflow tools via disallowed_tools). */
export function activateWorkflowToolsIfAllowed(pi: ExtensionAPI, cwd: string, getAgentDir: () => string): void {
  try {
    const active = pi.getActiveTools().map((tool: any) => {
      if (typeof tool === "string") return tool;
      return tool.name;
    });

    // Guard: if the agent already excludes workflow_todo, it is a restricted
    // agent — do NOT re-add workflow tools.
    if (!active.includes("workflow_todo")) return;

    const next = new Set(active);
    next.add("workflow_todo");
    next.add("workflow_plan");
    next.add("workflow_subagent");
    next.add("workflow_code_review");

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
  // Simplified role mapping: plan→plan, work→work, commit→commit
  const roleMap: Record<string, string> = {
    idle: "plan",   // idle uses plan model as default
    plan: "plan",
    work: "work",
    commit: "commit",
  };
  const role = roleMap[mode];
  try {
    if (role && !(await setRole(pi, ctx, role, getAgentDir))) return false;
    activateWorkflowToolsIfAllowed(pi, ctx.cwd, getAgentDir);
    ctx.ui.setStatus("lite-sp", modeLabel(mode));
    return true;
  } catch {
    return false;
  }
}

// ── Per-turn in-memory guard helpers ───────────────────────────────────────

/**
 * In-memory per-session turn guard state.
 * NOT persisted to JSON state — lives only for the current Pi process.
 * Keyed by session key to avoid cross-session contamination.
 */
const guardModes = new Map<string, Mode>();

export function setCurrentTurnGuardMode(sessionKey: string, mode: Mode): void {
  guardModes.set(sessionKey, mode);
}

export function getCurrentTurnGuardMode(sessionKey: string): Mode | undefined {
  return guardModes.get(sessionKey);
}

export function clearCurrentTurnGuardMode(sessionKey: string): void {
  guardModes.delete(sessionKey);
}