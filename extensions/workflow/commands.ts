import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import { getSessionKey, loadState, saveState, acquireDispatcherLock, releaseDispatcherLock } from "./state.js";
import { COMMON_PROMPT } from "./prompts.js";
import {
	isWorkflowDataPath,
	isReadonlyMode,
	isAllowedPlanScratchPath,
	isAllowedInitTargetPath,
	isInsideWorktree,
} from "./guards.js";
import {
	buildModeMessageBody,
	currentStatusText,
	isWorkflowActive,
	WORK_HANDOFF_CUSTOM_TYPE,
} from "./helpers.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { planDir } from "./paths.js";
import { loadConfigForContext, resolveConfigSources } from "./config.js";
import { PASEO_VERIFIED_VERSION } from "./todo-compat.js";
import {
	setRole,
	modeRole,
	restoreModeRuntime,
	activateWorkflowToolsIfAllowed,
	setCurrentTurnGuardMode,
	getCurrentTurnGuardMode,
	clearCurrentTurnGuardMode,
	deactivateWorkflowTools,
	setWorkflowStatus,
	transitionWorkflowMode,
	isWorkflowToolMode,
	workflowManagedToolNames,
	computeWorkflowToolNames,
	resolveTodoToolName,
} from "./mode.js";
import { execSync } from "node:child_process";
import path from "node:path";
import {
	deleteWorktreeBranch,
	gitStatusInWorktree,
	removeWorktree,
	validateWorktreeState,
} from "./worktree.js";

/** Read the session branch. Returns undefined on failure (fail-open). */
function getSessionBranch(ctx: unknown): any[] | undefined {
	try {
		return (
			(ctx as {
				sessionManager?: {
					getBranch?: () => any[];
				};
			}).sessionManager?.getBranch?.()
		);
	} catch {
		return undefined;
	}
}

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

function isProjectEmpty(root: string, agentsFile: string | null): boolean {
	// Workflow-only scaffolding and an existing AGENTS.md do not count as
	// project evidence; everything else (including .github, .vscode, etc.) does.
	const ignore = new Set([".git", ".pi"]);
	if (agentsFile) {
		// agentsFile may be a top-level filename ("AGENTS.md") or a nested path
		// ("docs/AGENTS.md"); ignore the top-level entry so the whole container
		// is excluded from the emptiness check.
		const top = agentsFile.includes(path.sep)
			? agentsFile.slice(0, agentsFile.indexOf(path.sep))
			: agentsFile;
		ignore.add(top);
	}
	const entries = fs.readdirSync(root, { withFileTypes: true });
	const meaningful = entries.filter((e) => !ignore.has(e.name));
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
		let state: WorkflowState;
		let config;
		try {
			state = loadState(ctx.cwd, sessionKey);
			config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
		} catch (e) {
			console.error(`[workflow] before_agent_start failed to load state/config: ${e instanceof Error ? e.message : e}`);
			return { systemPrompt: event.systemPrompt };
		}
		const workflowActive = isWorkflowActive(state, config);

		// Hide done items at the start of each new turn.
		const overlay = getWorkflowOverlay();
		if (overlay) {
			overlay.hideDoneFromLastTurn();
		}

		if (!workflowActive) {
			if (overlay) overlay.dispose();
			return;
		}

		// Set per-turn guard mode from persisted state so tool_call guards see
		// the active mode even before any transition happens this turn.
		setCurrentTurnGuardMode(sessionKey, state.mode);

		if (overlay) {
			overlay.update(state.todos);
		}

		// Restore workflow tools for the current mode without forcing a role
		// switch, so manual /model, Ctrl+P, and Shift+Tab selections made in
		// the current workflow mode survive across turns. When Pi has no
		// active model (ctx.model undefined), restoreModeRuntime falls back to
		// the role config. Reconciliation short-circuits when the active set
		// already matches, so this is cheap on the steady-state path.
		if (state.mode === "idle") {
			// session_start normally promotes idle→explore; reaching here in idle
			// means the transition failed. Log so the degradation is observable —
			// buildModeMessageBody returns undefined for idle, so the context handler
			// will inject no mode prompt this turn.
			console.warn(
				"[workflow] before_agent_start: mode is idle despite workflow being active; session_start transition may have failed",
			);
		}
		await restoreModeRuntime(pi, ctx, state.mode, getAgentDir);

		// Build stable system prompt: COMMON + Mode Prompt + worktree notice.
		// No dynamic state (todos, run IDs) — those come from tool results.
		const modeBody = buildModeMessageBody(state.mode, state, resolveTodoToolName(pi));
		const systemPrompt = modeBody
			? event.systemPrompt + "\n\n" + COMMON_PROMPT + "\n\n" + modeBody
			: event.systemPrompt + "\n\n" + COMMON_PROMPT;

		return { systemPrompt };
	});
}

