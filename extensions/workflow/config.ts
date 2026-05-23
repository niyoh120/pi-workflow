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

/**
 * Strip legacy subagent fields from a loaded config object.
 * Old fields like enabled/extensionMode/extensions/fallbackToInlineReview/timeoutMs
 * are silently ignored. New fields from DEFAULT_CONFIG take over.
 */
function stripLegacySubagentFields(cfg: any): any {
  if (!cfg || !cfg.subagent) return cfg;
  const cleaned = { ...cfg };
  const sa = { ...cleaned.subagent };
  // Fields that existed in the old SubagentConfig but are no longer used.
  const legacyKeys = ["enabled", "timeoutMs", "extensionMode", "extensions", "fallbackToInlineReview"];
  let hadLegacy = false;
  for (const k of legacyKeys) {
    if (k in sa) { hadLegacy = true; delete sa[k]; }
  }
  // If after stripping the object is empty, remove it entirely so deepMerge doesn't
  // leave an empty subagent override that shadows the default.
  if (Object.keys(sa).length === 0) {
    delete cleaned.subagent;
  } else {
    cleaned.subagent = sa;
  }
  if (hadLegacy) {
    console.warn("[pi-workflow] Ignoring legacy subagent config fields — subagents are now managed by @tintinweb/pi-subagents.");
  }
  return cleaned;
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
      merged = deepMerge(merged, stripLegacySubagentFields(globalCfg));
    } catch (e) {
      console.error(`Warning: Could not parse global config ${gpath}: ${e}`);
    }
  }

  // Layer project config
  const ppath = configPath(cwd);
  if (fs.existsSync(ppath)) {
    try {
      const projectCfg = JSON.parse(fs.readFileSync(ppath, "utf8"));
      merged = deepMerge(merged, stripLegacySubagentFields(projectCfg));
    } catch (e) {
      console.error(`Warning: Could not parse project config ${ppath}: ${e}`);
    }
  }

  return merged;
}
