/**
 * settings.ts — /workflow:settings configuration menu
 *
 * A TUI for editing every pi-workflow config option across three scopes:
 *   - Session: highest-priority overrides stored in this session's state
 *     (WorkflowState.sessionConfig). Takes effect immediately for this Pi
 *     process; model/thinking changes apply to the current and later turns.
 *   - Project: .pi/workflow/config.json
 *   - Global:  ~/.pi/agent/workflow/config.json
 *
 * Config merge order: DEFAULT ← Global ← Project ← Session.
 *
 * The editor mutates only the values explicitly stored in the selected scope
 * (a raw partial layer). Each row shows that layer's contribution on the right;
 * inherited rows show the scope-specific label ("inherit" for project/session,
 * "default" for global, which falls back to DEFAULT_CONFIG) plus the effective
 * merged value.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
	getSettingsListTheme,
	DynamicBorder,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	Container,
	Text,
	Spacer,
	Input,
	SelectList,
	SettingsList,
	fuzzyFilter,
	truncateToWidth,
	type Component,
	type Focusable,
	type SelectItem,
	type SettingItem,
} from "@earendil-works/pi-tui";
import {
	loadConfigForContext,
	readProjectConfigRaw,
	readGlobalConfigRaw,
	writeProjectConfigRaw,
	writeGlobalConfigRaw,
	deepMerge,
	normalizeConfig,
} from "./config.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { getSessionKey, loadState, saveState } from "./state.js";
import { applyModeRuntime } from "./mode.js";
import { isWorkflowActive } from "./helpers.js";
import type { ModelSpec, WorkflowConfig } from "./types.js";
import {
	loadDiskCompactionSnapshot,
	parseContextWindowInput,
	validateContextWindowValue,
	formatContextWindowRange,
	type CompactionSnapshotResult,
} from "./model-context.js";

// ── Scopes ────────────────────────────────────────────────────────────────

type Scope = "session" | "project" | "global";
type ScopeAction = Scope | "reset-session" | "reset-project";

/**
 * Structural subset of the Pi command-handler context for the RPC settings
 * wizard. The full ExtensionCommandContext type is exported but carries many
 * members unused here; this Pick keeps strict-mode type checking for the RPC
 * path while documenting exactly what the wizard touches.
 */
type RpcContext = Pick<
	ExtensionCommandContext,
	"mode" | "cwd" | "modelRegistry" | "isProjectTrusted" | "ui" | "scopedModels"
>;

/** Wrap a writeLayer call with error reporting matching the TUI path. */
async function commitRpcWrite(
	ctx: RpcContext,
	scope: Scope,
	layer: Record<string, any>,
	cwd: string,
	agentDir: string,
	sessionKey: string,
	changedScopes: Set<Scope>,
): Promise<boolean> {
	try {
		await writeLayer(scope, layer, cwd, agentDir, sessionKey);
		changedScopes.add(scope);
		return true;
	} catch (e: any) {
		ctx.ui.notify(`Failed to write ${scope} setting: ${e?.message ?? String(e)}`, "error");
		return false;
	}
}

const SCOPE_LABELS: Record<Scope, string> = {
	session: "Session (this Pi process)",
	project: "Project (.pi/workflow/config.json)",
	global: "Global (~/.pi/agent/workflow/config.json)",
};

// ── Setting descriptors ─────────────────────────────────────────────────────

type SettingKind = "boolean" | "thinking" | "string" | "model" | "contextWindow";

interface SettingDescriptor {
	id: string;
	label: string;
	description: string;
	kind: SettingKind;
	/** Path into the config object, e.g. ["models", "plan", "model"]. */
	path: string[];
	/** Workflow role for combined provider/model settings. */
	role?: (typeof ROLES)[number];
	/**
	 * True for options that gate command/tool registration, which happens at
	 * extension load time using the non-session config layers. These cannot
	 * take effect from the Session scope (even after /reload), so they are
	 * hidden there and surfaced only for Project/Global scopes.
	 */
	reloadSensitive?: boolean;
}

const ROLES = ["explore", "plan", "planReview", "review", "work", "commit"] as const;

const THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** Paths whose change requires /reload (or restart) to fully take effect.
 *  codeReview.enabled is intentionally excluded: it is a runtime OCR toggle
 *  for the unified Review (editable live, including Session scope). */
const RELOAD_SENSITIVE_IDS = new Set([
	"workflow.autoEnter",
	"planReview.enabled",
	"review.enabled",
]);

function buildDescriptors(): SettingDescriptor[] {
	const list: SettingDescriptor[] = [
		{
			id: "workflow.autoEnter",
			label: "workflow · autoEnter",
			description:
				"Enable workflow commands/tools automatically on startup (requires /reload).",
			kind: "boolean",
			path: ["workflow", "autoEnter"],
			reloadSensitive: true,
		},
		{
			id: "planReview.enabled",
			label: "planReview · enabled",
			description:
				"Expose the workflow_plan_review tool (requires /reload to register/unregister).",
			kind: "boolean",
			path: ["planReview", "enabled"],
			reloadSensitive: true,
		},
		{
			id: "review.enabled",
			label: "review · enabled",
			description:
				"Expose /workflow:review and the workflow_review tool (requires /reload to register/unregister).",
			kind: "boolean",
			path: ["review", "enabled"],
			reloadSensitive: true,
		},
		{
			id: "codeReview.enabled",
			label: "codeReview · enabled (Review OCR)",
			description:
				"When true, the unified Review folds a workspace OCR review into the reviewer task. Editable live (including Session scope).",
			kind: "boolean",
			path: ["codeReview", "enabled"],
		},
	];

	for (const role of ROLES) {
		list.push({
			id: `models.${role}.model`,
			label: `${role} · model`,
			description: `Model for the ${role} role. Pick from Pi's currently available model list.`,
			kind: "model",
			path: ["models", role, "model"],
			role,
		});
		list.push({
			id: `models.${role}.thinking`,
			label: `${role} · thinking`,
			description: `Thinking level for the ${role} role.`,
			kind: "thinking",
			path: ["models", role, "thinking"],
			role,
		});
		list.push({
			id: `models.${role}.contextWindow`,
			label: `${role} · contextWindow`,
			description:
				`Optional context window override for the ${role} role, in TOKENS. ` +
				`Must be a decimal integer strictly below the Pi default window and above the compaction reserve; blank = inherit.`,
			kind: "contextWindow",
			path: ["models", role, "contextWindow"],
			role,
		});
	}

	return list;
}

// ── Path get/set/unset (with empty-parent cleanup) ──────────────────────────

function getPath(obj: Record<string, any>, path: string[]): any {
	let cur: any = obj;
	for (const key of path) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = cur[key];
	}
	return cur;
}

function setPath(obj: Record<string, any>, path: string[], value: any): void {
	let cur: any = obj;
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i];
		if (
			cur[key] == null ||
			typeof cur[key] !== "object" ||
			Array.isArray(cur[key])
		) {
			cur[key] = {};
		}
		cur = cur[key];
	}
	cur[path[path.length - 1]] = value;
}

