#!/usr/bin/env node

/**
 * Deterministic checks for pi-workflow subagent diagnostics.
 *
 * Validates the actual TypeScript source files (rather than mirrored logic)
 * to ensure structural invariants are maintained: guard clauses, operation
 * ordering, and state-transition correctness.
 *
 * Usage:  node scripts/check-subagent-diagnostics.mjs
 */

import { readFileSync } from "node:fs";

// ── Helpers ────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

function assertContains(haystack, needle, label) {
  if (haystack.includes(needle)) { passed++; }
  else { failed++; console.error(`  FAIL: ${label} — expected "${needle}"`); }
}

function assertNotContains(haystack, needle, label) {
  if (!haystack.includes(needle)) { passed++; }
  else { failed++; console.error(`  FAIL: ${label} — unexpected "${needle}"`); }
}

function assertPattern(haystack, pattern, label) {
  if (pattern.test(haystack)) { passed++; }
  else { failed++; console.error(`  FAIL: ${label} — pattern not found`); }
}

// ── Load source files ──────────────────────────────────────

const subagentSrc = readFileSync("extensions/workflow/subagent.ts", "utf8");
const commandsSrc = readFileSync("extensions/workflow/commands.ts", "utf8");
const defaultsSrc = readFileSync("extensions/workflow/defaults.ts", "utf8");
const typesSrc = readFileSync("extensions/workflow/types.ts", "utf8");
const workHandoffSrc = readFileSync("extensions/workflow/work-handoff.ts", "utf8");
const modeSrc = readFileSync("extensions/workflow/mode.ts", "utf8");
const guardsSrc = readFileSync("extensions/workflow/guards.ts", "utf8");
const toolsSrc = readFileSync("extensions/workflow/tools.ts", "utf8");

// ── 1. Timeout defaults ────────────────────────────────────

console.log("1. Timeout defaults");

// DEFAULT_CONFIG.resultTimeoutMs is 600000
assertContains(defaultsSrc, "resultTimeoutMs: 600_000", "DEFAULT_CONFIG: resultTimeoutMs = 600000");

// spawnAndWait hard-coded fallback is 600000
assertContains(subagentSrc, "?? 600_000", "spawnAndWait: hard-coded fallback is 600000");

// ── 2. Timeout only installed when resultTimeoutMs > 0 ─────

console.log("2. resultTimeoutMs > 0 guard");

// The guard must exist in spawnAndWait
assertContains(subagentSrc, "resultTimeoutMs > 0", "spawnAndWait: guard 'resultTimeoutMs > 0' exists");

// The guard is followed by setTimeout (must be in same function scope)
assertPattern(
  subagentSrc,
  /resultTimeoutMs\s*>\s*0\s*\)\s*\{[\s\S]*?setTimeout/s,
  "spawnAndWait: setTimeout appears after resultTimeoutMs > 0 guard"
);

// ── 3. Agent id tracking in spawn reply ────────────────────

console.log("3. Agent id tracking");

assertContains(subagentSrc, "spawnedAgentId = agentId", "spawnAndWait: agentId captured from spawn reply");
assertContains(subagentSrc, "let spawnedAgentId =", "spawnAndWait: spawnedAgentId variable declared");

// spawnedAgentId used in SubagentTimeoutError constructor
assertContains(subagentSrc, "SubagentTimeoutError(spawnedAgentId", "spawnAndWait: timeout uses spawnedAgentId");

// ── 4. Terminal error checked before identity-marker validation ──

console.log("4. Terminal error ordering");

// The isError check MUST appear BEFORE IDENTITY_MARKERS reference
const isErrorIdx = subagentSrc.indexOf("isError");
const identityMarkersIdx = subagentSrc.indexOf("IDENTITY_MARKERS");

assert(isErrorIdx > 0, "isError variable exists in source");
assert(identityMarkersIdx > 0, "IDENTITY_MARKERS exists in source");

// Find the terminal error comment that signals the ordering
const isErrorBlock = subagentSrc.indexOf("Terminal error events: surface immediately");
const expectedMarkerCheck = subagentSrc.indexOf("Identity marker validation for custom review agents");

assert(isErrorBlock > 0, "Terminal error block comment exists");
assert(expectedMarkerCheck > 0, "Identity marker comment exists");
assert(isErrorBlock < expectedMarkerCheck, "isError terminal handler appears BEFORE identity-marker validation");

// ── 5. Plan review failure state transitions ───────────────

console.log("5. Plan review failure transitions");

// In the exitCode !== 0 handler within runPlanReviewSubagent
assertContains(commandsSrc, 'formatSubagentFailure(result)', "plan review: uses formatSubagentFailure");
assertContains(commandsSrc, 'planReviewStatus = "fail"', "plan review failure: sets planReviewStatus=fail");
assertContains(commandsSrc, "planReviewLoops += 1", "plan review failure: increments planReviewLoops");
assertContains(commandsSrc, "writePlanReview", "plan review failure: writes review notes");

// Must NOT attempt alternate result retrieval (no inline fallback)
// The old pattern was to fall back to inline review; check there's no such pattern
assertNotContains(commandsSrc, "inlineReview", "plan review: no inline review fallback");

// ── 6. Code review failure state transitions ───────────────

console.log("6. Code review failure transitions");

