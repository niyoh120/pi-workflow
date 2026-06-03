import fs from "node:fs";
import path from "node:path";
import type { WorkflowConfig, WorkflowConfigOverride } from "./types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { globalConfigPath, configPath, ensureWorkflowDir } from "./paths.js";
import { loadState } from "./state.js";

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

/** Load merged config: DEFAULT ← global ← project ← session override.
 *  The optional sessionOverride is the highest-priority layer (used by
 *  /wf-settings Session scope). */
export function loadConfig(
	cwd: string,
	agentDir: string,
	sessionOverride?: WorkflowConfigOverride,
): WorkflowConfig {
	ensureWorkflowDir(cwd);

	let merged = { ...DEFAULT_CONFIG };

	// Layer global config
	const gpath = globalConfigPath(agentDir);
	if (fs.existsSync(gpath)) {
		try {
			const globalCfg = JSON.parse(fs.readFileSync(gpath, "utf8"));
			merged = deepMerge(merged, globalCfg);
		} catch (e) {
			console.error(`Warning: Could not parse global config ${gpath}: ${e}`);
		}
	}

	// Layer project config
	const ppath = configPath(cwd);
	if (fs.existsSync(ppath)) {
		try {
			const projectCfg = JSON.parse(fs.readFileSync(ppath, "utf8"));
			merged = deepMerge(merged, projectCfg);
		} catch (e) {
			console.error(`Warning: Could not parse project config ${ppath}: ${e}`);
		}
	}

	// Layer session override (highest priority). WorkflowConfigOverride is a
	// deep-partial; deepMerge handles partial nesting at runtime, so the cast
	// to Partial<WorkflowConfig> only satisfies the generic's shallow shape.
	if (sessionOverride && typeof sessionOverride === "object") {
		merged = deepMerge(merged, sessionOverride as Partial<WorkflowConfig>);
	}

	// Normalize: strip stale fields from old configs (e.g. the removed
	// subagent section, old planReview.maxLoops/codeReview.maxLoops/codeReview.auto).
	merged = normalizeConfig(merged);

	return merged;
}

/** Load merged config including this session's override layer.
 *  Reads sessionConfig from the session state and passes it as the
 *  highest-priority layer to loadConfig. */
export function loadConfigForSession(
	cwd: string,
	agentDir: string,
	sessionKey: string,
): WorkflowConfig {
	let sessionOverride: WorkflowConfigOverride | undefined;
	try {
		sessionOverride = loadState(cwd, sessionKey).sessionConfig;
	} catch {
		sessionOverride = undefined;
	}
	return loadConfig(cwd, agentDir, sessionOverride);
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

// ── Raw config-layer IO (for /wf-settings) ─────────────────────────────
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
export function writeProjectConfigRaw(
	cwd: string,
	layer: Record<string, any>,
): void {
	ensureWorkflowDir(cwd);
	writeRawJsonAtomic(configPath(cwd), layer);
}

/** Atomically write the raw global config layer. */
export function writeGlobalConfigRaw(
	agentDir: string,
	layer: Record<string, any>,
): void {
	writeRawJsonAtomic(globalConfigPath(agentDir), layer);
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
