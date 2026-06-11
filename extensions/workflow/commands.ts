import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import { getSessionKey, loadState, saveState } from "./state.js";
import { COMMON_PROMPT, promptForMode } from "./prompts.js";
import {
	isWorkflowDataPath,
	isReadonlyMode,
	isLocalFileMutatingShell,
	isAllowedPlanScratchPath,
} from "./guards.js";
import { currentStatusText } from "./helpers.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { planDir } from "./paths.js";
import { loadConfig } from "./config.js";
import {
	applyModeRuntime,
	setCurrentTurnGuardMode,
	getCurrentTurnGuardMode,
	clearCurrentTurnGuardMode,
	deactivateWorkflowTools,
	transitionWorkflowMode,
	isWorkflowToolMode,
} from "./mode.js";
import { execSync } from "node:child_process";
import path from "node:path";

// ── /wf-init helpers ─────────────────────────────────────────────────────────

function isGitRepo(cwd: string): boolean {
	try {
		execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function getGitRoot(cwd: string): string {
	try {
		const root = execSync("git rev-parse --show-toplevel", {
			cwd,
			stdio: "pipe",
			encoding: "utf8",
		})
			.toString()
			.trim();
		return root;
	} catch {
		return cwd;
	}
}

function findExistingAgentsFile(root: string): string | null {
	const agMd = path.join(root, "AGENTS.md");
	const agMdLower = path.join(root, "agents.md");
	if (fs.existsSync(agMd)) return "AGENTS.md";
	if (fs.existsSync(agMdLower)) return "agents.md";
	return null;
}

function isProjectEmpty(root: string): boolean {
	const entries = fs.readdirSync(root, { withFileTypes: true });
	const meaningful = entries.filter((e) => !e.name.startsWith("."));
	return meaningful.length === 0;
}

// ── OCR review helpers ───────────────────────────────────────────────────────

import {
	type ReviewScope,
	scopeSelectorComponent,
	scopeInputComponent,
} from "./review-tui.js";

// ── Session key helper ───────────────────────────────────────────────────────

/**
 * Extract session key from ctx, bridging the ReadonlySessionManager → SessionKeySource gap.
 * ReadonlySessionManager.getSessionFile returns string | undefined,
 * but SessionKeySource expects string | null.
 */
function ctxSessionKey(ctx: any): string {
	return getSessionKey({
		getSessionId: () => ctx.sessionManager?.getSessionId?.(),
		getSessionFile: () => ctx.sessionManager?.getSessionFile?.() ?? null,
	});
}

// ── Event handlers ────────────────────────────────────────────────────────────

export function registerBeforeAgentStart(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const sessionKey = ctxSessionKey(ctx);
		let state = loadState(ctx.cwd, sessionKey);
		const config = loadConfig(ctx.cwd, getAgentDir());
		const workflowActive =
			(state.workflowEnabled || config.workflow.autoEnter) &&
			!state.workflowExplicitlyDisabled;

		// Hide done items at the start of each new turn.
		const overlay = getWorkflowOverlay();
		if (overlay) {
			overlay.hideDoneFromLastTurn();
		}

		// When workflow is not active, stay idle — no mode prompts, no guards.
		if (!workflowActive) {
			if (overlay) overlay.dispose();
			return;
		}

		let runtimeAppliedViaTransition = false;
		// Promote idle → explore through the unified transition path so
		// persisted mode, status line, runtime, and guards stay aligned.
		if (state.mode === "idle") {
			const result = await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState: { ...state, mode: "explore" },
				getAgentDir,
			});
			runtimeAppliedViaTransition = true;
			state = result.state;
			if (!result.ok) {
				ctx.ui.notify(result.reason, "error");
			}
		} else {
			// Set per-turn guard mode from persisted state
			setCurrentTurnGuardMode(sessionKey, state.mode);
		}

		if (overlay) {
			overlay.update(state.todos);
		}

		// Apply mode runtime (model/tools) for non-idle modes.
		if (!runtimeAppliedViaTransition) {
			await applyModeRuntime(pi, ctx, state.mode, getAgentDir);
		}

		// Inject system prompt
		const modePrompt = promptForMode(state.mode);
		if (!modePrompt) return;

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n" +
				COMMON_PROMPT +
				"\n\n" +
				modePrompt +
				"\n\n" +
				`# Current Workflow State\n` +
				currentStatusText(state) +
				"\n",
		};
	});
}

