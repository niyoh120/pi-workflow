/**
 * Pi Workflow Extension
 *
 * A lightweight software development workflow with simplified mode flow:
 * idle → plan → work → commit.
 *
 * Plan review uses completeSimple sidecall (no subprocess).
 * Code review uses alibaba/open-code-review CLI.
 * No external extension dependency required.
 *
 * Workflow commands and tools are gated behind /wf by default.
 * Set config workflow.autoEnter = true to enable them on startup.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadState, getSessionKey } from "./state.js";
import { loadConfig, loadConfigIfTrusted } from "./config.js";
import { setWorkflowStatus } from "./mode.js";
import type { Mode } from "./types.js";
import { WorkflowTodoOverlay, setWorkflowOverlay } from "./todo-overlay.js";

import { registerAllWorkflowTools } from "./tools.js";

import { registerWfSettingsCommand } from "./settings.js";

import {
	registerAllWorkflowCommands,
	registerWfCommand,
	registerBeforeAgentStart,
	registerToolCallGuard,
	registerAgentEnd,
} from "./commands.js";

// ── Dynamic registration guard ──────────────────────

const _workflowRegistered = new WeakSet<ExtensionAPI>();

/**
 * Dynamically register workflow slash commands and tools.
 * Idempotent per ExtensionAPI instance — safe to call multiple times.
 */
function ensureWorkflowRegistered(
	pi: ExtensionAPI,
	getAgentDir: () => string,
	cwd: string,
): void {
	if (_workflowRegistered.has(pi)) return;

	registerAllWorkflowCommands(pi, getAgentDir, cwd);
	registerAllWorkflowTools(pi, getAgentDir, cwd);

	_workflowRegistered.add(pi);
}

function statusModeForSessionStart(mode: Mode): Mode {
	return mode === "idle" ? "explore" : mode;
}

function registerWorkflowSessionStartStatus(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			const sessionKey = getSessionKey({
				getSessionId: () => (ctx as any).sessionManager?.getSessionId?.(),
				getSessionFile: () =>
					(ctx as any).sessionManager?.getSessionFile?.() ?? null,
			});
			const state = loadState((ctx as any).cwd, sessionKey);
			// Use trust-aware config loading in session context
			const config = loadConfigIfTrusted(
				(ctx as any).cwd,
				getAgentDir(),
				ctx as any,
			);
			const workflowActive =
				(state.workflowEnabled || config.workflow.autoEnter) &&
				!state.workflowExplicitlyDisabled;

			setWorkflowStatus(
				ctx,
				workflowActive ? statusModeForSessionStart(state.mode) : "idle",
			);
		} catch {
			// Silently skip if session state/status cannot be read or applied.
		}
	});
}

// ── Main entry point ────────────────────────────────

export default function (pi: ExtensionAPI) {
	const config = loadConfig(process.cwd(), getAgentDir());

	// ── /wf and /wf-settings are always registered ──
	registerWfCommand(pi, getAgentDir);
	registerWfSettingsCommand(pi, getAgentDir);

	// ── Workflow commands/tools: conditional ──────
	if (config.workflow.autoEnter) {
		// Auto-enter: register immediately and show Explore status on session start.
		ensureWorkflowRegistered(pi, getAgentDir, process.cwd());
		registerWorkflowSessionStartStatus(pi, getAgentDir);
	} else {
		// Delayed registration: wait until /wf enables the session flag,
		// then register on the next session_start after reload.
		pi.on("session_start", async (_event, ctx) => {
			try {
				const sessionKey = getSessionKey({
					getSessionId: () => (ctx as any).sessionManager?.getSessionId?.(),
					getSessionFile: () =>
						(ctx as any).sessionManager?.getSessionFile?.() ?? null,
				});
				const state = loadState((ctx as any).cwd, sessionKey);
				if (state.workflowEnabled) {
					ensureWorkflowRegistered(pi, getAgentDir, (ctx as any).cwd);
				}
			} catch {
				// Silently skip if session state cannot be read.
			}
		});
		registerWorkflowSessionStartStatus(pi, getAgentDir);
	}

	// ── Event handlers (always registered) ────────
	registerBeforeAgentStart(pi, getAgentDir);
	registerToolCallGuard(pi, getAgentDir);
	registerAgentEnd(pi, getAgentDir);

	// ── Overlay setup ─────────────────────────────
	const overlay = new WorkflowTodoOverlay();
	setWorkflowOverlay(overlay);
}
