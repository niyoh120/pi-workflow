#!/usr/bin/env node
/**
 * Focused validation: per-role contextWindow override.
 *
 * Three behavior groups from the approved plan:
 *
 *  1. Pure numeric/parse/validate/clone semantics (model-context.ts):
 *     strict UI parse, boundary validation (equality, above baseline,
 *     dynamic lower bound, non-number), clone isolation of the registry
 *     object, apply-error diagnostics.
 *  2. Main runtime: setRole applies the validated clone (registry untouched,
 *     provider/auth preserved) and rejects invalid values without touching
 *     the model; restoreModeRuntime is idempotent (zero redundant setModel in
 *     steady state, thinking preserved, ownership bookkeeping), release
 *     restores only the matching active clone; the real in-repo dependency
 *     clamp path (pi-ai clampMaxTokensToContext/buildBaseOptions) proves a
 *     smaller window tightens the request maxTokens while the model's
 *     declared maxTokens stays unchanged.
 *  3. Reviewer/cache: prepareReviewerModelPlan resolves the model via the
 *     child priority, applies the validated clone, and builds the context
 *     basis from ONE SettingsManager whose project trust follows the parent
 *     (untrusted project ⇒ global/default compaction values — the documented
 *     tightening); the basis feeds both reviewer hash builders (covered for
 *     plan-review basis + implementation task-input in
 *     validate-plan-review-agent.mjs).
 *
 * Run: node scripts/validate-model-context.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

/** Extract a top-level declaration by anchor up to a column-0 closing line. */
function extractDecl(src, anchor) {
	const start = src.indexOf(anchor);
	if (start < 0) return "";
	const lines = src.slice(start).split("\n");
	const out = [];
	for (const line of lines) {
		out.push(line);
		if (line === "}") break;
	}
	return out.join("\n");
}


/**
 * Copy extensions/workflow into a temp dir with every relative `.js` import
 * specifier rewritten to the real `.ts` file, then import `entry` (e.g.
 * "mode.ts" / "plan-review-agent.ts" / "state.ts"). This loads the REAL
 * module closure (config/state/model-context/...) under Node type stripping
 * while bare specifiers (@earendil-works/*, typebox) resolve against
 * node_modules. Returns the loaded module namespace.
 */
const workflowRewriteDirs = [];
async function loadWorkflowModule(entry) {
	// Under the REPO root so bare specifiers resolve against node_modules.
	const tmp = fs.mkdtempSync(path.join(root, ".model-context-mod-"));
	const dest = path.join(tmp, "workflow");
	fs.cpSync(path.join(root, "extensions", "workflow"), dest, { recursive: true });
	workflowRewriteDirs.push(tmp);
	for (const file of fs.readdirSync(dest).filter((f) => f.endsWith(".ts"))) {
		const p = path.join(dest, file);
		const text = fs.readFileSync(p, "utf8");
		fs.writeFileSync(
			p,
			text.replace(/(from\s+")(\.\/[^"\n]+)\.js"/g, "$1$2.ts\""),
		);
	}
	const mod = await import(pathToFileURL(path.join(dest, entry)).href + "?t=" + Date.now());
	return mod;
}

console.log("model-context: per-role contextWindow validation");

