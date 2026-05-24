/**
 * Pi Workflow Extension
 *
 * A lightweight software development workflow that layers plan,
 * plan review, implementation, code review, and commit phases on top
 * of pi-coding-agent. Supports pi install, global config merge, and
 * multi-plan document management under .pi/workflow/plan/.
 *
 * Subagents are powered by @tintinweb/pi-subagents (required).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createSubagentsClient, type SubagentsClient } from "./subagent.js";
import { loadState, getSessionKey } from "./state.js";
import { loadConfig } from "./config.js";
import {
  WorkflowTodoOverlay,
  setWorkflowOverlay,
  getWorkflowOverlay,
} from "./todo-overlay.js";

import {
  registerTodoTool,
  registerPlanTool,
  registerSubagentTool,
  registerWorkflowStatusTool,
} from "./tools.js";
import {
  registerPlanCommand,
  registerGoCommand,
  registerWorkCommand,
  registerReviewCommand,
  registerCommitCommand,
  registerWfStatusCommand,
  registerWfExitCommand,
  registerWfResetCommand,
  registerWfInitCommand,
  registerWfInstallSubagentsCommand,
  registerBeforeAgentStart,
  registerToolCallGuard,
  registerAgentEnd,
  setSubagentsClient,
} from "./commands.js";

export default function (pi: ExtensionAPI) {
  // ═══════════════════════════════════════════════════
  // Try to detect pi-subagents. It must be loaded as a
  // separate extension before pi-workflow.
  // ═══════════════════════════════════════════════════
  let subagentsClient: SubagentsClient = createSubagentsClient(pi);
  setSubagentsClient(subagentsClient);

  // ── Tools ──────────────────────────────────
  registerTodoTool(pi, getAgentDir);
  registerPlanTool(pi, getAgentDir);
  registerSubagentTool(pi, getAgentDir, () => subagentsClient);
  registerWorkflowStatusTool(pi, getAgentDir);

  // ── Commands ───────────────────────────────
  registerPlanCommand(pi, getAgentDir);
  registerGoCommand(pi, getAgentDir);
  registerWorkCommand(pi, getAgentDir);
  registerReviewCommand(pi, getAgentDir);
  registerCommitCommand(pi, getAgentDir);
  registerWfStatusCommand(pi, getAgentDir);
  registerWfExitCommand(pi);
  registerWfResetCommand(pi);
  registerWfInitCommand(pi);
  registerWfInstallSubagentsCommand(pi, getAgentDir);

  // ── Lifecycle events ───────────────────────
  registerBeforeAgentStart(pi, getAgentDir);
  registerToolCallGuard(pi, getAgentDir);
  registerAgentEnd(pi, getAgentDir);

  // ── Overlay lifecycle ──────────────────────
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const config = loadConfig(ctx.cwd, getAgentDir());
    if (!config.todoOverlay?.enabled) return;

    const sessionKey = getSessionKey(ctx.sessionManager);
    const state = loadState(ctx.cwd, sessionKey);

    let overlay = getWorkflowOverlay();
    if (!overlay) {
      overlay = new WorkflowTodoOverlay();
      setWorkflowOverlay(overlay);
    }
    overlay.setUICtx(ctx.ui);
    overlay.update(state.todos);
  });

  pi.on("session_shutdown", async () => {
    const overlay = getWorkflowOverlay();
    if (overlay) {
      overlay.dispose();
      setWorkflowOverlay(undefined);
    }
  });
}
