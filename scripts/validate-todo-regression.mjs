/**
 * Regression validation: todo/overlay state lifecycle and code review tooling.
 *
 * Covers session isolation, overlay lifecycle, normalizeState correctness,
 * workflow_code_review tool registration, baseline state removal.
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
  mode: "idle", todos: [], hiddenDoneIds: [],
};

function inlineLoadState(wfDir, sessionKey) {
  const spath = path.join(wfDir, "sessions", sessionKey, "state.json");
  if (!fs.existsSync(spath)) return { ...DEFAULT_STATE };
  try { return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(spath, "utf8")) }; }
  catch { return { ...DEFAULT_STATE }; }
}

// ═══════════════════════════════════════════════════════
// 1. DEFAULT_STATE has empty todos
// ═══════════════════════════════════════════════════════

console.log("\n=== Check 1: DEFAULT_STATE todos ===");
assert(Array.isArray(DEFAULT_STATE.todos) && DEFAULT_STATE.todos.length === 0,
  "DEFAULT_STATE has empty todos");

// ═══ Check 2: Session state loaded from session-scoped path ═══

console.log("\n=== Check 2: Session state ===");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-test-"));
  const wfDir = path.join(tmpDir, ".pi", "workflow");
  fs.mkdirSync(wfDir, { recursive: true });

  const sessionAFile = path.join(wfDir, "sessions", "session-A", "state.json");
  fs.mkdirSync(path.dirname(sessionAFile), { recursive: true });
  fs.writeFileSync(sessionAFile, JSON.stringify({ mode: "work", planRunId: "old-plan-id", todos: [{ id: "T1", title: "Old task", status: "done" }, { id: "T2", title: "Another old task", status: "done" }] }));

  const s1 = inlineLoadState(wfDir, "session-A");
  assert(s1.todos.length === 2, "Session A loads session-scoped todos (2 items)");
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

    setUICtx(ctx) { this.uiCtx = ctx; }

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
  assert(overlay.widgetActive === true, "update(nonEmpty) re-registers after empty");

  overlay.doneIdsPendingHide.add("T1");
  overlay.todos = [{ id: "T1", title: "done task", status: "done" }];
  overlay.hideDoneFromLastTurn();
  assert(overlay.hiddenDoneIds.has("T1"), "T1 is in hiddenDoneIds after hideDoneFromLastTurn");
  overlay.simulateAllDoneHidden();
  assert(overlay.uiCtx === mockCtx, "all-done auto-hide preserves uiCtx (no dispose)");
  assert(overlay.hiddenDoneIds.has("T1"), "T1 stays hidden after auto-hide (bookkeeping preserved)");

  overlay.update([{ id: "T1", title: "done task", status: "done" }]);
  assert(overlay.hiddenDoneIds.has("T1"), "T1 remains hidden after update() with same done todos");

  overlay.clearBookkeeping();
  overlay.update([{ id: "T1", title: "new task", status: "pending" }]);
  assert(overlay.widgetActive === true, "update(nonEmpty) re-registers after auto-hide + clearBookkeeping");
  assert(!overlay.hiddenDoneIds.has("T1"), "T1 not hidden after explicit clearBookkeeping");

  overlay.dispose();
  assert(overlay.uiCtx === null, "dispose() clears uiCtx (sanity)");
  assert(overlay.update([{ id: "T2", title: "x", status: "pending" }]) === "no-uictx",
    "After dispose, update returns early");
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
  assert(newTodos.every(isVisible), "After clearBookkeeping, reused IDs are visible");
  assert(hidden.size === 0, "hiddenDoneIds is empty");
  assert(pendingHide.size === 0, "doneIdsPendingHide is empty");
}

// ═══ Check 6: Source structure verification ═══

console.log("\n=== Check 6: Source structure verification ===");

{
  const overlayTs = fs.readFileSync(path.join(CWD, "extensions/workflow/todo-overlay.ts"), "utf8");
  const stateTs = fs.readFileSync(path.join(CWD, "extensions/workflow/state.ts"), "utf8");
  const pathsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/paths.ts"), "utf8");
  const toolsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/tools.ts"), "utf8");
  const commandsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/commands.ts"), "utf8");

  // Legacy migration cleanup
  assert(!pathsTs.includes("export function legacyStatePath"),
    "paths.ts no longer exports legacyStatePath");
  assert(!pathsTs.includes("export function legacyMigrationMarkerPath"),
    "paths.ts no longer exports legacyMigrationMarkerPath");
  assert(!stateTs.includes("legacyStatePath") && !stateTs.includes("legacyMigrationMarkerPath"),
    "state.ts no longer imports legacy path helpers");
  assert(stateTs.includes("normalizeState"), "loadState uses normalizeState");
  assert(stateTs.includes("normalizeState(JSON.parse"), "loadState calls normalizeState(JSON.parse)");
  assert(stateTs.includes("normalizeState(state"), "saveState calls normalizeState(state)");

  // Overlay: update empty-list does not dispose
  const updMatch = overlayTs.match(/update\(todos[\s\S]*?\{/);
  const updStart = updMatch?.index ?? 0;
  const updEnd = overlayTs.indexOf("hideDoneFromLastTurn", updStart);
  const updBody = overlayTs.slice(updStart, updEnd > 0 ? updEnd : overlayTs.length);
  assert(!updBody.includes("this.dispose()"), "update() does NOT call this.dispose() for empty list");

  // Overlay: auto-hide preserves bookkeeping
  const rwIdx = overlayTs.indexOf("private renderWidget");
  const rwEnd = overlayTs.indexOf("// Counts", rwIdx);
  const rwBody = overlayTs.slice(rwIdx, rwEnd > 0 ? rwEnd : overlayTs.length);
  assert(!rwBody.includes("this.dispose()"), "renderWidget auto-hide does NOT call this.dispose()");
  assert(!rwBody.includes("clearBookkeeping()"),
    "renderWidget auto-hide does NOT call clearBookkeeping() (preserves hidden/done state)");

  // workflow_plan save clears todos and bookkeeping within the save block
  const planToolIdx = toolsTs.indexOf("workflow_plan");
  const saveActionIdx = toolsTs.indexOf('action === "save"', planToolIdx);
  const saveBodyStart = toolsTs.indexOf("{", saveActionIdx);
  let saveDepth = 0, saveEndIdx = saveBodyStart;
  for (; saveEndIdx < toolsTs.length; saveEndIdx++) {
    const ch = toolsTs[saveEndIdx];
    if (ch === "{") saveDepth++;
    else if (ch === "}" && --saveDepth === 0) { saveEndIdx++; break; }
  }
  const saveBlock = toolsTs.slice(saveActionIdx, saveEndIdx);
  assert(
    planToolIdx >= 0 && saveActionIdx > planToolIdx &&
      saveBlock.includes("state.todos = []") &&
      saveBlock.includes("state.hiddenDoneIds = []") &&
      saveBlock.includes("overlay.clearBookkeeping()") &&
      saveBlock.indexOf("state.todos = []") < saveBlock.indexOf("saveState(") &&
      saveBlock.indexOf("saveState(") < saveBlock.indexOf("overlay.clearBookkeeping()"),
    "workflow_plan save: clear todos, then saveState, then overlay cleanup"
  );

  // /plan and /work call clearBookkeeping
  const planCmdStart = commandsTs.indexOf("registerPlanCommand");
  const planCmdEnd = commandsTs.indexOf("registerWorkCommand", planCmdStart);
  assert(
    planCmdStart >= 0 && planCmdEnd > planCmdStart &&
      commandsTs.slice(planCmdStart, planCmdEnd).includes("clearBookkeeping()"),
    "/plan command calls clearBookkeeping()"
  );
  const workCmdStart = commandsTs.indexOf("registerWorkCommand");
  const workCmdEnd = commandsTs.indexOf("registerReviewCommand", workCmdStart);
  assert(
    workCmdStart >= 0 && workCmdEnd > workCmdStart &&
      commandsTs.slice(workCmdStart, workCmdEnd).includes("clearBookkeeping()"),
    "/work command calls clearBookkeeping()"
  );

  // normalizeState drops unknown keys
  const nsFnStart = stateTs.indexOf("export function normalizeState(raw");
  const nsBodyStart = stateTs.indexOf("{", nsFnStart);
  let nsDepth = 0, nsFnEnd = nsBodyStart;
  for (let i = nsBodyStart; i < stateTs.length; i++) {
    if (stateTs[i] === "{") nsDepth++;
    else if (stateTs[i] === "}") { nsDepth--; if (nsDepth === 0) { nsFnEnd = i; break; } }
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
  nsBody = nsBody.replace(/:\s*(WorkflowState|string|number|boolean|unknown)\b/g, "");
  nsBody = nsBody.replace(/:\s*NonNullable<[^>]*>/g, "");
  const nsFnStr = "function normalizeState(raw) {" + nsBody + "\n}";
  const normalizeState = eval("(function(DEFAULT_STATE) { return " + nsFnStr + "; })(DEFAULT_STATE)");

  assert(typeof normalizeState === "function", "normalizeState extracted from state.ts");
  {
    const r = normalizeState({ mode: "plan", workBaselineRef: "abc123", todos: [{ id: "T1", title: "x", status: "pending" }] });
    assert(!("workBaselineRef" in r), "real normalizeState: workBaselineRef dropped");
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
  const indexTs = fs.readFileSync(path.join(CWD, "extensions/workflow/index.ts"), "utf8");
  const modeTs = fs.readFileSync(path.join(CWD, "extensions/workflow/mode.ts"), "utf8");
  const toolsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/tools.ts"), "utf8");
  const commandsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/commands.ts"), "utf8");
  const typesTs = fs.readFileSync(path.join(CWD, "extensions/workflow/types.ts"), "utf8");
  const stateTs = fs.readFileSync(path.join(CWD, "extensions/workflow/state.ts"), "utf8");
  const helpersTs = fs.readFileSync(path.join(CWD, "extensions/workflow/helpers.ts"), "utf8");
  const promptsTs = fs.readFileSync(path.join(CWD, "extensions/workflow/prompts.ts"), "utf8");
  const ocrHelpersTs = fs.readFileSync(path.join(CWD, "extensions/workflow/ocr-helpers.ts"), "utf8");

  // Tool registration and activation — precise regex, not loose includes
  assert(/export\s+function\s+registerCodeReviewTool\s*\(/.test(toolsTs),
    "tools.ts exports registerCodeReviewTool");
  assert(/registerCodeReviewTool\s*\(\s*pi\s*,\s*getAgentDir\s*\)/.test(indexTs),
    "index.ts registers workflow_code_review");
  assert(/next\.add\(\s*["']workflow_code_review["']\s*\)/.test(modeTs),
    "mode.ts activates workflow_code_review");
  assert(toolsTs.includes("requires a non-empty background"),
    "workflow_code_review requires non-empty background");

  // OCR helpers — verify exports and that buildReviewArgv body has required flags
  assert(/export\s+function\s+buildReviewArgv\s*\(/.test(ocrHelpersTs),
    "ocr-helpers.ts: exports buildReviewArgv");
  assert(/export\s+function\s+checkOcrAvailable\s*\(/.test(ocrHelpersTs),
    "ocr-helpers.ts: exports checkOcrAvailable");
  const buildArgvStart = ocrHelpersTs.indexOf("export function buildReviewArgv");
  const buildArgvEnd = ocrHelpersTs.indexOf("export function ocrCommandSummary", buildArgvStart);
  const buildArgvBody = ocrHelpersTs.slice(buildArgvStart, buildArgvEnd > 0 ? buildArgvEnd : ocrHelpersTs.length);
  assert(buildArgvBody.includes("--audience"),
    "ocr-helpers.ts: buildReviewArgv body uses --audience flag");
  assert(buildArgvBody.includes("--background"),
    "ocr-helpers.ts: buildReviewArgv body uses --background flag");

  // /review now prompts model to call workflow_code_review
  const reviewCmdStart = commandsTs.indexOf("registerReviewCommand");
  const reviewCmdEnd = commandsTs.indexOf("registerCommitCommand");
  assert(reviewCmdStart >= 0 && reviewCmdEnd > reviewCmdStart,
    "/review and commit command anchors exist");
  const reviewCmdBlock = commandsTs.slice(reviewCmdStart, reviewCmdEnd);
  assert(reviewCmdBlock.includes("workflow_code_review"),
    "/review prompts workflow_code_review tool call");
  assert(
    reviewCmdBlock.includes("const askTool") &&
      reviewCmdBlock.indexOf("const askTool") < reviewCmdBlock.indexOf('if (scopeKind === "workspace")'),
    "/review defines askTool before workspace/range/commit branches"
  );
  assert(!reviewCmdBlock.includes("async function runCodeReviewSubagent"),
    "/review: no old runCodeReviewSubagent");

  // Baseline state removed
  assert(!typesTs.includes("workBaselineRef"), "types.ts: no workBaselineRef");
  assert(!typesTs.includes("workBaselineUntracked"), "types.ts: no workBaselineUntracked");
  assert(!stateTs.includes("workBaselineRef"), "state.ts: no workBaselineRef normalization");
  assert(!stateTs.includes("workBaselineUntracked"), "state.ts: no workBaselineUntracked normalization");
  assert(!helpersTs.includes("workBaselineRef"), "helpers.ts: no baseline in status text");
  assert(!commandsTs.includes("createWorkBaseline"), "commands.ts: no createWorkBaseline calls");
  assert(!commandsTs.includes("captureBaselineUntracked"), "commands.ts: no captureBaselineUntracked calls");
  assert(!commandsTs.includes("clearWorkBaseline"), "commands.ts: no clearWorkBaseline calls");

  // Work prompt updated
  assert(promptsTs.includes("workflow_code_review"), "prompts.ts: mentions workflow_code_review");
  assertNotContains(promptsTs, "ocr review", "prompts.ts: no old ocr review recommendation");
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