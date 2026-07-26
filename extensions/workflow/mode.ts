import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mode, WorkflowConfig, WorkflowState } from "./types.js";
import { loadConfigForContext } from "./config.js";
import { assertNever, modeLabel, modeStatusLabel } from "./helpers.js";
import { isAliasOwned, isAliasRegistered, UPDATE_PLAN_TOOL_NAME } from "./todo-compat.js";
import { saveState, getSessionKey } from "./state.js";

// ── Workflow tool mode gating ─────────────────────────────────────────────────

export const WORKFLOW_GATED_TOOLS = [
	"workflow_todo",
	"workflow_plan_read",
	"workflow_plan_save",
	"workflow_plan_approve",
	"workflow_plan_clear",
	"workflow_grill_record",
	"workflow_plan_review",
	"workflow_code_review",
	"workflow_init_complete",
] as const;

export const WORKFLOW_TOOL_CLEANUP_NAMES = [...WORKFLOW_GATED_TOOLS] as const;

/**
 * Workflow-owned tool names for the current ExtensionAPI instance. The
 * update_plan alias is included only while its live sourceInfo fingerprint
 * proves ownership, preserving an external tool with the same name.
 */
export function workflowManagedToolNames(pi: ExtensionAPI): Set<string> {
	const names = new Set<string>(WORKFLOW_TOOL_CLEANUP_NAMES);
	if (isAliasOwned(pi)) names.add(UPDATE_PLAN_TOOL_NAME);
	return names;
}

const PLAN_WORKFLOW_TOOL_NAMES = [
	"workflow_todo",
	"workflow_plan_read",
	"workflow_plan_save",
	"workflow_plan_approve",
	"workflow_plan_clear",
	"workflow_grill_record",
];

const WORK_WORKFLOW_TOOL_NAMES = ["workflow_todo", "workflow_plan_read"];

const EXPLORE_WORKFLOW_TOOL_NAMES = ["workflow_plan_read"];

const INIT_WORKFLOW_TOOL_NAMES = ["workflow_init_complete"];

/**
 * Modes that may call gated workflow tools. Each mode's allowed set is
 * resolved by computeWorkflowToolNames; explore exposes only the read-only
 * workflow_plan_read so a preserved plan can be inspected.
 */
export function isWorkflowToolMode(mode: Mode): boolean {
	return mode === "plan" || mode === "work" || mode === "init" || mode === "explore";
}

/**
 * Swap workflow_todo for update_plan in a tool-name list when the RPC alias
 * is the active todo surface. Returns the list untouched when workflow_todo
 * is absent (defensive against future edits to the base arrays).
 */
function withTodoToolName(
	names: readonly string[],
	todoToolName: "workflow_todo" | "update_plan",
): string[] {
	if (todoToolName === "update_plan") {
		return names.map((n) => (n === "workflow_todo" ? "update_plan" : n));
	}
	return [...names];
}

