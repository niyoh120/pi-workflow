import { createBashTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import crypto from "node:crypto";
import {
	getSessionKey,
	loadState,
	saveState,
	writeNewPlan,
	updatePlan,
	readPlanTrimmed,
	requirePlanMarkdown,
} from "./state.js";
import { loadConfigForContext } from "./config.js";
import { todoDeltaText, todoSnapshotText, isWorkflowActive } from "./helpers.js";
import {
	createWorktree,
	deleteWorktreeBranch,
	plannedWorktreeInfo,
	removeWorktree,
	validateWorktreeState,
} from "./worktree.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import {
	applyTodoAction,
	UPDATE_PLAN_TOOL_NAME,
	UpdatePlanParamsSchema,
	isAliasConflicting,
	isAliasOwned,
	markAliasRegistered,
	toolFingerprint,
} from "./todo-compat.js";
import type { TodoStatus, WorkflowState } from "./types.js";
import {
	runPlanReviewAgent,
	extractUserRequirements,
	buildPlanReviewProtocolText,
	reconstructReviewerToolSurface,
	type PlanReviewResult,
} from "./plan-review-agent.js";
import {
	boundPreviousRoundText,
	buildReuseDiagnostics,
	computePlanDecisionHash,
	computePlanHash,
	computePlanReviewBasisHash,
	computePlanReviewTaskInputHash,
	computePlanSectionDelta,
	computePlanSectionHashes,
	decidePlanReviewMode,
	loadPlanReviewHistory,
	normalizePlanReviewFeedback,
	savePlanReviewRound,
} from "./plan-review-history.js";
import {
	runReviewAgent,
	buildImplementationReviewProtocolText,
	type PreviousReviewRoundInput,
	type ReviewResult,
} from "./review-agent.js";
import {
	PREVIOUS_ROUND_TEXT_BUDGET,
	boundedHeadTail,
	computeTaskInputHash,
	computeTodoHash,
	computeWorkspaceDiffSnapshot,
	filesChangedSince,
	loadReviewHistory,
	normalizeWorkFeedback,
	saveReviewRound,
} from "./review-history.js";
import { transitionWorkflowMode } from "./mode.js";
import {
	WORK_APPROVAL_CUSTOM_TYPE,
	buildWorkHandoffBody,
	type WorkApprovalData,
} from "./helpers.js";
import { isAllowedInitTargetPath } from "./guards.js";
import * as path from "node:path";
import * as fs from "node:fs";

function cleanupCreatedWorktree(cwd: string, worktreePath: string, branch: string): void {
	try {
		removeWorktree(cwd, { worktreePath, worktreeBranch: branch });
	} catch {
		// best effort cleanup after failed approval; /wf-status or git worktree list can recover residue.
	}
	try {
		deleteWorktreeBranch(cwd, branch);
	} catch {
		// branch may be absent or unmerged; preserving it is safer than forcing deletion.
	}
}

/**
 * Resolve the effective execution cwd for an external process spawned by a
 * workflow-owned tool (bash override, code review, implementation reviewer).
 * An active worktree in session state is validated via the shared worktree
 * validator and its absolute path is returned; a plain checkout session
 * returns ctx.cwd.
 *
 * Throws on an invalid worktree with a recovery hint so all callers share
 * one worktree semantics and error message.
 */
export function resolveEffectiveCwd(cwd: string, state: WorkflowState): string {
	if (!state.worktreePath) return cwd;
	const validation = validateWorktreeState(cwd, state);
	if (!validation.ok) {
		throw new Error(
			`Active worktree is invalid: ${validation.reason}. Run /wf-status or /wf-reset.`,
		);
	}
	return state.worktreePath;
}

export function registerBashOverrideTool(pi: ExtensionAPI, _getAgentDir: () => string, cwd: string): void {
	const baseBashTool = createBashTool(cwd);
	pi.registerTool({
		...baseBashTool,
		name: "bash",
		description:
			baseBashTool.description +
			" In pi-workflow active worktree mode, commands run from the active worktree cwd.",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);
			const effectiveCwd = resolveEffectiveCwd(ctx.cwd, state);
			const bashTool = createBashTool(effectiveCwd);
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}

// ── Workflow-enabled guard ──────────────────────────────────────

/** Error result returned when workflow is disabled or its state/config
 *  cannot be safely read. Workflow-owned tools surface the failure as an
 *  explicit tool error so the model does not mistake silence for success. */
interface WorkflowDenied {
	isError: true;
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

/**
 * Check whether workflow is enabled for the current session.
 * Returns an error result when workflow is explicitly disabled or when the
 * state/config needed to decide cannot be read. Returns null when workflow
 * is active and the tool call may proceed.
 *
 * NOTE: This returns an error result rather than throwing because it's a
 * business precondition check (permission denied style). The caller decides
 * how to handle this non-error case.
 */
function checkWorkflowEnabled(
	ctx: any,
	getAgentDir: () => string,
): WorkflowDenied | null {
	try {
		const sessionKey = getSessionKey(ctx.sessionManager);
		const state = loadState(ctx.cwd, sessionKey);
		const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
		if (!isWorkflowActive(state, config)) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: "Workflow is not enabled. Run /wf first to enable workflow tools.",
					},
				],
				details: {},
			};
		}
		return null;
	} catch (e) {
		// Workflow-owned tools surface read failures as explicit tool errors so
		// the model does not interpret silence as success.
		const reason = e instanceof Error ? e.message : String(e);
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `Workflow state could not be read: ${reason}`,
				},
			],
			details: { readError: true, error: reason },
		};
	}
}

const TodoStatusSchema = StringEnum([
	"pending",
	"in_progress",
	"done",
	"blocked",
] as const);

// ── workflow_todo tool ────────────────────────────────────

export function registerTodoTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_todo",
		label: "Workflow Todo",
		description:
			"Maintain the workflow todo list. Available in Plan and Work modes. Use to create, update, and track task progress aligned with the approved plan.",
		parameters: Type.Object({
			action: StringEnum(["reset", "add", "set", "list"] as const),
			items: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.Optional(Type.String()),
						title: Type.String(),
						status: Type.Optional(TodoStatusSchema),
						notes: Type.Optional(Type.String()),
					}),
				),
			),
			id: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			status: Type.Optional(TodoStatusSchema),
			notes: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);

			// Explicit read: return a full snapshot (clearly marked). No mutation.
			if (params.action === "list") {
				return {
					content: [{ type: "text", text: todoSnapshotText(state) }],
					details: { todos: state.todos },
				};
			}

			let changedId: string | undefined;
			let changedTitle: string | undefined;
			let changedStatus: TodoStatus | undefined;
			let deltaIsAdd = false;
			let deltaMutation: "reset" | "replaced" | undefined;

			if (params.action === "reset") {
				const overlay = getWorkflowOverlay();
				if (overlay) overlay.clearBookkeeping();

				state.todos = applyTodoAction(state.todos, {
					kind: "reset",
					items: params.items,
				});
				// reset replaces the whole list; label the delta as a reset. todoDeltaText
				// reports the first item and the next item under the reset label.
				deltaMutation = "reset";
			}

			if (params.action === "add") {
				if (!params.title) {
					throw new Error("workflow_todo add requires title.");
				}

				const before = new Set(state.todos.map((t) => t.id));
				state.todos = applyTodoAction(state.todos, {
					kind: "add",
					id: params.id,
					title: params.title,
					status: params.status,
					notes: params.notes,
				});
				const added = state.todos.find((t) => !before.has(t.id));
				changedId = added?.id;
				changedTitle = params.title;
				changedStatus = params.status as TodoStatus | undefined;
				// Signal to todoDeltaText that this is an add (label "added", not "changed").
				deltaIsAdd = true;
			}

			if (params.action === "set") {
				if (!params.id) {
					throw new Error("workflow_todo set requires a non-empty id.");
				}
				const exists = state.todos.some((todo) => todo.id === params.id);
				if (!exists) {
					throw new Error(`Todo not found: ${params.id}`);
				}

				state.todos = applyTodoAction(state.todos, {
					kind: "set",
					id: params.id,
					title: params.title,
					status: params.status,
					notes: params.notes,
				});
				changedId = params.id;
			}

			saveState(ctx.cwd, sessionKey, state);

			const overlay = getWorkflowOverlay();
			if (overlay) overlay.update(state.todos);

			return {
				content: [{ type: "text", text: todoDeltaText(state, { changedId, changedTitle, changedStatus, isAdd: deltaIsAdd, mutation: deltaMutation }) }],
				details: { todos: state.todos },
			};
		},
	});
}

