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
				"workflow_plan_review", "workflow_review",
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
			"workflow_review",
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
		"workflow_plan_review", "workflow_review",
		"workflow_init_complete",
	]);
	const realGated = new Set(realManagedNames);
	assert(
		[...stubGated].every((n) => realGated.has(n)) &&
			[...realGated].every((n) => stubGated.has(n)),
		"Part 2: stub workflowManagedToolNames set is bidirectionally equal to mode.ts WORKFLOW_GATED_TOOLS",
	);
	assert(realGated.has("workflow_review"), "Part 2: WORKFLOW_GATED_TOOLS includes workflow_review");
	const req = new Set(requestedTools);
	assert(!req.has("workflow_todo") && !req.has("workflow_plan_review"), "workflow tools removed from requested allowlist");
	assert(!req.has("workflow_plan_approve") && !req.has("workflow_grill_record"), "additional workflow tools removed from requested allowlist");
	assert(!req.has("workflow_review"), "workflow_review removed from requested allowlist (stripped from child reviewer)");
	assert(!req.has("workflow_code_review") && !req.has("workflow_plan_implementation_review"), "old review tool names absent from requested allowlist");
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
assert(!/implementationReview\??:/.test(typesTs), "WorkflowState no longer declares implementationReview PASS metadata");
assert(stateTs.includes("planReviewDecisions: normalizeGrillTurns(obj.planReviewDecisions)"), "planReviewDecisions normalized through shared helper");
assert(stateTs.includes("planStartEntryId:"), "planStartEntryId normalized");

