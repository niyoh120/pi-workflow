/**
 * kickoff-cancellation.ts — durable sidecar cancellation marker for the
 * pending Approved-Plan Work kickoff.
 *
 * Why a sidecar (not WorkflowState, not the session branch):
 *  - Pi's SessionManager.getBranch() reads an in-memory index; another
 *    runtime instance appending to the same session file cannot refresh it.
 *    A branch-recorded cancellation would stay invisible to stale instances.
 *  - WorkflowState is per-runtime in memory until the next saveState; a
 *    stale instance could resurrect a cleared pending field.
 *  - Every send path can cheaply re-read a shared disk file, and the write
 *    is atomic (temp file + rename), so once `write` returns ok the
 *    suppression holds for ALL instances of this session.
 *
 * Lifecycle:
 *  - Write-once per work run: cancelling the same run is idempotent; the
 *    marker is never deleted by this module, so a stale instance rebuilding
 *    a pending entry later still loses the race against the marker.
 *  - New work runs use a fresh workRunId, so they never inherit an old
 *    cancellation (the file name is a hash of the run id).
 *  - /workflow:reset keeps the markers: old instances of this session may
 *    still be alive, and a stale marker never affects a new run id.
 *  - Markers die with the session data directory (manual cleanup only).
 *
 * Failure semantics (fail-closed):
 *  - A READ error (corrupt JSON, id mismatch, permission) is surfaced as
 *    `error` and MUST suppress the automatic kickoff — an unreadable
 *    suppression must never degrade into "probably fine, send it".
 *  - A WRITE failure is reported to the caller so it can (a) block the
 *    kickoff for this process via a session-local intent and (b) warn that
 *    the cancellation did NOT become durable (a restart has no evidence).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sessionDir } from "./paths.js";

/** Current marker schema version. */
const MARKER_VERSION = 1;

/** Marker file prefix; the suffix is a hash of the workRunId. */
const FILE_PREFIX = "kickoff-cancel-";

/** On-disk marker payload. `workRunId` guards against hash collisions. */
export interface KickoffCancellationMarker {
	version: number;
	workRunId: string;
	cancelledAt: string;
}

/** Read result: absent / cancelled / error (fail-closed). */
export type KickoffCancellationStatus =
	| { state: "absent" }
	| { state: "cancelled"; workRunId: string }
	| { state: "error"; error: string };

/** Write result: ok (including idempotent re-cancel) or an explicit error. */
export type KickoffCancellationWriteResult =
	| { ok: true }
	| { ok: false; error: string };

/**
 * Pure path function: session data directory + hash-of-workRunId filename.
 * Writers create the directory; readers tolerate a missing file.
 */
export function kickoffCancellationPath(
	cwd: string,
	sessionKey: string,
	workRunId: string,
): string {
	const hash = crypto
		.createHash("sha256")
		.update(workRunId)
		.digest("hex")
		.slice(0, 16);
	return path.join(sessionDir(cwd, sessionKey), `${FILE_PREFIX}${hash}.json`);
}

/**
 * Atomically persist the cancellation marker for one work run. Cancelling
 * an already-cancelled run is a no-op success (write-once, never delete).
 * Uses temp file + rename in the same directory so readers never observe a
 * partial marker.
 */
export function writeKickoffCancellation(
	cwd: string,
	sessionKey: string,
	workRunId: string,
	now: string = new Date().toISOString(),
): KickoffCancellationWriteResult {
	if (typeof workRunId !== "string" || !workRunId.trim()) {
		return { ok: false, error: "workRunId is required" };
	}
	const file = kickoffCancellationPath(cwd, sessionKey, workRunId);
	try {
		// Idempotent re-cancel: a matching marker is a no-op success. Read
		// first (no existsSync — a permission error on the existing marker is
		// an explicit failure, never an overwrite opportunity); ENOENT falls
		// through to the write path.
		const existing = readKickoffCancellation(cwd, sessionKey, workRunId);
		if (existing.state === "cancelled") return { ok: true };
		if (existing.state === "error") {
			return { ok: false, error: `existing marker unreadable: ${existing.error}` };
		}
		const dir = path.dirname(file);
		fs.mkdirSync(dir, { recursive: true });
		const marker: KickoffCancellationMarker = {
			version: MARKER_VERSION,
			workRunId,
			cancelledAt: now,
		};
		const tmp = path.join(
			dir,
			`.tmp-kickoff-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		fs.writeFileSync(tmp, JSON.stringify(marker, null, 2), "utf8");
		fs.renameSync(tmp, file);
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Read the cancellation status for one work run. A malformed or foreign
 * marker (id mismatch against the requested run) is an explicit `error`,
 * never a silent "absent" — fail closed and suppress the kickoff.
 *
 * Reads the file DIRECTLY (no existsSync pre-check): existsSync returns
 * false for permission/traversal errors too, which would degrade a real
 * I/O failure into "absent" and let the kickoff through. Only ENOENT is
 * "absent"; every other read error is fail-closed.
 */
export function readKickoffCancellation(
	cwd: string,
	sessionKey: string,
	workRunId: string,
): KickoffCancellationStatus {
	const file = kickoffCancellationPath(cwd, sessionKey, workRunId);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { state: "absent" };
		}
		return {
			state: "error",
			error: `marker unreadable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	try {
		const parsed = JSON.parse(raw) as Partial<KickoffCancellationMarker>;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			parsed.version !== MARKER_VERSION ||
			typeof parsed.workRunId !== "string"
		) {
			return {
				state: "error",
				error: `marker malformed (version ${String((parsed as { version?: unknown })?.version)})`,
			};
		}
		if (parsed.workRunId !== workRunId) {
			return {
				state: "error",
				error: `marker belongs to a different run (${parsed.workRunId.slice(-8)}), expected ${workRunId.slice(-8)}`,
			};
		}
		return { state: "cancelled", workRunId };
	} catch (err) {
		return {
			state: "error",
			error: `marker corrupt: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
