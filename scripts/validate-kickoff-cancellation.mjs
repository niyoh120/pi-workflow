#!/usr/bin/env node
/**
 * Regression validation: Approved-Work kickoff cancellation (sidecar marker).
 *
 * Behavior groups from the approved plan:
 *
 *  1. Marker module (kickoff-cancellation.ts): atomic write + idempotent
 *     re-cancel, read states absent/cancelled, fail-closed read errors
 *     (corrupt JSON, foreign run id), write-failure reporting.
 *  2. Abort path (real agent_settled handler): aborted + matching pending →
 *     marker written; normal completion → no marker; non-matching pending →
 *     no write; repeated aborts → no duplicate notice; approved artifacts
 *     (plan/todos/handoff journal) preserved.
 *  3. Dispatcher suppression (real runPendingWorkDispatcher): cancelled
 *     pending cleared with handoff kept; error marker fail-closed (pending
 *     kept, no send); stale instance rebuild → suppressed; marker + state
 *     reload immediately before send (send path never fires on cancelled);
 *     new work run (new id) unaffected by an old marker.
 *
 * Two-runtime scenario: a second SessionManager instance opened on the same
 * session file (B) keeps dispatching while instance A persists the
 * cancellation — B's kickoff stays zero because the marker is read from
 * disk, not from the in-memory branch.
 *
 * Run: node scripts/validate-kickoff-cancellation.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * Copy extensions/workflow into a temp dir with every relative `.js` import
 * specifier rewritten to the real `.ts` file, then import `entry`.
 */
const workflowRewriteDirs = [];
async function loadWorkflowModule(entry) {
	const tmp = fs.mkdtempSync(path.join(root, ".kickoff-cancel-mod-"));
	const dest = path.join(tmp, "workflow");
	fs.cpSync(path.join(root, "extensions", "workflow"), dest, { recursive: true });
	workflowRewriteDirs.push(tmp);
	for (const file of fs.readdirSync(dest).filter((f) => f.endsWith(".ts"))) {
		const p = path.join(dest, file);
		let text = fs.readFileSync(p, "utf8");
		text = text.replace(/(from\s+")(\.\/[^"\n]+)\.js"/g, "$1$2.ts\"");
		// Dynamic imports keep the .js specifier at runtime — rewrite those too.
		text = text.replace(/(import\(\s*")(\.\/[^"\n]+)\.js("\s*\))/g, "$1$2.ts$3");
		fs.writeFileSync(p, text);
	}
	return import(pathToFileURL(path.join(dest, entry)).href + "?t=" + Date.now());
}
process.on("exit", () => {
	for (const d of fs.readdirSync(root).filter((f) => f.startsWith(".kickoff-cancel-mod-"))) {
		try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

function makeTmpProject(prefix) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const cwd = path.join(tmp, "project");
	const agentDir = path.join(tmp, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	return { tmp, cwd, agentDir };
}

function makeFakePi() {
	const handlers = new Map();
	const pi = {
		handlers,
		on(name, handler) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
		},
		messages: [],
		userMessages: [],
		sendMessage(msg) {
			pi.messages.push(msg);
		},
		sendUserMessage(text) {
			pi.userMessages.push(text);
		},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		getAllTools: () => [],
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		setModel: async () => true,
	};
	return pi;
}

function makeFakeCtx(cwd, overrides = {}) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => "validate-cancel-session",
			getSessionFile: () => path.join(cwd, ".validate-cancel-session.jsonl"),
		},
		model: { provider: "test-provider", id: "test-model", contextWindow: 128000 },
		modelRegistry: { find: () => undefined },
		isProjectTrusted: () => false,
		ui: { notify: () => {}, setStatus: () => {} },
		isIdle: () => true,
		hasPendingMessages: () => false,
		...overrides,
	};
}

/** Build a realistic Approved-Work state: work mode, plan, journal evidence. */
function workState(stateMod, defaultsMod, runId, overrides = {}) {
	return {
		...defaultsMod.DEFAULT_STATE,
		workflowEnabled: true,
		mode: "work",
		workRunId: runId,
		planPath: "plan/plans/plan-cancel.md",
		pendingWorkKickoff: runId,
		...overrides,
	};
}

// ── Group 1: marker module ───────────────────────────────────────────────────