/**
 * Inject the latest mode prompt and workflow state as an ephemeral hidden
 * custom message before every provider request. Filters out historical
 * workflow-mode messages (including persisted ones from older versions) and
 * appends one current message when workflow is active.
 */
export function registerWorkflowContextInjection(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.on("context", async (event, ctx) => {
		try {
			const sessionKey = ctxSessionKey(ctx);
			const state = loadState(ctx.cwd, sessionKey);
			const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
			const workflowActive = isWorkflowActive(state, config);

			// Step 1: Clean legacy workflow-mode messages from all modes.
			let messages = event.messages.filter((message) => {
				if (
					message &&
					typeof message === "object" &&
					"customType" in message &&
					(message as { customType?: unknown }).customType === "workflow-mode"
				) {
					return false;
				}
				return true;
			});

			if (!workflowActive) return { messages };

			// Step 2: Approved Work isolation via marker fast path.
			const isApprovedWork =
				state.mode === "work" && !!state.workRunId && !!state.planPath;

			if (isApprovedWork) {
				const { isolateWorkContext } = await import("./work-context.js");
				const isolated = isolateWorkContext(messages, state.workRunId!);
				if (isolated) {
					// Fast path succeeded — marker visible, pairing valid.
					return { messages: isolated };
				}

				// Marker not visible or pairing broken — attempt branch recovery.
				const branch = getSessionBranch(ctx);
				if (branch) {
					const { findApprovalJournalIndex, findCanonicalMarkerIndex } =
						await import("./work-context.js");
					const journalIdx = findApprovalJournalIndex(branch, state.workRunId!);
					if (journalIdx !== -1) {
						const markerIdx = findCanonicalMarkerIndex(branch, state.workRunId!, journalIdx);
						if (markerIdx !== -1) {
							// Marker exists in branch but not in provider messages
							// (compacted away). Reconstruct handoff at head.
							const markerEntry = branch[markerIdx];
							const handoffContent = (markerEntry as any).message?.content ??
								(markerEntry as any).content;
							if (handoffContent) {
								// Strip compaction/branch summaries and leading orphans,
								// prepend handoff snapshot.
								const cleaned = messages.filter((m) => {
									const role = (m as any).role;
									return role !== "compactionSummary" && role !== "branchSummary";
								});
								const { dropLeadingOrphanToolResults, validateToolPairing } =
									await import("./work-context.js");
								const stripped = dropLeadingOrphanToolResults(cleaned);
								const candidate = [
									{
										role: "custom" as const,
										customType: WORK_HANDOFF_CUSTOM_TYPE,
										content: handoffContent,
										display: false,
										details: { workRunId: state.workRunId, boundary: true },
										timestamp: Date.now(),
									},
									...stripped,
								];
								if (validateToolPairing(candidate)) {
									return { messages: candidate };
								}
								// Pairing broken — fail-open below.
							}
						}
						// Journal exists but no marker — pending dispatcher will
						// handle. Use journal handoffBody as ephemeral head.
						const journalEntry = branch[journalIdx];
						const journalData = (journalEntry as any).data as
							| { handoffBody?: string }
							| undefined;
						if (journalData?.handoffBody) {
							const candidate = [
								{
									role: "custom" as const,
									customType: WORK_HANDOFF_CUSTOM_TYPE,
									content: journalData.handoffBody,
									display: false,
									details: { workRunId: state.workRunId, boundary: false },
									timestamp: Date.now(),
								},
								...messages,
							];
							return { messages: candidate };
						}
					}
				}

				// Full fail-open: marker/journal unavailable or pairing broken.
				// Inject a hidden recovery warning so the model stops execution,
				// blocks the current todo, and asks the user to run /plan —
				// rather than silently continuing without the plan contract.
				console.error(
					"[workflow] work context isolation fail-open: marker/journal unavailable or pairing broken",
				);
				const recoveryWarning =
					"# Approved-Plan Work Recovery Warning\n\n" +
					"计划恢复失败：handoff marker 与 approval journal 均不可用或配对失效。\n" +
					"立即停止执行：将当前 workflow_todo 标记为 blocked，不要继续修改文件，\n" +
					"并向用户报告冲突，请用户执行 /plan 修订计划。不要自行切换模式或调用 workflow_plan_save。";
				return {
					messages: [
						{
							role: "user" as const,
							content: recoveryWarning,
							display: false,
							timestamp: Date.now(),
						},
						...messages,
					],
				};
			}

			// Step 3: Direct Work / other modes — clean old handoff messages.
			messages = messages.filter((message) => {
				if (
					message &&
					typeof message === "object" &&
					"customType" in message &&
					(message as { customType?: unknown }).customType === WORK_HANDOFF_CUSTOM_TYPE
				) {
					return false;
				}
				return true;
			});

			return { messages };
		} catch (err) {
			console.error(`[workflow] context injection failed: ${err}`);
			return { messages: event.messages };
		}
	});
}

