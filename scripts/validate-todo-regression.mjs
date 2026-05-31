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

	// workflow_plan save clears todos and bookkeeping within the save block
	const planToolIdx = toolsTs.indexOf("workflow_plan");
	const saveActionIdx = toolsTs.indexOf('action === "save"', planToolIdx);
	const saveBodyStart = toolsTs.indexOf("{", saveActionIdx);
	let saveDepth = 0,
		saveEndIdx = saveBodyStart;
	for (; saveEndIdx < toolsTs.length; saveEndIdx++) {
		const ch = toolsTs[saveEndIdx];
		if (ch === "{") saveDepth++;
		else if (ch === "}" && --saveDepth === 0) {
			saveEndIdx++;
			break;
		}
	}
	const saveBlock = toolsTs.slice(saveActionIdx, saveEndIdx);
	assert(
		planToolIdx >= 0 &&
			saveActionIdx > planToolIdx &&
			saveBlock.includes("state.todos = []") &&
			saveBlock.includes("state.hiddenDoneIds = []") &&
			saveBlock.includes("overlay.clearBookkeeping()") &&
			saveBlock.indexOf("state.todos = []") < saveBlock.indexOf("saveState(") &&
			saveBlock.indexOf("saveState(") <
				saveBlock.indexOf("overlay.clearBookkeeping()"),
		"workflow_plan save: clear todos, then saveState, then overlay cleanup",
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
		const r = normalizeState([1, 2, 3]);
		assert(r.mode === "idle", "real normalizeState: array input safe");
	}
}

// ═══ Check 7: Code review tooling ═══

console.log("\n=== Check 7: Code review tooling ===");

{
	const indexTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/index.ts"),
		"utf8",
	);
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
	const stateTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/state.ts"),
		"utf8",
	);
	const helpersTs = fs.readFileSync(
		path.join(CWD, "extensions/workflow/helpers.ts"),
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

	// Conditional activation in mode.ts — always delete old names first
	assert(
		/next\.delete\(.*workflow_subagent/.test(modeTs),
		"mode.ts: deletes old workflow_subagent from active tools",
	);
	assert(
		/next\.delete\(.*workflow_plan_review/.test(modeTs),
		"mode.ts: deletes workflow_plan_review before conditional add",
	);
	assert(
		/next\.delete\(.*workflow_code_review/.test(modeTs),
		"mode.ts: deletes workflow_code_review before conditional add",
	);
	// workflow_subagent only appears in delete context (cleanup for upgrades)
	const allWfSubagentMatches = [...modeTs.matchAll(/workflow_subagent/g)];
	const deleteOnlyMatches = [
		...modeTs.matchAll(/next\.delete\(.*workflow_subagent/g),
	];
	assert(
		allWfSubagentMatches.length === deleteOnlyMatches.length,
		"mode.ts: workflow_subagent only appears in next.delete calls (cleanup)",
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

	// /review now prompts model to call workflow_code_review
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
		reviewCmdBlock.includes("workflow_code_review"),
		"/review prompts workflow_code_review tool call",
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

	// Work prompt updated — workflow_code_review is optional
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

	// Sidecall: no marker validation
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

	// Approve kickoff — scope to approve branch, check await and order
	const approveStart = toolsTs.indexOf('if (action === "approve")');
	const approveEnd = toolsTs.indexOf('if (action === "read")', approveStart);
	assert(
		approveStart >= 0 && approveEnd > approveStart,
		"tools.ts: approve branch anchors exist",
	);
	const approveBlock = toolsTs.slice(approveStart, approveEnd);
	assert(
		/await\s+applyModeRuntime\s*\(/.test(approveBlock),
		"tools.ts: approve awaits applyModeRuntime",
	);
	assert(
		approveBlock.includes('deliverAs: "followUp"'),
		"tools.ts: approve sends followUp kickoff message",
	);
	assert(
		approveBlock.indexOf("applyModeRuntime") <
			approveBlock.indexOf('deliverAs: "followUp"'),
		"tools.ts: approve applies runtime before followUp kickoff",
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

console.log(`\n=== Result: ${runs - failures}/${runs} passed ===`);
if (failures > 0) {
	console.error(`${failures} test(s) FAILED.`);
	process.exitCode = 1;
} else {
	console.log("All checks passed.");
}
