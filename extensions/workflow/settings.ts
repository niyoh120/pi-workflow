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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getSettingsListTheme,
	DynamicBorder,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Text,
	Spacer,
	Input,
	SelectList,
	SettingsList,
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

// ── Scopes ────────────────────────────────────────────────────────────────

type Scope = "session" | "project" | "global";

const SCOPE_LABELS: Record<Scope, string> = {
	session: "Session (this Pi process)",
	project: "Project (.pi/workflow/config.json)",
	global: "Global (~/.pi/agent/workflow/config.json)",
};

// ── Setting descriptors ─────────────────────────────────────────────────────

type SettingKind = "boolean" | "thinking" | "string";

interface SettingDescriptor {
	id: string;
	label: string;
	description: string;
	kind: SettingKind;
	/** Path into the config object, e.g. ["models", "plan", "provider"]. */
	path: string[];
	/**
	 * True for options that gate command/tool registration, which happens at
	 * extension load time using the non-session config layers. These cannot
	 * take effect from the Session scope (even after /reload), so they are
	 * hidden there and surfaced only for Project/Global scopes.
	 */
	reloadSensitive?: boolean;
}

const ROLES = [
	"explore",
	"plan",
	"planReview",
	"work",
	"review",
	"commit",
] as const;

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
			id: `models.${role}.provider`,
			label: `${role} · provider`,
			description: `Model provider for the ${role} role (e.g. anthropic, openai).`,
			kind: "string",
			path: ["models", role, "provider"],
		});
		list.push({
			id: `models.${role}.model`,
			label: `${role} · model`,
			description: `Model id for the ${role} role (e.g. claude-sonnet-4-5).`,
			kind: "string",
			path: ["models", role, "model"],
		});
		list.push({
			id: `models.${role}.thinking`,
			label: `${role} · thinking`,
			description: `Thinking level for the ${role} role.`,
			kind: "thinking",
			path: ["models", role, "thinking"],
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

function writeLayer(
	scope: Scope,
	layer: Record<string, any>,
	cwd: string,
	agentDir: string,
	sessionKey: string,
): void {
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
		writeProjectConfigRaw(cwd, layer);
		return;
	}
	writeGlobalConfigRaw(agentDir, layer);
}

// ── Display helpers ─────────────────────────────────────────────────────────

function formatVal(v: any): string {
	if (typeof v === "boolean") return v ? "true" : "false";
	if (v === undefined || v === null) return "(none)";
	return String(v);
}

function valuesFor(desc: SettingDescriptor): string[] | undefined {
	if (desc.kind === "boolean") return ["inherit", "true", "false"];
	if (desc.kind === "thinking") return ["inherit", ...THINKING_VALUES];
	return undefined; // string → submenu
}

function currentDisplay(
	desc: SettingDescriptor,
	layer: Record<string, any>,
	effective: any,
): string {
	const raw = getPath(layer, desc.path);
	if (raw !== undefined) return formatVal(raw);
	if (desc.kind === "string") {
		return `inherit (${formatVal(getPath(effective, desc.path))})`;
	}
	return "inherit";
}

function descriptionFor(desc: SettingDescriptor, effective: any): string {
	const eff = formatVal(getPath(effective, desc.path));
	return `${desc.description}  ·  effective: ${eff}`;
}

// ── String input submenu ────────────────────────────────────────────────────

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
		render: (w: number) => container.render(w),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => {
			input.handleInput(data);
			container.invalidate();
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
		value: "project",
		label: "Project (.pi/workflow/config.json)",
		description: "Shared with the project. Overrides global.",
	},
	{
		value: "global",
		label: "Global (~/.pi/agent/workflow/config.json)",
		description: "Applies to all projects. Lowest of the editable layers.",
	},
	{
		value: "__exit__",
		label: "Done — close settings",
		description: "Finish editing and apply changes.",
	},
];

function scopeSelectorComponent(
	theme: Theme,
	done: (value: Scope | null) => void,
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
		if (item.value === "__exit__") {
			done(null);
		} else if (
			item.value === "session" ||
			item.value === "project" ||
			item.value === "global"
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
		render: (w: number) => container.render(w),
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

			const changedScopes = new Set<Scope>();
			const changedIds = new Set<string>();

			// Loop: pick a scope, edit it, return to scope picker, until Done/Esc.
			while (true) {
				const scope = await ctx.ui.custom<Scope | null>(
					(_tui, theme, _kb, done) => scopeSelectorComponent(theme, done),
				);
				if (!scope) break;

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

				await ctx.ui.custom<void>((tui, theme, _kb, done) => {
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
						const values = valuesFor(desc);
						if (values) {
							item.values = values;
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
						} else if (desc.kind === "boolean") {
							if (newValue === "inherit") unsetPath(layer, desc.path);
							else setPath(layer, desc.path, newValue === "true");
						} else {
							// thinking
							if (newValue === "inherit") unsetPath(layer, desc.path);
							else setPath(layer, desc.path, newValue);
						}
						writeLayer(scope, layer, cwd, agentDir, sessionKey);
						changedScopes.add(scope);
						changedIds.add(id);
						refreshItems();
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
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							settingsList.handleInput(data);
							tui.requestRender();
						},
					};
				});
			}

			if (changedIds.size === 0) {
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