function unsetPath(obj: Record<string, any>, path: string[]): void {
	const stack: Array<[Record<string, any>, string]> = [];
	let cur: any = obj;
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i];
		if (cur == null || typeof cur !== "object") return;
		stack.push([cur, key]);
		cur = cur[key];
	}
	if (cur && typeof cur === "object") {
		delete cur[path[path.length - 1]];
	}
	// Prune empty parent objects bottom-up.
	for (let i = stack.length - 1; i >= 0; i--) {
		const [parent, key] = stack[i];
		const child = parent[key];
		if (
			child &&
			typeof child === "object" &&
			!Array.isArray(child) &&
			Object.keys(child).length === 0
		) {
			delete parent[key];
		} else {
			break;
		}
	}
}

// ── Per-scope raw layer IO ──────────────────────────────────────────────────

function readLayer(
	scope: Scope,
	cwd: string,
	agentDir: string,
	sessionKey: string,
): Record<string, any> {
	if (scope === "session") {
		const raw = loadState(cwd, sessionKey).sessionConfig ?? {};
		// Deep clone so mutations don't touch the loaded state object.
		return JSON.parse(JSON.stringify(raw));
	}
	if (scope === "project") return readProjectConfigRaw(cwd);
	return readGlobalConfigRaw(agentDir);
}

async function writeLayer(
	scope: Scope,
	layer: Record<string, any>,
	cwd: string,
	agentDir: string,
	sessionKey: string,
): Promise<void> {
	if (scope === "session") {
		const state = loadState(cwd, sessionKey);
		state.sessionConfig =
			Object.keys(layer).length > 0
				? (layer as typeof state.sessionConfig)
				: undefined;
		saveState(cwd, sessionKey, state);
		return;
	}
	if (scope === "project") {
		await writeProjectConfigRaw(cwd, layer);
		return;
	}
	await writeGlobalConfigRaw(agentDir, layer);
}

// ── Context-window candidate validation ──────────────────────────────────

/**
 * Build the CANDIDATE config "merged up to the editing scope": DEFAULT ←
 * global ← (trusted project, only when a higher-priority scope is being
 * edited) ← the edited layer with the pending change already applied. Used
 * by the settings editor so a higher-priority session override cannot mask
 * an error in the layer being edited. The final runtime apply still
 * validates the FULL merge (setRole).
 */
export function buildCandidateConfigUpToScope(
	scope: Scope,
	editedLayer: Record<string, any>,
	cwd: string,
	agentDir: string,
	ctx: any,
): WorkflowConfig {
	let merged: any = { ...DEFAULT_CONFIG };
	merged = deepMerge(merged, readGlobalConfigRaw(agentDir));
	if (scope === "project") {
		merged = deepMerge(merged, editedLayer);
	} else if (scope === "session") {
		// The trusted project layer sits below session — include it so the
		// candidate reflects everything session would inherit from.
		const trusted =
			typeof ctx?.isProjectTrusted === "function" && ctx.isProjectTrusted();
		if (trusted) merged = deepMerge(merged, readProjectConfigRaw(cwd));
		merged = deepMerge(merged, editedLayer);
	} else {
		// global: only DEFAULT ← edited global layer.
		merged = deepMerge({ ...DEFAULT_CONFIG }, editedLayer);
	}
	return normalizeConfig(merged);
}

export type ContextWindowCandidateCheck =
	| { ok: true }
	| { ok: false; error: string };

/**
 * Validate a candidate role spec's contextWindow against the registry model
 * and a compaction snapshot. No configured window → OK regardless of
 * compaction/model availability (clearing and repairing stay possible).
 * Shared by the TUI onChange path and the RPC wizard. Pure apart from the
 * registry lookup.
 */
export function validateRoleContextWindowCandidate(
	spec: ModelSpec | undefined,
	modelRegistry: ModelRegistry,
	compactionRes: CompactionSnapshotResult,
): ContextWindowCandidateCheck {
	if (!spec || spec.contextWindow === undefined) return { ok: true };
	if (!compactionRes.ok) {
		return {
			ok: false,
			error: `${compactionRes.error}；无法校验 contextWindow。可先清除该字段（继承 Pi 默认窗口）。`,
		};
	}
	let model: Model<any> | undefined;
	try {
		model = modelRegistry.find(spec.provider, spec.model);
	} catch {
		model = undefined;
	}
	if (!model) {
		return {
			ok: false,
			error: `无法解析模型 ${spec.provider}/${spec.model}，保留的 contextWindow ${spec.contextWindow} 无法校验。先修正 provider/model 或清除 contextWindow。`,
		};
	}
	const check = validateContextWindowValue(
		spec.contextWindow,
		model.contextWindow,
		compactionRes.compaction,
	);
	if (!check.ok) return { ok: false, error: check.error };
	return { ok: true };
}

/**
 * Compute the acceptable-range hint for a role's contextWindow row: Pi
 * default window (registry) plus the dynamic range from the disk compaction
 * snapshot. Returns a short suffix string for the settings description.
 */
function contextWindowRangeHint(
	spec: ModelSpec | undefined,
	modelRegistry: ModelRegistry,
	compactionRes: CompactionSnapshotResult,
): string {
	if (!spec) return "";
	let model: Model<any> | undefined;
	try {
		model = modelRegistry.find(spec.provider, spec.model);
	} catch {
		model = undefined;
	}
	if (!model) return "Pi 窗口不可用（模型无法解析）";
	if (!compactionRes.ok) return `Pi 默认 ${model.contextWindow} · 区间不可用（${compactionRes.error}）`;
	return `Pi 默认 ${model.contextWindow} tokens · 可接受 ${formatContextWindowRange(model.contextWindow, compactionRes.compaction)}`;
}

// ── Display helpers ─────────────────────────────────────────────────────────

function formatVal(v: any): string {
	if (typeof v === "boolean") return v ? "true" : "false";
	if (v === undefined || v === null) return "(none)";
	return String(v);
}

function descriptorHasValue(
	desc: SettingDescriptor,
	layer: Record<string, any>,
): boolean {
	if (desc.kind === "model" && desc.role) {
		const paths = modelPaths(desc.role);
		return (
			getPath(layer, paths.provider) !== undefined ||
			getPath(layer, paths.model) !== undefined
		);
	}
	return getPath(layer, desc.path) !== undefined;
}

function valuesFor(
	desc: SettingDescriptor,
	scope: Scope,
	effective?: WorkflowConfig,
	modelRegistry?: ModelRegistry,
): string[] | undefined {
	const label = inheritLabel(scope);
	if (desc.kind === "boolean") return [label, "true", "false"];
	if (desc.kind === "thinking") {
		if (effective && modelRegistry) {
			return thinkingValuesFor(desc, scope, effective, modelRegistry);
		}
		return [label, ...THINKING_VALUES];
	}
	return undefined; // string/model/contextWindow → submenu
}

