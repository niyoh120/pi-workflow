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
import { loadConfigForContext } from "./config.js";
import { applyModeRuntime, setWorkflowStatus, transitionWorkflowMode } from "./mode.js";
import { isWorkflowActive } from "./helpers.js";
import type { WorkflowState } from "./types.js";
import { WorkflowTodoOverlay, setWorkflowOverlay, getWorkflowOverlay } from "./todo-overlay.js";

import { registerAllWorkflowTools, ensureRpcAliasRegistered } from "./tools.js";

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
	ctx?: any,
): void {
	if (_workflowRegistered.has(pi)) return;

	registerAllWorkflowCommands(pi, getAgentDir, cwd);
	registerAllWorkflowTools(pi, getAgentDir, cwd, ctx);

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
			const config = loadConfigForContext(cwd, getAgentDir(), sessionKey, ctx as any);
			const workflowActive = isWorkflowActive(state, config);

			if (!workflowActive) {
				setWorkflowStatus(ctx, "idle");
				return;
			}

			ensureWorkflowRegistered(pi, getAgentDir, cwd, ctx);

			// RPC alias registration needs ctx.mode, which is undefined at factory
			// time. Register/update it here on every session_start so the
			// update_plan alias is available in RPC mode regardless of whether
			// workflow was auto-entered (factory-time registration) or enabled
			// via /wf. Idempotent: no-op when already owned and live.
			ensureRpcAliasRegistered(pi, getAgentDir, ctx);

			// TUI-only: bind the todo overlay UI context and refresh from state.
			// RPC/JSON/print cannot consume the component factory widget, so
			// overlay stays dormant there; todos remain visible via tool results.
			const overlay = getWorkflowOverlay();
			if (overlay && (ctx as any).mode === "tui") {
				overlay.setUICtx((ctx as any).ui);
				overlay.update(state.todos);
			}

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
	// Factory time has no Project Trust context. loadConfigForContext therefore
	// resolves default/global only and ignores session/project layers.
	const config = loadConfigForContext(process.cwd(), getAgentDir(), "", undefined);

	// ── /wf and /wf-settings are always registered ──
	registerWfCommand(pi, getAgentDir);
	registerWfSettingsCommand(pi, getAgentDir);

	// ── Workflow commands/tools: conditional ──────
	if (config.workflow.autoEnter) {
		// Global/default auto-enter registers definitions immediately. Trusted
		// project auto-enter is resolved in session_start once ctx is available;
		// the update_plan RPC alias is also registered there.
		ensureWorkflowRegistered(pi, getAgentDir, process.cwd(), undefined);
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

	// ── Overlay lifecycle ─────────────────────────
	// session_shutdown disposes the overlay so reload/session replacement
	// does not leak the old UI context or leave a stale widget registered.
	// Capture the instance in the closure so each pi disposes only the
	// overlay it created, not whatever is current at shutdown time (which
	// could belong to a newer ExtensionAPI instance after a rebind).
	pi.on("session_shutdown", () => {
		overlay.dispose();
	});
}
