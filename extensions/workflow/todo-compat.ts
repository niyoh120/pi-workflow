/**
 * todo-compat.ts — Paseo native TodoListCard compatibility contract.
 *
 * pi-workflow registers an `update_plan` tool in RPC mode whose arguments
 * match the schema Paseo already parses into its native todo list card.
 * This module is the single source of truth for that contract so the tool
 * registration, input mapping, and fixtures all reference one definition.
 *
 * Verified against Paseo 0.2.1, commit 65633004b23d6eeeda9321e04f096ca647694b2b
 * (2026-07-24). Paseo normalizes the tool name and parses the `plan` array
 * via UpdatePlanSchema (zod). Pi history mapper replays persisted tool calls,
 * and Paseo's timeline reducer uses the same parser for live and history
 * tool-call input, so resume reconstructs the todo card.
 *
 * Compatibility ceiling: Paseo's todo status enum is `pending | in_progress |
 * completed`. pi-workflow's internal `blocked` status has no native slot and
 * is encoded as a `[blocked] ` prefix on the step text; the card shows it as
 * a pending item with the prefix. Structured `notes` are inlined into the
 * step text. Upgrading past these ceilings requires a Paseo mapper change.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TodoItem, TodoStatus } from "./types.js";

// ── Verified Paseo contract ────────────────────────────────────────────────

/** Paseo version this compatibility layer was verified against. */
export const PASEO_VERIFIED_VERSION = "0.2.1";

/** Paseo commit this compatibility layer was verified against. */
export const PASEO_VERIFIED_COMMIT = "65633004b23d6eeeda9321e04f096ca647694b2b";

/**
 * Tool name Paseo normalizes and recognizes. `normalizeToolName` lowercases
 * and replaces non-alphanumeric runs with `_`, so `update_plan` is stable.
 */
export const UPDATE_PLAN_TOOL_NAME = "update_plan";

/** Prefix encoding internal `blocked` status in Paseo's three-state schema. */
export const BLOCKED_PREFIX = "[blocked] ";

/** Paseo's todo status enum (no native blocked slot). */
export const PASEO_TODO_STATUS = ["pending", "in_progress", "completed"] as const;
export type PaseoTodoStatus = (typeof PASEO_TODO_STATUS)[number];

// ── TypeBox schema for the update_plan tool ───────────────────────────────

/** Single plan entry: step text + three-state status. */
export const UpdatePlanItemSchema = Type.Object({
	step: Type.String({ description: "Task description. [blocked] prefix marks a blocked task." }),
	status: Type.Optional(
		Type.Union(
			[
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("completed"),
			],
			{ description: "pending | in_progress | completed (defaults to pending)" },
		),
	),
});

/** Full update_plan parameters. `plan` omitted => read current todos. */
export const UpdatePlanParamsSchema = Type.Object({
	plan: Type.Optional(
		Type.Array(UpdatePlanItemSchema, {
			description:
				"Full replacement todo list. Omit to read the current list without updating.",
		}),
	),
});

// ── Shared mutation core ──────────────────────────────────────────────────

/**
 * Apply a workflow_todo action to the in-memory state. Does NOT save; the
 * caller persists the returned state and refreshes the overlay. Shared by
 * workflow_todo (TUI) and update_plan (RPC alias) so both stay in sync with
 * the same todo semantics.
 */
export function applyTodoAction(
	state: TodoItem[],
	action:
		| { kind: "reset"; items?: Array<{ id?: string; title: string; status?: TodoStatus; notes?: string }> }
		| { kind: "add"; id?: string; title: string; status?: TodoStatus; notes?: string }
		| { kind: "set"; id: string; title?: string; status?: TodoStatus; notes?: string | undefined }
		| { kind: "replace"; items: Array<{ step: string; status?: PaseoTodoStatus }> },
): TodoItem[] {
	switch (action.kind) {
		case "reset": {
			const usedIds = new Set<string>();
			return (action.items ?? []).map((item, index) => {
				let id = item.id;
				if (!id) {
					let candidate = index + 1;
					while (usedIds.has(`T${candidate}`)) candidate += 1;
					id = `T${candidate}`;
				}
				if (usedIds.has(id)) throw new Error(`Duplicate todo ID: ${id}`);
				usedIds.add(id);
				return {
					id,
					title: item.title,
					status: item.status ?? "pending",
					notes: item.notes,
				};
			});
		}
		case "add": {
			const usedIds = new Set(state.map((todo) => todo.id));
			if (action.id && usedIds.has(action.id)) {
				throw new Error(`Todo ID already exists: ${action.id}`);
			}
			let nextIndex = state.length + 1;
			while (usedIds.has(`T${nextIndex}`)) nextIndex += 1;
			return [
				...state,
				{
					id: action.id || `T${nextIndex}`,
					title: action.title,
					status: action.status ?? "pending",
					notes: action.notes,
				},
			];
		}
		case "set": {
			return state.map((todo) => {
				if (todo.id !== action.id) return todo;
				return {
					...todo,
					...(action.title !== undefined ? { title: action.title } : {}),
					...(action.status !== undefined ? { status: action.status } : {}),
					...(action.notes !== undefined ? { notes: action.notes } : {}),
				};
			});
		}
		case "replace": {
			// Full-list replacement from Paseo update_plan input. Each entry maps
			// via parsePaseoStep/fromPaseoStatus; IDs are per-call T1..Tn snapshots.
			return action.items.map((entry, index) => {
				const parsed = parsePaseoStep(entry.step);
				return {
					id: `T${index + 1}`,
					title: parsed.title,
					status: fromPaseoStatus(entry.step, entry.status),
					notes: parsed.notes,
				};
			});
		}
		default: {
			const _exhaustive: never = action;
			throw new Error(`Unhandled todo action: ${_exhaustive as string}`);
		}
	}
}

