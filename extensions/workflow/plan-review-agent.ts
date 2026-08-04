/**
 * plan-review-agent — independent, multi-turn plan reviewer.
 *
 * Replaces the former one-shot sidecall. At workflow_plan_review time this
 * module spawns a FRESH child AgentSession (in-memory, non-persistent) that:
 *
 *  - Inherits the parent Plan session's active information-tool surface on a
 *    best-effort basis, minus every workflow-owned tool. Built-in tools
 *    (read/bash/edit/write/grep/find/ls) are reconstructed by
 *    createAgentSession; active extension/MCP/Web/remote/memory tools are
 *    reconstructed from their owning extension source paths. pi-workflow
 *    itself is never loaded into the child (its only non-workflow override,
 *    bash, is treated as builtin).
 *  - Receives authoritative inputs only: original user requirements (scoped
 *    to the current Plan lifecycle), confirmed grilling decisions, and the
 *    saved Final Plan. Planner reasoning, thinking, tool results, and prior
 *    review output are excluded by construction.
 *  - Runs under a read-only child safety extension that blocks direct
 *    .pi/workflow/ reads and confines write/edit to the Plan scratch root,
 *    matching the parent Explore/Plan file boundary.
 *  - Is bounded by a single 30-minute total timeout combined with the parent
 *    AbortSignal. No turn/tool-call limit — the reviewer controls its own
 *    exploration.
 *  - Is always disposed in `finally`; timeout/user cancellation aborts the
 *    active AgentSession before returning an explicit tool error.
 */

import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	StopReason,
	ThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai";
import path from "node:path";
import { tmpdir } from "node:os";
import type { GrillTurn, ModelSpec, Thinking } from "./types.js";
import { workflowManagedToolNames } from "./mode.js";
import { isAllowedPlanScratchPath, isWorkflowDataPath } from "./guards.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Single internal total timeout for the whole reviewer run. */
export const REVIEWER_TOTAL_TIMEOUT_MS = 1_800_000; // 30 minutes

/**
 * Built-in tool names that createAgentSession reconstructs from its own
 * definitions. We never collect an extension source path for these, even when
 * the parent has overridden them (e.g. pi-workflow's bash override). This keeps
 * pi-workflow's own extension path out of the child loader, so workflow tools
 * cannot re-register inside the reviewer runtime.
 */
const BUILTIN_TOOL_NAMES = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

// ── Result type ──────────────────────────────────────────────────────────────

export interface PlanReviewAgentResult {
	text: string;
	reviewerModel: string;
	thinking?: Thinking;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	elapsedMs: number;
	turns: number;
	toolCalls: number;
	requestedTools: string[];
	activeTools: string[];
	unavailableTools: string[];
}

// ── Branch entry shape (kept minimal + structural for testability) ──────────

/** Minimal session branch entry shape used by requirement extraction. */
export interface ReviewBranchEntry {
	id?: string;
	type: string;
	message?: { role?: string; content?: unknown };
}

/**
 * Extract authoritative user-requirement text from the active session branch,
 * scoped to the current Plan lifecycle.
 *
 * - When `planStartEntryId` is present and found, only user messages at or after
 *   that entry are collected (the Plan discussion).
 * - If no user message follows the marker, the nearest preceding user message
 *   is included (the requirement that triggered /plan).
 * - Assistant messages, thinking, tool results, custom entries, and prior-plan
 *   content (which lives before the marker) are excluded by construction.
 *
 * Pure function — no I/O — so it can be unit-tested with fixture branches.
 */
