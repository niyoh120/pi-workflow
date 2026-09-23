#!/usr/bin/env node
/**
 * Regression validation: workflow mode prompt injection (post-refactor).
 *
 * Validates the stable-system-prompt + agent_settled dispatcher architecture:
 * - Mode prompt lives in before_agent_start system prompt (stable, no dynamic state).
 * - context hook only does marker isolation / cleanup / fail-open.
 * - Plan approval writes journal + pending; agent_settled starts new Work run.
 * - No per-request tail injection of mode or handoff.
 * - Workflow tools have no promptSnippet/promptGuidelines.
 *
 * Per-turn mode reminder architecture (added later):
 * - before_agent_start returns one short hidden custom message
 *   (WORKFLOW_MODE_REMINDER_CUSTOM_TYPE) per user turn; tool-loop
 *   continuations reuse it, so the message stream stays append-only.
 * - context hook never creates reminders; it only strips them from the
 *   provider projection once workflow is disabled.
 * - Guard rejections carry the effective mode + scope hint for re-anchoring.
 * - Real-handler groups below exercise reminders, projections, and the real
 *   Anthropic adapter payload (stubbed fetch, zero network) for the
 *   append-only prefix + cache-breakpoint claim.
 *
 * Run: node scripts/validate-mode-injection.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const root = process.cwd();

let runs = 0;
let failures = 0;

function read(rel) {
	return fs.readFileSync(path.join(root, rel), "utf8");
}

function assert(condition, msg) {
	runs++;
	if (condition) {
		console.log(`  PASS: ${msg}`);
		return;
	}
	failures++;
	console.error(`  FAIL: ${msg}`);
}

const helpers = read("extensions/workflow/helpers.ts");
const commands = read("extensions/workflow/commands.ts");
const tools = read("extensions/workflow/tools.ts");
const prompts = read("extensions/workflow/prompts.ts");
const mode = read("extensions/workflow/mode.ts");
const index = read("extensions/workflow/index.ts");
const state = read("extensions/workflow/state.ts");
const workContext = read("extensions/workflow/work-context.ts");
const types = read("extensions/workflow/types.ts");

console.log("Mode injection regression validation (stable system prompt architecture)");

// ── Runtime loader + fixture helpers (real handlers, real modules) ────────

const workflowTmpDirs = [];

/** Copy extensions/workflow into a temp dir with every relative `.js`
 *  import specifier rewritten to the real `.ts` file, then import `entry`.
 *  Loads the REAL module closure under Node type stripping while bare
 *  specifiers resolve against node_modules. */
async function loadWorkflowModule(entry) {
	const tmp = fs.mkdtempSync(path.join(root, ".mode-injection-mod-"));
	workflowTmpDirs.push(tmp);
	const dest = path.join(tmp, "workflow");
	fs.cpSync(path.join(root, "extensions", "workflow"), dest, { recursive: true });
	for (const file of fs.readdirSync(dest).filter((f) => f.endsWith(".ts"))) {
		const p = path.join(dest, file);
		const text = fs.readFileSync(p, "utf8");
		fs.writeFileSync(p, text.replace(/"(\.\/[^"\n]+)\.js"/g, '"./$1.ts"'));
	}
	return import(pathToFileURL(path.join(dest, entry)).href + "?t=" + Date.now());
}

