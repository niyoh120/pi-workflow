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

  return merged;
}