export function extractUserRequirements(
	branch: ReviewBranchEntry[] | undefined | null,
	planStartEntryId?: string,
): string[] {
	if (!branch || branch.length === 0) return [];

	let startIndex = 0;
	if (planStartEntryId) {
		const idx = branch.findIndex((e) => e && e.id === planStartEntryId);
		if (idx >= 0) {
			startIndex = idx;
		} else {
			// Marker lost (session pruning / stale state / cross-session replay).
			// Scoping is unreliable, so return nothing rather than risk leaking
			// prior-plan user content into the reviewer task. The task builder
			// flags the gap and lets the reviewer infer intent from the plan's
			// Goal section.
			return [];
		}
	}

	const collect = (from: number, toExclusive: number): string[] => {
		const out: string[] = [];
		for (let i = from; i < toExclusive; i++) {
			const e = branch[i];
			if (!e || e.type !== "message") continue;
			const msg = e.message;
			if (!msg || msg.role !== "user") continue;
			const text = extractTextContent(msg.content);
			if (text.trim()) out.push(text);
		}
		return out;
	};

	let reqs = collect(startIndex, branch.length);

	// No user messages after the marker — fall back to the nearest prior user
	// message (the requirement that triggered /plan).
	if (reqs.length === 0 && startIndex > 0) {
		for (let i = startIndex - 1; i >= 0; i--) {
			const e = branch[i];
			if (!e || e.type !== "message") continue;
			const msg = e.message;
			if (!msg || msg.role !== "user") continue;
			const text = extractTextContent(msg.content);
			if (text.trim()) {
				reqs = [text];
				break;
			}
		}
	}

	return reqs;
}

/** Pull plain text out of a user message content (string or content blocks). */
function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) =>
				b && typeof b === "object" && (b as { type?: string }).type === "text"
					? String((b as { text?: unknown }).text ?? "")
					: "",
			)
			.join("");
	}
	return "";
}

/** Format confirmed grilling decisions for the reviewer task. */
export function formatConfirmedDecisions(
	decisions: GrillTurn[] | undefined,
): string {
	if (!decisions || decisions.length === 0) return "(none recorded)";
	return decisions
		.map((d, i) => {
			const answer = d.userAnswer?.trim()
				? d.userAnswer.trim()
				: d.recommendedAnswer.trim();
			const status = d.decisionStatus ? ` [${d.decisionStatus}]` : "";
			const notes = d.notes?.trim() ? `\n  notes: ${d.notes.trim()}` : "";
			return `${i + 1}. Q: ${d.question.trim()}\n  A: ${answer}${status}${notes}`;
		})
		.join("\n");
}

// ── Reviewer prompts ─────────────────────────────────────────────────────────

export const REVIEWER_SYSTEM_PROMPT = `# Independent Plan Reviewer

You are an independent senior engineer reviewing a CANDIDATE implementation plan. You receive the authoritative user requirements, the confirmed decisions, and the candidate Final Plan. The project's own rules, context files, and skills are loaded automatically. You have read-only access to the repository and the same information tools the planner had.

## Your mandate
Independently validate that the plan is correct, complete, and feasible by inspecting the actual repository, documentation, MCP, web, and your other active information tools. Do NOT trust the plan's claims — verify them against evidence you gather yourself.

## Review focus
- Spec compliance: does the plan cover the stated goal? Does it add unrequested scope? Does it miss implicit or explicit requirements?
- Feasibility & fit: does the approach fit the existing project structure, conventions, and APIs? Are new dependencies justified and minimal? Any compatibility, configuration, data-migration, or security risks?
- Affected areas: did the plan identify ALL affected files and modules? Verify by searching the codebase yourself.
- Execution readiness: are the todos small and actionable (concrete file paths, clear steps)? Does the test plan prove the core behavior that can break? Are risks and rollback points identified?
- Tests: does the test plan actually exercise the behavior most likely to break?

## Constraints (HARD — do not violate)
- You are READ-ONLY for project files. Do NOT modify project files, config, memory, skills, or settings.
- You may write temporary probe scripts ONLY under the OS scratch root: ${path.join(tmpdir(), "pi-workflow-plan-scratch")}/
- No git mutations, no commits, no dependency installs, no project-mutating shell commands. Read-only inspection and scratch probes only.
- Do NOT interact with the user. If something is ambiguous or unverifiable, report it as an explicit assumption in your final review for the parent planner and user to resolve.
- Direct reads of .pi/workflow/ are blocked by the runtime; rely on the plan text provided plus your own exploration.

## Output
Produce exactly ONE final review using this structure, then stop (no further tool calls):

## 审查结果

### Critical
- C1: [问题描述] → [建议修订]

### Important
- I1: [问题描述] → [建议修订]

### Minor
- M1: [问题描述] → [建议修订]

### Summary
整体评估：[一段话总结]

## Rules
- Ground every issue in concrete repository evidence: cite file paths, line ranges, API signatures, config, or documentation you actually inspected.
- Do not fabricate issues to seem thorough. Only flag genuine concerns.
- If you could not verify something, state it explicitly as an unverified assumption rather than asserting it.
- Each issue must have a concrete description and a suggested revision.
- Leave a severity section empty if there are no genuine issues at that level.
`;