process.on("exit", () => {
	for (const d of fs.readdirSync(root).filter((f) => f.startsWith(".mode-injection-"))) {
		try {
			fs.rmSync(path.join(root, d), { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

/** Minimal ExtensionAPI capture: records handlers, satisfies the surface
 *  touched by registerBeforeAgentStart / registerWorkflowContextInjection /
 *  registerToolCallGuard with workflow-inactive defaults. */
function makeFakePi() {
	const handlers = new Map();
	const pi = {
		handlers,
		on(name, handler) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
		},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: (names) => {
			pi.activeTools = names;
		},
		getAllTools: () => [],
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		setModel: async () => true,
		activeTools: [],
	};
	return pi;
}

/** Minimal ExtensionContext: fresh temp cwd so session state and config
 *  resolve against empty dirs (workflow defaults). */
function makeFakeCtx(cwd) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => "validate-session",
			getSessionFile: () => path.join(cwd, ".validate-session.jsonl"),
		},
		model: { provider: "test-provider", id: "test-model", contextWindow: 128000 },
		modelRegistry: { find: () => undefined },
		isProjectTrusted: () => false,
		ui: { notify: () => {}, setStatus: () => {} },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
}

function makeTmpProject(prefix) {
	const tmp = fs.mkdtempSync(path.join(root, prefix));
	workflowTmpDirs.push(tmp);
	const cwd = path.join(tmp, "project");
	const agentDir = path.join(tmp, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	return { tmp, cwd, agentDir };
}

// ── helpers.ts: stable mode body ───────────────────────────────────────────
assert(
	helpers.includes("export function buildModeMessageBody"),
	"helpers exports buildModeMessageBody",
);
assert(
	!helpers.includes("currentStatusText(state)"),
	"buildModeMessageBody does NOT include dynamic currentStatusText",
);
assert(
	!helpers.includes('"# Current Workflow State"'),
	"helpers no longer embeds Current Workflow State in mode body",
);
assert(
	helpers.includes("WORK_APPROVAL_CUSTOM_TYPE"),
	"helpers exports WORK_APPROVAL_CUSTOM_TYPE for approval journal",
);
assert(
	helpers.includes("export interface WorkApprovalData"),
	"helpers exports WorkApprovalData interface",
);
assert(
	!helpers.includes("APPROVED_PLAN_PRIORITY"),
	"helpers no longer exports APPROVED_PLAN_PRIORITY (lives in WORK_PROMPT only)",
);
assert(
	!helpers.includes("todoText(state)"),
	"buildWorkHandoffBody does NOT include todo snapshot",
);

// ── prompts.ts: system Mode Prompt authority ───────────────────────────────
assert(
	prompts.includes("The Mode Prompt in the current system prompt is the authority for the current mode"),
	"COMMON_PROMPT declares system Mode Prompt as authority",
);
assert(
	!prompts.includes("扩展注入的最新 workflow-mode 上下文定义当前模式"),
	"COMMON_PROMPT no longer references workflow-mode custom context",
);
assert(
	/WORK_PROMPT[\s\S]*?handoff already contains the Final Plan/.test(prompts),
	"WORK_PROMPT states handoff already contains Final Plan",
);
assert(
	/WORK_PROMPT[\s\S]*?recovery warning[\s\S]*?mark the current todo blocked/.test(prompts),
	"WORK_PROMPT relies on recovery warning → block todo → /workflow:plan (no plan_read call path)",
);
assert(
	/WORK_PROMPT[\s\S]*?workflow_todo\(action="list"\) first/.test(prompts),
	"WORK_PROMPT requires todo read when context lacks recent result",
);

// ── commands.ts: before_agent_start builds system prompt ───────────────────
assert(
	/buildModeMessageBody\(state\.mode, state, resolveTodoToolName\(pi\)\)/.test(commands),
	"before_agent_start calls buildModeMessageBody for system prompt",
);
assert(
	/COMMON_PROMPT.*modeBody|modeBody.*COMMON_PROMPT/.test(commands),
	"before_agent_start combines COMMON_PROMPT and modeBody into system prompt",
);

// ── commands.ts: context handler does NOT tail-inject ──────────────────────
assert(
	!commands.includes('customType: "workflow-mode"'),
	"context handler does NOT create workflow-mode custom messages",
);
assert(
	!/filteredMessages\.push/.test(commands),
	"context handler does NOT push to filteredMessages tail",
);
assert(
	/isolateWorkContext/.test(commands),
	"context handler uses isolateWorkContext from work-context.ts",
);

// ── commands.ts: agent_settled dispatcher ──────────────────────────────────
assert(
	/registerPendingWorkDispatcher/.test(commands),
	"commands.ts exports registerPendingWorkDispatcher",
);
assert(
	/pi\.on\("agent_settled"/.test(commands),
	"dispatcher subscribes to agent_settled event",
);
assert(
	/runPendingWorkDispatcher/.test(commands),
	"commands.ts exports runPendingWorkDispatcher for session_start resume",
);
assert(
	/acquireDispatcherLock/.test(commands),
	"dispatcher uses cross-process advisory lock",
);
assert(
	/computeDispatcherDecision/.test(commands),
	"dispatcher uses computeDispatcherDecision from work-context.ts",
);
assert(
	/executeDispatcherDecision/.test(commands),
	"dispatcher uses executeDispatcherDecision from work-context.ts",
);

// ── index.ts: registration order ───────────────────────────────────────────
assert(
	index.includes("registerPendingWorkDispatcher"),
	"index.ts registers pending work dispatcher",
);
assert(
	/runPendingWorkDispatcher\(pi, ctx, getAgentDir\)/.test(index),
	"index.ts calls resume dispatcher after runtime restore",
);

// ── state.ts: atomic save + advisory lock ──────────────────────────────────
assert(
	/renameSync\(tmpFile, spath\)/.test(state),
	"saveState uses atomic temp+rename",
);
assert(
	state.includes("acquireDispatcherLock"),
	"state.ts exports acquireDispatcherLock",
);
assert(
	state.includes("releaseDispatcherLock"),
	"state.ts exports releaseDispatcherLock",
);
assert(
	/isPidAlive/.test(state),
	"state.ts checks pid liveness for stale lock cleanup",
);
assert(
	/pendingWorkKickoff/.test(state),
	"state.ts normalizes pendingWorkKickoff field",
);

// ── types.ts: pending field ────────────────────────────────────────────────
assert(
	types.includes("pendingWorkKickoff?: string"),
	"WorkflowState has optional pendingWorkKickoff field",
);

// ── work-context.ts: pure logic module ─────────────────────────────────────
assert(
	workContext.includes("findApprovalJournalIndex"),
	"work-context exports findApprovalJournalIndex",
);
assert(
	workContext.includes("findCanonicalMarkerIndex"),
	"work-context exports findCanonicalMarkerIndex",
);
assert(
	workContext.includes("computeDispatcherDecision"),
	"work-context exports computeDispatcherDecision",
);
assert(
	workContext.includes("executeDispatcherDecision"),
	"work-context exports executeDispatcherDecision",
);
assert(
	workContext.includes("isolateWorkContext"),
	"work-context exports isolateWorkContext",
);
assert(
	workContext.includes("validateToolPairing"),
	"work-context exports validateToolPairing",
);
assert(
	workContext.includes("dropLeadingOrphanToolResults"),
	"work-context exports dropLeadingOrphanToolResults",
);
assert(
	workContext.includes("DispatcherPorts"),
	"work-context defines DispatcherPorts interface",
);
assert(
	workContext.includes("data?: unknown"),
	"BranchEntry declares data field for CustomEntry payload",
);
assert(
	/e\.data as ApprovalJournalData/.test(workContext),
	"findApprovalJournalIndex reads approval journal from entry.data",
);
assert(
	/branch\[journalIdx\]\.data as ApprovalJournalData/.test(workContext),
	"resolveHandoff reads approval journal from entry.data",
);
assert(
	!/e\.details as ApprovalJournalData/.test(workContext),
	"work-context does NOT read approval journal from entry.details",
);
assert(
	!/branch\[journalIdx\]\.details as ApprovalJournalData/.test(workContext),
	"resolveHandoff does NOT read approval journal from entry.details",
);

// ── tools.ts: approval journal + pending + terminate ───────────────────────
assert(
	/pi\.appendEntry\(WORK_APPROVAL_CUSTOM_TYPE/.test(tools),
	"approval writes journal via pi.appendEntry",
);
assert(
	/journalEntry as any\)\.data as/.test(commands),
	"context handler reads journal handoffBody from entry.data",
);
assert(
	!/journalEntry as any\)\.details as/.test(commands),
	"context handler does NOT read journal handoffBody from entry.details",
);
assert(
	/pendingWorkKickoff: workRunId/.test(tools),
	"approval sets pendingWorkKickoff in nextState",
);
assert(
	/terminate: true/.test(tools),
	"approval returns terminate: true",
);
assert(
	!tools.includes('deliverAs: "followUp"'),
	"approval does NOT use followUp delivery",
);
assert(
	!tools.includes("WORK_HANDOFF_CUSTOM_TYPE"),
	"tools.ts does NOT directly write handoff marker (dispatcher does)",
);

// ── tools.ts: no promptSnippet/promptGuidelines ────────────────────────────
assert(
	!tools.includes("promptSnippet"),
	"tools.ts has no promptSnippet",
);
assert(
	!tools.includes("promptGuidelines"),
	"tools.ts has no promptGuidelines",
);

// ── tools.ts: descriptions strengthened ────────────────────────────────────
assert(
	/Plan Mode only/.test(tools),
	"tool descriptions include Plan Mode constraint",
);
assert(
	/Work Mode only/.test(tools),
	"tool descriptions include Work Mode constraint",
);
assert(
	/Init Mode only/.test(tools),
	"tool descriptions include Init Mode constraint",
);

// ── mode.ts: tool ownership invariants ─────────────────────────────────────
assert(
	mode.includes("EXPLORE_WORKFLOW_TOOL_NAMES"),
	"mode.ts declares EXPLORE_WORKFLOW_TOOL_NAMES (now empty)",
);
assert(
	/const EXPLORE_WORKFLOW_TOOL_NAMES: string\[\] = \[\];/.test(mode),
	"mode.ts: Explore workflow tool set is empty (plan_read removed from Explore)",
);
// WORK_WORKFLOW_TOOL_NAMES base set is todo-only; the unified review tool
// (workflow_review) is conditionally pushed in computeWorkflowToolNames on
// review.enabled. Scope the regex to the array literal so it cannot match the
// push site.
const workBaseMatch = mode.match(/const WORK_WORKFLOW_TOOL_NAMES = (\[[\s\S]*?\]);/);
assert(workBaseMatch !== null, "mode.ts: WORK_WORKFLOW_TOOL_NAMES array found");
assert(
	workBaseMatch !== null &&
		/"workflow_todo"/.test(workBaseMatch[1]) &&
		!/workflow_review/.test(workBaseMatch[1]),
	"mode.ts: WORK_WORKFLOW_TOOL_NAMES base set is todo-only (unified review is conditional)",
);
assert(
	/config\.review\.enabled[\s\S]*?names\.push\("workflow_review"\)/.test(mode),
	"mode.ts: computeWorkflowToolNames conditionally adds unified review on review.enabled",
);
assert(
	mode.includes('"workflow_review"'),
	"mode.ts: WORKFLOW_GATED_TOOLS includes workflow_review",
);
// Unified review is gated by review.enabled; codeReview.enabled does NOT change
// the Work tool set (it only toggles the delegated code review spec inside the
// review).
const workComputeBlock = mode.slice(
	mode.indexOf("case \"work\": {"),
	mode.indexOf("case \"explore\":", mode.indexOf("case \"work\": {")),
);
assert(
	workComputeBlock.includes("WORK_WORKFLOW_TOOL_NAMES") &&
		workComputeBlock.includes("workflow_review") &&
		!/codeReview\.enabled/.test(workComputeBlock),
	"mode.ts: computeWorkflowToolNames work branch spreads WORK base set then conditionally adds unified review (codeReview.enabled does not change the tool set)",
);
assert(
	/sameMembers/.test(mode),
	"mode.ts short-circuits setActiveTools when unchanged",
);

// ── config.ts: unified trust-aware config path ───────────────────────────
const config = read("extensions/workflow/config.ts");
assert(
	config.includes("export function loadConfigForContext"),
	"config.ts exports the unified ctx-aware loadConfigForContext",
);
assert(
	!config.includes("export function loadConfigForSession"),
	"config.ts no longer exports legacy loadConfigForSession",
);
assert(
	!config.includes("export function loadConfigIfTrusted"),
	"config.ts no longer exports legacy loadConfigIfTrusted",
);
assert(
	!config.includes("export function loadConfig(") &&
		!config.includes("export { loadConfig") &&
		!config.includes("export const loadConfig") &&
		!config.includes("export default function loadConfig"),
	"config.ts no longer exports legacy loadConfig (internal only)",
);
// Business modules must not import the removed legacy loaders.
for (const file of [
	"extensions/workflow/mode.ts",
	"extensions/workflow/commands.ts",
	"extensions/workflow/tools.ts",
	"extensions/workflow/settings.ts",
	"extensions/workflow/index.ts",
]) {
	const src = read(file);
	assert(
		!/import\s*\{[^}]*\bloadConfigForSession\b[^}]*\}\s*from/.test(src) &&
			!/import\s*\{[^}]*\bloadConfigIfTrusted\b[^}]*\}\s*from/.test(src),
		`${file} has no legacy loadConfigForSession/loadConfigIfTrusted imports`,
	);
}

