import fs from "node:fs";
import path from "node:path";
import type { WorkflowConfig, WorkflowConfigOverride } from "./types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { globalConfigPath, configPath, ensureWorkflowDir } from "./paths.js";
import { loadState } from "./state.js";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Keys that must never be merged — prevents prototype pollution from
 *  untrusted config files / session state. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Deep-merge objects recursively: arrays are replaced, objects are merged.
 *  Dangerous keys (__proto__/constructor/prototype) are skipped. */
export function deepMerge<T>(base: T, override: Partial<T>): T {
	const output: any = Array.isArray(base) ? [...base] : { ...(base as any) };

	for (const [key, value] of Object.entries(override as any)) {
		if (DANGEROUS_KEYS.has(key)) continue;
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			output[key] &&
			typeof output[key] === "object" &&
			!Array.isArray(output[key])
		) {
			output[key] = deepMerge(output[key], value);
		} else {
			output[key] = value;
		}
	}

	return output;
}

/** Raw layer record for source diagnostics. Each field is a deep-partial raw
 *  object as read from disk (or DEFAULT for the default layer), NOT yet
 *  normalized. `undefined` means the layer was absent (project untrusted or
 *  no file; session override not set). */
export interface ConfigLayers {
	default: WorkflowConfig;
	global: Record<string, any> | undefined;
	project: Record<string, any> | undefined;
	session: WorkflowConfigOverride | undefined;
}

/** Result of {@link loadConfigLayers}: the raw layers, the merged effective
 *  config, and whether the project layer was skipped due to an untrusted
 *  project. `projectSkipped` is derived from the same trust evaluation that
 *  decided `includeProject`, so source attribution never drifts from runtime
 *  semantics. */
export interface ConfigLayersResult {
	layers: ConfigLayers;
	effective: WorkflowConfig;
	projectSkipped: boolean;
}

/** Read each config layer separately without merging. Internal helper for
 *  loadConfigLayers (which also computes the merged effective config and
 *  projectSkipped). Does NOT create directories. */
function loadConfigLayersRaw(
	cwd: string,
	agentDir: string,
	sessionOverride: WorkflowConfigOverride | undefined,
	options: { includeProject: boolean },
): ConfigLayers {
	const layers: ConfigLayers = {
		default: { ...DEFAULT_CONFIG },
		global: undefined,
		project: undefined,
		session: undefined,
	};

	// Layer global config
	const gpath = globalConfigPath(agentDir);
	if (fs.existsSync(gpath)) {
		try {
			layers.global = JSON.parse(fs.readFileSync(gpath, "utf8"));
		} catch (e) {
			console.error(`Warning: Could not parse global config ${gpath}: ${e}`);
		}
	}

	// Layer project config only when project trust allows it.
	if (options.includeProject) {
		const ppath = configPath(cwd);
		if (fs.existsSync(ppath)) {
			try {
				layers.project = JSON.parse(fs.readFileSync(ppath, "utf8"));
			} catch (e) {
				console.error(`Warning: Could not parse project config ${ppath}: ${e}`);
			}
		}
	}

	// Layer session override (highest priority).
	if (sessionOverride && typeof sessionOverride === "object") {
		layers.session = sessionOverride;
	}

	return layers;
}

/** Read effective config layers for a session, honoring project trust.
 *  Returns the per-layer raw objects (plus DEFAULT) for source diagnostics,
 *  plus the merged normalized effective config. The sole ctx-aware public
 *  entry point for runtime/settings/status. */
