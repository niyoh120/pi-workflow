import type { Mode } from "./types.js";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";

// Fixed scratch root for Plan Mode temporary scripts.
const PLAN_SCRATCH_ROOT = path.join(tmpdir(), "pi-workflow-plan-scratch");

/**
 * Check whether a target path is inside the .pi/workflow/ data directory.
 * Used to block direct read/write/edit access — agents must use workflow tools instead.
 */
export function isWorkflowDataPath(targetPath: string, cwd: string): boolean {
	const resolved = path.resolve(cwd, targetPath);
	const workflowRoot = path.resolve(cwd, ".pi", "workflow");
	return (
		resolved === workflowRoot || resolved.startsWith(workflowRoot + path.sep)
	);
}

/**
 * Check whether a target path is a safe scratch path for Plan Mode write/edit.
 * Requires: absolute path, under PLAN_SCRATCH_ROOT, no symlinks in path,
 * no path that canonicalizes inside cwd, existing targets must be regular files.
 * Ensures PLAN_SCRATCH_ROOT exists (creates if needed) and is safe.
 * Returns null if allowed, or a denial reason string.
 */
export function isAllowedPlanScratchPath(
	cwd: string,
	targetPath: string,
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
	}

	return null; // Allowed.
}

/**
 * Check whether a work-mode write/edit target stays inside the active worktree.
 * Requires an absolute path and rejects symlink/hard-link escapes.
 */
export function isInsideWorktree(
	worktreePath: string,
	targetPath: string,
): string | null {
	if (!path.isAbsolute(targetPath)) {
		return `Worktree mode requires absolute paths under ${worktreePath}.`;
	}

	let canonicalRoot: string;
	try {
		const rootStat = lstatSync(worktreePath);
		if (rootStat.isSymbolicLink()) {
			return `Worktree root ${worktreePath} is a symlink — rejected.`;
		}
		if (!rootStat.isDirectory()) {
			return `Worktree root ${worktreePath} is not a directory.`;
		}
		canonicalRoot = realpathSync(worktreePath);
	} catch {
		return `Cannot resolve worktree root: ${worktreePath}`;
	}

	const lexicalRoot = path.resolve(path.normalize(worktreePath));
	const normalized = path.resolve(path.normalize(targetPath));
	const rel = path.relative(lexicalRoot, normalized);
	const escapesRoot =
		rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
	if (rel === "" || escapesRoot || path.resolve(lexicalRoot, rel) !== normalized) {
		return `Path must be under worktree ${worktreePath}.`;
	}

	const segments = rel.split(path.sep).filter(Boolean);
	let accumulated = canonicalRoot;
	for (let i = 0; i < segments.length; i++) {
		accumulated = path.join(accumulated, segments[i]);
		const isFinal = i === segments.length - 1;

		// This preflight is not sufficient as a security boundary for the later
		// built-in write/edit mutation. A controlled writer with no-follow traversal
		// would be needed to close symlink-swap TOCTOU races completely.
		let stat: ReturnType<typeof lstatSync>;
		let canonical: string;
		try {
			stat = lstatSync(accumulated);
			if (stat.isSymbolicLink()) {
				return `Path component ${accumulated} is a symlink — rejected.`;
			}

			if (isFinal) {
				if (!stat.isFile()) {
					return `Target ${accumulated} exists but is not a regular file.`;
				}
				if (stat.nlink > 1) {
					return `Target ${accumulated} has multiple hard links — rejected.`;
				}
			} else if (!stat.isDirectory()) {
				return `Path component ${accumulated} is not a directory.`;
			}

			canonical = realpathSync(accumulated);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				if (isFinal) continue;
				return `Path component ${accumulated} does not exist.`;
			}
			return `Cannot validate path component: ${accumulated}`;
		}

		const relToRoot = path.relative(canonicalRoot, canonical);
		const escapesRoot =
			relToRoot === ".." ||
			relToRoot.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relToRoot);
		if (relToRoot === "" || escapesRoot) {
			return `Path ${accumulated} resolves outside worktree.`;
		}
	}

	return null;
}

