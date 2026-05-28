#!/usr/bin/env node

/**
 * Regression validation: plan → workPending handoff lifecycle.
 *
 * Verifies key invariants against the TypeScript source files:
 * 1. workPending mode exists in types, defaults, helpers, guards, prompts.
 * 2. PendingWorkHandoff type and WorkflowState field.
 * 3. HANDOFF_MARKER_RE and TTL constant exist.
 * 4. queueApprovedWorkFromTool — context validation, send-first-save-after.
 * 5. handleWorkPendingBeforeAgentStart — marker detection, valid finalize,
 *    invalid safety branch, non-marker pending cleanup.
 * 6. startApprovedWorkFromCommand — runtime/state/send failure rollback.
 * 7. workflow_plan approve queues handoff (not just sets planApproved).
 * 8. workflow_plan save/clear clears pending.
 * 9. /go uses command direct helper.
 * 10. agent_end does NOT trigger planApproved → Work handoff.
 * 11. /plan, /wf-reset, /wf-exit clear pending.
 * 12. tool_call guard uses turn guard + blocks approve in invalidHandoff.
 *
 * Usage: node scripts/validate-handoff-regression.mjs
 */

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

function assertContains(haystack, needle, label) {
  if (haystack.includes(needle)) { passed++; }
  else { failed++; console.error(`  FAIL: ${label} — expected "${needle.slice(0,60)}"`); }
}

function assertNotContains(haystack, needle, label) {
  if (!haystack.includes(needle)) { passed++; }
  else { failed++; console.error(`  FAIL: ${label} — unexpected "${needle}"`); }
}

// ── Load source files ──────────────────────────────────────────────────────

const typesSrc = readFileSync("extensions/workflow/types.ts", "utf8");
const helpersSrc = readFileSync("extensions/workflow/helpers.ts", "utf8");
const guardsSrc = readFileSync("extensions/workflow/guards.ts", "utf8");
const promptsSrc = readFileSync("extensions/workflow/prompts.ts", "utf8");
const workHandoffSrc = readFileSync("extensions/workflow/work-handoff.ts", "utf8");
const modeSrc = readFileSync("extensions/workflow/mode.ts", "utf8");
const toolsSrc = readFileSync("extensions/workflow/tools.ts", "utf8");
const commandsSrc = readFileSync("extensions/workflow/commands.ts", "utf8");

// ── 1. workPending mode in types ───────────────────────────────────────────

console.log("1. workPending Mode in types");

assertContains(typesSrc, '"workPending"', "Mode union includes workPending");

// ── 2. PendingWorkHandoff type and WorkflowState field ─────────────────────

console.log("2. PendingWorkHandoff type");

assertContains(typesSrc, "export interface PendingWorkHandoff", "PendingWorkHandoff interface exists");
assertContains(typesSrc, "id: string", "PendingWorkHandoff has id");
assertContains(typesSrc, "marker: string", "PendingWorkHandoff has marker");
assertContains(typesSrc, "planPath: string", "PendingWorkHandoff has planPath");
assertContains(typesSrc, "planRunId?", "PendingWorkHandoff has optional planRunId");
assertContains(typesSrc, "workRunId: string", "PendingWorkHandoff has workRunId");
assertContains(typesSrc, "createdAt: string", "PendingWorkHandoff has createdAt");
assertContains(typesSrc, "expiresAt: string", "PendingWorkHandoff has expiresAt");
assertContains(typesSrc, "expectedPrompt: string", "PendingWorkHandoff has expectedPrompt");
assertContains(typesSrc, "pendingWorkHandoff?: PendingWorkHandoff", "WorkflowState has pendingWorkHandoff field");
assertNotContains(typesSrc, "force?: boolean", "PendingWorkHandoff does NOT have force field");

// ── 3. workPending in guards, helpers, prompts ─────────────────────────────

console.log("3. workPending in guards, helpers, prompts");

assertContains(guardsSrc, 'mode === "workPending"', "isReadonlyMode includes workPending");
assertContains(helpersSrc, 'workPending: "Work Pending"', "modeLabel has workPending");
assertContains(helpersSrc, "pendingHandoff", "currentStatusText includes pendingHandoff");
assertContains(promptsSrc, "workPending", "promptForMode handles workPending");

