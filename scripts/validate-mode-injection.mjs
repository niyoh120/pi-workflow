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
 * Run: node scripts/validate-mode-injection.mjs
 */

import fs from "node:fs";
import path from "node:path";
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
	prompts.includes("当前 system prompt 中的 Mode Prompt 定义当前模式"),
	"COMMON_PROMPT declares system Mode Prompt as authority",
);
assert(
	!prompts.includes("扩展注入的最新 workflow-mode 上下文定义当前模式"),
	"COMMON_PROMPT no longer references workflow-mode custom context",
);
assert(
	/WORK_PROMPT[\s\S]*?handoff 已包含 Final Plan/.test(prompts),
	"WORK_PROMPT states handoff already contains Final Plan",
);
assert(
	/WORK_PROMPT[\s\S]*?handoff marker 与 approval journal 自动恢复计划/.test(prompts),
	"WORK_PROMPT relies on handoff marker/journal for recovery (no plan_read call path)",
);
assert(
	/WORK_PROMPT[\s\S]*?workflow_todo\(action="list"\) 读取状态/.test(prompts),
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
assert(
	/const WORK_WORKFLOW_TOOL_NAMES = \["workflow_todo"\];/.test(mode),
	"mode.ts: Work base tool set is todo only (plan_read removed from Work)",
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

	// /work, /review, /commit kickoffs do not append the worktree notice.
	const workCmdStart = commands.indexOf("export function registerWorkCommand");
	assert(workCmdStart !== -1, "registerWorkCommand found in commands.ts");
	const workCmdEnd = commands.indexOf("export function registerReviewCommand", workCmdStart);
	const workCmdBlock = commands.slice(workCmdStart, workCmdEnd > 0 ? workCmdEnd : commands.length);
	assert(
		!/worktreeRuntimeNotice/.test(workCmdBlock),
		"/work kickoff does not append worktree notice",
	);
	const reviewStart = commands.indexOf("async function startReviewLoop");
	assert(reviewStart !== -1, "startReviewLoop found in commands.ts");
	const reviewEnd = commands.indexOf("async function rpcReadNonEmptyRef", reviewStart);
	const reviewBlock = commands.slice(reviewStart, reviewEnd > 0 ? reviewEnd : commands.length);
	assert(
		!/worktreeRuntimeNotice/.test(reviewBlock),
		"/review (startReviewLoop) does not append worktree notice",
	);
	const commitStart = commands.indexOf("export function registerCommitCommand");
	assert(commitStart !== -1, "registerCommitCommand found in commands.ts");
	const commitEnd = commands.indexOf("export function registerWfStatusCommand", commitStart);
	const commitBlock = commands.slice(commitStart, commitEnd > 0 ? commitEnd : commands.length);
	assert(
		!/worktreeRuntimeNotice/.test(commitBlock),
		"/commit kickoff does not append worktree notice",
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
		!!warnMatch && /标记为 blocked/.test(warnMatch[1]) && /\/plan/.test(warnMatch[1]),
		"recovery warning tells the model to block the todo and run /plan",
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

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);