/** Return thinking levels supported by the effective model for a role. */
function thinkingValuesFor(
	desc: SettingDescriptor,
	scope: Scope,
	effective: WorkflowConfig,
	modelRegistry: ModelRegistry,
): string[] {
	const label = inheritLabel(scope);
	if (!desc.role) return [label, ...THINKING_VALUES];
	try {
		const spec = effective.models[desc.role];
		const model = modelRegistry.find(spec.provider, spec.model);
		if (!model) return [label, ...THINKING_VALUES];
		return [label, ...getSupportedThinkingLevels(model)];
	} catch {
		return [label, ...THINKING_VALUES];
	}
}

function modelPaths(role: (typeof ROLES)[number]): {
	provider: string[];
	model: string[];
} {
	return {
		provider: ["models", role, "provider"],
		model: ["models", role, "model"],
	};
}

function formatModelRef(provider: any, model: any): string {
	return `${formatVal(provider)}/${formatVal(model)}`;
}

function currentDisplay(
	desc: SettingDescriptor,
	scope: Scope,
	layer: Record<string, any>,
	effective: any,
): string {
	if (desc.kind === "model" && desc.role) {
		const paths = modelPaths(desc.role);
		const rawProvider = getPath(layer, paths.provider);
		const rawModel = getPath(layer, paths.model);
		if (rawProvider !== undefined && rawModel !== undefined) {
			return formatModelRef(rawProvider, rawModel);
		}
		if (rawProvider !== undefined || rawModel !== undefined) {
			return `partial (${formatModelRef(rawProvider, rawModel)})`;
		}
		return `${inheritLabel(scope)} (${formatModelRef(
			getPath(effective, paths.provider),
			getPath(effective, paths.model),
		)})`;
	}

	if (desc.kind === "contextWindow") {
		const raw = getPath(layer, desc.path);
		if (raw !== undefined) return `${formatVal(raw)} tokens`;
		const effWindow = getPath(effective, desc.path);
		return `${inheritLabel(scope)} (${
			effWindow !== undefined
				? `${formatVal(effWindow)} tokens`
				: "unset — Pi model window"
		})`;
	}

	const raw = getPath(layer, desc.path);
	if (raw !== undefined) return formatVal(raw);
	if (desc.kind === "string") {
		return `${inheritLabel(scope)} (${formatVal(getPath(effective, desc.path))})`;
	}
	return inheritLabel(scope);
}

function descriptionFor(desc: SettingDescriptor, _effective: any): string {
	// SettingsList renders descriptions as raw lines. Keep them short; the
	// effective value is already shown in currentValue.
	return desc.description;
}

function truncateRenderedLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, width));
}

// ── String/model submenus ───────────────────────────────────────────────────

function makeStringInputSubmenu(
	theme: Theme,
	scope: Scope,
	title: string,
	initial: string,
	done: (value?: string) => void,
) {
	const input = new Input();
	input.setValue(initial);
	input.onSubmit = (value: string) => done(value);
	input.onEscape = () => done(undefined);

	const container = new Container();
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	container.addChild(
		new Text(
			theme.fg("dim", `enter save · clear field = ${inheritLabel(scope)} · esc cancel`),
			1,
			0,
		),
	);
	container.addChild(new Spacer(1));
	container.addChild(input);

	return {
		render: (w: number) => truncateRenderedLines(container.render(w), w),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => {
			input.handleInput(data);
			container.invalidate();
		},
	};
}

const INHERIT_MODEL_VALUE = "__pi_workflow_inherit_model__";

/** Words that all mean "clear this scope". onChange matches any of them. */
const INHERIT_WORDS = new Set(["inherit", "default"]);

/** Label shown for the "clear this scope" option in a given scope. */
function inheritLabel(scope: Scope): string {
	return scope === "global" ? "default" : "inherit";
}

interface ModelPickerItem {
	value: string;
	label: string;
	description: string;
	model?: Model<any>;
	searchText: string;
}

function encodeModelValue(model: Model<any>): string {
	return JSON.stringify({ provider: model.provider, model: model.id });
}

function decodeModelValue(value: string): { provider: string; model: string } {
	const parsed = JSON.parse(value) as { provider?: unknown; model?: unknown };
	if (typeof parsed.provider !== "string" || typeof parsed.model !== "string") {
		throw new Error("Invalid model selection");
	}
	return { provider: parsed.provider, model: parsed.model };
}