// ── Pending Work kickoff dispatcher ──────────────────────────────────────────

/** In-process mutex: session keys currently executing the dispatcher. */
const _dispatcherInFlight = new Set<string>();

/**
 * Register the agent_settled handler that starts the new Work run after
 * Plan approval. Also exports a callable for the session_start resume path.
 */
export function registerPendingWorkDispatcher(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.on("agent_settled", async (_event, ctx) => {
		await runPendingWorkDispatcher(pi, ctx, getAgentDir);
	});
}

/**
 * Core dispatcher logic, callable from both agent_settled and session_start
 * resume. Implements the full locked-section protocol:
 * claim lock → reload state → reload branch → recheck idle/pending →
 * compute decision → side effect → release lock.
 */
export async function runPendingWorkDispatcher(
	pi: ExtensionAPI,
	ctx: any,
	getAgentDir: () => string,
): Promise<void> {
	const sessionKey = ctxSessionKey(ctx);

	// Fast pre-check before acquiring lock.
	if (!ctx.isIdle?.() || ctx.hasPendingMessages?.()) return;

	// In-process mutex.
	if (_dispatcherInFlight.has(sessionKey)) return;
	_dispatcherInFlight.add(sessionKey);

	try {
		// Cross-process advisory lock.
		if (!acquireDispatcherLock(ctx.cwd, sessionKey)) return;

		try {
			// Locked section: reload everything and recheck.
			const state = loadState(ctx.cwd, sessionKey);
			const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
			const workflowActive = isWorkflowActive(state, config);
			if (!workflowActive) return;

			// Recheck idle/pending under lock.
			if (!ctx.isIdle?.() || ctx.hasPendingMessages?.()) return;

			const branch = getSessionBranch(ctx);

			const { computeDispatcherDecision, executeDispatcherDecision } =
				await import("./work-context.js");

			const decision = computeDispatcherDecision(state, branch);
			if (decision.action === "skip") return;

			// Build ports bound to this session.
			const ports = {
				loadState: () => loadState(ctx.cwd, sessionKey),
				getBranch: () => getSessionBranch(ctx),
				isIdle: () => ctx.isIdle?.() ?? false,
				hasPendingMessages: () => ctx.hasPendingMessages?.() ?? false,
				writeMarker: (handoffBody: string, workRunId: string) => {
					pi.sendMessage(
						{
							customType: WORK_HANDOFF_CUSTOM_TYPE,
							content: handoffBody,
							display: false,
							details: { workRunId, boundary: true },
						},
						{},
					);
				},
				sendKickoff: (workRunId: string) => {
					pi.sendUserMessage(
						`<!-- workflow-work-kickoff:${workRunId} -->\n\n` +
							`Plan已批准，开始执行 Approved-Plan Work。按 workflow_todo 和 Final Plan 推进。`,
					);
				},
				clearPending: () => {
					const s = loadState(ctx.cwd, sessionKey);
					saveState(ctx.cwd, sessionKey, { ...s, pendingWorkKickoff: undefined });
				},
				appendLateSnapshot: (handoffBody: string, workRunId: string) => {
					pi.sendMessage(
						{
							customType: WORK_HANDOFF_CUSTOM_TYPE,
							content: handoffBody,
							display: false,
							details: { workRunId, boundary: false, late: true },
						},
						{},
					);
				},
			};

			executeDispatcherDecision(decision, ports);

			if (decision.action === "late_user_no_replay") {
				console.warn(
					`[workflow] pending work kickoff skipped: late user detected (workRunId: ${state.workRunId?.slice(-8)}). Context will fail-open.`,
				);
			}
		} finally {
			releaseDispatcherLock(ctx.cwd, sessionKey);
		}
	} finally {
		_dispatcherInFlight.delete(sessionKey);
	}
}