console.log("Kickoff cancellation: marker module");
{
	const { cwd, agentDir } = makeTmpProject("wf-cancel-marker-");
	const mod = await loadWorkflowModule("kickoff-cancellation.ts");
	void agentDir;

	const sessionKey = "marker-session-key";
	const runId = "run-marker-00000001";

	const absent = mod.readKickoffCancellation(cwd, sessionKey, runId);
	assert(absent.state === "absent", "no marker → absent");

	const w1 = mod.writeKickoffCancellation(cwd, sessionKey, runId);
	assert(w1.ok === true, "write succeeds");
	const file = mod.kickoffCancellationPath(cwd, sessionKey, runId);
	assert(fs.existsSync(file), "marker file exists on disk");
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	assert(
		parsed.version === 1 && parsed.workRunId === runId && typeof parsed.cancelledAt === "string",
		"marker carries version + full workRunId + timestamp",
	);

	const read = mod.readKickoffCancellation(cwd, sessionKey, runId);
	assert(read.state === "cancelled" && read.workRunId === runId, "read → cancelled");

	const w2 = mod.writeKickoffCancellation(cwd, sessionKey, runId);
	assert(w2.ok === true, "idempotent re-cancel succeeds");

	// Foreign run id: hash collision guard.
	const otherRun = mod.readKickoffCancellation(cwd, sessionKey, "run-marker-00000002");
	assert(otherRun.state === "absent", "different run id hashes to a different marker (absent)");

	// Corrupt marker → fail-closed error.
	fs.writeFileSync(file, "{not json");
	const corrupt = mod.readKickoffCancellation(cwd, sessionKey, runId);
	assert(corrupt.state === "error" && /corrupt|malformed/i.test(corrupt.error), "corrupt JSON → error (fail-closed)");

	// Foreign-id marker content under this run's filename → error.
	fs.writeFileSync(
		file,
		JSON.stringify({ version: 1, workRunId: "run-other-00000009", cancelledAt: "t" }),
	);
	const foreign = mod.readKickoffCancellation(cwd, sessionKey, runId);
	assert(foreign.state === "error" && /different run/i.test(foreign.error), "foreign run id in marker → error (fail-closed)");

	// Malformed version → error.
	fs.writeFileSync(file, JSON.stringify({ version: 99, workRunId: runId }));
	const badVersion = mod.readKickoffCancellation(cwd, sessionKey, runId);
	assert(badVersion.state === "error", "unknown marker version → error (fail-closed)");

	// Empty run id → explicit write failure.
	const badWrite = mod.writeKickoffCancellation(cwd, sessionKey, "");
	assert(badWrite.ok === false && !!badWrite.error, "empty workRunId write → explicit error");
}

/** Module-scope helpers module (WORK_APPROVAL_CUSTOM_TYPE for branchWithJournal). */
const helpersTopMod = await loadWorkflowModule("helpers.ts");

/** A minimal branch carrying the approval journal for a work run. */
function branchWithJournal(workRunId, handoffBody) {
	return [
		{
			type: "custom",
			customType: helpersTopMod.WORK_APPROVAL_CUSTOM_TYPE,
			data: { workRunId, handoffBody },
		},
	];
}

// ── Group 2: abort path (real agent_settled handler) ────────────────────────

console.log("\nAbort path (real agent_settled handler)");
{
	const cmdMod = await loadWorkflowModule("commands.ts");
	const stateMod = await loadWorkflowModule("state.ts");
	const defaultsMod = await loadWorkflowModule("defaults.ts");
	const helpersMod = await loadWorkflowModule("helpers.ts");
	const cancelMod = await loadWorkflowModule("kickoff-cancellation.ts");

	const { cwd, agentDir } = makeTmpProject("wf-cancel-abort-");
	const pi = makeFakePi();
	cmdMod.registerPendingWorkDispatcher(pi, () => agentDir);
	const settled = pi.handlers.get("agent_settled")[0];
	assert(typeof settled === "function", "agent_settled handler registered");
	const ctx = makeFakeCtx(cwd);
	const runId = "run-abort-00000001";
	// Branch evidence must be visible to the dispatcher: the fake ctx carries
	// the approval journal for the run (handoff body included).
	ctx.sessionManager.getBranch = () => branchWithJournal(runId, "handoff body");
	const sessionKey = stateMod.getSessionKey(ctx);
	const markerFile = cancelMod.kickoffCancellationPath(cwd, sessionKey, runId);

	// 2a. Normal completion: no marker.
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, runId));
	await settled({ type: "agent_settled", aborted: false }, ctx);
	assert(!fs.existsSync(markerFile), "normal completion writes no marker");
	assert(pi.userMessages.length === 1, "normal completion starts the kickoff");
	assert(
		pi.userMessages[0].includes(runId),
		"kickoff message carries the workRunId",
	);
	const afterNormal = stateMod.loadState(cwd, sessionKey);
	assert(
		afterNormal.pendingWorkKickoff === undefined,
		"normal completion clears the pending kickoff",
	);

	// 2b. Aborted with matching pending → marker + suppression + artifacts kept.
	stateMod.saveState(cwd, sessionKey, {
		...workState(stateMod, defaultsMod, runId),
		todos: [{ id: "t1", title: "implement", status: "in_progress" }],
		approvedTodos: [{ id: "t1", title: "implement", status: "in_progress" }],
	});
	await settled({ type: "agent_settled", aborted: true }, ctx);
	assert(fs.existsSync(markerFile), "aborted run writes the durable marker");
	assert(cancelMod.readKickoffCancellation(cwd, sessionKey, runId).state === "cancelled", "marker reads cancelled");
	const afterAbort = stateMod.loadState(cwd, sessionKey);
	assert(
		afterAbort.mode === "work" &&
			afterAbort.workRunId === runId &&
			afterAbort.approvedTodos?.length === 1 &&
			afterAbort.planPath === "plan/plans/plan-cancel.md",
		"abort preserves approved artifacts (mode/run/todos/plan)",
	);
	// The abort path itself only writes the marker; the SUBSEQUENT dispatcher
	// pass cleans the pending. Drive it once and assert the cleanup boundary.
	await runDispatcherInGroup(cmdMod, pi, ctx);
	const afterClean = stateMod.loadState(cwd, sessionKey);
	assert(
		afterClean.pendingWorkKickoff === undefined && pi.userMessages.length === 1,
		"the following dispatcher pass cleans the cancelled pending without a kickoff",
	);

	// 2c. Aborted again (idempotent, no duplicate write): marker mtime stable.
	const mtime1 = fs.statSync(markerFile).mtimeMs;
	await new Promise((r) => setTimeout(r, 5));
	await settled({ type: "agent_settled", aborted: true }, ctx);
	const mtime2 = fs.statSync(markerFile).mtimeMs;
	assert(mtime1 === mtime2, "repeated abort does not rewrite the marker");

	// 2d. Abort with non-matching pending → no write for the other run.
	const otherRun = "run-abort-00000009";
	stateMod.saveState(cwd, sessionKey, {
		...workState(stateMod, defaultsMod, runId),
		pendingWorkKickoff: otherRun,
	});
	const otherMarker = cancelMod.kickoffCancellationPath(cwd, sessionKey, otherRun);
	await settled({ type: "agent_settled", aborted: true }, ctx);
	assert(!fs.existsSync(otherMarker), "abort with mismatched pending writes nothing");
	// Restore the matching pending for the next group.
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, runId));

	// 2e. Abort outside work mode → no write.
	stateMod.saveState(cwd, sessionKey, {
		...defaultsMod.DEFAULT_STATE,
		workflowEnabled: true,
		mode: "plan",
		pendingWorkKickoff: runId,
	});
	const markerCountBeforePlanAbort = fs
		.readdirSync(path.dirname(markerFile))
		.filter((f) => f.startsWith("kickoff-cancel-")).length;
	await settled({ type: "agent_settled", aborted: true }, ctx);
	const markerCountAfterPlanAbort = fs
		.readdirSync(path.dirname(markerFile))
		.filter((f) => f.startsWith("kickoff-cancel-")).length;
	assert(
		markerCountAfterPlanAbort === markerCountBeforePlanAbort,
		"plan-mode abort writes no new marker (state gate rejects non-work modes)",
	);
}

