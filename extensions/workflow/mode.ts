import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Mode, WorkflowConfig, WorkflowState } from "./types.js";
import { loadConfig, loadConfigForSession } from "./config.js";
import { modeLabel, modeStatusLabel } from "./helpers.js";
import { saveState, getSessionKey } from "./state.js";

// ── Workflow tool mode gating ─────────────────────────────────────────────

export const WORKFLOW_GATED_TOOLS = [
	"workflow_todo",
	"workflow_plan",
	"workflow_plan_review",
	"workflow_code_review",
] as const;

export const WORKFLOW_TOOL_CLEANUP_NAMES = [
	...WORKFLOW_GATED_TOOLS,
	"workflow_subagent",
] as const;

export function isWorkflowToolMode(mode: Mode): boolean {
	return mode === "plan" || mode === "work" || mode === "commit";
}

export function computeWorkflowToolNames(
	mode: Mode,
	config: WorkflowConfig,
): string[] {
	if (!isWorkflowToolMode(mode)) return [];

	const names = ["workflow_todo", "workflow_plan"];
	if (config.planReview.enabled) names.push("workflow_plan_review");
	if (config.codeReview.enabled) names.push("workflow_code_review");
	return names;
}

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
		// Resolve config with this session's override layer so /wf-settings
		// Session-scope model/thinking changes take effect immediately.
		const config = loadConfigForSession(
			ctx.cwd,
			getAgentDir(),
			getSessionKey(ctx.sessionManager),
		);
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

/**
 * Reconcile workflow tools for the current mode.
 * Explore/idle hide workflow tools; plan/work/commit enable the mode-allowed set.
 */
export function activateWorkflowToolsIfAllowed(
	pi: ExtensionAPI,
	cwd: string,
	getAgentDir: () => string,
	mode: Mode,
): void {
	try {
		const active = pi.getActiveTools().map((tool: any) => {
			if (typeof tool === "string") return tool;
			return tool.name;
		});

		const next = new Set(active);
		for (const toolName of WORKFLOW_TOOL_CLEANUP_NAMES) {
			next.delete(toolName);
		}

		let workflowToolNames: string[] = [];
		try {
			const cfg = loadConfig(cwd, getAgentDir());
			workflowToolNames = computeWorkflowToolNames(mode, cfg);
		} catch {
			// Preserve the core plan/work tools if config cannot be read.
			workflowToolNames = isWorkflowToolMode(mode)
				? ["workflow_todo", "workflow_plan"]
				: [];
		}
		for (const toolName of workflowToolNames) {
			next.add(toolName);
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
		activateWorkflowToolsIfAllowed(pi, ctx.cwd, getAgentDir, mode);
		return true;
	} catch {
		return false;
	}
}

// ── Workflow tool activation / deactivation ──────────────────────────────

/** All workflow tools that can be enabled in plan/work/commit modes. */
export const WORKFLOW_TOOL_NAMES = WORKFLOW_GATED_TOOLS;

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
		const workflowSet = new Set<string>(WORKFLOW_TOOL_NAMES);
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

interface WorkflowStatusContext {
	ui: {
		setStatus(key: string, value: string | undefined): void;
	};
}

/** Reflect the persisted workflow mode in the TUI status line. */
export function setWorkflowStatus(
	ctx: WorkflowStatusContext,
	mode: Mode,
): void {
	ctx.ui.setStatus(
		"lite-sp",
		mode === "idle" ? undefined : modeStatusLabel(mode),
	);
}

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
 * Persist mode, switch runtime (model / tools), update status, and sync the
 * current-turn guard cache in one atomic sequence. This is the single entry
 * point for workflow mode transitions.
 *
 * Persisted state — what future turns see on disk.
 * Runtime mode — the model, thinking level, and active tools.
 * Status line — reflects the persisted mode even when runtime setup fails.
 * Current-turn guard mode — controls write / edit / bash permissions for the
 * remainder of this turn.
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

	saveState(ctx.cwd, sessionKey, nextState);
	setWorkflowStatus(ctx, nextMode);
	if (nextMode === "idle") {
		clearCurrentTurnGuardMode(sessionKey);
	} else {
		setCurrentTurnGuardMode(sessionKey, nextMode);
	}

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

	return { ok: true, state: nextState };
}
