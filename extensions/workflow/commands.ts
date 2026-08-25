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
	buildMergeContextBody,
	MERGE_CONTEXT_MARKER,
	WORK_HANDOFF_CUSTOM_TYPE,
} from "./helpers.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { planDir, planReviewHistoryPath, reviewHistoryPath } from "./paths.js";
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
	validateMergeWorktreeState,
} from "./worktree.js";
import {
	cancelActiveMergeGit,
	parseMergeCommandArgs,
	resolveRepoRoot,
	runMergePreflight,
} from "./git-integration.js";

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

			// Step 4: Merge Mode canonical context. Rebuild the hidden context
			// message from persisted state every provider round (filtering previous
			// copies, including any persisted from older versions) so the merge
			// baseline and the user authorization survive reload and compaction.
			// Raw instructions stay at user priority and are never folded into the
			// system prompt.
			messages = messages.filter((message) => {
				const role = (message as { role?: unknown } | undefined)?.role;
				const content = (message as { content?: unknown } | undefined)?.content;
				return !(
					role === "user" &&
					typeof content === "string" &&
					content.startsWith(MERGE_CONTEXT_MARKER)
				);
			});
			if (state.mode === "merge" && state.mergeContext) {
				const body = buildMergeContextBody(state);
				if (body) {
					return {
						messages: [
							{
								role: "user" as const,
								content: `${MERGE_CONTEXT_MARKER}\n\n${body}`,
								display: false,
								timestamp: Date.now(),
							},
							...messages,
						],
					};
				}
			}

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

		// Worktree-bound Work/Merge Mode: code writes must stay inside the active
		// worktree. Merge Mode shares the Work file boundary but uses the
		// merge-aware validator so a rebase-in-progress worktree (detached HEAD
		// with a detectable rebase sequencer, workflow-worktree source) keeps
		// write/edit usable for conflict resolution; every other state stays strict.
		if (
			(effectiveMode === "work" || effectiveMode === "merge") &&
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

			const validation =
				effectiveMode === "merge"
					? validateMergeWorktreeState(ctx.cwd, state)
					: validateWorktreeState(ctx.cwd, state);
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
		description: "进入 workflow 模式，启用 /plan /work /review /wf-merge /wf-commit 等命令",
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
	registerWfMergeCommand(pi, getAgentDir);
	registerWfCommitCommand(pi, getAgentDir);
	registerWfStatusCommand(pi, getAgentDir);
	registerWfResetCommand(pi);
	registerWfInitCommand(pi, getAgentDir);
	registerWfExitCommand(pi);

	_workflowCommandsRegistered.add(pi);
}

// ── Active merge protection ────────────────────────────────────────────────

/**
 * Denial notice for mode-switching entries while a merge is active. Mode
 * commands must not silently drop an active merge baseline — the user closes
 * the run via workflow_merge_complete (completed/cancelled) or hard-recovers
 * via /wf-reset.
 */
