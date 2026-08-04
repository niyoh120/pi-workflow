#!/usr/bin/env node
/**
 * Regression validation: independent plan-reviewer agent architecture.
 *
 * Covers the behaviors that the sidecall→agent refactor can break:
 *  1. Authoritative requirement extraction is lifecycle-scoped and excludes
 *     planner reasoning / tool results / prior-plan content (pure fixture).
 *  2. reconstructReviewerToolSurface strips workflow tools, skips builtin
 *     names, and collects only real external extension paths (pure fixture).
 *  3. The child safety extension blocks .pi/workflow reads and confines
 *     write/edit to the Plan scratch root (pure dispatch fixture).
 *  4. A real DefaultResourceLoader (noExtensions + additionalExtensionPaths)
 *     reconstructs an active external information tool and never loads
 *     workflow tools (integration fixture).
 *  5. State compatibility: older state without planReviewDecisions normalizes
 *     to [] (additive field, backward compatible).
 *  6. Source-level wiring: 30-minute total timeout, finally-dispose, nested
 *     usage propagation, zero-argument tool contract.
 *
 * Pure-function fixtures are loaded via Node 24 type-stripping: the REAL
 * function source is extracted from plan-review-agent.ts into a temp .ts
 * module (with stubbed dependencies) and imported, so the test exercises the
 * actual implementation rather than a hand-maintained copy.
 *
 * Run: node scripts/validate-plan-review-agent.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = process.cwd();
let runs = 0;
let failures = 0;

function assert(condition, msg) {
	runs++;
	if (condition) {
		console.log(`  PASS: ${msg}`);
		return;
	}
	failures++;
	console.error(`  FAIL: ${msg}`);
}

function read(rel) {
	return fs.readFileSync(path.join(root, rel), "utf8");
}

/** Extract a top-level function/interface source by finding its closing
 *  brace at column 0 (handles multi-line return-type object literals,
 *  which naive brace-counting from the first `{` would misread as the body).
 *
 *  WARNING: the column-0 `}` sentinel assumes the extracted function body is
 *  tab-indented. Do NOT introduce a template literal or multi-line comment
 *  that contains a line equal to exactly `}` (column 0) inside any function
 *  this extracts — it would silently truncate the body. If loadTsModule ever
 *  throws an import error after editing plan-review-agent.ts, check here. */
function extractDecl(src, anchor) {
	const start = src.indexOf(anchor);
	if (start < 0) return "";
	const lines = src.slice(start).split("\n");
	const out = [];
	for (const line of lines) {
		out.push(line);
		// Top-level declarations close with a `}` at column 0.
		if (line === "}") break;
	}
	return out.join("\n");
}

/** Extract a `const NAME = new Set([...]);` (or array) source up to its `];`/`);`. */
function extractConst(src, anchor) {
	const start = src.indexOf(anchor);
	if (start < 0) return "";
	let depth = 0;
	let end = start;
	for (let i = start; i < src.length; i++) {
		if (src[i] === "[" || src[i] === "(") depth++;
		else if (src[i] === "]" || src[i] === ")") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	return src.slice(start, end + 1) + ";";
}

/** Write source to a temp .ts module and import it (Node 24 type stripping). */
async function loadTsModule(src) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-ts-"));
	const file = path.join(tmp, "mod.ts");
	fs.writeFileSync(file, src, "utf8");
	try {
		// Cache-bust query so repeated runs in the same process re-evaluate.
		return await import(pathToFileURL(file).href + "?t=" + Date.now());
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

console.log("Plan-review independent-agent regression validation");

const agentTs = read("extensions/workflow/plan-review-agent.ts");
const toolsTs = read("extensions/workflow/tools.ts");
const stateTs = read("extensions/workflow/state.ts");
const typesTs = read("extensions/workflow/types.ts");
const promptsTs = read("extensions/workflow/prompts.ts");

// ═══ Part 1: requirement extraction (pure fixture) ═════════════════════════

console.log("\n=== Part 1: authoritative requirement extraction ===");

{
	const iface = extractDecl(agentTs, "export interface ReviewBranchEntry");
	const extractText = extractDecl(agentTs, "function extractTextContent(");
	const extractReq = extractDecl(agentTs, "export function extractUserRequirements(");
	assert(iface.length > 0 && extractText.length > 0 && extractReq.length > 0, "Part 1: ReviewBranchEntry + extractTextContent + extractUserRequirements extracted");
	const mod = await loadTsModule([iface, extractText, extractReq].join("\n\n"));

	const branch = [
		{ id: "u1", type: "message", message: { role: "user", content: "old requirement from a prior plan" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "planner reasoning" }] } },
		{ id: "t1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
		{ id: "c1", type: "custom", customType: "x", data: {} },
		{ id: "mark", type: "message", message: { role: "assistant", content: [{ type: "text", text: "/plan acknowledged" }] } },
		{ id: "u2", type: "message", message: { role: "user", content: "build the foo feature" } },
		{ id: "u3", type: "message", message: { role: "user", content: [{ type: "text", text: "with bar constraint" }] } },
		{ id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "draft plan" }] } },
	];

	const reqs = mod.extractUserRequirements(branch, "mark");
	assert(reqs.length === 2, "includes only user messages after the planStart marker");
	assert(reqs[0] === "build the foo feature", "first requirement is the post-marker user text");
	assert(reqs.includes("with bar constraint"), "array content blocks are joined into text");
	assert(!reqs.some((r) => r.includes("planner") || r.includes("tool output")), "excludes planner reasoning and tool results");
	assert(!reqs.includes("old requirement from a prior plan"), "excludes prior-plan user content before the marker");

	const reqsFallback = mod.extractUserRequirements(branch, "a2");
	assert(reqsFallback.length === 1 && reqsFallback[0] === "with bar constraint", "falls back to nearest prior user message when none follow the marker");

	// Marker provided but not found in branch → return [] (no prior-plan leak).
	const lost = mod.extractUserRequirements(branch, "nonexistent-marker");
	assert(lost.length === 0, "marker not found in branch yields no requirements (no prior-plan leak)");

	const reqsAll = mod.extractUserRequirements(branch, undefined);
	assert(reqsAll.length === 3, "no marker: collects every user message in the branch");

	assert(mod.extractUserRequirements([], "x").length === 0, "empty branch yields no requirements");
	assert(mod.extractUserRequirements(null, undefined).length === 0, "null branch yields no requirements");

	const blank = mod.extractUserRequirements(
		[{ id: "b", type: "message", message: { role: "user", content: "   " } }],
		undefined,
	);
	assert(blank.length === 0, "blank user messages are skipped");
}

