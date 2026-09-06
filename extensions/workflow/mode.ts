import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Mode, WorkflowConfig, WorkflowState } from "./types.js";
import { loadConfigForContext } from "./config.js";
import {
	buildContextWindowApplyError,
	cloneModelWithContextWindow,
	loadDiskCompactionSnapshot,
	prepareModelWithContextWindow,
} from "./model-context.js";
import { assertNever, isWorkflowActive, modeLabel, modeStatusLabel } from "./helpers.js";
import { isAliasOwned, isAliasRegistered, UPDATE_PLAN_TOOL_NAME } from "./todo-compat.js";
import { saveState, getSessionKey, loadState } from "./state.js";

// ── Workflow tool mode gating ─────────────────────────────────────────────────

export const WORKFLOW_GATED_TOOLS = [
	"workflow_todo",
	"workflow_plan_read",
	"workflow_plan_save",
	"workflow_plan_approve",
	"workflow_plan_clear",
	"workflow_grill_record",
	"workflow_plan_review",
	"workflow_review",
	"workflow_init_complete",
	"workflow_merge_complete",
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

const WORK_WORKFLOW_TOOL_NAMES = [
	"workflow_todo",
];

const EXPLORE_WORKFLOW_TOOL_NAMES: string[] = [];

const INIT_WORKFLOW_TOOL_NAMES = ["workflow_init_complete"];

const MERGE_WORKFLOW_TOOL_NAMES = ["workflow_merge_complete"];

/**
 * Modes that may call gated workflow tools. Each mode's allowed set is
 * resolved by computeWorkflowToolNames. Explore exposes no workflow tools;
 * Work exposes todo (+ optional code review); Plan keeps plan read/save and
 * grilling; Init exposes only init_complete; Merge exposes only
 * merge_complete (todo/review/plan tools stay off so the merge stays
 * focused on the branch integration).
 */
export function isWorkflowToolMode(mode: Mode): boolean {
	return mode === "plan" || mode === "work" || mode === "init" || mode === "merge";
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
			if (config.review.enabled) names.push("workflow_review");
			return names;
		}
		case "explore":
			return [...EXPLORE_WORKFLOW_TOOL_NAMES];
		case "init":
			return [...INIT_WORKFLOW_TOOL_NAMES];
		case "merge":
			return [...MERGE_WORKFLOW_TOOL_NAMES];
		case "idle":
		case "commit":
			return [];
		default:
			return assertNever(mode);
	}
}

// ── Context-window ownership bookkeeping (session-local, in-memory) ────────

/**
 * Records a workflow-imposed context-window clone for one session. The clone
 * lives only in the Pi runtime; the transcript persists just provider/id, so
 * this bookkeeping is the only place that knows the active model object is
 * workflow-owned and what its original window was. NOT persisted to
 * WorkflowState — reload re-establishes the override from config.
 */
export interface ContextWindowOverrideRecord {
	provider: string;
	modelId: string;
	/** contextWindow the applied clone carries. */
	appliedWindow: number;
	/** Registry (pre-clone) contextWindow of the same provider/id. */
	originalWindow: number;
}

const contextWindowOverrides = new Map<string, ContextWindowOverrideRecord>();

/** Current ownership record for a session (diagnostics/status). */
export function getContextWindowOverride(
	sessionKey: string,
): ContextWindowOverrideRecord | undefined {
	return contextWindowOverrides.get(sessionKey);
}

function recordContextWindowOverride(
	sessionKey: string,
	record: ContextWindowOverrideRecord,
): void {
	contextWindowOverrides.set(sessionKey, record);
}

function clearContextWindowOverride(sessionKey: string): void {
	contextWindowOverrides.delete(sessionKey);
}

/** Drop ownership bookkeeping without touching the runtime (shutdown path:
 *  the transcript never stored the window, and the next load re-resolves the
 *  registry model — the override is re-established from config if needed). */
export function clearContextWindowOwnership(sessionKey: string): void {
	clearContextWindowOverride(sessionKey);
}

/** Read the trust flag off an unknown ctx, conservative when absent. */
function ctxProjectTrusted(ctx: any): boolean {
	try {
		return typeof ctx?.isProjectTrusted === "function" ? !!ctx.isProjectTrusted() : false;
	} catch {
		return false;
	}
}