export function registerToolCallGuard(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.on("tool_call", async (event, ctx) => {
		const sessionKey = ctxSessionKey(ctx);
		const state = loadState(ctx.cwd, sessionKey);
		const config = loadConfig(ctx.cwd, getAgentDir());
		const workflowActive =
			(state.workflowEnabled || config.workflow.autoEnter) &&
			!state.workflowExplicitlyDisabled;

		// Use per-turn effective guard mode; fall back to state mode.
		const effectiveMode = getCurrentTurnGuardMode(sessionKey) ?? state.mode;

		// Block workflow tool calls outside workflow-enabled implementation modes.
		// This catches stale tool registrations and direct tool invocations.
		if (
			event.toolName === "workflow_plan" ||
			event.toolName === "workflow_todo" ||
			event.toolName === "workflow_plan_review" ||
			event.toolName === "workflow_code_review"
		) {
			if (!workflowActive) {
				return {
					block: true,
					reason:
						"Workflow is not enabled. Run /wf first to enable workflow tools.",
				};
			}
			if (!isWorkflowToolMode(effectiveMode)) {
				return {
					block: true,
					reason:
						"当前模式禁止 workflow 计划/Todo/审查工具，请用 /plan 进入 Plan Mode。",
				};
			}
			return;
		}

		// ── Plan directory protection: block write/edit to .pi/workflow/plan/ in all modes ──
		if (event.toolName === "write" || event.toolName === "edit") {
			const targetPath: string | undefined =
				(event.input as any)?.path ?? (event.input as any)?.filePath;

			if (targetPath) {
				// Block writes to .pi/workflow/ data directory
				if (isWorkflowDataPath(targetPath, ctx.cwd)) {
					return {
						block: true,
						reason:
							"Workflow data files (.pi/workflow/) must be operated via workflow tools, not with write/edit.",
					};
				}

				// Block writes to plan directory specifically
				const resolved = path.resolve(ctx.cwd, targetPath);
				const planDirAbs = path.resolve(ctx.cwd, ".pi", "workflow", "plan");
				if (
					resolved.startsWith(planDirAbs + path.sep) ||
					resolved === planDirAbs
				) {
					return {
						block: true,
						reason:
							"Plan files (.pi/workflow/plan/) must be updated via workflow_plan(action='save', markdown='完整计划内容'), " +
							"not with write/edit.",
					};
				}
			}
		}

		// Read-only modes: block local file mutations.
		if (isReadonlyMode(effectiveMode)) {
			if (event.toolName === "read") {
				const filePath: string | undefined =
					(event.input as any)?.path ?? (event.input as any)?.filePath;

				if (filePath && isWorkflowDataPath(filePath, ctx.cwd)) {
					return {
						block: true,
						reason:
							"Workflow data files (.pi/workflow/) must be read via workflow tools, not directly.",
					};
				}
				return;
			}

			if (event.toolName === "write" || event.toolName === "edit") {
				if (effectiveMode === "plan" || effectiveMode === "explore") {
					const targetPath: string | undefined =
						(event.input as any)?.path ?? (event.input as any)?.filePath;
					if (!targetPath) {
						return {
							block: true,
							reason: `${effectiveMode} Mode: write/edit requires an absolute path under the scratch root.`,
						};
					}
					const denial = isAllowedPlanScratchPath(ctx.cwd, targetPath);
					if (denial) {
						return { block: true, reason: `${effectiveMode} Mode: ${denial}` };
					}
					return;
				}

				return {
					block: true,
					reason: `当前是 ${effectiveMode}，禁止修改本地文件。联网搜索、读取、分析工具仍可使用。`,
				};
			}

			if (event.toolName === "bash") {
				const command = String(event.input?.command ?? "");

				if (isLocalFileMutatingShell(command)) {
					return {
						block: true,
						reason: `当前是 ${effectiveMode}，禁止执行会修改本地文件的 shell 命令：${command}`,
					};
				}
			}

			return;
		}

		// Commit mode: prevent direct code file edits.
		if (state.mode === "commit") {
			if (event.toolName === "write" || event.toolName === "edit") {
				return {
					block: true,
					reason: "Commit Mode 禁止修改代码文件。",
				};
			}

			return;
		}
	});
}

