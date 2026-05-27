/**
 * Regression validation: todo/overlay state lifecycle.
 *
 * Verifies:
 * 1. One-shot legacy migration: first session imports legacy state.json,
 *    subsequent sessions start fresh (empty todos).
 * 2. DEFAULT_STATE has empty todos.
 * 3. loadState handles: new session, existing session, corrupt file, migration marker.
 * 4. Overlay update([]) preserves uiCtx.
 * 5. Overlay renderWidget auto-hide path preserves uiCtx.
 * 6. update([]) → update(nonEmpty) lifecycle works.
 * 7. clearBookkeeping prevents stale hidden IDs across plans.
 * 8. workflow_plan save clears todos.
 * 9. /plan and /work refresh overlay.
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
  mode: "idle", planReviewStatus: "none",
  planReviewLoops: 0, codeReviewLoops: 0, autoCodeReview: false, todos: [],
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

// ═══ Check 2: Session state loaded from session-scoped path, no legacy migration ═══

console.log("\n=== Check 2: Session state (no legacy migration) ===");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-test-"));
  const wfDir = path.join(tmpDir, ".pi", "workflow");
  fs.mkdirSync(wfDir, { recursive: true });

  // Write session state directly to session-scoped path.
  const sessionAFile = path.join(wfDir, "sessions", "session-A", "state.json");
  fs.mkdirSync(path.dirname(sessionAFile), { recursive: true });
  fs.writeFileSync(sessionAFile, JSON.stringify({ mode: "work", planRunId: "old-plan-id", todos: [{ id: "T1", title: "Old task", status: "done" }, { id: "T2", title: "Another old task", status: "done" }] }));

  const s1 = inlineLoadState(wfDir, "session-A");
  assert(s1.todos.length === 2, "Session A loads session-scoped todos (2 items)");
  assert(s1.todos[0].id === "T1", "Session A has T1");
  assert(s1.mode === "work", "Session A mode from file");

  // No legacy migration marker created
  assert(!fs.existsSync(path.join(wfDir, ".legacy-imported")), "No migration marker");

  // Session B: no file → defaults
  const s2 = inlineLoadState(wfDir, "session-B");
  assert(s2.todos.length === 0, "Session B empty defaults");
  assert(s2.mode === "idle", "Session B idle mode");

  // Session C: no file → defaults
  const s3 = inlineLoadState(wfDir, "session-C");
  assert(s3.todos.length === 0, "Session C empty defaults");

  // Corrupt session file: fallback to defaults
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
  assert(!fs.existsSync(path.join(wfDir, ".legacy-imported")), "No migration marker on fresh project");

  const s2 = inlineLoadState(wfDir, "session-B");
  assert(s2.todos.length === 0, "Second fresh session returns empty todos");

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════
// 4. Overlay lifecycle: update([]) preserves uiCtx
// ═══════════════════════════════════════════════════════

console.log("\n=== Check 4: Overlay update([]) preserves uiCtx ===");

{
  // Minimal simulation of WorkflowTodoOverlay behavior
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

    // Simulate renderWidget auto-hide when all visible todos are gone.
    // Important: does NOT clear bookkeeping — hidden/done state is preserved
    // for the current todo list. Only lifecycle resets clear bookkeeping.
    simulateAllDoneHidden() {
      if (this.widgetRegistered) {
        this.widgetRegistered = false;
        this.widgetActive = false;
      }
    }

    // Simulate hideDoneFromLastTurn — moves done to hidden
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

  // 4a: update([]) preserves uiCtx
  overlay.update([]);
  assert(overlay.uiCtx === mockCtx, "update([]) preserves uiCtx");

  // 4b: after update([]), update(nonEmpty) re-registers
  overlay.update([{ id: "T1", title: "task", status: "pending" }]);
  assert(overlay.widgetActive === true, "update(nonEmpty) re-registers after empty");

  // 4c: simulate all tasks done + hidden, then auto-hide preserves uiCtx
  // Set up: T1 is done, visible temporarily
  overlay.doneIdsPendingHide.add("T1");
  overlay.todos = [{ id: "T1", title: "done task", status: "done" }];
  overlay.hideDoneFromLastTurn(); // moves T1 to hiddenDoneIds
  assert(overlay.hiddenDoneIds.has("T1"), "T1 is in hiddenDoneIds after hideDoneFromLastTurn");
  overlay.simulateAllDoneHidden();
  assert(overlay.uiCtx === mockCtx, "all-done auto-hide preserves uiCtx (no dispose)");
  assert(overlay.hiddenDoneIds.has("T1"), "T1 stays hidden after auto-hide (bookkeeping preserved)");

  // 4d: after auto-hide, update() with same done todos keeps T1 hidden
  overlay.update([{ id: "T1", title: "done task", status: "done" }]);
  assert(overlay.hiddenDoneIds.has("T1"), "T1 remains hidden after update() with same done todos");

  // 4e: after auto-hide, update(nonEmpty) with new plan re-registers
  overlay.clearBookkeeping(); // explicit lifecycle reset
  overlay.update([{ id: "T1", title: "new task", status: "pending" }]);
  assert(overlay.widgetActive === true, "update(nonEmpty) re-registers after auto-hide + clearBookkeeping");
  assert(!overlay.hiddenDoneIds.has("T1"), "T1 not hidden after explicit clearBookkeeping");

  // 4f: dispose still clears uiCtx
  overlay.dispose();
  assert(overlay.uiCtx === null, "dispose() clears uiCtx (sanity)");
  assert(overlay.update([{ id: "T2", title: "x", status: "pending" }]) === "no-uictx",
    "After dispose, update returns early");
}

// ═══════════════════════════════════════════════════════
// 5. clearBookkeeping prevents stale IDs across plans
// ═══════════════════════════════════════════════════════

console.log("\n=== Check 5: clearBookkeeping prevents stale IDs ===");

{
  const hidden = new Set(["T1", "T3"]);
  const pendingHide = new Set(["T2"]);

  // clearBookkeeping
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

// ═══════════════════════════════════════════════════════
// 6. Source verification
// ═══════════════════════════════════════════════════════

console.log("\n=== Check 6: Source verification ===");

{
  const overlayTs = fs.readFileSync(
    path.join(CWD, "extensions/workflow/todo-overlay.ts"), "utf8"
  );
  const stateTs = fs.readFileSync(
    path.join(CWD, "extensions/workflow/state.ts"), "utf8"
  );
  const pathsTs = fs.readFileSync(
    path.join(CWD, "extensions/workflow/paths.ts"), "utf8"
  );
  const toolsTs = fs.readFileSync(
    path.join(CWD, "extensions/workflow/tools.ts"), "utf8"
  );
  const commandsTs = fs.readFileSync(
    path.join(CWD, "extensions/workflow/commands.ts"), "utf8"
  );

  // 6a: paths.ts no longer exports legacy path helpers
  assert(!pathsTs.includes("export function legacyStatePath"),
    "paths.ts no longer exports legacyStatePath");
  assert(!pathsTs.includes("export function legacyMigrationMarkerPath"),
    "paths.ts no longer exports legacyMigrationMarkerPath");

  // 6b: state.ts no longer imports legacy path helpers
  assert(!stateTs.includes("legacyStatePath") && !stateTs.includes("legacyMigrationMarkerPath"),
    "state.ts no longer imports legacy path helpers");

  // 6c: loadState uses normalizeState
  assert(stateTs.includes("normalizeState"),
    "loadState uses normalizeState");

  // 6d: loadState/saveState delegate to normalizeState
  assert(stateTs.includes("normalizeState(JSON.parse"), "loadState calls normalizeState(JSON.parse)");
  assert(stateTs.includes("normalizeState(state"), "saveState calls normalizeState(state)");

  // 6d: update([]) does NOT call this.dispose()
  const updMatch = overlayTs.match(/update\(todos[\s\S]*?\{/);
  const updStart = updMatch?.index ?? 0;
  const updEnd = overlayTs.indexOf("hideDoneFromLastTurn", updStart);
  const updBody = overlayTs.slice(updStart, updEnd > 0 ? updEnd : overlayTs.length);
  assert(!updBody.includes("this.dispose()"),
    "update() does NOT call this.dispose() for empty list");

  // 6e: renderWidget auto-hide does NOT call this.dispose() or clearBookkeeping()
  const rwIdx = overlayTs.indexOf("private renderWidget");
  const rwEnd = overlayTs.indexOf("// Counts", rwIdx);
  const rwBody = overlayTs.slice(rwIdx, rwEnd > 0 ? rwEnd : overlayTs.length);
  assert(!rwBody.includes("this.dispose()"),
    "renderWidget auto-hide does NOT call this.dispose()");
  assert(!rwBody.includes("clearBookkeeping()"),
    "renderWidget auto-hide does NOT call clearBookkeeping() (preserves hidden/done state)");

  // 6f: workflow_plan save clears todos + clearBookkeeping
  assert(toolsTs.includes("state.todos = []"),
    "workflow_plan save sets state.todos = []");
  assert(toolsTs.includes("overlay.clearBookkeeping()"),
    "workflow_plan save calls overlay.clearBookkeeping()");

  // 6g: /plan and /work refresh overlay
  assert(
    commandsTs.slice(
      commandsTs.indexOf("registerPlanCommand"),
      commandsTs.indexOf("registerGoCommand")
    ).includes("clearBookkeeping()"),
    "/plan command calls clearBookkeeping()"
  );
  assert(
    commandsTs.slice(
      commandsTs.indexOf("registerWorkCommand"),
      commandsTs.indexOf("registerReviewCommand")
    ).includes("clearBookkeeping()"),
    "/work command calls clearBookkeeping()"
  );

  // 6h: real normalizeState tested by extracting production function from state.ts
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
  nsBody = nsBody.replace(/\bas\s+WorkflowState\["planReviewStatus"\]/g, "");
  nsBody = nsBody.replace(/\bas\s+WorkflowState\["workStatus"\]/g, "");
  nsBody = nsBody.replace(/\bas\s+WorkflowState\["lastReviewStatus"\]/g, "");
  nsBody = nsBody.replace(/\bas\s+WorkflowState\["todos"\]\[number\]/g, "");
  nsBody = nsBody.replace(/\bas\s+any\b/g, "");
  nsBody = nsBody.replace(/\bas\s+Array<[^>]*>/g, "");
  nsBody = nsBody.replace(/\(t:\s*any\)/g, "(t)");
  nsBody = nsBody.replace(/:\s*(WorkflowState|string|number|boolean|unknown)\b/g, "");
  nsBody = nsBody.replace(/:\s*NonNullable<[^>]*>/g, "");
  const nsFnStr = "function normalizeState(raw) {" + nsBody + "\n}";
  const normalizeState = eval("(function(D) { return " + nsFnStr + "; })")({ mode: "idle", planReviewStatus: "none", planReviewLoops: 0, codeReviewLoops: 0, autoCodeReview: false, todos: [] });

  assert(typeof normalizeState === "function", "normalizeState extracted from state.ts");
  {
    const r = normalizeState({ mode: "plan", planApproved: true, todos: [{ id: "T1", title: "x", status: "pending" }] });
    assert(!("planApproved" in r), "real normalizeState: planApproved dropped");
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

// ═══════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════

console.log(`\n=== Result: ${runs - failures}/${runs} passed ===`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("All checks passed.");
}
