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
	buildModeReminderBody,
	currentStatusText,
	isWorkflowActive,
	isWorkflowModeReminderMessage,
	modeScopeHint,
	buildMergeContextBody,
	MERGE_CONTEXT_MARKER,
	WORK_HANDOFF_CUSTOM_TYPE,
	WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
} from "./helpers.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { planDir, planReviewHistoryPath, qaHistoryPath, reviewHistoryPath } from "./paths.js";
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
	type WorkflowModeTransitionResult,
	isWorkflowToolMode,
	workflowManagedToolNames,
	computeWorkflowToolNames,
	resolveTodoToolName,
	reconcileContextWindowForSession,
	releaseContextWindowOverride,
	getContextWindowOverride,
} from "./mode.js";
import { execSync } from "node:child_process";
import path from "node:path";
import {
	buildWorktreeBranchName,
	createWorktree,
	deleteWorktreeBranch,
	gitStatusInWorktree,
	parseWorkCommandArgs,
	removeCreatedWorktree,
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

// ── /workflow:init helpers ─────────────────────────────────────────────────────────

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

		// Per-user-turn mode reminder: a short hidden custom message appended
		// right after the user message and persisted in the session. Tool-loop
		// continuations reuse the same turn's reminder (before_agent_start only
		// fires per user request), so the message stream stays append-only for
		// provider prefix caching. Deterministic content — see
		// buildModeReminderBody. The context handler strips these from the
		// provider projection once workflow is disabled.
		const reminderBody = buildModeReminderBody(state.mode);
		if (reminderBody) {
			return {
				systemPrompt,
				message: {
					customType: WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
					content: reminderBody,
					display: false,
				},
			};
		}

		return { systemPrompt };
	});
}

/**
 * Provider-context projections for workflow mode.
 *
 * Responsibilities (no reminder creation — reminders are persisted per user
 * turn by the before_agent_start handler via WORKFLOW_MODE_REMINDER_CUSTOM_TYPE;
 * this hook only projects the provider-visible view):
 * - Filter historical legacy workflow-mode messages (including persisted ones
 *   from older versions) in all modes.
 * - Strip our per-turn mode reminders once workflow is disabled so stale mode
 *   constraints stop applying (session transcript keeps the originals).
 * - Approved Work isolation via the canonical handoff marker, with branch
 *   recovery and a fail-open recovery warning.
 * - Merge Mode canonical context rebuilt from persisted state every round.
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

			if (!workflowActive) {
				// Workflow disabled: strip our per-turn mode reminders from the
				// provider projection so stale mode constraints stop applying.
				// The session transcript keeps the originals; real user text is
				// never touched.
				return {
					messages: messages.filter(
						(message) => !isWorkflowModeReminderMessage(message),
					),
				};
			}

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
				// blocks the current todo, and asks the user to run /workflow:plan —
				// rather than silently continuing without the plan contract.
				console.error(
					"[workflow] work context isolation fail-open: marker/journal unavailable or pairing broken",
				);
				const recoveryWarning =
					"# Approved-Plan Work Recovery Warning\n\n" +
					"Plan restore failed: both the handoff marker and the approval journal are unavailable or no longer paired.\n" +
					"Stop executing now: mark the current workflow_todo as blocked, do not modify any further files,\n" +
					"report the conflict to the user and ask them to run /workflow:plan to revise the plan. Do not switch modes yourself or call workflow_plan_save.";
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
							`Plan approved — starting Approved-Plan Work. Drive execution via workflow_todo and the Final Plan.`,
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
						"Workflow is not enabled. Run /workflow:enable first to enable workflow tools.",
				};
			}
			if (!isWorkflowToolMode(effectiveMode)) {
				return {
					block: true,
					reason:
						`Current mode (${effectiveMode}) forbids ${event.toolName}. ${modeScopeHint(effectiveMode)}.` +
						" Tool calls from other modes in history belong to finished phases; switch modes via /workflow:plan (planning) or /workflow:work (implementation).",
				};
			}
			if (
				!computeWorkflowToolNames(effectiveMode, config, todoToolName).includes(
					event.toolName,
				)
			) {
				return {
					block: true,
					reason:
						`Current mode (${effectiveMode}) does not allow ${event.toolName}. ${modeScopeHint(effectiveMode)}.` +
						" Call records from earlier turns do not carry over.",
				};
			}
			return;
		}

		// ── Workflow data protection: block direct read to .pi/workflow/ in all modes ──
		// Workflow data is only accessible via workflow tools (plan save/read,
		// approval journal, /workflow:status). This read guard is mode-independent so Work
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
							"Plan files (.pi/workflow/plan/) must be updated via workflow_plan_save(markdown='complete plan content'), " +
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
					reason: `Active worktree is invalid: ${validation.reason}. Run /workflow:status or /workflow:reset.`,
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
						return {
							block: true,
							reason: `${effectiveMode} Mode: ${denial} ${modeScopeHint(effectiveMode)}.`,
						};
					}
					return;
				}

				return {
					block: true,
					reason: `Current mode is ${effectiveMode}: modifying local files is not allowed. ${modeScopeHint(effectiveMode)}. Web search, read, and analysis tools remain available.`,
				};
			}

			return;
		}

		// Commit mode: prevent direct code file edits.
		if (state.mode === "commit") {
			if (event.toolName === "write" || event.toolName === "edit") {
				return {
					block: true,
					reason: "Commit Mode forbids code changes.",
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

// ── Context-window event reconcile (model_select / session_tree) ──────────

/**
 * Re-apply the configured role context-window after user model selection or
 * session-tree navigation, so the override survives manual switches back to
 * the role model BEFORE the next provider request (and its compaction
 * check). Same-id selections emit no model_select (Pi dedup), which the
 * before_agent_start reconcile also covers; this handler catches the
 * different-model → role-model switch and tree restores immediately.
 */