/**
 * Release a workflow-owned context-window override: delete the bookkeeping
 * and restore the ORIGINAL window — but only on the still-active matching
 * clone. A user's later manual model (or any other extension's change) is
 * preserved untouched. Best-effort: returns whether a needed restore
 * succeeded (true when nothing had to be restored).
 */
export async function releaseContextWindowOverride(
	pi: ExtensionAPI,
	ctx: any,
	sessionKey: string,
): Promise<boolean> {
	const record = contextWindowOverrides.get(sessionKey);
	if (!record) return true;
	clearContextWindowOverride(sessionKey);
	const active = ctx?.model;
	if (!active) return true;
	const isActiveClone =
		active.provider === record.provider &&
		active.id === record.modelId &&
		active.contextWindow === record.appliedWindow;
	if (!isActiveClone) return true;
	try {
		const restored = cloneModelWithContextWindow(active, record.originalWindow);
		const savedThinking = pi.getThinkingLevel();
		const ok = await pi.setModel(restored);
		if (ok) pi.setThinkingLevel(savedThinking);
		return ok;
	} catch (err) {
		console.error(`[workflow] context-window release failed: ${err}`);
		return false;
	}
}

// ── Runtime mode switching ────────────────────────────────────────────────

/**
 * Switch the model to the one configured for the given role,
 * apply thinking level, and apply the optional context-window override:
 * the registry model is validated (positive safe integer, strictly below the
 * Pi baseline, strictly above reserve+keepRecent from the trust-aware disk
 * settings snapshot) and applied as a SHALLOW CLONE — the registry object
 * itself is never mutated. A configured-but-invalid window fails the apply
 * with an explicit error (role, provider/model, input, bounds, fix).
 * Does NOT write workflow state. Also maintains the session-local override
 * ownership bookkeeping.
 */
