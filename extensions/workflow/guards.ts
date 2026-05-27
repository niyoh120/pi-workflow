import type { Mode, WorkflowState } from "./types.js";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";

// Fixed scratch root for Plan Mode temporary scripts.
const PLAN_SCRATCH_ROOT = path.join(tmpdir(), "pi-workflow-plan-scratch");

/**
 * Check whether a target path is a safe scratch path for Plan Mode write/edit.
 * Requires: absolute path, under PLAN_SCRATCH_ROOT, no symlinks in path,
 * no path that canonicalizes inside cwd, existing targets must be regular files.
 * Ensures PLAN_SCRATCH_ROOT exists (creates if needed) and is safe.
 * Returns null if allowed, or a denial reason string.
 */
export function isAllowedPlanScratchPath(
  cwd: string,
  targetPath: string
): string | null {
  // 1. Must be absolute.
  if (!path.isAbsolute(targetPath)) {
    return "Only absolute paths under the Plan Mode scratch root are allowed.";
  }

  const normalized = path.resolve(path.normalize(targetPath));
  const scratchRoot = path.resolve(PLAN_SCRATCH_ROOT);

  // 2. Must be strictly under the scratch root.
  const rel = path.relative(scratchRoot, normalized);
  if (rel.startsWith("..") || path.resolve(scratchRoot, rel) !== normalized) {
    return `Path must be under ${scratchRoot}.`;
  }

  // 3. Canonicalize cwd.
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(cwd);
  } catch {
    return `Cannot resolve cwd: ${cwd}`;
  }

  // 4. Ensure scratch root exists and is safe (not a symlink, not inside cwd).
  let canonicalRoot: string;
  try {
    const rootStat = lstatSync(scratchRoot);
    if (rootStat.isSymbolicLink()) {
      return `Scratch root ${scratchRoot} is a symlink — rejected.`;
    }
    if (!rootStat.isDirectory()) {
      return `Scratch root ${scratchRoot} is not a directory.`;
    }
    canonicalRoot = realpathSync(scratchRoot);
  } catch {
    // Scratch root does not exist — verify the nearest existing ancestor
    // (tmpdir) is safe before creating anything.
    const tempDir = tmpdir();
    let canonicalTemp: string;
    try {
      canonicalTemp = realpathSync(tempDir);
    } catch {
      return `Cannot resolve temp directory: ${tempDir}`;
    }
    const tempRelToCwd = path.relative(canonicalCwd, canonicalTemp);
    if (!tempRelToCwd.startsWith("..") && tempRelToCwd !== "") {
      return `Temp directory resolves inside project — cannot create scratch root.`;
    }
    if (tempRelToCwd === "") {
      return `Temp directory resolves to project directory — cannot create scratch root.`;
    }

    // Safe to create scratch root now.
    mkdirSync(scratchRoot, { recursive: true });
    const createdStat = lstatSync(scratchRoot);
    if (createdStat.isSymbolicLink()) {
      return `Scratch root ${scratchRoot} was created as a symlink — rejected.`;
    }
    if (!createdStat.isDirectory()) {
      return `Scratch root ${scratchRoot} is not a directory — rejected.`;
    }
    canonicalRoot = realpathSync(scratchRoot);
  }

  // Scratch root itself must NOT resolve inside cwd.
  const rootRelToCwd = path.relative(canonicalCwd, canonicalRoot);
  if (!rootRelToCwd.startsWith("..") && rootRelToCwd !== "") {
    return `Scratch root resolves inside project directory.`;
  }
  if (rootRelToCwd === "") {
    return `Scratch root resolves to the same path as project directory.`;
  }

  // 5. Walk path segments from scratch root to target.
  //    Check each existing segment: must not be a symlink, must not resolve inside cwd.
  //    Final existing target must be a regular file; intermediate paths must be directories.
  const segments = rel.split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    return `Target path must be a file under ${scratchRoot}, not the root itself.`;
  }

  let accumulated = scratchRoot;
  for (let i = 0; i < segments.length; i++) {
    accumulated = path.join(accumulated, segments[i]);
    const isFinal = i === segments.length - 1;

    if (existsSync(accumulated)) {
      const stat = lstatSync(accumulated);

      if (stat.isSymbolicLink()) {
        return `Path component ${accumulated} is a symlink — rejected.`;
      }

      if (isFinal) {
        if (!stat.isFile()) {
          return `Target ${accumulated} exists but is not a regular file.`;
        }
        // Reject hard links: a hard-link target could share its inode
        // with a project file, so editing it would mutate the project.
        if (stat.nlink > 1) {
          return `Target ${accumulated} has multiple hard links — rejected.`;
        }
      } else {
        if (!stat.isDirectory()) {
          return `Path component ${accumulated} is not a directory.`;
        }
      }

      const canonical = realpathSync(accumulated);
      const relToCwd = path.relative(canonicalCwd, canonical);
      if (!relToCwd.startsWith("..") && relToCwd !== "") {
        return `Path ${accumulated} resolves inside project directory.`;
      }
      if (relToCwd === "") {
        return `Path ${accumulated} resolves to project directory — rejected.`;
      }
    }
    // Non-existing intermediate or final path: fine; existing ancestors already verified.
  }

  return null; // Allowed.
}

/** Returns true if the given mode does not allow local file mutations. */
export function isReadonlyMode(mode: Mode): boolean {
  return mode === "plan" || mode === "planReview" || mode === "workPending" || mode === "review";
}

/** Check whether a shell command would modify local files. */
export function isLocalFileMutatingShell(command: string): boolean {
  const cmd = command.trim();
  if (cmd.length === 0) return false;

  // Shell redirection / tee / patch usually writes files.
  if (/(^|[^<])>\s*[^&]/.test(cmd)) return true;
  if (/>>\s*/.test(cmd)) return true;
  if (/\|\s*tee\b/.test(cmd)) return true;
  if (/\bapply_patch\b/.test(cmd)) return true;

  const mutatingPatterns = [
    /^rm\b/,
    /^mv\b/,
    /^cp\b/,
    /^touch\b/,
    /^mkdir\b/,
    /^rmdir\b/,
    /^chmod\b/,
    /^chown\b/,
    /^ln\b/,
    /^truncate\b/,

    /\bprettier\b.*\s--write\b/,
    /\beslint\b.*\s--fix\b/,
    /\bruff\b.*\s--fix\b/,
    /\bblack\b/,
    /\bgofmt\b.*\s-w\b/,
    /\brustfmt\b/,

    /^npm\s+(install|i|add|update|dedupe|link|uninstall|remove|rm)\b/,
    /^pnpm\s+(install|add|update|link|remove|rm)\b/,
    /^yarn\s+(install|add|upgrade|link|remove)\b/,
    /^bun\s+(install|add|update|remove|rm)\b/,
    /^pip\s+install\b/,
    /^uv\s+add\b/,
    /^poetry\s+add\b/,
    /^cargo\s+add\b/,
    /^go\s+get\b/,

    /^git\s+(add|commit|checkout|switch|reset|clean|apply|restore|merge|rebase|cherry-pick|stash|tag|push)\b/,
    /^git\s+branch\s+(-d|-D|-m)\b/,
  ];

  return mutatingPatterns.some((re) => re.test(cmd));
}

