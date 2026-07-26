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
	readPlan,
} from "./state.js";
import { loadConfigForContext } from "./config.js";
import { todoDeltaText, todoSnapshotText } from "./helpers.js";
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
import { executePlanReviewSidecall } from "./sidecall.js";
import { transitionWorkflowMode } from "./mode.js";
import {
	WORK_APPROVAL_CUSTOM_TYPE,
	buildWorkHandoffBody,
	type WorkApprovalData,
} from "./helpers.js";
import { isAllowedInitTargetPath } from "./guards.js";
import * as path from "node:path";
import * as fs from "node:fs";
import {
	checkOcrAvailable,
	buildReviewArgv,
	ocrCommandSummary,
	runOcrReview,
	type ReviewScopeKind,
} from "./ocr-helpers.js";
import {
	parseOcrReviewJson,
	compactReviewText,
	compactPreviewText,
	OcrParseError,
} from "./ocr-result.js";

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
			let effectiveCwd = ctx.cwd;

			if (state.worktreePath) {
				const validation = validateWorktreeState(ctx.cwd, state);
				if (!validation.ok) {
					throw new Error(
						`Active worktree is invalid: ${validation.reason}. Run /wf-status or /wf-reset.`,
					);
				}
				effectiveCwd = state.worktreePath;
			}

			const bashTool = createBashTool(effectiveCwd);
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}

// ── Workflow-enabled guard ──────────────────────────────────────

/**
 * Check whether workflow is enabled for the current session.
 * Returns an error result if disabled, null if enabled.
 *
 * NOTE: This returns an error result rather than throwing because
 * it's a business precondition check (permission denied style).
 * The caller decides how to handle this non-error case.
 */