/**
 * Returns true if the given mode is read-only for local file mutations via
 * the generic write/edit path. `init` is treated as read-only; its
 * single-file AGENTS.md write exception is handled by a dedicated init
 * branch before this generic path. Bash mutation behavior relies on mode
 * prompts; this function only governs the write/edit tool path.
 */
export function isReadonlyMode(mode: Mode): boolean {
	return mode === "explore" || mode === "plan" || mode === "init";
}

/**
 * Validate a write/edit target against the single Init Mode allow-file.
 *
 * Invariants:
 *  - targetPath must be absolute and, after normalize+resolve, strictly equal
 *    to the recorded init target path (no directory prefix, no traversal).
 *  - the repo root (target's parent, as recorded by /workflow:init) must be an
 *    existing real directory and not a symlink.
 *  - every existing path component from repo root down to the target must be
 *    a real directory (no symlinks); the target itself, if it exists, must be
 *    a regular file with a single hard link.
 *
 * This is a preflight before the built-in write/edit mutation. Like the
 * worktree guard it shares the symlink-swap TOCTOU boundary; a fully
 * no-follow controlled writer is out of scope.
 *
 * Returns null if allowed, otherwise a denial reason string.
 */
export function isAllowedInitTargetPath(
	repoRoot: string,
	initTargetPath: string | undefined,
	targetPath: string | undefined,
): string | null {
	if (!initTargetPath) {
		return "Init Mode has no target file configured.";
	}
	if (!targetPath) {
		return "Init Mode: write/edit requires the target AGENTS.md path.";
	}
	if (!path.isAbsolute(targetPath)) {
		return `Init Mode: write/edit requires an absolute path. Received: ${targetPath}`;
	}

	const normalizedTarget = path.resolve(path.normalize(targetPath));
	const normalizedInit = path.resolve(path.normalize(initTargetPath));
	if (normalizedTarget !== normalizedInit) {
		return `Init Mode: only ${normalizedInit} may be written. Received: ${normalizedTarget}`;
	}

	// Repo root must be an existing real directory.
	let rootReal: string;
	try {
		const rootStat = lstatSync(repoRoot);
		if (rootStat.isSymbolicLink()) {
			return `Repo root ${repoRoot} is a symlink — rejected.`;
		}
		if (!rootStat.isDirectory()) {
			return `Repo root ${repoRoot} is not a directory.`;
		}
		rootReal = realpathSync(repoRoot);
	} catch (err) {
		return `Cannot resolve repo root: ${repoRoot} (${(err as Error).message})`;
	}

	// Walk the relative segments from repo root to target, enforcing no
	// symlinks and real directories; the final segment, if present, must be a
	// regular file with a single hard link. Nested paths (e.g. docs/AGENTS.md)
	// under the repo root are intentionally allowed.
	const rel = path.relative(rootReal, normalizedTarget);
	if (
		rel === "" ||
		rel === ".." ||
		rel.startsWith(`..${path.sep}`) ||
		path.isAbsolute(rel)
	) {
		return `Init target ${normalizedTarget} resolves outside repo root.`;
	}

	const segments = rel.split(path.sep).filter(Boolean);
	let accumulated = rootReal;
	for (let i = 0; i < segments.length; i++) {
		accumulated = path.join(accumulated, segments[i]);
		const isFinal = i === segments.length - 1;

		try {
			const stat = lstatSync(accumulated);
			if (stat.isSymbolicLink()) {
				return `Path component ${accumulated} is a symlink — rejected.`;
			}
			if (isFinal) {
				if (!stat.isFile()) {
					return `Target ${accumulated} exists but is not a regular file.`;
				}
				if (stat.nlink > 1) {
					return `Target ${accumulated} has multiple hard links — rejected.`;
				}
			} else if (!stat.isDirectory()) {
				return `Path component ${accumulated} is not a directory.`;
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				if (isFinal) continue; // creating the target file is allowed
				return `Path component ${accumulated} does not exist.`;
			}
			return `Cannot validate path component: ${accumulated} (${(err as Error).message})`;
		}
	}

	return null;
}
