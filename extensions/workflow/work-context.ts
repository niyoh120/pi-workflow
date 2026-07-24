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
	writeMarker(handoffBody: string, workRunId: string): void;
	sendKickoff(workRunId: string): void;
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
		const data = e.details as ApprovalJournalData | undefined;
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
 * Shared by write_marker_and_send and late_user_no_replay paths.
 */
function resolveHandoff(
	ports: DispatcherPorts,
): { handoffBody: string; workRunId: string } | undefined {
	const state = ports.loadState();
	const branch = ports.getBranch();
	if (!branch || !state.workRunId) return undefined;
	const journalIdx = findApprovalJournalIndex(branch, state.workRunId);
	if (journalIdx === -1) return undefined;
	const data = branch[journalIdx].details as ApprovalJournalData | undefined;
	if (!data?.handoffBody) return undefined;
	return { handoffBody: data.handoffBody, workRunId: state.workRunId };
}

/**
 * Execute the dispatcher decision through ports. Handles the side-effect
 * sequence for each decision branch.
 */
export function executeDispatcherDecision(
	decision: DispatcherDecision,
	ports: DispatcherPorts,
): void {
	switch (decision.action) {
		case "skip":
			return;
		case "ack":
			ports.clearPending();
			return;
		case "send_kickoff": {
			const state = ports.loadState();
			if (!state.workRunId) return;
			ports.sendKickoff(state.workRunId);
			ports.clearPending();
			return;
		}
		case "write_marker_and_send": {
			const resolved = resolveHandoff(ports);
			if (!resolved) return;
			ports.writeMarker(resolved.handoffBody, resolved.workRunId);
			ports.sendKickoff(resolved.workRunId);
			ports.clearPending();
			return;
		}
		case "late_user_no_replay": {
			const resolved = resolveHandoff(ports);
			if (!resolved) return;
			ports.appendLateSnapshot(resolved.handoffBody, resolved.workRunId);
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