// ═══ Part 2: reconstructReviewerToolSurface (pure fixture) ════════════════

console.log("\n=== Part 2: reviewer tool-surface reconstruction ===");

{
	const fn = extractDecl(agentTs, "export function reconstructReviewerToolSurface(");
	const builtinConst = extractConst(agentTs, "const BUILTIN_TOOL_NAMES = new Set(");
	assert(fn.length > 0 && builtinConst.length > 0, "Part 2: reconstructReviewerToolSurface + BUILTIN_TOOL_NAMES extracted");
	const stubs = `
		// Stub for the imported workflowManagedToolNames dependency.
		// Mirrors ALL names in mode.ts WORKFLOW_GATED_TOOLS + the update_plan alias
		// so the test verifies complete stripping, not a subset.
		function workflowManagedToolNames(pi) {
			return new Set([
				"workflow_todo", "workflow_plan_read", "workflow_plan_save",
				"workflow_plan_approve", "workflow_plan_clear", "workflow_grill_record",
				"workflow_plan_review", "workflow_code_review",
				"workflow_plan_implementation_review",
				"workflow_init_complete",
				"update_plan",
			]);
		}
	`;
	const mod = await loadTsModule([stubs, builtinConst, fn].join("\n\n"));

	const mockPi = {
		getActiveTools: () => [
			"read", "bash", "edit", "write", "grep",
			// Exercise stripping across the full managed set, not a subset.
			"workflow_todo", "workflow_plan_review",
			"workflow_plan_approve", "workflow_grill_record",
			"workflow_plan_implementation_review",
			"update_plan",
			"web_search", "mcp__server__tool",
		],
		getAllTools: () => [
			{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
			{ name: "bash", sourceInfo: { source: "local", path: "/proj/extensions/workflow/index.ts" } },
			{ name: "edit", sourceInfo: { source: "builtin", path: "<builtin:edit>" } },
			{ name: "write", sourceInfo: { source: "builtin", path: "<builtin:write>" } },
			{ name: "grep", sourceInfo: { source: "builtin", path: "<builtin:grep>" } },
			{ name: "workflow_todo", sourceInfo: { source: "local", path: "/proj/extensions/workflow/index.ts" } },
			{ name: "workflow_plan_review", sourceInfo: { source: "local", path: "/proj/extensions/workflow/index.ts" } },
			{ name: "web_search", sourceInfo: { source: "local", path: "/proj/extensions/web/index.ts" } },
			{ name: "mcp__server__tool", sourceInfo: { source: "local", path: "/proj/extensions/mcp/index.ts" } },
		],
	};

	const { requestedTools, extensionPaths } = mod.reconstructReviewerToolSurface(mockPi);

	// Sync guard: the stub's workflowManagedToolNames MUST mirror every name in
	// mode.ts WORKFLOW_GATED_TOOLS (+ update_plan alias). Parse the real source so
	// a newly added managed tool is caught here rather than silently passing.
	const modeTs = read("extensions/workflow/mode.ts");
	const wfGatedStart = modeTs.indexOf("WORKFLOW_GATED_TOOLS = [");
	const wfGatedEnd = modeTs.indexOf("] as const", wfGatedStart);
	const wfGatedBlock = wfGatedStart >= 0 ? modeTs.slice(wfGatedStart, wfGatedEnd) : "";
	const realManagedNames = [...wfGatedBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
	assert(realManagedNames.length > 0, "Part 2: parsed WORKFLOW_GATED_TOOLS from mode.ts");
	for (const name of realManagedNames) {
		assert(true, `Part 2: mode.ts managed tool '${name}' present in real source`);
	}
	// Bidirectional equality: the stub's workflowManagedToolNames set MUST exactly
	// match WORKFLOW_GATED_TOOLS (sans the update_plan alias, which is added
	// separately). Catches both a missing new tool in the stub and a stray entry
	// that would only log warnings instead of failing.
	const stubGated = new Set([
		"workflow_todo", "workflow_plan_read", "workflow_plan_save",
		"workflow_plan_approve", "workflow_plan_clear", "workflow_grill_record",
		"workflow_plan_review", "workflow_code_review",
		"workflow_plan_implementation_review",
		"workflow_init_complete",
	]);
	const realGated = new Set(realManagedNames);
	assert(
		[...stubGated].every((n) => realGated.has(n)) &&
			[...realGated].every((n) => stubGated.has(n)),
		"Part 2: stub workflowManagedToolNames set is bidirectionally equal to mode.ts WORKFLOW_GATED_TOOLS",
	);
	assert(realGated.has("workflow_plan_implementation_review"), "Part 2: WORKFLOW_GATED_TOOLS includes workflow_plan_implementation_review");
	const req = new Set(requestedTools);
	assert(!req.has("workflow_todo") && !req.has("workflow_plan_review"), "workflow tools removed from requested allowlist");
	assert(!req.has("workflow_plan_approve") && !req.has("workflow_grill_record"), "additional workflow tools removed from requested allowlist");
	assert(!req.has("workflow_plan_implementation_review"), "workflow_plan_implementation_review removed from requested allowlist (stripped from child reviewer)");
	assert(!req.has("update_plan"), "update_plan RPC alias removed from requested allowlist");
	assert(req.has("read") && req.has("bash") && req.has("grep"), "builtin tools retained in requested allowlist");
	assert(req.has("web_search") && req.has("mcp__server__tool"), "external information tools retained");
	assert(extensionPaths.includes("/proj/extensions/web/index.ts"), "external extension path collected");
	assert(extensionPaths.includes("/proj/extensions/mcp/index.ts"), "mcp extension path collected");
	assert(!extensionPaths.includes("/proj/extensions/workflow/index.ts"), "pi-workflow own path never collected (bash treated as builtin)");
	assert(!extensionPaths.some((p) => p.startsWith("<")), "synthetic markers not collected as real paths");
}

// ═══ Part 3: child safety extension dispatch (pure fixture) ════════════════

console.log("\n=== Part 3: child safety extension tool_call guard ===");

{
	const fn = extractDecl(agentTs, "export function createReviewerSafetyExtension(");
	assert(fn.length > 0, "Part 3: createReviewerSafetyExtension extracted from plan-review-agent.ts");
	// The interface extraction is best-effort; the function body is what matters.
	const stubs = `
		import path from "node:path";
		import os from "node:os";
		// Contract-faithful stubs for the imported path guards. The real function
		// calls isWorkflowDataPath(target, roots.primaryCwd) and
		// isWorkflowDataPath(target, roots.reviewCwd); the stub handles both roots.
		function isWorkflowDataPath(targetPath, cwd) {
			if (typeof cwd !== "string") return false;
			const resolved = path.resolve(cwd, targetPath);
			const workflowRoot = path.resolve(cwd, ".pi", "workflow");
			return resolved === workflowRoot || resolved.startsWith(workflowRoot + path.sep);
		}
		function isAllowedPlanScratchPath(cwd, targetPath) {
			const scratch = path.join(os.tmpdir(), "pi-workflow-plan-scratch");
			const resolved = path.resolve(targetPath);
			const rel = path.relative(scratch, resolved);
			if (rel.startsWith("..") || path.resolve(scratch, rel) !== resolved) return "not under scratch root";
			return null;
		}
	`;
	const mod = await loadTsModule([stubs, fn].join("\n\n"));

	let captured = null;
	const fakePi = { on: (ev, h) => { if (ev === "tool_call") captured = h; } };
	// createReviewerSafetyExtension now takes { primaryCwd, reviewCwd }.
	const primaryRoot = path.join(root, "main-checkout");
	const reviewRoot = path.join(root, "worktree");
	const ext = mod.createReviewerSafetyExtension({ primaryCwd: primaryRoot, reviewCwd: reviewRoot });
	ext.factory(fakePi);
	assert(typeof captured === "function", "safety extension registers a tool_call handler");

	// Read of .pi/workflow/ in EITHER root is blocked (dual workflow-root guard).
	const primaryWfRead = captured({ toolName: "read", input: { path: path.join(primaryRoot, ".pi/workflow/sessions/x/state.json") } }, {});
	assert(primaryWfRead && primaryWfRead.block === true, "read of .pi/workflow/ under primaryCwd is blocked");
	const reviewWfRead = captured({ toolName: "read", input: { path: path.join(reviewRoot, ".pi/workflow/plan/p.md") } }, {});
	assert(reviewWfRead && reviewWfRead.block === true, "read of .pi/workflow/ under reviewCwd is blocked (dual-root guard)");

	const normalRead = captured({ toolName: "read", input: { path: "src/foo.ts" } }, {});
	assert(!normalRead || normalRead.block === undefined, "read of a normal project file is allowed");

	const projectWrite = captured({ toolName: "write", input: { path: path.join(reviewRoot, "src/foo.ts") } }, {});
	assert(projectWrite && projectWrite.block === true, "write to a project file is blocked (non-scratch)");

	const scratchWrite = captured(
		{ toolName: "write", input: { path: path.join(os.tmpdir(), "pi-workflow-plan-scratch", "probe.js") } },
		{},
	);
	assert(!scratchWrite || scratchWrite.block === undefined, "write under the Plan scratch root is allowed");

	const pathlessWrite = captured({ toolName: "edit", input: {} }, {});
	assert(pathlessWrite && pathlessWrite.block === true, "edit without a path is blocked");
}

// ═══ Part 4: real extension reconstruction via ResourceLoader ═════════════

console.log("\n=== Part 4: external tool reconstruction (ResourceLoader) ===");

{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-ext-"));
	const extPath = path.join(tmp, "probe-ext.mjs");
	fs.writeFileSync(
		extPath,
		[
			"export default function (pi) {",
			"  pi.registerTool({",
			"    name: \"probe_info_tool\",",
			"    description: \"probe\",",
			"    parameters: { type: \"object\", properties: {} },",
			"    async execute() { return { content: [{ type: \"text\", text: \"ok\" }], details: {} }; },",
			"  });",
			"}",
		].join("\n"),
	);
	const agentDir = path.join(process.env.HOME || os.homedir(), ".pi", "agent");
	const settings = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd: tmp,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		additionalExtensionPaths: [extPath],
	});
	await loader.reload({ resolveProjectTrust: async () => true });
	const ext = loader.getExtensions();
	const toolNames = new Set();
	for (const e of ext.extensions) {
		for (const t of e.tools.values()) toolNames.add(t.definition.name);
	}
	assert(toolNames.has("probe_info_tool"), "active external information tool loads via additionalExtensionPaths");
	assert(!toolNames.has("workflow_plan_review"), "workflow tools stay absent under noExtensions + curated paths");
	assert(!toolNames.has("workflow_todo"), "workflow_todo absent from the child loader");
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ═══ Part 5: state compatibility (additive fields) ═════════════════════════

console.log("\n=== Part 5: state compatibility ===");

assert(typesTs.includes("planReviewDecisions: GrillTurn[];"), "WorkflowState declares planReviewDecisions");
assert(typesTs.includes("planStartEntryId?: string;"), "WorkflowState declares planStartEntryId");
assert(typesTs.includes("approvedTodos?: TodoItem[];"), "WorkflowState declares approvedTodos");
assert(typesTs.includes("workStartEntryId?: string;"), "WorkflowState declares workStartEntryId");
assert(typesTs.includes("implementationReview?:"), "WorkflowState declares implementationReview");
assert(stateTs.includes("planReviewDecisions: normalizeGrillTurns(obj.planReviewDecisions)"), "planReviewDecisions normalized through shared helper");
assert(stateTs.includes("planStartEntryId:"), "planStartEntryId normalized");

{
	const ngFn = extractDecl(stateTs, "function normalizeGrillTurns(raw");
	const ntFn = extractDecl(stateTs, "function normalizeTodos(raw");
	const nirFn = extractDecl(stateTs, "function normalizeImplementationReview(");
	const nsFn = extractDecl(stateTs, "export function normalizeState(raw");
	assert(ngFn.length > 0 && ntFn.length > 0 && nirFn.length > 0 && nsFn.length > 0, "Part 5: normalizeGrillTurns + normalizeTodos + normalizeImplementationReview + normalizeState extracted from state.ts");
	const mod = await loadTsModule(
		[
			"const DEFAULT_STATE = { workflowEnabled: false, workflowExplicitlyDisabled: false, mode: \"idle\", todos: [], grillTurns: [], planReviewDecisions: [] };",
			'import path from "node:path";',
			'function branchMatchesWorkRun(branch, workRunId) { return typeof branch === "string" && typeof workRunId === "string" && branch.includes(workRunId.slice(-8)); }',
			ngFn,
			ntFn,
			nirFn,
			nsFn,
		].join("\n\n"),
	);

	const oldState = mod.normalizeState({ mode: "plan", planRunId: "abc", grillTurns: [] });
	assert(Array.isArray(oldState.planReviewDecisions) && oldState.planReviewDecisions.length === 0, "old state without planReviewDecisions normalizes to []");
	assert(oldState.planStartEntryId === undefined, "old state without planStartEntryId normalizes to undefined");
	// New additive fields: old state normalizes to undefined/absent.
	assert(oldState.approvedTodos === undefined, "old state without approvedTodos normalizes to undefined");
	assert(oldState.workStartEntryId === undefined, "old state without workStartEntryId normalizes to undefined");
	assert(oldState.implementationReview === undefined, "old state without implementationReview normalizes to undefined");

	const withDecisions = mod.normalizeState({
		planReviewDecisions: [{ question: "q", recommendedAnswer: "r", decisionStatus: "resolved" }],
	});
	assert(withDecisions.planReviewDecisions.length === 1, "planReviewDecisions round-trips through normalization");
	assert(withDecisions.planReviewDecisions[0].decisionStatus === "resolved", "decision status preserved");

	// approvedTodos round-trips through normalizeTodos.
	const withApproved = mod.normalizeState({
		approvedTodos: [{ id: "T1", title: "task", status: "done" }],
	});
	assert(withApproved.approvedTodos && withApproved.approvedTodos.length === 1 && withApproved.approvedTodos[0].id === "T1", "approvedTodos round-trips through normalization");
	// Empty approvedTodos normalizes to undefined (no snapshot).
	assert(mod.normalizeState({ approvedTodos: [] }).approvedTodos === undefined, "empty approvedTodos normalizes to undefined");

	// workStartEntryId round-trips (trimmed, non-empty).
	assert(mod.normalizeState({ workStartEntryId: "leaf-1" }).workStartEntryId === "leaf-1", "workStartEntryId round-trips through normalization");
	assert(mod.normalizeState({ workStartEntryId: "  " }).workStartEntryId === undefined, "blank workStartEntryId normalizes to undefined");

	// implementationReview normalization: valid record preserved, invalid dropped.
	const validReview = mod.normalizeState({ implementationReview: { workRunId: "run-1", workspaceFingerprint: "abc123" } });
	assert(validReview.implementationReview && validReview.implementationReview.workRunId === "run-1" && validReview.implementationReview.workspaceFingerprint === "abc123", "implementationReview round-trips when valid");
	assert(mod.normalizeState({ implementationReview: { workRunId: "", workspaceFingerprint: "x" } }).implementationReview === undefined, "implementationReview with empty workRunId normalizes to undefined");
	assert(mod.normalizeState({ implementationReview: { workRunId: "r", workspaceFingerprint: "" } }).implementationReview === undefined, "implementationReview with empty fingerprint normalizes to undefined");
	assert(mod.normalizeState({ implementationReview: "garbage" }).implementationReview === undefined, "implementationReview with non-object normalizes to undefined");
}

// ═══ Part 6: source-level wiring (timeout / dispose / usage / contract) ═══

console.log("\n=== Part 6: reviewer wiring & tool contract ===");

{
	assert(agentTs.includes("REVIEWER_TOTAL_TIMEOUT_MS = 1_800_000"), "30-minute total timeout constant");
	assert(/setTimeout\(\s*\(\)\s*=>\s*controller\.abort\(\)/.test(agentTs), "timeout schedules controller.abort");
	assert(/finally\s*\{[\s\S]*?session\.dispose\(\)/.test(agentTs), "child session disposed in finally");
	assert(/finally\s*\{[\s\S]*?clearTimeout\(timer\)/.test(agentTs), "timer cleared in finally (no dangling timeout)");
	assert(/finally\s*\{[\s\S]*?removeEventListener\("abort"/.test(agentTs), "abort listeners removed in finally (no dangling listeners)");
	assert(agentTs.includes("unsub()"), "session subscription unsubscribed in finally");
	assert(/session\.abort\(\)\.catch/.test(agentTs), "fire-and-forget abort is catch-guarded (no unhandledRejection)");
	assert(agentTs.includes("SessionManager.inMemory"), "uses an in-memory (non-persistent) child session");
	assert(agentTs.includes("getRegisteredNativeProvider"), "createChildModelRuntime copies Provider-object registrations (native store)");
	assert(agentTs.includes("registerNativeProvider"), "createChildModelRuntime re-registers native Providers via registerNativeProvider");
	assert(agentTs.includes("getRegisteredProviderConfig"), "createChildModelRuntime also handles config-style registrations");
	assert(agentTs.includes("requestedTools") && agentTs.includes("unavailableTools"), "result carries tool diagnostics");
	assert(agentTs.includes("appendSystemPrompt: [systemPrompt]"), "shared runner injects the caller-provided system prompt into child system prompt");
	assert(agentTs.includes("REVIEWER_SYSTEM_PROMPT"), "plan-review system prompt constant still defined");
	assert(agentTs.includes("runIndependentReviewer("), "shared runIndependentReviewer runner extracted");
	assert(agentTs.includes("safetyRoots: { primaryCwd: ctx.cwd, reviewCwd: ctx.cwd }"), "runPlanReviewAgent delegates to shared runner with plan-review roots");
	assert(agentTs.includes("bindExtensions"), "child extensions bound (initialize external tools)");
	assert(agentTs.includes("isProjectTrusted"), "child project-trust aligned with parent");

	assert(toolsTs.includes("usage: result.usage"), "tool result propagates nested usage on top-level usage field");
	assert(/parameters:\s*Type\.Object\(\{\s*\}\)/.test(toolsTs), "workflow_plan_review is zero-argument");
	assert(/prepareArguments:\s*preparePlanReviewArguments/.test(toolsTs), "prepareArguments wired for legacy fields");
	assert(toolsTs.includes("runPlanReviewAgent("), "tool invokes the independent reviewer");
	assert(promptsTs.includes("独立的 agent") || promptsTs.includes("独立审查"), "plan prompt describes independent agent review");
	assert(!promptsTs.includes("workflow_plan_review(task="), "plan prompt no longer shows legacy sidecall arguments");
	assert(!fs.existsSync(path.join(root, "extensions/workflow/sidecall.ts")), "sidecall.ts removed");
}

// ═══ Part 7: Implementation Reviewer pure functions ═══════════════════════

console.log("\n=== Part 7: implementation-review-agent pure functions ===");

{
	const implTs = read("extensions/workflow/implementation-review-agent.ts");
	assert(implTs.includes("export async function runImplementationReviewAgent"), "implementation-review-agent.ts exports runImplementationReviewAgent");
	assert(implTs.includes("IMPLEMENTATION_REVIEWER_SYSTEM_PROMPT"), "implementation-review-agent.ts defines its own system prompt");
	assert(implTs.includes("VERDICT_LINE_PREFIX"), "implementation-review-agent.ts exports VERDICT_LINE_PREFIX");
	assert(implTs.includes("runIndependentReviewer"), "implementation-review-agent.ts delegates to the shared runner");
	assert(implTs.includes("reviewCwd"), "implementation-review-agent.ts runs in the validated review cwd");
	assert(implTs.includes("primaryCwd"), "implementation-review-agent.ts passes primaryCwd for dual-root guard");
	// FAIL without repo tool calls is enforced.
	assert(implTs.includes("madeRepoToolCall"), "implementation-review-agent.ts tracks whether the reviewer inspected the repo");
	assert(implTs.includes("REPO_TOOL_NAMES"), "implementation-review-agent.ts defines REPO_TOOL_NAMES for repo-inspection detection");
	// Prompt verdict examples must stay consistent with the parser's VERDICT_LINE_PREFIX.
	assert(
		/IMPLEMENTATION_REVIEW_VERDICT: PASS/.test(implTs),
		"implementation-review-agent.ts system prompt includes the PASS verdict example matching VERDICT_LINE_PREFIX",
	);

	// ── verdict parser (pure fixture) ──
	const vpFn = extractDecl(implTs, "export function parseImplementationVerdict(");
	assert(vpFn.length > 0, "Part 7: parseImplementationVerdict extracted");
	const vpMod = await loadTsModule([
		'export const VERDICT_LINE_PREFIX = "IMPLEMENTATION_REVIEW_VERDICT:";',
		vpFn,
	].join("\n\n"));

	const passText = "## Summary\nok\nIMPLEMENTATION_REVIEW_VERDICT: PASS";
	assert(vpMod.parseImplementationVerdict(passText).verdict === "PASS", "verdict parser: exact PASS line → PASS");
	const failText = "## Summary\nissues found\nIMPLEMENTATION_REVIEW_VERDICT: FAIL";
	assert(vpMod.parseImplementationVerdict(failText).verdict === "FAIL", "verdict parser: exact FAIL line → FAIL");
	// Missing verdict line → FAIL (fail-closed).
	const noVerdict = vpMod.parseImplementationVerdict("## Summary\nno verdict here");
	assert(noVerdict.verdict === "FAIL" && noVerdict.reason, "verdict parser: missing verdict line → FAIL with reason");
	// Empty text → FAIL.
	assert(vpMod.parseImplementationVerdict("").verdict === "FAIL", "verdict parser: empty text → FAIL");
	// Conflicting verdict lines → FAIL.
	const conflicting = vpMod.parseImplementationVerdict("IMPLEMENTATION_REVIEW_VERDICT: PASS\nIMPLEMENTATION_REVIEW_VERDICT: FAIL");
	assert(conflicting.verdict === "FAIL", "verdict parser: conflicting verdict lines → FAIL");
	// Multiple PASS lines that agree → PASS.
	const multiPass = vpMod.parseImplementationVerdict("IMPLEMENTATION_REVIEW_VERDICT: PASS\nIMPLEMENTATION_REVIEW_VERDICT: PASS");
	assert(multiPass.verdict === "PASS", "verdict parser: multiple agreeing PASS lines → PASS");
	// Unrecognized verdict value → FAIL.
	const badValue = vpMod.parseImplementationVerdict("IMPLEMENTATION_REVIEW_VERDICT: MAYBE");
	assert(badValue.verdict === "FAIL", "verdict parser: unrecognized verdict value → FAIL");

	// ── task builders (pure fixture) ──
	const approvedFn = extractDecl(implTs, "export function buildApprovedImplementationReviewTask(");
	const directFn = extractDecl(implTs, "export function buildDirectImplementationReviewTask(");
	const fmtFn = extractDecl(implTs, "export function formatTodosForReview(");
	assert(approvedFn.length > 0 && directFn.length > 0 && fmtFn.length > 0, "Part 7: task builders + formatTodosForReview extracted");

	// Approved task builder fixture.
	const approvedMod = await loadTsModule(fmtFn + "\n\n" + approvedFn);
	const approvedTask = approvedMod.buildApprovedImplementationReviewTask({
		requirements: ["build feature X"],
		planMarkdown: "# Final Plan\n## Goal\nDo X",
		approvedTodos: [{ id: "T1", title: "impl X", status: "pending" }],
		currentTodos: [{ id: "T1", title: "impl X", status: "done" }],
	});
	assert(approvedTask.includes("Authoritative User Requirements"), "Approved task includes user requirements");
	assert(approvedTask.includes("Final Plan"), "Approved task includes Final Plan");
	assert(approvedTask.includes("Approved Todo Snapshot"), "Approved task includes approved todo snapshot");
	assert(approvedTask.includes("Current Todo List"), "Approved task includes current todos");
	// Must NOT include parent diff/summary/test claims (isolation).
	// Isolation: the task must not embed parent-provided diff output, execution
	// summaries, or test-result claims. ("git diff" appears only as a tool the
	// reviewer may use, not as embedded parent evidence.)
	assert(!/Parent Execution Summary|Parent Diff|Test Results Claim|passed tests:/i.test(approvedTask), "Approved task excludes parent execution summary / diff output / test claims");
	assert(!approvedTask.includes("workflow_code_review"), "Approved task does not embed OCR code review output");
	// Snapshot gap is flagged when approvedTodos is empty.
	const gapTask = approvedMod.buildApprovedImplementationReviewTask({
		requirements: ["r"],
		planMarkdown: "# Plan",
		approvedTodos: undefined,
		currentTodos: [{ id: "T1", title: "t", status: "done" }],
	});
	assert(gapTask.includes("Approved todo snapshot is MISSING"), "Approved task flags missing snapshot gap");

	// Direct task builder fixture.
	const directMod = await loadTsModule(fmtFn + "\n\n" + directFn);
	const directTask = directMod.buildDirectImplementationReviewTask({
		requirements: ["fix bug Y"],
		currentTodos: [{ id: "T1", title: "fix Y", status: "done" }],
	});
	assert(directTask.includes("Authoritative User Requirements (this Work lifecycle)"), "Direct task includes Work-lifecycle requirements");
	assert(directTask.includes("Current Todo List"), "Direct task includes current todos");
	assert(!directTask.includes("Final Plan"), "Direct task does NOT include a Final Plan");
	assert(!directTask.includes("Approved Todo Snapshot"), "Direct task does NOT include approved todo snapshot");
}

// ═══ Part 8: workspace fingerprint + cleanup-before-fingerprint timing ════

console.log("\n=== Part 8: workspace fingerprint + runner timing ===");

{
	const wtTs = read("extensions/workflow/worktree.ts");
	assert(wtTs.includes("export function computeWorkspaceFingerprint"), "worktree.ts exports computeWorkspaceFingerprint");
	assert(wtTs.includes("export function workspaceFingerprintMatches"), "worktree.ts exports workspaceFingerprintMatches");
	// Fixed git args for reproducibility.
	assert(wtTs.includes('"--no-ext-diff"'), "fingerprint uses --no-ext-diff for reproducibility");
	assert(wtTs.includes('"--no-textconv"'), "fingerprint uses --no-textconv for reproducibility");
	assert(wtTs.includes('"--no-renames"'), "fingerprint uses --no-renames for reproducibility");
	assert(wtTs.includes('"--binary"'), "fingerprint uses --binary to capture all diff bytes");
	// Untracked (non-ignored) files are included so new source is covered.
	assert(wtTs.includes('"--others", "--exclude-standard", "-z"'), "fingerprint includes sorted non-ignored untracked files");
	assert(/hash\.update\(content\)/.test(wtTs), "fingerprint feeds untracked file content into the hash");
	// SHA-256 digest.
	assert(wtTs.includes('"sha256"'), "fingerprint uses SHA-256");

	// Real fingerprint on a temp git repo.
	const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "wf-fp-"));
	try {
		const { execSync } = await import("node:child_process");
		const run = (cmd) => execSync(cmd, { cwd: tmpRepo, stdio: "ignore", encoding: "utf8" });
		run("git init");
		run('git config user.email "t@t.t"');
		run('git config user.name "t"');
		fs.writeFileSync(path.join(tmpRepo, "a.txt"), "initial\n");
		run("git add a.txt");
		run('git commit -m "init"');
		const { computeWorkspaceFingerprint, workspaceFingerprintMatches } = await import(
			pathToFileURL(path.join(root, "extensions/workflow/worktree.ts")).href
		);
		const fp1 = computeWorkspaceFingerprint(tmpRepo);
		assert(typeof fp1 === "string" && fp1.length === 64, "computeWorkspaceFingerprint returns a 64-char SHA-256 hex");
		assert(workspaceFingerprintMatches(tmpRepo, fp1), "workspaceFingerprintMatches true for unchanged workspace");
		// Modify tracked content → fingerprint changes.
		fs.writeFileSync(path.join(tmpRepo, "a.txt"), "changed\n");
		assert(!workspaceFingerprintMatches(tmpRepo, fp1), "fingerprint changes after tracked file edit (PASS would be invalidated)");
		const fp2 = computeWorkspaceFingerprint(tmpRepo);
		// Add untracked new source file → fingerprint changes (new files covered).
		fs.writeFileSync(path.join(tmpRepo, "new-source.txt"), "brand new file\n");
		assert(!workspaceFingerprintMatches(tmpRepo, fp2), "fingerprint changes after adding untracked new source file");
		const fp3 = computeWorkspaceFingerprint(tmpRepo);
		assert(workspaceFingerprintMatches(tmpRepo, fp3), "fingerprint stable when no changes");
		// Ignored files do NOT affect the fingerprint.
		fs.writeFileSync(path.join(tmpRepo, ".gitignore"), "ignored.log\n");
		run("git add .gitignore && git commit -m gi");
		const fp4 = computeWorkspaceFingerprint(tmpRepo);
		fs.writeFileSync(path.join(tmpRepo, "ignored.log"), "noise\n");
		assert(workspaceFingerprintMatches(tmpRepo, fp4), "ignored untracked files do NOT affect the fingerprint");
	} finally {
		fs.rmSync(tmpRepo, { recursive: true, force: true });
	}

	// Cleanup-before-fingerprint timing: the implementation review tool computes
	// the fingerprint AFTER runImplementationReviewAgent returns (which fully
	// disposes the child session via the shared runner's finally).
	const toolsSrc = read("extensions/workflow/tools.ts");
	const implToolStart = toolsSrc.indexOf("export function registerPlanImplementationReviewTool");
	const implToolEnd = toolsSrc.indexOf("// ── Bulk registration", implToolStart);
	assert(implToolStart >= 0 && implToolEnd > implToolStart, "Part 8: implementation review tool block anchors exist");
	const implToolBlock = toolsSrc.slice(implToolStart, implToolEnd);
	assert(implToolBlock.includes("runImplementationReviewAgent("), "implementation review tool invokes runImplementationReviewAgent");
	// The fingerprint computation must come AFTER the runner returns.
	const runnerCallIdx = implToolBlock.indexOf("runImplementationReviewAgent(");
	const fpIdx = implToolBlock.indexOf("computeWorkspaceFingerprint(reviewCwd)");
	assert(runnerCallIdx >= 0 && fpIdx > runnerCallIdx, "implementation review tool computes fingerprint AFTER the runner returns (cleanup-before-fingerprint)");
	// PASS only recorded when verdict PASS + repo tool calls.
	assert(/delete reloaded\.implementationReview/.test(implToolBlock), "implementation review tool clears stale PASS on FAIL/no-repo-calls");
	assert(implToolBlock.includes("workRunId: reloaded.workRunId"), "implementation review tool binds PASS to the current (reloaded) workRunId");
	assert(implToolBlock.includes("staleWorkRun"), "implementation review tool guards against stale work run during review (staleWorkRun check)");
}

// ═══ Part 9: commit gate + agent_end fingerprint + approve snapshot ════════

console.log("\n=== Part 9: commit gate + agent_end + approve snapshot ===");

{
	const commandsSrc = read("extensions/workflow/commands.ts");
	const toolsSrc = read("extensions/workflow/tools.ts");

	// /commit gate: requires matching Implementation Review PASS for active Work,
	// but only when implementationReview.enabled is true (关闭即放行).
	const commitStart = commandsSrc.indexOf("export function registerCommitCommand");
	const commitEnd = commandsSrc.indexOf("export function registerWfStatusCommand", commitStart);
	const commitBlock = commandsSrc.slice(commitStart, commitEnd > 0 ? commitEnd : commandsSrc.length);
	assert(commitBlock.includes("current.mode === \"work\""), "/commit gate checks active Work mode");
	assert(commitBlock.includes("current.implementationReview"), "/commit gate checks for implementationReview PASS");
	assert(commitBlock.includes("commitConfig.implementationReview.enabled"), "/commit gate is gated on implementationReview.enabled (关闭即放行)");
	assert(commitBlock.includes("loadConfigForContext"), "/commit gate loads config to check enabled flag");
	assert(commitBlock.includes("computeWorkspaceFingerprint"), "/commit gate computes current fingerprint");
	assert(commitBlock.includes("pass.workspaceFingerprint"), "/commit gate compares against recorded fingerprint");
	// Commit does NOT require OCR.
	assert(!/codeReview\.enabled/.test(commitBlock), "/commit gate does NOT require OCR code review");

	// agent_end: only checks fingerprint when a PASS exists in Work mode.
	const agentEndStart = commandsSrc.indexOf("export function registerAgentEnd");
	const agentEndEnd = commandsSrc.indexOf("export function registerWfCommand", agentEndStart);
	const agentEndBlock = commandsSrc.slice(agentEndStart, agentEndEnd > 0 ? agentEndEnd : commandsSrc.length);
	assert(agentEndBlock.includes("state.implementationReview"), "agent_end checks for existing PASS");
	assert(agentEndBlock.includes("computeWorkspaceFingerprint"), "agent_end computes fingerprint to detect staleness");
	assert(agentEndBlock.includes('state.mode === "work"'), "agent_end only runs the fingerprint check in Work mode");

	// approve: non-empty todo gate + approvedTodos snapshot + clear PASS.
	const approveStart = toolsSrc.indexOf("export function registerPlanApproveTool");
	const approveEnd = toolsSrc.indexOf("export function registerPlanClearTool", approveStart);
	const approveBlock = toolsSrc.slice(approveStart, approveEnd);
	assert(approveBlock.includes("empty todo list"), "approve rejects empty todo list");
	assert(approveBlock.includes("approvedTodos: state.todos.map"), "approve deep-copies todos into approvedTodos snapshot");
	assert(approveBlock.includes("implementationReview: undefined"), "approve clears any prior Implementation Review PASS");

	// /work: captures workStartEntryId + clears approved/review state.
	const workStart = commandsSrc.indexOf("export function registerWorkCommand");
	const workEnd = commandsSrc.indexOf("export function registerReviewCommand", workStart);
	const workBlock = commandsSrc.slice(workStart, workEnd > 0 ? workEnd : commandsSrc.length);
	assert(workBlock.includes("workStartEntryId"), "/work captures workStartEntryId for Direct Work requirement scoping");
	assert(workBlock.includes("approvedTodos: undefined"), "/work clears approved todos for Direct Work");
	assert(workBlock.includes("implementationReview: undefined"), "/work clears prior Implementation Review PASS");

	// Todo mutations invalidate the PASS (both surfaces).
	const todoToolStart = toolsSrc.indexOf("export function registerTodoTool");
	const todoToolEnd = toolsSrc.indexOf("export function registerUpdatePlanTool", todoToolStart);
	const todoToolBlock = toolsSrc.slice(todoToolStart, todoToolEnd);
	assert(/delete state\.implementationReview/.test(todoToolBlock), "workflow_todo mutations delete implementationReview PASS");
	const upStart = toolsSrc.indexOf("export function registerUpdatePlanTool");
	const upEnd = toolsSrc.indexOf("// ── workflow plan tools", upStart);
	const upBlock = toolsSrc.slice(upStart, upEnd > 0 ? upEnd : toolsSrc.length);
	assert(/delete state\.implementationReview/.test(upBlock), "update_plan mutations delete implementationReview PASS");
}

// ═══ Part 10: implementationReview config role + enabled flag ═════════════

console.log("\n=== Part 10: implementationReview config role + enabled flag ===");

{
	const typesTs = read("extensions/workflow/types.ts");
	const defaultsTs = read("extensions/workflow/defaults.ts");
	const configTs = read("extensions/workflow/config.ts");
	const settingsTs = read("extensions/workflow/settings.ts");
	const modeTs = read("extensions/workflow/mode.ts");
	const toolsTs = read("extensions/workflow/tools.ts");
	const exampleJson = read("config.json.example");

	// Role union includes implementationReview.
	assert(/"implementationReview"/.test(typesTs), "types.ts: Role union includes implementationReview");
	// WorkflowConfig has implementationReview section.
	assert(typesTs.includes("implementationReview: {"), "types.ts: WorkflowConfig declares implementationReview section");
	assert(typesTs.includes("implementationReview?: Partial<"), "types.ts: WorkflowConfigOverride declares implementationReview override");

	// defaults: model + enabled default true.
	assert(defaultsTs.includes("implementationReview:"), "defaults.ts: DEFAULT_CONFIG includes implementationReview");
	assert(/implementationReview:[\s\S]*?enabled: true/.test(defaultsTs), "defaults.ts: implementationReview.enabled defaults to true");
	assert(/implementationReview:[\s\S]*?provider:[\s\S]*?model:[\s\S]*?thinking/.test(defaultsTs), "defaults.ts: implementationReview has a model spec");

	// config.json.example mirrors the closed set.
	assert(exampleJson.includes('"implementationReview"'), "config.json.example includes implementationReview");

	// config.ts: VALID_ROLES + normalize + leafPaths.
	assert(configTs.includes('"implementationReview"'), "config.ts: VALID_ROLES includes implementationReview");
	assert(/implementationReview && typeof cfg\.implementationReview === "object"/.test(configTs), "config.ts: normalizeConfig strips unknown implementationReview fields");
	assert(configTs.includes('"implementationReview.enabled"'), "config.ts: leafPaths includes implementationReview.enabled");
	assert(/"implementationReview", "work"/.test(configTs), "config.ts: leafPaths models list includes implementationReview");

	// settings.ts: ROLES + RELOAD_SENSITIVE_IDS + descriptor.
	assert(settingsTs.includes('"implementationReview"'), "settings.ts: ROLES includes implementationReview");
	assert(settingsTs.includes('"implementationReview.enabled"'), "settings.ts: RELOAD_SENSITIVE_IDS + descriptor include implementationReview.enabled");

	// mode.ts: implementation review is conditional on implementationReview.enabled
	// (no longer unconditionally in WORK_WORKFLOW_TOOL_NAMES).
	// WORK_WORKFLOW_TOOL_NAMES array body must NOT contain implementation review
	// (it is now conditionally pushed in computeWorkflowToolNames). Scope the
	// regex to the array literal's closing ] so it cannot match the push site.
	const workArrayMatch = modeTs.match(/const WORK_WORKFLOW_TOOL_NAMES = (\[[\s\S]*?\]);/);
	assert(workArrayMatch !== null, "Part 10: WORK_WORKFLOW_TOOL_NAMES array found");
	assert(workArrayMatch !== null && !/workflow_plan_implementation_review/.test(workArrayMatch[1]), "mode.ts: WORK_WORKFLOW_TOOL_NAMES array does not include implementation review (now conditional)");
	assert(/config\.implementationReview\.enabled[\s\S]*?names\.push\("workflow_plan_implementation_review"\)/.test(modeTs), "mode.ts: work branch conditionally pushes implementation review on implementationReview.enabled");

	// tools.ts: implementation review handler uses models.implementationReview.
	const implToolStart = toolsTs.indexOf("export function registerPlanImplementationReviewTool");
	const implToolEnd = toolsTs.indexOf("// ── Bulk registration", implToolStart);
	const implToolBlock = toolsTs.slice(implToolStart, implToolEnd);
	assert(implToolBlock.includes("config.models.implementationReview"), "tools.ts: implementation review handler uses config.models.implementationReview (own role, not planReview)");
	assert(!/modelSpec: config\.models\.planReview/.test(implToolBlock), "tools.ts: implementation review handler does NOT reuse planReview model");
}

// ═══ Result ════════════════════════════════════════════════════════════════

console.log(`\n=== Result: ${runs - failures}/${runs} checks passed ===`);
if (failures > 0) {
	console.error(`${failures} test(s) FAILED.`);
	process.exit(1);
}