export async function setRole(
	pi: ExtensionAPI,
	ctx: any,
	role: string,
	getAgentDir: () => string,
): Promise<boolean> {
	try {
		// Resolve config with this session's override layer so /workflow:settings
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

		const sessionKey = getSessionKey(ctx.sessionManager);

		// Optional context-window override: validate against the raw registry
		// model + compaction snapshot, then apply a clone. Invalid values fail
		// loudly — never silently dropped or clamped.
		let modelToApply: Model<any> = model;
		let compactionForError: Parameters<typeof buildContextWindowApplyError>[0]["compaction"];
		if (spec.contextWindow !== undefined) {
			const compactionRes = loadDiskCompactionSnapshot(
				ctx.cwd,
				getAgentDir(),
				ctxProjectTrusted(ctx),
			);
			if (!compactionRes.ok) {
				ctx.ui.notify(
					`models.${role}.contextWindow 已配置，但${compactionRes.error}；已拒绝应用该角色模型。可先清除该字段（继承 Pi 默认窗口）。`,
					"error",
				);
				return false;
			}
			compactionForError = compactionRes.compaction;
			const prepared = prepareModelWithContextWindow(
				model,
				spec.contextWindow,
				compactionRes.compaction,
			);
			if (!prepared.ok) {
				ctx.ui.notify(
					buildContextWindowApplyError({
						role,
						provider: spec.provider,
						model: spec.model,
						rawValue: spec.contextWindow,
						reason: prepared.error,
						baselineWindow: model.contextWindow,
						compaction: compactionForError,
					}),
					"error",
				);
				return false;
			}
			modelToApply = prepared.model;
		}

		const ok = await pi.setModel(modelToApply);
		if (!ok) {
			ctx.ui.notify(
				`模型不可用或缺少 API key：${spec.provider}/${spec.model}`,
				"error",
			);
			return false;
		}

		if (spec.contextWindow !== undefined) {
			recordContextWindowOverride(sessionKey, {
				provider: spec.provider,
				modelId: spec.model,
				appliedWindow: spec.contextWindow,
				originalWindow: model.contextWindow,
			});
		} else {
			// Role inherits the Pi window — any stale ownership from an earlier
			// override is superseded (the raw registry model just became active).
			clearContextWindowOverride(sessionKey);
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
 * Force-apply runtime (model / thinking / tools) for a mode.
 *
 * Always switches the model and thinking to the role configured for `mode`,
 * then reconciles workflow tools. Use this for explicit mode transitions
 * (slash commands, /workflow:enable first entry, idle→explore promotion) and /workflow:settings
 * saves where the target role config must take effect. Does NOT write
 * workflow state or update the status line; prefer transitionWorkflowMode()
 * for workflow mode transitions.
 *
 * To preserve a user's manual /model, Ctrl+P, or Shift+Tab selection across
 * turns, /reload, and /resume, use restoreModeRuntime() instead.
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
 * Restore runtime for the current mode without forcing a role switch.
 *
 * Preserves Pi's active session model/thinking (chosen via /model, Ctrl+P, or
 * Shift+Tab and restored by Pi on /reload and /resume) when `ctx.model` is
 * present. Falls back to the current mode's role config only when no active
 * model is available, keeping the no-model path usable. Always reconciles
 * workflow tools for the current mode.
 *
 * Context-window reconcile (idempotent, runs BEFORE the fallback): when Pi
 * restored an active model, the configured role override is re-applied only
 * if the active provider/id matches the role config AND the window drifted
 * (manual same-id re-select, tree restore, reload). Steady state performs
 * ZERO setModel calls; a needed re-apply preserves the user's thinking level.
 * A manual model different from the role config is kept untouched.
 *
 * Use this for session restore (non-idle session_start) and per-turn startup
 * (before_agent_start) so manual model/thinking selections survive across
 * turns and reloads within the same workflow mode. For explicit mode
 * transitions and /workflow:settings saves, use applyModeRuntime() to force the
 * target role's model/thinking.
 *
 * Does NOT write workflow state or update the status line.
 */
export async function restoreModeRuntime(
	pi: ExtensionAPI,
	ctx: any,
	mode: Mode,
	getAgentDir: () => string,
): Promise<boolean> {
	try {
		let modelOk = true;
		// Idempotent context-window reconcile — only when Pi has an active model;
		// the no-model fallback below applies the full role config (incl. window)
		// via setRole.
		if (ctx?.model) {
			modelOk = await reconcileContextWindow(pi, ctx, mode, getAgentDir);
		}
		// Keep Pi's active session model/thinking when present; only fall back to
		// the role config when Pi could not restore a model for this session.
		if (!ctx?.model) {
			modelOk = await setRole(pi, ctx, modeRole(mode), getAgentDir);
		}
		// Best-effort tool reconcile even when the role model could not be
		// applied, so the no-model path keeps workflow tools usable (matches the
		// original before_agent_start, which activated tools regardless of
		// setRole's outcome). The return value only reflects model-apply success.
		activateWorkflowToolsIfAllowed(pi, ctx.cwd, getAgentDir, mode, ctx);
		return modelOk;
	} catch {
		return false;
	}
}

/**
 * Idempotent context-window reconcile for the restore path. See
 * restoreModeRuntime for the contract. Not exported for external use —
 * event-driven callers use reconcileContextWindowForSession().
 */
async function reconcileContextWindow(
	pi: ExtensionAPI,
	ctx: any,
	mode: Mode,
	getAgentDir: () => string,
): Promise<boolean> {
	try {
		const config = loadConfigForContext(
			ctx.cwd,
			getAgentDir(),
			getSessionKey(ctx.sessionManager),
			ctx,
		);
		const role = modeRole(mode) as keyof typeof config.models;
		const spec = config.models[role];
		const active = ctx?.model as Model<any> | undefined;
		if (!spec || !active) return true;

		const sessionKey = getSessionKey(ctx.sessionManager);

		// No override configured: release any workflow-owned clone left over from
		// an earlier configured run (restore original window on the active clone).
		if (spec.contextWindow === undefined) {
			return await releaseContextWindowOverride(pi, ctx, sessionKey);
		}

		// Manual model different from the role config: keep the user's model (and
		// its window) untouched — the override binds only the configured model.
		if (
			active.provider !== spec.provider ||
			active.id !== spec.model
		) {
			return true;
		}

		const existing = contextWindowOverrides.get(sessionKey);
		if (active.contextWindow === spec.contextWindow) {
			// Already applied — re-establish bookkeeping only if it was lost
			// (e.g. process-internal reload) using the registry baseline.
			if (!existing || existing.provider !== active.provider || existing.modelId !== active.id) {
				const registryModel = ctx.modelRegistry.find(spec.provider, spec.model);
				recordContextWindowOverride(sessionKey, {
					provider: active.provider,
					modelId: active.id,
					appliedWindow: spec.contextWindow,
					originalWindow: registryModel?.contextWindow ?? active.contextWindow,
				});
			}
			return true;
		}

		// Window drifted (manual same-id re-select, tree navigation restore,
		// reload) — re-validate against the registry baseline and re-apply the
		// clone, preserving the user's current thinking level.
		const registryModel = ctx.modelRegistry.find(spec.provider, spec.model);
		if (!registryModel) {
			ctx.ui.notify(
				`contextWindow 覆盖无法恢复：找不到模型 ${spec.provider}/${spec.model}。`,
				"error",
			);
			return false;
		}
		const compactionRes = loadDiskCompactionSnapshot(
			ctx.cwd,
			getAgentDir(),
			ctxProjectTrusted(ctx),
		);
		if (!compactionRes.ok) {
			ctx.ui.notify(
				`models.${role}.contextWindow 已配置，但${compactionRes.error}；已拒绝恢复窗口覆盖。`,
				"error",
			);
			return false;
		}
		const prepared = prepareModelWithContextWindow(
			registryModel,
			spec.contextWindow,
			compactionRes.compaction,
		);
		if (!prepared.ok) {
			ctx.ui.notify(
				buildContextWindowApplyError({
					role: String(role),
					provider: spec.provider,
					model: spec.model,
					rawValue: spec.contextWindow,
					reason: prepared.error,
					baselineWindow: registryModel.contextWindow,
					compaction: compactionRes.compaction,
				}),
				"error",
			);
			return false;
		}
		const savedThinking = pi.getThinkingLevel();
		const ok = await pi.setModel(prepared.model);
		if (!ok) {
			ctx.ui.notify(
				`contextWindow 覆盖恢复失败：模型不可用或缺少 API key（${spec.provider}/${spec.model}）。`,
				"error",
			);
			return false;
		}
		recordContextWindowOverride(sessionKey, {
			provider: spec.provider,
			modelId: spec.model,
			appliedWindow: prepared.appliedWindow,
			originalWindow: prepared.originalWindow,
		});
		pi.setThinkingLevel(savedThinking);
		return true;
	} catch (err) {
		console.error(`[workflow] context-window reconcile failed: ${err}`);
		return false;
	}
}

/**
 * Event-driven entry (model_select / session_tree): load the persisted mode
 * and run the idempotent context-window reconcile when workflow is active.
 * Guarded against re-entrancy — the reconcile's own setModel on the same
 * provider/id is suppressed by Pi's model_select dedup, so no recursion is
 * expected, but the guard keeps any future emission path safe.
 */
const contextWindowReconcileInFlight = new Set<string>();

export async function reconcileContextWindowForSession(
	pi: ExtensionAPI,
	ctx: any,
	getAgentDir: () => string,
): Promise<boolean> {
	const sessionKey = getSessionKey(ctx.sessionManager);
	if (contextWindowReconcileInFlight.has(sessionKey)) return true;
	contextWindowReconcileInFlight.add(sessionKey);
	try {
		const state: WorkflowState = loadState(ctx.cwd, sessionKey);
		const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
		if (!isWorkflowActive(state, config)) return true;
		if (!ctx?.model) return true;
		return await reconcileContextWindow(pi, ctx, state.mode, getAgentDir);
	} catch (err) {
		console.error(`[workflow] context-window event reconcile failed: ${err}`);
		return false;
	} finally {
		contextWindowReconcileInFlight.delete(sessionKey);
	}
}

/**
 * Mode → model role. `init` reuses the explore model. `merge` reuses the work
 * model (conflict resolution and code fixes need the implementation model;
 * no separate merge role exists). `idle` has no prompt but also routes through
 * explore to keep a stable default model.
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
		case "merge":
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
		case "merge":
			return [...MERGE_WORKFLOW_TOOL_NAMES];
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
 * Used by /workflow:disable to ensure the next reload starts clean.
 *
 * update_plan is activated by this extension only when isAliasOwned confirms
 * our registration fingerprint still matches. On /workflow:disable we remove it if we
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