function modelPickerItems(
	modelRegistry: ModelRegistry,
	scope: Scope,
	effectiveProvider: string,
	effectiveModel: string,
): { items: ModelPickerItem[]; error?: string } {
	const label = inheritLabel(scope);
	const mkInheritItem = (): ModelPickerItem => ({
		value: INHERIT_MODEL_VALUE,
		label,
		description: `Use effective model: ${formatModelRef(
			effectiveProvider,
			effectiveModel,
		)}`,
		searchText: `${label} ${effectiveProvider} ${effectiveModel}`,
	});
	try {
		const loadError = modelRegistry.getError();
		const models = [...modelRegistry.getAvailable()].sort((a, b) => {
			const aRef = `${a.provider}/${a.id}`;
			const bRef = `${b.provider}/${b.id}`;
			return aRef.localeCompare(bRef);
		});
		return {
			items: [
				mkInheritItem(),
				...models.map((model) => ({
					value: encodeModelValue(model),
					label: model.id,
					description: `${model.provider} · ${model.name}`,
					model,
					searchText: `${model.id} ${model.name} ${model.provider} ${model.provider}/${model.id}`,
				})),
			],
			error: loadError,
		};
	} catch (e) {
		return {
			items: [mkInheritItem()],
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

function makeModelPickerSubmenu({
	theme,
	title,
	modelRegistry,
	scope,
	currentProvider,
	currentModel,
	effectiveProvider,
	effectiveModel,
	done,
	keybindings,
}: {
	theme: Theme;
	title: string;
	modelRegistry: ModelRegistry;
	scope: Scope;
	currentProvider?: string;
	currentModel?: string;
	effectiveProvider: string;
	effectiveModel: string;
	done: (value?: string) => void;
	keybindings: { matches(data: string, binding: string): boolean };
}): Component & Focusable {
	const input = new Input();
	const { items, error } = modelPickerItems(
		modelRegistry,
		scope,
		effectiveProvider,
		effectiveModel,
	);
	let filteredItems = items;
	let selectedIndex = Math.max(
		0,
		items.findIndex((item) =>
			currentProvider && currentModel
				? item.model?.provider === currentProvider &&
					item.model.id === currentModel
				: item.value === INHERIT_MODEL_VALUE,
		),
	);

	const applyFilter = () => {
		const query = input.getValue();
		filteredItems = query
			? fuzzyFilter(items, query, (item) => item.searchText)
			: items;
		selectedIndex = Math.min(
			selectedIndex,
			Math.max(0, filteredItems.length - 1),
		);
	};

	input.onSubmit = () => {
		if (filteredItems.length === 0) return;
		const selected = filteredItems[selectedIndex];
		if (selected) done(selected.value);
	};
	input.onEscape = () => done(undefined);

	let focused = false;
	const setInputFocused = (value: boolean) => {
		focused = value;
		if ("focused" in input) {
			input.focused = value;
		}
		input.invalidate();
	};

	return {
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			setInputFocused(value);
		},
		render: (w: number) => {
			const lines: string[] = [
				theme.fg("accent", theme.bold(title)),
				theme.fg(
					"dim",
					"type to search · enter select · esc cancel · choose " +
						inheritLabel(scope) +
						" to clear this scope",
				),
				"",
				...input.render(w),
				"",
			];
			const maxVisible = 10;
			const startIndex = Math.max(
				0,
				Math.min(
					selectedIndex - Math.floor(maxVisible / 2),
					filteredItems.length - maxVisible,
				),
			);
			const endIndex = Math.min(startIndex + maxVisible, filteredItems.length);
			if (filteredItems.length === 0) {
				lines.push(theme.fg("muted", "  No matching models"));
			} else {
				for (let i = startIndex; i < endIndex; i++) {
					const item = filteredItems[i];
					if (!item) continue;
					const selected = i === selectedIndex;
					const prefix = selected ? theme.fg("accent", "→ ") : "  ";
					const label = selected ? theme.fg("accent", item.label) : item.label;
					const description = theme.fg("muted", `  ${item.description}`);
					lines.push(truncateToWidth(prefix + label + description, w));
				}
				if (startIndex > 0 || endIndex < filteredItems.length) {
					lines.push(
						theme.fg("dim", `  (${selectedIndex + 1}/${filteredItems.length})`),
					);
				}
			}
			if (error) {
				lines.push("", theme.fg("warning", `  models.json warning: ${error}`));
			}
			return truncateRenderedLines(lines, w);
		},
		invalidate: () => undefined,
		handleInput: (data: string) => {
			const kb = keybindings;
			if (kb.matches(data, "tui.select.up")) {
				if (filteredItems.length > 0) {
					selectedIndex =
						selectedIndex === 0 ? filteredItems.length - 1 : selectedIndex - 1;
				}
			} else if (kb.matches(data, "tui.select.down")) {
				if (filteredItems.length > 0) {
					selectedIndex =
						selectedIndex === filteredItems.length - 1 ? 0 : selectedIndex + 1;
				}
			} else {
				input.handleInput(data);
				applyFilter();
			}
		},
	};
}

// ── RPC model candidates ────────────────────────────────────────────────────

/**
 * Resolve the candidate model list for the RPC model picker.
 *
 * A non-empty `scopedModels` (Pi's `--models` / `enabledModels` scope — the
 * same set `/model` and Ctrl+P cycle through) narrows the picker to exactly
 * those models. An empty scope keeps the full registry catalog available.
 * The result is deduped by `provider/id` and sorted by the same key so the
 * provider → model select always shows a stable list.
 */
export function resolveModelCandidates(
	scopedModels: readonly { model: Model<any> }[],
	availableModels: readonly Model<any>[],
): { scoped: boolean; models: Model<any>[] } {
	const scoped = scopedModels.length > 0;
	const source = scoped
		? scopedModels.map((entry) => entry.model).filter((m) => !!m)
		: [...availableModels];
	const seen = new Set<string>();
	const models: Model<any>[] = [];
	for (const model of source) {
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		models.push(model);
	}
	models.sort((a, b) =>
		`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
	);
	return { scoped, models };
}

// ── Session key helper ──────────────────────────────────────────────────────

function ctxSessionKey(ctx: any): string {
	return getSessionKey({
		getSessionId: () => ctx.sessionManager?.getSessionId?.(),
		getSessionFile: () => ctx.sessionManager?.getSessionFile?.() ?? null,
	});
}

// ── Scope selector ──────────────────────────────────────────────────────────

const SCOPE_ITEMS: SelectItem[] = [
	{
		value: "session",
		label: "Session (this Pi process)",
		description:
			"Highest priority. Stored in session state. Applies immediately to this Pi process.",
	},
	{
		value: "reset-session",
		label: "Reset Session",
		description: "Clear session overrides so this Pi process inherits project/global/default settings.",
	},
	{
		value: "project",
		label: "Project (.pi/workflow/config.json)",
		description: "Shared with the project. Overrides global.",
	},
	{
		value: "reset-project",
		label: "Reset Project",
		description: "Clear project overrides so this project inherits global/default settings.",
	},
	{
		value: "global",
		label: "Global (~/.pi/agent/workflow/config.json)",
		description: "Applies to all projects. Lowest of the editable layers.",
	},
];

function scopeSelectorComponent(
	theme: Theme,
	done: (value: ScopeAction | null) => void,
) {
	const container = new Container();
	container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	container.addChild(
		new Text(theme.fg("accent", theme.bold("Workflow Settings")), 1, 0),
	);
	container.addChild(new Text(theme.fg("dim", "Select a scope to edit"), 1, 0));
	container.addChild(new Spacer(1));

	const selectList = new SelectList(SCOPE_ITEMS, SCOPE_ITEMS.length, {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	});
	selectList.onSelect = (item) => {
		if (
			item.value === "session" ||
			item.value === "project" ||
			item.value === "global" ||
			item.value === "reset-session" ||
			item.value === "reset-project"
		) {
			done(item.value);
		} else {
			done(null);
		}
	};
	selectList.onCancel = () => done(null);
	container.addChild(selectList);

	container.addChild(new Spacer(1));
	container.addChild(
		new Text(
			theme.fg("dim", "↑↓ navigate  •  enter select  •  esc close"),
			1,
			0,
		),
	);
	container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

	return {
		render: (w: number) => truncateRenderedLines(container.render(w), w),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => {
			selectList.handleInput(data);
			container.invalidate();
		},
	};
}

// ── Command registration ────────────────────────────────────────────────────

export function registerWorkflowSettingsCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	const descriptors = buildDescriptors();
	const byId = new Map(descriptors.map((d) => [d.id, d]));

	pi.registerCommand("workflow:settings", {
		description:
			"配置 workflow 选项（models / autoEnter / planReview / review / codeReview），支持 session / project / global 三层作用域",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const cwd = ctx.cwd;
			const agentDir = getAgentDir();
			const sessionKey = ctxSessionKey(ctx);

			// JSON/print: no UI surface; stderr keeps stdout protocol/print output clean.
			if (ctx.mode === "json" || ctx.mode === "print") {
				console.error(
					"workflow settings: /workflow:settings requires interactive mode (TUI/RPC). " +
						"In JSON/print mode, edit config files directly:\n" +
						"  - Session: stored in session state\n" +
						"  - Project: .pi/workflow/config.json\n" +
						"  - Global: ~/.pi/agent/workflow/config.json",
				);
				return;
			}

			// RPC mode: basic-dialog wizard (scope → setting → value).
			if (ctx.mode === "rpc") {
				await runRpcSettingsWizard(pi, ctx, getAgentDir, sessionKey, cwd, agentDir);
				return;
			}

			// Refresh model catalog once so pickers can read synchronously.
			try {
				await ctx.modelRegistry.refresh();
			} catch {
				// Non-fatal: pickers fall back to the cached/stale catalog.
			}

			const changedScopes = new Set<Scope>();
			const changedIds = new Set<string>();
			const pendingWrites: Promise<void>[] = [];

			// Loop: pick a scope, edit it, return to scope picker, until Esc.
			while (true) {
				const action = await ctx.ui.custom<ScopeAction | null>(
					(_tui, theme, _kb, done) => scopeSelectorComponent(theme, done),
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: "60%", minWidth: 54 },
					},
				);
				if (!action) break;

				let resetScope: Scope | undefined;
				if (action === "reset-session") {
					resetScope = "session";
				} else if (action === "reset-project") {
					resetScope = "project";
				}
				if (resetScope) {
					if (resetScope === "project" && !ctx.isProjectTrusted()) {
						ctx.ui.notify(
							"Project config cannot be reset: this session is not project-trusted.",
							"warning",
						);
						continue;
					}
					try {
						const layer = readLayer(resetScope, cwd, agentDir, sessionKey);
						if (Object.keys(layer).length === 0) {
							ctx.ui.notify(
								`Workflow settings: ${resetScope} scope already inherits its parent.`,
								"info",
							);
							continue;
						}
						const resetDescriptors =
							resetScope === "session"
								? descriptors.filter((d) => !d.reloadSensitive)
								: descriptors;
						for (const desc of resetDescriptors) {
							if (descriptorHasValue(desc, layer)) changedIds.add(desc.id);
						}
						await writeLayer(resetScope, {}, cwd, agentDir, sessionKey);
						changedScopes.add(resetScope);
						ctx.ui.notify(
							`Workflow settings: reset ${resetScope} scope to inherit.`,
							"info",
						);
					} catch (e) {
						ctx.ui.notify(
							`Cannot reset ${resetScope} scope: ${e instanceof Error ? e.message : String(e)}`,
							"error",
						);
					}
					continue;
				}

				const scope = action as Scope;
				if (scope === "project" && !ctx.isProjectTrusted()) {
					ctx.ui.notify(
						"Project config is skipped: this session is not project-trusted. " +
							"Use --approve or /trust, or edit Session/Global instead.",
						"warning",
					);
					continue;
				}

				// Pre-flight the layer read so a corrupt config.json surfaces a
				// friendly message instead of crashing the editor (and prevents
				// silently overwriting recoverable content on the next save).
				try {
					readLayer(scope, cwd, agentDir, sessionKey);
				} catch (e) {
					ctx.ui.notify(
						`Cannot edit ${scope} scope: ${e instanceof Error ? e.message : String(e)}`,
						"error",
					);
					continue;
				}

				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						// Session scope can only carry options that take live effect
						// (models/thinking). Reload-sensitive flags gate load-time
						// registration via the non-session layers, so hide them here.
						const scopeDescriptors =
							scope === "session"
								? descriptors.filter((d) => !d.reloadSensitive)
								: descriptors;

						// Hoist single read of layer + effective — avoid per-item IO. Pre-flight
						// above already guarded against corrupt files, so this is safe.
						const initialLayer = readLayer(scope, cwd, agentDir, sessionKey);
						const initialEffective = loadConfigForContext(
							cwd,
							agentDir,
							sessionKey,
							ctx,
						);
						// Disk compaction snapshot for the contextWindow range hint. The
						// hint degrades to an explicit "unavailable" note on load errors.
						const initialCompaction = loadDiskCompactionSnapshot(
							cwd,
							agentDir,
							typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
						);
						const describe = (desc: SettingDescriptor, effective: WorkflowConfig, compactionRes: CompactionSnapshotResult) =>
							desc.kind === "contextWindow" && desc.role
								? `${desc.description} ${contextWindowRangeHint(
										effective.models[desc.role],
										ctx.modelRegistry,
										compactionRes,
									)}
								`
								: descriptionFor(desc, effective);

						const items: SettingItem[] = scopeDescriptors.map((desc) => {
							const item: SettingItem = {
								id: desc.id,
								label: desc.label,
								description: describe(desc, initialEffective, initialCompaction),
								currentValue: currentDisplay(
									desc,
									scope,
									initialLayer,
									initialEffective,
								),
							};
							const values = valuesFor(
								desc,
								scope,
								initialEffective,
								ctx.modelRegistry,
							);
							if (values) {
								item.values = values;
							} else if (desc.kind === "model" && desc.role) {
								item.submenu = (_cur, submenuDone) => {
									const layer = readLayer(scope, cwd, agentDir, sessionKey);
									const effective = loadConfigForContext(
										cwd,
										agentDir,
										sessionKey,
										ctx,
									);
									const paths = modelPaths(desc.role!);
									const rawProvider = getPath(layer, paths.provider);
									const rawModel = getPath(layer, paths.model);
									return makeModelPickerSubmenu({
										theme,
										title: desc.label,
										modelRegistry: ctx.modelRegistry,
										scope,
										currentProvider:
											typeof rawProvider === "string" ? rawProvider : undefined,
										currentModel:
											typeof rawModel === "string" ? rawModel : undefined,
										effectiveProvider: formatVal(
											getPath(effective, paths.provider),
										),
										effectiveModel: formatVal(getPath(effective, paths.model)),
										done: submenuDone,
										keybindings: _kb,
									});
								};
							} else {
								// String / contextWindow field → single-line input submenu.
								// contextWindow reuses the same input; validation happens in
								// onChange before any write.
								item.submenu = (_cur, submenuDone) => {
									const raw = getPath(
										readLayer(scope, cwd, agentDir, sessionKey),
										desc.path,
									);
									const initial = raw === undefined ? "" : String(raw);
									return makeStringInputSubmenu(
										theme,
										scope,
										desc.label,
										initial,
										submenuDone,
									);
								};
							}
							return item;
						});

						const refreshItems = () => {
							const layer = readLayer(scope, cwd, agentDir, sessionKey);
							const effective = loadConfigForContext(cwd, agentDir, sessionKey, ctx);
							const compactionRes = loadDiskCompactionSnapshot(
								cwd,
								agentDir,
								typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
							);
							for (const item of items) {
								const desc = byId.get(item.id);
								if (!desc) continue;
								item.currentValue = currentDisplay(desc, scope, layer, effective);
								item.description = describe(desc, effective, compactionRes);
								if (desc.kind === "thinking" && desc.role) {
									item.values = thinkingValuesFor(
										desc,
										scope,
										effective,
										ctx.modelRegistry,
									);
								}
							}
						};

						const onChange = (id: string, newValue: string) => {
							const desc = byId.get(id);
							if (!desc) return;
							const layer = readLayer(scope, cwd, agentDir, sessionKey);
							if (desc.kind === "string") {
								const trimmed = newValue.trim();
								if (trimmed === "") unsetPath(layer, desc.path);
								else setPath(layer, desc.path, trimmed);
							} else if (desc.kind === "model" && desc.role) {
								const paths = modelPaths(desc.role);
								if (newValue === INHERIT_MODEL_VALUE) {
									unsetPath(layer, paths.provider);
									unsetPath(layer, paths.model);
								} else {
									try {
										const selected = decodeModelValue(newValue);
										setPath(layer, paths.provider, selected.provider);
										setPath(layer, paths.model, selected.model);
									} catch (e) {
										unsetPath(layer, paths.provider);
										unsetPath(layer, paths.model);
										ctx.ui.notify(
											`Ignored invalid model selection: ${e instanceof Error ? e.message : String(e)}`,
											"warning",
										);
										return;
									}
								}
								// Model selection / clear re-checks any RETAINED contextWindow
								// (this layer or below, merged up to the editing scope) against the
								// candidate model — an illegal combination is rejected before the
								// write so no layer can be saved into a broken state.
								const modelCandidate = buildCandidateConfigUpToScope(
									scope,
									JSON.parse(JSON.stringify(layer)),
									cwd,
									agentDir,
									ctx,
								);
								const modelWindowCheck = validateRoleContextWindowCandidate(
									modelCandidate.models[desc.role],
									ctx.modelRegistry,
									loadDiskCompactionSnapshot(
										cwd,
										agentDir,
										typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
									),
								);
								if (!modelWindowCheck.ok) {
									ctx.ui.notify(
										`模型选择未保存：${modelWindowCheck.error} 先清除或调整 contextWindow 后重试。`,
										"error",
									);
									return;
								}
							} else if (desc.kind === "contextWindow" && desc.role) {
								const trimmed = newValue.trim();
								if (trimmed === "") {
									// Blank clears the current layer's override — always allowed so a
									// broken value stays repairable.
									unsetPath(layer, desc.path);
								} else {
									const parsed = parseContextWindowInput(trimmed);
									if (!parsed.ok) {
										ctx.ui.notify(`Workflow settings: ${parsed.error}`, "error");
										return; // no write; config keeps the original value
									}
									// Candidate = pending change merged up to the editing scope, so a
									// higher-priority session override cannot mask an error here.
									const candidateLayer = JSON.parse(JSON.stringify(layer));
									setPath(candidateLayer, desc.path, parsed.value);
									const candidate = buildCandidateConfigUpToScope(
										scope,
										candidateLayer,
										cwd,
										agentDir,
										ctx,
									);
									const check = validateRoleContextWindowCandidate(
										candidate.models[desc.role],
										ctx.modelRegistry,
										loadDiskCompactionSnapshot(
											cwd,
											agentDir,
											typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
										),
									);
									if (!check.ok) {
										ctx.ui.notify(
											`Workflow settings: contextWindow 未保存 — ${check.error}`,
											"error",
										);
										return; // no write; config keeps the original value
									}
									setPath(layer, desc.path, parsed.value);
								}
							} else if (desc.kind === "boolean") {
								if (INHERIT_WORDS.has(newValue)) unsetPath(layer, desc.path);
								else setPath(layer, desc.path, newValue === "true");
							} else {
								// thinking
								if (INHERIT_WORDS.has(newValue)) unsetPath(layer, desc.path);
								else setPath(layer, desc.path, newValue);
							}
							const writePromise = writeLayer(
								scope,
								layer,
								cwd,
								agentDir,
								sessionKey,
							)
								.then(() => {
									changedScopes.add(scope);
									changedIds.add(id);
									refreshItems();
								})
								.catch((e) => {
									ctx.ui.notify(
										`Failed to write workflow settings: ${e instanceof Error ? e.message : String(e)}`,
										"error",
									);
								});
							pendingWrites.push(writePromise);
						};

						const settingsList = new SettingsList(
							items,
							Math.min(items.length + 2, 16),
							getSettingsListTheme(),
							onChange,
							() => done(undefined),
							{ enableSearch: true },
						);

						const container = new Container();
						container.addChild(
							new DynamicBorder((s: string) => theme.fg("accent", s)),
						);
						container.addChild(
							new Text(
								theme.fg("accent", theme.bold(`Scope: ${SCOPE_LABELS[scope]}`)),
								1,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg(
									"dim",
									"type to search · enter/space change · esc back to scopes",
								),
								1,
								0,
							),
						);
						container.addChild(new Spacer(1));
						container.addChild(settingsList);
						container.addChild(
							new DynamicBorder((s: string) => theme.fg("accent", s)),
						);

						return {
							render: (w: number) =>
								truncateRenderedLines(container.render(w), w),
							invalidate: () => container.invalidate(),
							handleInput: (data: string) => {
								settingsList.handleInput(data);
								tui.requestRender();
							},
						};
					},
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: "80%", minWidth: 72 },
					},
				);
			}

			await Promise.all(pendingWrites);

			if (changedScopes.size === 0) {
				ctx.ui.notify("Workflow settings: no changes.", "info");
				return;
			}

			// Apply model/thinking changes to the running session immediately.
			// Mirror the before_agent_start activeness check so autoEnter-only
			// sessions (workflowEnabled still false) also get the new model.
			const state = loadState(cwd, sessionKey);
			const effective = loadConfigForContext(cwd, agentDir, sessionKey, ctx);
			const workflowActive = isWorkflowActive(state, effective);
			let runtimeApplied = true;
			if (workflowActive && state.mode !== "idle") {
				runtimeApplied = await applyModeRuntime(
					pi,
					ctx,
					state.mode,
					getAgentDir,
				);
			}

			const reloadNeeded = [...changedIds].some((id) =>
				RELOAD_SENSITIVE_IDS.has(id),
			);
			const scopes = [...changedScopes].join(", ");

			if (!runtimeApplied) {
				const suffix = reloadNeeded
					? " Changes to autoEnter / planReview.enabled / review.enabled also need /reload."
					: "";
				ctx.ui.notify(
					`Workflow settings saved (${scopes}), but the runtime failed to switch model/thinking/contextWindow. Check provider/model names and API key, and make sure contextWindow is inside the acceptable range.${suffix}`,
					"warning",
				);
			} else if (reloadNeeded) {
				ctx.ui.notify(
					`Workflow settings saved (${scopes}). Changes to autoEnter / planReview.enabled / review.enabled need /reload to take effect.`,
					"warning",
				);
			} else {
				ctx.ui.notify(
					`Workflow settings saved (${scopes}). Model/thinking/contextWindow changes apply to the current and later turns.`,
					"info",
				);
			}
		},
	});
}

// ── RPC Settings wizard (basic dialogs) ────────────────────────────────────

/**
 * Run the /workflow:settings wizard over Pi's basic select/input dialogs. Reuses
 * the same descriptor/scope/readLayer/writeLayer/effective-config plumbing
 * as the TUI path so writes are atomic and runtime apply is identical.
 *
 * Loop: pick a scope → edit settings in that scope → return to scope picker.
 * Each value confirmation is committed immediately via writeLayer; cancelling
 * a value prompt only returns to the setting list, keeping prior commits.
 */
async function runRpcSettingsWizard(
	pi: ExtensionAPI,
	ctx: RpcContext,
	getAgentDir: () => string,
	sessionKey: string,
	cwd: string,
	agentDir: string,
): Promise<void> {
	const descriptors = buildDescriptors();
	const changedScopes = new Set<Scope>();

	while (true) {
		// Scope selector.
		const scopeLabels = SCOPE_ITEMS.map((i) => i.value as ScopeAction);
		const scopeChoice = await ctx.ui.select(
			"Workflow Settings — pick a scope (or Done to finish)",
			[...scopeLabels, "done"],
		);
		if (!scopeChoice || scopeChoice === "done") break;

		// Reset actions.
		if (scopeChoice === "reset-session" || scopeChoice === "reset-project") {
			const resetScope: Scope = scopeChoice === "reset-session" ? "session" : "project";
			if (resetScope === "project" && !ctx.isProjectTrusted()) {
				ctx.ui.notify(
					"Project config cannot be reset: this session is not project-trusted.",
					"warning",
				);
				continue;
			}
			try {
				const layer = readLayer(resetScope, cwd, agentDir, sessionKey);
				if (Object.keys(layer).length === 0) {
					// Mirror the TUI path: an empty layer has nothing to clear, so
					// confirm+write would be pure noise.
					ctx.ui.notify(
						`Workflow settings: ${resetScope} scope already inherits its parent.`,
						"info",
					);
					continue;
				}
				// Non-empty layer: destructive, so confirm first. confirmed === true
				// is the only write condition — cancelling, closing, or answering No
				// all resolve to false in RPC mode.
				const confirmed = await ctx.ui.confirm(
					`Reset ${resetScope} workflow settings?`,
					`This clears every override stored in the ${resetScope} layer ` +
						`(${Object.keys(layer).length} top-level key(s)). ` +
						`${resetScope === "session" ? "This Pi process" : "The project"} goes back to ` +
						`inheriting ${resetScope === "session" ? "project/global/default" : "global/default"} settings.`,
				);
				if (!confirmed) {
					ctx.ui.notify(
						`Workflow settings: ${resetScope} reset cancelled — nothing was written.`,
						"info",
					);
					continue;
				}
				await writeLayer(resetScope, {}, cwd, agentDir, sessionKey);
				changedScopes.add(resetScope);
				ctx.ui.notify(`Workflow settings: reset ${resetScope} scope to inherit.`, "info");
			} catch (e: any) {
				ctx.ui.notify(`Cannot reset ${resetScope} scope: ${e?.message ?? String(e)}`, "error");
			}
			continue;
		}

		const scope = scopeChoice as Scope;

		// Project untrusted gate: refuse to read/write project config.
		if (scope === "project" && !ctx.isProjectTrusted()) {
			ctx.ui.notify(
				"Project config is skipped: this session is not project-trusted. " +
					"Use --approve or /trust, or edit Session/Global instead.",
				"warning",
			);
			continue;
		}

		// Pre-flight layer read so corrupt files surface a friendly error.
		try {
			readLayer(scope, cwd, agentDir, sessionKey);
		} catch (e: any) {
			ctx.ui.notify(`Cannot edit ${scope} scope: ${e?.message ?? String(e)}`, "error");
			continue;
		}

		// Session scope hides reload-sensitive flags.
		const scopeDescriptors =
			scope === "session" ? descriptors.filter((d) => !d.reloadSensitive) : descriptors;

		// Setting selector loop.
		let editing = true;
		while (editing) {
			const effective = loadConfigForContext(cwd, agentDir, sessionKey, ctx);
			const layer = readLayer(scope, cwd, agentDir, sessionKey);

			// Build setting labels with current/effective display.
			const settingLabels = scopeDescriptors.map((d) => {
				const disp = currentDisplay(d, scope, layer, effective);
				return `${d.label} → ${disp}`;
			});
			settingLabels.push("(back to scopes)");

			const settingChoice = await ctx.ui.select(
				`Scope: ${SCOPE_LABELS[scope]} — pick a setting`,
				settingLabels,
			);
			if (!settingChoice || settingChoice === "(back to scopes)") {
				editing = false;
				break;
			}

			// Resolve chosen descriptor by index for an exact match (label
			// prefix matching is fragile when one label is a prefix of another).
			const idx = settingLabels.indexOf(settingChoice as string);
			if (idx < 0 || idx >= scopeDescriptors.length) {
				editing = false;
				break;
			}
			const desc = scopeDescriptors[idx];

			// Edit value.
			await editRpcSettingValue(pi, ctx, desc, scope, cwd, agentDir, sessionKey, effective, changedScopes);
		}
	}

	if (changedScopes.size === 0) {
		ctx.ui.notify("Workflow settings: no changes.", "info");
		return;
	}

	// Apply model/thinking changes to the running session immediately.
	const state = loadState(cwd, sessionKey);
	const effective = loadConfigForContext(cwd, agentDir, sessionKey, ctx);
	const workflowActive = isWorkflowActive(state, effective);
	let runtimeApplied = true;
	if (workflowActive && state.mode !== "idle") {
		runtimeApplied = await applyModeRuntime(pi, ctx, state.mode, getAgentDir);
	}
	const scopes = [...changedScopes].join(", ");
	if (!runtimeApplied) {
		ctx.ui.notify(
			`Workflow settings saved (${scopes}), but the runtime failed to switch model/thinking/contextWindow. Check provider/model names and API key, and make sure contextWindow is inside the acceptable range.`,
			"warning",
		);
	} else {
		ctx.ui.notify(
			`Workflow settings saved (${scopes}). Model/thinking/contextWindow changes apply to the current and later turns.`,
			"info",
		);
	}
}

/**
 * Edit a single setting value via the appropriate RPC dialog. Scalar
 * (boolean/thinking) uses select; model uses provider→model two-stage select;
 * string uses input. Commits immediately via writeLayer on confirmation.
 */
async function editRpcSettingValue(
	pi: ExtensionAPI,
	ctx: RpcContext,
	desc: SettingDescriptor,
	scope: Scope,
	cwd: string,
	agentDir: string,
	sessionKey: string,
	effective: WorkflowConfig,
	changedScopes: Set<Scope>,
): Promise<void> {
	const label = inheritLabel(scope);

	if (desc.kind === "boolean") {
		const choice = await ctx.ui.select(desc.label, [label, "true", "false"]);
		if (!choice) return;
		const layer = readLayer(scope, cwd, agentDir, sessionKey);
		if (INHERIT_WORDS.has(choice)) unsetPath(layer, desc.path);
		else setPath(layer, desc.path, choice === "true");
		await commitRpcWrite(ctx, scope, layer, cwd, agentDir, sessionKey, changedScopes);
		return;
	}

	if (desc.kind === "thinking" && desc.role) {
		const levels = thinkingValuesFor(desc, scope, effective, ctx.modelRegistry);
		const choice = await ctx.ui.select(desc.label, levels);
		if (!choice) return;
		const layer = readLayer(scope, cwd, agentDir, sessionKey);
		if (INHERIT_WORDS.has(choice)) unsetPath(layer, desc.path);
		else setPath(layer, desc.path, choice);
		await commitRpcWrite(ctx, scope, layer, cwd, agentDir, sessionKey, changedScopes);
		return;
	}

	if (desc.kind === "model" && desc.role) {
		// Provider → Model two-stage select over scoped-first candidates. When
		// Pi runs with a model scope (--models / enabledModels), restrict the
		// picker to that scope — the same models /model and Ctrl+P offer. Without
		// a scope, refresh the registry first so the picker has fresh model data
		// (the TUI path refreshes before its UI too), falling back to the cached
		// catalog when refresh fails.
		const scopedEntries = Array.isArray(ctx.scopedModels)
			? ctx.scopedModels
			: [];
		let models: Model<any>[];
		if (scopedEntries.length > 0) {
			models = resolveModelCandidates(scopedEntries, []).models;
		} else {
			let available = ctx.modelRegistry.getAvailable();
			try {
				await ctx.modelRegistry.refresh();
				available = ctx.modelRegistry.getAvailable();
			} catch {
				// Keep the cached catalog when refresh fails.
			}
			models = resolveModelCandidates([], available).models;
		}
		const providers = [...new Set(models.map((m: any) => m.provider))].sort();
		const providerChoice = await ctx.ui.select(
			`${desc.label} — pick provider (or ${label} to clear)`,
			[label, ...providers],
		);
		if (!providerChoice) return;
		const layer = readLayer(scope, cwd, agentDir, sessionKey);
		const paths = modelPaths(desc.role);
		if (providerChoice === label) {
			unsetPath(layer, paths.provider);
			unsetPath(layer, paths.model);
			// Clearing this scope's model re-checks any RETAINED contextWindow
			// (this layer or below, merged up to the editing scope).
			const candidate = buildCandidateConfigUpToScope(
				scope,
				JSON.parse(JSON.stringify(layer)),
				cwd,
				agentDir,
				ctx,
			);
			const check = validateRoleContextWindowCandidate(
				candidate.models[desc.role],
				ctx.modelRegistry,
				loadDiskCompactionSnapshot(
					cwd,
					agentDir,
					typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
				),
			);
			if (!check.ok) {
				ctx.ui.notify(
					`模型清除未保存：${check.error} 先清除或调整 contextWindow 后重试。`,
					"error",
				);
				return;
			}
			await commitRpcWrite(ctx, scope, layer, cwd, agentDir, sessionKey, changedScopes);
			return;
		}
		const providerModels = models
			.filter((m: any) => m.provider === providerChoice)
			.sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const modelLabels = providerModels.map((m: any) => m.id);
		const modelChoice = await ctx.ui.select(
			`${desc.label} — pick model (${providerChoice})`,
			modelLabels,
		);
		if (!modelChoice) return;
		setPath(layer, paths.provider, providerChoice);
		setPath(layer, paths.model, modelChoice);
		// Selection re-checks the retained contextWindow against the NEW model
		// (candidate merged up to the editing scope) — reject broken combos.
		const candidate = buildCandidateConfigUpToScope(
			scope,
			JSON.parse(JSON.stringify(layer)),
			cwd,
			agentDir,
			ctx,
		);
		const check = validateRoleContextWindowCandidate(
			candidate.models[desc.role],
			ctx.modelRegistry,
			loadDiskCompactionSnapshot(
				cwd,
				agentDir,
				typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
			),
		);
		if (!check.ok) {
			ctx.ui.notify(
				`模型选择未保存：${check.error} 先清除或调整 contextWindow 后重试。`,
				"error",
			);
			return;
		}
		await commitRpcWrite(ctx, scope, layer, cwd, agentDir, sessionKey, changedScopes);
		return;
	}

	if (desc.kind === "contextWindow" && desc.role) {
		// Context window: single-line input (tokens). Blank clears this scope's
		// override (always allowed); a value is strictly parsed and validated
		// against the candidate merge before any write; cancel keeps the original.
		const raw = getPath(readLayer(scope, cwd, agentDir, sessionKey), desc.path);
		const initial = raw === undefined || raw === null ? "" : String(raw);
		// Surface the Pi default window and the acceptable range BEFORE input
		// (parity with the TUI description line).
		const rangeHint = contextWindowRangeHint(
			effective.models[desc.role],
			ctx.modelRegistry,
			loadDiskCompactionSnapshot(
				cwd,
				agentDir,
				typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
			),
		);
		const value = await ctx.ui.input(
			`${desc.label} (tokens) — blank = ${label} · ${rangeHint}`,
			initial,
		);
		if (value === undefined) return;
		const trimmed = value.trim();
		const layer = readLayer(scope, cwd, agentDir, sessionKey);
		if (trimmed === "") {
			unsetPath(layer, desc.path);
			await commitRpcWrite(ctx, scope, layer, cwd, agentDir, sessionKey, changedScopes);
			return;
		}
		const parsed = parseContextWindowInput(trimmed);
		if (!parsed.ok) {
			ctx.ui.notify(`Workflow settings: ${parsed.error}`, "error");
			return;
		}
		const candidateLayer = JSON.parse(JSON.stringify(layer));
		setPath(candidateLayer, desc.path, parsed.value);
		const candidate = buildCandidateConfigUpToScope(
			scope,
			candidateLayer,
			cwd,
			agentDir,
			ctx,
		);
		const check = validateRoleContextWindowCandidate(
			candidate.models[desc.role],
			ctx.modelRegistry,
			loadDiskCompactionSnapshot(
				cwd,
				agentDir,
				typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
			),
		);
		if (!check.ok) {
			ctx.ui.notify(
				`Workflow settings: contextWindow 未保存 — ${check.error}`,
				"error",
			);
			return;
		}
		setPath(layer, desc.path, parsed.value);
		await commitRpcWrite(ctx, scope, layer, cwd, agentDir, sessionKey, changedScopes);
		return;
	}

	// String: single-line input.
	const layer = readLayer(scope, cwd, agentDir, sessionKey);
	const raw = getPath(layer, desc.path);
	const initial = raw === undefined ? "" : String(raw);
	const value = await ctx.ui.input(desc.label, initial);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (trimmed === "") unsetPath(layer, desc.path);
	else setPath(layer, desc.path, trimmed);
	await commitRpcWrite(ctx, scope, layer, cwd, agentDir, sessionKey, changedScopes);
}