export function registerAgentEnd(
	pi: ExtensionAPI,
	_getAgentDir: () => string,
): void {
	pi.on("agent_end", async (_event, ctx) => {
		const sessionKey = ctxSessionKey(ctx);
		const state = loadState(ctx.cwd, sessionKey);

		// Clean up per-turn in-memory state.
		clearCurrentTurnGuardMode(sessionKey);

		// Update overlay with current todos
		const overlay = getWorkflowOverlay();
		if (overlay && state.mode !== "idle") {
			overlay.update(state.todos);
		}
	});
}

// ── /wf command ─────────────────────────────────────────────────────────────

export function registerWfCommand(
	pi: ExtensionAPI,
	_getAgentDir: () => string,
): void {
	pi.registerCommand("wf", {
		description: "进入 workflow 模式，启用 /plan /work /review /commit 等命令",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);
			const state = loadState(ctx.cwd, sessionKey);

			if (state.workflowEnabled) {
				ctx.ui.notify("Workflow 已启用。", "info");
				return;
			}

			state.workflowEnabled = true;
			state.workflowExplicitlyDisabled = false;
			state.mode = "explore";
			saveState(ctx.cwd, sessionKey, state);

			ctx.ui.notify("已进入 Workflow 模式（Explore）。正在重载扩展...", "info");
			await ctx.reload();
		},
	});
}

// ── Command registrations ────────────────────────────────────────────────────

const _workflowCommandsRegistered = new WeakSet<ExtensionAPI>();

/** Check whether workflow commands have already been registered for this session. */
export function isWorkflowCommandsRegistered(): boolean {
	// Legacy compat — WeakSet is the source of truth now.
	return false;
}

/**
 * Register all workflow slash commands except /wf (which is always registered).
 * Idempotent per ExtensionAPI instance — skips if already registered.
 */
export function registerAllWorkflowCommands(
	pi: ExtensionAPI,
	getAgentDir: () => string,
	cwd: string,
): void {
	if (_workflowCommandsRegistered.has(pi)) return;

	const config = loadConfig(cwd, getAgentDir());

	registerExploreCommand(pi, getAgentDir);
	registerPlanCommand(pi, getAgentDir);
	registerWorkCommand(pi, getAgentDir);
	if (config.codeReview.enabled) registerReviewCommand(pi, getAgentDir);
	registerCommitCommand(pi, getAgentDir);
	registerWfStatusCommand(pi, getAgentDir);
	registerWfResetCommand(pi);
	registerWfInitCommand(pi);
	registerWfExitCommand(pi);

	_workflowCommandsRegistered.add(pi);
}

export function registerExploreCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("explore", {
		description: "进入 Explore Mode：探索代码库、问答，权限等同 Plan Mode",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			const current = loadState(ctx.cwd, sessionKey);
			// Non-destructive: switch mode only — preserve plan/todos.
			// Also enable workflow in case the user ran /wf-exit earlier.
			const state: WorkflowState = {
				...current,
				workflowEnabled: true,
				workflowExplicitlyDisabled: false,
				mode: "explore",
			};

			const result = await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState: state,
				getAgentDir,
			});
			if (!result.ok) {
				ctx.ui.notify(result.reason, "error");
				return;
			}

			ctx.ui.notify("已进入 Explore Mode。准备探索代码库或回答问题。", "info");
		},
	});
}