export function registerToolCallGuard(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	// Design note: this guard keeps only the stable, low-false-positive path
	// invariants (workflow-data files, plan files, Explore/Plan scratch,
	// Init single-file target, worktree containment, Commit write/edit block).
	// Bash/Git mutation in read-only modes is governed by mode prompts rather
	// than a subcommand scanner: the previous isLocalFileMutatingShell()
	// approach produced too many false positives (e.g. matching `rg` args that
	// happened to contain `black`/`rustfmt`) and could not reliably classify
	// aliases, wrappers, or `git -C`. Prompt-based enforcement accepts that a
	// model can ignore instructions in exchange for not breaking legitimate
	// read-only workflows.
	pi.on("tool_call", async (event, ctx) => {
		const sessionKey = ctxSessionKey(ctx);
		let state: WorkflowState;
		let config;
		try {
			state = loadState(ctx.cwd, sessionKey);
			config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
		} catch (e) {
			console.error(`[workflow] tool_call guard failed to load state/config: ${e instanceof Error ? e.message : e}`);
			return; // pass-through: don't block on internal error
		}
		const workflowActive = isWorkflowActive(state, config);

		// Use per-turn effective guard mode; fall back to state mode.
		const effectiveMode = getCurrentTurnGuardMode(sessionKey) ?? state.mode;

		// Block workflow-owned tool calls outside workflow-enabled implementation
		// modes. update_plan participates only while its live sourceInfo proves
		// ownership; an external tool with that name remains outside this guard.
		const todoToolName = resolveTodoToolName(pi);
		if (workflowManagedToolNames(pi).has(event.toolName)) {
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
					reason: `当前模式(${effectiveMode})禁止使用 ${event.toolName}。请用 /plan 进入 Plan Mode 或 /work 进入 Work Mode。`,
				};
			}
			if (
				!computeWorkflowToolNames(effectiveMode, config, todoToolName).includes(
					event.toolName,
				)
			) {
				return {
					block: true,
					reason: `当前模式不可使用 ${event.toolName}。`,
				};
			}
			return;
		}

		// ── Workflow data protection: block direct read to .pi/workflow/ in all modes ──
		// Workflow data is only accessible via workflow tools (plan save/read,
		// approval journal, /wf-status). This read guard is mode-independent so Work
		// and Commit also cannot bypass it with direct read calls. write/edit
		// protection lives in the dedicated block below.
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
							"Plan files (.pi/workflow/plan/) must be updated via workflow_plan_save(markdown='完整计划内容'), " +
							"not with write/edit.",
					};
				}
			}
		}

		// Worktree-bound Work Mode: code writes must stay inside the active worktree.
		if (
			effectiveMode === "work" &&
			state.worktreePath &&
			(event.toolName === "write" || event.toolName === "edit")
		) {
			const targetPath: string | undefined =
				(event.input as any)?.path ?? (event.input as any)?.filePath;
			if (!targetPath) {
				return {
					block: true,
					reason: `Worktree mode: write/edit requires an absolute path under ${state.worktreePath}.`,
				};
			}

			const validation = validateWorktreeState(ctx.cwd, state);
			if (!validation.ok) {
				return {
					block: true,
					reason: `Active worktree is invalid: ${validation.reason}. Run /wf-status or /wf-reset.`,
				};
			}

			const worktreeDenial = isInsideWorktree(
				state.worktreePath,
				targetPath,
			);
			if (!worktreeDenial) return;

			return {
				block: true,
				reason:
					`Worktree mode: ${worktreeDenial} ` +
					`Use an absolute path under ${state.worktreePath}.`,
			};
		}

		// Init Mode: only the recorded AGENTS.md target may be written/edited.
		// Must run before the generic readonly branch (init is in isReadonlyMode)
		// so that the init-specific file exception takes priority.
		if (effectiveMode === "init" &&
			(event.toolName === "write" || event.toolName === "edit")) {
			const targetPath: string | undefined =
				(event.input as any)?.path ?? (event.input as any)?.filePath;
			const repoRoot =
				state.initTargetPath
					? path.dirname(state.initTargetPath)
					: ctx.cwd;
			const denial = isAllowedInitTargetPath(
				repoRoot,
				state.initTargetPath,
				targetPath,
			);
			if (denial) {
				return { block: true, reason: denial };
			}
			return;
		}

		// Read-only modes: block local file mutations.
		if (isReadonlyMode(effectiveMode)) {
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
	getAgentDir: () => string,
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

			// Set session name for easier identification in /resume
			pi.setSessionName("workflow: explore");

			// Apply Explore runtime before reload so the first entry uses the
			// explore role config. workflow tools may not be registered yet at this
			// point; setActiveTools ignores unregistered names, and session_start
			// reconciles the tool set once registration completes after reload.
			setWorkflowStatus(ctx, "explore");
			setCurrentTurnGuardMode(sessionKey, "explore");
			const runtimeOk = await setRole(pi, ctx, "explore", getAgentDir);
			if (runtimeOk) {
				activateWorkflowToolsIfAllowed(pi, ctx.cwd, getAgentDir, "explore", ctx);
			} else {
				// Unlike restoreModeRuntime, do not best-effort reconcile tools here
				// when setRole fails: workflow tools may not be registered yet at
				// this point, and session_start (post-reload) reconciles them
				// unconditionally via restoreModeRuntime once registration completes.
				console.warn(
					"[workflow] /wf: explore role runtime failed to apply; continuing with reload to register workflow commands/tools",
				);
			}

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
	_cwd: string,
): void {
	if (_workflowCommandsRegistered.has(pi)) return;

	registerExploreCommand(pi, getAgentDir);
	registerPlanCommand(pi, getAgentDir);
	registerWorkCommand(pi, getAgentDir);
	// Register the command definition unconditionally. The handler resolves
	// codeReview.enabled with the real trusted session context before running.
	registerReviewCommand(pi, getAgentDir);
	registerCommitCommand(pi, getAgentDir);
	registerWfStatusCommand(pi, getAgentDir);
	registerWfResetCommand(pi);
	registerWfInitCommand(pi, getAgentDir);
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

			// Set session name for easier identification in /resume
			pi.setSessionName("workflow: plan");

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
			if (current.worktreePath) {
				const validation = validateWorktreeState(ctx.cwd, current);
				if (!validation.ok) {
					ctx.ui.notify(
						`Active worktree is invalid: ${validation.reason}. Run /wf-status or /wf-reset.`,
						"error",
					);
					return;
				}
			}

			const state: WorkflowState = {
				...DEFAULT_STATE,
				workflowEnabled: current.workflowEnabled,
				mode: "work",
				workRunId: current.worktreePath
					? current.workRunId ?? crypto.randomUUID()
					: crypto.randomUUID(),
				worktreePath: current.worktreePath,
				worktreeBranch: current.worktreeBranch,
				worktreeBaseBranch: current.worktreeBaseBranch,
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

			const sessionName = workArgs
				? `work: ${workArgs.slice(0, 40)}`
				: "workflow: work";
			pi.setSessionName(sessionName);

			ctx.ui.notify("已进入 Work Mode。可以直接描述任务。", "info");

			// Worktree notice is injected into the stable system prompt by
			// buildModeMessageBody; do not repeat it in the kickoff message.
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

			const sessionKey = ctxSessionKey(ctx);
			const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
			if (!config.codeReview.enabled) {
				ctx.ui.notify(
					"Code review is not enabled. Set codeReview.enabled: true in config.",
					"error",
				);
				return;
			}

			// JSON/print: no UI surface; stderr keeps stdout protocol/print output clean.
			if (ctx.mode === "json" || ctx.mode === "print") {
				console.error(
					"workflow review: /review requires interactive mode (TUI/RPC). " +
						"In JSON/print mode, call workflow_code_review directly: " +
						"scope (workspace|range|commit), background, from, to, commit, preview.",
				);
				return;
			}

			// RPC mode: basic-dialog wizard (select scope, input refs).
			if (ctx.mode === "rpc") {
				const scopeKind = await ctx.ui.select(
					"Review Scope — pick what to review",
					["workspace", "range", "commit"],
				);
				if (!scopeKind) {
					ctx.ui.notify("Review cancelled: no scope selected.", "info");
					return;
				}

				let from: string | undefined;
				let to: string | undefined;
				let commit: string | undefined;

				if (scopeKind === "range") {
					from = await rpcReadNonEmptyRef(ctx, "From ref");
					if (from === undefined) return;
					if (!from) {
						ctx.ui.notify("Review cancelled: from ref cannot be empty.", "info");
						return;
					}
					to = await rpcReadNonEmptyRef(ctx, "To ref");
					if (to === undefined) return;
					if (!to) {
						ctx.ui.notify("Review cancelled: to ref cannot be empty.", "info");
						return;
					}
				}

				if (scopeKind === "commit") {
					commit = await rpcReadNonEmptyRef(ctx, "Commit hash");
					if (commit === undefined) return;
					if (!commit) {
						ctx.ui.notify("Review cancelled: commit hash cannot be empty.", "info");
						return;
					}
				}

				if (scopeKind !== "workspace" && scopeKind !== "range" && scopeKind !== "commit") {
					ctx.ui.notify(`Review cancelled: unknown scope "${scopeKind}".`, "error");
					return;
				}

				// Hand off to the same worktree/transition/kickoff path as TUI.
				await startReviewLoop(pi, ctx, getAgentDir, sessionKey, { scopeKind, from, to, commit });
				return;
			}

			// 1. Show scope selector (TUI only)
			const scopeKind = await ctx.ui.custom<ReviewScope["kind"] | null>(
				(_tui, theme, _kb, done) => scopeSelectorComponent(theme, done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "60%", minWidth: 48 },
				},
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
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: "60%", minWidth: 48 },
					},
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
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: "60%", minWidth: 48 },
					},
				);
				commit = values?.commit;
				if (!commit) {
					ctx.ui.notify("Review cancelled: commit hash required.", "info");
					return;
				}
			}

			// Hand off to the shared review-loop kickoff (worktree/transition/prompt).
			await startReviewLoop(pi, ctx, getAgentDir, sessionKey, { scopeKind, from, to, commit });
			return;
		},
	});
}