export function registerContextWindowEvents(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.on("model_select", async (_event, ctx) => {
		await reconcileContextWindowForSession(pi, ctx, getAgentDir);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await reconcileContextWindowForSession(pi, ctx, getAgentDir);
	});
}

// ── /workflow:enable command ─────────────────────────────────────────────────────────────

export function registerWorkflowEnableCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("workflow:enable", {
		description:
			"启用 workflow 并进入 Explore Mode，随后可用 /workflow:plan /workflow:work /workflow:review 等命令",
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
					"[workflow] /workflow:enable: explore role runtime failed to apply; continuing with reload to register workflow commands/tools",
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
 * Register all workflow slash commands except /workflow:enable (which is always registered).
 * Idempotent per ExtensionAPI instance — skips if already registered.
 */
export function registerAllWorkflowCommands(
	pi: ExtensionAPI,
	getAgentDir: () => string,
	_cwd: string,
): void {
	if (_workflowCommandsRegistered.has(pi)) return;

	registerWorkflowExploreCommand(pi, getAgentDir);
	registerWorkflowPlanCommand(pi, getAgentDir);
	registerWorkflowWorkCommand(pi, getAgentDir);
	// Register the command definition unconditionally. The handler resolves
	// codeReview.enabled with the real trusted session context before running.
	registerWorkflowReviewCommand(pi, getAgentDir);
	// Register the QA command definition unconditionally. The handler resolves
	// qa.enabled with the real trusted session context before running.
	registerWorkflowQaCommand(pi, getAgentDir);
	registerWorkflowMergeCommand(pi, getAgentDir);
	registerWorkflowCommitCommand(pi, getAgentDir);
	registerWorkflowStatusCommand(pi, getAgentDir);
	registerWorkflowResetCommand(pi);
	registerWorkflowInitCommand(pi, getAgentDir);
	registerWorkflowDisableCommand(pi);

	_workflowCommandsRegistered.add(pi);
}

// ── Active merge protection ────────────────────────────────────────────────

/**
 * Denial notice for mode-switching entries while a merge is active. Mode
 * commands must not silently drop an active merge baseline — the user closes
 * the run via workflow_merge_complete (completed/cancelled) or hard-recovers
 * via /workflow:reset.
 */
function activeMergeDenial(state: WorkflowState): string | null {
	if (state.mode !== "merge" || !state.mergeContext) return null;
	const mc = state.mergeContext;
	return (
		`当前存在 active merge：${mc.sourceBranch} → ${mc.targetBranch}（${mc.sourceKind}）。` +
		"请先在 Merge Mode 中调用 workflow_merge_complete(status=\"completed\" 或 \"cancelled\") 完成或中止本次集成；" +
		"需要硬恢复时使用 /workflow:reset。"
	);
}

export function registerWorkflowExploreCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("workflow:explore", {
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
			// Also enable workflow in case the user ran /workflow:disable earlier.
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

export function registerWorkflowPlanCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("workflow:plan", {
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

export function registerWorkflowWorkCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("workflow:work", {
		description:
			"跳过计划，直接进入 Work Mode；--worktree|-w [分支名] 在独立 Git worktree 中执行，任务正文用独立 -- 分隔",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const sessionKey = ctxSessionKey(ctx);

			// Parse args first — a parse error must produce zero side effects.
			const parsed = parseWorkCommandArgs(args ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const { worktree: wantWorktree, semanticBranch } = parsed.value;
			const workTask = parsed.value.task;

			const current = loadState(ctx.cwd, sessionKey);
			const mergeDenial = activeMergeDenial(current);
			if (mergeDenial) {
				ctx.ui.notify(mergeDenial, "error");
				return;
			}
			// The worktree-creation path is refused in Init Mode so a mode switch
			// cannot drop the single-file init lifecycle; the plain path keeps its
			// existing behavior.
			if (wantWorktree && current.mode === "init") {
				ctx.ui.notify(
					"当前处于 Init Mode。请先调用 workflow_init_complete 完成或取消初始化，再执行 /workflow:work --worktree。",
					"error",
				);
				return;
			}
			if (current.worktreePath) {
				const validation = validateWorktreeState(ctx.cwd, current);
				if (!validation.ok) {
					ctx.ui.notify(
						`Active worktree is invalid: ${validation.reason}. Run /workflow:status or /workflow:reset.`,
						"error",
					);
					return;
				}
			}

			// Resolve worktree fields BEFORE any git side effect. The plain path
			// keeps the existing selection logic: stay in the current directory, or
			// reuse an already-active worktree together with its workRunId.
			let workRunId: string;
			let worktreePath: string | undefined;
			let worktreeBranch: string | undefined;
			let worktreeBaseBranch: string | undefined;
			/** The worktree created BY THIS invocation — the only resource rollback may clean. */
			let createdWorktree: { path: string; branch: string } | undefined;

			if (current.worktreePath) {
				// Re-entry: always reuse the active worktree. An explicit semantic
				// name is only accepted when it maps to the current workRunId's full
				// branch name; anything else means the user wants a DIFFERENT task —
				// point them at a fresh Pi session instead of silently reusing.
				if (wantWorktree && semanticBranch) {
					const expected = buildWorktreeBranchName(
						current.workRunId ?? "",
						semanticBranch,
					);
					if (expected !== current.worktreeBranch) {
						ctx.ui.notify(
							`当前会话已绑定 active worktree（分支 ${current.worktreeBranch}），与指定的分支名 ${semanticBranch}（将生成分支 ${expected}）不匹配。` +
								`如需并行任务，请新开一个独立 Pi 会话执行 /workflow:work --worktree ${semanticBranch}。`,
							"error",
						);
						return;
					}
				}
				workRunId = current.workRunId ?? crypto.randomUUID();
				worktreePath = current.worktreePath;
				worktreeBranch = current.worktreeBranch;
				worktreeBaseBranch = current.worktreeBaseBranch;
			} else if (wantWorktree) {
				// Fresh workflow-managed worktree from the current checkout's commit
				// baseline. Uncommitted changes stay in the source checkout; git's
				// atomic `worktree add -b` rejects path/branch collisions.
				workRunId = crypto.randomUUID();
				try {
					const created = createWorktree(ctx.cwd, workRunId, semanticBranch);
					worktreePath = created.path;
					worktreeBranch = created.branch;
					worktreeBaseBranch = created.baseBranch;
					createdWorktree = { path: created.path, branch: created.branch };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					// No predictive cleanup: a collision or partial residue may belong
					// to a concurrent creator; report the helper error and let the user
					// inspect before anything is deleted.
					ctx.ui.notify(
						`创建 worktree 失败：${message}\n` +
							"未修改 workflow 状态。如产生残留，可用 /workflow:status、git worktree list 或 /workflow:reset 检查清理。",
						"error",
					);
					return;
				}
			} else {
				workRunId = crypto.randomUUID();
			}

			const state: WorkflowState = {
				...DEFAULT_STATE,
				workflowEnabled: current.workflowEnabled,
				mode: "work",
				workRunId,
				worktreePath,
				worktreeBranch,
				worktreeBaseBranch,
				// Capture the session leaf so the Implementation Reviewer can scope
				// authoritative requirement extraction to this Direct Work lifecycle.
				workStartEntryId:
					(ctx as { sessionManager?: { getLeafId?: () => string | undefined } })
						.sessionManager?.getLeafId?.() ?? undefined,
				// Direct Work has no approved plan; clear any stale approved todos
				// from a prior Approved Work run.
				approvedTodos: undefined,
			};

			// transitionWorkflowMode persists state BEFORE runtime activation, so a
			// {ok:false} result or a throw can happen after the state was written.
			// Wrap the transition so both failure shapes share the rollback below.
			let result: WorkflowModeTransitionResult;
			try {
				result = await transitionWorkflowMode({
					pi,
					ctx,
					sessionKey,
					nextState: state,
					getAgentDir,
				});
			} catch (err) {
				result = {
					ok: false,
					state,
					reason: err instanceof Error ? err.message : String(err),
				};
			}
			if (!result.ok) {
				// Restore the original state snapshot (state + runtime) via the same
				// transition helper, then only on a verified restore clean up the
				// worktree this invocation created.
				let restored = false;
				let restoreError: string | undefined;
				try {
					const restore = await transitionWorkflowMode({
						pi,
						ctx,
						sessionKey,
						nextState: current,
						getAgentDir,
					});
					restored = restore.ok;
					if (!restore.ok) restoreError = restore.reason;
				} catch (err) {
					restoreError = err instanceof Error ? err.message : String(err);
				}
				if (restored) {
					let cleanupNote = "";
					if (createdWorktree) {
						const cleanup = removeCreatedWorktree(
							ctx.cwd,
							createdWorktree.path,
							createdWorktree.branch,
						);
						if (!cleanup.ok) {
							cleanupNote = `\n清理本次创建的 worktree 失败：\n${cleanup.diagnostics.join("\n")}`;
						}
					}
					ctx.ui.notify(
						`进入 Work Mode 失败：${result.reason}。已恢复原 workflow 状态。${cleanupNote}`,
						"error",
					);
				} else {
					// Restore failed or is indeterminate: keep every resource so the
					// persisted state never points at a deleted directory, and hand
					// the user explicit recovery entries.
					const residue = createdWorktree
						? `已保留本次创建的 worktree：${createdWorktree.path}（分支 ${createdWorktree.branch}）。`
						: "";
					ctx.ui.notify(
						`进入 Work Mode 失败：${result.reason}\n` +
							`恢复原状态失败：${restoreError ?? "(unknown)"}\n${residue}\n` +
							"请用 /workflow:status 检查当前状态，并按需用 /workflow:reset 恢复。",
						"error",
					);
				}
				return;
			}

			// Success-only side effects. If any of them fails, keep the activated
			// worktree (state already references it) and report loudly.
			try {
				const overlay = getWorkflowOverlay();
				if (overlay) {
					overlay.clearBookkeeping();
					overlay.update(state.todos);
				}

				const sessionName = workTask
					? `work: ${workTask.slice(0, 40)}`
					: "workflow: work";
				pi.setSessionName(sessionName);

				if (createdWorktree) {
					ctx.ui.notify(
						`已进入 Work Mode（独立 worktree）。\n目录：${createdWorktree.path}\n分支：${worktreeBranch}（基于 ${worktreeBaseBranch} 的提交基线）\n` +
							"当前目录的未提交修改保留在原目录；提交用 /workflow:commit，集成用 /workflow:merge。" +
							(workTask ? "" : "可直接描述任务。"),
						"info",
					);
				} else if (worktreePath) {
					ctx.ui.notify(
						`已进入 Work Mode（复用 active worktree）。\n目录：${worktreePath}\n分支：${worktreeBranch}`,
						"info",
					);
				} else {
					ctx.ui.notify("已进入 Work Mode。可以直接描述任务。", "info");
				}

				// Worktree notice is injected into the stable system prompt by
				// buildModeMessageBody; do not repeat it in the kickoff message.
				if (workTask) {
					pi.sendUserMessage(workTask);
				}
			} catch (sideEffectErr) {
				console.error(
					`[workflow] /workflow:work post-transition side effects failed (worktree kept): ${sideEffectErr instanceof Error ? sideEffectErr.message : sideEffectErr}`,
				);
				try {
					ctx.ui.notify(
						"Work Mode 已激活；会话命名/通知/任务发送部分失败，可直接继续输入任务。",
						"error",
					);
				} catch { /* UI unavailable — the console error already records it */ }
			}
		},
	});
}

// registerWorkflowReviewCommand — on-demand unified review of the current workspace.
export function registerWorkflowReviewCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("workflow:review", {
		description:
			"Run the unified on-demand review of the current workspace (incl. active worktree). A delegated code review spec (ocr delegate, zero LLM) is included when codeReview.enabled is true.",
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
					"workflow review: /workflow:review requires interactive mode (TUI/RPC). " +
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
				`Active worktree is invalid: ${validation.reason}. Run /workflow:status or /workflow:reset.`,
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

	const promptText = `Please run the unified review loop.

Review scope: the current workspace (including the active worktree).

Requirements:
1. Round one: call \`workflow_review()\` with no arguments to launch the independent reviewer over the current workspace.
2. After each review result, verify each Critical/Important finding yourself — does it actually hold?
3. Fix confirmed issues and run the most relevant tests.
4. After fixing, call \`workflow_review\` again; keep the review → fix → re-review loop going until no new Critical/Important findings appear.
5. When you judge a Critical/Important finding to be a misjudgment, out of scope, unnecessary, or conflicting with project constraints, call \`workflow_review({ feedback: "..." })\` next round with per-item technical rationale and verifiable evidence (\`file:line\` / command output). Stay detailed, focused, and factual; fabricated evidence is useless — the reviewer verifies independently.
6. If round one already has no Critical/Important findings, end the loop. After 2-3 rounds of unresolved disagreement, stop and hand it to the user.
7. Handle Minor findings at your discretion; they do not block review passing.
8. \`/workflow:commit\` is always directly available and does not require review; you may commit anytime once review is done.`;
	ctx.ui.notify("Starting unified review loop: workspace.", "info");
	pi.setSessionName("review: workspace");
	pi.sendUserMessage(promptText);
}

// registerWorkflowQaCommand — Review → QA delivery-verification driver.
export function registerWorkflowQaCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("workflow:qa", {
		description:
			"Run the Review → QA delivery loop: unified review to PASS, then an independent runtime QA agent that actually executes the affected functionality.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const sessionKey = ctxSessionKey(ctx);
			const current = loadState(ctx.cwd, sessionKey);
			const mergeDenial = activeMergeDenial(current);
			if (mergeDenial) {
				ctx.ui.notify(mergeDenial, "error");
				return;
			}
			// Init Mode must finish first: switching modes here would clear
			// initTargetPath/initReturnMode and orphan the init run.
			if (current.mode === "init") {
				ctx.ui.notify(
					"当前处于 Init Mode。请先调用 workflow_init_complete 完成或取消初始化，再执行 /workflow:qa。",
					"error",
				);
				return;
			}
			const config = loadConfigForContext(ctx.cwd, getAgentDir(), sessionKey, ctx);
			if (!config.qa.enabled) {
				ctx.ui.notify(
					"QA is not enabled. Set qa.enabled: true in config and /reload.",
					"error",
				);
				return;
			}

			// JSON/print: no UI surface; stderr keeps stdout protocol/print output clean.
			if (ctx.mode === "json" || ctx.mode === "print") {
				console.error(
					"workflow qa: /workflow:qa requires interactive mode (TUI/RPC). " +
						"In JSON/print mode, call workflow_qa directly.",
				);
				return;
			}

			await startQaLoop(pi, ctx, getAgentDir, sessionKey, config.review.enabled);
			return;
		},
	});
}

/**
 * Shared Review → QA loop kickoff. Validates the worktree, moves the next
 * agent turn into Work runtime, and sends the driver prompt: unified review
 * to effective PASS first (when review is enabled), then workflow_qa; QA
 * defects loop back through Review before re-QA; a "QA status: BLOCKED"
 * report STOPS the loop for the user (no auto-install, no auto-retry).
 */
async function startQaLoop(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	getAgentDir: () => string,
	sessionKey: string,
	reviewEnabled: boolean,
): Promise<void> {
	const current = loadState(ctx.cwd, sessionKey);
	if (current.worktreePath) {
		const validation = validateWorktreeState(ctx.cwd, current);
		if (!validation.ok) {
			ctx.ui.notify(
				`Active worktree is invalid: ${validation.reason}. Run /workflow:status or /workflow:reset.`,
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

	const reviewStage = reviewEnabled
		? [
				"1. First run the unified Review loop to a valid PASS: call `workflow_review()`, fix confirmed issues one by one and run the most relevant tests, or dispute misjudgments next round via `workflow_review({ feedback: \"...\" })` (with file:line / command-output evidence) until PASS; identical inputs short-circuit and reuse the previous verdict. If round one already has no Critical/Important findings, end the Review phase directly. Stop and hand unresolved 2-3-round disagreements to the user.",
			].join("\n")
		: [
				"1. Review phase is absent (review.enabled=false): state that clearly to the user, then go straight to QA. After QA-reported defects are fixed, pause the combined loop and let the user decide whether to restore Review or move on; the combined chain only completes when both Review and QA actually pass.",
			].join("\n");
	const promptText = `Please run the Review → QA delivery-verification flow.

Scope: the current workspace (including the active worktree).

Requirements:
${reviewStage}
2. Once Review validly PASSes, call \`workflow_qa()\` (no arguments) to launch the independent runtime QA; the QA agent actually runs the affected functionality and reports per-flow PASS/FAIL/BLOCKED/SKIPPED evidence.
3. When QA reports product defects: confirm each against evidence → fix → run targeted checks → re-Review to PASS → run \`workflow_qa()\` again; recheck both phases after every implementation change. For disputed findings use each phase's feedback channel (\`workflow_review({ feedback })\` / \`workflow_qa({ feedback })\`; feedback must carry per-item verifiable evidence); after ~3 fix/re-review rounds without progress, stop and hand it to the user; handle Minor items at your discretion.
4. On "QA status: BLOCKED" end this run immediately: show the user the missing tools/capabilities, the blocked test flows, and what they must handle. Never install/upgrade/auto-download QA dependencies, never treat environment blockers as product defects, never auto-retry QA; continue only after the user resolves the blocker and explicitly re-triggers. Tool errors and user cancellation likewise stop the auto loop.
5. After QA passes, report the result to the user. \`/workflow:commit\` and \`/workflow:merge\` are always triggered explicitly by the user — never run them automatically.`;
	ctx.ui.notify("Starting Review → QA delivery loop: workspace.", "info");
	pi.setSessionName("qa: workspace");
	pi.sendUserMessage(promptText);
}


export function registerWorkflowCommitCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	// Command migrated from /commit to /workflow:commit with no compat alias (a
	// deliberate breaking CLI change). Registered through the same conditional
	// registration path as all other workflow commands.
	pi.registerCommand("workflow:commit", {
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
						`Active worktree is invalid: ${validation.reason}. Run /workflow:status or /workflow:reset.`,
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
				? `\n\nAdditional user requirements for the commit: ${args.trim()}`
				: "";

			pi.sendUserMessage(
				`Inspect the current diff, compose an appropriate commit message, and directly run git add and git commit.${extra}`,
			);
		},
	});
}

// ── /workflow:merge command ────────────────────────────────────────────────────────

/**
 * Register /workflow:merge: enter Merge Mode to integrate the source branch (the
 * active workflow worktree branch, or the current ordinary local branch) into
 * a target local branch. Default strategy is rebase + ff-only; trailing
 * natural-language instructions authorize a custom strategy. Syntax:
 *
 *   /workflow:merge [--target <branch>] [用户自然语言指令]
 *
 * Preflight rejects dirty source/target checkouts, detached-HEAD sources,
 * source==target, and unfinished sequencers; the baseline is then persisted
 * atomically with mode=merge BEFORE the kickoff message, so a crash mid-merge
 * never loses the merge context. Re-running /workflow:merge with an active context
 * never overwrites the baseline or the authorization.
 */
export function registerWorkflowMergeCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("workflow:merge", {
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
					"当前处于 Init Mode。请先调用 workflow_init_complete 完成或取消初始化，再执行 /workflow:merge。",
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
						`${MERGE_CONTEXT_MARKER}\n\n${buildMergeContextBody(current)}\n\nContinue this integration per the Active Merge Context.`,
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
						`Active worktree is invalid: ${validation.reason}. Run /workflow:status or /workflow:reset.`,
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
					: "regular local branch (current checkout)";
			const strategyLine = parsed.value.instructions
				? "User-authorized instructions are present (see the Active Merge Context injected this turn); only actions named verbatim by the instructions are authorized, and all other high-risk actions stay under the default bans."
				: `Default strategy: rebase \`${facts.sourceBranch}\` onto \`${facts.targetBranch}\`, resolve conflicts and verify, then call workflow_merge_complete(status="completed", finalize="ff-only").`;
			pi.sendUserMessage(
				[
					"# Merge Mode Task",
					`Source branch \`${facts.sourceBranch}\` → target branch \`${facts.targetBranch}\` (${kindLabel}).`,
					strategyLine,
					`To abort call workflow_merge_complete(status="cancelled"). The final movement of the target branch ref is performed by workflow_merge_complete.`,
				].join("\n\n"),
			);
		},
	});
}

export function registerWorkflowStatusCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("workflow:status", {
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
				const errMsg = `workflow:status: failed to resolve config sources: ${e instanceof Error ? e.message : String(e)}`;
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
			// explicit transitions and /workflow:settings saves.
			const activeModel = ctx.model;
			const activeThinking = pi.getThinkingLevel();
			msg += `\n\n# Effective Config`;
			msg += `\nprojectConfig: ${report.projectSkipped ? "skipped (untrusted)" : "active"}`;
			msg += `\nrole: ${role}`;
			msg += `\nactive runtime model: ${activeModel ? `${activeModel.provider}/${activeModel.id}` : "(none — role config applies)"}`;
			msg += `\nactive runtime thinking: ${activeThinking}`;
			msg += `\nconfigured role model: ${roleSpec ? `${roleSpec.provider}/${roleSpec.model}` : "(none)"}`;
			msg += `\nconfigured role thinking: ${roleSpec?.thinking ?? "(none)"}`;
			// Context-window diagnostics: configured override vs Pi baseline vs the
			// actually-active runtime window, plus workflow ownership. Locates a
			// stale override (cleared config but active clone), a lost override
			// (manual same-id re-select), and failed applies.
			const roleModelForWindow = roleSpec
				? ctx.modelRegistry.find(roleSpec.provider, roleSpec.model)
				: undefined;
			const ownership = getContextWindowOverride(sessionKey);
			msg += `\nconfigured contextWindow: ${
				roleSpec?.contextWindow !== undefined ? roleSpec.contextWindow : "(inherit)"
			} (source: ${report.sources[`models.${role}.contextWindow`]})`;
			msg += `\npi baseline window: ${
				roleModelForWindow?.contextWindow ?? "(model unavailable)"
			}`;
			msg += `\nactive runtime contextWindow: ${activeModel?.contextWindow ?? "(none)"}`;
			msg += `\nworkflow window ownership: ${
				ownership
					? `active (applied ${ownership.appliedWindow}, original ${ownership.originalWindow}, ${ownership.provider}/${ownership.modelId})`
					: "inactive"
			}`;
			msg += `\nworkflow.autoEnter: ${eff.workflow.autoEnter} (source: ${report.sources["workflow.autoEnter"]})`;
			msg += `\nplanReview.enabled: ${eff.planReview.enabled} (source: ${report.sources["planReview.enabled"]})`;
			msg += `\nreview.enabled: ${eff.review.enabled} (source: ${report.sources["review.enabled"]})`;
			msg += `\nqa.enabled (Runtime QA): ${eff.qa.enabled} (source: ${report.sources["qa.enabled"]})`;
			msg += `\ncodeReview.enabled (Delegated Code Review): ${eff.codeReview.enabled} (source: ${report.sources["codeReview.enabled"]})`;
			for (const r of ["explore", "plan", "planReview", "review", "qa", "work", "commit"] as const) {
				const spec = eff.models[r];
				if (!spec) continue;
				msg += `\nmodels.${r}: ${spec.provider}/${spec.model} / ${spec.thinking ?? "(none)"} / ctx ${
					spec.contextWindow !== undefined ? spec.contextWindow : "(inherit)"
				}`;
				msg += ` (provider: ${report.sources[`models.${r}.provider`]}, model: ${report.sources[`models.${r}.model`]}, thinking: ${report.sources[`models.${r}.thinking`]}, contextWindow: ${report.sources[`models.${r}.contextWindow`]})`;
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

export function registerWorkflowDisableCommand(pi: ExtensionAPI): void {
	pi.registerCommand("workflow:disable", {
		description: "禁用 workflow，恢复普通 Pi",
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

			// Release a workflow-owned context-window clone (restore the original
			// window on the matching active model) before leaving workflow runtime.
			await releaseContextWindowOverride(pi, ctx, sessionKey);

			// Remove workflow tools from active set before reload so
			// the next turn starts clean.
			deactivateWorkflowTools(pi);

			const overlay = getWorkflowOverlay();
			if (overlay) overlay.dispose();

			ctx.ui.setStatus("lite-sp", undefined);
			ctx.ui.notify("已禁用 workflow。正在重载扩展...", "info");
			await ctx.reload();
		},
	});
}

export function registerWorkflowResetCommand(pi: ExtensionAPI): void {
	pi.registerCommand("workflow:reset", {
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
						"Active merge 的来源 worktree 已不在状态中；请手动恢复后重试 /workflow:reset。",
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

			// Release a workflow-owned context-window clone (restore the original
			// window on the matching active model) — /workflow:reset keeps running
			// normal Pi runtime without a reload, so the clone must not linger.
			await releaseContextWindowOverride(pi, ctx, sessionKey);

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
			// Drop the QA round history (session-scoped per-work-run sidecar) so
			// a new work run starts with no stale QA findings.
			fs.rmSync(qaHistoryPath(ctx.cwd, sessionKey), { force: true });

			ctx.ui.setStatus("lite-sp", undefined);
			ctx.ui.notify("已清空 workflow 状态。", "info");
		},
	});
}

export function registerWorkflowInitCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	pi.registerCommand("workflow:init", {
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
	const rootRel = root === cwd ? "repo root" : `repo root (${root})`;
	const targetRel = path.basename(targetPath);

	const existingClause = existingFile
		? `The repo already has ${existingFile}. Treat it as an unverified information source: audit it for staleness, omissions, conflicts, and redundancy, then rebuild it to the current best state — no conservative merging.`
		: "The repo has no AGENTS.md; a new one will be created.";

	const statusClause =
		repoStatus === "empty"
			? `Repo status: empty (only git/.pi/AGENTS.md). Follow the empty-repo flow item by item: project goals & deliverable shape, language/runtime/framework/package manager, build/test/lint/format commands, directory & naming conventions, commit conventions; add deploy/release and key compatibility/security/performance constraints as the project shape demands.`
			: `Repo status: existing. First scan README, docs, build/CI config, source, deploy files, and git history; adopt clearly evidenced facts directly; grill item-by-item on gaps, conflicts, competing options, and team preferences.`;

	pi.sendUserMessage(
		[
			`# Init Mode task: ${targetRel} at ${rootRel}`,
			existingClause,
			statusClause,
			`Target file: ${targetPath}`,
			`Follow the Init Mode flow: gather evidence → confirm/decide item by item → show final findings, user-confirmed decisions, and the old rules slated for removal → rebuild a compact AGENTS.md.`,
			`When done call workflow_init_complete(status="completed"); use skipped when the user opts out of updating/generating; cancelled on user abort.`,
		].join("\n\n"),
	);
}