export function registerPlanCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("plan", {
		description: "进入计划模式：头脑风暴、产出计划、等待确认",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			const current = loadState(ctx.cwd, sessionKey);
			const state: WorkflowState = {
				...DEFAULT_STATE,
				workflowEnabled: current.workflowEnabled,
				mode: "plan",
				planRunId: crypto.randomUUID(),
			};

			const overlay = getWorkflowOverlay();
			if (overlay) {
				overlay.clearBookkeeping();
				overlay.update(state.todos);
			}

			const result = await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState: state,
				getAgentDir,
			});
			if (!result.ok) {
				ctx.ui.notify(result.reason, "error");
				return;
			}

			ctx.ui.notify(
				"已进入 Plan Mode。直接描述需求；产出计划并确认后会自动转交 Work Mode。",
				"info",
			);
		},
	});
}

export function registerWorkCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("work", {
		description: "跳过计划，直接进入 Work Mode",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			const workArgs = args.trim();

			const current = loadState(ctx.cwd, sessionKey);
			const state: WorkflowState = {
				...DEFAULT_STATE,
				workflowEnabled: current.workflowEnabled,
				mode: "work",
				workRunId: crypto.randomUUID(),
			};

			const overlay = getWorkflowOverlay();
			if (overlay) {
				overlay.clearBookkeeping();
				overlay.update(state.todos);
			}

			const result = await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState: state,
				getAgentDir,
			});
			if (!result.ok) {
				ctx.ui.notify(result.reason, "error");
				return;
			}

			ctx.ui.notify("已进入 Work Mode。可以直接描述任务。", "info");

			if (workArgs) {
				pi.sendUserMessage(workArgs);
			}
		},
	});
}

// registerReviewCommand
// (function signatures on L483 and L644)
export function registerReviewCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("review", {
		description:
			"Select code review scope via TUI, then run the workflow_code_review loop",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const config = loadConfig(ctx.cwd, getAgentDir());
			if (!config.codeReview.enabled) {
				ctx.ui.notify(
					"Code review is not enabled. Set codeReview.enabled: true in config.",
					"error",
				);
				return;
			}

			// 1. Show scope selector
			const scopeKind = await ctx.ui.custom<ReviewScope["kind"] | null>(
				(_tui, theme, _kb, done) => scopeSelectorComponent(theme, done),
			);
			if (!scopeKind) {
				ctx.ui.notify("Review cancelled: no scope selected.", "info");
				return;
			}

			// 2. Collect scope-specific inputs
			if (scopeKind !== "workspace") {
				ctx.ui.notify(
					`Selected ${scopeKind} scope. Collecting input...`,
					"info",
				);
			}

			let from: string | undefined;
			let to: string | undefined;
			let commit: string | undefined;

			if (scopeKind === "range") {
				const values = await ctx.ui.custom<Record<string, string> | null>(
					(_tui, theme, _kb, done) => scopeInputComponent("range", theme, done),
				);
				from = values?.from;
				to = values?.to;
				if (!from || !to) {
					ctx.ui.notify("Review cancelled: from/to refs required.", "info");
					return;
				}
			}

			if (scopeKind === "commit") {
				const values = await ctx.ui.custom<Record<string, string> | null>(
					(_tui, theme, _kb, done) =>
						scopeInputComponent("commit", theme, done),
				);
				commit = values?.commit;
				if (!commit) {
					ctx.ui.notify("Review cancelled: commit hash required.", "info");
					return;
				}
			}

			// 3. Move the next agent turn into Work runtime so the review loop can
			// call workflow_code_review, edit files, and run tests when fixes are needed.
			const sessionKey = ctxSessionKey(ctx);
			const current = loadState(ctx.cwd, sessionKey);
			const state: WorkflowState = {
				...current,
				mode: "work",
				workRunId: current.workRunId ?? crypto.randomUUID(),
			};
			const result = await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState: state,
				getAgentDir,
			});
			if (!result.ok) {
				ctx.ui.notify(result.reason, "error");
				return;
			}

			// 4. Build prompt instructing the model to run the full review/fix loop.
			let scopeDescription: string;
			let toolArguments: string;
			switch (scopeKind) {
				case "workspace":
					scopeDescription =
						"workspace (unstaged + staged + untracked changes)";
					toolArguments = 'scope="workspace"';
					break;
				case "range":
					scopeDescription = `range from=${from} to=${to}`;
					toolArguments = `scope="range", from=${JSON.stringify(from)}, to=${JSON.stringify(to)}`;
					break;
				case "commit":
					scopeDescription = `commit=${commit}`;
					toolArguments = `scope="commit", commit=${JSON.stringify(commit)}`;
					break;
			}

			const promptText = `请执行 code review 循环。

Review scope: ${scopeDescription}

要求：
1. 调用 workflow_code_review，参数使用 ${toolArguments}；background 由你根据当前任务上下文填写，包含用户目标、本轮修改范围、关键约束、已运行测试和希望 reviewer 重点检查的风险点。
2. 收到 review 结果后，逐条验证每个 Critical/Important 问题是否真实存在。
3. 对确认存在的 Critical/Important 问题进行修复，并运行最相关测试验证。
4. 修复后再次调用 workflow_code_review，让 reviewer 基于更新后的代码重新审查；持续 review → fix → re-review，直到没有新的 Critical/Important 问题。
5. 如果你判断某个 reviewer 问题是误判、超出范围、投入产出比不合理或与项目约束冲突，在下一轮 background 中说明技术理由。
6. 第一轮 review 已经没有 Critical/Important 问题时，可以结束循环。2-3 轮后仍存在分歧时，停止并交给用户裁决。
7. Minor 问题按价值选择处理，不能阻塞 review 通过。`;

			ctx.ui.notify(`Starting code review loop: ${scopeDescription}.`, "info");
			pi.sendUserMessage(promptText);
		},
	});
}

