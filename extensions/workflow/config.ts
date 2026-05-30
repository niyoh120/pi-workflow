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
 * Removes stale sections that no longer exist in the types (e.g. subagent),
 * and strips unknown keys from codeReview/planReview.
 */
function normalizeConfig(cfg: any): WorkflowConfig {
  // Remove the old `subagent` section entirely — it no longer exists.
  if ("subagent" in cfg) {
    delete cfg.subagent;
  }

  // Remove stale planReview fields (maxLoops no longer used)
  if (cfg.planReview && typeof cfg.planReview === "object") {
    const pr: any = {};
    if ("enabled" in cfg.planReview) pr.enabled = cfg.planReview.enabled;
    cfg.planReview = pr;
  }

  // Remove stale codeReview fields (maxLoops, auto)
  if (cfg.codeReview && typeof cfg.codeReview === "object") {
    const cr: any = {};
    if ("enabled" in cfg.codeReview) cr.enabled = cfg.codeReview.enabled;
    if ("ocrBinary" in cfg.codeReview) cr.ocrBinary = cfg.codeReview.ocrBinary;
    if ("timeoutMs" in cfg.codeReview) cr.timeoutMs = cfg.codeReview.timeoutMs;
    if ("maxLoops" in cfg.codeReview) cr.maxLoops = cfg.codeReview.maxLoops;
    cfg.codeReview = cr;
  }

  // Remove stale models entries (explore)
  if (cfg.models && typeof cfg.models === "object") {
    if ("explore" in cfg.models) {
      delete cfg.models.explore;
    }
  }

  return cfg as WorkflowConfig;
}