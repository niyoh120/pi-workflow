/**
 * Pure logic for Plan→Work handoff lifecycle, context isolation, and
 * dispatcher decision-making. No runtime I/O — all side effects go through
 * injectable ports so the module is fully testable with fake runtimes.
 */

import { WORK_HANDOFF_CUSTOM_TYPE, WORK_APPROVAL_CUSTOM_TYPE, type WorkApprovalData } from "./helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal session branch entry shape (from sessionManager.getBranch()). */
export interface BranchEntry {
	type: string;
	id?: string;
	customType?: string;
	/** CustomEntry.data — approval journal payload lives here. */
	data?: unknown;
	/** CustomMessageEntry.details — handoff marker metadata lives here. */
	details?: unknown;
	timestamp?: string;
	message?: { role?: string; content?: unknown; toolCallId?: string };
}

/** Minimal provider-visible message shape (from context event). */
export interface ContextMessage {
	role?: string;
	customType?: string;
	details?: unknown;
	timestamp?: number;
	toolCallId?: string;
	content?: unknown;
}

/** Approval journal data stored via pi.appendEntry. Reuses WorkApprovalData from helpers. */
export type ApprovalJournalData = WorkApprovalData;

/** Dispatcher decision result. */
export type DispatcherDecision =
	| { action: "skip" }
	| { action: "ack"; reason: string }
	| { action: "send_kickoff" }
	| { action: "write_marker_and_send" }
	| { action: "late_user_no_replay" };

/** Injectable ports for the dispatcher (all I/O goes through these). */
export interface DispatcherPorts {
	loadState(): { mode: string; workRunId?: string; planPath?: string; pendingWorkKickoff?: string };
	getBranch(): BranchEntry[] | undefined;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	/**
	 * Read the shared disk cancellation marker for a work run. States:
	 * absent / cancelled / error (fail-closed). Called immediately before
	 * any send so a stale runtime holding an old branch still observes the
	 * durable cancellation.
	 */
	readCancellation(workRunId: string): { state: "absent" } | { state: "cancelled" } | { state: "error"; error: string };
	writeMarker(handoffBody: string, workRunId: string): void;
	/**
	 * Actually send the kickoff. Implementations MUST perform the final
	 * precondition check (reload state + read the shared marker + confirm
	 * mode/run/pending, no await between check and send) and return whether
	 * the kickoff was actually sent — a cancelled run reports false.
	 */
	sendKickoff(workRunId: string): boolean;
	/**
	 * Optional lifecycle abort (e.g. shutdown mid-dispatch): when true, the
	 * decision executor skips ALL side effects (late snapshot, pending
	 * clears) so a shutting-down session keeps state for later recovery.
	 */
	shouldAbort?: () => boolean;
	clearPending(): void;
	appendLateSnapshot(handoffBody: string, workRunId: string): void;
}

// ── Canonical selection ──────────────────────────────────────────────────────

/**
 * Find the earliest approval journal entry matching the given workRunId.
 * Returns its index in the branch array, or -1.
 */
export function findApprovalJournalIndex(
	entries: BranchEntry[],
	workRunId: string,
): number {
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e.type !== "custom") continue;
		if (e.customType !== WORK_APPROVAL_CUSTOM_TYPE) continue;
		// pi.appendEntry stores the payload as CustomEntry.data, not details.
		const data = e.data as ApprovalJournalData | undefined;
		if (data?.workRunId === workRunId) return i;
	}
	return -1;
}

/**
 * Find the canonical boundary marker: earliest handoff marker with
 * details.boundary === true and matching workRunId, located after the
 * given journal index.
 * Returns its index in the branch array, or -1.
 */
export function findCanonicalMarkerIndex(
	entries: BranchEntry[],
	workRunId: string,
	afterJournalIndex: number,
): number {
	for (let i = afterJournalIndex + 1; i < entries.length; i++) {
		const e = entries[i];
		if (e.type !== "custom_message") continue;
		if (e.customType !== WORK_HANDOFF_CUSTOM_TYPE) continue;
		const details = e.details as { workRunId?: string; boundary?: boolean } | undefined;
		if (details?.workRunId === workRunId && details?.boundary === true) return i;
	}
	return -1;
}

/**
 * Check whether a user message entry exists after the given index.
 * Returns true if any session message entry with role "user" is found.
 */
export function hasUserEntryAfter(
	entries: BranchEntry[],
	afterIndex: number,
): boolean {
	for (let i = afterIndex + 1; i < entries.length; i++) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "user") return true;
	}
	return false;
}

// ── Dispatcher decision ──────────────────────────────────────────────────────

/**
 * Compute the dispatcher decision given current state and branch evidence.
 * Pure function — no I/O.
 */