// ── runtime entry shape: appendCustomEntry stores payload in .data ───────
// Regression for the bug where approval journal was read from .details.
// SessionManager.inMemory() bypasses disk so this runs in any environment.
{
	const sm = SessionManager.inMemory("/tmp/pi-workflow-validate-injection");
	const payload = { workRunId: "run-1", handoffBody: "handoff" };
	const id = sm.appendCustomEntry("workflow-work-approval", payload);
	const entry = sm.getEntry(id);
	assert(entry && entry.type === "custom", "appendCustomEntry creates a custom entry");
	assert(
		entry && "data" in entry && (entry).data === payload,
		"appendCustomEntry stores payload as CustomEntry.data",
	);
	assert(
		entry && !("details" in entry),
		"appendCustomEntry does NOT store payload as details",
	);
	const branch = sm.getBranch();
	assert(
		Array.isArray(branch) && branch.some(
			(e) => e.type === "custom" && (e).data === payload,
		),
		"getBranch exposes the approval journal with .data payload",
	);
}

// ── T3: worktree notice dedup + recovery warning + plan_read scoping ──────
console.log("\n=== T3: worktree notice dedup + recovery warning ===");
{
	// buildWorkHandoffBody no longer embeds the worktree notice.
	const handoffStart = helpers.indexOf("export function buildWorkHandoffBody");
	const handoffEnd = helpers.indexOf("/**", handoffStart + 1);
	const handoffBlock = helpers.slice(handoffStart, handoffEnd > 0 ? handoffEnd : helpers.length);
	assert(
		!/worktreeRuntimeNotice\(state\)/.test(handoffBlock),
		"buildWorkHandoffBody does NOT call worktreeRuntimeNotice (notice lives in system prompt)",
	);
	assert(
		/worktreeRuntimeNotice/.test(helpers) && /buildModeMessageBody/.test(helpers),
		"helpers.ts still exports worktreeRuntimeNotice for buildModeMessageBody",
	);

	// /workflow:work, /workflow:review, /workflow:commit kickoffs do not append the worktree notice.
	const workCmdStart = commands.indexOf("export function registerWorkflowWorkCommand");
	assert(workCmdStart !== -1, "registerWorkflowWorkCommand found in commands.ts");
	const workCmdEnd = commands.indexOf("export function registerWorkflowReviewCommand", workCmdStart);
	const workCmdBlock = commands.slice(workCmdStart, workCmdEnd > 0 ? workCmdEnd : commands.length);
	assert(
		!/worktreeRuntimeNotice/.test(workCmdBlock),
		"/workflow:work kickoff does not append worktree notice",
	);
	const reviewStart = commands.indexOf("async function startReviewLoop");
	assert(reviewStart !== -1, "startReviewLoop found in commands.ts");
	const reviewEnd = commands.indexOf("async function rpcReadNonEmptyRef", reviewStart);
	const reviewBlock = commands.slice(reviewStart, reviewEnd > 0 ? reviewEnd : commands.length);
	assert(
		!/worktreeRuntimeNotice/.test(reviewBlock),
		"/workflow:review (startReviewLoop) does not append worktree notice",
	);
	const commitStart = commands.indexOf("export function registerWorkflowCommitCommand");
	assert(commitStart !== -1, "registerWorkflowCommitCommand found in commands.ts");
	const commitEnd = commands.indexOf("export function registerWorkflowMergeCommand", commitStart);
	assert(commitEnd > commitStart, "registerWorkflowMergeCommand follows registerWorkflowCommitCommand");
	const commitBlock = commands.slice(commitStart, commitEnd);
	assert(
		!/worktreeRuntimeNotice/.test(commitBlock),
		"/workflow:commit kickoff does not append worktree notice",
	);
	// /workflow:merge kickoff does not append the worktree notice either (it lives in
	// the stable system prompt + per-round hidden merge context).
	const wfMergeStart = commands.indexOf("export function registerWorkflowMergeCommand");
	assert(wfMergeStart >= 0, "registerWorkflowMergeCommand found in commands.ts");
	const wfMergeEnd = commands.indexOf("export function registerWorkflowStatusCommand", wfMergeStart);
	const wfMergeBlock = commands.slice(wfMergeStart, wfMergeEnd > 0 ? wfMergeEnd : commands.length);
	assert(
		!/worktreeRuntimeNotice/.test(wfMergeBlock),
		"/workflow:merge kickoff does not append worktree notice",
	);
	assert(
		wfMergeBlock.includes("buildMergeContextBody") && wfMergeBlock.includes("MERGE_CONTEXT_MARKER"),
		"/workflow:merge active-merge re-entry re-sends the canonical merge context",
	);
	// commands.ts no longer references worktreeRuntimeNotice anywhere.
	assert(
		!/\bworktreeRuntimeNotice\b/.test(commands),
		"commands.ts no longer references worktreeRuntimeNotice",
	);

	// Recovery warning injected on full fail-open.
	assert(
		/recoveryWarning/.test(commands) && /Recovery Warning/.test(commands),
		"context handler injects a recovery warning on full fail-open",
	);
	assert(
		/role: "user" as const,\s*content: recoveryWarning,\s*display: false/.test(commands),
		"recovery warning is a hidden user message",
	);
	// Verify the recoveryWarning string itself contains both instructions,
	// scoped to the literal so the loose cross-section match can't false-pass.
	const warnMatch = commands.match(/const recoveryWarning =\s*([\s\S]*?);\s*\n/);
	assert(
		!!warnMatch && /mark the current workflow_todo as blocked/.test(warnMatch[1]) && /\/workflow:plan/.test(warnMatch[1]),
		"recovery warning tells the model to block the todo and run /workflow:plan",
	);

	// workflow_plan_read is only in the Plan tool set, not Work/Explore.
	assert(
		/PLAN_WORKFLOW_TOOL_NAMES[\s\S]*?"workflow_plan_read"/.test(mode),
		"mode.ts: PLAN_WORKFLOW_TOOL_NAMES includes workflow_plan_read",
	);
	const workSetMatch = mode.match(/const WORK_WORKFLOW_TOOL_NAMES = (\[[^\]]*\]);/);
	assert(
		workSetMatch && !/workflow_plan_read/.test(workSetMatch[1]),
		"mode.ts: WORK_WORKFLOW_TOOL_NAMES excludes workflow_plan_read",
	);
	const exploreSetMatch = mode.match(/const EXPLORE_WORKFLOW_TOOL_NAMES[^;]*;/);
	assert(
		exploreSetMatch && !/workflow_plan_read/.test(exploreSetMatch[0]),
		"mode.ts: EXPLORE_WORKFLOW_TOOL_NAMES excludes workflow_plan_read",
	);
	// Tool pairing validation is still used by the context handler.
	assert(
		/validateToolPairing/.test(commands),
		"context handler still validates tool pairing",
	);
}