// ── update_plan RPC alias (Paseo native TodoListCard) ──────────────────────

/**
 * Register the update_plan compatibility tool for RPC mode. The tool accepts
 * an optional `plan` array matching Paseo's UpdatePlanSchema. Omitting `plan`
 * reads the current todo list; providing it replaces the full list. Ownership
 * is tracked via todo-compat so collision with external update_plan tools is
 * detected and the alias is only activated when we own the name.
 */
export function registerUpdatePlanTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: UPDATE_PLAN_TOOL_NAME,
		label: "Update Plan (Paseo native todo)",
		description:
			"Maintain the workflow todo list using Paseo's native todo card format. " +
			"Provide `plan` to replace the full list (pending|in_progress|completed; " +
			"prefix a step with \"[blocked] \" to mark it blocked). Omit `plan` to read " +
			"the current list. IDs are per-call T1..Tn snapshots and must not be " +
			"referenced across calls.",
		parameters: UpdatePlanParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);

			// Read-only path: plan omitted → return full snapshot without mutating.
			if (params.plan === undefined) {
				return {
					content: [{ type: "text", text: todoSnapshotText(state) }],
					details: { todos: state.todos },
				};
			}

			// Full-list replacement. Clear overlay bookkeeping since IDs are snapshots.
			try {
				const overlay = getWorkflowOverlay();
				if (overlay) overlay.clearBookkeeping();

				state.todos = applyTodoAction(state.todos, {
					kind: "replace",
					items: params.plan,
				});
				saveState(ctx.cwd, sessionKey, state);

				if (overlay) overlay.update(state.todos);
			} catch (e) {
				const errMsg = e instanceof Error ? e.message : String(e);
				return {
					isError: true,
					content: [{ type: "text", text: `update_plan failed: ${errMsg}` }],
					details: { todos: state.todos },
				};
			}

			return {
				content: [{ type: "text", text: todoDeltaText(state, { mutation: "replaced" }) }],
				details: { todos: state.todos },
			};
		},
	});
}

// ── workflow plan tools ────────────────────────────────────

function renderPlanToolResult(result: any, _options: any, theme: any): Text {
	const state = result.details?.state as WorkflowState | undefined;
	const planPath = state?.planPath;
	const text = Array.isArray(result.content)
		? result.content
				.filter((block: any) => block?.type === "text")
				.map((block: any) => block.text)
				.join("\n")
		: "";
	const header = planPath
		? `${theme.fg("accent", theme.bold("Plan"))}: ${theme.fg("muted", planPath)}\n\n`
		: "";
	return new Text(header + text, 0, 0);
}

export function registerPlanReadTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_plan_read",
		label: "Read Workflow Plan",
		description: "Read the active workflow plan. In Approved Work the handoff already contains the plan; use this only when the user explicitly asks to re-read, the handoff is missing, or recovery diagnostics require it.",
		parameters: Type.Object({}),
		renderResult: renderPlanToolResult,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);

			if (!state.planPath) {
				return {
					content: [{ type: "text", text: "No active plan. Path: none." }],
					details: { state },
				};
			}

			const trimmed = readPlanTrimmed(ctx.cwd, state.planPath);
			if (!trimmed) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Active plan is missing or empty: ${state.planPath}. Re-enter /plan and save a plan first.`,
						},
					],
					details: { state, planMissing: true, planPath: state.planPath },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Plan path: ${state.planPath}\n\n${trimmed}`,
					},
				],
				details: { state },
			};
		},
	});
}

export function registerPlanSaveTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_plan_save",
		label: "Save Workflow Plan",
		description: "Save or revise the active workflow plan. Plan Mode only. Pass the complete plan text as markdown when revising.",
		parameters: Type.Object({
			title: Type.Optional(Type.String()),
			markdown: Type.String(),
		}),
		renderResult: renderPlanToolResult,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);
			const markdown = params.markdown;

			if (state.mode !== "plan") {
				throw new Error(
					`workflow_plan_save only allowed in Plan Mode (current: ${state.mode}).`,
				);
			}

			// Reject blank/whitespace-only plans so an empty save cannot become the
			// active plan that later flows into review/approve/handoff.
			if (!markdown || !markdown.trim()) {
				throw new Error(
					"workflow_plan_save requires non-blank markdown. Provide the complete plan text.",
				);
			}

			// Distinguish first save (new plan) vs revision save (update existing plan)
			const isRevision = !!state.planPath;
			if (isRevision) {
				// Revision: update existing plan file in-place
				updatePlan(ctx.cwd, state.planPath!, markdown);
				state.planTitle = params.title ?? state.planTitle ?? "Active Plan";
			} else {
				// First save: create new plan file
				const planPath = writeNewPlan(ctx.cwd, markdown);
				state.planPath = planPath;
				state.planTitle = params.title ?? "Active Plan";
				state.planRunId = crypto.randomUUID();
			}

			// Snapshot confirmed grilling decisions into planReviewDecisions so a
			// revised plan still carries earlier confirmed decisions to the
			// independent reviewer. grillTurns accumulates only decisions recorded
			// since the previous save (it is cleared below), so appending is
			// duplicate-safe across revisions.
			if (state.grillTurns.length) {
				state.planReviewDecisions = [
					...(state.planReviewDecisions ?? []),
					...state.grillTurns,
				];
			}
			state.todos = [];
			state.grillTurns = [];
			saveState(ctx.cwd, sessionKey, state);

			// Set session name for easier identification in /resume
			pi.setSessionName(`plan: ${state.planTitle ?? "Active Plan"}`);

			const overlay = getWorkflowOverlay();
			if (overlay) {
				overlay.clearBookkeeping();
				overlay.update(state.todos);
			}

			return {
				content: [
					{
						type: "text",
						text: isRevision
							? `Plan updated at ${state.planPath}.`
							: `Plan created at ${state.planPath}.`,
					},
				],
				details: { state },
			};
		},
	});
}