export function registerCommitCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("commit", {
		description:
			"切到 commit 模型，根据当前 diff 生成 commit message 并直接提交",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			const state = {
				...loadState(ctx.cwd, sessionKey),
				mode: "commit" as const,
			};

			const result = await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState: state,
				getAgentDir,
			});
			if (!result.ok) {
				ctx.ui.notify(result.reason, "error");
				return;
			}

			const extra = args.trim()
				? `\n\n用户对 commit 的额外要求：${args.trim()}`
				: "";

			pi.sendUserMessage(
				`请查看当前 diff，生成合适的 commit message，并直接执行 git add 和 git commit。${extra}`,
			);
		},
	});
}

export function registerWfStatusCommand(
	pi: ExtensionAPI,
	_getAgentDir: () => string,
): void {
	pi.registerCommand("wf-status", {
		description: "显示当前轻量 workflow 状态",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			const state = loadState(ctx.cwd, sessionKey);

			const msg = currentStatusText(state);
			ctx.ui.notify(msg, "info");
		},
	});
}

export function registerWfExitCommand(pi: ExtensionAPI): void {
	pi.registerCommand("wf-exit", {
		description: "退出 workflow mode，恢复普通 Pi",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			const state = loadState(ctx.cwd, sessionKey);
			state.mode = "idle";
			state.workflowEnabled = false;
			state.workflowExplicitlyDisabled = true;

			await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState: state,
				getAgentDir: () => "",
				applyRuntime: false,
			});

			// Remove workflow tools from active set before reload so
			// the next turn starts clean.
			deactivateWorkflowTools(pi);

			const overlay = getWorkflowOverlay();
			if (overlay) overlay.dispose();

			ctx.ui.setStatus("lite-sp", undefined);
			ctx.ui.notify("已退出 workflow mode。正在重载扩展...", "info");
			await ctx.reload();
		},
	});
}