function checkWorkflowEnabled(
	ctx: any,
	getAgentDir: () => string,
): {
	isError: true;
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
} | null {
	try {
		const sessionKey = getSessionKey(ctx.sessionManager);
		const state = loadState(ctx.cwd, sessionKey);
		const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
		if (!state.workflowEnabled && !config.workflow.autoEnter) {
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
	} catch {
		return null; // If we can't check, allow through.
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

			if (params.action === "reset") {
				const overlay = getWorkflowOverlay();
				if (overlay) overlay.clearBookkeeping();

				state.todos = applyTodoAction(state.todos, {
					kind: "reset",
					items: params.items,
				});
				// reset replaces the whole list; report first item as the next delta.
				const first = state.todos[0];
				changedId = first?.id;
				changedTitle = first?.title;
				changedStatus = first?.status;
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
				content: [{ type: "text", text: todoDeltaText(state, { changedId, changedTitle, changedStatus, isAdd: deltaIsAdd }) }],
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
				content: [{ type: "text", text: todoDeltaText(state) }],
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

			const text = readPlan(ctx.cwd, state.planPath);

			return {
				content: [
					{
						type: "text",
						text: `Plan path: ${state.planPath}\n\n${text}`,
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

			if (!markdown) {
				throw new Error("workflow_plan_save requires markdown.");
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

			state.todos = [];
			state.hiddenDoneIds = [];
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
			};

			// Build the immutable handoff snapshot BEFORE transition so the
			// approval journal captures the exact plan content at approval time.
			const planMarkdown = readPlan(ctx.cwd, state.planPath);
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
				hiddenDoneIds: [],
				grillTurns: [],
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

// ── workflow_plan_review tool (sidecall-based) ──────────────

export function registerPlanReviewTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_plan_review",
		label: "Workflow Plan Review",
		description:
			"Request an independent plan review from a separately-configured reviewer model via a single LLM side-call. Plan Mode only. The reviewer receives the full plan text plus auto-extracted key file snippets, conversation summary, and tool inventory. Returns structured feedback with Critical/Important/Minor severity ratings.",
		parameters: Type.Object({
			task: Type.String({
				description:
					"Description of what to review (plan content or brief summary).",
			}),
			context: Type.Optional(Type.String()),
			instructions: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			// Read the active plan from file if available
			const state = loadState(ctx.cwd, getSessionKey(ctx.sessionManager));
			if (state.mode !== "plan") {
				throw new Error(
					`workflow_plan_review only allowed in Plan Mode (current: ${state.mode}).`,
				);
			}

			const sessionKey = getSessionKey(ctx.sessionManager);
			const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
			const planMarkdown = state.planPath
				? readPlan(ctx.cwd, state.planPath)
				: params.task;

			if (!planMarkdown) {
				throw new Error(
					"No plan content to review. Save a plan first or provide task text.",
				);
			}

			const extraContext = [
				(params.context as string | undefined) ?? "",
				(params.instructions as string | undefined) ?? "",
			]
				.filter(Boolean)
				.join("\n\n");

			return executePlanReviewSidecall(ctx, pi, {
				planMarkdown,
				extraContext: extraContext || undefined,
				modelSpec: config.models.planReview,
				signal,
			});
		},
	});
}

// ── Internal OCR constants (no longer configurable) ──────

export const OCR_BINARY = "ocr";
export const OCR_TIMEOUT_MS = 1_800_000;

/**
 * Compact argv summary that omits the --background value, so the model-visible
 * result does not echo the full background context back. Used in
 * model-visible content; the full `ocrCommandSummary` stays in error/details.
 */
function ocrScopeSummary(argv: string[]): string {
	const flags: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--background") {
			flags.push("--background <redacted>");
			i++; // skip value
			continue;
		}
		flags.push(a);
	}
	return [OCR_BINARY, ...flags].join(" ");
}

// ── workflow_code_review tool ────────────────────────────

const ReviewScopeKindSchema = StringEnum([
	"workspace",
	"range",
	"commit",
] as const);

export function registerCodeReviewTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_code_review",
		label: "Workflow Code Review",
		description:
			"Run OCR code review on the current workspace or a Git ref range/commit. Work Mode only, triggered by /review. Provide a background string describing the task context, changes, constraints, and risk areas. Default scope is workspace (staged + unstaged + untracked changes).",
		parameters: Type.Object({
			scope: Type.Optional(ReviewScopeKindSchema),
			background: Type.String({
				description:
					"Task context and review focus — user goal, changes, constraints, tests, risk areas.",
			}),
			from: Type.Optional(
				Type.String({ description: "Source ref for range scope." }),
			),
			to: Type.Optional(
				Type.String({ description: "Target ref for range scope." }),
			),
			commit: Type.Optional(
				Type.String({ description: "Commit hash for commit scope." }),
			),
			preview: Type.Optional(
				Type.Boolean({ description: "Preview files without running the LLM." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			// Validate OCR availability
			if (!checkOcrAvailable(OCR_BINARY)) {
				throw new Error(
					"ocr CLI not found. " +
						"Install alibaba/open-code-review: npm i -g @alibaba-group/open-code-review\n" +
						"Then configure LLM with ocr config set llm.url / llm.auth_token / llm.model.",
				);
			}

			// Validate required fields per scope
			const scope: ReviewScopeKind =
				(params.scope as ReviewScopeKind) ?? "workspace";
			const background = params.background as string;
			const from = params.from as string | undefined;
			const to = params.to as string | undefined;
			const commit = params.commit as string | undefined;
			const preview = params.preview as boolean | undefined;

			if (!background || !background.trim()) {
				throw new Error(
					"workflow_code_review requires a non-empty background describing task context and review focus.",
				);
			}

			if (scope === "range" && (!from || !to)) {
				throw new Error("scope=range requires both from and to refs.");
			}

			if (scope === "commit" && !commit) {
				throw new Error("scope=commit requires a commit hash.");
			}

			// Build argv and execute
			const argv = buildReviewArgv(
				background.trim(),
				scope,
				from,
				to,
				commit,
				preview,
			);
			const cmdSummary = ocrCommandSummary(OCR_BINARY, argv);
			// Compact summary for model-visible output: omits the full --background
			// value (kept in cmdSummary / details) to avoid echoing context back.
			const scopeSummary = ocrScopeSummary(argv);

			try {
				const rawOutput = await runOcrReview(
					OCR_BINARY,
					ctx.cwd,
					argv,
					OCR_TIMEOUT_MS,
					_signal,
				);

				// Preview output is ANSI text (ocr ignores --format json for preview);
				// compact it into a file list. Full review output is JSON parsed
				// into normalized findings with the raw JSON saved to a temp file.
				if (preview) {
					const previewText = compactPreviewText(rawOutput);
					return {
						content: [
							{
								type: "text",
								text: `Code review preview (files only, no LLM run).\n\n${previewText}`,
							},
						],
						details: {
							scope,
							preview: true,
						},
					};
				}

				let result;
				try {
					result = parseOcrReviewJson(rawOutput);
				} catch (parseErr) {
					// parseOcrReviewJson wraps all errors in OcrParseError carrying the
					// saved raw file path plus the real cause. Surface both so the model
					// can inspect the original output.
					const rawPath = parseErr instanceof OcrParseError ? parseErr.rawPath : "";
					const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
					return {
						content: [
							{
								type: "text",
								text:
									`Code review output could not be processed.` +
									(rawPath ? `\nRaw output saved to: ${rawPath}` : "") +
									`\nError: ${errMsg}` +
									`\n\nCommand: ${scopeSummary}`,
							},
						],
						details: {
							scope,
							parseError: true,
							rawPath,
							error: errMsg,
						},
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Code review complete.\n\n${compactReviewText(result)}`,
						},
					],
					details: {
						scope,
						counts: result.counts,
						findings: result.findings.length,
						rawPath: result.rawPath,
						sessionId: result.sessionId,
						stats: result.stats,
					},
				};
			} catch (err: unknown) {
				// AbortError from cancelled signal — rethrow so the platform handles cancellation
				if (err instanceof Error && err.name === "AbortError") throw err;

				const errMsg = err instanceof Error ? err.message : String(err);
				const stderr =
					typeof err === "object" && err !== null && "stderr" in err
						? (err as { stderr?: unknown }).stderr
						: "";
				throw new Error(
					`ocr review failed.\n\n` +
						`Command: ${cmdSummary}\n` +
						`Error: ${errMsg}\n` +
						`stderr: ${String(stderr).slice(0, 2000)}\n\n` +
						`Check ocr config and LLM connectivity: ocr llm test`,
				);
			}
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
	registerCodeReviewTool(pi, getAgentDir);
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