function activeMergeDenial(state: WorkflowState): string | null {
	if (state.mode !== "merge" || !state.mergeContext) return null;
	const mc = state.mergeContext;
	return (
		`当前存在 active merge：${mc.sourceBranch} → ${mc.targetBranch}（${mc.sourceKind}）。` +
		"请先在 Merge Mode 中调用 workflow_merge_complete(status=\"completed\" 或 \"cancelled\") 完成或中止本次集成；" +
		"需要硬恢复时使用 /wf-reset。"
	);
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
			const mergeDenial = activeMergeDenial(current);
			if (mergeDenial) {
				ctx.ui.notify(mergeDenial, "error");
				return;
			}
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
			const mergeDenial = activeMergeDenial(current);
			if (mergeDenial) {
				ctx.ui.notify(mergeDenial, "error");
				return;
			}
			// Capture the current session leaf so requirement extraction can scope
			// to this Plan lifecycle (user messages from this discussion only).
			const planStartEntryId =
				(ctx as { sessionManager?: { getLeafId?: () => string | undefined } })
					.sessionManager?.getLeafId?.() ?? undefined;
			const state: WorkflowState = {
				...DEFAULT_STATE,
				workflowEnabled: current.workflowEnabled,
				mode: "plan",
				planRunId: crypto.randomUUID(),
				planStartEntryId,
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
			const mergeDenial = activeMergeDenial(current);
			if (mergeDenial) {
				ctx.ui.notify(mergeDenial, "error");
				return;
			}
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
				// Capture the session leaf so the Implementation Reviewer can scope
				// authoritative requirement extraction to this Direct Work lifecycle.
				workStartEntryId:
					(ctx as { sessionManager?: { getLeafId?: () => string | undefined } })
						.sessionManager?.getLeafId?.() ?? undefined,
				// Direct Work has no approved plan; clear any stale approved todos
				// from a prior Approved Work run.
				approvedTodos: undefined,
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

// registerReviewCommand — on-demand unified review of the current workspace.
export function registerReviewCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("review", {
		description:
			"Run the unified on-demand review of the current workspace (incl. active worktree). OCR is included when codeReview.enabled is true.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const sessionKey = ctxSessionKey(ctx);
			{
				const current = loadState(ctx.cwd, sessionKey);
				const mergeDenial = activeMergeDenial(current);
				if (mergeDenial) {
					ctx.ui.notify(mergeDenial, "error");
					return;
				}
			}
			const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
			if (!config.review.enabled) {
				ctx.ui.notify(
					"Review is not enabled. Set review.enabled: true in config.",
					"error",
				);
				return;
			}

			// JSON/print: no UI surface; stderr keeps stdout protocol/print output clean.
			if (ctx.mode === "json" || ctx.mode === "print") {
				console.error(
					"workflow review: /review requires interactive mode (TUI/RPC). " +
						"In JSON/print mode, call workflow_review directly.",
				);
				return;
			}

			await startReviewLoop(pi, ctx, getAgentDir, sessionKey);
			return;
		},
	});
}

/**
 * Shared review-loop kickoff. Validates the worktree, moves the next agent
 * turn into Work runtime, and sends the unified review/fix/re-review prompt.
 * The unified review always targets the current workspace (active worktree or
 * main checkout); scope/ref selection has been removed.
 */
async function startReviewLoop(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	getAgentDir: () => string,
	sessionKey: string,
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

	const promptText = `请执行统一 review 循环。

Review scope: 当前 workspace（含 active worktree）。

要求：
1. 第一轮调用 \`workflow_review()\`（无参数），启动独立 reviewer 对当前 workspace 审查。
2. 收到 review 结果后，逐条验证 reviewer 的每个 Critical/Important 问题是否真实存在。
3. 对确认存在的问题进行修复，并运行最相关测试验证。
4. 修复后再次调用 \`workflow_review\` 重新审查；持续 review → fix → re-review，直到没有新的 Critical/Important 问题。
5. 判断某 Critical/Important 问题是误判、超出范围、无需修改或与项目约束冲突时，在下一轮调用 \`workflow_review({ feedback: "..." })\` 提交技术理由。feedback 须逐条对应争议 finding，给出技术理由与 \`file:line\` / 命令输出等可复核证据，保持详细且聚焦，禁止编造事实；reviewer 会独立复核。
6. 第一轮已经没有 Critical/Important 问题时，可以结束循环。2-3 轮后仍存在分歧时，停止并交给用户裁决。
7. Minor 问题按价值选择处理，不能阻塞 review 通过。
8. \`/wf-commit\` 始终直接可用，不要求 Review；review 完成后可随时提交。`;
	ctx.ui.notify("Starting unified review loop: workspace.", "info");
	pi.setSessionName("review: workspace");
	pi.sendUserMessage(promptText);
}


