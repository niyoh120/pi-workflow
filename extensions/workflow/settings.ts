/**
 * settings.ts — /wf-settings configuration menu
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
 * inherited rows show "inherit" plus the effective merged value.
 */

import type {
	ExtensionAPI,
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
	loadConfigForSession,
	readProjectConfigRaw,
	readGlobalConfigRaw,
	writeProjectConfigRaw,
	writeGlobalConfigRaw,
} from "./config.js";
import { getSessionKey, loadState, saveState } from "./state.js";
import { applyModeRuntime } from "./mode.js";
import type { WorkflowConfig } from "./types.js";

// ── Scopes ────────────────────────────────────────────────────────────────

type Scope = "session" | "project" | "global";
type ScopeAction = Scope | "reset-session" | "reset-project";

const SCOPE_LABELS: Record<Scope, string> = {
	session: "Session (this Pi process)",
	project: "Project (.pi/workflow/config.json)",
	global: "Global (~/.pi/agent/workflow/config.json)",
};

// ── Setting descriptors ─────────────────────────────────────────────────────

type SettingKind = "boolean" | "thinking" | "string" | "model";

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

const ROLES = ["explore", "plan", "planReview", "work", "commit"] as const;

const THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

/** Paths whose change requires /reload (or restart) to fully take effect. */
const RELOAD_SENSITIVE_IDS = new Set([
	"workflow.autoEnter",
	"planReview.enabled",
	"codeReview.enabled",
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
			id: "codeReview.enabled",
			label: "codeReview · enabled",
			description:
				"Expose workflow_code_review and /review (requires /reload to register/unregister).",
			kind: "boolean",
			path: ["codeReview", "enabled"],
			reloadSensitive: true,
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
	effective?: WorkflowConfig,
	modelRegistry?: ModelRegistry,
): string[] | undefined {
	if (desc.kind === "boolean") return ["inherit", "true", "false"];
	if (desc.kind === "thinking") {
		if (effective && modelRegistry) {
			return thinkingValuesFor(desc, effective, modelRegistry);
		}
		return ["inherit", ...THINKING_VALUES];
	}
	return undefined; // string/model → submenu
}

/** Return thinking levels supported by the effective model for a role. */
function thinkingValuesFor(
	desc: SettingDescriptor,
	effective: WorkflowConfig,
	modelRegistry: ModelRegistry,
): string[] {
	if (!desc.role) return ["inherit", ...THINKING_VALUES];
	try {
		const spec = effective.models[desc.role];
		const model = modelRegistry.find(spec.provider, spec.model);
		if (!model) return ["inherit", ...THINKING_VALUES];
		return ["inherit", ...getSupportedThinkingLevels(model)];
	} catch {
		return ["inherit", ...THINKING_VALUES];
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
		return `inherit (${formatModelRef(
			getPath(effective, paths.provider),
			getPath(effective, paths.model),
		)})`;
	}

	const raw = getPath(layer, desc.path);
	if (raw !== undefined) return formatVal(raw);
	if (desc.kind === "string") {
		return `inherit (${formatVal(getPath(effective, desc.path))})`;
	}
	return "inherit";
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
			theme.fg("dim", "enter save · clear field = inherit · esc cancel"),
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
	effectiveProvider: string,
	effectiveModel: string,
): { items: ModelPickerItem[]; error?: string } {
	try {
		modelRegistry.refresh();
		const loadError = modelRegistry.getError();
		const models = [...modelRegistry.getAvailable()].sort((a, b) => {
			const aRef = `${a.provider}/${a.id}`;
			const bRef = `${b.provider}/${b.id}`;
			return aRef.localeCompare(bRef);
		});
		return {
			items: [
				{
					value: INHERIT_MODEL_VALUE,
					label: "inherit",
					description: `Use effective model: ${formatModelRef(
						effectiveProvider,
						effectiveModel,
					)}`,
					searchText: `inherit ${effectiveProvider} ${effectiveModel}`,
				},
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
			items: [
				{
					value: INHERIT_MODEL_VALUE,
					label: "inherit",
					description: `Use effective model: ${formatModelRef(
						effectiveProvider,
						effectiveModel,
					)}`,
					searchText: `inherit ${effectiveProvider} ${effectiveModel}`,
				},
			],
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

function makeModelPickerSubmenu({
	theme,
	title,
	modelRegistry,
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
					"type to search · enter select · esc cancel · choose inherit to clear this scope",
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

export function registerWfSettingsCommand(
	pi: ExtensionAPI,
	getAgentDir: () => string,
): void {
	const descriptors = buildDescriptors();
	const byId = new Map(descriptors.map((d) => [d.id, d]));

	pi.registerCommand("wf-settings", {
		description:
			"配置 workflow 选项（models / autoEnter / planReview / codeReview），支持 session / project / global 三层作用域",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const cwd = ctx.cwd;
			const agentDir = getAgentDir();
			const sessionKey = ctxSessionKey(ctx);

			// Non-TUI mode: provide text-based instructions
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"Settings menu requires interactive mode (TUI). " +
						"In RPC/JSON/print mode, please edit config files directly:\n" +
						"  - Session: stored in session state\n" +
						"  - Project: .pi/workflow/config.json\n" +
						"  - Global: ~/.pi/agent/workflow/config.json",
					"info",
				);
				return;
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
						const initialEffective = loadConfigForSession(
							cwd,
							agentDir,
							sessionKey,
						);

						const items: SettingItem[] = scopeDescriptors.map((desc) => {
							const item: SettingItem = {
								id: desc.id,
								label: desc.label,
								description: descriptionFor(desc, initialEffective),
								currentValue: currentDisplay(
									desc,
									initialLayer,
									initialEffective,
								),
							};
							const values = valuesFor(
								desc,
								initialEffective,
								ctx.modelRegistry,
							);
							if (values) {
								item.values = values;
							} else if (desc.kind === "model" && desc.role) {
								item.submenu = (_cur, submenuDone) => {
									const layer = readLayer(scope, cwd, agentDir, sessionKey);
									const effective = loadConfigForSession(
										cwd,
										agentDir,
										sessionKey,
									);
									const paths = modelPaths(desc.role!);
									const rawProvider = getPath(layer, paths.provider);
									const rawModel = getPath(layer, paths.model);
									return makeModelPickerSubmenu({
										theme,
										title: desc.label,
										modelRegistry: ctx.modelRegistry,
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
								// String field → single-line input submenu.
								item.submenu = (_cur, submenuDone) => {
									const raw = getPath(
										readLayer(scope, cwd, agentDir, sessionKey),
										desc.path,
									);
									const initial = raw === undefined ? "" : String(raw);
									return makeStringInputSubmenu(
										theme,
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
							const effective = loadConfigForSession(cwd, agentDir, sessionKey);
							for (const item of items) {
								const desc = byId.get(item.id);
								if (!desc) continue;
								item.currentValue = currentDisplay(desc, layer, effective);
								item.description = descriptionFor(desc, effective);
								if (desc.kind === "thinking" && desc.role) {
									item.values = thinkingValuesFor(
										desc,
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
									}
								}
							} else if (desc.kind === "boolean") {
								if (newValue === "inherit") unsetPath(layer, desc.path);
								else setPath(layer, desc.path, newValue === "true");
							} else {
								// thinking
								if (newValue === "inherit") unsetPath(layer, desc.path);
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
			const effective = loadConfigForSession(cwd, agentDir, sessionKey);
			const workflowActive =
				(state.workflowEnabled || effective.workflow.autoEnter) &&
				!state.workflowExplicitlyDisabled;
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
					? " Changes to autoEnter / planReview.enabled / codeReview.enabled also need /reload."
					: "";
				ctx.ui.notify(
					`Workflow settings saved (${scopes}), but the runtime failed to switch model/thinking. Check provider/model names and API key.${suffix}`,
					"warning",
				);
			} else if (reloadNeeded) {
				ctx.ui.notify(
					`Workflow settings saved (${scopes}). Changes to autoEnter / planReview.enabled / codeReview.enabled need /reload to take effect.`,
					"warning",
				);
			} else {
				ctx.ui.notify(
					`Workflow settings saved (${scopes}). Model/thinking changes apply to the current and later turns.`,
					"info",
				);
			}
		},
	});
}
