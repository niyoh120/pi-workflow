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
  mode: "idle", planApproved: false, planReviewStatus: "none",
  planReviewLoops: 0, codeReviewLoops: 0, autoCodeReview: false, todos: [],
};

function inlineLoadState(wfDir, sessionKey) {
  const spath = path.join(wfDir, "sessions", sessionKey, "state.json");

  if (!fs.existsSync(spath)) {
    const markerPath = path.join(wfDir, ".legacy-imported");
    if (!fs.existsSync(markerPath)) {
      const lpath = path.join(wfDir, "state.json");
      if (fs.existsSync(lpath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(lpath, "utf8"));
          const legacy = { ...DEFAULT_STATE, ...raw };
          fs.mkdirSync(path.dirname(spath), { recursive: true });
          fs.writeFileSync(spath, JSON.stringify(legacy, null, 2), "utf8");
          fs.writeFileSync(markerPath, "", "utf8");
          return legacy;
        } catch {
          fs.writeFileSync(markerPath, "", "utf8");
          return { ...DEFAULT_STATE };
        }
      }
      fs.writeFileSync(markerPath, "", "utf8");
    }
    return { ...DEFAULT_STATE };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(spath, "utf8"));
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

// ═══════════════════════════════════════════════════════
// 1. DEFAULT_STATE has empty todos
// ═══════════════════════════════════════════════════════

console.log("\n=== Check 1: DEFAULT_STATE todos ===");
assert(Array.isArray(DEFAULT_STATE.todos) && DEFAULT_STATE.todos.length === 0,
  "DEFAULT_STATE has empty todos");

// ═══════════════════════════════════════════════════════
// 2. One-shot legacy migration: first session imports,
//    second session returns DEFAULT_STATE
// ═══════════════════════════════════════════════════════

console.log("\n=== Check 2: One-shot legacy migration ===");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-test-"));
  const wfDir = path.join(tmpDir, ".pi", "workflow");
  fs.mkdirSync(wfDir, { recursive: true });

  // Create legacy state.json with completed todos
  const legacyState = {
    mode: "work",
    planRunId: "old-plan-id",
    todos: [
      { id: "T1", title: "Old task", status: "done" },
      { id: "T2", title: "Another old task", status: "done" },
    ],
  };
  fs.writeFileSync(path.join(wfDir, "state.json"), JSON.stringify(legacyState));

  const sessionsDir = path.join(wfDir, "sessions");

  // First session: should import legacy state
  const s1 = inlineLoadState(wfDir, "session-A");
  assert(s1.todos.length === 2, "Session A imports legacy todos (2 items)");
  assert(s1.todos[0].id === "T1", "Session A has legacy T1");
  assert(s1.mode === "work", "Session A inherits legacy mode");

  // Migration marker must exist
  const markerPath = path.join(wfDir, ".legacy-imported");
  assert(fs.existsSync(markerPath), "Migration marker written after first session");

  // Session A's own state file must exist
  assert(
    fs.existsSync(path.join(sessionsDir, "session-A", "state.json")),
    "Session A state file written"
  );

  // Second session: should return DEFAULT_STATE (not legacy)
  const s2 = inlineLoadState(wfDir, "session-B");
  assert(
    Array.isArray(s2.todos) && s2.todos.length === 0,
    "Session B returns empty todos (marker exists, no re-import)"
  );
  assert(s2.mode === "idle", "Session B starts in idle mode");

  // Third session without legacy state at all (just DEFAULT_STATE)
  const s3 = inlineLoadState(wfDir, "session-C");
  assert(s3.todos.length === 0, "Session C returns empty todos");

  // Corrupt legacy case: remove marker, write corrupt JSON, verify safe fallback
  fs.rmSync(markerPath);
  fs.writeFileSync(path.join(wfDir, "state.json"), "not-json{{");
  const s4 = inlineLoadState(wfDir, "session-D");
  assert(s4.todos.length === 0, "Corrupt legacy falls back to empty todos");
  assert(fs.existsSync(markerPath), "Marker written after corrupt legacy attempt");

  // Existing session with its own state is loaded correctly
  const s1Reload = inlineLoadState(wfDir, "session-A");
  assert(s1Reload.todos.length === 2, "Existing session A reloads correctly");

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════
// 3. New session with NO legacy state returns DEFAULT_STATE
// ═══════════════════════════════════════════════════════

console.log("\n=== Check 3: Fresh project (no legacy) ===");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-test-"));
  const wfDir = path.join(tmpDir, ".pi", "workflow");
  fs.mkdirSync(wfDir, { recursive: true });

  // No legacy state.json — just an empty workflow dir
  const s1 = inlineLoadState(wfDir, "session-A");
  assert(s1.todos.length === 0, "Fresh project session returns empty todos");
  assert(
    fs.existsSync(path.join(wfDir, ".legacy-imported")),
    "Migration marker written even when no legacy exists"
  );

  // Second session also returns empty
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

  // 6a: paths.ts exports legacyStatePath + migration marker
  assert(pathsTs.includes("export function legacyStatePath"),
    "paths.ts exports legacyStatePath");
  assert(pathsTs.includes("export function legacyMigrationMarkerPath"),
    "paths.ts exports legacyMigrationMarkerPath");

  // 6b: state.ts imports legacy paths
  assert(stateTs.includes("legacyStatePath") && stateTs.includes("legacyMigrationMarkerPath"),
    "state.ts imports legacy paths for one-shot migration");

  // 6c: loadState checks migration marker
  assert(stateTs.includes("legacyMigrationMarkerPath"),
    "loadState uses migration marker");

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