{
	const ngFn = extractDecl(stateTs, "function normalizeGrillTurns(raw");
	const ntFn = extractDecl(stateTs, "function normalizeTodos(raw");
	const nsFn = extractDecl(stateTs, "export function normalizeState(raw");
	assert(ngFn.length > 0 && ntFn.length > 0 && nsFn.length > 0, "Part 5: normalizeGrillTurns + normalizeTodos + normalizeState extracted from state.ts");
	assert(!/function normalizeImplementationReview\(/.test(stateTs), "state.ts no longer defines normalizeImplementationReview");
	const mod = await loadTsModule(
		[
			"const DEFAULT_STATE = { workflowEnabled: false, workflowExplicitlyDisabled: false, mode: \"idle\", todos: [], grillTurns: [], planReviewDecisions: [] };",
			'import path from "node:path";',
			'function branchMatchesWorkRun(branch, workRunId) { return typeof branch === "string" && typeof workRunId === "string" && branch.includes(workRunId.slice(-8)); }',
			ngFn,
			ntFn,
			nsFn,
		].join("\n\n"),
	);

	const oldState = mod.normalizeState({ mode: "plan", planRunId: "abc", grillTurns: [] });
	assert(Array.isArray(oldState.planReviewDecisions) && oldState.planReviewDecisions.length === 0, "old state without planReviewDecisions normalizes to []");
	assert(oldState.planStartEntryId === undefined, "old state without planStartEntryId normalizes to undefined");
	// New additive fields: old state normalizes to undefined/absent.
	assert(oldState.approvedTodos === undefined, "old state without approvedTodos normalizes to undefined");
	assert(oldState.workStartEntryId === undefined, "old state without workStartEntryId normalizes to undefined");

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

	// Old implementationReview PASS metadata is dropped by whitelist normalization.
	assert(mod.normalizeState({ implementationReview: { workRunId: "run-1", workspaceFingerprint: "abc123" } }).implementationReview === undefined, "old implementationReview PASS metadata is dropped by normalizeState");
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

// ═══ Part 7: unified Review Agent pure functions ═══════════════════════════

console.log("\n=== Part 7: review-agent pure functions ===");

{
	const reviewTs = read("extensions/workflow/review-agent.ts");
	assert(reviewTs.includes("export async function runReviewAgent"), "review-agent.ts exports runReviewAgent");
	assert(reviewTs.includes("REVIEWER_SYSTEM_PROMPT"), "review-agent.ts defines its own system prompt");
	assert(reviewTs.includes("VERDICT_LINE_PREFIX"), "review-agent.ts exports VERDICT_LINE_PREFIX");
	assert(reviewTs.includes("runIndependentReviewer"), "review-agent.ts delegates to the shared runner");
	assert(reviewTs.includes("reviewCwd"), "review-agent.ts runs in the validated review cwd");
	assert(reviewTs.includes("primaryCwd"), "review-agent.ts passes primaryCwd for dual-root guard");
	assert(reviewTs.includes("madeRepoToolCall"), "review-agent.ts tracks whether the reviewer inspected the repo");
	assert(reviewTs.includes("REPO_TOOL_NAMES"), "review-agent.ts defines REPO_TOOL_NAMES for repo-inspection detection");
	assert(/REVIEW_VERDICT: PASS/.test(reviewTs), "review-agent.ts system prompt includes the PASS verdict example matching VERDICT_LINE_PREFIX");
	// OCR wiring: enabled branch runs OCR + parse; disabled branch skips.
	assert(reviewTs.includes("includeOcr"), "review-agent.ts takes an includeOcr flag");
	assert(/runOcrReview\(/.test(reviewTs), "review-agent.ts enabled branch calls runOcrReview");
	assert(/parseOcrReviewJson\(/.test(reviewTs), "review-agent.ts enabled branch parses via parseOcrReviewJson");
	assert(/buildReviewArgv\(/.test(reviewTs), "review-agent.ts builds a workspace OCR argv");
	assert(/checkOcrAvailable\(/.test(reviewTs), "review-agent.ts checks OCR CLI availability when enabled");
	// The old file is gone.
	assert(!fs.existsSync(path.join(root, "extensions/workflow/implementation-review-agent.ts")), "implementation-review-agent.ts removed");

	// ── verdict parser (pure fixture) ──
	const vpFn = extractDecl(reviewTs, "export function parseReviewVerdict(");
	assert(vpFn.length > 0, "Part 7: parseReviewVerdict extracted");
	const vpMod = await loadTsModule([
		'export const VERDICT_LINE_PREFIX = "REVIEW_VERDICT:";',
		vpFn,
	].join("\n\n"));

	const passText = "## Summary\nok\nREVIEW_VERDICT: PASS";
	assert(vpMod.parseReviewVerdict(passText).verdict === "PASS", "verdict parser: exact PASS line → PASS");
	const failText = "## Summary\nissues found\nREVIEW_VERDICT: FAIL";
	assert(vpMod.parseReviewVerdict(failText).verdict === "FAIL", "verdict parser: exact FAIL line → FAIL");
	const noVerdict = vpMod.parseReviewVerdict("## Summary\nno verdict here");
	assert(noVerdict.verdict === "FAIL" && noVerdict.reason, "verdict parser: missing verdict line → FAIL with reason");
	assert(vpMod.parseReviewVerdict("").verdict === "FAIL", "verdict parser: empty text → FAIL");
	const conflicting = vpMod.parseReviewVerdict("REVIEW_VERDICT: PASS\nREVIEW_VERDICT: FAIL");
	assert(conflicting.verdict === "FAIL", "verdict parser: conflicting verdict lines → FAIL");
	const multiPass = vpMod.parseReviewVerdict("REVIEW_VERDICT: PASS\nREVIEW_VERDICT: PASS");
	assert(multiPass.verdict === "PASS", "verdict parser: multiple agreeing PASS lines → PASS");
	const badValue = vpMod.parseReviewVerdict("REVIEW_VERDICT: MAYBE");
	assert(badValue.verdict === "FAIL", "verdict parser: unrecognized verdict value → FAIL");

	// ── OCR context + task builders (pure fixture) ──
	const approvedFn = extractDecl(reviewTs, "export function buildApprovedReviewTask(");
	const directFn = extractDecl(reviewTs, "export function buildDirectReviewTask(");
	const fmtFn = extractDecl(reviewTs, "export function formatTodosForReview(");
	const fmtFindingsFn = extractDecl(reviewTs, "export function formatOcrFindings(");
	const buildBgFn = extractDecl(reviewTs, "export function buildOcrBackground(");
	const extractGoalFn = extractDecl(reviewTs, "function extractPlanGoal(");
	const truncateFn = extractDecl(reviewTs, "function truncate(s");
	const renderOcrFn = extractDecl(reviewTs, "function renderOcrSection(");
	assert(approvedFn.length > 0 && directFn.length > 0 && fmtFn.length > 0 && fmtFindingsFn.length > 0 && buildBgFn.length > 0 && renderOcrFn.length > 0, "Part 7: task builders + formatTodosForReview + formatOcrFindings + buildOcrBackground + renderOcrSection extracted");

	const finding = {
		id: "abc123",
		severity: "critical",
		rule: "bug",
		file: "src/a.ts",
		line: 10,
		endLine: 10,
		message: "NPE risk",
		suggestion: "guard null",
	};

	// Approved task builder fixture — OCR enabled with findings.
	const approvedMod = await loadTsModule(fmtFn + "\n\n" + fmtFindingsFn + "\n\n" + renderOcrFn + "\n\n" + approvedFn);
	const approvedTaskOcr = approvedMod.buildApprovedReviewTask({
		requirements: ["build feature X"],
		planMarkdown: "# Final Plan\n## Goal\nDo X",
		approvedTodos: [{ id: "T1", title: "impl X", status: "pending" }],
		currentTodos: [{ id: "T1", title: "impl X", status: "done" }],
		ocr: { enabled: true, findings: [finding], counts: { critical: 1 }, rawPath: "/tmp/raw.json" },
	});
	assert(approvedTaskOcr.includes("Authoritative User Requirements"), "Approved task includes user requirements");
	assert(approvedTaskOcr.includes("Final Plan"), "Approved task includes Final Plan");
	assert(approvedTaskOcr.includes("Approved Todo Snapshot"), "Approved task includes approved todo snapshot");
	assert(approvedTaskOcr.includes("Current Todo List"), "Approved task includes current todos");
	assert(approvedTaskOcr.includes("OCR Workspace Findings"), "Approved task includes OCR findings section (enabled)");
	assert(approvedTaskOcr.includes("NPE risk"), "Approved task embeds the OCR finding message");
	assert(approvedTaskOcr.includes("Disposition EVERY OCR finding"), "Approved task requires per-finding disposition");
	assert(approvedTaskOcr.includes("false positive"), "Approved task requires false-positive evidence");
	// Isolation: no parent diff/summary/test claims.
	assert(!/Parent Execution Summary|Parent Diff|Test Results Claim|passed tests:/i.test(approvedTaskOcr), "Approved task excludes parent execution summary / diff output / test claims");

	// Approved task builder fixture — OCR disabled.
	const approvedTaskNoOcr = approvedMod.buildApprovedReviewTask({
		requirements: ["build feature X"],
		planMarkdown: "# Final Plan\n## Goal\nDo X",
		approvedTodos: [{ id: "T1", title: "impl X", status: "pending" }],
		currentTodos: [{ id: "T1", title: "impl X", status: "done" }],
		ocr: { enabled: false, findings: [], counts: {}, skippedReason: "codeReview.enabled is false" },
	});
	assert(approvedTaskNoOcr.includes("OCR is disabled"), "Approved task records OCR disabled/skipped status");
	assert(!approvedTaskNoOcr.includes("Disposition EVERY OCR finding"), "Approved task omits disposition block when OCR disabled");
	// Snapshot gap flag when approvedTodos missing.
	const gapTask = approvedMod.buildApprovedReviewTask({
		requirements: ["r"],
		planMarkdown: "# Plan",
		approvedTodos: undefined,
		currentTodos: [{ id: "T1", title: "t", status: "done" }],
		ocr: { enabled: false, findings: [], counts: {} },
	});
	assert(gapTask.includes("Approved todo snapshot is MISSING"), "Approved task flags missing snapshot gap");

	// Direct task builder fixture — OCR enabled.
	const directMod = await loadTsModule(fmtFn + "\n\n" + fmtFindingsFn + "\n\n" + renderOcrFn + "\n\n" + directFn);
	const directTaskOcr = directMod.buildDirectReviewTask({
		requirements: ["fix bug Y"],
		currentTodos: [{ id: "T1", title: "fix Y", status: "done" }],
		ocr: { enabled: true, findings: [finding], counts: { critical: 1 }, rawPath: "/tmp/raw.json" },
	});
	assert(directTaskOcr.includes("Authoritative User Requirements (this Work lifecycle)"), "Direct task includes Work-lifecycle requirements");
	assert(directTaskOcr.includes("Current Todo List"), "Direct task includes current todos");
	assert(!directTaskOcr.includes("Final Plan"), "Direct task does NOT include a Final Plan");
	assert(!directTaskOcr.includes("Approved Todo Snapshot"), "Direct task does NOT include approved todo snapshot");
	assert(directTaskOcr.includes("Disposition EVERY OCR finding"), "Direct task requires per-finding disposition when OCR enabled");

	// buildOcrBackground determinism.
	const bgMod = await loadTsModule(extractGoalFn + "\n\n" + truncateFn + "\n\n" + buildBgFn);
	const bg1 = bgMod.buildOcrBackground({ requirements: ["r1"], planMarkdown: "# Final Plan\n## Goal\nShip X", todos: [{ id: "T1", title: "t", status: "done" }] });
	const bg2 = bgMod.buildOcrBackground({ requirements: ["r1"], planMarkdown: "# Final Plan\n## Goal\nShip X", todos: [{ id: "T1", title: "t", status: "done" }] });
	assert(bg1 === bg2, "buildOcrBackground is deterministic for identical inputs");
	assert(bg1.includes("r1") && bg1.includes("Ship X") && bg1.includes("T1"), "buildOcrBackground embeds requirements, plan goal, and todos");
}

// ═══ Part 8: unified review runner wiring (no fingerprint) ═════════════════

console.log("\n=== Part 8: unified review runner wiring ===");

{
	// The workspace fingerprint helpers are gone (no commit gate / no PASS).
	const wtTs = read("extensions/workflow/worktree.ts");
	assert(!/export function computeWorkspaceFingerprint/.test(wtTs), "worktree.ts no longer exports computeWorkspaceFingerprint");
	assert(!/export function workspaceFingerprintMatches/.test(wtTs), "worktree.ts no longer exports workspaceFingerprintMatches");
	assert(!/NUL_SEP|MAX_UNTRACKED_FILE_SIZE|parseNulDelimited/.test(wtTs), "worktree.ts fingerprint internals removed");

	const reviewTs = read("extensions/workflow/review-agent.ts");
	assert(/includeOcr[\s\S]*?runOcrReview\(/.test(reviewTs), "review-agent.ts: OCR runs inside the includeOcr=true branch");
	assert(/parseOcrReviewJson\(rawOutput\)/.test(reviewTs), "review-agent.ts: OCR output parsed into normalized findings");
	assert(/ocrContext = \{[\s\S]*?enabled: true/.test(reviewTs), "review-agent.ts: enabled branch builds an enabled ocrContext");
	assert(/skippedReason: "codeReview\.enabled is false"/.test(reviewTs), "review-agent.ts: disabled branch records the skip reason");
	assert(/OcrContext/.test(reviewTs), "review-agent.ts declares an OcrContext type passed to task builders");
	// Findings flow into the task builder via ocrContext.
	assert(/buildApprovedReviewTask\([\s\S]*?ocr: ocrContext/.test(reviewTs), "review-agent.ts passes ocrContext into buildApprovedReviewTask");
	assert(/buildDirectReviewTask\([\s\S]*?ocr: ocrContext/.test(reviewTs), "review-agent.ts passes ocrContext into buildDirectReviewTask");
	// Delegates to the shared runner with the review cwd + dual-root safety.
	assert(/runIndependentReviewer\(\{[\s\S]*?reviewCwd,/.test(reviewTs), "review-agent.ts delegates to runIndependentReviewer with reviewCwd");
	assert(/safetyRoots[\s\S]*?\{ primaryCwd, reviewCwd \}/.test(reviewTs), "review-agent.ts builds dual-root safetyRoots");

	// OCR errors surface as explicit errors (no verdict produced).
	assert(/ocr CLI not found/.test(reviewTs), "review-agent.ts: missing OCR CLI throws an explicit error");
	assert(/ocr review failed/.test(reviewTs), "review-agent.ts: OCR exec failure throws an explicit error");
	assert(/could not be processed/.test(reviewTs), "review-agent.ts: OCR parse failure throws an explicit error (carries rawPath)");
}

// ═══ Part 9: no commit gate + no agent_end PASS + approve snapshot ═════════

console.log("\n=== Part 9: no commit gate + no agent_end PASS + approve snapshot ===");

{
	const commandsSrc = read("extensions/workflow/commands.ts");
	const toolsSrc = read("extensions/workflow/tools.ts");

	// /commit has NO review/implementation gate — it switches Commit Mode directly.
	const commitStart = commandsSrc.indexOf("export function registerCommitCommand");
	const commitEnd = commandsSrc.indexOf("export function registerWfStatusCommand", commitStart);
	const commitBlock = commandsSrc.slice(commitStart, commitEnd > 0 ? commitEnd : commandsSrc.length);
	assert(!/implementationReview/.test(commitBlock), "/commit no longer references implementationReview PASS");
	assert(!/computeWorkspaceFingerprint/.test(commitBlock), "/commit no longer computes a workspace fingerprint");
	assert(!/workspaceFingerprint/.test(commitBlock), "/commit no longer compares a fingerprint");
	assert(commitBlock.includes("transitionWorkflowMode"), "/commit switches Commit Mode directly via transitionWorkflowMode");

	// agent_end has no fingerprint/PASS check.
	const agentEndStart = commandsSrc.indexOf("export function registerAgentEnd");
	const agentEndEnd = commandsSrc.indexOf("export function registerWfCommand", agentEndStart);
	const agentEndBlock = commandsSrc.slice(agentEndStart, agentEndEnd > 0 ? agentEndEnd : commandsSrc.length);
	assert(!/implementationReview/.test(agentEndBlock), "agent_end no longer references implementationReview PASS");
	assert(!/computeWorkspaceFingerprint/.test(agentEndBlock), "agent_end no longer computes a fingerprint");

	// approve no longer clears a PASS; it still deep-copies approvedTodos.
	const approveStart = toolsSrc.indexOf("export function registerPlanApproveTool");
	const approveEnd = toolsSrc.indexOf("export function registerPlanClearTool", approveStart);
	const approveBlock = toolsSrc.slice(approveStart, approveEnd);
	assert(approveBlock.includes("empty todo list"), "approve rejects empty todo list");
	assert(approveBlock.includes("approvedTodos: state.todos.map"), "approve deep-copies todos into approvedTodos snapshot");
	assert(!/implementationReview: undefined/.test(approveBlock), "approve no longer clears implementationReview PASS");

	// /work no longer clears a PASS.
	const workStart = commandsSrc.indexOf("export function registerWorkCommand");
	const workEnd = commandsSrc.indexOf("export function registerReviewCommand", workStart);
	const workBlock = commandsSrc.slice(workStart, workEnd > 0 ? workEnd : commandsSrc.length);
	assert(workBlock.includes("workStartEntryId"), "/work captures workStartEntryId for Direct Work requirement scoping");
	assert(workBlock.includes("approvedTodos: undefined"), "/work clears approved todos for Direct Work");
	assert(!/implementationReview: undefined/.test(workBlock), "/work no longer clears implementationReview PASS");

	// Todo mutations no longer delete a PASS (both surfaces).
	const todoToolStart = toolsSrc.indexOf("export function registerTodoTool");
	const todoToolEnd = toolsSrc.indexOf("export function registerUpdatePlanTool", todoToolStart);
	const todoToolBlock = toolsSrc.slice(todoToolStart, todoToolEnd);
	assert(!/delete state\.implementationReview/.test(todoToolBlock), "workflow_todo no longer deletes implementationReview PASS");
	const upStart = toolsSrc.indexOf("export function registerUpdatePlanTool");
	const upEnd = toolsSrc.indexOf("// ── workflow plan tools", upStart);
	const upBlock = toolsSrc.slice(upStart, upEnd > 0 ? upEnd : toolsSrc.length);
	assert(!/delete state\.implementationReview/.test(upBlock), "update_plan no longer deletes implementationReview PASS");

	// No stale identifiers anywhere in source.
	for (const file of [
		"extensions/workflow/tools.ts",
		"extensions/workflow/commands.ts",
		"extensions/workflow/mode.ts",
		"extensions/workflow/prompts.ts",
		"extensions/workflow/settings.ts",
		"extensions/workflow/index.ts",
		"extensions/workflow/helpers.ts",
		"extensions/workflow/state.ts",
		"extensions/workflow/worktree.ts",
		"extensions/workflow/review-agent.ts",
	]) {
		const src = read(file);
		assert(!/workflow_plan_implementation_review|workflow_code_review/.test(src), `${file} has no old tool identifiers`);
		assert(!/computeWorkspaceFingerprint|workspaceFingerprintMatches/.test(src), `${file} has no fingerprint helper references`);
		assert(!/ocrScopeSummary|compactPreviewText/.test(src), `${file} has no scope-summary / preview formatter`);
		assert(!/review-tui/.test(src), `${file} has no review-tui import`);
	}
}

// ═══ Part 10: review config role + enabled flag ════════════════════════════

console.log("\n=== Part 10: review config role + enabled flag ===");

{
	const typesTs = read("extensions/workflow/types.ts");
	const defaultsTs = read("extensions/workflow/defaults.ts");
	const configTs = read("extensions/workflow/config.ts");
	const settingsTs = read("extensions/workflow/settings.ts");
	const modeTs = read("extensions/workflow/mode.ts");
	const toolsTs = read("extensions/workflow/tools.ts");
	const exampleJson = read("config.json.example");

	// Role union includes review (not implementationReview).
	assert(/"review"/.test(typesTs), "types.ts: Role union includes review");
	assert(!/"implementationReview"/.test(typesTs), "types.ts: Role union no longer includes implementationReview");
	// WorkflowConfig has a review section (and the override).
	assert(typesTs.includes("review: {"), "types.ts: WorkflowConfig declares review section");
	assert(typesTs.includes("review?: Partial<"), "types.ts: WorkflowConfigOverride declares review override");
	assert(!/implementationReview\??:/.test(typesTs), "types.ts: no implementationReview config/state fields remain");

	// defaults: model + enabled default true.
	assert(defaultsTs.includes("review:"), "defaults.ts: DEFAULT_CONFIG includes review");
	assert(/review:[\s\S]*?enabled: true/.test(defaultsTs), "defaults.ts: review.enabled defaults to true");
	assert(/review:[\s\S]*?provider:[\s\S]*?model:[\s\S]*?thinking/.test(defaultsTs), "defaults.ts: review has a model spec");

	// config.json.example mirrors the closed set.
	assert(exampleJson.includes('"review"'), "config.json.example includes review");
	assert(!/"implementationReview"/.test(exampleJson), "config.json.example no longer includes implementationReview");

	// config.ts: VALID_ROLES + normalize + leafPaths.
	assert(configTs.includes('"review"'), "config.ts: VALID_ROLES includes review");
	assert(!/"implementationReview"/.test(configTs), "config.ts: VALID_ROLES no longer includes implementationReview");
	assert(/review && typeof cfg\.review === "object"/.test(configTs), "config.ts: normalizeConfig strips unknown review fields");
	assert(configTs.includes('"review.enabled"'), "config.ts: leafPaths includes review.enabled");
	assert(/"planReview", "review", "work"/.test(configTs), "config.ts: leafPaths models list includes review");

	// settings.ts: ROLES + RELOAD_SENSITIVE_IDS + descriptors.
	assert(settingsTs.includes('"review"'), "settings.ts: ROLES includes review");
	assert(!/"implementationReview"/.test(settingsTs), "settings.ts: ROLES no longer includes implementationReview");
	assert(settingsTs.includes('"review.enabled"'), "settings.ts: RELOAD_SENSITIVE_IDS + descriptor include review.enabled");
	assert(!settingsTs.includes('"implementationReview.enabled"'), "settings.ts: no stale implementationReview.enabled descriptor");
	// codeReview.enabled is a non-reload-sensitive OCR toggle.
	assert(/codeReview\.enabled[\s\S]*?editable live|codeReview\.enabled is intentionally excluded/.test(settingsTs) || !settingsTs.includes('"codeReview.enabled"'), "settings.ts: codeReview.enabled is not reload-sensitive");

	// mode.ts: workflow_review is conditional on review.enabled.
	const workArrayMatch = modeTs.match(/const WORK_WORKFLOW_TOOL_NAMES = (\[[\s\S]*?\]);/);
	assert(workArrayMatch !== null, "Part 10: WORK_WORKFLOW_TOOL_NAMES array found");
	assert(workArrayMatch !== null && !/workflow_review/.test(workArrayMatch[1]), "mode.ts: WORK_WORKFLOW_TOOL_NAMES array does not include workflow_review (now conditional)");
	assert(/config\.review\.enabled[\s\S]*?names\.push\("workflow_review"\)/.test(modeTs), "mode.ts: work branch conditionally pushes workflow_review on review.enabled");
	assert(!/config\.implementationReview\.enabled/.test(modeTs), "mode.ts: no implementationReview.enabled reference");

	// tools.ts: unified review handler uses models.review + codeReview.enabled.
	const reviewToolStart = toolsTs.indexOf("export function registerReviewTool");
	const reviewToolEnd = toolsTs.indexOf("// ── Bulk registration", reviewToolStart);
	const reviewToolBlock = toolsTs.slice(reviewToolStart, reviewToolEnd);
	assert(reviewToolBlock.includes("config.models.review"), "tools.ts: unified review handler uses config.models.review");
	assert(reviewToolBlock.includes("config.codeReview.enabled"), "tools.ts: unified review handler passes config.codeReview.enabled as includeOcr");
	assert(!/modelSpec: config\.models\.implementationReview/.test(reviewToolBlock), "tools.ts: review handler does NOT reference models.implementationReview");
}

// ═══ Result ════════════════════════════════════════════════════════════════

console.log(`\n=== Result: ${runs - failures}/${runs} checks passed ===`);
if (failures > 0) {
	console.error(`${failures} test(s) FAILED.`);
	process.exit(1);
}