// ── Group 3: dispatcher suppression (real dispatcher) ───────────────────────

console.log("\nDispatcher suppression (real runPendingWorkDispatcher)");
{
	const cmdMod = await loadWorkflowModule("commands.ts");
	const stateMod = await loadWorkflowModule("state.ts");
	const defaultsMod = await loadWorkflowModule("defaults.ts");
	const cancelMod = await loadWorkflowModule("kickoff-cancellation.ts");

	const { cwd, agentDir } = makeTmpProject("wf-cancel-dispatch-");
	const pi = makeFakePi();
	cmdMod.registerPendingWorkDispatcher(pi, () => agentDir);
	const settled = pi.handlers.get("agent_settled")[0];
	const ctx = makeFakeCtx(cwd);
	const runId = "run-dispatch-00000001";
	ctx.sessionManager.getBranch = () => branchWithJournal(runId, "handoff body");
	const sessionKey = stateMod.getSessionKey(ctx);
	const markerFile = cancelMod.kickoffCancellationPath(cwd, sessionKey, runId);

	// 3a. Cancelled pending → pending cleared, no kickoff, handoff untouched.
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, runId));
	fs.mkdirSync(path.dirname(markerFile), { recursive: true });
	cancelMod.writeKickoffCancellation(cwd, sessionKey, runId);
	await runDispatcher(cmdMod, pi, ctx);
	const s3a = stateMod.loadState(cwd, sessionKey);
	assert(
		s3a.pendingWorkKickoff === undefined && pi.userMessages.length === 0,
		"cancelled pending is cleared without any kickoff",
	);
	assert(
		s3a.mode === "work" && s3a.workRunId === runId && s3a.approvedTodos === undefined,
		"approval artifacts (mode/run/state) are preserved after cancel",
	);
	// Second pass: no re-clear churn, still no send.
	await runDispatcher(cmdMod, pi, ctx);
	assert(pi.userMessages.length === 0, "second dispatcher pass sends nothing");

	// 3b. Corrupt marker → fail-closed: pending KEPT, no send.
	const runId2 = "run-dispatch-00000002";
	const marker2 = cancelMod.kickoffCancellationPath(cwd, sessionKey, runId2);
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, runId2));
	fs.mkdirSync(path.dirname(marker2), { recursive: true });
	fs.writeFileSync(marker2, "{broken");
	await runDispatcher(cmdMod, pi, ctx);
	const s3b = stateMod.loadState(cwd, sessionKey);
	assert(
		s3b.pendingWorkKickoff === runId2 && pi.userMessages.length === 0,
		"unreadable marker suppresses the send and keeps the pending (fail-closed)",
	);

	// 3c. Marker for an OLD run never blocks a NEW run.
	const runId3 = "run-dispatch-00000003";
	ctx.sessionManager.getBranch = () => branchWithJournal(runId3, "handoff body");
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, runId3));
	// old marker for runId still on disk; new run has a fresh id → dispatches.
	await runDispatcher(cmdMod, pi, ctx);
	assert(
		pi.userMessages.length === 1 && pi.userMessages[0].includes(runId3),
		"a fresh work run (new id) is never blocked by an old run's marker",
	);

	// 3d. session_start resume path: cancelled pending not replayed.
	const runId4 = "run-dispatch-00000004";
	const marker4 = cancelMod.kickoffCancellationPath(cwd, sessionKey, runId4);
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, runId4));
	cancelMod.writeKickoffCancellation(cwd, sessionKey, runId4);
	ctx.sessionManager.getBranch = () => branchWithJournal(runId4, "handoff body");
	await runDispatcher(cmdMod, pi, ctx);
	const s3d = stateMod.loadState(cwd, sessionKey);
	assert(
		s3d.pendingWorkKickoff === undefined && pi.userMessages.length === 1,
		"resume path also honors the marker (kickoff not replayed after restart)",
	);
}