export function registerPlanApproveTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_plan_approve",
		label: "Approve Workflow Plan",
		description: "Approve the active plan for implementation. Plan Mode only. Call only after the user explicitly confirms the final plan. Must be called alone in its tool batch.",
		parameters: Type.Object({
			branchName: Type.Optional(
				Type.String({
					description:
						"Optional semantic branch name (e.g. 'feat/readable-name'). Suffix '@wf-<id>' is appended automatically.",
				}),
			),
		}),
		renderResult: renderPlanToolResult,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);

			if (state.mode !== "plan") {
				throw new Error(
					`workflow_plan_approve only allowed in Plan Mode (current: ${state.mode}).`,
				);
			}

			if (!state.planPath) {
				throw new Error("No active plan. Save a plan first.");
			}

			// Approval requires a valid Final Plan. A missing or blank plan file
			// must not produce a journal/handoff — surface an explicit error so the
			// user re-enters /plan instead of starting an empty Work run.
			const planMarkdown = requirePlanMarkdown(ctx.cwd, state.planPath);

			// Approval requires a non-empty todo list. The Plan prompt mandates
			// save → write todos → approve; rejecting empty todos here enforces
			// that the Work run starts with a concrete task list and the
			// Implementation Reviewer has a plan coverage target to verify.
			if (!state.todos || state.todos.length === 0) {
				throw new Error(
	`Cannot approve a plan with an empty todo list. After workflow_plan_save, write the full todo list via workflow_todo(action="reset", items=[...]) before calling workflow_plan_approve.`,
				);
			}

			const workRunId = crypto.randomUUID();
			let worktreePath: string | undefined;
			let worktreeBranch: string | undefined;
			let worktreeBaseBranch: string | undefined;

			const choice = ctx.ui.select
				? await ctx.ui.select("执行方式", [
						"当前目录",
						"Git worktree",
						"取消",
					])
				: "当前目录";
			if (!choice || choice === "取消") {
				return {
					content: [{ type: "text", text: "Plan approval cancelled." }],
					details: { state },
				};
			}

			if (choice === "Git worktree") {
				const semanticBranch = params.branchName;
				const planned = plannedWorktreeInfo(ctx.cwd, workRunId, semanticBranch);
				try {
					const worktree = createWorktree(ctx.cwd, workRunId, semanticBranch);
					worktreePath = worktree.path;
					worktreeBranch = worktree.branch;
					worktreeBaseBranch = worktree.baseBranch;
				} catch (err) {
					try {
						removeWorktree(ctx.cwd, {
							worktreePath: planned.path,
							worktreeBranch: planned.branch,
						});
					} catch {
						// best effort cleanup after failed creation; avoid deleting a branch that may have pre-existed.
					}
					throw err;
				}
			}

			const nextState: WorkflowState = {
				...state,
				mode: "work",
				workRunId,
				worktreePath,
				worktreeBranch,
				worktreeBaseBranch,
				pendingWorkKickoff: workRunId,
				// Deep-copy the current todo list as an immutable approved snapshot.
				// The reviewer and handoff use this snapshot, not the mutable live
				// state.todos, so later Work mutations don't alter what was approved.
				approvedTodos: state.todos.map((t) => ({ ...t })),
				// Plan-lifecycle review-context fields are no longer relevant once the
				// plan is approved; drop them so they cannot leak into a later Plan run.
				planStartEntryId: undefined,
				planReviewDecisions: [],
			};

			// Build the immutable handoff snapshot BEFORE transition so the
			// approval journal captures the exact plan content at approval time.
			const handoffBody = buildWorkHandoffBody(nextState, planMarkdown);

			if (Buffer.byteLength(handoffBody, "utf8") > 65536) {
				console.warn(
					`[workflow] handoffBody is ${Buffer.byteLength(handoffBody, "utf8")} bytes (>64KB); approval will proceed but context size may be large`,
				);
			}

			// Persist the approval journal (non-LLM custom entry) as the durable
			// snapshot and boundary. Must succeed before state transition.
			try {
				const journalData: WorkApprovalData = { workRunId, handoffBody };
				pi.appendEntry(WORK_APPROVAL_CUSTOM_TYPE, journalData);
			} catch (journalErr) {
				// Journal write failed — cleanup worktree and abort.
				if (worktreePath && worktreeBranch) cleanupCreatedWorktree(ctx.cwd, worktreePath, worktreeBranch);
				throw journalErr;
			}

			const rollbackApproval = async () => {
				let rollbackSucceeded = false;
				try {
					await transitionWorkflowMode({
						pi,
						ctx,
						sessionKey,
						nextState: state,
						getAgentDir,
					});
					rollbackSucceeded = true;
				} catch {
					// Preserve the original approval failure; /wf-reset can recover a rollback failure.
				}
				if (rollbackSucceeded && worktreePath && worktreeBranch) cleanupCreatedWorktree(ctx.cwd, worktreePath, worktreeBranch);
			};

			let result: Awaited<ReturnType<typeof transitionWorkflowMode>>;
			try {
				result = await transitionWorkflowMode({
					pi,
					ctx,
					sessionKey,
					nextState,
					getAgentDir,
				});
			} catch (err) {
				await rollbackApproval();
				throw err;
			}

			if (!result.ok) {
				await rollbackApproval();
				throw new Error(result.reason);
			}

			// Set session name for easier identification in /resume
			pi.setSessionName(`work: ${result.state.planTitle ?? "Active Plan"}`);

			// The agent_settled dispatcher will write the canonical marker and
			// start the new Work run. No same-loop followUp or immediate marker.

			return {
				content: [
					{
						type: "text",
						text:
							`Plan approved. Work Mode runtime activated. ` +
							`Work run: ${result.state.workRunId!.slice(-8)}.\n\n` +
							`Approval journal已持久化。Plan run结束后将自动启动新 Work run。` +
							"\n\nDo not call any more tools in this turn.",
					},
				],
				details: { state: result.state },
				terminate: true,
			};
		},
	});
}

export function registerPlanClearTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_plan_clear",
		label: "Clear Workflow Plan",
		description: "Clear workflow state and return to idle mode. Plan Mode only.",
		parameters: Type.Object({}),
		renderResult: renderPlanToolResult,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);

			if (state.mode !== "plan") {
				throw new Error(
					`workflow_plan_clear only allowed in Plan Mode (current: ${state.mode}).`,
				);
			}

			const cleared: WorkflowState = {
				workflowEnabled: state.workflowEnabled,
				workflowExplicitlyDisabled: state.workflowExplicitlyDisabled,
				mode: "idle",
				todos: [],
				grillTurns: [],
				planReviewDecisions: [],
			};

			const result = await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState: cleared,
				getAgentDir,
				applyRuntime: false,
			});

			const overlay = getWorkflowOverlay();
			if (overlay) overlay.dispose();

			return {
				content: [{ type: "text", text: "Workflow state cleared." }],
				details: { state: result.state },
				terminate: true,
			};
		},
	});
}

// ── workflow_grill_record tool (grilling 阶段决策落盘) ───────

/** Single source for the grill decision-status union (schema + runtime guard). */
const GRILL_DECISION_STATUSES = ["resolved", "open", "needs-codebase-check"] as const;
const GrillDecisionStatusSchema = StringEnum(GRILL_DECISION_STATUSES);

/** A single grilling decision in the batched public schema. */
const GrillDecisionSchema = Type.Object({
	question: Type.String({ description: "The exact question asked, one question only." }),
	recommendedAnswer: Type.String({ description: "The assistant's recommended answer to the question." }),
	userAnswer: Type.Optional(Type.String({ description: "The user's answer, if already provided." })),
	decisionStatus: GrillDecisionStatusSchema,
	notes: Type.Optional(Type.String({ description: "Short rationale, dependency, or follow-up note." })),
});

