import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import { getSessionKey, loadState, saveState } from "./state.js";
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
	buildWorkHandoffBody,
	currentStatusText,
	WORK_HANDOFF_CUSTOM_TYPE,
	worktreeRuntimeNotice,
} from "./helpers.js";
import { readPlan } from "./state.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { planDir } from "./paths.js";
import { loadConfig } from "./config.js";
import {
	setRole,
	modeRole,
	activateWorkflowToolsIfAllowed,
	setCurrentTurnGuardMode,
	getCurrentTurnGuardMode,
	clearCurrentTurnGuardMode,
	deactivateWorkflowTools,
	transitionWorkflowMode,
	isWorkflowToolMode,
	WORKFLOW_GATED_TOOLS,
	computeWorkflowToolNames,
} from "./mode.js";
import { execSync } from "node:child_process";
import path from "node:path";
import {
	deleteWorktreeBranch,
	gitStatusInWorktree,
	removeWorktree,
	validateWorktreeState,
} from "./worktree.js";

// ── Work context isolation helpers ──────────────────────────────────────────

/**
 * Minimal shape of AgentMessage we inspect for Work context isolation. We only
 * need to identify custom handoff messages, compaction/branch summaries, and
 * toolCall/toolResult pairing; other roles pass through untouched.
 */
type WorkflowContextMessage = {
	role?: string;
	customType?: string;
	details?: unknown;
	timestamp?: number;
	toolCallId?: string;
};

/** Session branch entry shape returned by sessionManager.getBranch(). */
type SessionBranchEntry = {
	type: string;
	customType?: string;
	details?: unknown;
	timestamp?: string;
};

/**
 * Read the session branch once per provider request. Returns undefined when
 * the session manager shape drifts or getBranch is unavailable — callers fall
 * back to keeping full history (fail-open).
 */
function getSessionBranch(ctx: unknown): SessionBranchEntry[] | undefined {
	try {
		return (
			(ctx as {
				sessionManager?: {
					getBranch?: () => SessionBranchEntry[];
				};
			}).sessionManager?.getBranch?.()
		);
	} catch {
		return undefined;
	}
}

/**
 * Return the timestamp of the most recent workflow-work-handoff custom message
 * whose details.workRunId matches the current work run, or undefined when the
 * branch has no matching marker (Direct Work, legacy sessions, pre-approval).
 */
function findCurrentHandoffTimestamp(
	entries: SessionBranchEntry[],
	workRunId: string | undefined,
): string | undefined {
	if (!workRunId) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom_message") continue;
		if (entry.customType !== WORK_HANDOFF_CUSTOM_TYPE) continue;
		const details = entry.details as { workRunId?: unknown } | undefined;
		if (details?.workRunId === workRunId) return entry.timestamp;
	}
	return undefined;
}

/**
 * Check whether the current work run has a handoff marker anywhere on the
 * session branch. Used to distinguish "marker compacted away" (isolation still
 * in effect) from "Direct Work / legacy session" (no marker, keep history).
 */
function branchHasCurrentHandoff(
	entries: SessionBranchEntry[] | undefined,
	workRunId: string | undefined,
): boolean {
	if (!entries || !workRunId) return false;
	return findCurrentHandoffTimestamp(entries, workRunId) !== undefined;
}

/**
 * Drop leading orphan toolResult messages after a mid-pair slice so the
 * remaining sequence has valid toolCall/toolResult pairing and providers
 * do not reject the request. Only strips a contiguous run of leading
 * toolResult messages; stops at the first non-toolResult (user/assistant/
 * custom/etc.), which is always a safe anchor for a provider request.
 */
function dropOrphanToolMessages<T extends WorkflowContextMessage>(
	messages: T[],
): T[] {
	let firstSafe = 0;
	while (firstSafe < messages.length && messages[firstSafe]?.role === "toolResult") {
		firstSafe++;
	}
	return messages.slice(firstSafe);
}

/**
 * Apply Approved-Plan Work context isolation to provider-visible messages.
 *
 * Slicing rules:
 * - No matching marker on the branch → Direct Work or legacy session: keep all
 *   messages unchanged.
 * - Marker present in `messages` → keep only messages after the marker, then
 *   repair tool pairing in case the cut landed mid-pair.
 * - Marker on branch but not in `messages` (compacted away) → drop all
 *   leading compactionSummary/branchSummary messages; keep the first
 *   non-summary and everything after it. If no leading summary exists,
 *   fail-open and return messages unchanged (no reliable cut point).
 *   Residual Plan-era non-summary turns after a leading summary may still
 *   leak — known limit of this fallback; needs state-backed isolation to close.
 */