export function registerWfResetCommand(pi: ExtensionAPI): void {
	pi.registerCommand("wf-reset", {
		description: "清空 workflow 状态、plan 目录和 todo",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			const current = loadState(ctx.cwd, sessionKey);
			const state: WorkflowState = {
				...DEFAULT_STATE,
				workflowEnabled: current.workflowEnabled,
				workflowExplicitlyDisabled: current.workflowExplicitlyDisabled,
			};

			await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState: state,
				getAgentDir: () => "",
				applyRuntime: false,
			});

			const overlay = getWorkflowOverlay();
			if (overlay) overlay.dispose();

			const pdir = planDir(ctx.cwd);
			if (fs.existsSync(pdir)) {
				for (const entry of fs.readdirSync(pdir)) {
					fs.rmSync(path.join(pdir, entry));
				}
			}

			ctx.ui.setStatus("lite-sp", undefined);
			ctx.ui.notify("已清空 workflow 状态。", "info");
		},
	});
}

export function registerWfInitCommand(pi: ExtensionAPI): void {
	pi.registerCommand("wf-init", {
		description: "初始化 agent 工作区：确保 git 仓库存在，生成/更新 AGENTS.md",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			if (!isGitRepo(ctx.cwd)) {
				ctx.ui.notify("当前目录不是 git 仓库，正在执行 git init...", "info");
				try {
					execSync("git init", { cwd: ctx.cwd, stdio: "pipe" });
					ctx.ui.notify("git init 完成。", "info");
				} catch (err: any) {
					ctx.ui.notify(
						`git init 失败：${err?.stderr ?? err?.message ?? String(err)}`,
						"error",
					);
					return;
				}
			}

			const root = getGitRoot(ctx.cwd);
			const existingFile = findExistingAgentsFile(root);

			if (existingFile) {
				const filePath = path.join(root, existingFile);
				pi.sendUserMessage(
					`当前仓库已存在 ${existingFile} (${filePath})。\n\n` +
						`请向用户询问是否更新 AGENTS.md。ask_user_question 工具可用时使用该工具提问；` +
						`工具不可用时，用普通文本提供选项让用户手动回复。\n\n` +
						`选项：\n` +
						`1. 更新 AGENTS.md：读取当前内容并结合项目上下文更新。\n` +
						`2. 保持现状：不修改文件。\n\n` +
						`用户选择更新后，再询问更新方向，然后读取 ${filePath} 并写回更新后的内容。`,
				);
				return;
			}

			if (isProjectEmpty(root)) {
				pi.sendUserMessage(
					`当前仓库还没有实质项目文件。请先向用户收集生成 AGENTS.md 所需信息。\n\n` +
						`ask_user_question 工具可用时使用该工具提问；工具不可用时，用普通文本列出问题让用户手动输入。` +
						`需要收集：\n` +
						`1. 项目使用的编程语言和框架。\n` +
						`2. 代码风格和规范（如 eslint、prettier、rustfmt）。\n` +
						`3. 构建和测试命令（如 npm test、cargo test、pytest）。\n` +
						`4. 提交信息规范（如 conventional commits）。\n` +
						`5. 其他 agent 需要遵守的约定或限制。\n\n` +
						`收集完毕后，使用 write 工具将 AGENTS.md 写入 ${path.join(root, "AGENTS.md")}。`,
				);
				return;
			}

			const rootRel = root === ctx.cwd ? "仓库根目录" : `仓库根目录 (${root})`;
			pi.sendUserMessage(
				`请在 ${rootRel} 初始化 AGENTS.md。\n\n` +
					`请先探索项目上下文：README、docs、package/build/test 配置、目录结构、相关源码等。` +
					`探索后向用户确认生成方案：ask_user_question 工具可用时使用该工具提问；` +
					`工具不可用时，用普通文本提供选项让用户手动回复。\n\n` +
					`确认内容至少包含：\n` +
					`- 项目概述\n` +
					`- 构建/测试命令\n` +
					`- 代码风格/规范\n` +
					`- 目录约定\n` +
					`- 工作流规则（idle → plan → work → commit；plan review 使用内置 completeSimple 侧调用，code review 使用 OCR CLI）\n` +
					`- 提交规范\n` +
					`- 安全/禁止事项\n\n` +
					`用户确认后，使用 write 工具将内容写入 ${path.join(root, "AGENTS.md")}。`,
			);
		},
	});
}
