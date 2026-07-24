import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { loadConfig } from "./config.js";
import { todoText } from "./helpers.js";
import {
	createWorktree,
	deleteWorktreeBranch,
	plannedWorktreeInfo,
	removeWorktree,
	validateWorktreeState,
} from "./worktree.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState } from "./types.js";
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
		const config = loadConfig(ctx.cwd, getAgentDir());
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

			if (params.action === "reset") {
				const overlay = getWorkflowOverlay();
				if (overlay) overlay.clearBookkeeping();

				state.todos = (params.items ?? []).map((item: any, index: number) => ({
					id: item.id || `T${index + 1}`,
					title: item.title,
					status: item.status ?? "pending",
					notes: item.notes,
				}));
			}

			if (params.action === "add") {
				if (!params.title) {
					throw new Error("workflow_todo add requires title.");
				}

				state.todos.push({
					id: params.id ?? `T${state.todos.length + 1}`,
					title: params.title,
					status: params.status ?? "pending",
					notes: params.notes,
				});
			}

			if (params.action === "set") {
				const item = state.todos.find((todo) => todo.id === params.id);
				if (!item) {
					throw new Error(`Todo not found: ${params.id}`);
				}

				if (params.title) item.title = params.title;
				if (params.status) item.status = params.status;
				if (params.notes !== undefined) item.notes = params.notes;
			}

			saveState(ctx.cwd, sessionKey, state);

			const overlay = getWorkflowOverlay();
			if (overlay) overlay.update(state.todos);

			return {
				content: [{ type: "text", text: todoText(state) }],
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

const GrillDecisionStatusSchema = StringEnum([
	"resolved",
	"open",
	"needs-codebase-check",
] as const);

export function registerGrillRecordTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_grill_record",
		label: "Grill Record Turn",
		description:
			"Record one grilling decision during Plan Mode: a single question, its recommended answer, the user answer, and decision status. Call once per resolved question. Plan Mode only.",
		parameters: Type.Object({
			question: Type.String({
				description: "The exact question asked, one question only.",
			}),
			recommendedAnswer: Type.String({
				description: "The assistant's recommended answer to the question.",
			}),
			userAnswer: Type.Optional(
				Type.String({ description: "The user's answer, if already provided." }),
			),
			decisionStatus: GrillDecisionStatusSchema,
			notes: Type.Optional(
				Type.String({
					description: "Short rationale, dependency, or follow-up note.",
				}),
			),
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

			state.grillTurns.push({
				question: params.question,
				recommendedAnswer: params.recommendedAnswer,
				userAnswer: params.userAnswer as string | undefined,
				decisionStatus: params.decisionStatus as
					| "resolved"
					| "open"
					| "needs-codebase-check",
				notes: params.notes as string | undefined,
			});
			saveState(ctx.cwd, sessionKey, state);

			const summary = state.grillTurns
				.map(
					(t, i) =>
						`${i + 1}. [${t.decisionStatus}] ${t.question}`,
				)
				.join("\n");

			return {
				content: [
					{
						type: "text",
						text: `Recorded grill turn #${state.grillTurns.length} (status: ${params.decisionStatus}).\n\n${summary || "(no turns yet)"}`,
					},
				],
				details: { count: state.grillTurns.length, grillTurns: state.grillTurns },
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

			const config = loadConfig(ctx.cwd, getAgentDir());
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

			try {
				const rawOutput = await runOcrReview(
					OCR_BINARY,
					ctx.cwd,
					argv,
					OCR_TIMEOUT_MS,
					_signal,
				);

				return {
					content: [
						{
							type: "text",
							text:
								`Code review complete.\n\n` +
								`Command: ${cmdSummary}\n\n` +
								`${rawOutput || "(empty output)"}`,
						},
					],
					details: {
						command: cmdSummary,
						scope,
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
): void {
	if (_workflowToolsRegistered.has(pi)) return;

	const config = loadConfig(cwd, getAgentDir());

	registerBashOverrideTool(pi, getAgentDir, cwd);
	registerTodoTool(pi, getAgentDir);
	registerPlanReadTool(pi, getAgentDir);
	registerPlanSaveTool(pi, getAgentDir);
	registerPlanApproveTool(pi, getAgentDir);
	registerPlanClearTool(pi, getAgentDir);
	registerGrillRecordTool(pi, getAgentDir);
	if (config.planReview.enabled) registerPlanReviewTool(pi, getAgentDir);
	if (config.codeReview.enabled) registerCodeReviewTool(pi, getAgentDir);
	registerInitCompleteTool(pi, getAgentDir);

	_workflowToolsRegistered.add(pi);
}