// ── 4. HANDOFF_MARKER_RE and TTL ───────────────────────────────────────────

console.log("4. Handoff constants");

assertContains(workHandoffSrc, "HANDOFF_MARKER_RE", "HANDOFF_MARKER_RE exists");
assertContains(workHandoffSrc, "PENDING_WORK_HANDOFF_TTL_MS", "PENDING_WORK_HANDOFF_TTL_MS exists");
assertContains(workHandoffSrc, "5 * 60 * 1000", "TTL is 5 minutes");

// ── 5. queueApprovedWorkFromTool structure ─────────────────────────────────

console.log("5. queueApprovedWorkFromTool");

assertContains(workHandoffSrc, "queueApprovedWorkFromTool", "queueApprovedWorkFromTool function exists");
assertContains(workHandoffSrc, 'state.mode !== "plan"', "approve validates state.mode === plan");
assertNotContains(workHandoffSrc, 'guardMode !== "plan"', "approve no longer hard-rejects non-plan guard");
assertNotContains(workHandoffSrc, "planApproved", "approve no longer uses planApproved");
assertContains(workHandoffSrc, "pendingWorkHandoff", "approve checks existing pending");
assertContains(workHandoffSrc, "sendUserMessage", "approve sends followUp");
assertContains(workHandoffSrc, 'deliverAs: "followUp"', "approve uses followUp delivery");
assertContains(workHandoffSrc, 'mode = "workPending"', "approve sets mode to workPending");

// send-first-save-after: sendUserMessage appears before mode = "workPending" save
const queueFnStart = workHandoffSrc.indexOf("async function queueApprovedWorkFromTool");
const queueFnBody = workHandoffSrc.slice(queueFnStart);
const sendIdx = queueFnBody.indexOf("sendUserMessage");
const modePendingIdx = queueFnBody.indexOf('mode = "workPending"');
assert(sendIdx > 0 && modePendingIdx > 0, "queueApprovedWorkFromTool: contains send and save");
assert(sendIdx < modePendingIdx, "queueApprovedWorkFromTool: sends BEFORE saving pending (send-first-save-after)");

// ── 5b. Executable approval guard tests (source-backed decision checks) ──

console.log("5b. Executable approval guard tests");

// Extract the approval function body from work-handoff.ts for line-level checks.
const approveFnBodySrc = workHandoffSrc.slice(
  workHandoffSrc.indexOf("async function queueApprovedWorkFromTool"),
  workHandoffSrc.indexOf("// ── before_agent_start")
);

// Verify each of the 5 durable rejection conditions, in order, by line position.
function durableCheckOrder(condition, label) {
  const idx = approveFnBodySrc.indexOf(condition);
  assert(idx > 0, "durable check present: " + label);
  return idx;
}

const chkModeNotPlan  = durableCheckOrder('state.mode !== "plan"', "mode !== plan");
const chkNoPlanPath   = durableCheckOrder('!state.planPath', "missing planPath");
const chkReview       = durableCheckOrder('planReview.enabled', "review enabled");
const chkPending      = durableCheckOrder('state.pendingWorkHandoff', "pending exists");
const chkInvalidTurn  = durableCheckOrder('isInvalidHandoffTurn', "invalid handoff");

// Verify checks are in the correct order.
assert(chkModeNotPlan < chkNoPlanPath, "checks ordered: mode → planPath");
assert(chkNoPlanPath < chkReview, "checks ordered: planPath → review");
assert(chkReview < chkPending, "checks ordered: review → pending");
assert(chkPending < chkInvalidTurn, "checks ordered: pending → invalidTurn");

// Verify guard mode is NOT used as a rejection condition.
assertNotContains(approveFnBodySrc, 'guardMode !== "plan"', "no guardMode!==plan check");
assertNotContains(approveFnBodySrc, "getCurrentTurnGuardMode", "no getCurrentTurnGuardMode call");

// Verify planApproved is NOT used.
assertNotContains(approveFnBodySrc, "planApproved", "no planApproved in approve function");