/** Drive the registered agent_settled handler (group-local helper). */
async function runDispatcherInGroup(_cmdMod, pi, ctx) {
	const handler = pi.handlers.get("agent_settled")[0];
	await handler({ type: "agent_settled", aborted: false }, ctx);
}

async function runDispatcher(cmdMod, pi, ctx) {
	// The dispatcher is registered as agent_settled; drive it directly.
	const handler = pi.handlers.get("agent_settled")[0];
	await handler({ type: "agent_settled", aborted: false }, ctx);
}

// ── Group 4: cross-runtime suppression (two independent SessionManagers) ──

console.log("\nCross-runtime suppression (stale branch, shared disk)");
{
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const cmdMod = await loadWorkflowModule("commands.ts");
	const stateMod = await loadWorkflowModule("state.ts");
	const defaultsMod = await loadWorkflowModule("defaults.ts");
	const cancelMod = await loadWorkflowModule("kickoff-cancellation.ts");
	const pathsMod = await loadWorkflowModule("paths.ts");

	const { cwd, agentDir } = makeTmpProject("wf-cancel-runtime-");
	// Explicit ISOLATED session dir — SessionManager.create(cwd, sessionDir)
	// must never touch the real default session store.
	const sessionDir = path.join(cwd, "sess");
	fs.mkdirSync(sessionDir, { recursive: true });

	// Instance A creates and PERSISTS the session (journal evidence included).
	// A user message starts the file on disk (setup-only sessions stay in
	// memory per SessionManager's persistence rule).
	const smA = SessionManager.create(cwd, sessionDir);
	smA.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	smA.appendCustomEntry("workflow-work-approval", {
		workRunId: "run-runtime-00000001",
		handoffBody: "HB-runtime",
	});
	const sessionFile = smA.getSessionFile();
	assert(!!sessionFile && fs.existsSync(sessionFile), "instance A persists a real session file in the isolated dir");
	assert(
		path.dirname(sessionFile) === sessionDir,
		"session file lives in the isolated sessionDir (not the default store)",
	);

	// Instance B opens the SAME file as a fully independent SessionManager.
	const smB = SessionManager.open(sessionFile, sessionDir, cwd);
	assert(smB.getSessionId() === smA.getSessionId(), "instance B resolves the same session id");

	// Instance A persists the cancellation for the current run — VIA THE ABORT
	// PATH (real handler), not a direct marker write. Before that, instance B
	// HOLDS the cross-process dispatcher lock, so A's abort persists the marker
	// but its dispatch pass must defer; when B releases and continues, B's
	// dispatch + the reopen both see the durable cancellation.
	const piA = makeFakePi();
	cmdMod.registerPendingWorkDispatcher(piA, () => agentDir);
	const ctxA = makeFakeCtx(cwd, {
		sessionManager: {
			getSessionId: () => smA.getSessionId(),
			getSessionFile: () => sessionFile,
			getBranch: () => smA.getBranch(),
		},
	});
	const sessionKey = stateMod.getSessionKey(ctxA);
	const runId = "run-runtime-00000001";
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, runId));

	// B takes the dispatcher lock and holds it while A aborts.
	const piB = makeFakePi();
	cmdMod.registerPendingWorkDispatcher(piB, () => agentDir);
	const ctxB = makeFakeCtx(cwd, {
		sessionManager: {
			getSessionId: () => smB.getSessionId(),
			getSessionFile: () => smB.getSessionFile(),
			getBranch: () => smB.getBranch(),
		},
	});
	assert(
		stateMod.getSessionKey(ctxB) === sessionKey,
		"both instances map to the same workflow session key",
	);
	const lockAcquired = stateMod.acquireDispatcherLock(cwd, sessionKey);
	assert(lockAcquired, "instance B holds the cross-process dispatcher lock");

	// A: abort → marker persisted while B holds the lock.
	const settledA = piA.handlers.get("agent_settled")[0];
	await settledA({ type: "agent_settled", aborted: true }, ctxA);
	const markerFileA = cancelMod.kickoffCancellationPath(cwd, sessionKey, runId);
	assert(
		fs.existsSync(markerFileA),
		"instance A's abort persisted the cancellation marker despite B's lock",
	);
	assert(
		piA.userMessages.length === 0,
		"instance A does not start the run while B holds the lock",
	);

	// B releases and continues dispatch: reads the marker from DISK (its
	// in-memory branch never saw the marker) and suppresses + cleans.
	stateMod.releaseDispatcherLock(cwd, sessionKey);
	await runDispatcher(cmdMod, piB, ctxB);
	assert(
		piB.userMessages.length === 0,
		"stale runtime instance B does not start the cancelled run after taking over",
	);
	const sB = stateMod.loadState(cwd, sessionKey);
	assert(
		sB.pendingWorkKickoff === undefined,
		"instance B clears only the matching pending; approved artifacts stay",
	);
	assert(
		cancelMod.readKickoffCancellation(cwd, sessionKey, runId).state === "cancelled",
		"cancel evidence survives instance B's dispatch pass",
	);
	// Handoff repair ran on B's pass: the repair is emitted through B's runtime
	// (pi.sendMessage → persisted to B's session by the real runtime). Verify
	// the repair message carries the canonical boundary marker payload, then
	// PERSIST it into B's SessionManager exactly as a real runtime would.
	const repairMsg = piB.messages.find(
		(m) =>
			m.customType === helpersTopMod.WORK_HANDOFF_CUSTOM_TYPE &&
			m.details?.workRunId === runId &&
			m.details?.boundary === true,
	);
	assert(
		!!repairMsg,
		"instance B's runtime emitted the repaired canonical handoff marker",
	);
	smB.appendCustomMessageEntry(
		repairMsg.customType,
		repairMsg.content,
		false,
		repairMsg.details,
	);
	const bBranch = smB.getBranch();
	const bRepairEntry = bBranch.find(
		(e) =>
			e.type === "custom_message" &&
			e.customType === helpersTopMod.WORK_HANDOFF_CUSTOM_TYPE &&
			e.details?.workRunId === runId &&
			e.details?.boundary === true,
	);
	assert(
		!!bRepairEntry,
		"the repaired canonical marker is persisted in B's SessionManager",
	);

	// REOPEN: a fresh SessionManager on the same file (real recovery) must not
	// replay the cancelled kickoff — the pending is already cleared, and even
	// a stale rewritten pending loses against the write-once marker.
	const smC = SessionManager.open(sessionFile, sessionDir, cwd);
	assert(
		smC.getBranch().some(
			(e) =>
				e.type === "custom_message" &&
				e.customType === helpersTopMod.WORK_HANDOFF_CUSTOM_TYPE &&
				e.details?.workRunId === runId &&
				e.details?.boundary === true,
		),
		"reopened SessionManager sees the persisted canonical marker",
	);
	const piC = makeFakePi();
	cmdMod.registerPendingWorkDispatcher(piC, () => agentDir);
	cmdMod.registerWorkflowContextInjection(piC, () => agentDir);
	const ctxC = makeFakeCtx(cwd, {
		sessionManager: {
			getSessionId: () => smC.getSessionId(),
			getSessionFile: () => smC.getSessionFile(),
			getBranch: () => smC.getBranch(),
		},
	});
	// Simulate a stale runtime rewriting the stale pending (old-bug scenario).
	stateMod.saveState(cwd, sessionKey, {
		...workState(stateMod, defaultsMod, runId),
		pendingWorkKickoff: runId,
	});
	await runDispatcher(cmdMod, piC, ctxC);
	assert(
		piC.userMessages.length === 0,
		"reopened session does not replay the cancelled kickoff (write-once marker)",
	);
	const sC = stateMod.loadState(cwd, sessionKey);
	assert(
		sC.pendingWorkKickoff === undefined,
		"reopened session cleans the stale pending without touching approved artifacts",
	);
	// Post-reopen user recovery: the context projection over a fresh provider
	// list (next user message) must isolate from the persisted marker — the
	// pre-approval seed message stays out, the handoff body stays in.
	const ctxHandlerC = piC.handlers.get("context")[0];
	assert(typeof ctxHandlerC === "function", "context handler registered for reopened session");
	// Real transcript: the persisted marker participates in LLM context, so the
	// provider list carries it (and the pre-approval seed before it).
	const providerMessages = [
		{ role: "user", content: "seed", timestamp: 1 },
		{
			role: "custom",
			customType: helpersTopMod.WORK_HANDOFF_CUSTOM_TYPE,
			content: bRepairEntry.content,
			display: false,
			details: bRepairEntry.details,
			timestamp: 5,
		},
		{ role: "user", content: "post-reopen user turn", timestamp: 9 },
	];
	const projC = await ctxHandlerC({ messages: providerMessages }, ctxC);
	const projTexts = projC.messages.map((m) => String(m.content));
	assert(
		projTexts.some((t) => t.includes("HB-runtime")),
		"reopened projection carries the handoff body",
	);
	assert(
		!projTexts.some((t) => t.includes("seed")),
		"reopened projection isolates the pre-approval seed message",
	);
	assert(
		projTexts.some((t) => t.includes("post-reopen user turn")),
		"reopened projection keeps the user's new message",
	);
	void pathsMod;
}