export function registerWfCommitCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	// Command migrated from /commit to /wf-commit with no compat alias (a
	// deliberate breaking CLI change). Registered through the same conditional
	// registration path as all other workflow commands.
	pi.registerCommand("wf-commit", {
		description:
			"切到 commit 模型，根据当前 diff 生成 commit message 并直接提交",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			const current = loadState(ctx.cwd, sessionKey);
			const mergeDenial = activeMergeDenial(current);
			if (mergeDenial) {
				ctx.ui.notify(mergeDenial, "error");
				return;
			}
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

// ── /wf-merge command ────────────────────────────────────────────────────────

/**
 * Register /wf-merge: enter Merge Mode to integrate the source branch (the
 * active workflow worktree branch, or the current ordinary local branch) into
 * a target local branch. Default strategy is rebase + ff-only; trailing
 * natural-language instructions authorize a custom strategy. Syntax:
 *
 *   /wf-merge [--target <branch>] [用户自然语言指令]
 *
 * Preflight rejects dirty source/target checkouts, detached-HEAD sources,
 * source==target, and unfinished sequencers; the baseline is then persisted
 * atomically with mode=merge BEFORE the kickoff message, so a crash mid-merge
 * never loses the merge context. Re-running /wf-merge with an active context
 * never overwrites the baseline or the authorization.
 */
export function registerWfMergeCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("wf-merge", {
		description:
			"进入 Merge Mode：rebase 来源分支到目标分支并 fast-forward（可尾随自定义策略指令）",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);
			const current = loadState(ctx.cwd, sessionKey);

			// Init Mode must finish first: switching modes here would clear
			// initTargetPath/initReturnMode via state normalization and orphan the
			// init run.
			if (current.mode === "init") {
				ctx.ui.notify(
					"当前处于 Init Mode。请先调用 workflow_init_complete 完成或取消初始化，再执行 /wf-merge。",
					"error",
				);
				return;
			}

			// Active merge: never overwrite the recorded baseline/authorization.
			// No args → re-send the current context; new instructions arrive as a
			// normal user message inside Merge Mode.
			if (current.mode === "merge" && current.mergeContext) {
				const trimmed = (args ?? "").trim();
				if (trimmed) {
					ctx.ui.notify(
						"Merge 已在进行中，基线与授权不会被覆盖；新增指令已作为普通用户消息发送给当前 Merge。",
						"info",
					);
					pi.sendUserMessage(trimmed);
				} else {
					ctx.ui.notify("Merge 已在进行中；已重发当前上下文。", "info");
					pi.sendUserMessage(
						`${MERGE_CONTEXT_MARKER}\n\n${buildMergeContextBody(current)}\n\n请继续按 Active Merge Context 执行本次集成。`,
					);
				}
				return;
			}

			// Strict worktree validation at entry (the rebase-detached window is
			// only tolerated mid-merge, never at kickoff).
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

			const parsed = parseMergeCommandArgs(args ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}

			const preflight = runMergePreflight(ctx.cwd, {
				worktreePath: current.worktreePath,
				worktreeBranch: current.worktreeBranch,
				worktreeBaseBranch: current.worktreeBaseBranch,
				targetBranch: parsed.value.targetBranch,
			});
			if (!preflight.ok) {
				ctx.ui.notify(`无法启动 merge：${preflight.error}`, "error");
				return;
			}
			const facts = preflight.value;

			// Only non-idle workflow modes are valid return targets (idle is
			// auto-promoted to explore on session start; merge cannot return to
			// itself here because the active-merge branch above already returned).
			const returnMode: "explore" | "plan" | "work" | "commit" =
				current.mode === "plan" ||
				current.mode === "work" ||
				current.mode === "commit"
					? current.mode
					: "explore";

			const nextState: WorkflowState = {
				...current,
				mode: "merge",
				mergeContext: {
					sourceKind: facts.sourceKind,
					sourceBranch: facts.sourceBranch,
					targetBranch: facts.targetBranch,
					sourceHeadBefore: facts.sourceHeadBefore,
					targetHeadBefore: facts.targetHeadBefore,
					sourceOnlyCommitCountBefore: facts.sourceOnlyCommitCountBefore,
					instructions: parsed.value.instructions,
					defaultStrategy: !parsed.value.instructions,
					returnMode,
				},
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

			pi.setSessionName(
				`merge: ${facts.sourceBranch} → ${facts.targetBranch}`,
			);

			const kindLabel =
				facts.sourceKind === "workflow-worktree"
					? "workflow worktree"
					: "普通本地分支（当前 checkout）";
			const strategyLine = parsed.value.instructions
				? "存在用户授权指令（见本轮注入的 Active Merge Context）；只有指令逐字点名的动作被授权，其余高风险动作保持默认禁令。"
				: `默认策略：rebase \`${facts.sourceBranch}\` 到 \`${facts.targetBranch}\`，解决冲突并验证后调用 workflow_merge_complete(status="completed", finalize="ff-only")。`;
			pi.sendUserMessage(
				[
					"# Merge Mode 任务",
					`来源分支 \`${facts.sourceBranch}\` → 目标分支 \`${facts.targetBranch}\`（${kindLabel}）。`,
					strategyLine,
					`中止调用 workflow_merge_complete(status="cancelled")。目标分支 ref 的最终前移由 workflow_merge_complete 完成。`,
				].join("\n\n"),
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
			msg += `\nreview.enabled: ${eff.review.enabled} (source: ${report.sources["review.enabled"]})`;
			msg += `\ncodeReview.enabled (Review OCR): ${eff.codeReview.enabled} (source: ${report.sources["codeReview.enabled"]})`;
			for (const r of ["explore", "plan", "planReview", "review", "work", "commit"] as const) {
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
			const mergeDenial = activeMergeDenial(state);
			if (mergeDenial) {
				ctx.ui.notify(mergeDenial, "error");
				return;
			}
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
			// Active merge: abort in-flight git operations and restore the source
			// checkout BEFORE clearing state, so the reset never leaves an invisible
			// half-finished rebase behind. A failed recovery stops the reset.
			if (current.mode === "merge" && current.mergeContext) {
				const mc = current.mergeContext;
				if (mc.sourceKind === "workflow-worktree" && !current.worktreePath) {
					ctx.ui.notify(
						"Active merge 的来源 worktree 已不在状态中；请手动恢复后重试 /wf-reset。",
						"error",
					);
					return;
				}
				const sourceCheckoutPath =
					mc.sourceKind === "workflow-worktree"
						? current.worktreePath!
						: (() => {
							const root = resolveRepoRoot(ctx.cwd);
							if (!root.ok) return ctx.cwd;
							return root.root;
						})();
				const cancel = cancelActiveMergeGit(ctx.cwd, {
					sourceKind: mc.sourceKind,
					sourceBranch: mc.sourceBranch,
					targetBranch: mc.targetBranch,
					sourceCheckoutPath,
				});
				if (!cancel.ok) {
					ctx.ui.notify(
						`中止 active merge 失败，已停止 reset：${cancel.error ?? "(unknown)"}\n${cancel.diagnostics.join("\n")}`,
						"error",
					);
					return;
				}
				ctx.ui.notify(
					`已中止 active merge（${mc.sourceBranch} → ${mc.targetBranch}）：${[...cancel.aborted, ...(cancel.reattached ? ["forced-reattach"] : [])].join(", ") || "无需恢复"}`,
					"info",
				);
			}
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

			// Drop the review-round history (session-scoped per-work-run cache).
			fs.rmSync(reviewHistoryPath(ctx.cwd, sessionKey), { force: true });
			// Drop the plan-review round history too (session-scoped per-plan-run
			// cache powering reuse/incremental rounds).
			fs.rmSync(planReviewHistoryPath(ctx.cwd, sessionKey), { force: true });

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

			const mergeDenial = activeMergeDenial(state);
			if (mergeDenial) {
				ctx.ui.notify(mergeDenial, "error");
				return;
			}

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

			// Active merge was denied above, so "merge" cannot reach here; map it
			// to explore defensively alongside idle/init.
			const returnMode: WorkflowState["initReturnMode"] =
				state.mode === "plan" || state.mode === "work" || state.mode === "commit"
					? state.mode
					: "explore";

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
