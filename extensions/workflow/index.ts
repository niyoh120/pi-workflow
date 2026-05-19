/**
 * Pi Workflow Extension
 *
 * A lightweight software development workflow that layers planning,
 * plan review, implementation, code review, and commit phases on top
 * of pi-coding-agent. Supports pi install, global config merge, and
 * multi-plan document management under .pi/workflow/plan/.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { registerTodoTool, registerPlanTool } from "./tools.js";
import {
  registerPlanCommand,
  registerGoCommand,
  registerWorkCommand,
  registerReviewCommand,
  registerCommitCommand,
  registerWfStatusCommand,
  registerWfExitCommand,
  registerWfResetCommand,
  registerBeforeAgentStart,
  registerToolCallGuard,
  registerAgentEnd,
} from "./commands.js";

export default function (pi: ExtensionAPI) {
  // ── Tools ──────────────────────────────────
  registerTodoTool(pi, getAgentDir);
  registerPlanTool(pi, getAgentDir);

  // ── Commands ───────────────────────────────
  registerPlanCommand(pi, getAgentDir);
  registerGoCommand(pi, getAgentDir);
  registerWorkCommand(pi, getAgentDir);
  registerReviewCommand(pi, getAgentDir);
  registerCommitCommand(pi, getAgentDir);
  registerWfStatusCommand(pi, getAgentDir);
  registerWfExitCommand(pi);
  registerWfResetCommand(pi);

  // ── Lifecycle events ───────────────────────
  registerBeforeAgentStart(pi, getAgentDir);
  registerToolCallGuard(pi, getAgentDir);
  registerAgentEnd(pi, getAgentDir);
}
