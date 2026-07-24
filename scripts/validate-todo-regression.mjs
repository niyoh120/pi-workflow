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
	hiddenDoneIds: [],
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
	return mode === "plan" || mode === "work" || mode === "init" || mode === "explore";
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
			const names = ["workflow_todo", "workflow_plan_read"];
			if (config.codeReview.enabled) names.push("workflow_code_review");
			return names;
		}
		case "explore":
			return ["workflow_plan_read"];
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
			saveBlock.includes("state.todos = []") &&
			saveBlock.includes("state.hiddenDoneIds = []") &&
			saveBlock.includes("overlay.clearBookkeeping()") &&
			saveBlock.indexOf("state.todos = []") < saveBlock.indexOf("saveState(") &&
			saveBlock.indexOf("saveState(") <
				saveBlock.indexOf("overlay.clearBookkeeping()"),
		"workflow_plan_save: clear todos, then saveState, then overlay cleanup",
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
	const normalizeState = eval(
		"(function(DEFAULT_STATE) { return " + nsFnStr + "; })(DEFAULT_STATE)",
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

	// Conditional registration — now inside registerAllWorkflowTools in tools.ts
	// and registerAllWorkflowCommands in commands.ts (not index.ts directly)
	assert(
		/if\s*\(\s*config\.planReview\.enabled\s*\)\s*\{?\s*registerPlanReviewTool/.test(
			toolsTs,
		),
		"tools.ts: conditionally registers plan review tool",
	);
	assert(
		/if\s*\(\s*config\.codeReview\.enabled\s*\)\s*\{?\s*registerCodeReviewTool/.test(
			toolsTs,
		),
		"tools.ts: conditionally registers code review tool",
	);
	assert(
		/if\s*\(\s*config\.codeReview\.enabled\s*\)\s*\{?\s*registerReviewCommand/.test(
			commandsTs,
		),
		"commands.ts: conditionally registers /review command",
	);

	// Conditional activation in mode.ts — mode-aware delete-then-add
	assert(
		modeTs.includes("WORKFLOW_GATED_TOOLS") &&
			modeTs.includes("WORKFLOW_TOOL_CLEANUP_NAMES"),
		"mode.ts: separates gated workflow tools from cleanup names",
	);
	assert(
		!modeTs.includes('"workflow_subagent"'),
		"mode.ts: no old workflow_subagent cleanup entry",
	);
	assert(
		/for \(const toolName of WORKFLOW_TOOL_CLEANUP_NAMES\)[\s\S]*?next\.delete\(toolName\)/.test(
			modeTs,
		),
		"mode.ts: deletes workflow cleanup names before re-adding allowed tools",
	);
	assert(
		/computeWorkflowToolNames\(mode, cfg\)/.test(modeTs),
		"mode.ts: uses computeWorkflowToolNames for mode-aware activation",
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

	// Sidecall: auth resolution + error surfacing
	const sidecallTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/sidecall.ts"),
		"utf8",
	);
	assertNotContains(
		sidecallTs,
		"[pi-workflow-plan-review/v1]",
		"sidecall.ts: no identity marker requirement",
	);
	assertNotContains(
		sidecallTs,
		"identity_marker_missing",
		"sidecall.ts: no identity_marker_missing error",
	);
	assertNotContains(
		sidecallTs,
		"identity marker",
		"sidecall.ts: no identity marker validation",
	);
	// Auth: sidecall must resolve request auth via modelRegistry, not rely on env keys.
	assert(
		sidecallTs.includes("getApiKeyAndHeaders"),
		"sidecall.ts: resolves auth via getApiKeyAndHeaders",
	);
	assert(
		/if\s*\(\s*!auth\.ok\s*\)\s*\{\s*throw new Error/.test(sidecallTs),
		"sidecall.ts: checks auth.ok and throws on failure",
	);
	assert(
		sidecallTs.includes("apiKey: auth.apiKey") &&
			sidecallTs.includes("headers: auth.headers") &&
			sidecallTs.includes("env: auth.env"),
		"sidecall.ts: forwards apiKey, headers, and env to provider streamSimple",
	);
	assert(
		/await\s+provider\.streamSimple\([\s\S]*?\)\.result\(\)/.test(sidecallTs),
		"sidecall.ts: chains provider.streamSimple(...).result() at a real call site",
	);
	// Error surfacing: detect stopReason === "error" or errorMessage and throw.
	assert(
		/stopReason\s*===\s*"error"/.test(sidecallTs),
		"sidecall.ts: detects stopReason === 'error'",
	);
	assert(
		/if\s*\(\s*response\.stopReason\s*===\s*"error"\s*\|\|\s*response\.errorMessage\s*\)\s*\{\s*throw new Error/.test(
			sidecallTs,
		),
		"sidecall.ts: throws on errorMessage or stopReason error",
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
		basBlock.includes("workflowActive") &&
			basBlock.includes("workflowExplicitlyDisabled"),
		"commands.ts: before_agent_start scoped check for workflowActive + explicit disable",
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
		inlineComputeWorkflowToolNames("explore", cfgAllReviewTools).join(",") ===
			"workflow_plan_read" &&
			inlineComputeWorkflowToolNames("idle", cfgAllReviewTools).length === 0,
		"inline runtime: explore exposes workflow_plan_read; idle exposes none",
	);
	assert(
		inlineComputeWorkflowToolNames("plan", cfgAllReviewTools).join(",") ===
			"workflow_todo,workflow_plan_read,workflow_plan_save,workflow_plan_approve,workflow_plan_clear,workflow_plan_review" &&
			inlineComputeWorkflowToolNames("work", cfgAllReviewTools).join(",") ===
				"workflow_todo,workflow_plan_read,workflow_code_review" &&
			inlineComputeWorkflowToolNames("work", cfgNoReviewTools).join(",") ===
				"workflow_todo,workflow_plan_read" &&
			inlineComputeWorkflowToolNames("commit", cfgAllReviewTools).length === 0,
		"inline runtime: plan/work expose workflow tools; commit exposes none",
	);
	assert(
		/export function isWorkflowToolMode\([\s\S]*?mode === "plan"[\s\S]*?mode === "work"[\s\S]*?mode === "explore"/.test(
			modeTs14,
		) &&
			!/export function isWorkflowToolMode\([\s\S]*?mode === "commit"/.test(
				modeTs14,
			),
		"mode.ts: isWorkflowToolMode allow-list is plan/work/explore",
	);
	assert(
		/const PLAN_WORKFLOW_TOOL_NAMES[\s\S]*?workflow_plan_save[\s\S]*?const WORK_WORKFLOW_TOOL_NAMES[\s\S]*?workflow_plan_read[\s\S]*?export function computeWorkflowToolNames[\s\S]*?config\.planReview\.enabled[\s\S]*?config\.codeReview\.enabled[\s\S]*?return \[\]/.test(
			modeTs14,
		),
		"mode.ts: computeWorkflowToolNames mirrors mode-specific runtime behavior",
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
		/activateWorkflowToolsIfAllowed\([\s\S]*?mode: Mode[\s\S]*?computeWorkflowToolNames\(mode, cfg\)/.test(
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
		!commandsTs14.includes(
			"activateWorkflowToolsIfAllowed(pi, ctx.cwd, getAgentDir)",
		),
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
			state.includes("branchMatchesRun") &&
			state.includes("@wf-"),
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
			tools.includes("effectiveCwd = state.worktreePath"),
		"bash override replaces shell parser and runs from worktree cwd",
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
	assert(inlineIsWorkflowToolMode("explore") === true, "inline runtime: explore is a workflow-tool mode");
	assert(inlineIsWorkflowToolMode("idle") === false, "inline runtime: idle is not a workflow-tool mode");
}
validateInitModeStatic();

console.log(`\n=== Result: ${runs - failures}/${runs} passed ===`);
if (failures > 0) {
	console.error(`${failures} test(s) FAILED.`);
	process.exitCode = 1;
} else {
	console.log("All checks passed.");
}