/** Assemble the four-section reviewer task. Pure function. */
export function buildReviewerTask(opts: {
	requirements: string[];
	decisions: GrillTurn[] | undefined;
	planMarkdown: string;
}): string {
	const requirements = opts.requirements.length
		? opts.requirements.map((r) => r.trim()).join("\n\n---\n\n")
		: "(none captured — infer the intent from the plan's Goal section, and flag the gap if material)";

	return [
		"# 1. Authoritative User Requirements",
		"",
		requirements,
		"",
		"# 2. Confirmed Decisions",
		"",
		formatConfirmedDecisions(opts.decisions),
		"",
		"# 3. Candidate Final Plan",
		"",
		opts.planMarkdown.trim(),
		"",
		"# 4. Review Assignment",
		"",
		"Review the Candidate Final Plan above against the Authoritative User Requirements and Confirmed Decisions, using your own independent exploration of the repository and your active information tools. Follow your system prompt. When you are done, emit only the final review (no further tool calls).",
	].join("\n");
}

// ── Tool reconstruction ──────────────────────────────────────────────────────

/**
 * Snapshot the parent Plan session's active information-tool surface and strip
 * out every workflow-owned tool. Returns the filtered tool-name allowlist and
 * the extension source paths that must be reconstructed in the child loader.
 *
 * Built-in tools (read/bash/edit/write/grep/find/ls) are never path-collected:
 * createAgentSession reconstructs them, and skipping them keeps pi-workflow's
 * own extension path (its bash override is the only non-workflow tool it
 * registers) out of the child loader.
 */
export function reconstructReviewerToolSurface(pi: ExtensionAPI): {
	requestedTools: string[];
	extensionPaths: string[];
} {
	const active = pi.getActiveTools() ?? [];
	const workflowNames = workflowManagedToolNames(pi);
	const requestedTools = active.filter((name) => !workflowNames.has(name));

	let allTools: ToolInfo[] = [];
	try {
		allTools = pi.getAllTools() ?? [];
	} catch {
		// Introspection failure → reconstruct builtins only; external tools
		// become "unavailable" in the result diagnostics.
		allTools = [];
	}
	const toolByName = new Map<string, ToolInfo>(allTools.map((t) => [t.name, t]));

	const extensionPaths = new Set<string>();
	for (const name of requestedTools) {
		if (BUILTIN_TOOL_NAMES.has(name)) continue;
		const info = toolByName.get(name);
		if (!info) continue;
		const src = info.sourceInfo?.source;
		// Built-in and SDK custom tools are reconstructed by createAgentSession.
		if (src === "builtin" || src === "sdk") continue;
		const p = info.sourceInfo?.path;
		// Synthetic markers (e.g. <builtin:bash>) are not real loadable paths.
		if (p && !p.startsWith("<")) extensionPaths.add(p);
	}

	return { requestedTools, extensionPaths: [...extensionPaths] };
}

// ── Child safety extension ──────────────────────────────────────────────────

/** Minimal tool_call event shape the guard inspects. */
interface ToolCallLike {
	toolName: string;
	input?: { path?: string; filePath?: string } | Record<string, unknown>;
}

/**
 * Roots the reviewer safety extension must protect. For an Implementation
 * Review running in an active worktree, `primaryCwd` is the main checkout and
 * `reviewCwd` is the worktree path; for a Plan Review both are the same cwd.
 * Reads under `.pi/workflow/` in EITHER root are blocked so a worktree
 * reviewer cannot read the main checkout's workflow data and vice versa.
 */
export interface ReviewerSafetyRoots {
	primaryCwd: string;
	reviewCwd: string;
}