export function loadConfigLayers(
	cwd: string,
	agentDir: string,
	sessionKey: string,
	ctx?: { isProjectTrusted?: () => boolean },
): ConfigLayersResult {
	let sessionOverride: WorkflowConfigOverride | undefined;
	if (sessionKey) {
		try {
			sessionOverride = loadState(cwd, sessionKey).sessionConfig;
		} catch (e) {
			console.error(`Warning: Could not load session state for key ${sessionKey}: ${e instanceof Error ? e.message : e}`);
			sessionOverride = undefined;
		}
	}
	// Missing trust context is conservative: default/global only. Project
	// config participates only after Pi explicitly reports the project trusted.
	const includeProject =
		!!ctx && typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
	const layers = loadConfigLayersRaw(cwd, agentDir, sessionOverride, { includeProject });
	let effective: WorkflowConfig = { ...DEFAULT_CONFIG };
	if (layers.global) effective = deepMerge(effective, layers.global);
	if (layers.project) effective = deepMerge(effective, layers.project);
	if (layers.session) effective = deepMerge(effective, layers.session as Partial<WorkflowConfig>);
	effective = normalizeConfig(effective);
	// Reuse the exact decision above so diagnostics cannot drift from the
	// effective config. Missing trust context also means the project layer was
	// conservatively skipped.
	const projectSkipped = !includeProject;
	return { layers, effective, projectSkipped };
}

/** Unified ctx-aware effective config loader. Reads session override from
 *  session state and includes the project layer only when the project is
 *  trusted. All business modules (mode/commands/tools/settings/status)
 *  MUST use this instead of the legacy loadConfig/loadConfigForSession/
 *  loadConfigIfTrusted entry points. */
export function loadConfigForContext(
	cwd: string,
	agentDir: string,
	sessionKey: string,
	ctx?: { isProjectTrusted?: () => boolean },
): WorkflowConfig {
	return loadConfigLayers(cwd, agentDir, sessionKey, ctx).effective;
}

// ── Config source diagnostics ──────────────────────────────────────────────

export type ConfigSource = "default" | "global" | "project" | "session";

export interface ConfigSourceReport {
	/** Per-leaf source map. Keys are dotted paths like "models.plan.model". */
	sources: Record<string, ConfigSource>;
	/** True when the project layer was skipped due to untrusted project. */
	projectSkipped: boolean;
	/** The effective merged config (trusted-aware). */
	effective: WorkflowConfig;
}

/**
 * Resolve the origin layer of each config leaf by walking the layer stack
 * from highest to lowest priority: session → project → global → default.
 * Reuses the same loadConfigLayers result that effective config is built
 * from, so source attribution never drifts from runtime semantics.
 */
export function resolveConfigSources(
	cwd: string,
	agentDir: string,
	sessionKey: string,
	ctx?: { isProjectTrusted?: () => boolean },
): ConfigSourceReport {
	const { layers, effective, projectSkipped } = loadConfigLayers(cwd, agentDir, sessionKey, ctx);

	const sources: Record<string, ConfigSource> = {};

	const leafPaths = [
		"workflow.autoEnter",
		"planReview.enabled",
		"review.enabled",
		"codeReview.enabled",
		...(["explore", "plan", "planReview", "review", "work", "commit"] as const).flatMap(
			(role) => [
				`models.${role}.provider`,
				`models.${role}.model`,
				`models.${role}.thinking`,
			],
		),
	];

	for (const path of leafPaths) {
		sources[path] = sourceOfPath(path, layers);
	}

	return { sources, projectSkipped, effective };
}

/** Find the highest-priority layer that defines a given dotted path. */
function sourceOfPath(path: string, layers: ConfigLayers): ConfigSource {
	const segs = path.split(".");
	const get = (obj: Record<string, any> | undefined): unknown => {
		let cur: any = obj;
		for (const seg of segs) {
			if (cur == null || typeof cur !== "object") return undefined;
			cur = cur[seg];
		}
		return cur;
	};
	if (get(layers.session) !== undefined) return "session";
	if (get(layers.project) !== undefined) return "project";
	if (get(layers.global) !== undefined) return "global";
	return "default";
}

/**
 * Normalize a config object to the current schema.
 * Removes stale sections that no longer exist (subagent, askUserQuestion,
 * todoOverlay) and strips unknown keys from codeReview/planReview.
 */