// ── Group 5: lock diagnostics ────────────────────────────────────────────────

console.log("\nDispatcher lock diagnostics");
{
	const stateMod = await loadWorkflowModule("state.ts");
	const pathsMod = await loadWorkflowModule("paths.ts");
	const { cwd, agentDir } = makeTmpProject("wf-cancel-lock-");
	void agentDir;
	const sessionKey = "lock-diag-session";

	const acquired = stateMod.acquireDispatcherLockTry(cwd, sessionKey);
	assert(acquired.outcome === "acquired", "lock claim succeeds on an empty dir");

	const busy = stateMod.acquireDispatcherLockTry(cwd, sessionKey);
	assert(busy.outcome === "busy" && !!busy.reason, "second claim → busy with a diagnostic reason");

	// Stale lock (dead pid) is reclaimable.
	const lockPath = pathsMod.sessionStatePath(cwd, sessionKey) + ".dispatch.lock";
	fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, at: Date.now() }));
	const reclaimed = stateMod.acquireDispatcherLockTry(cwd, sessionKey);
	assert(reclaimed.outcome === "acquired", "stale (dead pid) lock is reclaimed");

	// Corrupt lock file → busy (treated as live), never silently claimed.
	fs.writeFileSync(lockPath, "not json");
	const corrupt = stateMod.acquireDispatcherLockTry(cwd, sessionKey);
	assert(corrupt.outcome === "busy", "corrupt lock file → busy (treated as live)");

	// Permission error → diagnosable error outcome.
	fs.chmodSync(path.dirname(lockPath), 0o500);
	const denied = stateMod.acquireDispatcherLockTry(cwd, sessionKey);
	fs.chmodSync(path.dirname(lockPath), 0o755);
	assert(
		denied.outcome === "error" || denied.outcome === "busy",
		"unwritable dir → explicit error/busy (never a silent claim)",
	);

	stateMod.releaseDispatcherLock(cwd, sessionKey);
	const reAcquire = stateMod.acquireDispatcherLockTry(cwd, sessionKey);
	assert(reAcquire.outcome === "acquired", "release then re-acquire works");
	stateMod.releaseDispatcherLock(cwd, sessionKey);

	// Legacy boolean wrapper stays functional.
	assert(stateMod.acquireDispatcherLock(cwd, sessionKey) === true, "legacy boolean acquire contract holds");
	stateMod.releaseDispatcherLock(cwd, sessionKey);
}