/**
 * Build the inline child-runtime safety extension. It reuses the existing pure
 * path guards to enforce the Plan-equivalent read/write boundary inside the
 * reviewer runtime:
 *  - read: block any path under .pi/workflow/ in EITHER the primary or review cwd
 *  - write/edit: allow only the Plan scratch root
 * Workflow tools are already absent from the child allowlist; bash mutation is
 * governed by the reviewer system prompt (matching the parent guard policy of
 * not scanning shell commands).
 */
export function createReviewerSafetyExtension(roots: ReviewerSafetyRoots): InlineExtension {
	return {
		name: "plan-review-safety",
		factory: (pi: ExtensionAPI) => {
			pi.on("tool_call", (event, _ctx: ExtensionContext) => {
				const e = event as unknown as ToolCallLike;
				const input = (e.input ?? {}) as Record<string, unknown>;
				// Cover the common file-target property names used by builtin
				// read/write/edit and by external tools (MCP/remote/Web) that
				// may expose file targets under different keys. This is
				// defense-in-depth; the reviewer system prompt is the primary
				// write-prohibition and builtin tools already use `path`.
				const target =
					(typeof input.path === "string" && input.path) ||
					(typeof input.filePath === "string" && input.filePath) ||
					(typeof input.file_path === "string" && input.file_path) ||
					(typeof input.filename === "string" && input.filename) ||
					(typeof input.destination === "string" && input.destination) ||
					(typeof input.outputPath === "string" && input.outputPath) ||
					undefined;
				if (e.toolName === "read") {
					if (
						target &&
						(isWorkflowDataPath(target, roots.primaryCwd) ||
							isWorkflowDataPath(target, roots.reviewCwd))
					) {
						return {
							block: true,
							reason:
								"Reviewer is read-only for workflow data (.pi/workflow/).",
						};
					}
					return;
				}
				if (e.toolName === "write" || e.toolName === "edit") {
					if (!target) {
						return {
							block: true,
							reason:
								"Reviewer write/edit requires an absolute path under the Plan scratch root.",
						};
					}
					const denial = isAllowedPlanScratchPath(roots.reviewCwd, target);
					if (denial) {
						return { block: true, reason: `Reviewer: ${denial}` };
					}
					return;
				}
				return;
			});
		},
	};
}

// ── Child model runtime ─────────────────────────────────────────────────────

/**
 * Create a child ModelRuntime reading the same auth.json / models.json as the
 * parent, then best-effort copy runtime-only provider registrations and API
 * keys that live in memory (set via pi.registerProvider / setRuntimeApiKey)
 * and would otherwise be absent from the file-based runtime.
 */
async function createChildModelRuntime(
	ctx: ExtensionContext,
	agentDir: string,
): Promise<ModelRuntime> {
	const authPath = path.join(agentDir, "auth.json");
	const modelsPath = path.join(agentDir, "models.json");
	const childRuntime = await ModelRuntime.create({ authPath, modelsPath });

	const parentRegistry = ctx.modelRegistry;
	let ids: readonly string[];
	try {
		ids = parentRegistry.getRegisteredProviderIds();
	} catch {
		// Introspection unavailable — fall back to file-based auth only.
		ids = [];
	}
	// Each provider is copied independently so one provider's failure (native
	// lookup, config lookup, key resolution, or registration) cannot abort the
	// remaining providers. File-based auth already covers the common case.
	for (const id of ids) {
		try {
			// Providers register through one of two overloads and land in separate
			// internal stores: a full `Provider` object (registerProvider(provider))
			// goes into nativeExtensionProviders, while a config (registerProvider(id,
			// config)) goes into extensionProviders. Extensions like pi-axonhub use
			// the Provider-object overload, so querying getRegisteredProviderConfig
			// alone returns undefined for them and they'd never be copied. Copy both
			// shapes through their matching sink so the child can reproduce the same
			// providers regardless of registration style.
			const nativeProvider = parentRegistry.getRegisteredNativeProvider(id);
			if (nativeProvider) {
				try {
					childRuntime.registerNativeProvider(nativeProvider);
				} catch {
					// Built-in/native providers may reject re-registration; skip.
				}
			} else {
				const config = parentRegistry.getRegisteredProviderConfig(id);
				if (config) {
					try {
						childRuntime.registerProvider(id, config);
					} catch {
						// Native/builtin providers may reject re-registration; skip.
					}
				}
			}
			const key = await parentRegistry.getApiKeyForProvider(id);
			if (key) {
				try {
					await childRuntime.setRuntimeApiKey(id, key);
				} catch {
					// best-effort; provider may not accept runtime keys.
				}
			}
		} catch {
			// One provider failed; continue with the rest.
		}
	}

	return childRuntime;
}