// ── T1: workflow data read guard is mode-independent ───────────────────────
console.log("\n=== T1: workflow data read guard (all modes) ===");
{
	// The direct-read guard for .pi/workflow/ lives above the readonly/commit
	// branches so Work and Commit cannot bypass it either.
	const tcgStart = commands.indexOf("registerToolCallGuard");
	const tcgEnd = commands.indexOf("registerAgentEnd", tcgStart);
	const tcgBlock = commands.slice(tcgStart, tcgEnd);
	// Generic read guard precedes the readonly branch.
	const readGuardIdx = tcgBlock.indexOf("Workflow data protection: block direct read to .pi/workflow/");
	const readonlyIdx = tcgBlock.indexOf("Read-only modes: block local file mutations");
	assert(readGuardIdx !== -1, "tool_call guard: has mode-independent workflow data read guard");
	assert(readonlyIdx !== -1 && readGuardIdx < readonlyIdx, "tool_call guard: read guard runs before readonly branch (covers Work/Commit)");
	assert(/if \(event.toolName === "read"\)[\s\S]*?isWorkflowDataPath\(filePath, ctx.cwd\)/.test(tcgBlock), "tool_call guard: read path checks isWorkflowDataPath");
	// The old read guard inside the readonly branch is gone (no duplicate).
	const readonlyBlock = tcgBlock.slice(readonlyIdx, tcgBlock.length);
	assert(!/event.toolName === "read"[\s\S]{0,80}?isWorkflowDataPath/.test(readonlyBlock), "tool_call guard: readonly branch no longer re-checks read workflow data");
	// Workflow plan tools still reach the plan file via state.ts (workflow_plan_read/save).
	assert(tools.includes("workflow_plan_read"), "tools.ts registers workflow_plan_read (plan access path retained)");
	assert(/requirePlanMarkdown\(ctx.cwd, state.planPath\)/.test(tools), "tools.ts: approve reaches plan via requirePlanMarkdown");
}

