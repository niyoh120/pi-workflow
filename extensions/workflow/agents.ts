/**
 * Bundled agent asset helpers for pi-workflow.
 *
 * Bundled custom review agent definitions live under extensions/workflow/agents/.
 * The sync helper copies them to the global agents directory (~/.pi/agent/agents/)
 * so pi-subagents discovers them in any project.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Managed-by header that marks pi-workflow owned files. */
const MANAGED_MARKER = "<!-- managed-by: pi-workflow -->";

/**
 * Resolve the directory containing bundled agent .md files.
 * Works from the current module's location: extensions/workflow/agents/
 */
export function getBundledAgentsDir(): string {
  // __dirname equivalent for ESM
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  return path.join(currentDir, "agents");
}

/**
 * Resolve the global agents directory where pi-subagents discovers custom types.
 */
export function getGlobalAgentsDir(agentDir: string): string {
  return path.join(agentDir, "agents");
}

/** Agents that pi-workflow bundles and requires for review operations. */
const BUNDLED_REVIEW_AGENTS = [
  "pi-workflow-plan-review.md",
  "pi-workflow-code-review.md",
] as const;

export interface SyncResult {
  copied: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Sync bundled review agent definitions to the global agents directory.
 *
 * Safety rules:
 * - Only copies files that carry the pi-workflow managed marker.
 * - If a target file exists but does NOT have the marker, it is skipped
 *   (assumed user-owned) and reported as skipped.
 * - If a target file exists and HAS the marker, it is overwritten.
 * - If a target file does not exist, it is created.
 *
 * Returns a summary of what was copied, skipped, and any errors.
 */
export function syncReviewAgentsToGlobal(agentDir: string): SyncResult {
  const result: SyncResult = { copied: [], skipped: [], errors: [] };
  const sourceDir = getBundledAgentsDir();
  const targetDir = getGlobalAgentsDir(agentDir);

  // Ensure target directory exists
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err: any) {
    result.errors.push(`Cannot create global agents dir ${targetDir}: ${err.message}`);
    return result;
  }

  for (const filename of BUNDLED_REVIEW_AGENTS) {
    const sourcePath = path.join(sourceDir, filename);
    const targetPath = path.join(targetDir, filename);

    // Check source exists
    if (!fs.existsSync(sourcePath)) {
      result.errors.push(`Bundled agent not found: ${sourcePath}`);
      continue;
    }

    // Read source content
    let sourceContent: string;
    try {
      sourceContent = fs.readFileSync(sourcePath, "utf-8");
    } catch (err: any) {
      result.errors.push(`Cannot read ${sourcePath}: ${err.message}`);
      continue;
    }

    // Verify source has managed marker (safety)
    if (!sourceContent.includes(MANAGED_MARKER)) {
      result.errors.push(`Bundled agent ${filename} is missing managed-by marker — refusing to sync.`);
      continue;
    }

    // Check target
    if (fs.existsSync(targetPath)) {
      let existingContent: string;
      try {
        existingContent = fs.readFileSync(targetPath, "utf-8");
      } catch (err: any) {
        result.errors.push(`Cannot read existing ${targetPath}: ${err.message}`);
        continue;
      }

      if (!existingContent.includes(MANAGED_MARKER)) {
        // User-owned file — skip with warning
        result.skipped.push(`${filename} (existing user file, not managed by pi-workflow)`);
        continue;
      }
      // Managed file — overwrite is safe
    }

    // Write
    try {
      fs.writeFileSync(targetPath, sourceContent, "utf-8");
      result.copied.push(filename);
    } catch (err: any) {
      result.errors.push(`Cannot write ${targetPath}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Check whether a custom review agent is discoverable by pi-subagents.
 * Checks both project-local (.pi/agents/) and global (~/.pi/agent/agents/) paths.
 */
export function isReviewAgentAvailable(
  cwd: string,
  agentDir: string,
  agentName: "pi-workflow-plan-review" | "pi-workflow-code-review",
): boolean {
  const filename = `${agentName}.md`;

  // Check project-local (highest priority for pi-subagents)
  const projectPath = path.join(cwd, ".pi", "agents", filename);
  if (fs.existsSync(projectPath)) return true;

  // Check global
  const globalPath = path.join(agentDir, "agents", filename);
  if (fs.existsSync(globalPath)) return true;

  // Not found in any pi-subagents discoverable path.
  // Bundled source exists but must be synced first via /wf-install-subagents.
  return false;
}

/** Hint text shown when a required review agent is not available. */
export function reviewAgentMissingHint(): string {
  return (
    "Required custom review agent not found. Run /wf-install-subagents to install @tintinweb/pi-subagents " +
    "and sync bundled review agents, then /reload or restart Pi."
  );
}
