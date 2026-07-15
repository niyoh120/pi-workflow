#!/usr/bin/env node
/**
 * Regression validation: workflow mode prompt injection.
 *
 * Ensures mutable mode instructions live in custom messages/tool results,
 * not in the per-turn system prompt that stays stale during follow-up drains.
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

console.log("Mode injection regression validation");

assert(
	helpers.includes("export function buildModeMessageBody"),
	"helpers exports buildModeMessageBody",
);
assert(
	helpers.includes("export function buildWorkflowModeMessage"),
	"helpers exports buildWorkflowModeMessage",
);
assert(
	helpers.includes('customType: "workflow-mode"'),
	"workflow mode message uses customType=workflow-mode",
);
assert(
	helpers.includes('display: false'),
	"workflow mode message is hidden from UI",
);
assert(
	helpers.includes('"# Current Workflow State"'),
	"mode message includes current workflow state header",
);

assert(
	!prompts.includes("currentStatusText") && !prompts.includes("buildModeMessageBody"),
	"prompts.ts remains prompt-only and does not import helper state builders",
);
assert(
	prompts.includes("覆盖此前对 Plan Mode 的描述"),
	"handoff notice explicitly overrides stale Plan Mode description",
);

assert(
	/const\s+systemPrompt\s*=\s*event\.systemPrompt\s*\+\s*["']\\n\\n["']\s*\+\s*COMMON_PROMPT/.test(
		commands,
	),
	"before_agent_start keeps only COMMON_PROMPT in system prompt",
);
assert(
	/const\s+message\s*=\s*buildWorkflowModeMessage\(\s*state\.mode\s*,\s*state\s*\)/.test(
		commands,
	),
	"before_agent_start builds workflow mode custom message",
);
assert(
	/if\s*\(\s*!message\s*\)\s*return\s*\{\s*systemPrompt\s*\}/.test(
		commands,
	),
	"idle/no-mode branch injects no workflow mode message",
);
assert(
	!commands.includes("promptForMode(state.mode)"),
	"commands no longer inlines mode prompt into system prompt",
);

assert(
	tools.includes("buildModeMessageBody(\"work\", result.state)"),
	"plan approve builds Work Mode body from shared helper",
);
assert(
	tools.includes("handoffMessage +"),
	"plan approve tool result includes handoff message as same-turn fallback",
);
assert(
	tools.includes("Do not call any more tools in this turn."),
	"plan approve still terminates current tool turn explicitly",
);

// Exhaustive mode dispatch (T1: assertNever guards closed Mode unions)
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

// Trimmed COMMON_PROMPT: generic engineering guidance removed
assert(
	!/不要扩大范围|最小可行|避免过度设计|不要重新设计|严重级别|reviewer 的意见/.test(prompts),
	"COMMON_PROMPT no longer embeds scope/style/reviewer guidance",
);
assert(
	/prompts.ts/.test("prompts.ts") && prompts.includes("用户是最终决策者"),
	"COMMON_PROMPT keeps user as final decision maker",
);
assert(
	prompts.includes("只能使用 workflow_* 工具访问工作流状态"),
	"COMMON_PROMPT keeps .pi/workflow tool-only access rule",
);

// Protocol-level checks per mode prompt
assert(
	/EXPLORE_PROMPT[\s\S]*?项目文件只读/.test(prompts),
	"EXPLORE_PROMPT keeps read-only project files protocol",
);
assert(
	/PLAN_PROMPT[\s\S]*?workflow_grill_record/.test(prompts),
	"PLAN_PROMPT keeps grilling record protocol",
);
assert(
	/PLAN_PROMPT[\s\S]*?讨论是否充分/.test(prompts),
	"PLAN_PROMPT keeps pre-save discussion-sufficiency gate",
);
assert(
	/PLAN_PROMPT[\s\S]*?workflow_plan_review/.test(prompts),
	"PLAN_PROMPT keeps optional Plan Review tool protocol",
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
	/WORK_PROMPT[\s\S]*?workflow_todo/.test(prompts),
	"WORK_PROMPT keeps todo protocol",
);
assert(
	/COMMIT_PROMPT[\s\S]*?git log --oneline -20/.test(prompts),
	"COMMIT_PROMPT keeps project history learning protocol",
);
assert(
	/INIT_PROMPT[\s\S]*?workflow_init_complete/.test(prompts),
	"INIT_PROMPT keeps lifecycle close protocol",
);
assert(
	prompts.includes("覆盖此前对 Plan Mode 的描述"),
	"WORK_HANDOFF_RUNTIME_NOTICE keeps authoritative override semantics",
);

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);