// Verify the send-first-save-after pattern is preserved.
const sendIdx2 = approveFnBodySrc.indexOf("sendUserMessage");
const saveIdx2 = approveFnBodySrc.indexOf("saveState(ctx.cwd, sessionKey, state)", approveFnBodySrc.indexOf('mode = "workPending"'));
assert(sendIdx2 > 0 && saveIdx2 > 0, "send and save both present in approve");
assert(sendIdx2 < saveIdx2, "sendUserMessage BEFORE saveState (send-first-save-after)");

// Extract only the queueApprovedWorkFromTool function body for scoped checks.
const approveFnBody = queueFnBody.slice(0, queueFnBody.indexOf("\n// ── before_agent_start"));

// All 5 durable rejection conditions must exist:
assertContains(approveFnBody, 'state.mode !== "plan"', "durable guard: rejects non-plan mode");
assertContains(approveFnBody, "planPath", "durable guard: checks missing planPath");
assertContains(approveFnBody, "planReviewStatus", "durable guard: checks plan review status");
assertContains(approveFnBody, "pendingWorkHandoff", "durable guard: rejects existing pending");
assertContains(approveFnBody, "isInvalidHandoffTurn", "durable guard: rejects invalid handoff turn");

// Old guard mode check must no longer exist in any rejection path.
assertNotContains(approveFnBody, 'guardMode', "durable guard: no guardMode check anywhere");
assertNotContains(approveFnBody, "getCurrentTurnGuardMode", "durable guard: no getCurrentTurnGuardMode call");

// ── 6. handleWorkPendingBeforeAgentStart ───────────────────────────────────

console.log("6. handleWorkPendingBeforeAgentStart");

assertContains(workHandoffSrc, "handleWorkPendingBeforeAgentStart", "handler function exists");
assertContains(workHandoffSrc, "HANDOFF_MARKER_RE.test", "handler tests marker regex on eventPrompt");
assertContains(workHandoffSrc, "applyModeRuntime(pi, ctx, \"work\"", "handler applies Work runtime on valid finalize");
assertContains(workHandoffSrc, "setCurrentTurnGuardMode(sessionKey, \"work\")", "handler sets guard to work on success");
assertContains(workHandoffSrc, "clearPendingWorkHandoff", "handler clears pending on finalize");

// Invalid handoff safety
assertContains(workHandoffSrc, "buildInvalidHandoffSafetyPrompt", "handler generates safety prompt");
assertContains(workHandoffSrc, "setInvalidHandoffTurn", "handler sets invalidHandoff flag");
assertContains(workHandoffSrc, 'setCurrentTurnGuardMode(sessionKey, "plan")', "handler sets guard to plan on failure");

// Non-marker prompt + workPending → user interrupt
assertContains(workHandoffSrc, 'mode === "workPending"', "handler detects workPending without marker");

// ── 7. startApprovedWorkFromCommand ────────────────────────────────────────

console.log("7. startApprovedWorkFromCommand");

assertContains(workHandoffSrc, "startApprovedWorkFromCommand", "command start function exists");
assertContains(workHandoffSrc, "captureRuntimeSnapshot", "command start captures runtime snapshot");
assertContains(workHandoffSrc, "restoreRuntimeSnapshot", "command start can restore runtime");
assertContains(workHandoffSrc, "sendUserMessage(kickoff)", "command start sends direct kickoff");

// ── 8. createPendingWorkHandoff ────────────────────────────────────────────

console.log("8. createPendingWorkHandoff");

assertContains(workHandoffSrc, "createPendingWorkHandoff", "create function exists");
assertContains(workHandoffSrc, "randomUUID()", "generates handoffId");
assertContains(workHandoffSrc, "randomUUID()", "generates workRunId");
assertContains(workHandoffSrc, "expectedPrompt", "builds expectedPrompt with marker");

// ── 9. isPendingWorkHandoffValid ───────────────────────────────────────────

console.log("9. isPendingWorkHandoffValid");