export function computeWorkflowToolNames(
	mode: Mode,
	config: WorkflowConfig,
	todoToolName: "workflow_todo" | "update_plan" = "workflow_todo",
): string[] {
	switch (mode) {
		case "plan": {
			const names = withTodoToolName([...PLAN_WORKFLOW_TOOL_NAMES], todoToolName);
			if (config.planReview.enabled) names.push("workflow_plan_review");
			return names;
		}
		case "work": {
			const names = withTodoToolName([...WORK_WORKFLOW_TOOL_NAMES], todoToolName);
			if (config.codeReview.enabled) names.push("workflow_code_review");
			return names;
		}
		case "explore":
			return [...EXPLORE_WORKFLOW_TOOL_NAMES];
		case "init":
			return [...INIT_WORKFLOW_TOOL_NAMES];
		case "idle":
		case "commit":
			return [];
		default:
			return assertNever(mode);
	}
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
		// Session-scope model/thinking changes take effect immediately. Project
		// trust is honored via ctx.isProjectTrusted() when available.
		const config = loadConfigForContext(
			ctx.cwd,
			getAgentDir(),
			getSessionKey(ctx.sessionManager),
			ctx,
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
 * Resolve which todo tool name to activate. Returns "update_plan" when this
 * extension has registered the RPC alias and still owns it (no external
 * override detected at activation time); "workflow_todo" otherwise.
 */
export function resolveTodoToolName(pi: ExtensionAPI): "workflow_todo" | "update_plan" {
	return isAliasOwned(pi) ? "update_plan" : "workflow_todo";
}

/**
 * Reconcile workflow tools for the current mode.
 *
 * pi-workflow manages only its own workflow_* tools. Built-in and other
 * extension tools preserve their current active/inactive state; mode
 * permissions are enforced by prompts and the path guards. External
 * auto-activation (such as ask_user_question) is left to the owning
 * extension or the user.
 */
export function activateWorkflowToolsIfAllowed(
	pi: ExtensionAPI,
	cwd: string,
	getAgentDir: () => string,
	mode: Mode,
	ctx?: ExtensionContext,
): void {
	try {
		const active = pi.getActiveTools().map((tool: any) => {
			if (typeof tool === "string") return tool;
			return tool.name;
		});

		// Resolve which todo tool to activate: update_plan RPC alias when we
		// own it and no external tool has overridden it; workflow_todo otherwise.
		// This is recomputed each activation so late overrides are detected.
		const todoToolName = resolveTodoToolName(pi);

		let workflowToolNames: string[] = [];
		try {
			const cfg = ctx
				? loadConfigForContext(cwd, getAgentDir(), getSessionKey(ctx.sessionManager), ctx)
				: loadConfigForContext(cwd, getAgentDir(), "", undefined);
			workflowToolNames = computeWorkflowToolNames(mode, cfg, todoToolName);
		} catch {
			// Preserve core workflow tools and the already-resolved todo surface
			// when config cannot be read.
			workflowToolNames = computeFallbackWorkflowToolNames(mode, todoToolName);
		}

		// Short-circuit when active and allowed workflow sets already match.
		const workflowCleanup = workflowManagedToolNames(pi);
		const activeWorkflow = new Set(
			active.filter((name) => workflowCleanup.has(name)),
		);
		const expectedWorkflow = new Set(workflowToolNames);
		const sameSize = activeWorkflow.size === expectedWorkflow.size;
		const sameMembers =
			sameSize &&
			[...expectedWorkflow].every((name) => activeWorkflow.has(name));
		if (sameMembers) return;

		const next = new Set(active);
		for (const toolName of workflowCleanup) {
			next.delete(toolName);
		}
		for (const toolName of workflowToolNames) {
			next.add(toolName);
		}

		pi.setActiveTools([...next]);
	} catch (err) {
		// Reconciliation is a safety net; surface failures so they are traceable
		// without disrupting the agent loop.
		console.error(`[workflow] activateWorkflowToolsIfAllowed failed: ${err}`);
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
	const role = modeRole(mode);
	try {
		if (!(await setRole(pi, ctx, role, getAgentDir))) return false;
		activateWorkflowToolsIfAllowed(pi, ctx.cwd, getAgentDir, mode, ctx);
		return true;
	} catch {
		return false;
	}
}

/**
 * Mode → model role. `init` reuses the explore model. `idle` has no prompt but
 * also routes through explore to keep a stable default model.
 */
export function modeRole(mode: Mode): string {
	switch (mode) {
		case "idle":
		case "explore":
		case "init":
			return "explore";
		case "plan":
			return "plan";
		case "work":
			return "work";
		case "commit":
			return "commit";
		default:
			return assertNever(mode);
	}
}

/** Fallback tool set when config cannot be read. Mirrors computeWorkflowToolNames. */
function computeFallbackWorkflowToolNames(
	mode: Mode,
	todoToolName: "workflow_todo" | "update_plan" = "workflow_todo",
): string[] {
	switch (mode) {
		case "plan":
			return withTodoToolName([...PLAN_WORKFLOW_TOOL_NAMES], todoToolName);
		case "explore":
			return [...EXPLORE_WORKFLOW_TOOL_NAMES];
		case "work":
			return withTodoToolName([...WORK_WORKFLOW_TOOL_NAMES], todoToolName);
		case "init":
			return [...INIT_WORKFLOW_TOOL_NAMES];
		case "idle":
		case "commit":
			return [];
		default:
			return assertNever(mode);
	}
}

// ── Workflow tool activation / deactivation ──────────────────────────────

/** All workflow tools that can be enabled in plan/work modes. */
export const WORKFLOW_TOOL_NAMES = WORKFLOW_GATED_TOOLS;

/**
 * Remove all workflow tool names from the active tool set.
 * Used by /wf-exit to ensure the next reload starts clean.
 *
 * update_plan is activated by this extension only when isAliasOwned confirms
 * our registration fingerprint still matches. On /wf-exit we remove it if we
 * ever registered the alias (isAliasRegistered), even if ownership was lost
 * mid-session (e.g., another extension re-registered the name after our
 * activation), preventing a stale alias from lingering into the next reload
 * while preserving an external tool we never owned.
 */
export function deactivateWorkflowTools(pi: ExtensionAPI): void {
	try {
		const active = pi.getActiveTools().map((tool: any) => {
			if (typeof tool === "string") return tool;
			return tool.name;
		});
		const workflowSet = workflowManagedToolNames(pi);
		// Remove update_plan if we ever registered it (isAliasRegistered), even if
		// ownership was lost mid-session, so a stale alias doesn't linger into
		// the next reload. An external tool we never registered is preserved.
		if (isAliasRegistered(pi)) workflowSet.add(UPDATE_PLAN_TOOL_NAME);
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