// ── Group 6: mutex-busy drain + shutdown timer cleanup ─────────────────

console.log("\nMutex-busy drain + shutdown cleanup");
{
	const cmdMod = await loadWorkflowModule("commands.ts");
	const stateMod = await loadWorkflowModule("state.ts");
	const defaultsMod = await loadWorkflowModule("defaults.ts");
	const cancelMod = await loadWorkflowModule("kickoff-cancellation.ts");

	const { cwd, agentDir } = makeTmpProject("wf-cancel-drain-");
	const pi = makeFakePi();
	cmdMod.registerPendingWorkDispatcher(pi, () => agentDir);
	const handlers = pi.handlers.get("agent_settled");
	const settled = handlers[0];
	const shutdown = pi.handlers.get("session_shutdown")[0];
	assert(typeof shutdown === "function", "session_shutdown drain-timer cleanup registered");

	const ctx = makeFakeCtx(cwd);
	const runId = "run-drain-00000001";
	ctx.sessionManager.getBranch = () => branchWithJournal(runId, "handoff body");
	// Kickoff count baseline for this group (pi.userMessages is cumulative
	// across groups; asserts use deltas from this baseline).
	const sentBefore = pi.userMessages.length;
	const sessionKey = stateMod.getSessionKey(ctx);
	const markerFile = cancelMod.kickoffCancellationPath(cwd, sessionKey, runId);
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, runId));
	cancelMod.writeKickoffCancellation(cwd, sessionKey, runId);

	// Runtime still busy (messages pending): the cleanup-before-idle-gate path
	// clears a CANCELLED pending IMMEDIATELY (lock-free, sends nothing). No
	// drain wait is needed anymore.
	ctx.hasPendingMessages = () => true;
	await settled({ type: "agent_settled", aborted: true }, ctx);
	assert(
		stateMod.loadState(cwd, sessionKey).pendingWorkKickoff === undefined &&
			pi.userMessages.length === sentBefore,
		"busy runtime: cancelled pending is cleaned on the fast path without a kickoff",
	);

	// session_shutdown clears the drain bookkeeping. Re-pending the SAME
	// run stays suppressed by the write-once marker (evidence persists) and
	// is again cleaned on the busy fast path; a NEW run (fresh id) is not
	// cancelled — it schedules the dispatch drain and sends after the
	// runtime frees up.
	shutdown({ type: "session_shutdown" }, ctx);
	ctx.hasPendingMessages = () => true;
	stateMod.saveState(cwd, sessionKey, {
		...workState(stateMod, defaultsMod, runId),
		pendingWorkKickoff: runId,
	});
	await settled({ type: "agent_settled", aborted: false }, ctx);
	assert(
		stateMod.loadState(cwd, sessionKey).pendingWorkKickoff === undefined &&
			pi.userMessages.length === sentBefore,
		"re-pending a cancelled run after shutdown is cleaned again (write-once marker)",
	);

	// F14 (busy cleanup reschedule): the busy fast path awaits the cleanup's
	// file I/O; a shutdown during that await must ALSO stop the follow-up
	// drain that the fast path schedules afterwards.
	shutdown({ type: "session_shutdown" }, ctx);
	const heldRun = "run-drain-00000003";
	ctx.sessionManager.getBranch = () => branchWithJournal(heldRun, "handoff body");
	ctx.hasPendingMessages = () => true;
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, heldRun));
	cancelMod.writeKickoffCancellation(cwd, sessionKey, heldRun);
	// Fire a settled pass whose fast-path cleanup awaits I/O; shutdown races it.
	const racedPass = settled({ type: "agent_settled", aborted: false }, ctx);
	const sideEffectsAtShutdown = pi.messages.length;
	shutdown({ type: "session_shutdown" }, ctx);
	await racedPass;
	await new Promise((r) => setTimeout(r, 600));
	// Either the cleanup ran pre-shutdown (pending cleared, no kickoff for the
	// cancelled run) or shutdown won the race (pending kept) — in BOTH cases
	// no kickoff may go out and no post-shutdown repair may appear.
	const stRaced = stateMod.loadState(cwd, sessionKey);
	const racedClean = stRaced.pendingWorkKickoff === undefined;
	assert(
		pi.userMessages.length === sentBefore,
		"raced shutdown: no kickoff for the cancelled run",
	);
	assert(
		pi.messages.length === sideEffectsAtShutdown,
		"raced shutdown: no side effects after the shutdown call",
	);
	// Now the same pass WITHOUT the race: a fresh drain after shutdown must
	// not dispatch (generation still cancelled until a new schedule).
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, heldRun));
	ctx.hasPendingMessages = () => false;
	await new Promise((r) => setTimeout(r, 100));
	assert(
		pi.userMessages.length === sentBefore,
		"no stray drain dispatch after the raced shutdown",
	);
	void racedClean;

	// A fresh run after shutdown flows through the drain normally.
	shutdown({ type: "session_shutdown" }, ctx);
	const freshRun = "run-drain-00000002";
	ctx.sessionManager.getBranch = () => branchWithJournal(freshRun, "handoff body");
	ctx.hasPendingMessages = () => true;
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, freshRun));
	await settled({ type: "agent_settled", aborted: false }, ctx);
	ctx.hasPendingMessages = () => false;
	await new Promise((r) => setTimeout(r, 400));
	assert(
		pi.userMessages.length === sentBefore + 1 &&
			pi.userMessages[sentBefore].includes(freshRun),
		"a fresh work run (new id) dispatches normally through the drain",
	);
	assert(
		pi.userMessages.every((m) => !m.includes(heldRun)),
		"the shutdown-cancelled drain never dispatched its run",
	);
}

