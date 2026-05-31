import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
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
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState } from "./types.js";
import { executePlanReviewSidecall } from "./sidecall.js";
import { applyModeRuntime } from "./mode.js";
import {
	checkOcrAvailable,
	buildReviewArgv,
	ocrCommandSummary,
	runOcrReview,
	type ReviewScopeKind,
} from "./ocr-helpers.js";

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
					return {
						isError: true,
						content: [
							{ type: "text", text: "workflow_todo add requires title." },
						],
						details: { todos: state.todos },
					};
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
					return {
						isError: true,
						content: [{ type: "text", text: `Todo not found: ${params.id}` }],
						details: { todos: state.todos },
					};
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionKey = getSessionKey(ctx.sessionManager);
			const state = loadState(ctx.cwd, sessionKey);
			const { action } = params;

			if (action === "save") {
				if (!params.markdown) {
					return {
						isError: true,
						content: [
							{ type: "text", text: "workflow_plan save requires markdown." },
						],
						details: { state },
					};
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
					return {
						isError: true,
						content: [
							{ type: "text", text: "No active plan. Save a plan first." },
						],
						details: { state },
					};
				}

				if (state.mode !== "plan") {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Approve only allowed in Plan Mode (current: ${state.mode}).`,
							},
						],
						details: { state },
					};
				}

				// Direct transition: plan → work — switch runtime and kick off immediately.
				state.mode = "work";
				state.workRunId = crypto.randomUUID();

				saveState(ctx.cwd, sessionKey, state);

				// Switch the model and tools to Work Mode now so the
				// follow-up message runs under the correct runtime.
				const runtimeApplied = await applyModeRuntime(
					pi,
					ctx,
					"work",
					getAgentDir,
				);
				if (!runtimeApplied) {
					// Roll back state so we don't leave a broken work mode.
					state.mode = "plan";
					state.workRunId = undefined;
					saveState(ctx.cwd, sessionKey, state);
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Plan approval could not complete because Work Mode runtime failed to activate. Please try approving again.",
							},
						],
						details: { state },
					};
				}

				// Queue a follow-up message that triggers the Work agent
				// to start implementing the approved plan.
				pi.sendUserMessage("请读取已批准的计划并开始 Work Mode 实现。", {
					deliverAs: "followUp",
				});

				return {
					content: [
						{
							type: "text",
							text:
								`Plan approved. Work Mode activated.\n` +
								`Work run: ${state.workRunId.slice(-8)}.\n` +
								`A kick-off message has been queued — the Work agent will start implementing next.`,
						},
					],
					details: { state },
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
					mode: "idle",
					todos: [],
					hiddenDoneIds: [],
				};
				saveState(ctx.cwd, sessionKey, cleared);

				const overlay = getWorkflowOverlay();
				if (overlay) overlay.dispose();

				return {
					content: [{ type: "text", text: "Workflow state cleared." }],
					details: { state: cleared },
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
			const config = loadConfig(ctx.cwd, getAgentDir());

			// Read the active plan from file if available
			const state = loadState(ctx.cwd, getSessionKey(ctx.sessionManager));
			const planMarkdown = state.planPath
				? readPlan(ctx.cwd, state.planPath)
				: params.task;

			if (!planMarkdown) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "No plan content to review. Save a plan first or provide task text.",
						},
					],
					details: {},
				};
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
			"Use workflow_code_review when completing work to review changes.",
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
			// Validate OCR availability
			if (!checkOcrAvailable(OCR_BINARY)) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text:
								`ocr CLI not found. ` +
								"Install alibaba/open-code-review: npm i -g @alibaba-group/open-code-review\n" +
								"Then configure LLM with ocr config set llm.url / llm.auth_token / llm.model.",
						},
					],
					details: {},
				};
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
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "workflow_code_review requires a non-empty background describing task context and review focus.",
						},
					],
					details: {},
				};
			}

			if (scope === "range" && (!from || !to)) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "scope=range requires both from and to refs.",
						},
					],
					details: {},
				};
			}

			if (scope === "commit" && !commit) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "scope=commit requires a commit hash.",
						},
					],
					details: {},
				};
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
				return {
					isError: true,
					content: [
						{
							type: "text",
							text:
								`ocr review failed.\n\n` +
								`Command: ${cmdSummary}\n` +
								`Error: ${errMsg}\n` +
								`stderr: ${String(stderr).slice(0, 2000)}\n\n` +
								`Check ocr config and LLM connectivity: ocr llm test`,
						},
					],
					details: { command: cmdSummary, error: errMsg },
				};
			}
		},
	});
}