// ── Usage aggregation ───────────────────────────────────────────────────────

function emptyUsageAccumulator(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function accumulateUsage(acc: Usage, usage: Usage | undefined): void {
	if (!usage) return;
	acc.input += usage.input ?? 0;
	acc.output += usage.output ?? 0;
	acc.cacheRead += usage.cacheRead ?? 0;
	acc.cacheWrite += usage.cacheWrite ?? 0;
	acc.totalTokens += usage.totalTokens ?? 0;
	acc.cost.input += usage.cost?.input ?? 0;
	acc.cost.output += usage.cost?.output ?? 0;
	acc.cost.cacheRead += usage.cost?.cacheRead ?? 0;
	acc.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
	acc.cost.total += usage.cost?.total ?? 0;
}

// ── Main runner ──────────────────────────────────────────────────────────────

export interface RunPlanReviewAgentOptions {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	modelSpec: ModelSpec;
	planMarkdown: string;
	decisions: GrillTurn[];
	/** Active session branch (from sessionManager.getBranch()). */
	branch: ReviewBranchEntry[] | undefined;
	/** Session leaf captured when /plan started. */
	planStartEntryId?: string;
	/** Parent tool AbortSignal (user cancellation / turn abort). */
	parentSignal?: AbortSignal;
	/** Streaming progress callback. */
	onProgress?: (text: string) => void;
}

// ── Shared independent reviewer runner ──────────────────────────────────────

/**
 * Options for the shared independent reviewer runner. Both Plan Review and
 * Implementation Review call this with their own authoritative task, system
 * prompt, and review cwd. The caller computes any post-run artifacts (e.g. the
 * Implementation Review workspace fingerprint) AFTER this returns — the child
 * session is fully disposed by then.
 */
export interface RunIndependentReviewerOptions {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	modelSpec: ModelSpec;
	/** Fully-assembled authoritative task (requirements + plan/decisions or
	 *  lifecycle requirements + todos). The runner passes it verbatim. */
	task: string;
	/** Behavioral mandate appended to the child system prompt. */
	systemPrompt: string;
	/** Cwd the reviewer runs in: active worktree path for Implementation
	 *  Review, ctx.cwd for Plan Review. */
	reviewCwd: string;
	/** Roots the safety extension must protect (primary + review cwd). */
	safetyRoots: ReviewerSafetyRoots;
	/** Parent tool AbortSignal (user cancellation / turn abort). */
	parentSignal?: AbortSignal;
	/** Streaming progress callback. */
	onProgress?: (text: string) => void;
	/** Label for timeout/abort messages, e.g. "Plan review" / "Implementation review". */
	progressLabel: string;
}

/**
 * Run an independent reviewer in a fresh in-memory AgentSession. Creates the
 * child runtime, drives one prompt to completion (the reviewer's full
 * multi-turn exploration), and returns the final text plus operational
 * metadata.
 *
 * The child session is ALWAYS fully disposed (abort + unsubscribe + dispose)
 * before this returns, so the caller can safely compute post-run artifacts
 * (workspace fingerprint) without racing reviewer I/O.
 *
 * Timeout or parent cancellation aborts the active AgentSession before
 * throwing an explicit error.
 */
export async function runIndependentReviewer(
	opts: RunIndependentReviewerOptions,
): Promise<PlanReviewAgentResult> {
	const { ctx, pi, modelSpec, task, systemPrompt, reviewCwd, safetyRoots, progressLabel } =
		opts;
	const reviewerLabel = `${modelSpec.provider}/${modelSpec.model}`;
	const labelSlug = progressLabel.toLowerCase().replace(/\s+/g, "-");
	const startedAt = Date.now();

	// ── Tool surface reconstruction ──
	const { requestedTools, extensionPaths } = reconstructReviewerToolSurface(pi);

	// ── Model / auth ──
	const agentDir = getAgentDir();
	const childRuntime = await createChildModelRuntime(ctx, agentDir);

	const model =
		childRuntime.getModel(modelSpec.provider, modelSpec.model) ??
		ctx.modelRegistry.find(modelSpec.provider, modelSpec.model);
	if (!model) {
		throw new Error(`${progressLabel} model not found: ${reviewerLabel}`);
	}

	// Thinking level: pass the configured level; "off" disables reasoning.
	const thinkingLevel: ThinkingLevel | undefined =
		modelSpec.thinking && modelSpec.thinking !== "off"
			? (modelSpec.thinking as ThinkingLevel)
			: undefined;

	// ── Resource loader: project context + skills + active extensions only ──
	// Use reviewCwd so the reviewer sees the worktree's project context when
	// running inside an active worktree.
	let settingsManager: SettingsManager;
	try {
		settingsManager = SettingsManager.create(reviewCwd, agentDir);
	} catch {
		settingsManager = SettingsManager.inMemory();
	}
	const resourceLoader = new DefaultResourceLoader({
		cwd: reviewCwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: extensionPaths,
		extensionFactories: [createReviewerSafetyExtension(safetyRoots)],
		// Inject the reviewer behavioral mandate (read-only constraint, output
		// format, evidence-grounding, scratch-write policy) into the child
		// session's system prompt. Appended after the project context (AGENTS.md
		// + default) so the reviewer sees project rules AND its review mandate.
		appendSystemPrompt: [systemPrompt],
	});
	await resourceLoader.reload({
		// Align child project-trust resolution with the parent session.
		resolveProjectTrust: async () => ctx.isProjectTrusted(),
	});

	// ── Child AgentSession ──
	const { session } = await createAgentSession({
		cwd: reviewCwd,
		agentDir,
		modelRuntime: childRuntime,
		model,
		thinkingLevel,
		tools: requestedTools,
		resourceLoader,
		sessionManager: SessionManager.inMemory(reviewCwd),
		sessionStartEvent: { type: "session_start", reason: "new" },
	});

	// ── Progress / usage / cancellation wiring ──
	let turns = 0;
	let toolCalls = 0;
	const usage = emptyUsageAccumulator();
	let stopReason: StopReason | undefined;
	let errorMessage: string | undefined;

	const unsub = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "turn_start":
				turns += 1;
				return;
			case "tool_execution_start": {
				toolCalls += 1;
				opts.onProgress?.(
					`[reviewer] turn ${turns} · tool #${toolCalls}: ${event.toolName}`,
				);
				return;
			}
			case "message_end": {
				const msg = event.message as {
					role?: string;
					usage?: Usage;
					stopReason?: StopReason;
					errorMessage?: string;
				};
				if (msg?.role === "assistant") {
					accumulateUsage(usage, msg.usage);
					if (msg.stopReason) stopReason = msg.stopReason;
					if (msg.errorMessage) errorMessage = msg.errorMessage;
				}
				return;
			}
			default:
				return;
		}
	});

	// Total timeout + parent-signal linkage.
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		REVIEWER_TOTAL_TIMEOUT_MS,
	);
	const onParentAbort = () => controller.abort();
	if (opts.parentSignal) {
		if (opts.parentSignal.aborted) controller.abort();
		else opts.parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}
	const onChildAbort = () => {
		// session.abort() returns a promise; attach a catch guard so a
		// double-abort (timeout/parent-signal here + finally below) cannot
		// surface as an unhandledRejection. The awaited prompt()/waitForIdle()
		// settle because of the abort regardless.
		session.abort().catch(() => {
			// best-effort; a second abort on a draining session is expected.
		});
	};
	controller.signal.addEventListener("abort", onChildAbort, { once: true });

	const timedOut = () =>
		controller.signal.aborted && !opts.parentSignal?.aborted;

	let aborted = false;
	// Capture final outputs BEFORE dispose. The finally block below disposes
	// the child session; reading getLastAssistantText()/getActiveToolNames() on
	// a disposed session may throw or return stale state, so we snapshot them
	// while the session is still alive (guarded for the abort/error path too).
	let finalText = "";
	let finalActiveTools: string[] = [];
	try {
		// Initialize extension tools (MCP/Web connections etc.) best-effort.
		try {
			await session.bindExtensions({
				mode: "json",
				onError: (err) => {
					console.error(`[${labelSlug}] child extension error:`, err);
				},
			});
		} catch (bindErr) {
			// bindExtensions failure (e.g. an extension assuming UI) must not abort
			// the review; builtin tools still work and external tools surface
			// normal tool errors if selected.
			console.error(`[${labelSlug}] bindExtensions failed:`, bindErr);
		}

		await session.prompt(task);
		await session.waitForIdle();

		// Snapshot outputs while the session is alive (post-idle, pre-dispose).
		try {
			finalText = session.getLastAssistantText()?.trim() ?? "";
		} catch {
			finalText = "";
		}
		try {
			finalActiveTools = session.getActiveToolNames();
		} catch {
			finalActiveTools = [];
		}
	} catch (err) {
		if (
			controller.signal.aborted ||
			(err instanceof Error && err.name === "AbortError")
		) {
			aborted = true;
		} else {
			throw err;
		}
	} finally {
		clearTimeout(timer);
		controller.signal.removeEventListener("abort", onChildAbort);
		if (opts.parentSignal) {
			opts.parentSignal.removeEventListener("abort", onParentAbort);
		}
		unsub();
		try {
			await session.abort();
		} catch {
			// best-effort drain.
		}
		session.dispose();
	}

	const activeTools = finalActiveTools;
	const activeSet = new Set(activeTools);
	const unavailableTools = requestedTools.filter((n) => !activeSet.has(n));

	const text = finalText;

	const elapsedMs = Date.now() - startedAt;

	if (aborted) {
		const reason = timedOut()
			? `${progressLabel} timed out after ${REVIEWER_TOTAL_TIMEOUT_MS}ms`
			: `${progressLabel} aborted`;
		throw new Error(
			`${reason} (model: ${reviewerLabel}, turns: ${turns}, tools: ${toolCalls}).`,
		);
	}

	if (!text) {
		throw new Error(
			`${progressLabel} produced no final text (model: ${reviewerLabel}, stopReason: ${stopReason ?? "unknown"}${errorMessage ? `, error: ${errorMessage}` : ""}).`,
		);
	}

	return {
		text,
		reviewerModel: reviewerLabel,
		thinking: modelSpec.thinking,
		usage,
		stopReason,
		errorMessage,
		elapsedMs,
		turns,
		toolCalls,
		requestedTools,
		activeTools,
		unavailableTools,
	};
}

/**
 * Run the Plan Review reviewer. Assembles the authoritative plan-review task
 * (requirements + confirmed decisions + candidate plan) and delegates to the
 * shared independent reviewer runner running in the parent session cwd.
 *
 * Always disposes the child session. Timeout or parent cancellation aborts the
 * active AgentSession before throwing an explicit error.
 */
export async function runPlanReviewAgent(
	opts: RunPlanReviewAgentOptions,
): Promise<PlanReviewAgentResult> {
	const { ctx, modelSpec, planMarkdown, decisions, branch, planStartEntryId } =
		opts;

	// ── Authoritative task ──
	const requirements = extractUserRequirements(branch, planStartEntryId);
	const task = buildReviewerTask({ requirements, decisions, planMarkdown });

	return runIndependentReviewer({
		ctx,
		pi: opts.pi,
		modelSpec,
		task,
		systemPrompt: REVIEWER_SYSTEM_PROMPT,
		reviewCwd: ctx.cwd,
		safetyRoots: { primaryCwd: ctx.cwd, reviewCwd: ctx.cwd },
		parentSignal: opts.parentSignal,
		onProgress: opts.onProgress,
		progressLabel: "Plan review",
	});
}