/** Runtime check for the closed grill decision-status union. */
function isGrillDecisionStatus(v: unknown): v is (typeof GRILL_DECISION_STATUSES)[number] {
	return typeof v === "string" && (GRILL_DECISION_STATUSES as readonly string[]).includes(v);
}

/**
 * Normalize tool-call params into a decisions[] array. Accepts the new
 * batched `decisions` schema; legacy single-decision calls (question /
 * recommendedAnswer / userAnswer / decisionStatus / notes as top-level
 * fields) are converted into a one-element array so old session tool-call
 * replays still persist correctly.
 */
function prepareGrillArguments(params: Record<string, unknown>): Array<{
	question: string;
	recommendedAnswer: string;
	userAnswer?: string;
	decisionStatus: "resolved" | "open" | "needs-codebase-check";
	notes?: string;
}> {
	if (Array.isArray(params.decisions)) {
		return (params.decisions as Array<Record<string, unknown>>)
			.filter((d) => d && typeof d.question === "string" && typeof d.recommendedAnswer === "string")
			.map((d) => ({
				question: String(d.question),
				recommendedAnswer: String(d.recommendedAnswer),
				userAnswer: typeof d.userAnswer === "string" ? d.userAnswer : undefined,
				decisionStatus: isGrillDecisionStatus(d.decisionStatus) ? d.decisionStatus : "open",
				notes: typeof d.notes === "string" ? d.notes : undefined,
			}));
	}
	// Legacy single-decision shape.
	if (typeof params.question === "string" && typeof params.recommendedAnswer === "string") {
		return [{
			question: params.question,
			recommendedAnswer: params.recommendedAnswer,
			userAnswer: typeof params.userAnswer === "string" ? params.userAnswer : undefined,
			decisionStatus: isGrillDecisionStatus(params.decisionStatus) ? params.decisionStatus : "open",
			notes: typeof params.notes === "string" ? params.notes : undefined,
		}];
	}
	return [];
}

export function registerGrillRecordTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_grill_record",
		label: "Grill Record Turn",
		description:
			"Record grilling decisions during Plan Mode. Pass `decisions` (a batch of " +
			"{question, recommendedAnswer, userAnswer?, decisionStatus, notes?}) to persist " +
			"multiple decisions from one round of user answers at once. Legacy single-field " +
			"calls (question/recommendedAnswer/userAnswer/decisionStatus/notes) are accepted " +
			"for backward compatibility. Plan Mode only.",
		parameters: Type.Object({
			decisions: Type.Optional(Type.Array(GrillDecisionSchema, {
				description: "Batch of grilling decisions to record. Prefer this over the legacy single fields.",
			})),
			// Legacy single-decision fields (kept for backward compatibility with old
			// session tool-call replays; converted into a one-element decisions array).
			question: Type.Optional(Type.String()),
			recommendedAnswer: Type.Optional(Type.String()),
			userAnswer: Type.Optional(Type.String()),
			decisionStatus: Type.Optional(GrillDecisionStatusSchema),
			notes: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);

			if (state.mode !== "plan") {
				throw new Error(
					`workflow_grill_record only allowed in Plan Mode (current: ${state.mode}).`,
				);
			}

			const decisions = prepareGrillArguments(params as Record<string, unknown>);
			if (decisions.length === 0) {
				throw new Error(
					"workflow_grill_record requires either `decisions` (batch) or the legacy single-decision fields (question + recommendedAnswer + decisionStatus).",
				);
			}

			for (const d of decisions) {
				state.grillTurns.push({
					question: d.question,
					recommendedAnswer: d.recommendedAnswer,
					userAnswer: d.userAnswer,
					decisionStatus: d.decisionStatus,
					notes: d.notes,
				});
			}
			saveState(ctx.cwd, sessionKey, state);

			// Compact confirmation: only this batch's count and the running total.
			// Full grillTurns stay in details for UI/state recovery.
			return {
				content: [
					{
						type: "text",
						text: `Recorded ${decisions.length} grill decision(s). Total: ${state.grillTurns.length}.`,
					},
				],
				details: { recorded: decisions.length, count: state.grillTurns.length, grillTurns: state.grillTurns },
			};
		},
	});
}

// ── workflow_plan_review tool (independent reviewer agent) ──────────

/** Normalize plan-review arguments carried in resumed sessions.
 *
 *  The tool accepts one optional `feedback` string (a response to a prior
 *  round's disputed findings). Older sessions may still replay the legacy
 *  sidecall fields `task` / `context` / `instructions`; accept and discard
 *  them so resumed tool calls do not fail validation. */
function preparePlanReviewArguments(
	args: unknown,
): { feedback?: string } {
	// Intentionally discards legacy fields. Kept explicit so future arg
	// additions are deliberate.
	const a = (args ?? {}) as Record<string, unknown>;
	void a.task;
	void a.context;
	void a.instructions;
	const feedback = typeof a.feedback === "string" ? a.feedback : undefined;
	return feedback === undefined ? {} : { feedback };
}