export function computeDispatcherDecision(
	state: { mode: string; workRunId?: string; planPath?: string; pendingWorkKickoff?: string },
	branch: BranchEntry[] | undefined,
): DispatcherDecision {
	// Gate: must be Work mode with matching pending.
	if (state.mode !== "work") return { action: "skip" };
	if (!state.workRunId || !state.planPath) return { action: "skip" };
	if (state.pendingWorkKickoff !== state.workRunId) return { action: "skip" };

	if (!branch) return { action: "skip" }; // fail-open: no branch access

	const journalIdx = findApprovalJournalIndex(branch, state.workRunId);
	if (journalIdx === -1) return { action: "skip" }; // no journal → stale/corrupt

	const markerIdx = findCanonicalMarkerIndex(branch, state.workRunId, journalIdx);

	if (markerIdx !== -1) {
		// Marker exists — check for post-marker user evidence.
		if (hasUserEntryAfter(branch, markerIdx)) {
			return { action: "ack", reason: "post-marker user evidence" };
		}
		return { action: "send_kickoff" };
	}

	// Marker missing — check for late user (journal-after user entry).
	if (hasUserEntryAfter(branch, journalIdx)) {
		return { action: "late_user_no_replay" };
	}

	// No marker, no user — normal first-time path.
	return { action: "write_marker_and_send" };
}

/**
 * Resolve the handoff body and workRunId from the approval journal.
 * Shared by write_marker_and_send and late_user_no_replay paths. When the
 * journal is unrecoverable, still returns the workRunId with handoffBody
 * undefined so the caller can clear the matching pending entry with an
 * explicit error (never fabricate context).
 */
function resolveHandoff(
	ports: DispatcherPorts,
): { handoffBody?: string; workRunId: string } | undefined {
	const state = ports.loadState();
	const branch = ports.getBranch();
	if (!branch || !state.workRunId) return undefined;
	const journalIdx = findApprovalJournalIndex(branch, state.workRunId);
	if (journalIdx === -1) return { workRunId: state.workRunId };
	const data = branch[journalIdx].data as ApprovalJournalData | undefined;
	if (!data?.handoffBody) return { workRunId: state.workRunId };
	return { handoffBody: data.handoffBody, workRunId: state.workRunId };
}

/**
 * Cancellation outcome for one dispatch pass.
 *  - not-cancelled: proceed with the branch-evidence decision.
 *  - cancelled: durable marker present; caller keeps the handoff and clears
 *    only the matching pending entry.
 *  - error: marker unreadable/mismatched — fail closed, suppress the send
 *    and report; the pending entry stays for a subsequent pass.
 */
export type CancellationCheck =
	| { status: "not-cancelled" }
	| { status: "cancelled"; workRunId: string }
	| { status: "error"; workRunId: string; error: string };

/**
 * Gate any kickoff-capable pass on the SHARED DISK marker. The branch is
 * used only for handoff/approval evidence — cancellation is judged from the
 * durable marker so stale runtimes with old in-memory branch indexes cannot
 * miss a cancellation written by another instance.
 */
export function checkKickoffCancellation(ports: {
	loadState(): { mode: string; workRunId?: string; pendingWorkKickoff?: string };
	readCancellation(
		workRunId: string,
	): { state: "absent" } | { state: "cancelled" } | { state: "error"; error: string };
}): CancellationCheck {
	const state = ports.loadState();
	const workRunId = state.workRunId;
	if (!workRunId || state.mode !== "work" || state.pendingWorkKickoff !== workRunId) {
		return { status: "not-cancelled" };
	}
	const c = ports.readCancellation(workRunId);
	if (c.state === "absent") return { status: "not-cancelled" };
	if (c.state === "cancelled") return { status: "cancelled", workRunId };
	return { status: "error", workRunId, error: c.error };
}

/**
 * Execute the dispatcher decision through ports. Handles the side-effect
 * sequence for each decision branch. Every kickoff-capable path re-reads
 * loadState + the cancellation marker immediately before the actual send
 * (no await between the read and the send) and re-verifies mode/run/pending
 * still match, closing the in-process race where a cancel lands during
 * branch evidence gathering.
 */