// Clean up rewrite temp dirs even on unexpected early exit.
process.on("exit", () => {
	for (const d of fs.readdirSync(root).filter((f) => f.startsWith(".model-context-"))) {
		try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

const modelContextTs = read("extensions/workflow/model-context.ts");
const modeTs = read("extensions/workflow/mode.ts");
const typesTs = read("extensions/workflow/types.ts");
const configTs = read("extensions/workflow/config.ts");
const commandsTs = read("extensions/workflow/commands.ts");
const indexTs = read("extensions/workflow/index.ts");
const settingsTs = read("extensions/workflow/settings.ts");
const toolsTs = read("extensions/workflow/tools.ts");
const praTs = read("extensions/workflow/plan-review-agent.ts");
const reviewAgentTs = read("extensions/workflow/review-agent.ts");

// ── Source-level contract ─────────────────────────────────────────────────

console.log("\n=== S: source wiring ===");
{
	assert(
		/contextWindow\?: number;/.test(typesTs),
		"ModelSpec declares optional contextWindow?: number",
	);
	assert(
		/"contextWindow" in m \? \{ contextWindow: m\.contextWindow \} : \{\}/.test(configTs),
		"normalizeConfig preserves contextWindow verbatim (incl. invalid values)",
	);
	assert(
		/`models\.\$\{role\}\.contextWindow`/.test(configTs),
		"resolveConfigSources maps models.<role>.contextWindow",
	);
	assert(
		/reconcileContextWindowForSession/.test(commandsTs) &&
			/"model_select"/.test(commandsTs) &&
			/"session_tree"/.test(commandsTs),
		"commands.ts registers model_select/session_tree window reconcile",
	);
	assert(
		/clearContextWindowOwnership/.test(indexTs),
		"index.ts clears window ownership on session_shutdown",
	);
	assert(
		/releaseContextWindowOverride/.test(commandsTs),
		"/workflow:disable and /workflow:reset release the window override",
	);
	assert(
		/prepareReviewerModelPlan/.test(toolsTs) &&
			toolsTs.indexOf("prepareReviewerModelPlan") <
				toolsTs.indexOf("decidePlanReviewMode") &&
			toolsTs.indexOf("prepareReviewerModelPlan") <
				toolsTs.indexOf("loadReviewHistory"),
		"tools.ts prepares the reviewer model plan BEFORE the cache decisions",
	);
	assert(
		/reviewerContext: prepared\.contextBasis/.test(toolsTs),
		"tools.ts feeds the prepared context basis into the review hashes",
	);
	assert(
		/runIndependentReviewer\(\{[\s\S]*?prepared,/.test(praTs),
		"shared runner consumes the prepared reviewer model snapshot",
	);
	assert(
		/settingsManager,/.test(praTs) &&
			/createAgentSession\(\{[\s\S]*?settingsManager/.test(praTs.slice(praTs.indexOf("const { session } = await createAgentSession"))),
		"the prepared SettingsManager feeds both DefaultResourceLoader and createAgentSession",
	);
	assert(
		/"contextWindow"/.test(settingsTs) && /parseContextWindowInput/.test(settingsTs),
		"settings editor exposes contextWindow rows with strict parsing",
	);
	assert(
		/reviewerContext\?/.test(read("extensions/workflow/review-history.ts")),
		"computeTaskInputHash accepts the structured reviewer context basis",
	);
}

// ── Part 1: pure parse/validate/clone ─────────────────────────────────────

console.log("\n=== 1: pure parse/validate/clone semantics ===");

const pureMod = await loadWorkflowModule("model-context.ts");
const COMPACTION = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
};

{
	// Strict UI parse.
	const ok = pureMod.parseContextWindowInput(" 120000 ");
	assert(ok.ok === true && ok.value === 120_000, "parse accepts a decimal integer (trims whitespace)");
	assert(pureMod.parseContextWindowInput("0").ok === true, "parse accepts 0 digits (validation rejects the value later)");

	for (const bad of ["", "  ", "-5", "1.5", "1e5", "12x", "x12", "0x10", "NaN", "Infinity", "1 2", "+5", "٩", "1_000", "900719925474099300000"]) {
		const res = pureMod.parseContextWindowInput(bad);
		assert(res.ok === false, `parse rejects ${JSON.stringify(bad)}`);
	}

	// Boundary validation against baseline 200000.
	const V = (value) =>
		pureMod.validateContextWindowValue(value, 200_000, COMPACTION);
	assert(V(120_000).ok === true, "120000 within (36384, 200000) is valid");
	assert(V(36_385).ok === true, "lower bound is exclusive: reserve+keepRecent+1 is valid");
	assert(V(36_384).ok === false, "value equal to reserve+keepRecent is rejected");
	assert(V(199_999).ok === true, "upper bound is exclusive: baseline-1 is valid");
	assert(V(200_000).ok === false, "value EQUAL to the Pi baseline is rejected (strictly less)");
	assert(V(250_000).ok === false, "value above the Pi baseline is rejected");
	assert(V(0).ok === false && V(-1).ok === false, "non-positive values are rejected");
	assert(V(1.5).ok === false, "non-integer numbers are rejected");
	assert(V("120000").ok === false, "string values are rejected (JSON accepts number only)");
	assert(V(Number.MAX_SAFE_INTEGER + 1).ok === false, "beyond-safe-integer values are rejected");
	assert(V(null).ok === false && V(undefined).ok === false && V({}).ok === false, "null/undefined/object values are rejected");

	// Dynamic lower bound follows the compaction snapshot.
	const VBig = (value) =>
		pureMod.validateContextWindowValue(value, 1_000_000, {
			enabled: false,
			reserveTokens: 50_000,
			keepRecentTokens: 30_000,
		});
	assert(VBig(80_001).ok === true, "dynamic lower bound uses reserve+keepRecent");
	assert(VBig(80_000).ok === false, "dynamic lower bound is exclusive even with compaction disabled");
	assert(
		V(120_000).ok === true &&
			pureMod.validateContextWindowValue(120_000, 200_000, {
				enabled: true,
				reserveTokens: Number.NaN,
				keepRecentTokens: 20_000,
			}).ok === false,
		"invalid compaction snapshot numbers are rejected (no silent defaults)",
	);

	// Clone isolation.
	const registryModel = {
		provider: "anthropic",
		id: "claude-opus-4-5",
		api: "anthropic-messages",
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 1, output: 2 },
		compat: { cache: true },
	};
	const cloned = pureMod.cloneModelWithContextWindow(registryModel, 150_000);
	assert(cloned !== registryModel, "clone returns a new object");
	assert(cloned.contextWindow === 150_000, "clone carries the overridden window");
	assert(registryModel.contextWindow === 200_000, "registry object window is untouched");
	assert(
		cloned.provider === registryModel.provider &&
			cloned.id === registryModel.id &&
			cloned.api === registryModel.api &&
			cloned.maxTokens === registryModel.maxTokens &&
			cloned.cost === registryModel.cost &&
			cloned.compat === registryModel.compat,
		"clone preserves provider/id/api/maxTokens/cost/compat fields",
	);

	// prepareModelWithContextWindow combines validation + clone.
	const prep = pureMod.prepareModelWithContextWindow(registryModel, 150_000, COMPACTION);
	assert(prep.ok === true && prep.model.contextWindow === 150_000, "prepareModelWithContextWindow applies a valid window");
	assert(prep.originalWindow === 200_000 && prep.appliedWindow === 150_000, "prepare records original + applied windows");
	const prepBad = pureMod.prepareModelWithContextWindow(registryModel, 250_000, COMPACTION);
	assert(prepBad.ok === false && /严格小于/.test(prepBad.error), "prepareModelWithContextWindow rejects an above-baseline window with a clear reason");

	// Apply-error diagnostics carry role/model/input/range/fix.
	const msg = pureMod.buildContextWindowApplyError({
		role: "plan",
		provider: "anthropic",
		model: "claude-opus-4-5",
		rawValue: 250_000,
		reason: prepBad.error,
		baselineWindow: 200_000,
		compaction: COMPACTION,
	});
	assert(
		msg.includes("models.plan.contextWindow") &&
			msg.includes("anthropic/claude-opus-4-5") &&
			msg.includes("250000") &&
			msg.includes("36385 ~ 199999") &&
			msg.includes("清除"),
		"apply error names the field, model, input value, range, and the clear-to-inherit fix",
	);

	// Range formatting + basis serialization.
	assert(
		pureMod.formatContextWindowRange(200_000, COMPACTION) === "36385 ~ 199999 tokens (both ends exclusive)",
		"range formatting shows the exclusive bounds",
	);
	const basis = pureMod.serializeReviewerContextBasis({
		piBaseline: 200_000,
		effective: 150_000,
		compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
	});
	assert(
		!("configured" in basis) &&
			basis.piBaseline === 200_000 &&
			basis.effective === 150_000 &&
			JSON.stringify(basis.compaction) ===
				JSON.stringify({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }),
		"serializeReviewerContextBasis omits configured when unset and flattens compaction",
	);
	assert(
		"configured" in pureMod.serializeReviewerContextBasis({ configured: 150_000, piBaseline: 200_000, effective: 150_000, compaction: COMPACTION }),
		"serializeReviewerContextBasis includes configured when an override exists",
	);
}

// ── Part 1b: settings candidate merge + shared validation (real module) ──

console.log("\n=== 1b: settings candidate merge + shared validation ===");
{
	const settingsMod = await loadWorkflowModule("settings.ts");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mc-settings-"));
	const scwd = path.join(tmp, "project");
	const sAgent = path.join(tmp, "agent");
	try {
		// Global: plan model = claude-opus-4-5 (window 200000), window 150000.
		fs.mkdirSync(path.join(sAgent, "workflow"), { recursive: true });
		fs.writeFileSync(
			path.join(sAgent, "workflow", "config.json"),
			JSON.stringify({
				models: { plan: { provider: "anthropic", model: "claude-opus-4-5", contextWindow: 150_000 } },
			}),
		);
		// Project (trusted): plan model → claude-sonnet-4-5 (window 1000000).
		fs.mkdirSync(path.join(scwd, ".pi", "workflow"), { recursive: true });
		fs.writeFileSync(
			path.join(scwd, ".pi", "workflow", "config.json"),
			JSON.stringify({
				models: { plan: { provider: "anthropic", model: "claude-sonnet-4-5" } },
			}),
		);
		// Pi global settings: default compaction bounds.
		fs.writeFileSync(
			path.join(sAgent, "settings.json"),
			JSON.stringify({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } }),
		);

		const trustedCtx = { isProjectTrusted: () => true };
		const registry = {
			find: (p, m) => {
				const models = {
					"anthropic/claude-opus-4-5": { contextWindow: 200_000 },
					"anthropic/claude-sonnet-4-5": { contextWindow: 1_000_000 },
				};
				return models[`${p}/${m}`];
			},
		};
		const compaction = { ok: true, compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } };

		// Project-scope candidate (DEFAULT ← global ← edited project): plan =
		// sonnet (baseline 1M) + RETAINED global window 150000 → valid.
		const projectCandidate = settingsMod.buildCandidateConfigUpToScope(
			"project",
			{ models: { plan: { provider: "anthropic", model: "claude-sonnet-4-5", contextWindow: 150_000 } } },
			scwd,
			sAgent,
			trustedCtx,
		);
		assert(
			projectCandidate.models.plan.provider === "anthropic" &&
				projectCandidate.models.plan.model === "claude-sonnet-4-5" &&
				projectCandidate.models.plan.contextWindow === 150_000,
			"project candidate merges global window over the edited project model",
		);
		assert(
			settingsMod.validateRoleContextWindowCandidate(projectCandidate.models.plan, registry, compaction).ok === true,
			"project-scope edit stays valid (session does not mask lower-layer editing)",
		);

		// Session-scope candidate (everything merged): project model sonnet +
		// retained global window 150000 → valid too; but if the SESSION layer
		// writes a window 150000 while overriding the model BACK to opus
		// (baseline 200000), it is still valid; a window of 500000 for opus is
		// invalid ONLY at the session candidate — proving the editing-scope merge
		// catches what a lower-layer edit would have masked.
		const sessionCandidateBad = settingsMod.buildCandidateConfigUpToScope(
			"session",
			{ models: { plan: { provider: "anthropic", model: "claude-opus-4-5", contextWindow: 500_000 } } },
			scwd,
			sAgent,
			trustedCtx,
		);
		assert(
			settingsMod.validateRoleContextWindowCandidate(sessionCandidateBad.models.plan, registry, compaction).ok === false,
			"session candidate rejects a window above the opus baseline",
		);
		// Untrusted session editing: project layer is EXCLUDED from the candidate
		// (mirrors runtime layering), so the plan model falls back to the global
		// layer's opus and the 500000 window is rejected against THAT baseline.
		const sessionCandidateUntrusted = settingsMod.buildCandidateConfigUpToScope(
			"session",
			{ models: { plan: { contextWindow: 500_000 } } },
			scwd,
			sAgent,
			{ isProjectTrusted: () => false },
		);
		assert(
			sessionCandidateUntrusted.models.plan.model === "claude-opus-4-5",
			"untrusted session candidate inherits the global model (project layer excluded)",
		);

		// No configured window → always OK (clearing stays possible), even when
		// compaction/model are unavailable.
		assert(
			settingsMod.validateRoleContextWindowCandidate({ provider: "x", model: "y" }, registry, { ok: false, error: "boom" }).ok === true,
			"no configured window validates OK regardless of compaction/model availability",
		);
		assert(
			settingsMod.validateRoleContextWindowCandidate(
				{ provider: "x", model: "y", contextWindow: 1_000 },
				registry,
				{ ok: false, error: "settings unreadable" },
			).ok === false,
			"a configured window with unreadable compaction is rejected explicitly",
		);
		assert(
			settingsMod.validateRoleContextWindowCandidate(
				{ provider: "x", model: "nope", contextWindow: 1_000 },
				registry,
				compaction,
			).ok === false &&
				/无法解析模型/.test(
					settingsMod.validateRoleContextWindowCandidate(
						{ provider: "x", model: "nope", contextWindow: 1_000 },
					registry,
					compaction,
				).error,
			),
			"an unresolvable model rejects a retained window with the fix hint",
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

// ── Part 2: main runtime apply/restore/release ────────────────────────────

console.log("\n=== 2: main runtime apply / idempotent restore / release ===");


function makeRegistryModel(overrides = {}) {
	return {
		provider: "anthropic",
		id: "claude-opus-4-5",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 200_000,
		maxTokens: 64_000,
		thinkingLevelMap: { medium: "medium" },
		...overrides,
	};
}

function makeHarness({ registryModel, projectTrusted }) {
	const setModelCalls = [];
	const thinkingCalls = [];
	let thinkingLevel = "high"; // user's manual level
	const notifications = [];
	const pi = {
		setModel: async (model) => {
			setModelCalls.push(model);
			return true;
		},
		setThinkingLevel: (level) => thinkingCalls.push(level),
		getThinkingLevel: () => thinkingLevel,
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
	const registry = { model: registryModel };
	const ctx = {
		cwd, // fixture project dir (config + Pi project settings live here)
		mode: "tui",
		sessionManager: {
			getSessionId: () => "model-context-validation",
			getSessionFile: () => null,
		},
		modelRegistry: {
			find: (provider, model) =>
				registry.model.provider === provider && registry.model.id === model
					? registry.model
					: undefined,
		},
		ui: {
			notify: (msg, kind) => notifications.push({ msg, kind }),
			setStatus: () => {},
		},
		isProjectTrusted: () => projectTrusted,
	};
	return {
		pi,
		ctx,
		get setModelCalls() {
			return setModelCalls;
		},
		get thinkingCalls() {
			return thinkingCalls;
		},
		get notifications() {
			return notifications;
		},
		set thinking(value) {
			thinkingLevel = value;
		},
		get thinking() {
			return thinkingLevel;
		},
	};
}

/** Disk fixture: workflow config (GLOBAL layer) + Pi settings (global + project).
 *  The workflow config lives in the global layer so the project-trust flag
 *  only affects the Pi settings snapshot — the semantics under test. */
function writeFixtures({ cwd, agentDir, workflowConfig, piGlobalSettings, piProjectSettings }) {
	fs.rmSync(cwd, { recursive: true, force: true });
	fs.rmSync(agentDir, { recursive: true, force: true });
	if (piProjectSettings !== undefined) {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(piProjectSettings, null, 2));
	}
	if (workflowConfig !== undefined || piGlobalSettings !== undefined) {
		fs.mkdirSync(path.join(agentDir, "workflow"), { recursive: true });
		if (workflowConfig !== undefined) {
			fs.writeFileSync(path.join(agentDir, "workflow", "config.json"), JSON.stringify(workflowConfig, null, 2));
		}
		if (piGlobalSettings !== undefined) {
			fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(piGlobalSettings, null, 2));
		}
	}
}

const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-model-context-"));
const cwd = path.join(harnessDir, "project");
const agentDir = path.join(harnessDir, "agent");
const getAgentDir = () => agentDir;
const PI_GLOBAL_SETTINGS = {
	compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
};
const PI_PROJECT_SETTINGS = {
	compaction: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 5_000 },
};

try {
	const modeMod = await loadWorkflowModule("mode.ts");

	// 2a. setRole applies the validated clone.
	{
		writeFixtures({
			cwd,
			agentDir,
			workflowConfig: { models: { plan: { contextWindow: 150_000 } } },
			piGlobalSettings: PI_GLOBAL_SETTINGS,
			piProjectSettings: PI_PROJECT_SETTINGS,
		});
		const registryModel = makeRegistryModel();
		const h = makeHarness({ registryModel, projectTrusted: false });
		const ok = await modeMod.setRole(h.pi, h.ctx, "plan", getAgentDir);
		assert(ok === true, "setRole succeeds with a valid configured window");
		assert(h.setModelCalls.length === 1, "setRole performs exactly one setModel");
		const applied = h.setModelCalls[0];
		assert(applied.contextWindow === 150_000, "setRole applies the configured window");
		assert(applied !== registryModel, "setRole applies a clone, not the registry object");
		assert(registryModel.contextWindow === 200_000, "registry model stays untouched after apply");
		assert(applied.id === registryModel.id && applied.maxTokens === registryModel.maxTokens, "applied clone preserves id/maxTokens");
		// Untrusted project ⇒ disk snapshot uses GLOBAL compaction (16384+20000),
		// so 40000 would fail; verify the boundary uses global values.
		const owned = modeMod.getContextWindowOverride("model-context-validation" /* placeholder; real key is hashed */);
		assert(owned === undefined, "ownership lookup by raw session id is undefined (key is hashed)");
	}

	// 2a-2. trust-aware disk snapshot: trusted project changes the lower bound.
	{
		// Trusted project settings reserve+keepRecent = 9096, so 150000 valid,
		// and a value of 10000 (invalid under global 36384) becomes VALID here —
		// proving the snapshot honors project trust.
		writeFixtures({
			cwd,
			agentDir,
			workflowConfig: { models: { plan: { contextWindow: 10_000 } } },
			piGlobalSettings: PI_GLOBAL_SETTINGS,
			piProjectSettings: PI_PROJECT_SETTINGS,
		});
		const hTrusted = makeHarness({ registryModel: makeRegistryModel(), projectTrusted: true });
		const okTrusted = await modeMod.setRole(hTrusted.pi, hTrusted.ctx, "plan", getAgentDir);
		assert(okTrusted === true && hTrusted.setModelCalls[0]?.contextWindow === 10_000, "trusted project compaction lowers the dynamic bound (10000 accepted)");

		const hUntrusted = makeHarness({ registryModel: makeRegistryModel(), projectTrusted: false });
		const okUntrusted = await modeMod.setRole(hUntrusted.pi, hUntrusted.ctx, "plan", getAgentDir);
		assert(okUntrusted === false && hUntrusted.setModelCalls.length === 0, "untrusted project ignores project compaction (10000 rejected under global bound)");
		assert(
			hUntrusted.notifications.some((n) => /models\.plan\.contextWindow 无效/.test(n.msg) && n.msg.includes("16384")),
			"rejection error cites the global reserve values",
		);
	}

	// 2a-3. invalid configured values never touch the model.
	for (const [value, label] of [
		[200_000, "equal to the Pi baseline"],
		[250_000, "above the Pi baseline"],
		[36_384, "at the compaction lower bound"],
		[36_383, "below the compaction lower bound"],
		["150000" /** as string */, "a string"],
		[-5, "negative"],
	]) {
		writeFixtures({
			cwd,
			agentDir,
			workflowConfig: { models: { plan: { contextWindow: value } } },
			piGlobalSettings: PI_GLOBAL_SETTINGS,
		});
		const h = makeHarness({ registryModel: makeRegistryModel(), projectTrusted: false });
		const ok = await modeMod.setRole(h.pi, h.ctx, "plan", getAgentDir);
		assert(ok === false && h.setModelCalls.length === 0, `setRole rejects a window ${label} without calling setModel`);
		assert(h.notifications.length > 0, `setRole rejection for a window ${label} surfaces a notify`);
	}

	// 2a-4. no configured window → raw registry model, no constraint.
	{
		writeFixtures({
			cwd,
			agentDir,
			workflowConfig: { models: { plan: { thinking: "high" } } },
			piGlobalSettings: PI_GLOBAL_SETTINGS,
		});
		const registryModel = makeRegistryModel();
		const h = makeHarness({ registryModel, projectTrusted: false });
		const ok = await modeMod.setRole(h.pi, h.ctx, "plan", getAgentDir);
		assert(ok === true && h.setModelCalls[0] === registryModel, "no configured window applies the raw registry model");
	}

	// 2b. restoreModeRuntime idempotence + thinking preservation.
	{
		writeFixtures({
			cwd,
			agentDir,
			workflowConfig: { models: { plan: { contextWindow: 150_000 } } },
			piGlobalSettings: PI_GLOBAL_SETTINGS,
		});
		const registryModel = makeRegistryModel();
		const h = makeHarness({ registryModel, projectTrusted: false });

		// Drifted window (e.g. manual same-id re-select restored the registry
		// object) → reconcile re-applies the clone once and restores thinking.
		h.ctx.model = makeRegistryModel(); // active model = registry window
		const ok1 = await modeMod.restoreModeRuntime(h.pi, h.ctx, "plan", getAgentDir);
		assert(ok1 === true, "restore succeeds when the window drifted");
		assert(h.setModelCalls.length === 1 && h.setModelCalls[0].contextWindow === 150_000, "drifted window is re-applied exactly once");
		assert(
			h.thinkingCalls.length >= 1 && h.thinkingCalls[h.thinkingCalls.length - 1] === "high",
			"the user's thinking level is restored after the re-apply",
		);

		// Steady state: active model already carries the window → zero setModel.
		h.ctx.model = h.setModelCalls[0];
		const ok2 = await modeMod.restoreModeRuntime(h.pi, h.ctx, "plan", getAgentDir);
		const callsAfterSecond = h.setModelCalls.length;
		assert(ok2 === true && callsAfterSecond === 1, "repeated restore performs ZERO additional setModel (no extra history entries)");

		// Manual different model → untouched.
		const manualModel = makeRegistryModel({ provider: "openai", id: "gpt-5.1", contextWindow: 400_000 });
		h.ctx.model = manualModel;
		const ok3 = await modeMod.restoreModeRuntime(h.pi, h.ctx, "plan", getAgentDir);
		assert(ok3 === true && h.setModelCalls.length === 1, "a manual model different from the role config is left untouched");
		assert(h.ctx.model === manualModel && manualModel.contextWindow === 400_000, "the manual model object is not mutated");
	}

	// 2b-2. reconcileContextWindowForSession re-establishes the window after a
	// different-model → role-model switch (the model_select path).
	{
		// Workflow must be active and the persisted mode must map to the role.
		const stateMod = await loadWorkflowModule("state.ts");
		const sessionKey = stateMod.getSessionKey({
			getSessionId: () => "model-context-validation",
			getSessionFile: () => null,
		});
		stateMod.saveState(cwd, sessionKey, {
			workflowEnabled: true,
			mode: "plan",
			todos: [],
			grillTurns: [],
			planReviewDecisions: [],
		});
		const h = makeHarness({ registryModel: makeRegistryModel(), projectTrusted: false });
		h.ctx.model = makeRegistryModel({ provider: "openai", id: "gpt-5.1" });
		await modeMod.reconcileContextWindowForSession(h.pi, h.ctx, getAgentDir);
		assert(h.setModelCalls.length === 0, "event reconcile is a no-op while a non-role model is active");
		h.ctx.model = makeRegistryModel(); // user switches back to the role model
		await modeMod.reconcileContextWindowForSession(h.pi, h.ctx, getAgentDir);
		assert(h.setModelCalls.length === 1 && h.setModelCalls[0].contextWindow === 150_000, "event reconcile re-applies the window after switching back to the role model");
		stateMod.saveState(cwd, sessionKey, {
			workflowEnabled: false,
			workflowExplicitlyDisabled: true,
			mode: "idle",
			todos: [],
			grillTurns: [],
			planReviewDecisions: [],
		});
	}

	// 2c. release restores ONLY the matching active clone.
	{
		writeFixtures({
			cwd,
			agentDir,
			workflowConfig: { models: { plan: { contextWindow: 150_000 } } },
			piGlobalSettings: PI_GLOBAL_SETTINGS,
		});
		const h = makeHarness({ registryModel: makeRegistryModel(), projectTrusted: false });
		await modeMod.setRole(h.pi, h.ctx, "plan", getAgentDir);
		const stateMod = await loadWorkflowModule("state.ts");
		const sessionKey = stateMod.getSessionKey(h.ctx);

		// Matching active clone → restored to the original window.
		h.ctx.model = h.setModelCalls[0];
		const relOk = await modeMod.releaseContextWindowOverride(h.pi, h.ctx, sessionKey);
		assert(relOk === true, "release succeeds on the matching active clone");
		const last = h.setModelCalls[h.setModelCalls.length - 1];
		assert(last.contextWindow === 200_000, "release restores the original window");
		assert(
			h.thinkingCalls[h.thinkingCalls.length - 1] === "high",
			"release preserves the user's thinking level",
		);
		// Second release is a no-op.
		const before = h.setModelCalls.length;
		await modeMod.releaseContextWindowOverride(h.pi, h.ctx, sessionKey);
		assert(h.setModelCalls.length === before, "a second release is a no-op (bookkeeping already dropped)");

		// Non-matching active model (user switched away) → no restore setModel.
		await modeMod.setRole(h.pi, h.ctx, "plan", getAgentDir);
		h.ctx.model = makeRegistryModel({ provider: "openai", id: "gpt-5.1" });
		const before2 = h.setModelCalls.length;
		await modeMod.releaseContextWindowOverride(h.pi, h.ctx, sessionKey);
		assert(h.setModelCalls.length === before2, "release leaves a user-switched manual model untouched");
	}

	// 2d. release path when the config no longer carries a window
	// (restoreModeRuntime → releaseContextWindowOverride).
	{
		writeFixtures({
			cwd,
			agentDir,
			workflowConfig: { models: { plan: { contextWindow: 150_000 } } },
			piGlobalSettings: PI_GLOBAL_SETTINGS,
		});
		const h = makeHarness({ registryModel: makeRegistryModel(), projectTrusted: false });
		await modeMod.setRole(h.pi, h.ctx, "plan", getAgentDir);
		// Simulate the field being cleared while the clone is still active.
		writeFixtures({
			cwd,
			agentDir,
			workflowConfig: { models: { plan: {} } },
			piGlobalSettings: PI_GLOBAL_SETTINGS,
		});
		h.ctx.model = h.setModelCalls[0];
		const ok = await modeMod.restoreModeRuntime(h.pi, h.ctx, "plan", getAgentDir);
		const last = h.setModelCalls[h.setModelCalls.length - 1];
		assert(ok === true && last.contextWindow === 200_000, "clearing the config releases the active clone back to the Pi window");
	}
} finally {
	fs.rmSync(harnessDir, { recursive: true, force: true });
}

// ── Part 2b: real dependency clamp path (pi-ai) ───────────────────────────

console.log("\n=== 2e: pi-ai request maxTokens clamp ===");
{
	// The simple-options subpath is not a package export; load the installed
	// dependency's real module through createRequire to exercise the ACTUAL
	// clamp path pi uses when building provider requests.
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	const { clampMaxTokensToContext, buildBaseOptions } = require(
		path.join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "simple-options.js"),
	);
	const registryModel = makeRegistryModel();
	const context = [{ role: "user", content: [{ type: "text", text: "x".repeat(50_000) }] }];
	const full = buildBaseOptions(registryModel, context, {});
	const shrunkModel = pureMod.cloneModelWithContextWindow(registryModel, 60_000);
	const shrunk = buildBaseOptions(shrunkModel, context, {});
	assert(
		typeof full.maxTokens === "number" && typeof shrunk.maxTokens === "number",
		"buildBaseOptions returns numeric maxTokens",
	);
	assert(shrunk.maxTokens < full.maxTokens, "a smaller contextWindow tightens the request maxTokens clamp");
	assert(registryModel.maxTokens === 64_000, "the model's declared maxTokens stays unchanged");
	const clampFull = clampMaxTokensToContext(registryModel, context, registryModel.maxTokens);
	const clampShrunk = clampMaxTokensToContext(shrunkModel, context, shrunkModel.maxTokens);
	assert(clampShrunk < clampFull, "clampMaxTokensToContext shrinks with the window (output-budget side effect)");
}

// ── Part 3: reviewer preparation + trust-aligned SettingsManager ──────────

console.log("\n=== 3: reviewer preparation + trust-aligned settings ===");

const reviewerDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-model-context-rev-"));
const reviewCwd = path.join(reviewerDir, "project");
const revAgentDir = path.join(reviewerDir, "agent");
try {
	const reviewerMod = await loadWorkflowModule("plan-review-agent.ts");
	const spec = {
		provider: "anthropic",
		model: "claude-opus-4-5",
		thinking: "high",
	};
	const makeRevCtx = (projectTrusted) => ({
		cwd: reviewCwd,
		isProjectTrusted: () => projectTrusted,
		modelRegistry: {
			find: (p, m) =>
				p === spec.provider && m === spec.model ? makeRegistryModel() : undefined,
		},
	});

	// 3a. trusted parent: project compaction participates.
	writeFixtures({
		cwd: reviewCwd,
		agentDir: revAgentDir,
		piGlobalSettings: PI_GLOBAL_SETTINGS,
		piProjectSettings: PI_PROJECT_SETTINGS,
	});
	{
		const prepared = await reviewerMod.prepareReviewerModelPlan({
			ctx: makeRevCtx(true),
			modelSpec: spec,
			reviewCwd,
			progressLabel: "Plan review",
		});
		assert(prepared.model.contextWindow === 200_000, "unconfigured window keeps the raw Pi model");
		assert(
			prepared.contextBasis.piBaseline === 200_000 &&
				prepared.contextBasis.effective === 200_000 &&
				prepared.contextBasis.compaction.reserveTokens === 4_096,
			"trusted parent: context basis compaction comes from the PROJECT settings",
		);
		assert(!("configured" in prepared.contextBasis), "unconfigured window omits `configured` from the basis");
		assert(prepared.thinkingLevel === "high", "thinking level is derived from the spec");
	}

	// 3b. untrusted parent: global/default compaction (the tightening).
	{
		const prepared = await reviewerMod.prepareReviewerModelPlan({
			ctx: makeRevCtx(false),
			modelSpec: spec,
			reviewCwd,
			progressLabel: "Review",
		});
		assert(
			prepared.contextBasis.compaction.reserveTokens === 16_384 &&
				prepared.contextBasis.compaction.keepRecentTokens === 20_000,
			"untrusted parent: context basis uses GLOBAL compaction (documented tightening)",
		);
	}

	// 3c. configured window: validated clone + basis.
	{
		const prepared = await reviewerMod.prepareReviewerModelPlan({
			ctx: makeRevCtx(false),
			modelSpec: { ...spec, contextWindow: 150_000 },
			reviewCwd,
			progressLabel: "Review",
		});
		assert(prepared.model.contextWindow === 150_000, "configured window applies the clone to the child model");
		assert(
			prepared.contextBasis.configured === 150_000 &&
				prepared.contextBasis.piBaseline === 200_000 &&
				prepared.contextBasis.effective === 150_000,
			"basis records configured/piBaseline/effective",
		);
	}

	// 3d. invalid configured window throws BEFORE any cache use.
	{
		let threw = "";
		try {
			await reviewerMod.prepareReviewerModelPlan({
				ctx: makeRevCtx(false),
				modelSpec: { ...spec, contextWindow: 200_000 },
				reviewCwd,
				progressLabel: "Review",
			});
		} catch (e) {
			threw = e instanceof Error ? e.message : String(e);
		}
		assert(threw.includes("严格小于"), "window equal to the baseline throws an explicit preparation error");
	}

	// 3d-2. corrupt Pi settings + configured window → explicit error (M1:
	// strictness aligned with loadDiskCompactionSnapshot); no-window reviews
	// keep running so a broken settings.json cannot brick them.
	{
		const corruptDir = path.join(reviewerDir, "corrupt-agent");
		fs.mkdirSync(corruptDir, { recursive: true });
		fs.writeFileSync(path.join(corruptDir, "settings.json"), "{ not valid json");
		// prepareReviewerModelPlan resolves the agent dir via the SDK's
		// getAgentDir(), which reads PI_CODING_AGENT_DIR — point it at the
		// corrupt fixture for the duration of this case.
		const prevAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = corruptDir;
		try {
			let threwWith = "";
			try {
				await reviewerMod.prepareReviewerModelPlan({
					ctx: makeRevCtx(false),
					modelSpec: { ...spec, contextWindow: 150_000 },
					reviewCwd,
					progressLabel: "Review",
				});
			} catch (e) {
				threwWith = e instanceof Error ? e.message : String(e);
			}
			assert(
				threwWith.includes("Pi settings 加载失败"),
				"corrupt Pi settings reject a configured-window review preparation explicitly",
			);

			const noWindowPrepared = await reviewerMod.prepareReviewerModelPlan({
				ctx: makeRevCtx(false),
				modelSpec: spec,
				reviewCwd,
				progressLabel: "Review",
			});
			assert(
				noWindowPrepared.model.contextWindow === 200_000,
				"corrupt Pi settings still allow a no-window reviewer run (basis reflects actual child params)",
			);
		} finally {
			if (prevAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDirEnv;
		}
	}

	// 3e. unresolvable model throws the not-found error.
	{
		let threw = "";
		try {
			await reviewerMod.prepareReviewerModelPlan({
				ctx: {
					cwd: reviewCwd,
					isProjectTrusted: () => false,
					modelRegistry: { find: () => undefined },
				},
				modelSpec: { provider: "nope", model: "nope" },
				reviewCwd,
				progressLabel: "Review",
			});
		} catch (e) {
			threw = e instanceof Error ? e.message : String(e);
		}
		assert(threw.includes("model not found"), "unresolvable model throws the explicit not-found error");
	}
} finally {
	fs.rmSync(reviewerDir, { recursive: true, force: true });
}

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);
