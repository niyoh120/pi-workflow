import fs from "node:fs";
import type { WorkflowConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { globalConfigPath, configPath, ensureWorkflowDir } from "./paths.js";

/** Deep-merge objects recursively: arrays are replaced, objects are merged. */
export function deepMerge<T>(base: T, override: Partial<T>): T {
	const output: any = Array.isArray(base) ? [...base] : { ...(base as any) };

	for (const [key, value] of Object.entries(override as any)) {
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

/** Load merged config: DEFAULT ← global ← project. */
export function loadConfig(cwd: string, agentDir: string): WorkflowConfig {
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

	// Normalize: strip stale fields from old configs (e.g. the removed
	// subagent section, old planReview.maxLoops/codeReview.maxLoops/codeReview.auto).
	merged = normalizeConfig(merged);

	return merged;
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
		"plan",
		"planReview",
		"work",
		"review",
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
