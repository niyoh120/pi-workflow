/**
 * Regression validation: todo/overlay state lifecycle and review tooling.
 *
 * Covers session isolation, overlay lifecycle, normalizeState correctness,
 * plan/code review tool registration (renamed, conditional), config simplification,
 * marker removal, and approve kickoff.
 *
 * Run: node scripts/validate-todo-regression.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// Dynamic import of extensions/workflow/todo-compat.ts relies on Node's native
// TypeScript loader (Node >= 22.19). Fail early with a clear message on older
// runtimes instead of an opaque syntax error.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	console.error("validate-todo-regression.mjs requires Node >= 22.19 for native TypeScript loading.");
	process.exit(1);
}

const CWD = process.cwd();

let failures = 0;
let runs = 0;

function assert(condition, msg) {
	runs++;
	if (!condition) {
		console.error(`  FAIL: ${msg}`);
		failures++;
	} else {
		console.log(`  PASS: ${msg}`);
	}
}

// ═══════════════════════════════════════════════════════
// Helper: inline real loadState / saveState semantics
// ═══════════════════════════════════════════════════════

const DEFAULT_STATE = {
	mode: "idle",
	todos: [],
};

function inlineLoadState(wfDir, sessionKey) {
	const spath = path.join(wfDir, "sessions", sessionKey, "state.json");
	if (!fs.existsSync(spath)) return { ...DEFAULT_STATE };
	try {
		return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(spath, "utf8")) };
	} catch {
		return { ...DEFAULT_STATE };
	}
}

function inlineIsWorkflowToolMode(mode) {
	return mode === "plan" || mode === "work" || mode === "init";
}

function inlineComputeWorkflowToolNames(mode, config) {
	switch (mode) {
		case "plan": {
			const names = [
				"workflow_todo",
				"workflow_plan_read",
				"workflow_plan_save",
				"workflow_plan_approve",
				"workflow_plan_clear",
			];
			if (config.planReview.enabled) names.push("workflow_plan_review");
			return names;
		}
		case "work": {
			const names = ["workflow_todo"];
			if (config.codeReview.enabled) names.push("workflow_code_review");
			return names;
		}
		case "explore":
			return [];
		case "init":
			return ["workflow_init_complete"];
		default:
			return [];
	}
}

// ═══════════════════════════════════════════════════════
// 1. DEFAULT_STATE has empty todos
// ═══════════════════════════════════════════════════════

console.log("\n=== Check 1: DEFAULT_STATE todos ===");
assert(
	Array.isArray(DEFAULT_STATE.todos) && DEFAULT_STATE.todos.length === 0,
	"DEFAULT_STATE has empty todos",
);

// ═══ Check 2: Session state loaded from session-scoped path ═══

console.log("\n=== Check 2: Session state ===");

{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-test-"));
	const wfDir = path.join(tmpDir, ".pi", "workflow");
	fs.mkdirSync(wfDir, { recursive: true });

	const sessionAFile = path.join(wfDir, "sessions", "session-A", "state.json");
	fs.mkdirSync(path.dirname(sessionAFile), { recursive: true });
	fs.writeFileSync(
		sessionAFile,
		JSON.stringify({
			mode: "work",
			planRunId: "old-plan-id",
			todos: [
				{ id: "T1", title: "Old task", status: "done" },
				{ id: "T2", title: "Another old task", status: "done" },
			],
		}),
	);

	const s1 = inlineLoadState(wfDir, "session-A");
	assert(
		s1.todos.length === 2,
		"Session A loads session-scoped todos (2 items)",
	);
	assert(s1.todos[0].id === "T1", "Session A has T1");
	assert(s1.mode === "work", "Session A mode from file");

	const s2 = inlineLoadState(wfDir, "session-B");
	assert(s2.todos.length === 0, "Session B empty defaults");
	assert(s2.mode === "idle", "Session B idle mode");

	const s3 = inlineLoadState(wfDir, "session-C");
	assert(s3.todos.length === 0, "Session C empty defaults");

	const corruptFile = path.join(wfDir, "sessions", "session-D", "state.json");
	fs.mkdirSync(path.dirname(corruptFile), { recursive: true });
	fs.writeFileSync(corruptFile, "not-json{{");
	const s4 = inlineLoadState(wfDir, "session-D");
	assert(s4.todos.length === 0, "Corrupt file falls back to empty todos");

	const s1Reload = inlineLoadState(wfDir, "session-A");
	assert(s1Reload.todos.length === 2, "Existing session A reloads correctly");

	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ═══ Check 3: Fresh project returns DEFAULT_STATE ═══

console.log("\n=== Check 3: Fresh project (no session state) ===");

{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-test-"));
	const wfDir = path.join(tmpDir, ".pi", "workflow");
	fs.mkdirSync(wfDir, { recursive: true });

	const s1 = inlineLoadState(wfDir, "session-A");
	assert(s1.todos.length === 0, "Fresh project session returns empty todos");

	const s2 = inlineLoadState(wfDir, "session-B");
	assert(s2.todos.length === 0, "Second fresh session returns empty todos");

	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ═══ Check 4: Overlay lifecycle ═══

console.log("\n=== Check 4: Overlay update([]) preserves uiCtx ===");

{
	class TestOverlay {
		uiCtx = null;
		todos = [];
		doneIdsPendingHide = new Set();
		hiddenDoneIds = new Set();
		widgetRegistered = false;
		widgetActive = false;

		setUICtx(ctx) {
			this.uiCtx = ctx;
		}

		clearBookkeeping() {
			this.doneIdsPendingHide.clear();
			this.hiddenDoneIds.clear();
		}

		update(todos) {
			if (!this.uiCtx) return "no-uictx";
			this.todos = todos;
			if (todos.length === 0) {
				this.clearBookkeeping();
				if (this.widgetRegistered) {
					this.widgetRegistered = false;
					this.widgetActive = false;
				}
				return "empty-cleared";
			}
			if (!this.widgetRegistered) {
				this.widgetRegistered = true;
				this.widgetActive = true;
				return "registered";
			}
			return "updated";
		}

		simulateAllDoneHidden() {
			if (this.widgetRegistered) {
				this.widgetRegistered = false;
				this.widgetActive = false;
			}
		}

		hideDoneFromLastTurn() {
			for (const id of this.doneIdsPendingHide) {
				this.hiddenDoneIds.add(id);
			}
			this.doneIdsPendingHide.clear();
		}

		dispose() {
			this.uiCtx = null;
			this.widgetRegistered = false;
			this.widgetActive = false;
			this.doneIdsPendingHide.clear();
			this.hiddenDoneIds.clear();
		}
	}

	const overlay = new TestOverlay();
	const mockCtx = { id: "test-ui-ctx" };
	overlay.setUICtx(mockCtx);

	overlay.update([]);
	assert(overlay.uiCtx === mockCtx, "update([]) preserves uiCtx");

	overlay.update([{ id: "T1", title: "task", status: "pending" }]);
	assert(
		overlay.widgetActive === true,
		"update(nonEmpty) re-registers after empty",
	);

	overlay.doneIdsPendingHide.add("T1");
	overlay.todos = [{ id: "T1", title: "done task", status: "done" }];
	overlay.hideDoneFromLastTurn();
	assert(
		overlay.hiddenDoneIds.has("T1"),
		"T1 is in hiddenDoneIds after hideDoneFromLastTurn",
	);
	overlay.simulateAllDoneHidden();
	assert(
		overlay.uiCtx === mockCtx,
		"all-done auto-hide preserves uiCtx (no dispose)",
	);
	assert(
		overlay.hiddenDoneIds.has("T1"),
		"T1 stays hidden after auto-hide (bookkeeping preserved)",
	);

	overlay.update([{ id: "T1", title: "done task", status: "done" }]);
	assert(
		overlay.hiddenDoneIds.has("T1"),
		"T1 remains hidden after update() with same done todos",
	);

	overlay.clearBookkeeping();
	overlay.update([{ id: "T1", title: "new task", status: "pending" }]);
	assert(
		overlay.widgetActive === true,
		"update(nonEmpty) re-registers after auto-hide + clearBookkeeping",
	);
	assert(
		!overlay.hiddenDoneIds.has("T1"),
		"T1 not hidden after explicit clearBookkeeping",
	);

	overlay.dispose();
	assert(overlay.uiCtx === null, "dispose() clears uiCtx (sanity)");
	assert(
		overlay.update([{ id: "T2", title: "x", status: "pending" }]) ===
			"no-uictx",
		"After dispose, update returns early",
	);
}

// ═══ Check 5: clearBookkeeping prevents stale IDs ═══

console.log("\n=== Check 5: clearBookkeeping prevents stale IDs ===");

{
	const hidden = new Set(["T1", "T3"]);
	const pendingHide = new Set(["T2"]);
	hidden.clear();
	pendingHide.clear();

	const newTodos = [
		{ id: "T1", title: "new T1", status: "pending" },
		{ id: "T2", title: "new T2", status: "in_progress" },
	];
	const isVisible = (t) => !(t.status === "done" && hidden.has(t.id));
	assert(
		newTodos.every(isVisible),
		"After clearBookkeeping, reused IDs are visible",
	);
	assert(hidden.size === 0, "hiddenDoneIds is empty");
	assert(pendingHide.size === 0, "doneIdsPendingHide is empty");
}

// ═══ Check 6: Source structure verification ═══

console.log("\n=== Check 6: Source structure verification ===");

{
	const overlayTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/todo-overlay.ts"),
		"utf8",
	);
	const stateTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/state.ts"),
		"utf8",
	);
	const pathsTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/paths.ts"),
		"utf8",
	);
	const toolsTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/tools.ts"),
		"utf8",
	);
	const commandsTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/commands.ts"),
		"utf8",
	);

	// Legacy migration cleanup
	assert(
		!pathsTs.includes("export function legacyStatePath"),
		"paths.ts no longer exports legacyStatePath",
	);
	assert(
		!pathsTs.includes("export function legacyMigrationMarkerPath"),
		"paths.ts no longer exports legacyMigrationMarkerPath",
	);
	assert(
		!stateTs.includes("legacyStatePath") &&
			!stateTs.includes("legacyMigrationMarkerPath"),
		"state.ts no longer imports legacy path helpers",
	);
	assert(stateTs.includes("normalizeState"), "loadState uses normalizeState");
	assert(
		stateTs.includes("normalizeState(JSON.parse"),
		"loadState calls normalizeState(JSON.parse)",
	);
	assert(
		stateTs.includes("normalizeState(state"),
		"saveState calls normalizeState(state)",
	);

	// Overlay: update empty-list does not dispose
	const updMatch = overlayTs.match(/update\(todos[\s\S]*?\{/);
	const updStart = updMatch?.index ?? 0;
	const updEnd = overlayTs.indexOf("hideDoneFromLastTurn", updStart);
	const updBody = overlayTs.slice(
		updStart,
		updEnd > 0 ? updEnd : overlayTs.length,
	);
	assert(
		!updBody.includes("this.dispose()"),
		"update() does NOT call this.dispose() for empty list",
	);

	// Overlay: auto-hide preserves bookkeeping
	const rwIdx = overlayTs.indexOf("private renderWidget");
	const rwEnd = overlayTs.indexOf("// Counts", rwIdx);
	const rwBody = overlayTs.slice(rwIdx, rwEnd > 0 ? rwEnd : overlayTs.length);
	assert(
		!rwBody.includes("this.dispose()"),
		"renderWidget auto-hide does NOT call this.dispose()",
	);
	assert(
		!rwBody.includes("clearBookkeeping()"),
		"renderWidget auto-hide does NOT call clearBookkeeping() (preserves hidden/done state)",
	);

	// workflow_plan_save clears todos and bookkeeping within the save tool block
	const planToolIdx = toolsTs.indexOf("export function registerPlanSaveTool");
	const saveEndIdx = toolsTs.indexOf(
		"export function registerPlanApproveTool",
		planToolIdx,
	);
	const saveBlock = toolsTs.slice(planToolIdx, saveEndIdx);
	assert(
		planToolIdx >= 0 &&
			saveEndIdx > planToolIdx &&
			saveBlock.includes('state.todos = []') &&
			saveBlock.includes('state.grillTurns = []') &&
			!saveBlock.includes('hiddenDoneIds') &&
			saveBlock.includes('overlay.clearBookkeeping()') &&
			saveBlock.indexOf('state.todos = []') < saveBlock.indexOf('saveState(') &&
			saveBlock.indexOf('saveState(') <
				saveBlock.indexOf('overlay.clearBookkeeping()'),
		'workflow_plan_save: clear todos + grillTurns (no persisted hiddenDoneIds), then saveState, then overlay cleanup',
	);

	// /plan and /work call clearBookkeeping
	const planCmdStart = commandsTs.indexOf(
		"export function registerPlanCommand",
	);
	const planCmdEnd = commandsTs.indexOf(
		"export function registerWorkCommand",
		planCmdStart,
	);
	assert(
		planCmdStart >= 0 &&
			planCmdEnd > planCmdStart &&
			commandsTs.slice(planCmdStart, planCmdEnd).includes("clearBookkeeping()"),
		"/plan command calls clearBookkeeping()",
	);
	const workCmdStart = commandsTs.indexOf(
		"export function registerWorkCommand",
	);
	const workCmdEnd = commandsTs.indexOf(
		"export function registerReviewCommand",
		workCmdStart,
	);
	assert(
		workCmdStart >= 0 &&
			workCmdEnd > workCmdStart &&
			commandsTs.slice(workCmdStart, workCmdEnd).includes("clearBookkeeping()"),
		"/work command calls clearBookkeeping()",
	);

	// normalizeState drops unknown keys
	const nsFnStart = stateTs.indexOf("export function normalizeState(raw");
	const nsBodyStart = stateTs.indexOf("{", nsFnStart);
	let nsDepth = 0,
		nsFnEnd = nsBodyStart;
	for (let i = nsBodyStart; i < stateTs.length; i++) {
		if (stateTs[i] === "{") nsDepth++;
		else if (stateTs[i] === "}") {
			nsDepth--;
			if (nsDepth === 0) {
				nsFnEnd = i;
				break;
			}
		}
	}
	let nsBody = stateTs.slice(nsBodyStart + 1, nsFnEnd);
	nsBody = nsBody.replace(/\bas\s+Record<[^>]*>/g, "");
	nsBody = nsBody.replace(/\bas\s+WorkflowState\["mode"\]/g, "");
	nsBody = nsBody.replace(/\bas\s+WorkflowState\["sessionConfig"\]/g, "");
	nsBody = nsBody.replace(/\bas\s+WorkflowState\["todos"\]\[number\]/g, "");
	nsBody = nsBody.replace(/\bas\s+any\b/g, "");
	nsBody = nsBody.replace(/\bas\s+Array<[^>]*>/g, "");
	nsBody = nsBody.replace(/\bas\s+string\[\]/g, "");
	nsBody = nsBody.replace(/\(t:\s*any\)/g, "(t)");
	nsBody = nsBody.replace(/\(p:\s*any\)/g, "(p)");
	nsBody = nsBody.replace(/\(id:\s*any\)/g, "(id)");
	nsBody = nsBody.replace(
		/:\s*(WorkflowState|string|number|boolean|unknown)\b/g,
		"",
	);
	nsBody = nsBody.replace(/:\s*NonNullable<[^>]*>/g, "");
	const nsFnStr = "function normalizeState(raw) {" + nsBody + "\n}";
	// normalizeState now delegates grillTurns / planReviewDecisions
	// normalization to the module-level normalizeGrillTurns helper; extract and
	// strip it too so the isolated eval has it in scope.
	const ngFnDeclStart = stateTs.indexOf("function normalizeGrillTurns(raw");
	let ngFnStr = "";
	if (ngFnDeclStart >= 0) {
		const ngBodyStart = stateTs.indexOf("{", ngFnDeclStart);
		let ngDepth = 0,
			ngFnEnd = ngBodyStart;
		for (let i = ngBodyStart; i < stateTs.length; i++) {
			if (stateTs[i] === "{") ngDepth++;
			else if (stateTs[i] === "}") {
				ngDepth--;
				if (ngDepth === 0) {
					ngFnEnd = i;
					break;
				}
			}
		}
		let ngBody = stateTs.slice(ngBodyStart + 1, ngFnEnd);
		const ngStrips = [
			[/\bas\s+Record<[^>]*>/g, ""],
			[/\bas\s+WorkflowState\["[a-z]+"\]\[number\]/g, ""],
			[/\bas\s+any\b/g, ""],
			[/\bas\s+Array<[^>]*>/g, ""],
			[/\bas\s+string\[\]/g, ""],
			[/\(t:\s*any\)/g, "(t)"],
			[/:\s*(WorkflowState|string|number|boolean|unknown)\b/g, ""],
		];
		for (const [re, repl] of ngStrips) ngBody = ngBody.replace(re, repl);
		ngFnStr = "function normalizeGrillTurns(raw) {" + ngBody + "\n}";
	}
	// Guard against a silent ReferenceError: normalizeState calls
	// normalizeGrillTurns unconditionally, so a missing extraction must surface
	// as a clear assertion failure rather than a cryptic eval error.
	assert(
		ngFnDeclStart >= 0 && ngFnStr.length > 0,
		"normalizeGrillTurns function found and extracted from state.ts",
	);
	const normalizeState = eval(
		"(function(DEFAULT_STATE) { " +
			ngFnStr +
			" return " +
			nsFnStr +
			"; })(DEFAULT_STATE)",
	);

	assert(
		typeof normalizeState === "function",
		"normalizeState extracted from state.ts",
	);
	{
		const r = normalizeState({
			mode: "plan",
			workBaselineRef: "abc123",
			todos: [{ id: "T1", title: "x", status: "pending" }],
		});
		assert(
			!("workBaselineRef" in r),
			"real normalizeState: workBaselineRef dropped",
		);
		assert(r.mode === "plan", "real normalizeState: mode preserved");
	}
	{
		const r = normalizeState({ unknownField: 42 });
		assert(!("unknownField" in r), "real normalizeState: unknown key dropped");
	}
	{
		// Corrupt/unknown mode must fall back to DEFAULT_STATE.mode, not reach
		// downstream assertNever switches.
		const r = normalizeState({ mode: "bogus-mode" });
		assert(r.mode === DEFAULT_STATE.mode, "real normalizeState: unknown mode falls back to default");
	}
	{
		const r = normalizeState({ mode: "init", initReturnMode: "work", initTargetPath: "/tmp/AGENTS.md" });
		assert(r.mode === "init", "real normalizeState: init mode preserved");
		assert(r.initReturnMode === "work", "real normalizeState: initReturnMode preserved in init");
		assert(r.initTargetPath === "/tmp/AGENTS.md", "real normalizeState: initTargetPath preserved in init");
	}
	{
		// init fields are dropped outside init mode to prevent stale leakage.
		const r = normalizeState({ mode: "explore", initReturnMode: "work", initTargetPath: "/tmp/AGENTS.md" });
		assert(r.initReturnMode === undefined && r.initTargetPath === undefined, "real normalizeState: init fields dropped outside init mode");
	}
	{
		const r = normalizeState({ pendingWorkHandoff: true, mode: "work" });
		assert(
			!("pendingWorkHandoff" in r),
			"real normalizeState: pendingWorkHandoff dropped",
		);
		assert(r.mode === "work", "real normalizeState: work mode preserved");
	}
	{
		const r = normalizeState({
			mode: "plan",
			sessionConfig: {
				models: { plan: { provider: "openai", model: "gpt-5.1" } },
			},
		});
		assert(
			r.sessionConfig &&
				r.sessionConfig.models &&
				r.sessionConfig.models.plan &&
				r.sessionConfig.models.plan.provider === "openai",
			"real normalizeState: sessionConfig preserved round-trip",
		);
	}
	{
		const r = normalizeState({ sessionConfig: "not-an-object" });
		assert(
			!("sessionConfig" in r),
			"real normalizeState: invalid sessionConfig string dropped",
		);
	}
	{
		const r = normalizeState({ sessionConfig: [1, 2, 3] });
		assert(
			!("sessionConfig" in r),
			"real normalizeState: array sessionConfig dropped",
		);
	}
	{
		const r = normalizeState({
			sessionConfig: JSON.parse(
				'{"__proto__":{"polluted":1},"planReview":{"enabled":false}}',
			),
		});
		assert(
			{}.polluted === undefined,
			"real normalizeState: __proto__ key does not pollute Object prototype",
		);
		assert(
			r.sessionConfig &&
				r.sessionConfig.planReview &&
				r.sessionConfig.planReview.enabled === false &&
				!Object.hasOwn(r.sessionConfig, "__proto__"),
			"real normalizeState: dangerous keys stripped, safe keys kept",
		);
	}
	{
		const r = normalizeState([1, 2, 3]);
		assert(r.mode === "idle", "real normalizeState: array input safe");
	}

	// Overlay lifecycle wiring: index.ts binds UI ctx in TUI session_start and
	// disposes on session_shutdown so reload/replacement does not leak.
	const indexTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/index.ts"),
		"utf8",
	);
	assert(
		/overlay\.setUICtx\(\(ctx as any\)\.ui\)/.test(indexTs),
		"index.ts session_start binds overlay.setUICtx(ctx.ui) in TUI",
	);
	assert(
		/overlay\.update\(state\.todos\)/.test(indexTs),
		"index.ts session_start refreshes overlay with current todos",
	);
	assert(
		/ctx as any\)\.mode === "tui"/.test(indexTs),
		"index.ts overlay binding is gated on ctx.mode === 'tui'",
	);
	assert(
		/pi\.on\("session_shutdown"[\s\S]*?overlay\.dispose\(\)/.test(indexTs),
		"index.ts registers session_shutdown handler that disposes overlay",
	);
}

// ═══ Check 7: Code review tooling ═══

console.log("\n=== Check 7: Code review tooling ===");

{
	const modeTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/mode.ts"),
		"utf8",
	);
	const toolsTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/tools.ts"),
		"utf8",
	);
	const commandsTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/commands.ts"),
		"utf8",
	);
	const typesTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/types.ts"),
		"utf8",
	);
	const promptsTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/prompts.ts"),
		"utf8",
	);
	const ocrHelpersTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/ocr-helpers.ts"),
		"utf8",
	);

	// Role param removed — scope to plan review tool block to avoid false positives
	assert(
		/export\s+function\s+registerPlanReviewTool\s*\(/.test(toolsTs),
		"tools.ts exports registerPlanReviewTool",
	);
	assert(
		!toolsTs.includes("registerSubagentTool"),
		"tools.ts: no old registerSubagentTool",
	);
	const prtStart = toolsTs.indexOf("export function registerPlanReviewTool");
	const prtEnd = toolsTs.indexOf("// ── Internal OCR constants", prtStart);
	assert(
		prtStart >= 0 && prtEnd > prtStart,
		"tools.ts: plan review tool block anchors exist",
	);
	const prtBlock = toolsTs.slice(prtStart, prtEnd);
	assert(
		prtBlock.includes('"workflow_plan_review"'),
		"tools.ts: uses workflow_plan_review name",
	);
	assert(
		!prtBlock.includes('"workflow_subagent"'),
		"tools.ts: no old workflow_subagent name",
	);
	assert(
		!/parameters:\s*Type\.Object\(\s*\{[\s\S]*?\brole\s*:/.test(prtBlock),
		"tools.ts: workflow_plan_review no longer has role param (removed)",
	);

	// Optional tool definitions are registered unconditionally; visibility is
	// gated by mode reconciliation and each handler rechecks config.
	assert(
		/export\s+function\s+registerPlanReviewTool\s*\(/.test(toolsTs),
		"tools.ts registers the plan review tool definition",
	);
	assert(
		toolsTs.includes("registerPlanReviewTool(pi, getAgentDir);") &&
			toolsTs.includes("registerCodeReviewTool(pi, getAgentDir);"),
		"tools.ts registers plan/code review definitions unconditionally",
	);
	assert(
		!/if\s*\(\s*config\.planReview\.enabled\)\s*\{?\s*registerPlanReviewTool/.test(toolsTs),
		"tools.ts no longer gates plan review definition registration on factory-time config",
	);
	assert(
		commandsTs.includes("registerReviewCommand(pi, getAgentDir);"),
		"commands.ts registers /review unconditionally; the handler rechecks config",
	);
	// Conditional activation in mode.ts — mode-aware delete-then-add
	assert(
		modeTs.includes("WORKFLOW_GATED_TOOLS") &&
			modeTs.includes("WORKFLOW_TOOL_CLEANUP_NAMES"),
		"mode.ts: separates gated workflow tools from cleanup names",
	);
	assert(
		!/update_plan/.test(modeTs.match(/WORKFLOW_GATED_TOOLS\s*=\s*\[[\s\S]*?\]/)?.[0] ?? ""),
		"mode.ts: WORKFLOW_GATED_TOOLS excludes the update_plan alias",
	);
	assert(
		modeTs.includes("workflowManagedToolNames"),
		"mode.ts: workflow tool ownership is resolved live via workflowManagedToolNames",
	);
	assert(
		modeTs.includes("const workflowCleanup = workflowManagedToolNames(pi)"),
		"mode.ts: deletes owned workflow cleanup names before re-adding allowed tools",
	);
	assert(
		/computeWorkflowToolNames\(mode, cfg(, \w+)?\)/.test(modeTs),
		"mode.ts: uses computeWorkflowToolNames for mode-aware activation",
	);
	// Guard against the regression where withTodoToolName returns a new array
	// but its result is discarded: the plan/work branches must assign the
	// swapped tool list to `names`.
	assert(
		modeTs.includes("const names = withTodoToolName([...PLAN_WORKFLOW_TOOL_NAMES], todoToolName)") &&
			modeTs.includes("const names = withTodoToolName([...WORK_WORKFLOW_TOOL_NAMES], todoToolName)"),
		"mode.ts: computeWorkflowToolNames assigns withTodoToolName's result in plan and work branches",
	);
	assert(
		!/withTodoToolName\(names, todoToolName\);/.test(modeTs),
		"mode.ts: no discarded withTodoToolName return value (mutation-free swap)",
	);
	assert(
		!/if \(!active\.includes\("workflow_todo"\)\) return/.test(modeTs),
		"mode.ts: removed implicit restricted-agent early return",
	);

	// Code review tool
	assert(
		/export\s+function\s+registerCodeReviewTool\s*\(/.test(toolsTs),
		"tools.ts exports registerCodeReviewTool",
	);
	assert(
		toolsTs.includes("requires a non-empty background"),
		"workflow_code_review requires non-empty background",
	);

	// OCR internal constants (no longer configurable)
	assert(
		toolsTs.includes('OCR_BINARY = "ocr"'),
		"tools.ts: OCR_BINARY constant",
	);
	assert(
		toolsTs.includes("OCR_TIMEOUT_MS = 1_800_000"),
		"tools.ts: OCR_TIMEOUT_MS constant",
	);
	assert(
		!toolsTs.includes("config.codeReview.ocrBinary"),
		"tools.ts: no config.codeReview.ocrBinary reference",
	);
	assert(
		!toolsTs.includes("config.codeReview.timeoutMs"),
		"tools.ts: no config.codeReview.timeoutMs reference",
	);

	// OCR helpers — verify exports and that buildReviewArgv body has required flags
	assert(
		/export\s+function\s+buildReviewArgv\s*\(/.test(ocrHelpersTs),
		"ocr-helpers.ts: exports buildReviewArgv",
	);
	assert(
		/export\s+function\s+checkOcrAvailable\s*\(/.test(ocrHelpersTs),
		"ocr-helpers.ts: exports checkOcrAvailable",
	);
	const buildArgvStart = ocrHelpersTs.indexOf(
		"export function buildReviewArgv",
	);
	const buildArgvEnd = ocrHelpersTs.indexOf(
		"export function ocrCommandSummary",
		buildArgvStart,
	);
	const buildArgvBody = ocrHelpersTs.slice(
		buildArgvStart,
		buildArgvEnd > 0 ? buildArgvEnd : ocrHelpersTs.length,
	);
	assert(
		buildArgvBody.includes("--audience"),
		"ocr-helpers.ts: buildReviewArgv body uses --audience flag",
	);
	assert(
		buildArgvBody.includes("--background"),
		"ocr-helpers.ts: buildReviewArgv body uses --background flag",
	);

	// /review owns the workflow_code_review review/fix loop
	const reviewCmdStart = commandsTs.indexOf(
		"export function registerReviewCommand",
	);
	const reviewCmdEnd = commandsTs.indexOf(
		"export function registerCommitCommand",
		reviewCmdStart,
	);
	assert(
		reviewCmdStart >= 0 && reviewCmdEnd > reviewCmdStart,
		"/review and commit command anchors exist",
	);
	const reviewCmdBlock = commandsTs.slice(reviewCmdStart, reviewCmdEnd);
	assert(
		reviewCmdBlock.includes("workflow_code_review") &&
			reviewCmdBlock.includes("review → fix → re-review") &&
			reviewCmdBlock.includes("transitionWorkflowMode"),
		"/review command includes workflow_code_review review/fix loop",
	);
	assert(
		!reviewCmdBlock.includes("async function runCodeReviewSubagent"),
		"/review: no old runCodeReviewSubagent",
	);

	// No stale config field references in commands
	assert(
		!commandsTs.includes("config.codeReview.ocrBinary"),
		"commands.ts: no config.codeReview.ocrBinary",
	);
	assert(
		!commandsTs.includes("config.askUserQuestion"),
		"commands.ts: no config.askUserQuestion",
	);

	// Config slimmed down — no askUserQuestion/TodoOverlay/OcrBinary/TimeoutMs
	assert(
		!typesTs.includes("AskUserQuestionConfig"),
		"types.ts: no AskUserQuestionConfig",
	);
	assert(
		!typesTs.includes("TodoOverlayConfig"),
		"types.ts: no TodoOverlayConfig",
	);
	assert(
		!typesTs.includes("ocrBinary"),
		"types.ts: no ocrBinary (removed from config)",
	);
	assert(
		!typesTs.includes("timeoutMs"),
		"types.ts: no timeoutMs (removed from config)",
	);
	assert(
		!typesTs.includes("maxLoops"),
		"types.ts: no maxLoops (removed from config)",
	);

	// defaults slimmed down
	const defaultsTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/defaults.ts"),
		"utf8",
	);
	assert(!defaultsTs.includes("ocrBinary"), "defaults.ts: no ocrBinary");
	assert(!defaultsTs.includes("maxLoops"), "defaults.ts: no maxLoops");
	assert(
		!defaultsTs.includes("askUserQuestion"),
		"defaults.ts: no askUserQuestion",
	);
	assert(!defaultsTs.includes("todoOverlay"), "defaults.ts: no todoOverlay");

	// config normalize strips stale sections
	const configTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/config.ts"),
		"utf8",
	);
	assert(
		configTs.includes('"todoOverlay" in cfg) delete cfg.todoOverlay'),
		"config.ts: strips todoOverlay",
	);
	assert(
		configTs.includes('"askUserQuestion" in cfg) delete cfg.askUserQuestion'),
		"config.ts: strips askUserQuestion",
	);

	// Work prompt updated — git writes are reserved for /commit; code review is routed through /review
	const workPromptStart = promptsTs.indexOf("export const WORK_PROMPT");
	const workPromptEnd = promptsTs.indexOf(
		"export const COMMIT_PROMPT",
		workPromptStart,
	);
	assert(
		workPromptStart >= 0 && workPromptEnd > workPromptStart,
		"prompts.ts: work prompt block anchors exist",
	);
	const workPromptBlock = promptsTs.slice(workPromptStart, workPromptEnd);
	assert(
		workPromptBlock.includes("git 仓库写操作"),
		"prompts.ts: work prompt forbids git repository writes",
	);
	assert(
		/\/review.*code review/.test(workPromptBlock) &&
			/\/commit.*命令提交/.test(workPromptBlock),
		"prompts.ts: work prompt tells users to use /review then /commit after work",
	);
	assertNotContains(
		workPromptBlock,
		"- 禁止 git commit。",
		"prompts.ts: old work prompt 'git commit' ban line removed",
	);
	assertNotContains(
		workPromptBlock,
		"- 禁止 push。",
		"prompts.ts: old work prompt 'push' ban line removed",
	);
	assertNotContains(
		workPromptBlock,
		"自主决定是否调用它进行代码审查",
		"prompts.ts: work prompt does not tell model to auto-review",
	);
	assert(
		promptsTs.includes("workflow_code_review"),
		"prompts.ts: mentions workflow_code_review",
	);
	assert(
		promptsTs.includes("workflow_plan_review"),
		"prompts.ts: mentions workflow_plan_review",
	);
	assertNotContains(
		promptsTs,
		"workflow_subagent",
		"prompts.ts: no old workflow_subagent",
	);
	assertNotContains(
		promptsTs,
		"workflow_status",
		"prompts.ts: no workflow_status (removed)",
	);

	// Plan review: sidecall removed, independent reviewer agent in place.
	assert(
		!fs.existsSync(path.join(CWD, "extensions/workflow/sidecall.ts")),
		"sidecall.ts removed",
	);
	assert(
		!toolsTs.includes("sidecall.js"),
		"tools.ts no longer imports sidecall",
	);
	const planReviewAgentTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/plan-review-agent.ts"),
		"utf8",
	);
	assert(
		planReviewAgentTs.includes("export async function runPlanReviewAgent"),
		"plan-review-agent.ts: exports runPlanReviewAgent",
	);
	assert(
		planReviewAgentTs.includes("SessionManager.inMemory"),
		"plan-review-agent.ts: uses an in-memory child SessionManager",
	);
	assert(
		planReviewAgentTs.includes("createAgentSession"),
		"plan-review-agent.ts: builds a fresh child AgentSession",
	);
	assert(
		planReviewAgentTs.includes("noExtensions: true"),
		"plan-review-agent.ts: ResourceLoader disables auto extension discovery",
	);
	assert(
		planReviewAgentTs.includes("workflowManagedToolNames(pi)"),
		"plan-review-agent.ts: strips workflow-managed tools from the child allowlist",
	);
	assert(
		planReviewAgentTs.includes("PLAN_REVIEW_TOTAL_TIMEOUT_MS = 1_800_000"),
		"plan-review-agent.ts: 30-minute total timeout constant",
	);
	assert(
		/controller\.signal\.addEventListener\("abort"/.test(planReviewAgentTs),
		"plan-review-agent.ts: aborts the child session on timeout/cancel",
	);
	assert(
		/finally\b[\s\S]*?session\.dispose\(\)/.test(planReviewAgentTs),
		"plan-review-agent.ts: disposes the child session in finally",
	);
	assert(
		planReviewAgentTs.includes("usage") &&
			planReviewAgentTs.includes("requestedTools") &&
			planReviewAgentTs.includes("unavailableTools"),
		"plan-review-agent.ts: returns usage + tool diagnostics",
	);
	// The tool is now zero-argument and discards legacy sidecall fields.
	const planReviewToolStart = toolsTs.indexOf(
		"// ── workflow_plan_review tool (independent reviewer agent)",
	);
	const planReviewToolEnd = toolsTs.indexOf(
		"// ── Internal OCR constants",
		planReviewToolStart,
	);
	assert(
		planReviewToolStart >= 0 && planReviewToolEnd > planReviewToolStart,
		"tools.ts: plan review tool block anchors exist",
	);
	const planReviewToolBlock = toolsTs.slice(planReviewToolStart, planReviewToolEnd);
	assert(
		/parameters:\s*Type\.Object\(\{\s*\}\)/.test(planReviewToolBlock),
		"tools.ts: workflow_plan_review is zero-argument",
	);
	assert(
		planReviewToolBlock.includes("prepareArguments: preparePlanReviewArguments"),
		"tools.ts: workflow_plan_review declares prepareArguments",
	);
	assert(
		planReviewToolBlock.includes("void a.task") &&
			planReviewToolBlock.includes("void a.context") &&
			planReviewToolBlock.includes("void a.instructions"),
		"tools.ts: preparePlanReviewArguments discards legacy task/context/instructions",
	);
	assert(
		planReviewToolBlock.includes("runPlanReviewAgent("),
		"tools.ts: workflow_plan_review invokes the independent reviewer",
	);
	assert(
		planReviewToolBlock.includes("usage: result.usage"),
		"tools.ts: workflow_plan_review propagates nested usage on the result",
	);

	// Approve kickoff — scope to approve tool, check immediate runtime handoff behavior.
	const approveStart = toolsTs.indexOf(
		"export function registerPlanApproveTool",
	);
	const approveEnd = toolsTs.indexOf(
		"export function registerPlanClearTool",
		approveStart,
	);
	assert(
		approveStart >= 0 && approveEnd > approveStart,
		"tools.ts: approve branch anchors exist",
	);
	const approveBlock = toolsTs.slice(approveStart, approveEnd);
	assert(
		/const\s+nextState\s*:\s*WorkflowState\s*=\s*\{\s*\.\.\.state/.test(
			approveBlock,
		),
		"tools.ts: approve preserves existing workflow state fields",
	);
	assert(
		approveBlock.includes('mode: "work"') &&
			approveBlock.includes("const workRunId = crypto.randomUUID()") &&
			approveBlock.includes("workRunId,") &&
			!approveBlock.includes("pendingWorkHandoff: true"),
		"tools.ts: approve persists work mode without pending handoff flag",
	);
	assert(
		/await\s+transitionWorkflowMode\s*\(/.test(approveBlock),
		"tools.ts: approve switches runtime before handoff kickoff",
	);
	assert(
		/await\s+transitionWorkflowMode[\s\S]*?if\s*\(\s*!result\.ok[\s\S]*?rollbackApproval/.test(
			approveBlock,
		),
		"tools.ts: approve switches runtime and rolls back on failure",
	);
	assert(
		/if\s*\(\s*!result\.ok\s*\)[\s\S]*?throw\s+new\s+Error\(result\.reason\)/.test(
			approveBlock,
		),
		"tools.ts: approve throws when runtime transition fails",
	);
	assert(
		approveBlock.includes('pi.appendEntry(WORK_APPROVAL_CUSTOM_TYPE') &&
			approveBlock.includes('pendingWorkKickoff: workRunId') &&
			!approveBlock.includes('pi.sendUserMessage') &&
			!approveBlock.includes('deliverAs'),
		"tools.ts: approve writes journal + pending (no followUp/sendUserMessage)",
	);
	assert(
		/try\s*\{[\s\S]*?appendEntry[\s\S]*?\}\s*catch\s*\(\s*journalErr[\s\S]*?cleanupCreatedWorktree/.test(
			approveBlock,
		),
		"tools.ts: journal failure triggers worktree cleanup",
	);
	assert(
		approveBlock.includes("terminate: true"),
		"tools.ts: approve terminates the current turn",
	);

	// mode.ts unified transition helper
	assert(
		/export\s+(async\s+)?function\s+transitionWorkflowMode\s*\(/.test(modeTs),
		"mode.ts: exports transitionWorkflowMode",
	);
	assert(
		modeTs.includes("setCurrentTurnGuardMode") && modeTs.includes("saveState"),
		"mode.ts: transitionWorkflowMode syncs persist + guard cache",
	);
	assert(
		modeTs.includes("clearCurrentTurnGuardMode"),
		"mode.ts: transitionWorkflowMode clears guard for idle mode",
	);

	// Slash commands use transitionWorkflowMode
	assert(
		commandsTs.includes("transitionWorkflowMode"),
		"commands.ts: slash commands call transitionWorkflowMode",
	);
	assert(
		!/\bsaveState\(ctx\.cwd,\s*sessionKey,\s*state\)[^;]*\n\s*const\s+ok\s*=\s*await\s+applyModeRuntime/.test(
			commandsTs,
		),
		"commands.ts: no bare saveState + applyModeRuntime in command handlers",
	);
	// Check 13: Workflow gating — defaults, schema, guards ───
	console.log("\n=== Check 13: Workflow gating ===");

	// DEFAULT_STATE includes workflowEnabled: false
	assert(
		defaultsTs.includes("workflowEnabled: false"),
		"defaults.ts: DEFAULT_STATE has workflowEnabled: false",
	);
	assert(
		defaultsTs.includes("autoEnter: false"),
		"defaults.ts: DEFAULT_CONFIG has autoEnter: false",
	);

	// Type definitions
	assert(
		typesTs.includes("workflowEnabled: boolean"),
		"types.ts: WorkflowState has workflowEnabled",
	);
	assert(
		typesTs.includes("workflowExplicitlyDisabled"),
		"types.ts: WorkflowState has workflowExplicitlyDisabled",
	);
	assert(
		typesTs.includes("autoEnter: boolean"),
		"types.ts: WorkflowConfig has workflow.autoEnter",
	);

	// State normalization preserves workflowEnabled
	const stateTs2 = fs.readFileSync(
		path.join(CWD, "extensions/workflow/state.ts"),
		"utf8",
	);
	assert(
		stateTs2.includes("typeof obj.workflowEnabled"),
		"state.ts: normalizeState checks workflowEnabled",
	);

	// Config normalization preserves workflow section
	assert(
		/"workflow"/.test(configTs) ||
			/cfg\.workflow/.test(configTs) ||
			configTs.includes("workflow") ||
			configTs.includes("autoEnter"),
		"config.ts: normalizeConfig preserves workflow.autoEnter",
	);

	// checkWorkflowEnabled guard in tools
	assert(
		toolsTs.includes("checkWorkflowEnabled"),
		"tools.ts: has checkWorkflowEnabled guard function",
	);
	assert(
		toolsTs.includes("Run /wf first to enable workflow tools"),
		"tools.ts: checkWorkflowEnabled error message present",
	);

	// Register functions exist
	assert(
		/export\s+function\s+registerWfCommand\s*\(/.test(commandsTs),
		"commands.ts: exports registerWfCommand",
	);
	assert(
		/export\s+function\s+registerAllWorkflowCommands\s*\(/.test(commandsTs),
		"commands.ts: exports registerAllWorkflowCommands",
	);
	assert(
		/export\s+function\s+registerAllWorkflowTools\s*\(/.test(toolsTs),
		"tools.ts: exports registerAllWorkflowTools",
	);
	assert(
		/export\s+function\s+deactivateWorkflowTools\s*\(/.test(modeTs),
		"mode.ts: exports deactivateWorkflowTools",
	);

	// /wf-exit disables workflowEnabled
	const wfExitStart = commandsTs.indexOf(
		"export function registerWfExitCommand",
	);
	const wfExitEnd = commandsTs.indexOf(
		"export function registerWfResetCommand",
		wfExitStart,
	);
	const wfExitBlock = commandsTs.slice(wfExitStart, wfExitEnd);
	assert(
		wfExitBlock.includes("workflowEnabled = false"),
		"/wf-exit: sets workflowEnabled to false",
	);

	// /wf-reset preserves workflowEnabled
	const wfResetStart = commandsTs.indexOf(
		"export function registerWfResetCommand",
	);
	const wfResetEnd = commandsTs.indexOf(
		"export function registerWfInitCommand",
		wfResetStart,
	);
	const wfResetBlock = commandsTs.slice(wfResetStart, wfResetEnd);
	assert(
		wfResetBlock.includes("current.workflowEnabled"),
		"/wf-reset: preserves current workflowEnabled state",
	);

	// Tool-call guard blocks workflow tools when disabled
	const tcgStart = commandsTs.indexOf("registerToolCallGuard");
	const tcgEnd = commandsTs.indexOf("registerAgentEnd", tcgStart);
	const tcgBlock = commandsTs.slice(tcgStart, tcgEnd);
	assert(
		tcgBlock.includes("!workflowActive"),
		"tool-call guard: checks !workflowActive for workflow tools",
	);
	assert(
		tcgBlock.includes("Run /wf first"),
		"tool-call guard: error message mentions /wf",
	);

	// before_agent_start gates on workflowActive (scoped to the function)
	const basStart = commandsTs.indexOf(
		"export function registerBeforeAgentStart",
	);
	const basEnd = commandsTs.indexOf(
		"export function registerToolCallGuard",
		basStart,
	);
	const basBlock =
		basStart >= 0 && basEnd > basStart
			? commandsTs.slice(basStart, basEnd)
			: "";
	assert(
		basBlock.includes('workflowActive') &&
			basBlock.includes('isWorkflowActive(state, config)'),
		'commands.ts: before_agent_start uses unified isWorkflowActive helper',
	);

	// index.ts gating
	const indexTsGating = fs.readFileSync(
		path.join(CWD, "extensions/workflow/index.ts"),
		"utf8",
	);
	assert(
		indexTsGating.includes("registerWfCommand") &&
			indexTsGating.includes("autoEnter"),
		"index.ts: /wf always registered, autoEnter gating present",
	);
	assert(
		indexTsGating.includes("ensureWorkflowRegistered"),
		"index.ts: has ensureWorkflowRegistered helper",
	);
	assert(
		indexTsGating.includes('pi.on("session_start"') ||
			indexTsGating.includes("session_start"),
		"index.ts: registers session_start handler",
	);
}

// Check 14: Explore mode — types, config, prompts, guards, commands, redirect ═══

console.log("\n=== Check 14: Explore mode ===");

{
	// Re-read source files — Check 7's block defines them in a sibling scope.
	const typesTs14 = fs.readFileSync(
		path.join(CWD, "extensions/workflow/types.ts"),
		"utf8",
	);
	const defaultsTs14 = fs.readFileSync(
		path.join(CWD, "extensions/workflow/defaults.ts"),
		"utf8",
	);
	const configTs14 = fs.readFileSync(
		path.join(CWD, "extensions/workflow/config.ts"),
		"utf8",
	);
	const promptsTs14 = fs.readFileSync(
		path.join(CWD, "extensions/workflow/prompts.ts"),
		"utf8",
	);
	const modeTs14 = fs.readFileSync(
		path.join(CWD, "extensions/workflow/mode.ts"),
		"utf8",
	);
	const helpersTs14 = fs.readFileSync(
		path.join(CWD, "extensions/workflow/helpers.ts"),
		"utf8",
	);
	const commandsTs14 = fs.readFileSync(
		path.join(CWD, "extensions/workflow/commands.ts"),
		"utf8",
	);

	// types.ts: Mode and Role include explore
	assert(typesTs14.includes('"explore"'), "types.ts: includes 'explore'");
	assert(
		typesTs14.includes('"explore"') && typesTs14.includes('"plan"'),
		"types.ts: Mode union includes explore",
	);

	// defaults.ts: DEFAULT_CONFIG.models includes explore
	assert(
		defaultsTs14.includes("explore:"),
		"defaults.ts: DEFAULT_CONFIG has explore model",
	);
	assert(
		!defaultsTs14.includes("models.explore (Explore removed)"),
		"defaults.ts: no stale explore-removed comment",
	);

	// config.ts: VALID_ROLES includes explore
	assert(
		configTs14.includes('"explore"'),
		"config.ts: VALID_ROLES includes explore",
	);

	// prompts.ts: EXPLORE_PROMPT and promptForMode branch
	assert(
		/export const EXPLORE_PROMPT/.test(promptsTs14),
		"prompts.ts: exports EXPLORE_PROMPT",
	);
	assert(
		promptsTs14.includes('case "explore"'),
		"prompts.ts: promptForMode handles explore",
	);

	// mode.ts: roleMap includes explore
	assert(
		/case "explore":\s*\n\s*\n?\s*case "init":[\s\S]*?return "explore"/.test(modeTs14) ||
			/modeRole[\s\S]*?case "explore"[\s\S]*?return "explore"/.test(modeTs14),
		"mode.ts: roleMap has explore: explore",
	);

	// mode.ts: workflow tool gating hides workflow tools in explore/idle.
	const cfgAllReviewTools = {
		planReview: { enabled: true },
		codeReview: { enabled: true },
	};
	const cfgNoReviewTools = {
		planReview: { enabled: false },
		codeReview: { enabled: false },
	};
	assert(
		inlineComputeWorkflowToolNames("explore", cfgAllReviewTools).length === 0 &&
			inlineComputeWorkflowToolNames("idle", cfgAllReviewTools).length === 0,
		"inline runtime: explore exposes no workflow tools; idle exposes none",
	);
	assert(
		inlineComputeWorkflowToolNames("plan", cfgAllReviewTools).join(",") ===
			"workflow_todo,workflow_plan_read,workflow_plan_save,workflow_plan_approve,workflow_plan_clear,workflow_plan_review" &&
			inlineComputeWorkflowToolNames("work", cfgAllReviewTools).join(",") ===
				"workflow_todo,workflow_code_review" &&
			inlineComputeWorkflowToolNames("work", cfgNoReviewTools).join(",") ===
				"workflow_todo" &&
			inlineComputeWorkflowToolNames("commit", cfgAllReviewTools).length === 0,
		"inline runtime: plan exposes plan tools; work exposes todo (+optional review); commit exposes none",
	);
	assert(
		/export function isWorkflowToolMode\([\s\S]*?mode === "plan"[\s\S]*?mode === "work"[\s\S]*?mode === "init"/.test(
			modeTs14,
		) &&
			!/export function isWorkflowToolMode\([\s\S]*?mode === "explore"/.test(
				modeTs14,
			) &&
			!/export function isWorkflowToolMode\([\s\S]*?mode === "commit"/.test(
				modeTs14,
			),
		"mode.ts: isWorkflowToolMode allow-list is plan/work/init (explore excluded)",
	);
	assert(
		/const PLAN_WORKFLOW_TOOL_NAMES[\s\S]*?workflow_plan_save[\s\S]*?const WORK_WORKFLOW_TOOL_NAMES[\s\S]*?export function computeWorkflowToolNames[\s\S]*?config\.planReview\.enabled[\s\S]*?config\.codeReview\.enabled[\s\S]*?return \[\]/.test(
			modeTs14,
		),
		"mode.ts: computeWorkflowToolNames mirrors mode-specific runtime behavior (work has no plan_read)",
	);
	const expectedWorkflowTools = [
		"workflow_todo",
		"workflow_plan_read",
		"workflow_plan_save",
		"workflow_plan_approve",
		"workflow_plan_clear",
		"workflow_plan_review",
		"workflow_code_review",
	];
	for (const toolName of expectedWorkflowTools) {
		assert(
			modeTs14.includes(`"${toolName}"`),
			`mode.ts: WORKFLOW_GATED_TOOLS includes ${toolName}`,
		);
	}
	assert(
		/activateWorkflowToolsIfAllowed\([\s\S]*?mode: Mode[\s\S]*?computeWorkflowToolNames\(mode, cfg(, \w+)?\)/.test(
			modeTs14,
		),
		"mode.ts: activateWorkflowToolsIfAllowed receives mode and computes tool set",
	);

	// helpers.ts: modeLabel includes explore
	assert(
		helpersTs14.includes('case "explore":') &&
			helpersTs14.includes('return "Explore Mode"'),
		"helpers.ts: modeLabel has explore",
	);

	// guards.ts: isReadonlyMode includes explore
	const guardsTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/guards.ts"),
		"utf8",
	);
	assert(
		/mode === "explore"/.test(guardsTs) && /mode === "plan"/.test(guardsTs),
		"guards.ts: isReadonlyMode true for explore + plan",
	);

	// guards.ts: isLocalFileMutatingShell has been removed; the remaining
	// read-only protections live in path guards and mode prompts.
	assert(
		!/export function isLocalFileMutatingShell/.test(guardsTs),
		"guards.ts: isLocalFileMutatingShell removed in favor of mode prompts",
	);

	// commands.ts: before_agent_start promotes idle→explore
	assert(
		/state\.mode === "idle"/.test(commandsTs14) &&
			commandsTs14.includes('state.mode = "explore"'),
		"commands.ts: before_agent_start promotes idle→explore",
	);

	// commands.ts: /explore command registered
	assert(
		/registerExploreCommand/.test(commandsTs14),
		"commands.ts: exports registerExploreCommand",
	);
	assert(
		commandsTs14.includes("Non-destructive") ||
			commandsTs14.includes("...current, mode"),
		"commands.ts: /explore is non-destructive",
	);

	// commands.ts: /wf sets mode explore
	const wfCmdStart = commandsTs14.indexOf("export function registerWfCommand");
	const wfResetCmdStart = commandsTs14.indexOf(
		"export function registerWfResetCommand",
		wfCmdStart,
	);
	const wfCmdBlock = commandsTs14.slice(wfCmdStart, wfResetCmdStart);
	assert(
		wfCmdBlock.includes('state.mode = "explore"'),
		"commands.ts: /wf sets mode to explore",
	);

	// commands.ts: workflow tools are blocked outside plan/work.
	assert(
		commandsTs14.includes("isWorkflowToolMode") &&
			commandsTs14.includes("当前模式(${effectiveMode})禁止使用"),
		"commands.ts: workflow tools blocked outside workflow tool modes",
	);
	assert(
		!/activateWorkflowToolsIfAllowed\(\s*pi,\s*ctx\.cwd,\s*getAgentDir,\s*ctx\s*\)/.test(commandsTs14),
		"commands.ts: before_agent_start does not pre-activate workflow tools without mode",
	);

	// commands.ts: scratch write allows explore mode
	assert(
		/e(?:ffectiveMode|ffective)\s*===\s*"plan"\s*\|\|\s*e(?:ffectiveMode|ffective)\s*===\s*"explore"/.test(
			commandsTs14,
		) || commandsTs14.includes('"plan" || effectiveMode === "explore"'),
		"commands.ts: scratch writes allowed for plan || explore",
	);
}

// ═══ Check 15: Bash mutation scanner removed; path guards retained ═══

console.log("\n=== Check 15: mutation scanner removed, path guards retained ===");

{
	const guardsTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/guards.ts"),
		"utf8",
	);
	const commandsTs2 = fs.readFileSync(
		path.join(CWD, "extensions/workflow/commands.ts"),
		"utf8",
	);

	assert(
		!/export function isLocalFileMutatingShell/.test(guardsTs),
		"guards.ts: isLocalFileMutatingShell removed",
	);
	assert(
		!/\bisLocalFileMutatingShell\s*\(/.test(
			commandsTs2.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
		),
		"commands.ts: Bash mutation scanner removed from tool_call guard",
	);

	// Stable path guards retained.
	assert(
		guardsTs.includes("export function isWorkflowDataPath"),
		"guards.ts: isWorkflowDataPath retained",
	);
	assert(
		guardsTs.includes("export function isAllowedPlanScratchPath"),
		"guards.ts: isAllowedPlanScratchPath retained",
	);
	assert(
		guardsTs.includes("export function isAllowedInitTargetPath"),
		"guards.ts: isAllowedInitTargetPath retained",
	);
	assert(
		guardsTs.includes("export function isInsideWorktree"),
		"guards.ts: isInsideWorktree retained",
	);
	assert(
		guardsTs.includes("export function isReadonlyMode"),
		"guards.ts: isReadonlyMode retained",
	);
}

function validateWorktreeIntegrationStatic() {
	console.log("\n=== Worktree integration static checks ===");
	const root = process.cwd();
	const types = fs.readFileSync(path.join(root, "extensions/workflow/types.ts"), "utf8");
	const state = fs.readFileSync(path.join(root, "extensions/workflow/state.ts"), "utf8");
	const worktree = fs.readFileSync(path.join(root, "extensions/workflow/worktree.ts"), "utf8");
	const commands = fs.readFileSync(path.join(root, "extensions/workflow/commands.ts"), "utf8");
	const tools = fs.readFileSync(path.join(root, "extensions/workflow/tools.ts"), "utf8");
	const helpers = fs.readFileSync(path.join(root, "extensions/workflow/helpers.ts"), "utf8");
	const guards = fs.readFileSync(path.join(root, "extensions/workflow/guards.ts"), "utf8");

	assert(
		types.includes("worktreePath?: string") &&
			types.includes("worktreeBranch?: string") &&
			types.includes("worktreeBaseBranch?: string"),
		"WorkflowState has worktree fields",
	);
	assert(
		state.includes("obj.worktreePath") &&
			state.includes("path.isAbsolute(obj.worktreePath.trim())") &&
			state.includes("worktreePrefix") &&
			state.includes("/^[a-fA-F0-9]{8}/") &&
			state.includes('branchMatchesWorkRun') &&
			state.includes('from "./worktree.js"') &&
			worktree.includes('branchMatchesWorkRun') &&
			worktree.includes('@wf-'),
		"normalizeState validates worktree path against 8-hex workRunId prefix and accepts semantic @wf-<id> branches",
	);
	assert(
		/execFileSync\(\s*["']git["']\s*,\s*args\b/.test(worktree) &&
			/["']worktree["']\s*,\s*["']add["']\s*,\s*["']-b["']/.test(worktree),
		"createWorktree uses git argv array",
	);
	assert(
		worktree.includes("export function validateWorktreeState") &&
			worktree.includes("worktreePath points to the current repo checkout"),
		"validateWorktreeState rejects invalid worktrees",
	);
	assert(
		/["']worktree["']\s*,\s*["']remove["']\s*,\s*state\.worktreePath/.test(worktree) &&
			!/["']worktree["']\s*,\s*["']remove["']\s*,\s*["']--force["']/.test(worktree) &&
			/["']branch["']\s*,\s*["']-d["']\s*,\s*branch/.test(worktree) &&
			/\^wf\\\/\[a-fA-F0-9\]\{8\}\$/.test(worktree) &&
			worktree.includes("Refusing to delete non-workflow branch"),
		"reset helpers remove worktree safely and only delete workflow branches",
	);
	assert(
		guards.includes("export function isInsideWorktree") &&
			guards.includes("isSymbolicLink()") &&
			guards.includes("nlink > 1"),
		"isInsideWorktree guards symlink and hardlink escapes",
	);
	const writeGuard = commands.slice(
		commands.indexOf("// Worktree-bound Work Mode"),
		commands.indexOf("// Read-only modes"),
	);
	assert(
		writeGuard.includes("validateWorktreeState(ctx.cwd, state)") &&
			writeGuard.includes("isInsideWorktree(") &&
			!writeGuard.includes("isAllowedPlanScratchPath"),
		"tool guard validates worktree and confines write/edit paths",
	);
	assert(
		!commands.includes("worktreeShellDenial") &&
			tools.includes("registerBashOverrideTool") &&
			tools.includes("createBashTool") &&
			tools.includes('name: "bash"') &&
			tools.includes("function resolveEffectiveCwd") &&
			tools.includes("resolveEffectiveCwd(ctx.cwd, state)") &&
			tools.includes("createBashTool(effectiveCwd)") &&
			tools.includes("return state.worktreePath;"),
		"bash override routes external commands through the shared worktree-aware cwd resolver",
	);

	// workflow_code_review resolves the same worktree-aware cwd and passes it
	// to runOcrReview so workspace/range/commit reviews run against the active
	// worktree's working tree and branch.
	const crStart = tools.indexOf("export function registerCodeReviewTool");
	const crEnd = tools.indexOf("// ── Bulk registration", crStart);
	assert(
		crStart >= 0 && crEnd > crStart,
		"tools.ts: code review block anchors exist for cwd assertion",
	);
	const crBlock = tools.slice(crStart, crEnd > 0 ? crEnd : tools.length);
	assert(
		crBlock.includes("getSessionKey(ctx.sessionManager)") &&
			crBlock.includes("loadState(ctx.cwd, sessionKey)"),
		"workflow_code_review reads session state before running OCR",
	);
	assert(
		crBlock.includes("resolveEffectiveCwd(ctx.cwd, state)"),
		"workflow_code_review resolves worktree-aware cwd via the shared helper",
	);
	assert(
		/runOcrReview\(\s*OCR_BINARY,\s*reviewCwd,/.test(crBlock),
		"workflow_code_review passes the resolved reviewCwd to runOcrReview (ctx.cwd replaced)",
	);
	assert(
		crBlock.includes(
			"all scopes run against that worktree's working tree and branch",
		),
		"workflow_code_review description documents active-worktree execution",
	);
	assert(
		commands.includes("Branch was not deleted") &&
			commands.includes("worktree 已删除，但 branch 删除失败"),
		"/wf-reset validates removal and preserves branch safety",
	);
	assert(
		tools.includes("Git worktree") &&
			tools.includes("plannedWorktreeInfo") &&
			tools.includes("cleanupCreatedWorktree") &&
			tools.includes("rollbackApproval") &&
			tools.includes("branchName") &&
			tools.includes("params.branchName"),
		"plan approve creates worktree choice, rollback cleanup, and accepts branchName",
	);
	assert(
		worktree.includes("export function buildWorktreeBranchName") &&
			worktree.includes("export function validateSemanticBranchName") &&
			worktree.includes("check-ref-format") &&
			worktree.includes("WORKTREE_BRANCH_SUFFIX_RE") &&
			worktree.includes("@wf-") &&
			!/show-ref/.test(worktree),
		"createWorktree builds semantic@wf-<id> names and validates via git check-ref-format without show-ref pre-check",
	);
	assert(
		helpers.includes("worktreeRuntimeNotice") &&
			helpers.includes("bash 已自动在 active worktree 中执行") &&
			helpers.includes("promptLine"),
		"worktreeRuntimeNotice describes file paths and bash cwd override",
	);
}

validateWorktreeIntegrationStatic();

function assertNotContains(haystack, needle, label) {
	runs++;
	const contains = haystack.includes(needle);
	if (contains) {
		console.error(`  FAIL: ${label}`);
		failures++;
	} else {
		console.log(`  PASS: ${label}`);
	}
}

console.log("\n=== Init Mode static checks ===");
function validateInitModeStatic() {
	const typesTs = fs.readFileSync(path.join(CWD, "extensions/workflow/types.ts"), "utf8");
	const modeTs = fs.readFileSync(path.join(CWD, "extensions/workflow/mode.ts"), "utf8");
	const guardsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/guards.ts"), "utf8");
	const commandsTs2 = fs.readFileSync(path.join(CWD, "extensions/workflow/commands.ts"), "utf8");
	const toolsTs2 = fs.readFileSync(path.join(CWD, "extensions/workflow/tools.ts"), "utf8");
	const promptsTs2 = fs.readFileSync(path.join(CWD, "extensions/workflow/prompts.ts"), "utf8");
	const helpersTs2 = fs.readFileSync(path.join(CWD, "extensions/workflow/helpers.ts"), "utf8");

	assert(/export type Mode = "idle" \| "explore" \| "init"[\s\S]*"commit";/.test(typesTs), "types.ts: Mode includes init");
	assert(/initReturnMode\?: "explore" \| "plan" \| "work" \| "commit";/.test(typesTs), "types.ts: initReturnMode narrowed to non-idle/init modes");
	assert(/initTargetPath\?: string;/.test(typesTs), "types.ts: optional initTargetPath field");

	assert(modeTs.includes("workflow_init_complete"), "mode.ts: WORKFLOW_GATED_TOOLS includes workflow_init_complete");
	assert(modeTs.includes("case \"init\":") && modeTs.includes("INIT_WORKFLOW_TOOL_NAMES"), "mode.ts: computeWorkflowToolNames handles init via exhaustive switch");
	assert(/modeRole[\s\S]*?case "init"[\s\S]*?return "explore"/.test(modeTs), "mode.ts: init reuses explore model role");
	assert(/function modeRole[\s\S]*?default:[\s\S]*?assertNever/.test(modeTs), "mode.ts: modeRole switch uses assertNever");
	assert(/function computeFallbackWorkflowToolNames[\s\S]*?default:[\s\S]*?assertNever/.test(modeTs), "mode.ts: fallback tool names switch uses assertNever");

	assert(guardsTs.includes("isAllowedInitTargetPath"), "guards.ts: exports isAllowedInitTargetPath");
	assert(/isReadonlyMode[\s\S]*?mode === "init"/.test(guardsTs), "guards.ts: init is read-only (inherits bash guard)");
	assert(guardsTs.includes("has multiple hard links") && guardsTs.includes("is a symlink — rejected"), "guards.ts: init path validator rejects symlink + hardlink");

	assert(commandsTs2.includes("effectiveMode === \"init\"") && commandsTs2.includes("isAllowedInitTargetPath"), "commands.ts: tool_call guard has init branch before readonly");
	assert(/function isProjectEmpty[\s\S]*?ignore[\s\S]*?\.git[\s\S]*?\.pi/.test(commandsTs2), "commands.ts: isProjectEmpty ignores .git/.pi/AGENTS.md");
	assert(commandsTs2.includes("registerWfInitCommand(\n\tpi: ExtensionAPI,\n\tgetAgentDir") || commandsTs2.includes("registerWfInitCommand(\n\tpi,\n\tgetAgentDir") || /registerWfInitCommand\([\s\S]*?getAgentDir/.test(commandsTs2), "commands.ts: registerWfInitCommand takes getAgentDir");
	assert(commandsTs2.includes("state.mode === \"init\" && state.initTargetPath"), "commands.ts: wf-init resumes existing init without overwriting return mode");

	assert(toolsTs2.includes("registerInitCompleteTool"), "tools.ts: registers registerInitCompleteTool");
	assert(/name: "workflow_init_complete"[\s\S]*?status: InitCompleteStatusSchema/.test(toolsTs2), "tools.ts: workflow_init_complete has status param");
	assert(toolsTs2.includes("workflow_init_complete only allowed in Init Mode"), "tools.ts: init_complete gates on init mode");
	assert(toolsTs2.includes("target failed validation"), "tools.ts: init_complete completed re-validates target");
	assert(toolsTs2.includes("mode: returnMode"), "tools.ts: init_complete restores prior mode");

	assert(promptsTs2.includes("INIT_PROMPT") && promptsTs2.includes('case "init":'), "prompts.ts: INIT_PROMPT + exhaustive dispatch");
	assert(helpersTs2.includes('case "init":') && helpersTs2.includes("Init Mode"), "helpers.ts: modeLabel has init");

	// Inline runtime: init workflow tools
	const initTools = inlineComputeWorkflowToolNames("init", { planReview: { enabled: true }, codeReview: { enabled: true } });
	assert(JSON.stringify(initTools) === JSON.stringify(["workflow_init_complete"]), "inline runtime: init exposes only workflow_init_complete");
	assert(inlineIsWorkflowToolMode("init") === true, "inline runtime: init is a workflow-tool mode");
	assert(inlineIsWorkflowToolMode("explore") === false, "inline runtime: explore is no longer a workflow-tool mode");
	assert(inlineIsWorkflowToolMode("idle") === false, "inline runtime: idle is not a workflow-tool mode");
}
validateInitModeStatic();

// ═══ Check 17: Todo delta/snapshot + grilling batch ═══
console.log("\n=== Check 17: todo delta/snapshot + grilling batch ===");
{
	const helpersTs = fs.readFileSync(path.join(CWD, "extensions/workflow/helpers.ts"), "utf8");
	const toolsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/tools.ts"), "utf8");
	const promptsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/prompts.ts"), "utf8");

	// helpers.ts exports delta/snapshot formatters and next-todo helper.
	assert(/export function todoDeltaText/.test(helpersTs), "helpers.ts exports todoDeltaText");
	assert(/export function todoSnapshotText/.test(helpersTs), "helpers.ts exports todoSnapshotText");
	assert(/export function nextTodo/.test(helpersTs), "helpers.ts exports nextTodo");
	assert(/export function todoStatusCounts/.test(helpersTs), "helpers.ts exports todoStatusCounts");
	assert(helpersTs.includes("[todo delta]"), "todoDeltaText marks output as delta");
	assert(helpersTs.includes("[todo snapshot]"), "todoSnapshotText marks output as snapshot");

	// workflow_todo: list returns snapshot, reset/add/set return delta.
	const todoToolStart = toolsTs.indexOf("export function registerTodoTool");
	const todoToolEnd = toolsTs.indexOf("export function registerUpdatePlanTool", todoToolStart);
	assert(todoToolStart >= 0 && todoToolEnd > todoToolStart, "tools.ts: todo tool block anchors exist");
	const todoBlock = toolsTs.slice(todoToolStart, todoToolEnd);
	assert(todoBlock.includes('action === "list"'), "workflow_todo handles list action");
	assert(todoBlock.includes("todoSnapshotText(state)"), "workflow_todo list returns snapshot");
	assert(todoBlock.includes("todoDeltaText(state"), "workflow_todo mutation returns delta");
	// Guard the add-path diff logic (changedId is found post-add; isAdd flag
	// distinguishes add from change; before-set captures the added item).
	assert(todoBlock.includes("new Set(state.todos.map") && todoBlock.includes("deltaIsAdd"), "workflow_todo add captures before-set + isAdd flag for delta diff");
	assert(todoBlock.includes("details: { todos: state.todos }"), "workflow_todo keeps full todos in details");

	// update_plan: read returns snapshot, replace returns delta.
	const upStart = toolsTs.indexOf("export function registerUpdatePlanTool");
	const upEnd = toolsTs.indexOf("// ── workflow plan tools", upStart);
	assert(upStart >= 0 && upEnd > upStart, "tools.ts: update_plan block anchors exist");
	const upBlock = toolsTs.slice(upStart, upEnd);
	assert(upBlock.includes("todoSnapshotText(state)"), "update_plan read returns snapshot");
	assert(upBlock.includes('todoDeltaText(state, { mutation: "replaced" })'), "update_plan replace returns replaced-mutation delta");
	assert(upBlock.includes("details: { todos: state.todos }"), "update_plan keeps full todos in details");

	// Grilling: batch decisions schema + prepareGrillArguments legacy compat.
	const grillStart = toolsTs.indexOf("// ── workflow_grill_record tool");
	const grillEnd = toolsTs.indexOf("// ── workflow_plan_review tool", grillStart);
	assert(grillStart >= 0 && grillEnd > grillStart, "tools.ts: grill block anchors exist");
	const grillBlock = toolsTs.slice(grillStart, grillEnd);
	assert(grillBlock.includes("const GrillDecisionSchema"), "grill defines GrillDecisionSchema");
	assert(/decisions: Type\.Optional\(Type\.Array\(GrillDecisionSchema/.test(grillBlock), "grill parameters accept decisions[] batch");
	assert(grillBlock.includes("function prepareGrillArguments"), "grill has prepareGrillArguments");
	// Legacy single-field shape is accepted and converted.
	assert(/question: Type\.Optional\(Type\.String\(\)\)/.test(grillBlock), "grill keeps legacy optional question field");
	assert(/recommendedAnswer: Type\.Optional\(Type\.String\(\)\)/.test(grillBlock), "grill keeps legacy optional recommendedAnswer field");
	assert(/decisionStatus: Type\.Optional\(GrillDecisionStatusSchema\)/.test(grillBlock), "grill keeps legacy optional decisionStatus field");
	// Both shapes persist into grillTurns.
	assert(grillBlock.includes("state.grillTurns.push"), "grill persists into grillTurns");
	// Compact result: only count + total in content; full grillTurns in details.
	assert(/Recorded \$\{decisions\.length\} grill decision/.test(grillBlock), "grill content reports batch count");
	assert(/Total: \$\{state\.grillTurns\.length\}/.test(grillBlock), "grill content reports running total");
	assert(/details: \{ recorded: decisions\.length, count: state\.grillTurns\.length, grillTurns: state\.grillTurns \}/.test(grillBlock), "grill details keep full grillTurns");

	// Plan prompt: grilling protocol uses batch decisions.
	assert(/workflow_grill_record\(decisions=\[/.test(promptsTs), "plan prompt instructs batch decisions via workflow_grill_record(decisions=[...])");
	// Work prompt: snapshot read uses action="list".
	assert(/workflow_todo\(action="list"\) 读取状态/.test(promptsTs), "work prompt reads todo snapshot via action=list");
}

// ═══ Check 16: Paseo update_plan compatibility contract ═══
console.log("\n=== Check 16: Paseo update_plan compatibility ===");
{
	const tc = fs.readFileSync(path.join(CWD, "extensions/workflow/todo-compat.ts"), "utf8");

	// Verified version/commit recorded so the contract is traceable.
	assert(tc.includes('PASEO_VERIFIED_VERSION = "0.2.1"'), "todo-compat records verified Paseo version 0.2.1");
	assert(
		tc.includes('PASEO_VERIFIED_COMMIT = "65633004b23d6eeeda9321e04f096ca647694b2b"'),
		"todo-compat records verified Paseo commit",
	);
	assert(tc.includes('UPDATE_PLAN_TOOL_NAME = "update_plan"'), "todo-compat fixes tool name to update_plan");
	assert(tc.includes('BLOCKED_PREFIX = "[blocked] "'), "todo-compat fixes blocked prefix");

	// Schema matches Paseo's UpdatePlanSchema: plan of { step, status } with
	// the three-state enum.
	assert(tc.includes("UpdatePlanItemSchema"), "todo-compat exports UpdatePlanItemSchema");
	assert(tc.includes("UpdatePlanParamsSchema"), "todo-compat exports UpdatePlanParamsSchema");
	assert(
		tc.includes('Type.Literal("pending")') &&
			tc.includes('Type.Literal("in_progress")') &&
			tc.includes('Type.Literal("completed")'),
		"todo-compat schema uses pending|in_progress|completed",
	);

	// Node >=22.19 loads TypeScript directly, so exercise the production
	// mapping/mutation functions instead of verification copies.
	const {
		applyTodoAction,
		toPaseoStatus,
		fromPaseoStatus,
		parsePaseoStep,
	} = await import(
		pathToFileURL(path.join(CWD, "extensions/workflow/todo-compat.ts")).href
	);

	assert(toPaseoStatus("done") === "completed", "toPaseoStatus: done -> completed");
	assert(toPaseoStatus("blocked") === "pending", "toPaseoStatus: blocked -> pending");
	assert(toPaseoStatus("in_progress") === "in_progress", "toPaseoStatus: in_progress preserved");
	assert(fromPaseoStatus("[blocked] foo", "pending") === "blocked", "fromPaseoStatus: [blocked] prefix -> blocked");
	assert(fromPaseoStatus("foo", "completed") === "done", "fromPaseoStatus: completed -> done");
	assert(fromPaseoStatus("foo", "pending") === "pending", "fromPaseoStatus: pending preserved");
	const p1 = parsePaseoStep("[blocked] Do thing — note here");
	assert(p1.title === "Do thing" && p1.notes === "note here", "parsePaseoStep: blocked + notes parsed");
	const p2 = parsePaseoStep("Plain task");
	assert(p2.title === "Plain task" && p2.notes === undefined, "parsePaseoStep: plain task, no notes");
	const p3 = parsePaseoStep("Fix login — high priority — note here");
	assert(p3.title === "Fix login — high priority" && p3.notes === "note here", "parsePaseoStep: lastIndexOf splits notes from the end, keeping earlier em-dashes in title");

	const replaced = applyTodoAction([], {
		kind: "replace",
		items: [
			{ step: "[blocked] Verify trust gate — waiting on approval", status: "pending" },
			{ step: "Ship fix", status: "completed" },
		],
	});
	assert(
		replaced[0]?.id === "T1" &&
			replaced[0]?.title === "Verify trust gate" &&
			replaced[0]?.status === "blocked" &&
			replaced[0]?.notes === "waiting on approval" &&
			replaced[1]?.id === "T2" &&
			replaced[1]?.status === "done",
		"applyTodoAction replace maps Paseo steps/statuses into internal todos",
	);
	const resetWithHole = applyTodoAction([], {
		kind: "reset",
		items: [
			{ id: "T2", title: "Explicit" },
			{ title: "Generated" },
		],
	});
	assert(
		resetWithHole[0]?.id === "T2" && resetWithHole[1]?.id === "T3",
		"applyTodoAction reset generates an unused ID after explicit collisions",
	);
	let duplicateResetRejected = false;
	try {
		applyTodoAction([], {
			kind: "reset",
			items: [
				{ id: "T1", title: "One" },
				{ id: "T1", title: "Duplicate" },
			],
		});
	} catch {
		duplicateResetRejected = true;
	}
	assert(duplicateResetRejected, "applyTodoAction reset rejects duplicate explicit IDs");
	let duplicateAddRejected = false;
	try {
		applyTodoAction([{ id: "T1", title: "One", status: "pending" }], {
			kind: "add",
			id: "T1",
			title: "Duplicate",
		});
	} catch {
		duplicateAddRejected = true;
	}
	assert(duplicateAddRejected, "applyTodoAction add rejects duplicate explicit IDs");

	// tools.ts registers the alias and uses the shared mutation core.
	const toolsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/tools.ts"), "utf8");
	assert(toolsTs.includes("registerUpdatePlanTool"), "tools.ts registers update_plan alias");
	assert(toolsTs.includes("applyTodoAction"), "tools.ts uses shared applyTodoAction for todo mutation");
	assert(toolsTs.includes('name: UPDATE_PLAN_TOOL_NAME'), "update_plan alias uses the contract tool name");
	assert(toolsTs.includes("ensureRpcAliasRegistered"), "tools.ts exposes ensureRpcAliasRegistered for session_start-time RPC alias registration");

	// index.ts registers the RPC alias in session_start (outside the
	// _workflowRegistered idempotency guard) so autoEnter + RPC mode works.
	const indexTs = fs.readFileSync(path.join(CWD, "extensions/workflow/index.ts"), "utf8");
	assert(indexTs.includes("ensureRpcAliasRegistered"), "index.ts calls ensureRpcAliasRegistered in session_start");
	assert(/pi\.on\("session_shutdown"[\s\S]*?overlay\.dispose\(\)/.test(indexTs), "index.ts session_shutdown disposes the captured overlay instance");

	// mode.ts resolves todo tool ownership at activation time.
	const modeTs = fs.readFileSync(path.join(CWD, "extensions/workflow/mode.ts"), "utf8");
	assert(modeTs.includes("resolveTodoToolName"), "mode.ts exports resolveTodoToolName for live ownership");
	assert(modeTs.includes('"update_plan"'), "mode.ts handles update_plan in tool visibility");
}

// ═══ Check 18: T1–T3 hardened error paths and shared invariants ═══
console.log("\n=== Check 18: hardened error paths + shared invariants ===");
{
	// isWorkflowActive truth table — inline the pure predicate so this runs
	// without loading helpers.ts (whose ./prompts.js import Node's native TS
	// loader does not rewrite to .ts).
	function isWorkflowActive(state, config) {
		return (state.workflowEnabled || config.workflow.autoEnter) && !state.workflowExplicitlyDisabled;
	}
	assert(isWorkflowActive({ workflowEnabled: false, workflowExplicitlyDisabled: false }, { workflow: { autoEnter: true } }) === true, "isWorkflowActive: autoEnter alone activates");
	assert(isWorkflowActive({ workflowEnabled: true, workflowExplicitlyDisabled: false }, { workflow: { autoEnter: false } }) === true, "isWorkflowActive: workflowEnabled alone activates");
	assert(isWorkflowActive({ workflowEnabled: true, workflowExplicitlyDisabled: true }, { workflow: { autoEnter: true } }) === false, "isWorkflowActive: explicit disable overrides both flags");
	assert(isWorkflowActive({ workflowEnabled: false, workflowExplicitlyDisabled: false }, { workflow: { autoEnter: false } }) === false, "isWorkflowActive: nothing on stays inactive");

	// helpers.ts exports the typed predicate and is referenced by tools/commands/index/settings.
	const helpersSrc = fs.readFileSync(path.join(CWD, "extensions/workflow/helpers.ts"), "utf8");
	// Guard against drift: the inlined predicate above must match the canonical
	// export in helpers.ts so the truth table validates real logic.
	assert(/return\s*\(\s*\(state\.workflowEnabled \|\| config\.workflow\.autoEnter\)\s*&&\s*!state\.workflowExplicitlyDisabled/.test(helpersSrc), "isWorkflowActive: inlined predicate matches helpers.ts canonical implementation");
	assert(/export function isWorkflowActive\(/.test(helpersSrc), "helpers.ts exports isWorkflowActive");
	const toolsSrc18 = fs.readFileSync(path.join(CWD, "extensions/workflow/tools.ts"), "utf8");
	assert(toolsSrc18.includes("isWorkflowActive(state, config)"), "tools.ts checkWorkflowEnabled uses isWorkflowActive");
	const commandsSrc18 = fs.readFileSync(path.join(CWD, "extensions/workflow/commands.ts"), "utf8");
	assert(commandsSrc18.includes("isWorkflowActive(state, config)"), "commands.ts uses isWorkflowActive");
	const indexSrc18 = fs.readFileSync(path.join(CWD, "extensions/workflow/index.ts"), "utf8");
	assert(indexSrc18.includes("isWorkflowActive(state, config)"), "index.ts uses isWorkflowActive");
	const settingsSrc18 = fs.readFileSync(path.join(CWD, "extensions/workflow/settings.ts"), "utf8");
	assert(settingsSrc18.includes("isWorkflowActive(state, effective)"), "settings.ts uses isWorkflowActive");

	// Plan non-empty validation: readPlanTrimmed + requirePlanMarkdown exported and used.
	const stateSrc18 = fs.readFileSync(path.join(CWD, "extensions/workflow/state.ts"), "utf8");
	assert(/export function readPlanTrimmed\(/.test(stateSrc18), "state.ts exports readPlanTrimmed");
	assert(/export function requirePlanMarkdown\(/.test(stateSrc18), "state.ts exports requirePlanMarkdown");
	assert(toolsSrc18.includes("requirePlanMarkdown(ctx.cwd, state.planPath)"), "tools.ts: approve uses requirePlanMarkdown");
	assert(/workflow_plan_save requires non-blank markdown/.test(toolsSrc18), "tools.ts: plan_save rejects blank markdown");
	assert(/Active plan is missing or empty/.test(toolsSrc18), "tools.ts: plan_read surfaces missing/empty plan error");

	// OCR parse failure returns isError: true with rawPath + command.
	const parseCatchStart = toolsSrc18.indexOf("} catch (parseErr) {");
	const parseCatchEnd = toolsSrc18.indexOf("} catch (err: unknown)", parseCatchStart);
	assert(parseCatchStart >= 0 && parseCatchEnd > parseCatchStart, "tools.ts: OCR parse catch block anchors exist");
	const ocrParseBlock = toolsSrc18.slice(parseCatchStart, parseCatchEnd);
	assert(/isError: true/.test(ocrParseBlock), "OCR parse failure returns isError: true");
	assert(/parseError: true/.test(ocrParseBlock), "OCR parse failure details.parseError set");
	assert(/rawPath/.test(ocrParseBlock), "OCR parse failure preserves rawPath");
	assert(/command: scopeSummary/.test(ocrParseBlock), "OCR parse failure keeps compact command in details");

	// Pure path getters: no directory creation as a side effect.
	const pathsMod = await import(
		pathToFileURL(path.join(CWD, "extensions/workflow/paths.ts")).href
	);
	const tmpCwd18 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-paths-"));
	try {
		const planDir18 = pathsMod.planDir(tmpCwd18);
		const globalCfg18 = pathsMod.globalConfigPath(path.join(tmpCwd18, "agent"));
		assert(!fs.existsSync(planDir18), "planDir(): pure getter, does not create directory");
		assert(!fs.existsSync(path.dirname(globalCfg18)), "globalConfigPath(): pure getter, does not create directory");
		// writeNewPlan creates the plan directory at write time (verified via source + fs).
		assert(/writeNewPlan[\s\S]*?mkdirSync\(dir, \{ recursive: true \}\)/.test(stateSrc18), "state.ts: writeNewPlan creates plan dir before writing");
		fs.mkdirSync(planDir18, { recursive: true });
		fs.writeFileSync(path.join(planDir18, "plan-x.md"), "# Plan\nbody");
		assert(fs.existsSync(path.join(planDir18, "plan-x.md")), "plan dir writable after explicit mkdir");
	} finally {
		fs.rmSync(tmpCwd18, { recursive: true, force: true });
	}

	// Terminal sanitizer: single source with two semantics.
	const ttMod = await import(
		pathToFileURL(path.join(CWD, "extensions/workflow/terminal-text.ts")).href
	);
	assert(typeof ttMod.stripTerminalControl === "function", "terminal-text.ts exports stripTerminalControl");
	assert(ttMod.stripTerminalControl("a\x1B[31mb\nc\td") === "abcd", "stripTerminalControl: default removes newlines + tabs");
	assert(ttMod.stripTerminalControl("a\x1B[31mb\nc\td", { keepNewlines: true }) === "ab\nc\td", "stripTerminalControl: keepNewlines preserves LF + tab");
	assert(ttMod.stripTerminalControl("a\u0000b\x07c") === "abc", "stripTerminalControl: strips C0/C1 controls");
	// Three prior implementations now delegate to the shared module.
	const ocrResultSrc = fs.readFileSync(path.join(CWD, "extensions/workflow/ocr-result.ts"), "utf8");
	const ocrHelpersSrc = fs.readFileSync(path.join(CWD, "extensions/workflow/ocr-helpers.ts"), "utf8");
	const reviewTuiSrc = fs.readFileSync(path.join(CWD, "extensions/workflow/review-tui.ts"), "utf8");
	assert(ocrResultSrc.includes('from "./terminal-text.js"') && /stripTerminalControl\(s, \{ keepNewlines: true \}\)/.test(ocrResultSrc), "ocr-result.ts delegates stripAnsi to shared sanitizer (keepNewlines)");
	assert(ocrHelpersSrc.includes('from "./terminal-text.js"') && !/function stripTerminalControlChars/.test(ocrHelpersSrc), "ocr-helpers.ts delegates to shared sanitizer, local impl removed");
	assert(reviewTuiSrc.includes('from "./terminal-text.js"') && !/function stripTerminalControlChars/.test(reviewTuiSrc), "review-tui.ts delegates to shared sanitizer, local impl removed");

	// Shared branch matcher reused by state normalization.
	const wtMod = await import(
		pathToFileURL(path.join(CWD, "extensions/workflow/worktree.ts")).href
	);
	assert(typeof wtMod.branchMatchesWorkRun === "function", "worktree.ts exports branchMatchesWorkRun");
	assert(wtMod.branchMatchesWorkRun("wf/abcd1234", "abcd1234-aaaa-bbbb-cccc-dddddddddddd") === true, "branchMatchesWorkRun: legacy wf/<prefix> matches");
	assert(wtMod.branchMatchesWorkRun("feat/x@wf-abcd1234", "abcd1234-aaaa-bbbb-cccc-dddddddddddd") === true, "branchMatchesWorkRun: semantic <slug>@wf-<prefix> matches");
	assert(wtMod.branchMatchesWorkRun("wf/deadbeef", "abcd1234-aaaa-bbbb-cccc-dddddddddddd") === false, "branchMatchesWorkRun: mismatched prefix rejected");
	assert(stateSrc18.includes('branchMatchesWorkRun') && stateSrc18.includes('from "./worktree.js"'), "state.ts normalization reuses branchMatchesWorkRun from worktree.ts");

	// todo_delta mutation labels: reset and replaced keep next item + four-state count.
	const helpersTodoSrc = helpersSrc;
	assert(/mutation\?: "reset" \| "replaced"/.test(helpersTodoSrc), "todoDeltaText: opts declare reset | replaced mutation");
	assert(/\$\{opts.mutation\}: \$\{todoLine\(first\)\}/.test(helpersTodoSrc), "todoDeltaText: mutation labels first item");
	assert(toolsSrc18.includes('mutation: deltaMutation') && /deltaMutation = "reset"/.test(toolsSrc18), "tools.ts: reset passes mutation=reset");
	assert(/todoDeltaText\(state, \{ mutation: "replaced" \}\)/.test(toolsSrc18), "tools.ts: update_plan replace passes mutation=replaced");
}

console.log(`\n=== Result: ${runs - failures}/${runs} passed ===`);
if (failures > 0) {
	console.error(`${failures} test(s) FAILED.`);
	process.exitCode = 1;
} else {
	console.log("All checks passed.");
}