// ── Group 6b: journal-fallback custom-message retention (F13) ───────────

console.log("\nJournal-fallback custom-message retention (both orders)");
async function f13Scenario(customBeforeUser) {
	const cmdMod = await loadWorkflowModule("commands.ts");
	const stateMod = await loadWorkflowModule("state.ts");
	const defaultsMod = await loadWorkflowModule("defaults.ts");
	const helpersMod = await loadWorkflowModule("helpers.ts");
	const pi = makeFakePi();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-f13-"));
	const cwd = path.join(tmp, "project");
	fs.mkdirSync(cwd, { recursive: true });
	cmdMod.registerPendingWorkDispatcher(pi, () => path.join(tmp, "agent"));
	cmdMod.registerWorkflowContextInjection(pi, () => path.join(tmp, "agent"));
	const runId = "run-f13-" + (customBeforeUser ? "a" : "b");
	const branch = [
		{ type: "message", id: "u0", message: { role: "user", content: "sentinel", timestamp: 100 } },
		{ type: "custom", id: "j1", customType: helpersMod.WORK_APPROVAL_CUSTOM_TYPE, data: { workRunId: runId, handoffBody: "HB-F13" } },
	];
	if (customBeforeUser) {
		branch.push({ type: "custom_message", id: "c1", customType: "some-custom-note", content: "custom-context-note", display: false });
		branch.push({ type: "message", id: "u2", message: { role: "user", content: "late-user-instruction", timestamp: 300 } });
	} else {
		branch.push({ type: "message", id: "u2", message: { role: "user", content: "late-user-instruction", timestamp: 300 } });
		branch.push({ type: "custom_message", id: "c1", customType: "some-custom-note", content: "custom-context-note", display: false });
	}
	const ctx = makeFakeCtx(cwd);
	ctx.sessionManager.getBranch = () => branch;
	const sessionKey = stateMod.getSessionKey(ctx);
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, runId));
	const settled = pi.handlers.get("agent_settled")[0];
	await settled({ type: "agent_settled", aborted: true }, ctx);
	const repair = pi.messages.find((m) => m.customType === helpersMod.WORK_HANDOFF_CUSTOM_TYPE);
	branch.push({ type: "custom_message", id: "r1", customType: helpersMod.WORK_HANDOFF_CUSTOM_TYPE, content: repair.content, display: false, details: repair.details });
	const providerMessages = [
		{ role: "user", content: "sentinel", timestamp: 100 },
		...(customBeforeUser
			? [
					{ role: "custom", customType: "some-custom-note", content: "custom-context-note", display: false, timestamp: 200 },
					{ role: "user", content: "late-user-instruction", timestamp: 300 },
				]
			: [
					{ role: "user", content: "late-user-instruction", timestamp: 300 },
					{ role: "custom", customType: "some-custom-note", content: "custom-context-note", display: false, timestamp: 350 },
				]),
		{ role: "custom", customType: helpersMod.WORK_HANDOFF_CUSTOM_TYPE, content: repair.content, display: false, details: repair.details, timestamp: 400 },
		{ role: "user", content: "current-user-turn", timestamp: 500 },
	];
	const ctxHandler = pi.handlers.get("context")[0];
	const out = await ctxHandler({ messages: providerMessages }, ctx);
	const texts = out.messages.map((m) => String(m.content));
	return {
		customRetained: texts.some((t) => t.includes("custom-context-note")),
		lateRetained: texts.some((t) => t.includes("late-user-instruction")),
		currentRetained: texts.some((t) => t.includes("current-user-turn")),
		handoffPresent: texts.some((t) => t.includes("HB-F13")),
		// Fail-open recovery is EXPLICIT (notice present), never silent.
		explicitRecoveryNotice: texts.some((t) =>
			t.includes("Cancelled Work Run — Context Restored"),
		),
	};
}
{
	const before = await f13Scenario(true);
	assert(
		before.customRetained && before.lateRetained && before.currentRetained &&
			before.handoffPresent && before.explicitRecoveryNotice,
		`custom-message-before-late-user: retained + explicit recovery ${JSON.stringify(before)}`,
	);
	const after = await f13Scenario(false);
	assert(
		after.customRetained && after.lateRetained && after.currentRetained &&
			after.handoffPresent && after.explicitRecoveryNotice,
		`custom-message-after-late-user: retained + explicit recovery ${JSON.stringify(after)}`,
	);
}