assertContains(workHandoffSrc, "isPendingWorkHandoffValid", "validation function exists");
assertContains(workHandoffSrc, "planPath !== state.planPath", "validates planPath against current state");
assertContains(workHandoffSrc, "planRunId !== state.planRunId", "validates planRunId against current state");
assertContains(workHandoffSrc, "extractedMarker !== pending.marker", "validates marker match via extractHandoffMarker");
assertContains(workHandoffSrc, "expiresAt", "validates expiry");

// ── 10. workflow_plan approve → queues handoff, not just planApproved ──────

console.log("10. workflow_plan approve");

const planToolApproveIdx = toolsSrc.indexOf('action === "approve"');
const planToolApproveBody = toolsSrc.slice(planToolApproveIdx, toolsSrc.indexOf("review_pass", planToolApproveIdx));

assertContains(toolsSrc, "queueApprovedWorkFromTool(pi, ctx, getAgentDir)", "approve calls queueApprovedWorkFromTool");
assertContains(toolsSrc, 'mode === "workPending"', "approve rejects if already workPending");
assertContains(toolsSrc, "pendingWorkHandoff", "approve rejects if pending exists");
assertNotContains(planToolApproveBody, "planApproved = true;", "approve does NOT directly set planApproved");

// ── 11. workflow_plan save/clear clear pending ─────────────────────────────

console.log("11. workflow_plan save/clear");

const saveBlock = toolsSrc.slice(toolsSrc.indexOf('action === "save"'), toolsSrc.indexOf('action === "approve"'));
assertContains(saveBlock, "clearPendingWorkHandoff", "save clears pendingWorkHandoff");

const clearBlock = toolsSrc.slice(toolsSrc.indexOf('action === "clear"'));
assertNotContains(clearBlock, "planApproved", "clear no longer uses planApproved");

// ── 12. /go uses command direct helper ─────────────────────────────────────

console.log("12. /go command");

const goFn = commandsSrc.slice(commandsSrc.indexOf("registerGoCommand"), commandsSrc.indexOf("registerWorkCommand"));
assertContains(goFn, "startApprovedWorkFromCommand", "/go calls startApprovedWorkFromCommand");
assertNotContains(goFn, "planApproved = true", "/go does NOT directly set planApproved");
assertNotContains(goFn, "startWorkFromPlan", "/go does NOT call old startWorkFromPlan");

// ── 13. agent_end does NOT trigger planApproved → Work ─────────────────────

console.log("13. agent_end planApproved removal");

const agentEndFn = commandsSrc.slice(
  commandsSrc.indexOf("registerAgentEnd"),
  commandsSrc.indexOf("registerPlanCommand")
);
assertNotContains(agentEndFn, "if (state.planApproved)", "agent_end: no planApproved check");
assertNotContains(agentEndFn, "await startWorkFromPlan(", "agent_end: no startWorkFromPlan call");
assertContains(agentEndFn, "planApproved has been removed", "agent_end: has updated comment");
assertContains(agentEndFn, "clearCurrentTurnGuardMode", "agent_end: clears turn guard mode");
assertContains(agentEndFn, "clearInvalidHandoffTurn", "agent_end: clears invalidHandoff flag");

// ── 14. /wf-reset, /wf-exit, /plan clear pending ───────────────────────────

console.log("14. Pending cleanup in commands");

// /wf-exit clears pending
const wfExitFn = commandsSrc.slice(
  commandsSrc.indexOf("registerWfExitCommand"),
  commandsSrc.indexOf("registerWfResetCommand")
);
assertContains(wfExitFn, "clearPendingWorkHandoff", "/wf-exit clears pending");

// ── 15. tool_call guard ────────────────────────────────────────────────────

console.log("15. tool_call guard");

const guardFn = commandsSrc.slice(
  commandsSrc.indexOf("registerToolCallGuard"),
  commandsSrc.indexOf("registerAgentEnd")
);
assertContains(guardFn, "getCurrentTurnGuardMode", "guard uses getCurrentTurnGuardMode");
assertContains(guardFn, "isInvalidHandoffTurn", "guard checks isInvalidHandoffTurn");
assertContains(guardFn, 'event.toolName === "workflow_plan"', "guard checks workflow_plan in invalid handoff");

// ── 16. mode.ts runtime helpers ────────────────────────────────────────────