// In the exitCode !== 0 handler within runCodeReviewSubagent
assertContains(commandsSrc, 'autoCodeReview = false', "code review failure: sets autoCodeReview=false");

// The exitCode !== 0 handler must not set mode to "fix".
// Verify: within the runCodeReviewSubagent function, the exitCode !== 0 block
// ends with return false BEFORE any mode = "fix" assignment.
// We check this structurally: exitCode !== 0 → autoCodeReview=false → return false
// all within the same block, before result.statusMarker is checked.
const codeReviewFn = commandsSrc.slice(
  commandsSrc.indexOf("async function runCodeReviewSubagent")
);
const exitCodeHandler = codeReviewFn.slice(
  codeReviewFn.indexOf("result.exitCode !== 0")
);
const statusMarkerCheck = exitCodeHandler.indexOf("result.statusMarker");
const autoCodeFalse = exitCodeHandler.indexOf("autoCodeReview = false");
const modeFix = exitCodeHandler.indexOf('mode = "fix"');

assert(autoCodeFalse > 0, "code review exitCode!==0 block: contains autoCodeReview=false");
assert(statusMarkerCheck > 0, "code review: statusMarker check exists after exitCode handler");
assert(autoCodeFalse < statusMarkerCheck, "code review: autoCodeReview=false before statusMarker check");
// mode = "fix" appears in the FAIL handler (not the exitCode handler),
// which is AFTER result.statusMarker check
assert(modeFix > statusMarkerCheck, "code review: mode=fix only in FAIL handler, not in exitCode handler");

// Verify autoFix guard protects state mutation correctly
assertPattern(
  commandsSrc,
  /if\s*\(\s*autoFix\s*\)\s*\{[\s\S]*?autoCodeReview\s*=\s*false[\s\S]*?saveState/s,
  "code review: autoCodeReview=false guarded by autoFix check + persist"
);

// ── 7. SubagentResult includes optional diagnostic fields ──

console.log("7. SubagentResult additive fields");

assertContains(subagentSrc, "agentId?: string", "SubagentResult: optional agentId field");
assertContains(subagentSrc, "durationMs?: number", "SubagentResult: optional durationMs field");
assertContains(subagentSrc, "eventStatus?: string", "SubagentResult: optional eventStatus field");

// The existing fields must still exist (backward compatibility)
assertContains(subagentSrc, "role: string", "SubagentResult: role field preserved");
assertContains(subagentSrc, "text: string", "SubagentResult: text field preserved");
assertContains(subagentSrc, "exitCode:", "SubagentResult: exitCode field preserved");
assertContains(subagentSrc, "stderr:", "SubagentResult: stderr field preserved");
assertContains(subagentSrc, "statusMarker?", "SubagentResult: statusMarker field preserved");

// ── 8. formatSubagentFailure coverage ──────────────────────

console.log("8. formatSubagentFailure structure");

assertContains(subagentSrc, "formatSubagentFailure", "formatSubagentFailure function exists");
assertContains(subagentSrc, "exit ${result.exitCode}", "formatter: includes exit code");
assertContains(subagentSrc, "result.agentId", "formatter: checks agentId");
assertContains(subagentSrc, "result.eventStatus", "formatter: checks eventStatus");
assertContains(subagentSrc, "result.durationMs", "formatter: checks durationMs");
assertContains(subagentSrc, "slice(0, 500)", "formatter: stderr is bounded");
assertContains(subagentSrc, "slice(0, 1000)", "formatter: text is bounded");
assertContains(subagentSrc, "exitCode === 2", "formatter: recognizes exitCode 2 (identity marker)");

// ── Summary ────────────────────────────────────────────────

// ── 9. New handoff infrastructure ──────────────────────────

console.log("9. Handoff infrastructure");

// workPending mode
assertContains(typesSrc, '"workPending"', "Mode union includes workPending");

// PendingWorkHandoff type
assertContains(typesSrc, "PendingWorkHandoff", "types exports PendingWorkHandoff");
assertContains(typesSrc, "pendingWorkHandoff", "WorkflowState includes pendingWorkHandoff");

// HANDOFF_MARKER_RE
assertContains(workHandoffSrc, "HANDOFF_MARKER_RE", "work-handoff exports HANDOFF_MARKER_RE");
assertContains(workHandoffSrc, "PENDING_WORK_HANDOFF_TTL_MS", "work-handoff exports TTL constant");
assertContains(workHandoffSrc, "handleWorkPendingBeforeAgentStart", "work-handoff exports handler");

// guard mode helpers
assertContains(modeSrc, "getCurrentTurnGuardMode", "mode exports getCurrentTurnGuardMode");
assertContains(modeSrc, "isInvalidHandoffTurn", "mode exports isInvalidHandoffTurn");

// isReadonlyMode
assertContains(guardsSrc, '"workPending"', "isReadonlyMode includes workPending");

// /go --force still exists
assertContains(commandsSrc, "--force", "/go --force still exists");

// approve sends followUp via queueApprovedWorkFromTool
assertContains(toolsSrc, "queueApprovedWorkFromTool", "tools approve calls queueApprovedWorkFromTool");
assertContains(toolsSrc, "clearPendingWorkHandoff", "tools save calls clearPendingWorkHandoff");

// ── Summary ────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
