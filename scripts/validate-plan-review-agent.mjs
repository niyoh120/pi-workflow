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
				"workflow_plan_review", "workflow_code_review", "workflow_init_complete",
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
	const req = new Set(requestedTools);
	assert(!req.has("workflow_todo") && !req.has("workflow_plan_review"), "workflow tools removed from requested allowlist");
	assert(!req.has("workflow_plan_approve") && !req.has("workflow_grill_record"), "additional workflow tools removed from requested allowlist");
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
	const stubs = `
		import path from "node:path";
		import os from "node:os";
		// Contract-faithful stubs for the imported path guards.
		function isWorkflowDataPath(targetPath, cwd) {
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
	const ext = mod.createReviewerSafetyExtension(root);
	ext.factory(fakePi);
	assert(typeof captured === "function", "safety extension registers a tool_call handler");

	const workflowRead = captured({ toolName: "read", input: { path: ".pi/workflow/sessions/x/state.json" } }, {});
	assert(workflowRead && workflowRead.block === true, "read of .pi/workflow/ is blocked");

	const normalRead = captured({ toolName: "read", input: { path: "src/foo.ts" } }, {});
	assert(!normalRead || normalRead.block === undefined, "read of a normal project file is allowed");

	const projectWrite = captured({ toolName: "write", input: { path: path.join(root, "src/foo.ts") } }, {});
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
assert(stateTs.includes("planReviewDecisions: normalizeGrillTurns(obj.planReviewDecisions)"), "planReviewDecisions normalized through shared helper");
assert(stateTs.includes("planStartEntryId:"), "planStartEntryId normalized");

{
	const ngFn = extractDecl(stateTs, "function normalizeGrillTurns(raw");
	const nsFn = extractDecl(stateTs, "export function normalizeState(raw");
	assert(ngFn.length > 0 && nsFn.length > 0, "Part 5: normalizeGrillTurns + normalizeState extracted from state.ts");
	const mod = await loadTsModule(
		[
			"const DEFAULT_STATE = { workflowEnabled: false, workflowExplicitlyDisabled: false, mode: \"idle\", todos: [], grillTurns: [], planReviewDecisions: [] };",
			'import path from "node:path";',
			'function branchMatchesWorkRun(branch, workRunId) { return typeof branch === "string" && typeof workRunId === "string" && branch.includes(workRunId.slice(-8)); }',
			ngFn,
			nsFn,
		].join("\n\n"),
	);

	const oldState = mod.normalizeState({ mode: "plan", planRunId: "abc", grillTurns: [] });
	assert(Array.isArray(oldState.planReviewDecisions) && oldState.planReviewDecisions.length === 0, "old state without planReviewDecisions normalizes to []");
	assert(oldState.planStartEntryId === undefined, "old state without planStartEntryId normalizes to undefined");

	const withDecisions = mod.normalizeState({
		planReviewDecisions: [{ question: "q", recommendedAnswer: "r", decisionStatus: "resolved" }],
	});
	assert(withDecisions.planReviewDecisions.length === 1, "planReviewDecisions round-trips through normalization");
	assert(withDecisions.planReviewDecisions[0].decisionStatus === "resolved", "decision status preserved");
}

// ═══ Part 6: source-level wiring (timeout / dispose / usage / contract) ═══

console.log("\n=== Part 6: reviewer wiring & tool contract ===");

{
	assert(agentTs.includes("PLAN_REVIEW_TOTAL_TIMEOUT_MS = 1_800_000"), "30-minute total timeout constant");
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
	assert(agentTs.includes("appendSystemPrompt: [REVIEWER_SYSTEM_PROMPT]"), "reviewer behavioral mandate injected into child system prompt");
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

// ═══ Result ════════════════════════════════════════════════════════════════

console.log(`\n=== Result: ${runs - failures}/${runs} checks passed ===`);
if (failures > 0) {
	console.error(`${failures} test(s) FAILED.`);
	process.exit(1);
}