console.log("16. mode.ts helpers");

assertContains(modeSrc, "setCurrentTurnGuardMode", "setCurrentTurnGuardMode exists");
assertContains(modeSrc, "getCurrentTurnGuardMode", "getCurrentTurnGuardMode exists");
assertContains(modeSrc, "clearCurrentTurnGuardMode", "clearCurrentTurnGuardMode exists");
assertContains(modeSrc, "setInvalidHandoffTurn", "setInvalidHandoffTurn exists");
assertContains(modeSrc, "isInvalidHandoffTurn", "isInvalidHandoffTurn exists");
assertContains(modeSrc, "clearInvalidHandoffTurn", "clearInvalidHandoffTurn exists");
assertContains(modeSrc, "captureRuntimeSnapshot", "captureRuntimeSnapshot exists");
assertContains(modeSrc, "restoreRuntimeSnapshot", "restoreRuntimeSnapshot exists");
assertContains(modeSrc, "applyModeRuntime", "applyModeRuntime exists");
assertContains(modeSrc, "activateWorkflowToolsIfAllowed", "activateWorkflowToolsIfAllowed exists");

// ── 17. before_agent_start integration ─────────────────────────────────────

console.log("17. before_agent_start integration");

const beforeAgentFn = commandsSrc.slice(
  commandsSrc.indexOf("registerBeforeAgentStart"),
  commandsSrc.indexOf("registerToolCallGuard")
);
assertContains(beforeAgentFn, "handleWorkPendingBeforeAgentStart", "before_agent_start calls handoff handler");
assertContains(beforeAgentFn, "handoffResult.systemPrompt", "before_agent_start checks safety system prompt");

// ── 18. No old startWorkFromPlan / sendHandoffUserMessage ──────────────────

console.log("18. No old handoff functions");

assertNotContains(commandsSrc, "function startWorkFromPlan", "commands.ts: no old startWorkFromPlan");
assertNotContains(commandsSrc, "function sendHandoffUserMessage", "commands.ts: no old sendHandoffUserMessage");
assertNotContains(commandsSrc, "function switchMode", "commands.ts: no old switchMode");
assertNotContains(commandsSrc, "function setRole", "commands.ts: no old setRole");
assertNotContains(commandsSrc, "function activateWorkflowToolsIfAllowed", "commands.ts: no own activateWorkflowToolsIfAllowed");
assertContains(commandsSrc, "activateWorkflowToolsIfAllowed", "commands.ts imports activateWorkflowToolsIfAllowed");

// ── 19. runCodeReviewSubagent still uses fix handoff ───────────────────────

console.log("19. Code-review → fix handoff preserved");

const codeReviewFn = commandsSrc.slice(
  commandsSrc.indexOf("async function runCodeReviewSubagent"),
  commandsSrc.indexOf("registerBeforeAgentStart")
);
assertContains(codeReviewFn, 'applyModeRuntime(pi, ctx, "fix"', "code-review → fix: applies fix runtime");
assertContains(codeReviewFn, "Critical / Important", "code-review → fix: sends fix handoff message");

// ── 20. work-handoff.ts exports ────────────────────────────────────────────

console.log("20. work-handoff.ts exports");

assertContains(workHandoffSrc, "export const HANDOFF_MARKER_RE", "exports HANDOFF_MARKER_RE");
assertContains(workHandoffSrc, "export async function queueApprovedWorkFromTool", "exports queueApprovedWorkFromTool");
assertContains(workHandoffSrc, "export async function handleWorkPendingBeforeAgentStart", "exports handleWorkPendingBeforeAgentStart");
assertContains(workHandoffSrc, "export async function startApprovedWorkFromCommand", "exports startApprovedWorkFromCommand");
assertContains(workHandoffSrc, "export function clearPendingWorkHandoff", "exports clearPendingWorkHandoff");
assertContains(workHandoffSrc, "export function isPendingWorkHandoffValid", "exports isPendingWorkHandoffValid");
assertContains(workHandoffSrc, "export const PENDING_WORK_HANDOFF_TTL_MS", "exports PENDING_WORK_HANDOFF_TTL_MS");

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
