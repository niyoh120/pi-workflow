import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Mode, WorkflowState } from "./types.js";
import { loadConfig } from "./config.js";
import { modeLabel } from "./helpers.js";
import { saveState } from "./state.js";

// ── Runtime mode switching ────────────────────────────────────────────────

/**
 * Switch the model to the one configured for the given role,
 * and apply thinking level. Does NOT write workflow state.
 */
export async function setRole(
	pi: ExtensionAPI,
	ctx: any,
	role: string,
	getAgentDir: () => string,
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
				"error",
			);
			return false;
		}

		if (spec.thinking) {
			pi.setThinkingLevel(spec.thinking);
		}

		return true;
	} catch (err: any) {
		ctx.ui.notify(
			`Runtime switch error: ${err.message ?? String(err)}`,
			"error",
		);
		return false;
	}
}

/** Activate workflow tools when the current agent allows them.
 *  Skips when the current agent has already excluded workflow_todo
 *  (e.g. review subagents that block workflow tools via disallowed_tools). */
export function activateWorkflowToolsIfAllowed(
	pi: ExtensionAPI,
	cwd: string,
	getAgentDir: () => string,
): void {
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

		// Conditionally activate review tools based on config.
		// Always remove first, then re-add — so a config change to false takes effect.
		try {
			const cfg = loadConfig(cwd, getAgentDir());
			next.delete("workflow_subagent"); // old tool name, no longer registered
			next.delete("workflow_plan_review");
			next.delete("workflow_code_review");
			if (cfg.planReview.enabled) next.add("workflow_plan_review");
			if (cfg.codeReview.enabled) next.add("workflow_code_review");
		} catch {
			// If config load fails, skip review tool activation.
		}

		// Auto-activate ask_user_question if the tool is installed (tool-name existence check only).
		try {
			const allTools = pi.getAllTools();
			if (allTools.some((t: any) => t.name === "ask_user_question")) {
				next.add("ask_user_question");
			}
		} catch {
			// If getAllTools fails, skip silently.
		}

		pi.setActiveTools([...next]);
	} catch {
		// If any part of tool activation fails, skip silently.
	}
}

/**
 * Apply runtime (model / thinking / tools / status) for a mode.
 * Does NOT write workflow state or update current-turn guard state.
 * Prefer transitionWorkflowMode() for workflow mode transitions.
 */
export async function applyModeRuntime(
	pi: ExtensionAPI,
	ctx: any,
	mode: Mode,
	getAgentDir: () => string,
): Promise<boolean> {
	// Simplified role mapping: plan→plan, work→work, commit→commit
	const roleMap: Record<string, string> = {
		explore: "explore",
		idle: "explore", // idle uses explore model as default
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

// ── Workflow tool activation / deactivation ──────────────────────────────

/** All workflow tools that get enabled when workflow mode is active. */
export const WORKFLOW_TOOL_NAMES = [
	"workflow_todo",
	"workflow_plan",
	"workflow_plan_review",
	"workflow_code_review",
];

/**
 * Remove all workflow tool names from the active tool set.
 * Used by /wf-exit to ensure the next reload starts clean.
 */
export function deactivateWorkflowTools(pi: ExtensionAPI): void {
	try {
		const active = pi.getActiveTools().map((tool: any) => {
			if (typeof tool === "string") return tool;
			return tool.name;
		});
		const workflowSet = new Set(WORKFLOW_TOOL_NAMES);
		const next = active.filter((t: string) => !workflowSet.has(t));
		if (next.length < active.length) {
			pi.setActiveTools(next);
		}
	} catch {
		// Silently ignore if tool introspection fails.
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

// ── Unified mode transition ──────────────────────────────────────────────────

export type WorkflowModeTransitionResult =
	| { ok: true; state: WorkflowState }
	| { ok: false; state: WorkflowState; reason: string };

export interface WorkflowModeTransitionOptions {
	pi: ExtensionAPI;
	ctx: any;
	sessionKey: string;
	nextState: WorkflowState;
	getAgentDir: () => string;
	/**
	 * Set false for teardown/reset paths that intentionally leave normal Pi runtime.
	 */
	applyRuntime?: boolean;
}

/**
 * Persist mode, switch runtime (model / tools / status), and sync the current-turn
 * guard cache in one atomic sequence. This is the single entry point for any
 * workflow mode change so that the three layers (persisted state, runtime, and
 * tool-call guard) never diverge.
 *
 * Persisted state — what future turns see on disk.
 * Runtime mode — the model, thinking level, active tools, and TUI status bar.
 * Current-turn guard mode — controls write / edit / bash permissions for the
 * remainder of this turn.
 *
 * On runtime failure the persisted state is NOT written, so rollback is implicit.
 */
export async function transitionWorkflowMode({
	pi,
	ctx,
	sessionKey,
	nextState,
	getAgentDir,
	applyRuntime: shouldApplyRuntime = true,
}: WorkflowModeTransitionOptions): Promise<WorkflowModeTransitionResult> {
	const nextMode = nextState.mode;

	if (shouldApplyRuntime) {
		const runtimeApplied = await applyModeRuntime(
			pi,
			ctx,
			nextMode,
			getAgentDir,
		);
		if (!runtimeApplied) {
			return {
				ok: false,
				state: nextState,
				reason: `${modeLabel(nextMode)} runtime failed to activate.`,
			};
		}
	}

	saveState(ctx.cwd, sessionKey, nextState);
	if (nextMode === "idle") {
		clearCurrentTurnGuardMode(sessionKey);
	} else {
		setCurrentTurnGuardMode(sessionKey, nextMode);
	}

	return { ok: true, state: nextState };
}