// ── T4: restore vs apply mode runtime split ───────────────────────────────
console.log("\n=== T4: restore vs apply mode runtime split ===");
{
	// mode.ts exports restoreModeRuntime and keeps applyModeRuntime as the
	// forced role-switch entry. Both must exist as distinct exports.
	assert(
		/export\s+async\s+function\s+restoreModeRuntime\s*\(/.test(mode),
		"mode.ts exports restoreModeRuntime (restore path)",
	);
	assert(
		/export\s+async\s+function\s+applyModeRuntime\s*\(/.test(mode),
		"mode.ts still exports applyModeRuntime (forced role path)",
	);

	// restoreModeRuntime only calls setRole when ctx.model is absent; it never
	// forces a role switch on every call.
	const restoreStart = mode.indexOf("export async function restoreModeRuntime");
	assert(restoreStart >= 0, "T4: mode.ts marker 'restoreModeRuntime' found");
	const restoreEnd = mode.indexOf("\nexport ", restoreStart + 1);
	const restoreBlock = mode.slice(
		restoreStart,
		restoreEnd > 0 ? restoreEnd : mode.length,
	);
	assert(
		/if\s*\(\s*!ctx\?\.model\s*\)[\s\S]*?await\s+setRole\(/.test(restoreBlock),
		"restoreModeRuntime gates setRole on !ctx?.model (only falls back when no active model)",
	);
	// activateWorkflowToolsIfAllowed must run unconditionally after the
	// !ctx?.model branch closes, not nested inside it, so tool reconcile still
	// happens when the fallback setRole fails (no-model + role-unavailable).
	// Comments may sit between the closing brace and the call, so allow them.
	// Built via new RegExp so the comment-marker `//` does not terminate the
	// regex literal.
	// NOTE: the non-greedy \{[\s\S]*?\} stops at the first `}` and cannot count
	// brace depth. This works because restoreModeRuntime's !ctx?.model block
	// currently has no nested braces. If a nested block is ever added inside that
	// branch, switch to a brace-depth-aware extractor to avoid false positives.
	const reconcileOutsideFallback = new RegExp(
		"if\\s*\\(\\s*!ctx\\?\\.model\\s*\\)\\s*\\{[\\s\\S]*?\\}\\s*(?://[^\\n]*\\n\\s*)*activateWorkflowToolsIfAllowed\\(",
	);
	assert(
		reconcileOutsideFallback.test(restoreBlock),
		"restoreModeRuntime reconciles workflow tools unconditionally (outside the !ctx?.model fallback)",
	);
	// applyModeRuntime unconditionally calls setRole(modeRole(mode)). Use a
	// token-sequence match (not exact whitespace) so cosmetic reformatting does
	// not break the assertion without a real behavioral regression.
	const applyStart = mode.indexOf("export async function applyModeRuntime");
	assert(applyStart >= 0, "T4: mode.ts marker 'applyModeRuntime' found");
	const applyEnd = mode.indexOf("\nexport ", applyStart + 1);
	const applyBlock = mode.slice(applyStart, applyEnd > 0 ? applyEnd : mode.length);
	assert(
		/modeRole\(mode\)[\s\S]*?setRole[\s\S]*?getAgentDir/.test(applyBlock),
		"applyModeRuntime always applies modeRole via setRole (forced role)",
	);

	// before_agent_start uses the restore path, not the forced role path.
	const basStart = commands.indexOf("export function registerBeforeAgentStart");
	assert(basStart >= 0, "T4: commands.ts marker 'registerBeforeAgentStart' found");
	const basEnd = commands.indexOf(
		"export function registerWorkflowContextInjection",
		basStart,
	);
	const basBlock = commands.slice(basStart, basEnd > 0 ? basEnd : commands.length);
	assert(
		/await\s+restoreModeRuntime\(pi,\s+ctx,\s*state\.mode,\s*getAgentDir\)/.test(
			basBlock,
		),
		"before_agent_start uses restoreModeRuntime (preserves manual selection)",
	);
	assert(
		!/await\s+setRole\(pi,\s+ctx,\s*modeRole\(state\.mode\)/.test(basBlock),
		"before_agent_start no longer calls setRole(modeRole(state.mode)) directly",
	);

	// Non-idle session_start uses the restore path; idle→explore still uses the
	// forced transition (transitionWorkflowMode → applyModeRuntime).
	assert(
		/await\s+restoreModeRuntime\([\s\S]*?state\.mode[\s\S]*?getAgentDir\)/.test(index),
		"index.ts session_start uses restoreModeRuntime for non-idle restore",
	);
	assert(
		/transitionWorkflowMode\(\s*[\s\S]*?nextState:\s*\{[\s\S]*?mode:\s*"explore"\s*\}/.test(
			index,
		),
		"index.ts idle→explore promotion still uses transitionWorkflowMode (forced role)",
	);
	assert(
		!/await\s+applyModeRuntime\(\s*pi,\s+ctx,\s*state\.mode/.test(index),
		"index.ts no longer calls applyModeRuntime(state.mode) directly",
	);

	// /workflow:enable applies Explore runtime before reload: setRole(explore) + status +
	// guard mode set, then reconcile, with a fallback warning on failure.
	const wfStart = commands.indexOf("export function registerWorkflowEnableCommand");
	assert(wfStart >= 0, "T4: commands.ts marker 'registerWorkflowEnableCommand' found");
	const wfEnd = commands.indexOf(
		"// ── Command registrations",
		wfStart,
	);
	const wfBlock = commands.slice(wfStart, wfEnd > 0 ? wfEnd : commands.length);
	assert(
		/setWorkflowStatus\(ctx,\s*"explore"\)/.test(wfBlock) &&
			/setCurrentTurnGuardMode\(sessionKey,\s*"explore"\)/.test(wfBlock),
		"/workflow:enable sets explore status and guard mode before reload",
	);
	assert(
		/setRole[\s\S]*?"explore"[\s\S]*?getAgentDir/.test(wfBlock),
		"/workflow:enable applies explore role via setRole before reload",
	);
	assert(
		/activateWorkflowToolsIfAllowed\(pi,\s+ctx\.cwd,\s*getAgentDir,\s*"explore",\s*ctx\)/.test(
			wfBlock,
		),
		"/workflow:enable reconciles workflow tools for explore before reload",
	);
	assert(
		/explore role runtime failed to apply/.test(wfBlock),
		"/workflow:enable logs a warning when explore runtime fails and continues with reload",
	);
	assert(
		/await\s+ctx\.reload\(\)/.test(wfBlock),
		"/workflow:enable still reloads after applying Explore runtime",
	);

	// /workflow:status shows both active runtime and configured role model/thinking.
	const wfStatusStart = commands.indexOf("export function registerWorkflowStatusCommand");
	assert(wfStatusStart >= 0, "T4: commands.ts marker 'registerWorkflowStatusCommand' found");
	const wfStatusEnd = commands.indexOf(
		"export function registerWorkflowDisableCommand",
		wfStatusStart,
	);
	const wfStatusBlock = commands.slice(
		wfStatusStart,
		wfStatusEnd > 0 ? wfStatusEnd : commands.length,
	);
	assert(
		/active runtime model:/.test(wfStatusBlock) &&
			/activeModel\s*\?\s*`\$\{activeModel\.provider\}\/\$\{activeModel\.id\}`\s*:\s*"\(none/.test(wfStatusBlock) &&
			/configured role model:/.test(wfStatusBlock),
		"/workflow:status displays active runtime model (ctx.model) with safe ternary access alongside configured role model",
	);
	assert(
		/active runtime thinking:/.test(wfStatusBlock) &&
			/pi\.getThinkingLevel\(\)/.test(wfStatusBlock) &&
			/configured role thinking:/.test(wfStatusBlock),
		"/workflow:status displays active runtime thinking (pi.getThinkingLevel) alongside configured role thinking",
	);
}

// ── T5: Merge Mode prompt + canonical context + merge-aware guards ────────
console.log("\n=== T5: merge mode prompt/context/guards ===");
{
	// MERGE_PROMPT exists and is dispatched for mode "merge".
	assert(
		/export const MERGE_PROMPT/.test(prompts),
		"prompts.ts: MERGE_PROMPT constant exists",
	);
	assert(
		/case "merge":\s*\n\s*prompt = MERGE_PROMPT;/.test(prompts),
		"prompts.ts: dispatch maps merge → MERGE_PROMPT",
	);
	assert(
		/finally|workflow_merge_complete\(status=\"cancelled\"\)|The default flow forbids/.test(prompts) &&
			/MERGE_PROMPT[\s\S]*?workflow_merge_complete/.test(prompts),
		"prompts.ts: MERGE_PROMPT routes completion/cancel through workflow_merge_complete",
	);
	// buildModeMessageBody picks up merge via promptForMode; the worktree notice
	// stays shared with Work (single source, no duplication in kickoffs — see T3).
	assert(
		/buildModeMessageBody[\s\S]*?worktreeRuntimeNotice/.test(helpers),
		"helpers.ts: buildModeMessageBody keeps the shared worktree notice",
	);

	// Context injection: rebuilds the hidden canonical merge context from state
	// every round and filters previous copies (single current message).
	assert(
		/MERGE_CONTEXT_MARKER/.test(commands) && /buildMergeContextBody\(state\)/.test(commands),
		"context handler rebuilds the merge context body from persisted state",
	);
	const step4Start = commands.indexOf("// Step 4: Merge Mode canonical context");
	assert(step4Start !== -1, "context handler has the merge context step");
	const step4Block = commands.slice(step4Start, commands.indexOf("return { messages };", step4Start));
	assert(
		step4Block.includes("display: false"),
		"merge context message is hidden (display: false)",
	);
	assert(
		/startsWith\(MERGE_CONTEXT_MARKER\)/.test(step4Block),
		"merge context filtering keys off the stable marker prefix",
	);
	assert(
		!/"role": "custom"|role: "custom" as const,\s*customType: MERGE_CONTEXT_MARKER/.test(step4Block),
		"merge context stays at user priority (not a system prompt merge)",
	);

	// Merge-aware worktree guard call-site: commands.ts write/edit guard selects
	// the merge-aware validator for mode==="merge", strict otherwise.
	const guardBlock = commands.slice(
		commands.indexOf("Worktree-bound Work/Merge Mode"),
		commands.indexOf("// Read-only modes"),
	);
	assert(
		/effectiveMode === "merge"[\s\S]{0,140}validateMergeWorktreeState\(ctx\.cwd, state\)/.test(guardBlock),
		"tool_call guard: merge mode write/edit uses the merge-aware validator",
	);
	assert(
		guardBlock.includes("validateWorktreeState(ctx.cwd, state)"),
		"tool_call guard: work mode write/edit keeps the strict validator",
	);

	// bash override resolver is merge-aware in tools.ts.
	assert(
		/state\.mode === "merge"[\s\S]{0,200}validateMergeWorktreeState\(cwd, state\)/.test(tools),
		"tools.ts: resolveEffectiveCwd selects merge-aware validation for Merge Mode",
	);

	// workflow_merge_complete terminates the turn after restoring the mode.
	const mcToolStart = tools.indexOf("export function registerMergeCompleteTool");
	const mcBulk = tools.indexOf("// ── Bulk registration", mcToolStart);
	const mcTool = tools.slice(mcToolStart, mcBulk > mcToolStart ? mcBulk : tools.length);
	assert(/terminate: true/.test(mcTool), "workflow_merge_complete returns terminate: true");
	assert(
		/mode: mc\.returnMode/.test(mcTool) && /mergeContext: undefined/.test(mcTool),
		"workflow_merge_complete clears mergeContext and restores returnMode",
	);
	assert(
		/mc\.defaultStrategy && params\.finalize !== "ff-only"/.test(mcTool),
		"workflow_merge_complete: defaultStrategy rejects finalize=already-integrated",
	);
}

// ── R0: per-turn mode reminder source wiring ─────────────────────────────
console.log("\n=== R0: mode reminder source wiring ===");
{
	assert(
		helpers.includes("export const WORKFLOW_MODE_REMINDER_CUSTOM_TYPE"),
		"helpers exports WORKFLOW_MODE_REMINDER_CUSTOM_TYPE",
	);
	assert(
		helpers.includes("export const MODE_REMINDER_MAX_BYTES"),
		"helpers exports MODE_REMINDER_MAX_BYTES byte cap",
	);
	assert(
		helpers.includes("export function buildModeReminderBody"),
		"helpers exports buildModeReminderBody pure builder",
	);
	assert(
		helpers.includes("export function isWorkflowModeReminderMessage"),
		"helpers exports isWorkflowModeReminderMessage predicate",
	);
	assert(
		helpers.includes("export function modeScopeHint"),
		"helpers exports modeScopeHint guard hint",
	);
	assert(
		/workflow-mode-reminder/.test(prompts),
		"COMMON_PROMPT documents the per-turn reminder semantics",
	);
	assert(
		commands.includes("WORKFLOW_MODE_REMINDER_CUSTOM_TYPE"),
		"commands.ts wires the reminder custom type",
	);
	const basR0Start = commands.indexOf("export function registerBeforeAgentStart");
	const basR0End = commands.indexOf(
		"export function registerWorkflowContextInjection",
		basR0Start,
	);
	const basR0Block = commands.slice(basR0Start, basR0End > 0 ? basR0End : commands.length);
	assert(
		basR0Block.includes("buildModeReminderBody(state.mode)") &&
			basR0Block.includes("customType: WORKFLOW_MODE_REMINDER_CUSTOM_TYPE") &&
			basR0Block.includes("display: false"),
		"before_agent_start returns the hidden per-turn reminder message",
	);
	const ctxR0Start = commands.indexOf("export function registerWorkflowContextInjection");
	const ctxR0End = commands.indexOf("// ── Pending Work kickoff dispatcher", ctxR0Start);
	const ctxR0Block = commands.slice(ctxR0Start, ctxR0End > 0 ? ctxR0End : commands.length);
	assert(
		!ctxR0Block.includes("buildModeReminderBody"),
		"context handler does NOT create reminders (persisted per user turn by before_agent_start)",
	);
	assert(
		/isWorkflowModeReminderMessage\(message\)/.test(ctxR0Block),
		"context handler strips stale reminders when workflow is inactive",
	);
	assert(
		commands.includes("modeScopeHint(effectiveMode)"),
		"guard rejections carry the mode scope hint",
	);
}

// ── R1: per-turn reminder lifecycle (real before_agent_start handler) ──────
console.log("\n=== R1: reminder lifecycle (real handlers) ===");
{
	const cmdMod = await loadWorkflowModule("commands.ts");
	const helpersMod = await loadWorkflowModule("helpers.ts");
	const stateMod = await loadWorkflowModule("state.ts");
	const defaultsMod = await loadWorkflowModule("defaults.ts");

	const { tmp, cwd, agentDir } = makeTmpProject(".mode-injection-run1-");
	const getAgentDir = () => agentDir;
	const pi = makeFakePi();
	cmdMod.registerBeforeAgentStart(pi, getAgentDir);
	cmdMod.registerWorkflowContextInjection(pi, getAgentDir);
	const basHandler = pi.handlers.get("before_agent_start")[0];
	assert(typeof basHandler === "function", "before_agent_start handler registered");

	const ctx = makeFakeCtx(cwd);
	const sessionKey = stateMod.getSessionKey(ctx);
	const setState = (patch) => {
		stateMod.saveState(cwd, sessionKey, {
			...defaultsMod.DEFAULT_STATE,
			...patch,
		});
	};

	setState({ workflowEnabled: true, mode: "explore" });
	let res = await basHandler({ systemPrompt: "BASE" }, ctx);
	assert(res && res.message, "explore turn returns a reminder message");
	assert(
		res.message.customType === helpersMod.WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
		"reminder carries the dedicated custom type",
	);
	assert(res.message.display === false, "reminder is hidden");
	assert(
		res.message.content === helpersMod.buildModeReminderBody("explore"),
		"explore reminder matches the pure builder",
	);
	assert(
		typeof res.systemPrompt === "string" &&
			res.systemPrompt.startsWith("BASE") &&
			res.systemPrompt.includes("Explore Mode"),
		"system prompt still carries the stable mode prompt",
	);

	const roundTrip = ["work", "explore", "plan", "explore"];
	for (const mode of roundTrip) {
		setState({ workflowEnabled: true, mode });
		res = await basHandler({ systemPrompt: "BASE" }, ctx);
		assert(
			res.message.content === helpersMod.buildModeReminderBody(mode),
			`round-trip reminder matches ${mode}`,
		);
	}
	assert(
		res.message.content === helpersMod.buildModeReminderBody("explore"),
		"final round-trip reminder reflects the CURRENT mode",
	);

	setState({ workflowEnabled: true, mode: "explore" });
	const r1a = await basHandler({ systemPrompt: "BASE" }, ctx);
	const r1b = await basHandler({ systemPrompt: "BASE" }, ctx);
	assert(
		r1a.message.content === r1b.message.content,
		"same-mode turns produce byte-identical reminders (deterministic)",
	);

	for (const mode of ["explore", "plan", "work", "init", "merge", "commit"]) {
		const body = helpersMod.buildModeReminderBody(mode);
		assert(
			Buffer.byteLength(body, "utf8") <= helpersMod.MODE_REMINDER_MAX_BYTES,
			`${mode} reminder within the byte cap`,
		);
	}

	setState({ workflowEnabled: true, mode: "idle" });
	res = await basHandler({ systemPrompt: "BASE" }, ctx);
	assert(
		res && res.message === undefined,
		"idle turn returns no reminder",
	);

	setState({ workflowEnabled: false, mode: "explore" });
	res = await basHandler({ systemPrompt: "BASE" }, ctx);
	assert(res === undefined, "inactive workflow emits no reminder");

	const sm = SessionManager.inMemory(path.join(tmp, "sm"));
	sm.appendCustomMessageEntry(
		helpersMod.WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
		helpersMod.buildModeReminderBody("work"),
		false,
		undefined,
	);
	const stored = sm
		.getBranch()
		.find(
			(e) =>
				e.type === "custom_message" &&
				e.customType === helpersMod.WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
		);
	assert(
		stored &&
			stored.content === helpersMod.buildModeReminderBody("work") &&
			stored.display === false,
		"reminder persists as a hidden custom_message entry",
	);

	const praMod = await loadWorkflowModule("plan-review-agent.ts");
	const branchFixture = [
		{
			type: "message",
			id: "e1",
			message: { role: "user", content: [{ type: "text", text: "实现登录功能" }] },
		},
		{
			type: "custom_message",
			id: "e2",
			customType: helpersMod.WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
			content: helpersMod.buildModeReminderBody("work"),
		},
	];
	const reqs = praMod.extractUserRequirements(branchFixture);
	assert(
		reqs.some((r) => r.includes("实现登录功能")),
		"extractUserRequirements keeps real user requirements",
	);
	assert(
		!reqs.some((r) => r.includes("workflow-mode-reminder")),
		"extractUserRequirements excludes reminder custom messages",
	);
}

// ── R2: context projections + provider payload (append-only prefix) ────────
console.log("\n=== R2: context projections + provider payload ===");
{
	const cmdMod = await loadWorkflowModule("commands.ts");
	const helpersMod = await loadWorkflowModule("helpers.ts");
	const stateMod = await loadWorkflowModule("state.ts");
	const defaultsMod = await loadWorkflowModule("defaults.ts");

	const { cwd, agentDir } = makeTmpProject(".mode-injection-run2-");
	const pi = makeFakePi();
	cmdMod.registerWorkflowContextInjection(pi, () => agentDir);
	const ctxHandler = pi.handlers.get("context")[0];
	const ctx = makeFakeCtx(cwd);
	const sessionKey = stateMod.getSessionKey(ctx);
	const setState = (patch) => {
		stateMod.saveState(cwd, sessionKey, {
			...defaultsMod.DEFAULT_STATE,
			...patch,
		});
	};

	const reminderWork = helpersMod.buildModeReminderBody("work");
	const reminderExplore = helpersMod.buildModeReminderBody("explore");

	// Approved Work fast path: current-turn + prior reminders survive isolation.
	setState({
		workflowEnabled: true,
		mode: "work",
		workRunId: "run-r2",
		planPath: path.join(cwd, "plan.md"),
	});
	const workMessages = [
		{ role: "user", content: "原始需求", timestamp: 1 },
		{
			role: "custom",
			customType: helpersMod.WORK_HANDOFF_CUSTOM_TYPE,
			content: "# Approved-Plan Work Handoff",
			display: false,
			details: { workRunId: "run-r2", boundary: true },
			timestamp: 2,
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }],
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 4,
		},
		{
			role: "custom",
			customType: helpersMod.WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
			content: reminderExplore,
			display: false,
			timestamp: 5,
		},
		{
			role: "custom",
			customType: helpersMod.WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
			content: reminderWork,
			display: false,
			timestamp: 7,
		},
		{ role: "user", content: "继续", timestamp: 8 },
	];
	const out = await ctxHandler({ messages: workMessages }, ctx);
	assert(Array.isArray(out.messages), "approved work projection returns messages");
	const projected = JSON.stringify(out.messages);
	assert(projected.includes("# Approved-Plan Work Handoff"), "handoff marker retained");
	assert(
		out.messages.some(
			(m) => helpersMod.isWorkflowModeReminderMessage(m) && m.content === reminderWork,
		),
		"current-turn work reminder retained through isolation",
	);
	assert(
		out.messages.some(
			(m) => helpersMod.isWorkflowModeReminderMessage(m) && m.content === reminderExplore,
		),
		"prior-turn reminder retained verbatim (append-only history)",
	);
	assert(
		!projected.includes("原始需求"),
		"pre-marker content stays isolated",
	);
	const callIdx = out.messages.findIndex((m) => m.role === "assistant");
	const resIdx = out.messages.findIndex((m) => m.role === "toolResult");
	assert(
		callIdx !== -1 && resIdx === callIdx + 1,
		"tool pairing intact after isolation",
	);

	// Merge mode: canonical context at head, reminders untouched.
	setState({
		workflowEnabled: true,
		mode: "merge",
		workRunId: undefined,
		planPath: undefined,
		mergeContext: {
			sourceBranch: "feat/x",
			targetBranch: "main",
			sourceKind: "ordinary-branch",
			sourceHeadBefore: "a".repeat(40),
			targetHeadBefore: "b".repeat(40),
			sourceOnlyCommitCountBefore: 2,
			defaultStrategy: true,
			instructions: "",
			returnMode: "explore",
		},
	});
	const mergeOut = await ctxHandler(
		{
			messages: [
				{ role: "user", content: "普通消息", timestamp: 1 },
				{
					role: "custom",
					customType: helpersMod.WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
					content: reminderExplore,
					display: false,
					timestamp: 2,
				},
			],
		},
		ctx,
	);
	assert(
		mergeOut.messages[0].role === "user" &&
			String(mergeOut.messages[0].content).startsWith(helpersMod.MERGE_CONTEXT_MARKER),
		"merge canonical context injected at head",
	);
	assert(
		mergeOut.messages.some((m) => helpersMod.isWorkflowModeReminderMessage(m)),
		"merge projection keeps reminders",
	);

	// Inactive: reminders stripped from the projection, real user text kept.
	setState({ workflowEnabled: false, mode: "explore" });
	const inactiveMessages = [
		{
			role: "user",
			content: "用户正文提到 workflow-mode-reminder 这个词",
			timestamp: 1,
		},
		{
			role: "custom",
			customType: helpersMod.WORKFLOW_MODE_REMINDER_CUSTOM_TYPE,
			content: reminderWork,
			display: false,
			timestamp: 2,
		},
	];
	const inactiveOut = await ctxHandler({ messages: inactiveMessages }, ctx);
	assert(
		!inactiveOut.messages.some((m) => helpersMod.isWorkflowModeReminderMessage(m)),
		"inactive projection strips workflow reminders",
	);
	assert(
		inactiveOut.messages.some(
			(m) =>
				m.role === "user" && String(m.content).includes("workflow-mode-reminder"),
		),
		"real user text mentioning the type string survives",
	);

	setState({ workflowEnabled: true, mode: "explore" });
	const activeOut = await ctxHandler({ messages: inactiveMessages }, ctx);
	assert(
		activeOut.messages.some((m) => helpersMod.isWorkflowModeReminderMessage(m)),
		"active projection keeps reminders again after re-enable",
	);

	// Real Anthropic adapter payload capture (stubbed fetch, zero network):
	// turn B extends turn A verbatim → append-only, cache-reusable prefix;
	// the cache_control breakpoint sits on the newest block.
	const { stream } = await import("@earendil-works/pi-ai/api/anthropic-messages");
	const captured = [];
	const sse = [
		"event: message_start",
		'data: {"type":"message_start","message":{"id":"msg_t","type":"message","role":"assistant","model":"claude-test","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
		"",
		"event: content_block_start",
		'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
		"",
		"event: content_block_delta",
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
		"",
		"event: content_block_stop",
		'data: {"type":"content_block_stop","index":0}',
		"",
		"event: message_delta",
		'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
		"",
		"event: message_stop",
		'data: {"type":"message_stop"}',
		"",
	].join("\n");
	const fakeFetch = async (url, init) => {
		let raw = "{}";
		if (typeof init?.body === "string") raw = init.body;
		else if (typeof init?.body?.text === "function") raw = await init.body.text();
		captured.push({ url: String(url), body: JSON.parse(raw) });
		return new Response(sse, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const model = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-test",
		name: "claude-test",
		contextWindow: 200000,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"],
	};
	const userMsg = { role: "user", content: [{ type: "text", text: "用户问题" }], timestamp: 1 };
	const reminderMsg = { role: "user", content: [{ type: "text", text: reminderWork }], timestamp: 2 };
	const ctxA = { systemPrompt: "BASE", messages: [userMsg, reminderMsg], tools: [] };
	const ctxB = {
		systemPrompt: "BASE",
		messages: [
			...ctxA.messages,
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 4,
			},
		],
		tools: [],
	};
	for (const c of [ctxA, ctxB]) {
		try {
			const events = stream(model, c, { apiKey: "test-key", fetch: fakeFetch, maxTokens: 64 });
			for await (const ev of events) {
				if (ev.type === "done" || ev.type === "error") break;
			}
		} catch {
			// payload already captured; stream errors must not fail the group
		}
	}
	assert(captured.length === 2, "two provider requests captured (zero network)");
	if (captured.length === 2) {
		const aMsgs = captured[0].body.messages;
		const bMsgs = captured[1].body.messages;
		// Compare with SDK-managed breakpoint metadata normalized away — the
		// cache_control position is asserted separately below.
		const stripBreakpoints = (msgs) =>
			JSON.stringify(msgs).replace(/,"cache_control":\{[^}]*\}/g, "");
		assert(
			stripBreakpoints(bMsgs.slice(0, aMsgs.length)) === stripBreakpoints(aMsgs),
			"turn B payload extends turn A verbatim (append-only, cache-reusable prefix)",
		);
		assert(
			JSON.stringify(bMsgs).includes(reminderWork),
			"reminder body reaches the provider payload as prefix text",
			);
		const lastTurnB = bMsgs[bMsgs.length - 1];
		const lastBlockB = Array.isArray(lastTurnB.content)
			? lastTurnB.content[lastTurnB.content.length - 1]
			: undefined;
		assert(
			lastBlockB && lastBlockB.cache_control,
			"cache_control breakpoint sits on the newest block",
		);
		const reminderBlockA = aMsgs[aMsgs.length - 1]?.content?.[0];
		const reminderBlockB = bMsgs[1]?.content?.[0];
		assert(
			reminderBlockA?.cache_control &&
				reminderBlockB &&
				!reminderBlockB.cache_control,
			"breakpoint moves forward off the reminder as the conversation grows",
		);
	}
}

// ── R3: guard rejections (mode re-anchor feedback) ───────────────────────
console.log("\n=== R3: guard rejections ===");
{
	const cmdMod = await loadWorkflowModule("commands.ts");
	const stateMod = await loadWorkflowModule("state.ts");
	const defaultsMod = await loadWorkflowModule("defaults.ts");

	const { cwd, agentDir } = makeTmpProject(".mode-injection-run3-");
	const pi = makeFakePi();
	cmdMod.registerToolCallGuard(pi, () => agentDir);
	const guard = pi.handlers.get("tool_call")[0];
	const ctx = makeFakeCtx(cwd);
	const sessionKey = stateMod.getSessionKey(ctx);
	const setState = (patch) => {
		stateMod.saveState(cwd, sessionKey, {
			...defaultsMod.DEFAULT_STATE,
			...patch,
		});
	};

	setState({ workflowEnabled: true, mode: "explore" });
	let r = await guard({ toolName: "workflow_plan_save", input: {} }, ctx);
	assert(r && r.block === true, "explore blocks workflow_plan_save");
	assert(
		r.reason.includes("Current mode (explore)") && r.reason.includes("workflow_plan_save"),
		"rejection names the effective mode and tool",
	);
	assert(
		r.reason.includes("Explore is read-only exploration"),
		"rejection carries the scope hint",
	);
	assert(
		r.reason.includes("/workflow:plan"),
		"rejection points to the switch commands",
	);

	setState({ workflowEnabled: true, mode: "plan" });
	r = await guard({ toolName: "workflow_review", input: {} }, ctx);
	assert(r && r.block === true, "plan blocks workflow_review (not in the plan tool surface)");
	assert(
		r.reason.includes("Current mode (plan) does not allow workflow_review") &&
			r.reason.includes("Call records from earlier turns do not carry over"),
		"mode-surface rejection explains stale history",
	);

	setState({ workflowEnabled: true, mode: "explore" });
	r = await guard(
		{ toolName: "write", input: { path: path.join(cwd, "src.ts"), content: "x" } },
		ctx,
	);
	assert(
		r &&
			r.block === true &&
			r.reason.includes("explore Mode") &&
			r.reason.includes("Explore is read-only exploration"),
		"readonly write rejection names mode + scope",
	);

	r = await guard(
		{
			toolName: "write",
			input: {
				path: path.join(os.tmpdir(), "pi-workflow-plan-scratch", "probe.js"),
				content: "x",
			},
		},
		ctx,
	);
	assert(r === undefined, "scratch write still allowed in explore");

	r = await guard({ toolName: "read", input: { path: path.join(cwd, "src.ts") } }, ctx);
	assert(r === undefined, "project read allowed in explore");

	r = await guard(
		{ toolName: "read", input: { path: path.join(cwd, ".pi", "workflow", "state.json") } },
		ctx,
	);
	assert(r && r.block === true, "workflow data read stays blocked in explore");

	setState({ workflowEnabled: true, mode: "work" });
	r = await guard({ toolName: "workflow_todo", input: { action: "list" } }, ctx);
	assert(r === undefined, "work keeps workflow_todo available");
}

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);
