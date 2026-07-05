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

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);