export function registerPlanReviewTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_plan_review",
		label: "Workflow Plan Review",
		description:
			"Launch an independent reviewer agent that re-validates the saved Final Plan against the authoritative user requirements and confirmed decisions, using its own exploration of the repository and active information tools. Plan Mode only. The reviewer task is assembled from workflow state. Repeated calls are efficient: identical inputs (plan + decisions + repository + reviewer baseline) reuse the cached round; a revised plan or new confirmed decisions run an INCREMENTAL review focused on the changed sections; changed requirements/model/tools/repository force a full review. Optional `feedback` (free text) responds to the previous round's disputed Critical/Important findings; the reviewer verifies it independently. Returns structured feedback (Critical/Important/Minor/Summary) plus a transient PASS/FAIL evaluation signal — the reviewer submits the verdict through its own terminating review_submit tool call, and a missing submission resolves fail-closed to FAIL. The signal never gates approval, which stays user-confirmed via workflow_plan_approve.",
		parameters: Type.Object({
			feedback: Type.Optional(
				Type.String({
					description:
						"Optional free-text response to the previous plan-review round's disputed findings. Map each disputed Critical/Important finding to its technical rationale with verifiable evidence (file:line, command output). Only valid once this plan has a prior review round; the reviewer verifies every claim independently. Omit for a normal review.",
				}),
			),
		}),
		prepareArguments: preparePlanReviewArguments,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			// Legacy sidecall fields (task/context/instructions) from resumed
			// sessions are already stripped by the prepareArguments hook before
			// execute is invoked; no further action needed here.

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);
			if (state.mode !== "plan") {
				throw new Error(
					`workflow_plan_review only allowed in Plan Mode (current: ${state.mode}).`,
				);
			}

			if (!state.planPath) {
				throw new Error(
					"No active plan to review. Save a plan first via workflow_plan_save.",
				);
			}

			// Old-session self-heal: a planPath recorded before planRunId existed
			// (or a state file that lost it) gets a fresh id persisted immediately,
			// BEFORE any fingerprint/hash/reviewer orchestration. This plan run
			// starts from a full review; later rounds gain isolation + deltas.
			if (!state.planRunId) {
				state.planRunId = crypto.randomUUID();
				saveState(ctx.cwd, sessionKey, state);
			}
			const planRunId = state.planRunId;

			const planMarkdown = requirePlanMarkdown(ctx.cwd, state.planPath);
			const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
			const decisions = state.planReviewDecisions ?? [];

			// ── Single snapshots shared by hashes and the child runner ──
			// Requirements, tool surface, and protocol text are each computed ONCE
			// so the cache decision and the actual reviewer inputs cannot drift.
			const branch = ctx.sessionManager?.getBranch?.();
			const requirements = extractUserRequirements(branch, state.planStartEntryId);
			const toolSurface = reconstructReviewerToolSurface(pi);
			const protocolText = buildPlanReviewProtocolText();
			const reviewerModel = `${config.models.planReview.provider}/${config.models.planReview.model}`;

			// Optional non-authoritative planner feedback on a prior round's
			// disputed findings. Accepted only when this plan run already has an
			// actual review round; a first-round feedback is an explicit error.
			const feedback = normalizePlanReviewFeedback(params.feedback);
			const history = loadPlanReviewHistory(ctx.cwd, sessionKey);
			const lastRound =
				history && history.planRunId === planRunId
					? history.rounds[history.rounds.length - 1]
					: undefined;
			if (feedback && !lastRound) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "当前 Plan 尚无上一轮 finding；移除 feedback 后重新调用 workflow_plan_review()。",
						},
					],
					details: { feedbackRejected: true, reason: "no previous round" },
				};
			}

			// ── Repository fingerprint + hashes ──
			const diffSnapshot = computeWorkspaceDiffSnapshot(ctx.cwd);
			const reviewBasisHash = computePlanReviewBasisHash({
				requirements,
				reviewerModel,
				thinking: config.models.planReview.thinking,
				requestedTools: toolSurface.requestedTools,
				extensionPaths: toolSurface.extensionPaths,
				protocolText,
			});
			const decisionHash = computePlanDecisionHash(decisions);
			const planHash = computePlanHash(planMarkdown);
			const sectionHashes = computePlanSectionHashes(planMarkdown);
			const taskInputHash = computePlanReviewTaskInputHash({
				basisHash: reviewBasisHash,
				planMarkdown,
				decisions,
				feedback,
			});

			const cache = decidePlanReviewMode({
				history,
				planRunId,
				diffFingerprint: diffSnapshot.fingerprint,
				deltaUnknown: diffSnapshot.unknown,
				reviewBasisHash,
				taskInputHash,
			});
			const nextRound = (lastRound?.round ?? 0) + 1;

			// ── Reused path: identical repository + basis + task input ──
			// Returns the cached canonical output and effective verdict with zero
			// this-round cost. No new history round is appended (bounded history,
			// no nested output growth) — unlike Implementation Review, which
			// persists its short-circuited rounds.
			if (cache.mode === "reused" && lastRound) {
				const reuse = buildReuseDiagnostics(lastRound);
				const ops = [
					`reviewer: ${lastRound.model}`,
					`round: ${reuse.round} (mode: reused — repo evidence reused from round ${reuse.reusedFromRound}; inputs + repository unchanged)`,
					`elapsed: 0s (no reviewer run)`,
					`turns: 0 | tool calls: 0 | usage: 0 (cached)`,
					`successful repo inspection: ${reuse.hasSuccessfulRepoInspection ? "yes" : "NO"}`,
					`cache: ${cache.reason}`,
					`verdict: ${lastRound.effectiveVerdict}${lastRound.verdictReason ? ` (${lastRound.verdictReason})` : ""}`,
				];
				const verdictNotice =
					lastRound.effectiveVerdict === "PASS"
						? "\n\n✅ Plan review PASS (reused). Evaluation signal for the planner; approval remains user-confirmed via workflow_plan_approve."
						: "\n\n❌ Plan review FAIL (reused). Address the Critical/Important findings, then revise the plan and re-run workflow_plan_review().";
				return {
					content: [
						{
							type: "text",
							text: `♻️ Reused: repository, review basis, and all task inputs are unchanged since review round ${reuse.reusedFromRound}. No new reviewer run.\n\n${lastRound.reviewerText}${verdictNotice}\n\n---\n${ops.join(" | ")}`,
						},
					],
					details: {
						reviewerModel: lastRound.model,
						round: reuse.round,
						reusedFromRound: reuse.reusedFromRound,
						mode: "reused",
						elapsedMs: reuse.elapsedMs,
						turns: reuse.turns,
						toolCalls: reuse.toolCalls,
						successfulToolNames: reuse.successfulToolNames,
						hasSuccessfulRepoInspection: reuse.hasSuccessfulRepoInspection,
						effectiveVerdict: lastRound.effectiveVerdict,
						verdictReason: lastRound.verdictReason,
						cacheReason: cache.reason,
					},
				};
			}

			// ── Full / incremental reviewer run ──
			const incremental = cache.mode === "incremental" && !!lastRound;
			const previousRound = incremental && lastRound
				? {
						round: lastRound.round,
						effectiveVerdict: lastRound.effectiveVerdict,
						reviewerText: boundPreviousRoundText(lastRound.reviewerText),
						deltaUnknown: lastRound.deltaUnknown || diffSnapshot.unknown,
					}
				: undefined;
			const sectionDelta = incremental && lastRound
				? computePlanSectionDelta(lastRound.sectionHashes, sectionHashes)
				: undefined;
			const decisionsChanged = incremental && lastRound
				? lastRound.decisionHash !== decisionHash
				: undefined;

			let result: PlanReviewResult;
			try {
				result = await runPlanReviewAgent({
					ctx,
					pi,
					modelSpec: config.models.planReview,
					planMarkdown,
					decisions,
					requirements,
					toolSurface,
					previousRound,
					sectionDelta,
					decisionsChanged,
					feedback,
					parentSignal: signal,
					onProgress: (text) => {
						onUpdate?.({
							content: [{ type: "text", text }],
							details: {},
						});
					},
				});
			} catch (err) {
				// AbortError from a cancelled signal is rethrown so the platform
				// handles cancellation; everything else becomes an explicit tool
				// error (no verdict produced, no history round written).
				if (err instanceof Error && err.name === "AbortError") throw err;
				const reason = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [{ type: "text", text: `Plan review failed: ${reason}` }],
					details: { error: true, reason, mode: cache.mode, round: nextRound },
				};
			}

			// ── Effective verdict ──
			// A submitted FAIL stays FAIL. A submitted PASS requires successful
			// builtin repo inspection evidence (finalized tool_execution_end
			// results); without it the round is downgraded to FAIL so the planner
			// treats it as insufficient evidence rather than approval clearance.
			let effectiveVerdict = result.verdict;
			let verdictReason = result.verdictReason;
			if (result.verdict === "PASS" && !result.hasSuccessfulRepoInspection) {
				effectiveVerdict = "FAIL";
				verdictReason = "reviewer produced PASS without successful repository inspection";
			}

			// Persist this ACTUAL reviewer round so later calls can reuse or
			// increment against it. Best-effort: the review result stands even
			// when the write fails — the diagnostics flag that the next round
			// will full review.
			let historyPersisted = true;
			try {
				savePlanReviewRound(ctx.cwd, sessionKey, {
					planRunId,
					round: nextRound,
					at: new Date().toISOString(),
					model: result.reviewerModel,
					thinking: result.thinking,
					elapsedMs: result.elapsedMs,
					turns: result.turns,
					toolCalls: result.toolCalls,
					reviewerText: result.text,
					effectiveVerdict,
					verdictReason,
					hasSuccessfulRepoInspection: result.hasSuccessfulRepoInspection,
					successfulToolNames: result.successfulToolNames ?? [],
					diffFingerprint: diffSnapshot.fingerprint,
					deltaUnknown: diffSnapshot.unknown,
					reviewBasisHash,
					taskInputHash,
					planHash,
					decisionHash,
					sectionHashes,
					mode: incremental ? "incremental" : "full",
					reusedFromRound: previousRound?.round,
				});
			} catch {
				historyPersisted = false;
			}

			const elapsedSec = Math.round(result.elapsedMs / 1000);
			const ops: string[] = [
				`reviewer: ${result.reviewerModel}${result.thinking ? ` / ${result.thinking}` : ""}`,
				`round: ${nextRound} (mode: ${cache.mode}${incremental && previousRound ? `, building on round ${previousRound.round}` : ""}${historyPersisted ? "" : "; history write failed — next round will full review"})`,
				`cache decision: ${cache.reason}`,
			];
			if (sectionDelta) {
				ops.push(
					`changed sections: added ${sectionDelta.added.length}, changed ${sectionDelta.changed.length}, removed ${sectionDelta.removed.length}`,
				);
			}
			if (decisionsChanged !== undefined) {
				ops.push(`decisions changed: ${decisionsChanged ? "yes" : "no"}`);
			}
			ops.push(
				`elapsed: ${elapsedSec}s`,
				`turns: ${result.turns}`,
				`tool calls: ${result.toolCalls}`,
				`successful repo inspection: ${result.hasSuccessfulRepoInspection ? "yes" : "NO"}`,
				`verdict: ${effectiveVerdict}${verdictReason ? ` (${verdictReason})` : ""}`,
			);
			if (result.unavailableTools.length) {
				ops.push(`unavailable tools: ${result.unavailableTools.join(", ")}`);
			}
			if (result.stopReason && result.stopReason !== "stop") {
				ops.push(`stopReason: ${result.stopReason}`);
			}
			if (result.errorMessage) {
				ops.push(`error: ${result.errorMessage}`);
			}

			const verdictNotice =
				effectiveVerdict === "PASS"
					? "\n\n✅ Plan review PASS. Evaluation signal for the planner; approval remains user-confirmed via workflow_plan_approve."
					: "\n\n❌ Plan review FAIL. Address the Critical/Important findings, revise the plan (workflow_plan_save), and re-run workflow_plan_review(). workflow_plan_approve remains available once the user explicitly confirms.";

			return {
				content: [
					{
						type: "text",
						text: `${result.text}${verdictNotice}\n\n---\n${ops.join(" | ")}`,
					},
				],
				details: {
					reviewerModel: result.reviewerModel,
					thinking: result.thinking,
					elapsedMs: result.elapsedMs,
					turns: result.turns,
					toolCalls: result.toolCalls,
					requestedTools: result.requestedTools,
					activeTools: result.activeTools,
					unavailableTools: result.unavailableTools,
					successfulToolNames: result.successfulToolNames ?? [],
					hasSuccessfulRepoInspection: result.hasSuccessfulRepoInspection,
					stopReason: result.stopReason,
					errorMessage: result.errorMessage,
					verdict: result.verdict,
					effectiveVerdict,
					verdictReason,
					round: nextRound,
					mode: cache.mode,
					reusedFromRound: previousRound?.round,
					historyPersisted,
				},
				usage: result.usage,
			};
		},
	});
}