// ── Mapping helpers ────────────────────────────────────────────────────────

/**
 * Map internal TodoStatus to Paseo's three-state enum. `blocked` maps to
 * `pending` and is disambiguated by a `[blocked] ` prefix on the step text.
 */
export function toPaseoStatus(status: TodoStatus): PaseoTodoStatus {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "in_progress";
		case "done":
			return "completed";
		case "blocked":
			return "pending";
		default: {
			// Exhaustiveness guard; unreachable for the closed TodoStatus union.
			const _exhaustive: never = status;
			throw new Error(`Unreachable: unhandled TodoStatus: ${_exhaustive as string}`);
		}
	}
}

/**
 * Build the step text for a Paseo plan entry. `blocked` gets the prefix;
 * notes are inlined after the title so the card surfaces them.
 */
export function toPaseoStep(item: TodoItem): string {
	const prefix = item.status === "blocked" ? BLOCKED_PREFIX : "";
	const notes = item.notes ? ` — ${item.notes}` : "";
	return `${prefix}${item.title}${notes}`;
}

/**
 * Map a Paseo plan entry back to internal TodoStatus. `[blocked] ` prefix
 * decodes to `blocked`; `completed` maps to `done`.
 */
export function fromPaseoStatus(
	step: string,
	status: PaseoTodoStatus | undefined,
): TodoStatus {
	if (step.startsWith(BLOCKED_PREFIX)) return "blocked";
	if (status === "completed") return "done";
	if (status === "in_progress") return "in_progress";
	return "pending";
}

/**
 * Strip the blocked prefix and notes suffix from a Paseo step to recover the
 * internal title. Used when converting a full plan into internal TodoItem[].
 *
 * The notes suffix is delimited by " — " (em-dash with spaces). Split from the
 * end so a title that itself contains the delimiter keeps its earlier
 * segment intact; a title with multiple em-dashes still loses the last one
 * to notes, which is the least-surprising choice for model-generated steps.
 */
export function parsePaseoStep(step: string): { title: string; notes?: string } {
	let title = step;
	if (title.startsWith(BLOCKED_PREFIX)) title = title.slice(BLOCKED_PREFIX.length);
	const sep = title.lastIndexOf(" — ");
	if (sep >= 0) {
		return { title: title.slice(0, sep), notes: title.slice(sep + 3) };
	}
	return { title };
}

// ── RPC alias ownership ────────────────────────────────────────────────────

/**
 * Per-ExtensionAPI bookkeeping for the update_plan RPC alias.
 *
 * Pi session replacement/reload rebinds extensions to a new ExtensionAPI
 * instance, so ownership is tracked per instance via a WeakMap. Each new
 * instance starts with no owned alias and re-registers on its first
 * trust-resolved session_start. The `sourceInfo` fingerprint lets later
 * ownership checks distinguish our own (re)registration from an external
 * tool registered with the same name.
 */
interface AliasOwnership {
	/** True once this ExtensionAPI instance has registered update_plan. */
	registered: boolean;
	/** sourceInfo fingerprint identifying our registered tool, if any. */
	sourceFingerprint: string | undefined;
}

const aliasOwnership = new WeakMap<ExtensionAPI, AliasOwnership>();

function ownershipFor(pi: ExtensionAPI): AliasOwnership {
	let own = aliasOwnership.get(pi);
	if (!own) {
		own = { registered: false, sourceFingerprint: undefined };
		aliasOwnership.set(pi, own);
	}
	return own;
}

/** Has this ExtensionAPI instance registered the update_plan alias? */
export function isAliasRegistered(pi: ExtensionAPI): boolean {
	return ownershipFor(pi).registered;
}

/** Record that this instance owns update_plan with the given source fingerprint. */
export function markAliasRegistered(pi: ExtensionAPI, sourceFingerprint: string | undefined): void {
	const own = ownershipFor(pi);
	own.registered = true;
	own.sourceFingerprint = sourceFingerprint;
}

/** Clear ownership (session_shutdown / cleanup). */
export function clearAliasOwnership(pi: ExtensionAPI): void {
	aliasOwnership.delete(pi);
}

/** Compute the sourceInfo fingerprint of a registered tool. */
export function toolFingerprint(tool: ToolInfo | undefined): string | undefined {
	if (!tool) return undefined;
	return JSON.stringify([tool.sourceInfo.source, tool.sourceInfo.path]);
}

/** True when the live update_plan tool still matches our stored fingerprint. */
export function isAliasOwned(pi: ExtensionAPI): boolean {
	const own = ownershipFor(pi);
	if (!own.registered || !own.sourceFingerprint) return false;
	const found = pi.getAllTools().find((t) => t.name === UPDATE_PLAN_TOOL_NAME);
	return !!found && toolFingerprint(found) === own.sourceFingerprint;
}

/**
 * Check whether `update_plan` is currently owned by another extension.
 * Compares the live tool's sourceInfo fingerprint against the fingerprint
 * stored at registration time. Returns true only when a live tool exists and
 * is not ours. A missing tool is available for registration/re-registration.
 *
 * Used at registration and each activation to detect pre-existing
 * collisions and late overrides (another extension replacing our tool).
 */
export function isAliasConflicting(pi: ExtensionAPI): boolean {
	const found = pi.getAllTools().find((t) => t.name === UPDATE_PLAN_TOOL_NAME);
	if (!found) return false;
	const own = ownershipFor(pi);
	// Provisional ownership (registered but fingerprint not yet enumerable): treat
	// the live tool as ours so a re-resolving session_start does not skip it as
	// an external conflict. Once the fingerprint is stored, compare it live.
	if (own.registered && !own.sourceFingerprint) return false;
	return !isAliasOwned(pi);
}