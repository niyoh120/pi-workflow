/**
 * Pi Workflow Extension
 *
 * A lightweight software development workflow that layers plan,
 * plan review, implementation, code review, and commit phases on top
 * of pi-coding-agent. Supports pi install, global config merge, and
 * multi-plan document management under .pi/workflow/plan/.
 *
 * When PI_WORKFLOW_SUBAGENT is set, enters child-safe mode:
 * only registers a minimal readonly guard, skipping all workflow
 * tools, commands, state machine, and prompt injection.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  registerTodoTool,
  registerPlanTool,
  registerSubagentTool,
  registerReadonlyGuard,
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
  registerBeforeAgentStart,
  registerToolCallGuard,
  registerAgentEnd,
} from "./commands.js";

export default function (pi: ExtensionAPI) {
  // ═══════════════════════════════════════════════════
  // Child-safe mode: PI_WORKFLOW_SUBAGENT is set.
  // Only register the minimal readonly guard.
  // Do NOT register workflow tools, commands, hooks,
  //   agent_end state machine, prompt injection, or
  //   the workflow_subagent tool itself.
  // ═══════════════════════════════════════════════════
  const subagentEnv = process.env.PI_WORKFLOW_SUBAGENT;
  if (subagentEnv) {
    registerReadonlyGuard(pi);
    return;
  }

  // ═══════════════════════════════════════════════════
  // Normal (parent) mode: full workflow
  // ═══════════════════════════════════════════════════

  // ── Tools ──────────────────────────────────
  registerTodoTool(pi, getAgentDir);
  registerPlanTool(pi, getAgentDir);
  registerSubagentTool(pi, getAgentDir);

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

  // ── Lifecycle events ───────────────────────
  registerBeforeAgentStart(pi, getAgentDir);
  registerToolCallGuard(pi, getAgentDir);
  registerAgentEnd(pi, getAgentDir);
}