// ── workflow_review tool (on-demand unified review) ───────────────────────

export function registerReviewTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_review",
		label: "Workflow Review",
		description:
			"Launch an independent reviewer that reviews the Work agent's implementation against the requirements and approved plan/todos (Approved Work) or current todos (Direct Work), using its own exploration of the actual repository. Work Mode only, on-demand (triggered by /review). The reviewer task is assembled from workflow state. Optional `feedback` (free text) lets the Work agent respond to a prior round's disputed Critical/Important findings; it is injected as a clearly-labeled UNTRUSTED section that the reviewer must independently verify against the repository before it carries any weight — requirements/plan/todos remain the authoritative inputs. When codeReview.enabled is true, a workspace OCR review runs first and its normalized findings are folded into the reviewer task; when false the reviewer covers the implementation directly. Returns structured findings + a PASS/FAIL verdict that signals whether this review loop can end (never gates /commit and is not persisted).",
		parameters: Type.Object({
			feedback: Type.Optional(
				Type.String({
					description:
						"Optional free-text response to a prior review round's disputed findings. Map each disputed Critical/Important finding to its technical rationale with verifiable evidence (file:line, command output). The reviewer treats this as UNTRUSTED and verifies each claim independently against the repository; it cannot waive requirements/todos or force a PASS on its own. Omit for a normal review round.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);
			if (state.mode !== "work") {
				throw new Error(
					`workflow_review only allowed in Work Mode (current: ${state.mode}).`,
				);
			}
			if (!state.workRunId) {
				throw new Error(
					"No active Work run. Enter Work Mode via /work or plan approval first.",
				);
			}

			const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);

			// Resolve the validated review cwd (active worktree or main checkout).
			const reviewCwd = resolveEffectiveCwd(ctx.cwd, state);
			const primaryCwd = ctx.cwd;

			// Approved Work: read the Final Plan + approved todos. Direct Work:
			// no plan; the reviewer uses Work-lifecycle requirements + current todos.
			const isApprovedWork = !!state.planPath;
			let planMarkdown: string | undefined;
			if (isApprovedWork) {
				planMarkdown = requirePlanMarkdown(ctx.cwd, state.planPath!);
			}

			// codeReview.enabled controls whether the unified review folds workspace
			// OCR findings into the reviewer task. It does not gate the tool itself.
			const includeOcr = config.codeReview.enabled;

			// Optional non-authoritative Work feedback on a prior round's disputed
			// findings. Normalized once (trim + 20k budget + blank→undefined) so the
			// task hash and the reviewer task share one identical value.
			const feedback = normalizeWorkFeedback(params.feedback);

			// ── Review round continuity ──
			// The reviewer is a FRESH agent every round and cannot see the previous
			// round's findings, so it re-derives the whole review from scratch each
			// time. Persist each round (verdict + output + OCR findings + diff
			// fingerprint + task-input hash) so the next round can re-disposition
			// prior findings instead of re-deriving, reuse cached OCR findings when
			// the diff is unchanged, and short-circuit a review whose inputs + diff
			// are identical to the last round. The verdict stays transient: this
			// lives in a session-scoped file, never in WorkflowState.
			const branch = ctx.sessionManager?.getBranch?.();
			const requirements = isApprovedWork
				? extractUserRequirements(branch, state.planStartEntryId)
				: extractUserRequirements(branch, state.workStartEntryId);
			const diffSnapshot = computeWorkspaceDiffSnapshot(reviewCwd);
			const todoHash = computeTodoHash(state.todos);
			const reviewModel = `${config.models.review.provider}/${config.models.review.model}`;
			// Snapshot the reviewer protocol text ONCE so the task-input hash and
			// the reviewer run share the same behavioral baseline; a protocol change
			// (e.g. the review_submit verdict migration) invalidates reuse of
			// rounds produced under the older protocol.
			const protocolText = buildImplementationReviewProtocolText();
			const taskInputHash = computeTaskInputHash({
				requirements,
				planMarkdown,
				approvedTodos: state.approvedTodos,
				todos: state.todos,
				includeOcr,
				reviewModel,
				protocolText,
				feedback,
			});
			const history = loadReviewHistory(ctx.cwd, sessionKey);
			const lastRound =
				history && history.workRunId === state.workRunId
					? history.rounds[history.rounds.length - 1]
					: undefined;
			const nextRound = (lastRound?.round ?? 0) + 1;

			const diffUnchanged =
				lastRound !== undefined &&
				!lastRound.deltaUnknown &&
				!diffSnapshot.unknown &&
				lastRound.diffFingerprint === diffSnapshot.fingerprint;

			let result: ReviewResult;
			let shortCircuited = false;
			let ocrCachedRound: number | undefined;
			if (diffUnchanged && lastRound.taskInputHash === taskInputHash) {
				// Same diff + same authoritative inputs as the last round — the
				// reviewer would reach the same verdict, so reuse it instead of
				// burning minutes on an identical re-review.
				shortCircuited = true;
				const prev = lastRound;
				result = {
					text:
						`⚠️ Short-circuited: the workspace diff and all review inputs are unchanged since review round ${prev.round} (verdict ${prev.verdict}). ` +
						`Re-running the independent reviewer would produce the same outcome, so this round reuses round ${prev.round}'s verdict without a new review.\n\n` +
						`Round ${prev.round} output:\n\n${prev.reviewerText}`,
					reviewerModel: prev.model,
					elapsedMs: 0,
					turns: prev.turns,
					toolCalls: prev.toolCalls,
					requestedTools: [],
					// No repository tools ran this round — do not fabricate usage.
					activeTools: [],
					unavailableTools: [],
					stopReason: "stop",
					verdict: prev.verdict,
					verdictReason: prev.verdictReason,
					madeRepoToolCall: prev.madeRepoToolCall,
					ocr: {
						enabled: includeOcr,
						findings: prev.ocrCount,
						counts: prev.ocrCounts,
						rawPath: prev.ocrRawPath,
					},
					ocrFindingsList: prev.ocrFindings,
				};
			} else {
				// OCR cache: when the diff is unchanged since the previous round, the
				// OCR findings are identical — reuse them instead of re-running the
				// expensive `ocr review` CLI.
				const cachedOcr =
					includeOcr && diffUnchanged && lastRound?.ocrEnabled
						? {
								findings: lastRound.ocrFindings,
								counts: lastRound.ocrCounts,
								rawPath: lastRound.ocrRawPath,
								fromRound: lastRound.round,
							}
						: undefined;
				ocrCachedRound = cachedOcr?.fromRound;

				const previousRound: PreviousReviewRoundInput | undefined = lastRound
					? {
							round: lastRound.round,
							verdict: lastRound.verdict,
							reviewerText: boundedHeadTail(
								lastRound.reviewerText,
								PREVIOUS_ROUND_TEXT_BUDGET,
							),
							changedFiles:
								lastRound.deltaUnknown || diffSnapshot.unknown
									? []
									: filesChangedSince(lastRound, diffSnapshot),
							deltaUnknown: lastRound.deltaUnknown || diffSnapshot.unknown,
							todosChanged: lastRound.todoHash !== todoHash,
							ocrCached: !!cachedOcr,
							ocrFindings: lastRound.ocrCount,
						}
					: undefined;

				try {
					result = await runReviewAgent({
						ctx,
						pi,
						modelSpec: config.models.review,
						branch,
						planStartEntryId: state.planStartEntryId,
						workStartEntryId: state.workStartEntryId,
						planMarkdown,
						approvedTodos: state.approvedTodos,
						currentTodos: state.todos,
						reviewCwd,
						primaryCwd,
						includeOcr,
						previousRound,
						cachedOcr,
						feedback,
						parentSignal: signal,
						onProgress: (text) => {
							onUpdate?.({
								content: [{ type: "text", text }],
								details: {},
							});
						},
					});
				} catch (err) {
					// Reviewer/OCR run failure (CLI missing, OCR exec failure, JSON parse
					// failure, timeout/abort/model error) surfaces as an explicit tool
					// error so the review loop does not treat it as success. No verdict is
					// produced. AbortError from a cancelled signal is rethrown so the
					// platform handles cancellation.
					if (err instanceof Error && err.name === "AbortError") throw err;
					const reason = err instanceof Error ? err.message : String(err);
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Review failed: ${reason}`,
							},
						],
						details: { ocrEnabled: includeOcr, error: true, reason },
					};
				}
			}

			// Persist this round so the next workflow_review call can carry its
			// findings/evidence forward (re-disposition instead of re-derive). A
			// failed write must not turn a successful review into an error — the
			// next round simply starts fresh.
			try {
				saveReviewRound(ctx.cwd, sessionKey, {
					workRunId: state.workRunId,
					round: nextRound,
					at: new Date().toISOString(),
					verdict: result.verdict,
					verdictReason: result.verdictReason,
					model: result.reviewerModel,
					elapsedMs: result.elapsedMs,
					turns: result.turns,
					toolCalls: result.toolCalls,
					madeRepoToolCall: result.madeRepoToolCall,
					reviewerText: result.text,
					ocrEnabled: includeOcr,
					ocrCount: result.ocr.findings,
					ocrCounts: result.ocr.counts,
					ocrRawPath: result.ocr.rawPath,
					ocrFindings: result.ocrFindingsList,
					diffFingerprint: diffSnapshot.fingerprint,
					deltaUnknown: diffSnapshot.unknown,
					fileHashes: diffSnapshot.fileHashes,
					untrackedHashes: diffSnapshot.untrackedHashes,
					todoHash,
					taskInputHash,
					shortCircuited,
				});
			} catch {
				// best-effort history persistence
			}

			// The verdict is transient: it only signals whether this on-demand
			// review loop can end. It is never written to WorkflowState and never
			// gates /commit. A PASS requires verdict === PASS AND the reviewer
			// actually inspected the repository (zero repo tool calls → fail-closed
			// FAIL surfaced for the Work agent to act on).
			const passed =
				result.verdict === "PASS" && result.madeRepoToolCall;

			const elapsedSec = Math.round(result.elapsedMs / 1000);
			const ops: string[] = [
				`reviewer: ${result.reviewerModel}${result.thinking ? ` / ${result.thinking}` : ""}`,
				`round: ${nextRound}${shortCircuited ? " (short-circuited: inputs + diff unchanged)" : ""}`,
				`elapsed: ${elapsedSec}s`,
				`turns: ${result.turns}`,
				`tool calls: ${result.toolCalls}`,
				`repo tool used: ${result.madeRepoToolCall ? "yes" : "NO"}`,
				`ocr: ${result.ocr.enabled ? `enabled (${result.ocr.findings} findings${ocrCachedRound !== undefined ? `, cached from round ${ocrCachedRound}` : ""})` : "disabled"}`,
				`verdict: ${result.verdict}${result.verdictReason ? ` (${result.verdictReason})` : ""}`,
			];
			if (result.unavailableTools.length) {
				ops.push(`unavailable tools: ${result.unavailableTools.join(", ")}`);
			}
			if (result.stopReason && result.stopReason !== "stop") {
				ops.push(`stopReason: ${result.stopReason}`);
			}
			if (result.errorMessage) {
				ops.push(`error: ${result.errorMessage}`);
			}

			let verdictNotice: string;
			if (passed) {
				verdictNotice = "\n\n✅ Review PASS. This on-demand review loop can end; the verdict is transient and never gates /commit.";
			} else if (result.verdict === "PASS" && !result.madeRepoToolCall) {
				verdictNotice = "\n\n❌ Verdict was PASS but the reviewer made no repository tool calls — treated as FAIL (no independent verification). Re-run after the reviewer inspects the repository.";
			} else {
				verdictNotice = "\n\n❌ Review did NOT pass. Address the Critical/Important findings, then re-run workflow_review(). /commit is always available regardless of the verdict.";
			}

			return {
				content: [
					{
						type: "text",
						text: `${result.text}${verdictNotice}\n\n---\n${ops.join(" | ")}`,
					},
				],
				details: {
					reviewerModel: result.reviewerModel,
					thinking: result.thinking,
					elapsedMs: result.elapsedMs,
					turns: result.turns,
					toolCalls: result.toolCalls,
					requestedTools: result.requestedTools,
					activeTools: result.activeTools,
					unavailableTools: result.unavailableTools,
					stopReason: result.stopReason,
					errorMessage: result.errorMessage,
					verdict: result.verdict,
					verdictReason: result.verdictReason,
					madeRepoToolCall: result.madeRepoToolCall,
					ocr: result.ocr,
					round: nextRound,
					shortCircuited,
					ocrCachedRound,
				},
				usage: result.usage,
			};
		},
	});
}

// ── Bulk registration / gating ──────────────────────────────────────

const _workflowToolsRegistered = new WeakSet<ExtensionAPI>();

// ── workflow_init_complete tool (Init Mode lifecycle close) ───────────────

const InitCompleteStatusSchema = StringEnum([
	"completed",
	"skipped",
	"cancelled",
] as const);

export function registerInitCompleteTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_init_complete",
		label: "Init Complete",
		description:
			"Close Init Mode: restore the prior mode after generating, skipping, or cancelling AGENTS.md. Init Mode only. Call once with status completed/skipped/cancelled.",
		parameters: Type.Object({
			status: InitCompleteStatusSchema,
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);

			if (state.mode !== "init") {
				throw new Error(
					`workflow_init_complete only allowed in Init Mode (current: ${state.mode}).`,
				);
			}

			const status = params.status as "completed" | "skipped" | "cancelled";
			const targetPath = state.initTargetPath;

			if (status === "completed") {
				if (!targetPath) {
					throw new Error(
						"workflow_init_complete(completed): no target AGENTS.md configured.",
					);
				}
				if (!fs.existsSync(targetPath)) {
					throw new Error(
						`workflow_init_complete(completed): target file does not exist: ${targetPath}`,
					);
				}
				const stat = fs.statSync(targetPath);
				if (!stat.isFile() || stat.size === 0) {
					throw new Error(
						`workflow_init_complete(completed): target must be a non-empty regular file: ${targetPath}`,
					);
				}
				// Best-effort re-validation against the single-file rule.
				const repoRoot = path.dirname(targetPath);
				const denial = isAllowedInitTargetPath(
					repoRoot,
					targetPath,
					targetPath,
				);
				if (denial) {
					throw new Error(
						`workflow_init_complete(completed): target failed validation: ${denial}`,
					);
				}
			}

			// initReturnMode is typed as "explore" | "plan" | "work" | "commit";
			// fall back to explore when missing.
			const returnMode: WorkflowState["mode"] = state.initReturnMode ?? "explore";

			const nextState: WorkflowState = {
				...state,
				mode: returnMode,
				initReturnMode: undefined,
				initTargetPath: undefined,
			};

			const result = await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState,
				getAgentDir,
			});
			if (!result.ok) {
				throw new Error(
					`workflow_init_complete: failed to restore mode: ${result.reason}`,
				);
			}

			return {
				content: [
					{
						type: "text",
						text: `Init Mode ${status}. Restored mode: ${returnMode}.`,
					},
				],
				details: { status, returnMode },
				terminate: true,
			};
		},
	});
}

/**
 * Register all workflow tools (todo, plan, plan review, code review).
 * Idempotent per ExtensionAPI instance — skips if already registered.
 */
export function registerAllWorkflowTools(
	pi: ExtensionAPI,
	getAgentDir: () => string,
	cwd: string,
	_ctx?: ExtensionContext,
): void {
	if (_workflowToolsRegistered.has(pi)) return;

	registerBashOverrideTool(pi, getAgentDir, cwd);
	registerTodoTool(pi, getAgentDir);
	registerPlanReadTool(pi, getAgentDir);
	registerPlanSaveTool(pi, getAgentDir);
	registerPlanApproveTool(pi, getAgentDir);
	registerPlanClearTool(pi, getAgentDir);
	registerGrillRecordTool(pi, getAgentDir);
	// Register optional definitions unconditionally. Trust-resolved config in
	// mode reconciliation controls visibility, and each execute/handler path
	// rechecks workflow/config gates with the real session context.
	registerPlanReviewTool(pi, getAgentDir);
	registerReviewTool(pi, getAgentDir);
	registerInitCompleteTool(pi, getAgentDir);

	_workflowToolsRegistered.add(pi);
}

/**
 * Idempotently register the update_plan RPC alias for Paseo's native
 * TodoListCard. Called from session_start (after ctx is available) because
 * alias registration needs ctx.mode, which is undefined at factory time.
 *
 * Collision-safe: if another extension already owns update_plan (detected
 * via sourceInfo fingerprint), skip registration and let the external tool
 * win; TUI stays on workflow_todo. Safe to call multiple times per
 * ExtensionAPI instance — no-op once this instance owns the alias and the
 * live tool still matches our fingerprint.
 */
export function ensureRpcAliasRegistered(
	pi: ExtensionAPI,
	getAgentDir: () => string,
	ctx: ExtensionContext | undefined,
): void {
	if (ctx?.mode !== "rpc") return;
	// Already owned and still live → nothing to do.
	if (isAliasOwned(pi)) return;
	// Another extension owns it → skip.
	if (isAliasConflicting(pi)) {
		console.warn(
			"[workflow] update_plan already registered by another extension; " +
				"RPC todo alias skipped, falling back to workflow_todo.",
		);
		return;
	}
	registerUpdatePlanTool(pi, getAgentDir);
	// Record ownership using the live tool's real sourceInfo fingerprint so
	// later conflict detection compares apples to apples. If the registry is
	// eventually consistent and the tool is not enumerable yet, leave ownership
	// unset so the next session_start re-registers cleanly instead of
	// recording an undefined fingerprint that would break isAliasOwned.
	const all = pi.getAllTools();
	const found = all.find((t) => t.name === UPDATE_PLAN_TOOL_NAME);
	if (!found) {
		// Registry eventually consistent: mark provisional ownership so the
		// next session_start's isAliasConflicting does not misclassify our own
		// tool as an external conflict. isAliasConflicting treats a registered
		// instance with no fingerprint as non-conflicting (optimistically ours),
		// allowing the next session_start to re-resolve and store the real
		// fingerprint once the tool becomes enumerable.
		markAliasRegistered(pi, undefined);
		console.warn(
			"[workflow] update_plan registered but not enumerable in getAllTools(); " +
				"ownership marked provisionally — fingerprint resolved on next session_start.",
		);
		return;
	}
	markAliasRegistered(pi, toolFingerprint(found));
}