/**
 * Shared review-loop kickoff for TUI and RPC. Validates the worktree, moves
 * the next agent turn into Work runtime, and sends the review/fix/re-review
 * prompt. `scope` carries the chosen kind and any refs.
 */
async function startReviewLoop(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	getAgentDir: () => string,
	sessionKey: string,
	scope: { scopeKind: ReviewScope["kind"]; from?: string; to?: string; commit?: string },
): Promise<void> {
	const current = loadState(ctx.cwd, sessionKey);
	if (current.worktreePath) {
		const validation = validateWorktreeState(ctx.cwd, current);
		if (!validation.ok) {
			ctx.ui.notify(
				`Active worktree is invalid: ${validation.reason}. Run /wf-status or /wf-reset.`,
				"error",
			);
			return;
		}
	}
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

	let scopeDescription: string;
	let toolArguments: string;
	switch (scope.scopeKind) {
		case "workspace":
			scopeDescription = "workspace (unstaged + staged + untracked changes)";
			toolArguments = 'scope="workspace"';
			break;
		case "range":
			scopeDescription = `range from=${scope.from} to=${scope.to}`;
			toolArguments = `scope="range", from=${JSON.stringify(scope.from)}, to=${JSON.stringify(scope.to)}`;
			break;
		case "commit":
			scopeDescription = `commit=${scope.commit}`;
			toolArguments = `scope="commit", commit=${JSON.stringify(scope.commit)}`;
			break;
		default:
			ctx.ui.notify(`Unhandled review scope: ${scope.scopeKind}`, "error");
			return;
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
	pi.setSessionName(`review: ${scope.scopeKind}`);
	pi.sendUserMessage(promptText);
}

/**
 * Read a non-empty git ref via RPC input. Returns the trimmed value, "" for
 * an empty submit (caller treats as cancel), or undefined when the user
 * cancels the input dialog. Re-prompts once on empty input so users do not
 * lose the whole wizard on an accidental blank Enter.
 */
async function rpcReadNonEmptyRef(ctx: ExtensionCommandContext, label: string): Promise<string | undefined> {
	const first = await ctx.ui.input(label, "");
	if (first === undefined) return undefined; // user cancelled
	const trimmed = first.trim();
	if (trimmed) return trimmed;
	// Empty submit: re-prompt once with a clearer placeholder.
	const second = await ctx.ui.input(`${label} (required — press Esc to cancel)`, "");
	if (second === undefined) return undefined;
	return second.trim();
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

			const current = loadState(ctx.cwd, sessionKey);
			if (current.worktreePath) {
				const validation = validateWorktreeState(ctx.cwd, current);
				if (!validation.ok) {
					ctx.ui.notify(
						`Active worktree is invalid: ${validation.reason}. Run /wf-status or /wf-reset.`,
						"error",
					);
					return;
				}
			}

			const state = {
				...current,
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
	getAgentDir: () => string,
): void {
	pi.registerCommand("wf-status", {
		description: "显示当前轻量 workflow 状态、有效配置与来源",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			const state = loadState(ctx.cwd, sessionKey);

			let msg = currentStatusText(state);
			if (state.worktreePath) {
				const validation = validateWorktreeState(ctx.cwd, state);
				msg += `\n\nworktreeValidation: ${validation.ok ? "ok" : validation.reason}`;
				msg += `\nworktreeStatus:\n${gitStatusInWorktree(state.worktreePath)}`;
			}

			// Effective config + per-leaf source attribution + project trust.
			let report: ReturnType<typeof resolveConfigSources>;
			try {
				report = resolveConfigSources(
					ctx.cwd,
					getAgentDir(),
					sessionKey,
					ctx,
				);
			} catch (e: unknown) {
				const errMsg = `wf-status: failed to resolve config sources: ${e instanceof Error ? e.message : String(e)}`;
				if (ctx.mode === "json" || ctx.mode === "print") {
					console.error(errMsg);
					return;
				}
				ctx.ui.notify(errMsg, "error");
				return;
			}
			const role = state.mode ? modeRole(state.mode) : "explore";
			const eff = report.effective;
			const roleSpec = eff.models[role as keyof typeof eff.models];
			// Active Pi session runtime: the model/thinking Pi currently has loaded
			// (chosen via /model, Ctrl+P, Shift+Tab, or restored on /reload or /resume).
			// Differs from the configured role when the user manually switched within
			// the current workflow mode; workflow only re-applies the role config on
			// explicit transitions and /wf-settings saves.
			const activeModel = ctx.model;
			const activeThinking = pi.getThinkingLevel();
			msg += `\n\n# Effective Config`;
			msg += `\nprojectConfig: ${report.projectSkipped ? "skipped (untrusted)" : "active"}`;
			msg += `\nrole: ${role}`;
			msg += `\nactive runtime model: ${activeModel ? `${activeModel.provider}/${activeModel.id}` : "(none — role config applies)"}`;
			msg += `\nactive runtime thinking: ${activeThinking}`;
			msg += `\nconfigured role model: ${roleSpec ? `${roleSpec.provider}/${roleSpec.model}` : "(none)"}`;
			msg += `\nconfigured role thinking: ${roleSpec?.thinking ?? "(none)"}`;
			msg += `\nworkflow.autoEnter: ${eff.workflow.autoEnter} (source: ${report.sources["workflow.autoEnter"]})`;
			msg += `\nplanReview.enabled: ${eff.planReview.enabled} (source: ${report.sources["planReview.enabled"]})`;
			msg += `\ncodeReview.enabled: ${eff.codeReview.enabled} (source: ${report.sources["codeReview.enabled"]})`;
			for (const r of ["explore", "plan", "planReview", "work", "commit"] as const) {
				const spec = eff.models[r];
				if (!spec) continue;
				msg += `\nmodels.${r}: ${spec.provider}/${spec.model} / ${spec.thinking ?? "(none)"}`;
				msg += ` (provider: ${report.sources[`models.${r}.provider`]}, model: ${report.sources[`models.${r}.model`]}, thinking: ${report.sources[`models.${r}.thinking`]})`;
			}

			// Active todo tool + alias ownership (RPC compatibility status).
			const todoTool = resolveTodoToolName(pi);
			msg += `\n\ntodoTool: ${todoTool}`;
			if (todoTool === "update_plan") {
				msg += ` (Paseo native TodoListCard; verified Paseo ${PASEO_VERIFIED_VERSION})`;
			} else if (ctx.mode === "rpc") {
				msg += ` (workflow_todo; update_plan alias unavailable — external collision or not registered)`;
			}

			// JSON/print: no UI surface; stderr keeps stdout protocol/print clean.
			if (ctx.mode === "json" || ctx.mode === "print") {
				console.error(msg);
				return;
			}
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
			if (current.worktreePath) {
				const choice = ctx.ui.select
					? await ctx.ui.select("Active worktree", [
							"保留 worktree，仅清 state",
							"删除 worktree，保留 branch",
							"删除 worktree 和 branch",
							"取消",
						])
					: "保留 worktree，仅清 state";
				if (!choice || choice === "取消") return;
				if (choice === "删除 worktree，保留 branch" || choice === "删除 worktree 和 branch") {
					try {
						if (choice === "删除 worktree 和 branch") {
							const validation = validateWorktreeState(ctx.cwd, current);
							if (!validation.ok) {
								ctx.ui.notify(
									`Active worktree is invalid: ${validation.reason}. Branch was not deleted.`,
									"error",
								);
								return;
							}
						}
						removeWorktree(ctx.cwd, current);
						if (choice === "删除 worktree 和 branch" && current.worktreeBranch) {
							try {
								deleteWorktreeBranch(ctx.cwd, current.worktreeBranch);
							} catch (err: any) {
								ctx.ui.notify(
									`worktree 已删除，但 branch 删除失败：${err?.message ?? String(err)}`,
									"error",
								);
							}
						}
					} catch (err: any) {
						ctx.ui.notify(
							`删除 worktree 失败：${err?.message ?? String(err)}`,
							"error",
						);
						return;
					}
				}
			}

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

export function registerWfInitCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("wf-init", {
		description: "初始化 agent 工作区：确保 git 仓库存在，进入 Init Mode 生成/校准 AGENTS.md",
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
			const targetFile = existingFile ?? "AGENTS.md";
			const targetPath = path.join(root, targetFile);
			const sessionKey = ctxSessionKey(ctx);
			const state = loadState(ctx.cwd, sessionKey);

			// Resume an already-active init instead of overwriting the return mode.
			if (state.mode === "init" && state.initTargetPath) {
				sendInitTaskMessage(
					pi,
					root,
					ctx.cwd,
					targetPath,
					isProjectEmpty(root, existingFile) ? "empty" : "existing",
					existingFile,
				);
				return;
			}

			const returnMode: WorkflowState["initReturnMode"] =
				state.mode === "idle" || state.mode === "init"
					? "explore"
					: state.mode;

			const nextState: WorkflowState = {
				...state,
				mode: "init",
				initReturnMode: returnMode,
				initTargetPath: targetPath,
			};

			const result = await transitionWorkflowMode({
				pi,
				ctx,
				sessionKey,
				nextState,
				getAgentDir,
			});
			if (!result.ok) {
				ctx.ui.notify(result.reason, "error");
				return;
			}

			sendInitTaskMessage(
				pi,
				root,
				ctx.cwd,
				targetPath,
				isProjectEmpty(root, existingFile) ? "empty" : "existing",
				existingFile,
			);
		},
	});
}

/** Compose and send the Init Mode kickoff user message. */
function sendInitTaskMessage(
	pi: ExtensionAPI,
	root: string,
	cwd: string,
	targetPath: string,
	repoStatus: "empty" | "existing",
	existingFile: string | null,
): void {
	const rootRel = root === cwd ? "仓库根目录" : `仓库根目录 (${root})`;
	const targetRel = path.basename(targetPath);

	const existingClause = existingFile
		? `当前仓库已存在 ${existingFile}。请将它作为待验证的信息来源：审计过时/遗漏/冲突/冗余，按当前最佳效果重建，无需保守合并。`
		: "当前仓库没有 AGENTS.md，将新建。";

	const statusClause =
		repoStatus === "empty"
			? `仓库状态：empty（只有 git/.pi/AGENTS.md）。按空仓库流程逐项确认：项目目标与交付形态、语言/运行时/框架/包管理器、构建/测试/lint/格式化命令、目录与命名约定、提交规范；按项目形态补充部署/发布与关键兼容、安全、性能约束。`
			: `仓库状态：existing。先扫描 README、docs、构建/CI 配置、源码、部署文件、git 历史；能由明确证据确认的事实直接采用，缺失、冲突、多方案或团队偏好逐项 grilling。`;

	pi.sendUserMessage(
		[
			`# Init Mode 任务：${rootRel} 的 ${targetRel}`,
			existingClause,
			statusClause,
			`目标文件：${targetPath}`,
			`按 Init Mode 流程执行：收集证据→逐项确认/裁决→展示最终发现、用户确认的决策和计划删除的旧规则→重建紧凑版 AGENTS.md。`,
			`完成后调用 workflow_init_complete(status="completed")；用户决定不更新/不生成时 skipped；用户取消时 cancelled。`,
		].join("\n\n"),
	);
}