export function executeDispatcherDecision(
	decision: DispatcherDecision,
	ports: DispatcherPorts,
): void {
	switch (decision.action) {
		case "skip":
			return;
		case "ack":
			if (ports.shouldAbort?.()) return;
			ports.clearPending();
			return;
		case "send_kickoff": {
			const state = ports.loadState();
			if (!state.workRunId) return;
			if (
				state.mode !== "work" ||
				state.pendingWorkKickoff !== state.workRunId ||
				ports.readCancellation(state.workRunId).state !== "absent"
			) {
				return;
			}
			// sendKickoff performs the authoritative final check inside the
			// send port; only clear pending when the kickoff actually went out.
			if (ports.sendKickoff(state.workRunId) && !ports.shouldAbort?.()) {
				ports.clearPending();
			}
			return;
		}
		case "write_marker_and_send": {
			const resolved = resolveHandoff(ports);
			if (!resolved) return;
			if (!resolved.handoffBody) return;
			const state = ports.loadState();
			if (
				!state.workRunId ||
				state.workRunId !== resolved.workRunId ||
				state.mode !== "work" ||
				state.pendingWorkKickoff !== state.workRunId ||
				ports.readCancellation(state.workRunId).state !== "absent"
			) {
				return;
			}
			if (ports.shouldAbort?.()) return;
			ports.writeMarker(resolved.handoffBody, resolved.workRunId);
			// The send port re-checks state + marker with no await in between;
			// a cancellation landing between the precheck above and the send
			// suppresses the kickoff here.
			if (ports.sendKickoff(resolved.workRunId) && !ports.shouldAbort?.()) {
				ports.clearPending();
			}
			return;
		}
		case "late_user_no_replay": {
			const resolved = resolveHandoff(ports);
			if (!resolved) return;
			if (ports.shouldAbort?.()) return;
			// Late user: never send. Missing handoff with an unrecoverable
			// journal still clears the matching pending (caller reports) — the
			// next user message walks the recovery-warning path.
			if (resolved.handoffBody) {
				ports.appendLateSnapshot(resolved.handoffBody, resolved.workRunId);
			}
			ports.clearPending();
			return;
		}
	}
}

// ── Context isolation ────────────────────────────────────────────────────────

/**
 * Find the earliest matching boundary marker in provider-visible messages.
 * Returns its index, or -1.
 */
export function findMarkerInMessages(
	messages: ContextMessage[],
	workRunId: string,
): number {
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "custom") continue;
		if (msg.customType !== WORK_HANDOFF_CUSTOM_TYPE) continue;
		const details = msg.details as { workRunId?: string; boundary?: boolean } | undefined;
		if (details?.workRunId === workRunId && details?.boundary === true) return i;
	}
	return -1;
}

/**
 * Drop leading orphan toolResult messages (no preceding toolCall).
 * Stops at the first non-toolResult message.
 */
export function dropLeadingOrphanToolResults<T extends ContextMessage>(
	messages: T[],
): T[] {
	let firstSafe = 0;
	while (firstSafe < messages.length && messages[firstSafe]?.role === "toolResult") {
		firstSafe++;
	}
	return messages.slice(firstSafe);
}

/**
 * Validate toolCall/toolResult pairing in a message sequence.
 * Returns true if every toolResult has a preceding toolCall and every
 * toolCall has a subsequent toolResult.
 */
export function validateToolPairing(messages: ContextMessage[]): boolean {
	const openCalls = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "assistant") {
			// Collect toolCall IDs from assistant content.
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					// Pi assistant content blocks are untyped heterogeneous arrays;
					// cast needed because ContentBlock has no discriminated union for toolCall.
					const cb = block as { type?: string; id?: string };
					if (
						cb &&
						typeof cb === "object" &&
						cb.type === "toolCall" &&
						typeof cb.id === "string"
					) {
						openCalls.add(cb.id);
					}
				}
			}
		} else if (msg.role === "toolResult") {
			const id = msg.toolCallId;
			// toolResult without a valid toolCallId is unpaired by definition.
			if (typeof id !== "string") return false;
			if (!openCalls.has(id)) return false; // orphan result
			openCalls.delete(id);
		}
	}

	// Any remaining open calls without results → invalid.
	return openCalls.size === 0;
}

/**
 * Apply Approved-Plan Work context isolation to provider-visible messages.
 *
 * Fast path: marker visible in messages → slice from marker (inclusive).
 * Fallback: marker not visible → return undefined (caller handles branch
 * recovery or fail-open).
 *
 * Returns the isolated message array, or undefined if the marker is not
 * visible and branch recovery is needed.
 */
export function isolateWorkContext<T extends ContextMessage>(
	messages: T[],
	workRunId: string,
): T[] | undefined {
	const markerIdx = findMarkerInMessages(messages, workRunId);
	if (markerIdx === -1) return undefined; // needs branch recovery

	// Slice from marker (inclusive) — marker is the stable prefix.
	const sliced = messages.slice(markerIdx);

	// Drop leading orphan toolResults (shouldn't happen with settled marker,
	// but defensive).
	const cleaned = dropLeadingOrphanToolResults(sliced);

	// Validate tool pairing.
	if (!validateToolPairing(cleaned)) {
		return undefined; // pairing broken → caller fail-open
	}

	return cleaned;
}
