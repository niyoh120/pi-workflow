/**
 * Pi Workflow Extension
 *
 * A lightweight software development workflow with simplified mode flow:
 * idle → plan → work → commit.
 *
 * Plan review uses completeSimple sidecall (no subprocess).
 * Code review uses alibaba/open-code-review CLI.
 * No external extension dependency required.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
	registerPlanReviewTool,
	registerCodeReviewTool,
} from "./tools.js";

import {
	registerBeforeAgentStart,
	registerToolCallGuard,
	registerAgentEnd,
	registerPlanCommand,
	registerWorkCommand,
	registerReviewCommand,
	registerCommitCommand,
	registerWfStatusCommand,
	registerWfExitCommand,
	registerWfResetCommand,
	registerWfInitCommand,
} from "./commands.js";

export default function (pi: ExtensionAPI) {
	const config = loadConfig(process.cwd(), getAgentDir());

	// ── Tools ──────────────────────────────────
	registerTodoTool(pi, getAgentDir);
	registerPlanTool(pi, getAgentDir);
	if (config.planReview.enabled) registerPlanReviewTool(pi, getAgentDir);
	if (config.codeReview.enabled) registerCodeReviewTool(pi, getAgentDir);

	// ── Commands ───────────────────────────────
	registerPlanCommand(pi, getAgentDir);
	registerWorkCommand(pi, getAgentDir);
	if (config.codeReview.enabled) registerReviewCommand(pi, getAgentDir);
	registerCommitCommand(pi, getAgentDir);
	registerWfStatusCommand(pi, getAgentDir);
	registerWfExitCommand(pi);
	registerWfResetCommand(pi);
	registerWfInitCommand(pi);

	// ── Event handlers ─────────────────────────
	registerBeforeAgentStart(pi, getAgentDir);
	registerToolCallGuard(pi, getAgentDir);
	registerAgentEnd(pi, getAgentDir);

	// ── Overlay setup ──────────────────────────
	const overlay = new WorkflowTodoOverlay();
	setWorkflowOverlay(overlay);
}
