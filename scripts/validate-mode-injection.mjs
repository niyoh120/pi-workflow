#!/usr/bin/env node
/**
 * Regression validation: workflow mode prompt injection.
 *
 * Validates the post-0.81.1 architecture:
 * - COMMON_PROMPT stays system-level (appended in before_agent_start).
 * - Mutable mode prompt/state are injected per-provider-request through the
 *   `context` event as one ephemeral hidden workflow-mode custom message.
 * - before_agent_start only calibrates the model role; it must not call
 *   setActiveTools or persist mode custom messages.
 * - Plan approval sends a short follow-up kickoff; the next context event
 *   delivers the authoritative Work Mode state.
 *
 * Run: node scripts/validate-mode-injection.mjs
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

let runs = 0;
let failures = 0;

function read(rel) {
	return fs.readFileSync(path.join(root, rel), "utf8");
}

function assert(condition, msg) {
	runs++;
	if (condition) {
		console.log(`  PASS: ${msg}`);
		return;
	}
	failures++;
	console.error(`  FAIL: ${msg}`);
}

const helpers = read("extensions/workflow/helpers.ts");
const commands = read("extensions/workflow/commands.ts");
const tools = read("extensions/workflow/tools.ts");
const prompts = read("extensions/workflow/prompts.ts");
const mode = read("extensions/workflow/mode.ts");
const index = read("extensions/workflow/index.ts");
const sidecall = read("extensions/workflow/sidecall.ts");
const guards = read("extensions/workflow/guards.ts");

console.log("Mode injection regression validation");

// ── helpers.ts: shared mode-body builder ───────────────────────────────────
assert(
	helpers.includes("export function buildModeMessageBody"),
	"helpers exports buildModeMessageBody",
);
assert(
	!helpers.includes("export function buildWorkflowModeMessage"),
	"helpers no longer exports the persisted buildWorkflowModeMessage wrapper",
);
assert(
	helpers.includes('"# Current Workflow State"'),
	"mode message includes current workflow state header",
);

// ── prompts.ts: prompt-only and simplified ─────────────────────────────────
assert(
	!prompts.includes("currentStatusText") && !prompts.includes("buildModeMessageBody"),
	"prompts.ts remains prompt-only and does not import helper state builders",
);
assert(
	!prompts.includes("WORK_HANDOFF_RUNTIME_NOTICE"),
	"prompts.ts no longer carries the stale Work Mode runtime handoff notice",
);

// COMMON_PROMPT keeps durable workflow rules
assert(
	prompts.includes("用户是最终决策者"),
	"COMMON_PROMPT keeps user as final decision maker",
);
assert(
	/工作流状态.*workflow_\* 工具访问/.test(prompts) &&
		prompts.includes("禁止直接读写 .pi/workflow/"),
	"COMMON_PROMPT keeps .pi/workflow tool-only access rule without exclusive wording",
);
assert(
	prompts.includes("扩展注入的最新 workflow-mode 上下文定义当前模式"),
	"COMMON_PROMPT declares latest workflow-mode context as authoritative for all active tools",
);
assert(
	prompts.includes("其职责和权限适用于所有已启用工具"),
	"COMMON_PROMPT applies mode boundaries to built-in, extension, MCP, and remote tools",
);

// Per-mode prompt protocol checks
assert(
	/EXPLORE_PROMPT[\s\S]*?项目文件只读/.test(prompts),
	"EXPLORE_PROMPT keeps read-only project files protocol",
);
assert(
	/PLAN_PROMPT[\s\S]*?workflow_grill_record/.test(prompts),
	"PLAN_PROMPT keeps grilling record protocol",
);
assert(
	/PLAN_PROMPT[\s\S]*?相关且互不依赖的问题可以通过 ask_user_question 一次提出/.test(prompts),
	"PLAN_PROMPT allows grouped independent clarification questions",
);
assert(
	/PLAN_PROMPT[\s\S]*?数量最少且可独立验证的可执行 todo/.test(prompts),
	"PLAN_PROMPT replaces fixed todo count with minimal verifiable set",
);
assert(
	!/3-8 个可执行 todo/.test(prompts),
	"PLAN_PROMPT drops the old fixed 3-8 todo count",
);
assert(
	/PLAN_PROMPT[\s\S]*?Critical\/Important 问题导致方案发生实质修改时重新调用/.test(prompts),
	"PLAN_PROMPT gates plan-review reruns on material changes",
);
assert(
	!/2-3 轮/.test(prompts),
	"PLAN_PROMPT drops the mandatory 2-3 round reviewer debate",
);
assert(
	/PLAN_PROMPT[\s\S]*?workflow_plan_approve/.test(prompts),
	"PLAN_PROMPT keeps approval handoff protocol",
);
assert(
	/WORK_PROMPT[\s\S]*?workflow_plan_read/.test(prompts),
	"WORK_PROMPT keeps plan read protocol",
);
assert(
	/WORK_PROMPT[\s\S]*?实际依赖推进/.test(prompts),
	"WORK_PROMPT keeps dependency-aware todo ordering",
);
assert(
	/COMMIT_PROMPT[\s\S]*?提交规范缺失或不清楚时/.test(prompts),
	"COMMIT_PROMPT gates git log inspection on missing/unclear conventions",
);
assert(
	!/COMMIT_PROMPT[\s\S]*?如有历史 commit.*执行 git log --oneline -20 学习/.test(prompts),
	"COMMIT_PROMPT no longer unconditionally requires git log --oneline -20",
);
assert(
	/INIT_PROMPT[\s\S]*?workflow_init_complete/.test(prompts),
	"INIT_PROMPT keeps lifecycle close protocol",
);

// ── commands.ts: before_agent_start is prompt-only / role-only ─────────────
assert(
	/systemPrompt:\s*event\.systemPrompt\s*\+\s*["']\\n\\n["']\s*\+\s*COMMON_PROMPT/.test(
		commands,
	),
	"before_agent_start returns COMMON_PROMPT in system prompt",
);
const beforeAgentStartBody =
	commands.match(/registerBeforeAgentStart[\s\S]*?pi\.on\("before_agent_start"[\s\S]*?\n\}\)?;?\s*\n/)?.[0] ?? "";
assert(
	beforeAgentStartBody.length > 0,
	"registerBeforeAgentStart body was extracted (function exists and regex matched)",
);
assert(
	!/\bapplyModeRuntime\s*\(/.test(beforeAgentStartBody),
	"before_agent_start no longer calls applyModeRuntime directly",
);
assert(
	/setRole\(\s*pi,\s*ctx,\s*modeRole\(state\.mode\)/.test(beforeAgentStartBody),
	"before_agent_start only recalibrates the configured model role",
);
assert(
	beforeAgentStartBody.includes("activateWorkflowToolsIfAllowed"),
	"before_agent_start reconciles workflow tools as a session_start safety net",
);
assert(
	!/const\s+message\s*=\s*buildWorkflowModeMessage/.test(commands),
	"before_agent_start no longer persists workflow mode custom messages",
);
assert(
	!commands.includes("promptForMode(state.mode)"),
	"commands no longer inlines mode prompt into system prompt",
);

// ── commands.ts: context event injects latest mode ─────────────────────────
assert(
	/registerWorkflowContextInjection[\s\S]*?pi\.on\("context"/.test(commands),
	"registerWorkflowContextInjection subscribes to the context event",
);
assert(
	/customType === "workflow-mode"/.test(commands),
	"context handler filters historical workflow-mode messages",
);
assert(
	/customType: "workflow-mode"[\s\S]*?display: false/.test(commands),
	"context handler appends one hidden workflow-mode custom message",
);
assert(
	/messages\.push\({[\s\S]*?return \{ messages \}/.test(commands) &&
		/event\.messages\.filter/.test(commands),
	"context handler filters event.messages into a new array and returns it (does not mutate in place)",
);
assert(
	/context injection failed[\s\S]*?return \{ messages: event\.messages \}/.test(commands),
	"context handler catch returns original event.messages so failures don't strip mode context",
);

// ── mode.ts: tool ownership invariants ─────────────────────────────────────
assert(
	!/allTools\.some[\s\S]*?ask_user_question|next\.add\("ask_user_question"\)/.test(
		mode,
	),
	"mode.ts drops the ask_user_question special auto-activation block",
);
assert(
	mode.includes("EXPLORE_WORKFLOW_TOOL_NAMES"),
	"mode.ts exposes read-only workflow_plan_read in Explore Mode",
);
assert(
	/sameMembers/.test(mode),
	"mode.ts short-circuits setActiveTools when the workflow tool set is unchanged",
);

// ── tools.ts: plan approval uses short kickoff, no handoff notice ──────────
assert(
	!tools.includes("WORK_HANDOFF_RUNTIME_NOTICE"),
	"plan approval no longer imports WORK_HANDOFF_RUNTIME_NOTICE",
);
assert(
	tools.includes("workflow_plan_read 读取计划和当前 workflow_todo 列表"),
	"plan approval followUp is a short kickoff pointing to plan/todo tools",
);
assert(
	tools.includes("Do not call any more tools in this turn."),
	"plan approve still terminates current tool turn explicitly",
);

// ── index.ts: single ordered session_start path ────────────────────────────
const sessionStartBody =
	index.match(/registerWorkflowSessionStart[\s\S]*?\n\}\)?;?\s*\n/)?.[0] ?? "";
assert(
	sessionStartBody.length > 0,
	"registerWorkflowSessionStart body was extracted (function exists and regex matched)",
);
assert(
	/registerWorkflowSessionStart[\s\S]*?pi\.on\("session_start"/.test(index),
	"index.ts has a unified session_start handler",
);
assert(
	/session_start[\s\S]*?ensureWorkflowRegistered[\s\S]*?(applyModeRuntime|transitionWorkflowMode)/.test(
		sessionStartBody,
	),
	"registerWorkflowSessionStart registers tools before applying mode runtime",
);
assert(
	index.includes("registerWorkflowContextInjection"),
	"index.ts registers the context injection handler",
);
assert(
	/session_start[\s\S]*?console\.error\(`\[workflow\] session_start initialization failed/.test(
		sessionStartBody,
	),
	"session_start surfaces initialization failures via console.error",
);

// ── sidecall.ts / guards.ts: API migration invariants ───────────────────────
assert(
	!/\bcompleteSimple\s*\(/.test(sidecall) &&
		!/import[\s\S]*?completeSimple/.test(sidecall),
	"sidecall.ts no longer imports or calls the removed completeSimple API",
);
assert(
	/await\s+provider\.streamSimple\([\s\S]*?\)\.result\(\)/.test(sidecall),
	"sidecall.ts chains provider.streamSimple(...).result() at a real call site",
);
assert(
	!/^(?:\s*export\s+function|\s*function)\s+isLocalFileMutatingShell/m.test(guards) &&
		!/\bisLocalFileMutatingShell\s*\(/.test(
			guards.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
		),
	"guards.ts no longer declares or calls isLocalFileMutatingShell",
);

// Exhaustive mode dispatch (closed Mode unions)
assert(
	/export function assertNever[\s\S]*?value: never/.test(helpers),
	"helpers.ts: exports assertNever",
);
assert(
	/promptForMode[\s\S]*?switch[\s\S]*?default:[\s\S]*?assertNever/.test(prompts),
	"prompts.ts: promptForMode dispatch is exhaustive",
);
assert(
	/modeLabel[\s\S]*?switch[\s\S]*?default:[\s\S]*?assertNever/.test(helpers),
	"helpers.ts: modeLabel dispatch is exhaustive",
);
assert(
	/modeStatusLabel[\s\S]*?switch[\s\S]*?default:[\s\S]*?assertNever/.test(helpers),
	"helpers.ts: modeStatusLabel dispatch is exhaustive",
);

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);