function normalizeConfig(cfg: any): WorkflowConfig {
	// Remove old sections entirely.
	if ("subagent" in cfg) delete cfg.subagent;
	if ("todoOverlay" in cfg) delete cfg.todoOverlay;
	if ("askUserQuestion" in cfg) delete cfg.askUserQuestion;

	// Normalize workflow section — only autoEnter is supported.
	if (
		cfg.workflow &&
		typeof cfg.workflow === "object" &&
		!Array.isArray(cfg.workflow)
	) {
		cfg.workflow = { autoEnter: !!cfg.workflow.autoEnter };
	} else if ("workflow" in cfg) {
		// Non-object value — reset to default.
		cfg.workflow = { autoEnter: DEFAULT_CONFIG.workflow.autoEnter };
	}

	// Strip unknown planReview fields — only enabled is supported.
	if (cfg.planReview && typeof cfg.planReview === "object") {
		cfg.planReview = { enabled: !!cfg.planReview.enabled };
	}

	// Strip unknown review fields — only enabled is supported.
	if (cfg.review && typeof cfg.review === "object") {
		cfg.review = { enabled: !!cfg.review.enabled };
	}

	// Strip unknown codeReview fields — only enabled is supported.
	if (cfg.codeReview && typeof cfg.codeReview === "object") {
		cfg.codeReview = { enabled: !!cfg.codeReview.enabled };
	}

	// Strip unknown models entries and normalize each model to only contain
	// provider/model/thinking (strip baseUrl, apiKey, or other old fields).
	const VALID_ROLES = new Set([
		"explore",
		"plan",
		"planReview",
		"work",
		"commit",
		"review",
	]);
	if (cfg.models && typeof cfg.models === "object") {
		const cleaned: any = {};
		for (const [key, val] of Object.entries(cfg.models)) {
			if (VALID_ROLES.has(key) && val && typeof val === "object") {
				const m = val as any;
				cleaned[key] = {
					provider: m.provider,
					model: m.model,
					...("thinking" in m ? { thinking: m.thinking } : {}),
				};
			}
		}
		cfg.models = cleaned;
	}

	return cfg as WorkflowConfig;
}

// ── Raw config-layer IO (for /workflow:settings) ─────────────────────────────
//
// These helpers read/write a raw partial config object for a single layer
// (project or global config.json) WITHOUT merging defaults. They are used
// by the settings editor to surface and mutate only the values explicitly
// stored in that layer. A missing file reads as {}; a corrupt file throws
// so the editor never silently overwrites recoverable user content.

/** Read the raw project config layer ({} if missing). Throws on parse error. */
export function readProjectConfigRaw(cwd: string): Record<string, any> {
	const ppath = configPath(cwd);
	return readRawJson(ppath);
}

/** Read the raw global config layer ({} if missing). Throws on parse error. */
export function readGlobalConfigRaw(agentDir: string): Record<string, any> {
	const gpath = globalConfigPath(agentDir);
	return readRawJson(gpath);
}

/** Atomically write the raw project config layer. */
export async function writeProjectConfigRaw(
	cwd: string,
	layer: Record<string, any>,
): Promise<void> {
	ensureWorkflowDir(cwd);
	const filePath = configPath(cwd);
	await withFileMutationQueue(filePath, async () => {
		writeRawJsonAtomic(filePath, layer);
	});
}

/** Atomically write the raw global config layer. */
export async function writeGlobalConfigRaw(
	agentDir: string,
	layer: Record<string, any>,
): Promise<void> {
	const filePath = globalConfigPath(agentDir);
	await withFileMutationQueue(filePath, async () => {
		writeRawJsonAtomic(filePath, layer);
	});
}

function readRawJson(filePath: string): Record<string, any> {
	if (!fs.existsSync(filePath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (e) {
		// Surface a clear error instead of returning {} — returning {} would
		// let a later write silently overwrite a corrupt-but-meaningful file.
		throw new Error(`Could not parse config ${filePath}: ${e}`);
	}
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, any>)
		: (() => {
				throw new Error(
					`Config ${filePath} must be a JSON object (got ${parsed === null ? "null" : typeof parsed}).`,
				);
			})();
}

function writeRawJsonAtomic(
	filePath: string,
	value: Record<string, any>,
): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpFile = path.join(
		dir,
		`.tmp-config-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	try {
		fs.writeFileSync(tmpFile, JSON.stringify(value, null, 2) + "\n", "utf8");
		fs.renameSync(tmpFile, filePath);
	} catch (e) {
		try {
			if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
		} catch {
			/* best-effort */
		}
		throw e;
	}
}