function applyWorkContextIsolation<T extends WorkflowContextMessage>(
	messages: T[],
	entries: SessionBranchEntry[],
	workRunId: string | undefined,
): T[] {
	if (!workRunId) return messages;
	const markerTs = findCurrentHandoffTimestamp(entries, workRunId);
	if (markerTs === undefined) return messages;

	// Look for the marker in the provider-visible messages first. It must be
	// called BEFORE filtering handoffs out of the array.
	let markerMsgIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (
			msg.role === "custom" &&
			msg.customType === WORK_HANDOFF_CUSTOM_TYPE &&
			(msg.details as { workRunId?: unknown } | undefined)?.workRunId ===
				workRunId
		) {
			markerMsgIdx = i;
			break;
		}
	}

	if (markerMsgIdx !== -1) {
		// Marker still in provider context: keep only messages after it, then
		// repair tool pairing in case the cut landed mid-pair.
		return dropOrphanToolMessages(messages.slice(markerMsgIdx + 1));
	}

	// Marker compacted away: we cannot reliably align provider messages with
	// branch entries after compaction, so drop ALL leading messages up to and
	// including the last leading compaction/branch summary. That summary
	// summarizes Plan-era content and must not reach the Work model. The first
	// non-summary message after it is a best-effort Work-era anchor. If there
	// is no leading summary, fail-open and keep everything (no reliable cut).
	// Residual Plan-era non-summary turns may still leak — known limit.
	const isolated: T[] = [];
	let trimming = true;
	let sawAnySummary = false;
	for (const msg of messages) {
		if (trimming) {
			const isSummary =
				msg.role === "compactionSummary" ||
				msg.role === "branchSummary";
			if (isSummary) {
				sawAnySummary = true;
				continue; // drop leading Plan/Work-boundary summary
			}
			trimming = false;
		}
		isolated.push(msg);
	}
	// Mirror the marker-present path: repair leading orphan toolResults that
	// appear when the summarized prefix absorbed the matching toolCall.
	return sawAnySummary ? dropOrphanToolMessages(isolated) : messages;
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
		const state = loadState(ctx.cwd, sessionKey);
		const config = loadConfig(ctx.cwd, getAgentDir());
		const workflowActive =
			(state.workflowEnabled || config.workflow.autoEnter) &&
			!state.workflowExplicitlyDisabled;

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

		// Reapply the configured model/thinking role for the current mode, and
		// reconcile workflow tools as a safety net in case session_start failed
		// or a transition was skipped. Reconciliation short-circuits when the
		// active set already matches, so this is cheap on the steady-state path.
		if (state.mode === "idle") {
			// session_start normally promotes idle→explore; reaching here in idle
		// means the transition failed. Log so the degradation is observable —
		// buildModeMessageBody returns undefined for idle, so the context handler
		// will inject no mode prompt this turn.
			console.warn(
				"[workflow] before_agent_start: mode is idle despite workflow being active; session_start transition may have failed",
			);
		}
		await setRole(pi, ctx, modeRole(state.mode), getAgentDir);
		activateWorkflowToolsIfAllowed(pi, ctx.cwd, getAgentDir, state.mode);

		// Keep stable workflow rules in the system prompt. The mutable mode
		// prompt and current state are injected per-request by the context handler.
		return {
			systemPrompt: event.systemPrompt + "\n\n" + COMMON_PROMPT,
		};
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
			const config = loadConfig(ctx.cwd, getAgentDir());
			const workflowActive =
				(state.workflowEnabled || config.workflow.autoEnter) &&
				!state.workflowExplicitlyDisabled;

			// Read the session branch once per request; shared by isolation and
			// handoff re-injection. Failure degrades to undefined (fail-open).
			const branch = getSessionBranch(ctx);

			// Approved-Plan Work isolation runs BEFORE filtering stale injectables so
			// applyWorkContextIsolation can still see the handoff marker in the
			// provider-visible messages. Filtering first would strip the marker and
			// make markerMsgIdx permanently -1, defeating Plan-history isolation.
			let messages = event.messages;
			if (workflowActive && state.mode === "work" && state.workRunId) {
				try {
					if (branch) {
						if (
							state.planPath &&
							!branchHasCurrentHandoff(branch, state.workRunId)
						) {
							// Approved-Plan signal without marker: isolation + re-inject
							// both degrade. Surface the known branch-compaction limit.
							console.error(
								"[workflow] work context isolation skipped: handoff marker not found on session branch (Plan history may leak)",
							);
						}
						messages = applyWorkContextIsolation(
							event.messages,
							branch,
							state.workRunId,
						);
					} else if (state.planPath) {
						// Approved-Plan Work without branch access: cannot isolate, but
						// surface it so the degradation is observable. Fail-open keeps
						// full history so the Work model can still proceed.
						console.error(
							"[workflow] work context isolation skipped: sessionManager.getBranch unavailable",
						);
					}
				} catch (isolationErr) {
					// Branch inspection failed (e.g. session shape drift). Fail open:
					// keep event.messages as-is so the mode prompt still injects.
					console.error(
						`[workflow] work context isolation skipped: ${isolationErr}`,
					);
				}
			}

			// Drop stale injectables (workflow-mode, workflow-work-handoff) from
			// whatever isolation produced. Both are re-injected below from current
			// state, so any persisted copies (including the marker we just used) are
			// stale and must be removed to avoid duplicates.
			const filteredMessages = messages.filter((message) => {
				if (
					message &&
					typeof message === "object" &&
					"customType" in message
				) {
					const ct = (message as { customType?: unknown }).customType;
					if (ct === "workflow-mode" || ct === WORK_HANDOFF_CUSTOM_TYPE) {
						return false;
					}
				}
				return true;
			});

			if (!workflowActive) return { messages: filteredMessages };

			const content = buildModeMessageBody(state.mode, state);
			if (!content) return { messages: filteredMessages };

			// For Approved-Plan Work, re-inject the handoff execution packet each
			// provider request so todo/state changes propagate. Gated on
			// branchHasCurrentHandoff so Direct Work (no marker) never receives an
			// Approved-Plan packet.
			if (
				state.mode === "work" &&
				state.workRunId &&
				state.planPath &&
				branchHasCurrentHandoff(branch, state.workRunId)
			) {
				try {
					const planMarkdown = readPlan(ctx.cwd, state.planPath);
					filteredMessages.push({
						role: "custom",
						customType: WORK_HANDOFF_CUSTOM_TYPE,
						content: buildWorkHandoffBody(state, planMarkdown),
						display: false,
						details: { workRunId: state.workRunId },
						timestamp: Date.now(),
					});
				} catch (planErr) {
					// Plan read failed; skip handoff re-injection this turn.
					console.error(
						`[workflow] handoff re-inject skipped: ${planErr}`,
					);
				}
			}

			filteredMessages.push({
				role: "custom",
				customType: "workflow-mode",
				content,
				display: false,
				timestamp: Date.now(),
			});

			return { messages: filteredMessages };
		} catch (err) {
			// Surface injection failures so debugging is possible. Return the
			// original event.messages unmodified so mode context is not silently
			// stripped when state/config loading fails.
			console.error(`[workflow] context injection failed: ${err}`);
			return { messages: event.messages };
		}
	});
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
		const state = loadState(ctx.cwd, sessionKey);
		const config = loadConfig(ctx.cwd, getAgentDir());
		const workflowActive =
			(state.workflowEnabled || config.workflow.autoEnter) &&
			!state.workflowExplicitlyDisabled;

		// Use per-turn effective guard mode; fall back to state mode.
		const effectiveMode = getCurrentTurnGuardMode(sessionKey) ?? state.mode;

		// Block workflow tool calls outside workflow-enabled implementation modes.
		// This catches stale tool registrations and direct tool invocations.
		if ((WORKFLOW_GATED_TOOLS as readonly string[]).includes(event.toolName)) {
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
				!computeWorkflowToolNames(effectiveMode, config).includes(
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

			// Set session name for easier identification in /resume
			pi.setSessionName("workflow: explore");

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

			const notice = worktreeRuntimeNotice(result.state);
			if (workArgs || notice) {
				pi.sendUserMessage([notice, workArgs].filter(Boolean).join("\n\n"));
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

			// Non-TUI mode: provide text-based instructions
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"Code review requires interactive mode (TUI). " +
						"In RPC/JSON/print mode, please use workflow_code_review tool directly. " +
						"Parameters: scope (workspace|range|commit), background, from, to, commit, preview.",
					"info",
				);
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

			// 3. Move the next agent turn into Work runtime so the review loop can
			// call workflow_code_review, edit files, and run tests when fixes are needed.
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
			const fullPromptText = [worktreeRuntimeNotice(state), promptText]
				.filter(Boolean)
				.join("\n\n");

			ctx.ui.notify(`Starting code review loop: ${scopeDescription}.`, "info");
			pi.setSessionName(`review: ${scopeKind}`);
			pi.sendUserMessage(fullPromptText);
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
				[
					worktreeRuntimeNotice(state),
					`请查看当前 diff，生成合适的 commit message，并直接执行 git add 和 git commit。${extra}`,
				]
					.filter(Boolean)
					.join("\n\n"),
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

			let msg = currentStatusText(state);
			if (state.worktreePath) {
				const validation = validateWorktreeState(ctx.cwd, state);
				msg += `\n\nworktreeValidation: ${validation.ok ? "ok" : validation.reason}`;
				msg += `\nworktreeStatus:\n${gitStatusInWorktree(state.worktreePath)}`;
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