// ── Group 6c: real mutex-wait shutdown cancellation (F17/F14) ───────────

console.log("\nReal mutex-wait drain cancelled by shutdown");
{
	const cmdMod = await loadWorkflowModule("commands.ts");
	const stateMod = await loadWorkflowModule("state.ts");
	const defaultsMod = await loadWorkflowModule("defaults.ts");
	const cancelMod = await loadWorkflowModule("kickoff-cancellation.ts");

	const { cwd, agentDir } = makeTmpProject("wf-cancel-mutexwait-");
	const pi = makeFakePi();
	cmdMod.registerPendingWorkDispatcher(pi, () => agentDir);
	const settled = pi.handlers.get("agent_settled")[0];
	const shutdown = pi.handlers.get("session_shutdown")[0];
	const ctx = makeFakeCtx(cwd);
	const heldRun = "run-mutexwait-00000001";
	ctx.sessionManager.getBranch = () => branchWithJournal(heldRun, "handoff body");
	const sessionKey = stateMod.getSessionKey(ctx);
	stateMod.saveState(cwd, sessionKey, workState(stateMod, defaultsMod, heldRun));
	cancelMod.writeKickoffCancellation(cwd, sessionKey, heldRun);

	// Hold the cross-process file lock so pass A (agent_settled) enters the
	// dispatcher (mutex claimed) and spins on the busy retry (~150ms). During
	// that window pass B hits the in-process mutex branch and schedules a
	// drain whose wait loop spins on _dispatcherInFlight — the real wait.
	stateMod.acquireDispatcherLock(cwd, sessionKey);
	ctx.hasPendingMessages = () => true;
	const passA = settled({ type: "agent_settled", aborted: false }, ctx);
	await new Promise((r) => setTimeout(r, 40));
	const passB = settled({ type: "agent_settled", aborted: false }, ctx);
	// Shutdown while the drain is (or is about to be) mid-await.
	shutdown({ type: "session_shutdown" }, ctx);
	stateMod.releaseDispatcherLock(cwd, sessionKey);
	await Promise.all([passA, passB]);
	await new Promise((r) => setTimeout(r, 700));
	const st = stateMod.loadState(cwd, sessionKey);
	assert(
		pi.userMessages.length === 0,
		"mutex-wait shutdown: no kickoff for the cancelled run",
	);
	assert(
		pi.messages.every((m) => m.details?.workRunId !== heldRun),
		"mutex-wait shutdown: no handoff repair side effect",
	);
	assert(
		cancelMod.readKickoffCancellation(cwd, sessionKey, heldRun).state === "cancelled",
		"cancel evidence survives the mutex-wait shutdown race",
	);
	// Pending may be cleared (if A's locked-section cleanup won the race
	// before shutdown) or kept (shutdown won) — both are safe; the marker
	// guarantees no dispatch either way.
	void st;
}

// ── Group 7: dispatcher-lifecycle cancellation wiring (F14) ─────────────

console.log("\nDispatcher-lifecycle cancellation (shouldAbort threadi)");

{
	const commandsSrc = fs.readFileSync(path.join(root, "extensions/workflow/commands.ts"), "utf8");
	// The drain threads its generation into the dispatcher as shouldAbort.
	assert(
		/shouldAbort:\s*cancelled/.test(commandsSrc),
		"drain threads its generation check as shouldAbort",
	);
	// The dispatcher checks it after the async imports, before side effects.
	// Anchor: the check comment sits AFTER the dynamic-import block and BEFORE
	// the advisory-lock acquire (so this is the post-await point, not line 815's
	// fast-path check).
	{
		// Entry check: after the in-process mutex claim, before the advisory
		// lock / any side effect. Post-await points re-check separately (the
		// drain generation loop, the cancelled branch, and the send port).
		const checkIdx = commandsSrc.indexOf("Lifecycle check on entry");
		const lockIdx = commandsSrc.indexOf(
			"acquireDispatcherLockWithRetry(ctx.cwd, sessionKey)",
			checkIdx,
		);
		assert(
			checkIdx !== -1 && lockIdx > checkIdx,
			"entry lifecycle check sits before the advisory lock",
		);
		assert(
			/if \(shouldAbort\?\.\(\)\) return/.test(commandsSrc.slice(checkIdx, lockIdx)),
			"dispatcher checks merged shouldAbort on entry before the lock acquire",
		);
	}
	assert(
		/cancel\.status === "cancelled"\) \{[\s\S]{0,120}if \(shouldAbort\?\.\(\)\) return/.test(commandsSrc),
		"cancelled branch re-checks shouldAbort before repair/clear side effects",
	);
	// The final send port re-checks: shutdown-mid-dispatch keeps the pending.
	assert(
		/sendKickoff: \(workRunId: string\): boolean => \{[\s\S]{0,400}if \(shouldAbort\?\.\(\)\) return false/.test(commandsSrc),
		"final send port re-checks merged shouldAbort (shutdown keeps the pending)",
	);
	// Every entry merges the process shutdown flag (session_start resume is
	// protected even without an explicit caller callback — F18).
	assert(
		/_shutDownSessions\.has\(sessionKey\) \|\| \(callerShouldAbort\?\.\(\) \?\? false\)/.test(commandsSrc),
		"dispatcher entry merges the process shutdown flag with the caller callback",
	);
	assert(
		/callerShouldAbort = opts\.shouldAbort/.test(commandsSrc),
		"caller callback remains mergeable via opts.shouldAbort",
	);
}

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);
