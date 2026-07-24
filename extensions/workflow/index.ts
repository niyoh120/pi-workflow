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
import { applyModeRuntime, setWorkflowStatus, transitionWorkflowMode } from "./mode.js";
import type { WorkflowState } from "./types.js";
import { WorkflowTodoOverlay, setWorkflowOverlay } from "./todo-overlay.js";

import { registerAllWorkflowTools } from "./tools.js";

import { registerWfSettingsCommand } from "./settings.js";

import {
	registerAllWorkflowCommands,
	registerWfCommand,
	registerBeforeAgentStart,
	registerWorkflowContextInjection,
	registerPendingWorkDispatcher,
	runPendingWorkDispatcher,
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

/**
 * Single ordered session_start path for both auto-enter and delayed /wf paths.
 *
 * When workflow is active, register workflow commands/tools first, then apply
 * the current mode runtime (promote idle → explore through the unified
 * transition path, or restore the persisted mode). Registering before
 * synchronizing guarantees tools exist before setActiveTools runs, so the
 * first provider request builds its system prompt from the real tool set.
 */
function registerWorkflowSessionStart(
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
			const cwd = (ctx as any).cwd;
			const state: WorkflowState = loadState(cwd, sessionKey);
			const config = loadConfigIfTrusted(cwd, getAgentDir(), ctx as any);
			const workflowActive =
				(state.workflowEnabled || config.workflow.autoEnter) &&
				!state.workflowExplicitlyDisabled;

			if (!workflowActive) {
				setWorkflowStatus(ctx, "idle");
				return;
			}

			ensureWorkflowRegistered(pi, getAgentDir, cwd);

			// Promote idle → explore via the unified transition path so persisted
			// mode, status line, runtime, and guards stay aligned. Otherwise restore
			// the persisted mode runtime.
			if (state.mode === "idle") {
				const result = await transitionWorkflowMode({
					pi,
					ctx,
					sessionKey,
					nextState: { ...state, mode: "explore" },
					getAgentDir,
				});
				if (!result.ok) {
					console.error(
						`[workflow] session_start idle→explore transition failed: ${result.reason}`,
					);
				}
			} else {
				const runtimeOk = await applyModeRuntime(
					pi,
					ctx,
					state.mode,
					getAgentDir,
				);
				if (!runtimeOk) {
					console.error(
						`[workflow] session_start runtime apply failed for mode: ${state.mode}`,
					);
				}
				// applyModeRuntime does not touch the status line; mirror it here.
				setWorkflowStatus(ctx, state.mode);

				// Resume pending work kickoff after successful runtime restore.
				await runPendingWorkDispatcher(pi, ctx, getAgentDir);
			}
		} catch (err) {
			// Surface initialization failures (e.g. 0.81.x API drift) instead of
			// silently leaving workflow without tools or runtime.
			console.error(`[workflow] session_start initialization failed: ${err}`);
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
		// Auto-enter: register immediately so tools are available before the
		// first session_start fires.
		ensureWorkflowRegistered(pi, getAgentDir, process.cwd());
	}
	// Unified session_start path: register when /wf has enabled workflow,
	// apply runtime (tools/model) before the first prompt is built, and set
	// status. Runs for both auto-enter and delayed /wf reload/resume paths.
	registerWorkflowSessionStart(pi, getAgentDir);

	// ── Event handlers (always registered) ────────
	registerBeforeAgentStart(pi, getAgentDir);
	registerWorkflowContextInjection(pi, getAgentDir);
	registerPendingWorkDispatcher(pi, getAgentDir);
	registerToolCallGuard(pi, getAgentDir);
	registerAgentEnd(pi, getAgentDir);

	// ── Overlay setup ─────────────────────────────
	const overlay = new WorkflowTodoOverlay();
	setWorkflowOverlay(overlay);
}
