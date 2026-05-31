/**
 * sidecall — lightweight plan-review via completeSimple (no subprocess).
 *
 * Replaces the pi-subagents spawnAndWait path for planReview.
 * Builds a curated system prompt (review focus + conversation summary +
 * key file snippets + tool inventory), calls completeSimple once with
 * no tools, and returns a structured tool result.
 */

import type {
	StopReason,
	Usage,
	ThinkingLevel,
	Context,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import type { ModelSpec, Thinking } from "./types.js";

// ── Result type ──────────────────────────────────────────────────

export interface SideCallResult {
	text: string;
	model?: string;
	effort?: Thinking;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

interface SideCallDetails {
	advisorModel?: string;
	effort?: Thinking;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	errorCause?: unknown;
}

// ── Plan review system prompt ────────────────────────────────────

const PLAN_REVIEW_SYSTEM_PROMPT = `
# Plan Review Advisor

You are reviewing a software implementation plan. You receive the full plan text
plus any relevant conversation summary and key file snippets. You have NO tools —
produce a single structured text response.

## Your Job

Review the plan independently. Do NOT trust any summary or claim in the context —
read the actual plan content provided below.

### Spec Compliance First
- Does the plan cover the stated goal?
- Does it add anything NOT requested? (Feature creep / over-engineering)
- Does it miss any implicit or explicit requirements?

### Feasibility & Fit
- Does the approach fit the existing project structure and style?
- Does it bypass existing mechanisms or patterns — and if so, is that justified?
- Are new dependencies needed? Are they well-justified and minimal?
- Are there compatibility, configuration, API, data-migration, or security risks?

### Execution Readiness
- Are the todo items small enough for incremental implementation (2-5 min each)?
- Is each todo actionable (exact file paths, concrete steps)?
- Does the test plan prove core behavior for each todo?
- Are risks and rollback points identified?

## Output Format

Produce your review using this structure:

## 审查结果

### Critical
- C1: [问题描述] → [建议修订]

### Important
- I1: [问题描述] → [建议修订]

### Minor
- M1: [问题描述] → [建议修订]

### Summary
整体评估：[一段话总结]

## Rules
- Do NOT fabricate issues to seem thorough. Only flag genuine concerns.
- Did not read the plan → cannot produce a valid review.
- Each issue must have a concrete description and a suggested revision.
- If there are no issues in a severity level, leave that section empty (do not fabricate).
`;

// ── File path extraction ─────────────────────────────────────────

/** Regex patterns to extract file paths from plan markdown. */
const FILE_PATH_PATTERNS = [
	// "Files / Areas to Change" section: lines like `- src/foo.ts` or `1. src/foo.ts`
	/^[-*\d.]+\s+(`[^`]+`|[^\s]+\.[a-z]+)\s*$/gm,
	// Inline code references: `src/foo.ts`
	/`([^`]+\.[a-z]+)`/g,
	// Generic path-like strings: src/foo/bar.ts
	/(?:src|lib|test|tests|pkg|cmd|internal|extensions|scripts|docs)\/[\w./-]+\.[a-z]+/g,
];

/** Max lines per file snippet. */
const MAX_SNIPPET_LINES = 40;

/** Max total file snippets to include. */
const MAX_SNIPPET_FILES = 5;

/**
 * Extract referenced file paths from plan markdown and read key snippets.
 * Returns a formatted string ready to inject into the prompt.
 */
export function extractFileSnippets(planMarkdown: string, cwd: string): string {
	const filePaths = new Set<string>();

	for (const pattern of FILE_PATH_PATTERNS) {
		const matches = planMarkdown.matchAll(
			pattern instanceof RegExp && pattern.global
				? pattern
				: new RegExp(pattern.source, pattern.flags),
		);
		for (const match of matches) {
			const raw = match[1] ?? match[0];
			// Strip markdown formatting
			const cleaned = raw
				.replace(/^[-*\d.]+\s+/, "")
				.replace(/^`|`$/g, "")
				.trim();
			if (cleaned && /\.[a-z]+$/.test(cleaned)) {
				filePaths.add(cleaned);
			}
		}
	}

	const snippets: string[] = [];
	const includedFiles: string[] = [];

	for (const filePath of filePaths) {
		if (includedFiles.length >= MAX_SNIPPET_FILES) break;

		const resolved = path.resolve(cwd, filePath);
		// Safety: only read files inside cwd
		const rel = path.relative(cwd, resolved);
		if (rel.startsWith("..") || rel === "") continue;

		try {
			if (!fs.existsSync(resolved)) continue;
			const content = fs.readFileSync(resolved, "utf-8");
			const lines = content.split("\n").slice(0, MAX_SNIPPET_LINES);
			snippets.push(`### ${filePath}\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
			includedFiles.push(filePath);
		} catch {
			// Skip unreadable files
		}
	}

	if (snippets.length === 0) return "";
	return `\n# Key File Snippets (auto-extracted from plan)\n\n${snippets.join("\n\n")}`;
}

// ── Conversation summary extraction ──────────────────────────────

/**
 * Extract a concise conversation summary from the session context.
 * This gives the plan reviewer awareness of user requirements and
 * decisions discussed, without forwarding the entire conversation.
 *
 * Currently returns an empty string — conversation summary injection
 * will be implemented when ctx.sessionManager provides a suitable
 * summary API. The infrastructure is here for future enhancement.
 */
export function extractConversationSummary(_ctx: ExtensionContext): string {
	// TODO: Extract key decisions and user constraints from session context.
	// Could use ctx.sessionManager.getEntries() to identify user messages
	// that contain requirements, constraints, or design decisions.
	return "";
}

// ── Tool inventory ───────────────────────────────────────────────

/**
 * Build a concise tool inventory section so the reviewer can judge
 * whether the executor's planned tool usage is reasonable.
 */
export function buildToolInventory(pi: ExtensionAPI): string {
	try {
		const tools = pi.getAllTools();
		if (!tools || tools.length === 0) return "";

		const names: string[] = [];
		for (const tool of tools) {
			if (typeof tool === "string") names.push(tool);
			else if (tool && typeof tool.name === "string") names.push(tool.name);
		}

		if (names.length === 0) return "";
		return `\n# Executor Tool Inventory\n\nThe executor model has access to these tools: ${names.join(", ")}`;
	} catch {
		return "";
	}
}

// ── Main sidecall ─────────────────────────────────────────────────

/**
 * Execute a plan review via completeSimple — single LLM call with
 * curated context, no tools, no subprocess.
 */
export async function executePlanReviewSidecall(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	opts: {
		planMarkdown: string;
		/** Optional: conversation summary (currently empty, future enhancement). */
		conversationSummary?: string;
		/** Optional: additional context from executor (e.g. user constraints). */
		extraContext?: string;
		modelSpec: ModelSpec;
		signal?: AbortSignal;
	},
): Promise<AgentToolResult<SideCallDetails>> {
	const effort = opts.modelSpec.thinking;
	const advisorLabel = `${opts.modelSpec.provider}/${opts.modelSpec.model}`;

	// Build curated context sections
	const fileSnippets = extractFileSnippets(opts.planMarkdown, ctx.cwd);
	const conversationSummary =
		opts.conversationSummary ?? extractConversationSummary(ctx);
	const toolInventory = buildToolInventory(pi);

	// Assemble system prompt with dynamic context
	let systemPrompt = PLAN_REVIEW_SYSTEM_PROMPT;
	if (conversationSummary) {
		systemPrompt += `\n\n# Conversation Summary\n\n${conversationSummary}`;
	}
	if (toolInventory) {
		systemPrompt += toolInventory;
	}

	// Build user message: plan content + file snippets + extra context
	let userContent = opts.planMarkdown;
	if (fileSnippets) {
		userContent += `\n\n${fileSnippets}`;
	}
	if (opts.extraContext) {
		userContent += `\n\n# Additional Context\n${opts.extraContext}`;
	}

	// Build Context object: system prompt goes in Context.systemPrompt,
	// not as a Message with "system" role (pi-ai Message only supports user/assistant/toolResult).
	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
	};

	// Find the model from the registry (needed for completeSimple's Model<TApi> parameter).
	const model = (ctx as any).modelRegistry?.find(
		opts.modelSpec.provider,
		opts.modelSpec.model,
	);
	if (!model) {
		return {
			content: [
				{ type: "text", text: `Plan review model not found: ${advisorLabel}` },
			],
			details: {
				advisorModel: advisorLabel,
				effort,
				errorMessage: "model_not_found",
			},
		};
	}

	// Convert Thinking to ThinkingLevel: "off" means no reasoning.
	const thinkingLevel: ThinkingLevel | undefined =
		effort && effort !== "off"
			? (effort as unknown as ThinkingLevel)
			: undefined;

	try {
		// completeSimple(model, context, options) — not an options bag.
		const response = await completeSimple(model, context, {
			reasoning: thinkingLevel,
			signal: opts.signal,
		});

		// AssistantMessage.content is (TextContent | ThinkingContent | ToolCall)[] —
		// extract text from TextContent blocks.
		const text = response.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("");

		const resultText = text || "(no text output returned by plan review model)";

		return {
			content: [{ type: "text", text: resultText }],
			details: {
				advisorModel: advisorLabel,
				effort,
				usage: response.usage,
				stopReason: response.stopReason,
			},
		};
	} catch (err: any) {
		const message = err instanceof Error ? err.message : String(err);
		const cause =
			err instanceof Error && (err as Error & { cause?: unknown }).cause
				? `\nCause: ${String((err as Error & { cause?: unknown }).cause)}`
				: "";
		return {
			content: [
				{
					type: "text",
					text: `Plan review sidecall error: ${message}${cause}\n\nModel: ${advisorLabel}\nThinking: ${effort ?? "off"}`,
				},
			],
			details: {
				advisorModel: advisorLabel,
				effort,
				errorMessage: message,
				errorCause: (err as any)?.cause ?? undefined,
			},
		};
	}
}
