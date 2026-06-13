import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { WORK_HANDOFF_RUNTIME_NOTICE, WORK_PROMPT } from "./prompts.js";
import { todoText } from "./helpers.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState } from "./types.js";
import { executePlanReviewSidecall } from "./sidecall.js";
import { transitionWorkflowMode } from "./mode.js";
import {
	checkOcrAvailable,
	buildReviewArgv,
	ocrCommandSummary,
	runOcrReview,
	type ReviewScopeKind,
} from "./ocr-helpers.js";

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
			"Maintain the lightweight workflow todo list for plan/work alignment.",
		promptSnippet:
			"workflow_todo: maintain the workflow todo list so implementation stays aligned with the plan.",
		promptGuidelines: [
			"Use workflow_todo to create and update the task list before and during implementation.",
			"Use workflow_todo status updates to keep implementation aligned with the approved plan.",
		],
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

// ── workflow_plan tool ────────────────────────────────────

export function registerPlanTool(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerTool({
		name: "workflow_plan",
		label: "Workflow Plan",
		description: "Save, approve, read, or clear the active workflow plan.",
		promptSnippet:
			"workflow_plan: save the active plan or approve it for implementation.",
		promptGuidelines: [
			"Use workflow_plan save after producing a final implementation plan.",
			"Use workflow_plan approve only after the user explicitly confirms the final plan.",
			"Use workflow_plan read to view the current plan.",
			"Use workflow_plan clear to reset workflow state.",
		],
		parameters: Type.Object({
			action: StringEnum(["save", "approve", "read", "clear"] as const),
			title: Type.Optional(Type.String()),
			markdown: Type.Optional(Type.String()),
		}),
		renderResult(result: any, _options: any, theme: any) {
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
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const denied = checkWorkflowEnabled(ctx, getAgentDir);
			if (denied) return denied;

			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);
			const { action } = params;

			if (action === "save") {
				if (!params.markdown) {
					throw new Error("workflow_plan save requires markdown.");
				}

				// Distinguish first save (new plan) vs revision save (update existing plan)
				const isRevision = !!state.planPath;
				if (isRevision) {
					// Revision: update existing plan file in-place
					updatePlan(ctx.cwd, state.planPath!, params.markdown);
					state.planTitle = params.title ?? state.planTitle ?? "Active Plan";
				} else {
					// First save: create new plan file
					const planPath = writeNewPlan(ctx.cwd, params.markdown);
					state.planPath = planPath;
					state.planTitle = params.title ?? "Active Plan";
					state.planRunId = crypto.randomUUID();
				}

				state.todos = [];
				state.hiddenDoneIds = [];
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
			}

			if (action === "approve") {
				if (!state.planPath) {
					throw new Error("No active plan. Save a plan first.");
				}

				if (state.mode !== "plan") {
					throw new Error(
						`Approve only allowed in Plan Mode (current: ${state.mode}).`,
					);
				}

				const nextState: WorkflowState = {
					...state,
					mode: "work",
					workRunId: crypto.randomUUID(),
				};

				const result = await transitionWorkflowMode({
					pi,
					ctx,
					sessionKey,
					nextState,
					getAgentDir,
				});

				if (!result.ok) {
					throw new Error(result.reason);
				}

				const handoffMessage =
					WORK_HANDOFF_RUNTIME_NOTICE +
					"\n\n" +
					WORK_PROMPT +
					"\n\n" +
					`已批准的计划在 ${result.state.planPath}. ` +
					`请用 workflow_plan(action="read") 读取计划和当前 workflow_todo 列表，按 todo 顺序开始实现。`;

				// Set session name for easier identification in /resume
				pi.setSessionName(`work: ${result.state.planTitle ?? "Active Plan"}`);

				pi.sendUserMessage(handoffMessage, { deliverAs: "followUp" });

				return {
					content: [
						{
							type: "text",
							text:
								`Plan approved. Work Mode runtime activated.\n` +
								`Work run: ${result.state.workRunId!.slice(-8)}.\n` +
								`A kick-off message has been queued. If it does not continue automatically, send a message to continue implementation. Do not call any more tools in this turn.`,
						},
					],
					details: { state: result.state },
					terminate: true,
				};
			}

			if (action === "read") {
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
			}

			if (action === "clear") {
				const cleared: WorkflowState = {
					workflowEnabled: state.workflowEnabled,
					workflowExplicitlyDisabled: state.workflowExplicitlyDisabled,
					mode: "idle",
					todos: [],
					hiddenDoneIds: [],
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
				};
			}

			return {
				content: [{ type: "text", text: "Unknown workflow_plan action." }],
				details: { state },
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
			"Request an independent plan review from a separately-configured reviewer model via a single LLM side-call. The reviewer receives the full plan text plus auto-extracted key file snippets, conversation summary, and tool inventory. Returns structured feedback with Critical/Important/Minor severity ratings.",
		promptSnippet:
			"workflow_plan_review: get an objective plan review from a reviewer model.",
		promptGuidelines: [
			"Use workflow_plan_review to get an objective plan review after saving a plan.",
			"Provide the plan content or a brief task description.",
			"Use context for extra background (user constraints, discussion points).",
			"Use instructions for review preferences (depth, focus areas).",
		],
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

			const config = loadConfig(ctx.cwd, getAgentDir());

			// Read the active plan from file if available
			const state = loadState(ctx.cwd, getSessionKey(ctx.sessionManager));
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
			"Run OCR code review on the current workspace or a Git ref range/commit. The model must provide a background string describing the task context, changes, constraints, and risk areas. Default review scope is workspace (staged + unstaged + untracked changes).",
		promptSnippet:
			"workflow_code_review: run ocr review with model-supplied context.",
		promptGuidelines: [
			"Use workflow_code_review when the /review command prompts a code review loop.",
			"Default scope to workspace unless the user explicitly requested range or commit.",
			"Provide a thoughtful background: user goal, actual changes, key constraints, tests run, and risk areas to check.",
		],
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

/** Check whether workflow tools have already been registered this session. */
export function isWorkflowToolsRegistered(): boolean {
	// Legacy compat — WeakSet is the source of truth now.
	return false;
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

	registerTodoTool(pi, getAgentDir);
	registerPlanTool(pi, getAgentDir);
	if (config.planReview.enabled) registerPlanReviewTool(pi, getAgentDir);
	if (config.codeReview.enabled) registerCodeReviewTool(pi, getAgentDir);

	_workflowToolsRegistered.add(pi);
}
