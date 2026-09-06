/**
 * RPC / JSON / print integration fixtures for pi-workflow.
 *
 * Drives the real Pi binary in RPC and print modes with a throwaway cwd so
 * no real session/state/config is touched. No API key or model calls are
 * needed: extension commands run without an agent turn, and we ignore
 * unrelated setStatus / model-unavailable notify events. Interactive
 * extension dialogs are answered from a scripted response list via the
 * extension_ui_request / extension_ui_response protocol.
 *
 * Run: node scripts/validate-rpc-mode.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const PI_BIN = path.join(REPO, "node_modules/.bin/pi");
const EXT = path.join(REPO, "extensions/workflow/index.ts");

if (!fs.existsSync(PI_BIN)) {
	console.error(`pi binary not found at ${PI_BIN} — run \`npm install\` first.`);
	process.exit(1);
}

let runs = 0;
let failures = 0;

function assert(cond, msg) {
	runs++;
	if (cond) {
		console.log(`  PASS: ${msg}`);
		return;
	}
	failures++;
	console.error(`  FAIL: ${msg}`);
}

/** Split a stdout buffer into JSONL records, LF-only, per Pi RPC framing. */
function readJsonlLines(buf) {
	const lines = [];
	let buffer = buf.toString("utf8");
	while (true) {
		const idx = buffer.indexOf("\n");
		if (idx === -1) break;
		let line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line.length === 0) continue;
		try {
			lines.push(JSON.parse(line));
		} catch {
			// Non-JSON line (e.g. startup banner); ignore.
		}
	}
	return lines;
}

/**
 * Spawn Pi in RPC mode, send one prompt, collect all events until the prompt
 * response arrives. Returns the parsed events. Resolves after a short delay
 * following the response so late notify events are captured.
 */
function runRpcPrompt(args, prompt, cwd, env, { timeoutMs = 15000 } = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(PI_BIN, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
		const stdoutChunks = [];
		const stderrChunks = [];
		let buffer = "";
		let stdinTimer = null;
		let settled = false;

		const settle = (fn) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (stdinTimer) clearTimeout(stdinTimer);
			fn();
		};

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }, 2000);
			settle(() => reject(new Error(`RPC prompt timed out after ${timeoutMs}ms`)));
		}, timeoutMs);

		// Close stdin shortly after the matching response arrives so late
		// notify events are still captured; the outer timer bounds failure.
		const onStdout = (chunk) => {
			stdoutChunks.push(chunk);
			buffer += chunk.toString("utf8");
			let nl;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) continue;
				try {
					const event = JSON.parse(line);
					if (
						event.type === "response" &&
						event.id === "t1" &&
						!stdinTimer
					) {
						// Close stdin shortly after the response (success or rejection) so
						// late notify events are still captured and the process exits
						// promptly even on prompt rejection.
						stdinTimer = setTimeout(() => {
							try { proc.stdin.end(); } catch { /* already closed */ }
						}, 400);
					}
				} catch { /* non-JSON startup line */ }
			}
		};
		proc.stdout.on("data", onStdout);
		proc.stderr.on("data", (c) => stderrChunks.push(c));

		proc.once("error", (error) => {
			settle(() => reject(error));
		});
		proc.on("exit", (code) => {
			settle(() => {
				const events = readJsonlLines(Buffer.concat(stdoutChunks));
				resolve({ events, stderr: Buffer.concat(stderrChunks).toString("utf8"), code });
			});
		});

		// Send the prompt once the child process is ready to receive input.
		proc.once("spawn", () => {
			proc.stdin.write(JSON.stringify({ id: "t1", type: "prompt", message: prompt }) + "\n");
		});
	});
}

/**
 * Spawn Pi in RPC mode and answer extension UI dialogs from a scripted list.
 *
 * Each interactive request (select / confirm / input) consumes the next entry
 * of `responses`; an entry is either a response payload object (spread after
 * the id) or a function (event) => payload. Fire-and-forget requests (notify,
 * setStatus, ...) are recorded but never answered. When the script runs out,
 * the dialog is cancelled so the extension can finish gracefully. All events
 * (including every extension_ui_request) are returned for assertions.
 */
function runRpcInteractive(args, prompt, cwd, env, responses, { timeoutMs = 20000 } = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(PI_BIN, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
		const stdoutChunks = [];
		const stderrChunks = [];
		const uiRequests = [];
		let buffer = "";
		let responseIdx = 0;
		let stdinTimer = null;
		let settled = false;

		const settle = (fn) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (stdinTimer) clearTimeout(stdinTimer);
			fn();
		};

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }, 2000);
			settle(() => reject(new Error(`RPC interactive prompt timed out after ${timeoutMs}ms`)));
		}, timeoutMs);

		const sendUiResponse = (id, payload) => {
			const line = JSON.stringify({ type: "extension_ui_response", id, ...payload }) + "\n";
			try { proc.stdin.write(line); } catch { /* stdin already closed */ }
		};

		const handleEvent = (event) => {
			if (event.type === "extension_ui_request") {
				uiRequests.push(event);
				if (["select", "confirm", "input"].includes(event.method)) {
					const scripted = responses[responseIdx++];
					if (scripted === undefined) {
						sendUiResponse(event.id, { cancelled: true });
						return;
					}
					const payload = typeof scripted === "function" ? scripted(event) : scripted;
					if (payload) sendUiResponse(event.id, payload);
				}
				return;
			}
			if (event.type === "response" && event.id === "t1" && !stdinTimer) {
				stdinTimer = setTimeout(() => {
					try { proc.stdin.end(); } catch { /* already closed */ }
				}, 500);
			}
		};

		proc.stdout.on("data", (chunk) => {
			stdoutChunks.push(chunk);
			buffer += chunk.toString("utf8");
			let nl;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) continue;
				try {
					handleEvent(JSON.parse(line));
				} catch { /* non-JSON startup line */ }
			}
		});
		proc.stderr.on("data", (c) => stderrChunks.push(c));

		proc.once("error", (error) => {
			settle(() => reject(error));
		});
		proc.on("exit", (code) => {
			settle(() => {
				const events = readJsonlLines(Buffer.concat(stdoutChunks));
				resolve({ events, uiRequests, stderr: Buffer.concat(stderrChunks).toString("utf8"), code });
			});
		});

		proc.once("spawn", () => {
			proc.stdin.write(JSON.stringify({ id: "t1", type: "prompt", message: prompt }) + "\n");
		});
	});
}

// ── Setup throwaway project ────────────────────────────────────────────────

const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-"));
const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-agent-"));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-home-"));

// Enable workflow.autoEnter via a global config so /workflow:status is registered
// without needing an interactive /workflow:enable first. Global config lives under the
// agent dir: <agentDir>/workflow/config.json.
const wfConfigDir = path.join(tmpAgent, "workflow");
fs.mkdirSync(wfConfigDir, { recursive: true });
fs.writeFileSync(
	path.join(wfConfigDir, "config.json"),
	JSON.stringify({ workflow: { autoEnter: true } }, null, 2),
);

function cleanup() {
	for (const d of [tmpCwd, tmpAgent, tmpHome]) {
		try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}
process.on("exit", cleanup);

/** Shared RPC-mode Pi args: workflow extension only, offline, no session. */
const RPC_ARGS = [
	"--mode", "rpc",
	"--offline",
	"--no-session",
	"--no-extensions",
	"-e", EXT,
];

/** Shared env: isolated agent dir / HOME so real configs never load. */
const RPC_ENV = {
	...process.env,
	PI_CODING_AGENT_DIR: tmpAgent,
	HOME: tmpHome,
	PI_OFFLINE: "1",
};

// ── Test 1: RPC /workflow:status emits an effective-config notify ─────────────────
console.log("=== Test 1: RPC /workflow:status effective-config notify ===");
{
	const env = RPC_ENV;

	let result;
	try {
		result = await runRpcPrompt(RPC_ARGS, "/workflow:status", tmpCwd, env, { timeoutMs: 15000 });
	} catch (e) {
		// Spawn/startup failure is a real regression — do not mask it as a pass.
		console.error(`  FAIL: RPC spawn failed: ${e.message}`);
		failures++;
		process.exit(1);
	}

	if (result) {
		const notifyEvents = result.events.filter(
			(e) => e.type === "extension_ui_request" && e.method === "notify",
		);
		const statusNotify = notifyEvents.find((e) =>
			typeof e.message === "string" && e.message.includes("Effective Config"),
		);
		assert(
			!!statusNotify,
			"RPC /workflow:status emits a notify containing 'Effective Config'",
		);
		if (statusNotify) {
			assert(
				statusNotify.message.includes("projectConfig:"),
				"/workflow:status notify includes projectConfig trust line",
			);
			assert(
				statusNotify.message.includes("todoTool: update_plan"),
				"autoEnter RPC session registers and activates the update_plan alias",
			);
		}
		// The prompt command itself must succeed.
		const response = result.events.find((e) => e.type === "response");
		if (!response || response.success !== true) {
			console.error(`  stderr: ${result.stderr.slice(0, 2000)}`);
			console.error(`  exit code: ${result.code}`);
		}
		assert(!!response && response.success === true, "RPC /workflow:status prompt accepted");
	}
}

// ── Test 2: update_plan Paseo contract unchanged + replace returns delta ──
console.log("\n=== Test 2: update_plan Paseo contract (source-level) ===");
{
	const toolsSrc = fs.readFileSync(
		path.join(REPO, "extensions/workflow/tools.ts"),
		"utf8",
	);
	const compatSrc = fs.readFileSync(
		path.join(REPO, "extensions/workflow/todo-compat.ts"),
		"utf8",
	);
	// Paseo parameter contract unchanged: UpdatePlanParamsSchema with plan of {step, status}.
	assert(
		compatSrc.includes("UpdatePlanParamsSchema") &&
			compatSrc.includes('Type.Literal("pending")') &&
			compatSrc.includes('Type.Literal("in_progress")') &&
			compatSrc.includes('Type.Literal("completed")'),
		"todo-compat: Paseo UpdatePlanParamsSchema status enum unchanged",
	);
	// update_plan read returns snapshot, replace returns delta; details.todos full.
	const upStart = toolsSrc.indexOf("export function registerUpdatePlanTool");
	const upEnd = toolsSrc.indexOf("// ── workflow plan tools", upStart);
	assert(upStart >= 0 && upEnd > upStart, "tools.ts: update_plan block anchors exist");
	const upBlock = toolsSrc.slice(upStart, upEnd);
	assert(
		upBlock.includes('todoSnapshotText(state)') &&
			upBlock.includes('todoDeltaText(state, { mutation: "replaced" })') &&
			/details: \{ todos: state\.todos \}/.test(upBlock),
		'update_plan: read returns snapshot, replace returns replaced-mutation delta, details.todos kept full',
	);
	// applyTodoAction replace still maps Paseo steps into internal todos.
	assert(
		compatSrc.includes('case "replace"') &&
			compatSrc.includes('parsePaseoStep(entry.step)') &&
			compatSrc.includes('fromPaseoStatus(entry.step'),
		"todo-compat: replace action + Paseo-to-internal status mapping retained",
	);

	// workflow_todo reset passes mutation=reset; four-state count stays in delta.
	const todoToolStart = toolsSrc.indexOf("export function registerTodoTool");
	const todoToolEnd = toolsSrc.indexOf("export function registerUpdatePlanTool", todoToolStart);
	assert(todoToolStart >= 0 && todoToolEnd > todoToolStart, "tools.ts: workflow_todo block anchors exist");
	const todoBlock = toolsSrc.slice(todoToolStart, todoToolEnd);
	assert(/deltaMutation = "reset"/.test(todoBlock), "workflow_todo: reset sets deltaMutation=reset");
	assert(/mutation: deltaMutation/.test(todoBlock), "workflow_todo: delta passes mutation flag");
	// four-state count stays in delta (helpers.ts owns the format).
	const helpersSrc = fs.readFileSync(path.join(REPO, "extensions/workflow/helpers.ts"), "utf8");
	assert(/done=\$\{counts\.done\}, in_progress=\$\{counts\.in_progress\}, pending=\$\{counts\.pending\}, blocked=\$\{counts\.blocked\}/.test(helpersSrc), "helpers.ts: todo delta keeps four-state count");
	// Legacy grilling replay still accepted (single-field shape).
	assert(/question: Type\.Optional\(Type\.String\(\)\)/.test(toolsSrc) && /recommendedAnswer: Type\.Optional\(Type\.String\(\)\)/.test(toolsSrc), "workflow_grill_record: legacy single-field params retained for replay");
}

// ── Test 3: /workflow:settings empty-layer reset skips confirm and write ──────
console.log("\n=== Test 3: RPC /workflow:settings empty session layer reset ===");
{
	// Fresh throwaway cwd: the session layer is empty, so reset-session must
	// short-circuit with an already-inherits notify — no confirm, no write.
	const tmpCwd3 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-empty-"));
	try {
		const responses = [
			{ value: "reset-session" }, // scope selector
			{ value: "done" },          // back at scope selector after short-circuit
		];
		const result = await runRpcInteractive(
			RPC_ARGS,
			"/workflow:settings",
			tmpCwd3,
			RPC_ENV,
			responses,
			{ timeoutMs: 20000 },
		);

		const confirms = result.uiRequests.filter((e) => e.method === "confirm");
		assert(confirms.length === 0, "empty session layer reset never asks for confirmation");

		const notifies = result.uiRequests.filter(
			(e) => e.method === "notify" && typeof e.message === "string",
		);
		assert(
			notifies.some((e) => e.message.includes("already inherits its parent")),
			"empty session layer reset notifies 'already inherits its parent'",
		);
		assert(
			!notifies.some((e) => e.message.includes("reset session scope to inherit")),
			"empty session layer reset reports no reset",
		);

		const response = result.events.find((e) => e.type === "response");
		if (!response || response.success !== true) {
			console.error(`  stderr: ${result.stderr.slice(0, 2000)}`);
			console.error(`  exit code: ${result.code}`);
		}
		assert(!!response && response.success === true, "RPC /workflow:settings prompt accepted (empty-layer path)");
	} finally {
		fs.rmSync(tmpCwd3, { recursive: true, force: true });
	}
}

// ── Test 4: /workflow:settings cancelled reset leaves project config untouched ─
console.log("\n=== Test 4: RPC /workflow:settings cancelled project reset ===");
{
	// Throwaway project with a non-empty .pi/workflow/config.json, started
	// with --approve so the project trust gate passes. Cancelling the reset
	// confirm must leave the file byte-identical and report no success.
	const tmpCwd4 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-proj-"));
	try {
		const wfDir4 = path.join(tmpCwd4, ".pi", "workflow");
		fs.mkdirSync(wfDir4, { recursive: true });
		const originalConfig =
			JSON.stringify({ workflow: { autoEnter: true }, review: { enabled: false } }, null, 2) + "\n";
		fs.writeFileSync(path.join(wfDir4, "config.json"), originalConfig);

		const responses = [
			{ value: "reset-project" },  // scope selector
			{ confirmed: false },        // confirm dialog: answer No
			{ value: "done" },           // back at scope selector after cancel
		];
		const result = await runRpcInteractive(
			[...RPC_ARGS, "--approve"],
			"/workflow:settings",
			tmpCwd4,
			RPC_ENV,
			responses,
			{ timeoutMs: 20000 },
		);

		const confirms = result.uiRequests.filter((e) => e.method === "confirm");
		assert(confirms.length === 1, "non-empty project reset asks exactly one confirmation");
		if (confirms[0]) {
			assert(
				String(confirms[0].title ?? "").includes("project") &&
					String(confirms[0].message ?? "").includes("project"),
				"confirm title/message name the project scope and its inheritance effect",
			);
		}

		const notifies = result.uiRequests.filter(
			(e) => e.method === "notify" && typeof e.message === "string",
		);
		assert(
			!notifies.some((e) => e.message.includes("reset project scope to inherit")),
			"cancelled reset does not report a reset",
		);
		assert(
			notifies.some((e) => e.message.includes("reset cancelled")),
			"cancelled reset reports the cancellation",
		);

		const after = fs.readFileSync(path.join(wfDir4, "config.json"), "utf8");
		assert(after === originalConfig, "project config file unchanged after cancelled reset");

		const response = result.events.find((e) => e.type === "response");
		if (!response || response.success !== true) {
			console.error(`  stderr: ${result.stderr.slice(0, 2000)}`);
			console.error(`  exit code: ${result.code}`);
		}
		assert(!!response && response.success === true, "RPC /workflow:settings prompt accepted (cancelled-reset path)");
	} finally {
		fs.rmSync(tmpCwd4, { recursive: true, force: true });
	}
}

// ── Test 5: scoped-first model candidates (pure helper) ──────────────────
console.log("\n=== Test 5: scoped-first model candidates helper ===");
{
	// settings.ts imports TUI-only modules, so extract the pure helper into a
	// temp .ts module (Node native type-stripping) instead of importing the file.
	const settingsSrc = fs.readFileSync(
		path.join(REPO, "extensions/workflow/settings.ts"),
		"utf8",
	);
	const anchor = "export function resolveModelCandidates(";
	const start = settingsSrc.indexOf(anchor);
	assert(start >= 0, "settings.ts exports resolveModelCandidates");
	const lines = settingsSrc.slice(start).split("\n");
	const out = [];
	for (const line of lines) {
		out.push(line);
		// Top-level declaration closes with a `}` at column 0.
		if (line === "}") break;
	}
	const fnSrc = out.join("\n");
	assert(fnSrc.startsWith("export function") && fnSrc.endsWith("}"), "resolveModelCandidates extracted intact");

	const tmpDir5 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-mod-"));
	try {
		const modPath = path.join(tmpDir5, "candidates.ts");
		fs.writeFileSync(modPath, fnSrc + "\n");
		const mod = await import(pathToFileURL(modPath).href);

		const mk = (provider, id) => ({ provider, id });
		const scoped = [
			{ model: mk("openai", "gpt-b"), thinkingLevel: "high" },
			{ model: mk("anthropic", "claude-a") },
			{ model: mk("anthropic", "claude-a") }, // duplicate provider/id
		];
		const catalog = [mk("zai", "grok-x"), mk("anthropic", "claude-a"), mk("openai", "gpt-b")];

		const narrowed = mod.resolveModelCandidates(scoped, catalog);
		assert(narrowed.scoped === true, "non-empty scopedModels marks the result as scoped");
		assert(
			narrowed.models.length === 2 &&
				narrowed.models.map((m) => `${m.provider}/${m.id}`).join(",") ===
					"anthropic/claude-a,openai/gpt-b",
			"non-empty scopedModels returns only scoped models, deduped and sorted",
		);

		const fallback = mod.resolveModelCandidates([], catalog);
		assert(fallback.scoped === false, "empty scopedModels falls back to the available catalog");
		assert(
			fallback.models.length === 3 &&
				fallback.models.map((m) => `${m.provider}/${m.id}`).join(",") ===
					"anthropic/claude-a,openai/gpt-b,zai/grok-x",
			"empty scopedModels keeps catalog models deduped and sorted by provider/id",
		);
	} finally {
		fs.rmSync(tmpDir5, { recursive: true, force: true });
	}
}

// ── Test 7: RPC contextWindow editing — real event-dispatch path ────────
console.log("\n=== Test 7: RPC contextWindow session-scope editing ===");
{
	// Drives the REAL RPC wizard: session scope → plan · contextWindow →
	// invalid parse ("abc") → invalid value (250000 ≥ Pi baseline for
	// claude-opus-4-5) → valid value (150000). The two invalid inputs must be
	// rejected with error notifies and leave nothing persisted; the valid one
	// must land in the session layer as a number.
	const tmpCwd7 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-ctx-"));
	try {
		const pickCtxWindow = (event) => {
			const items = Array.isArray(event.options) ? event.options : [];
			const hit = items.find((o) => typeof o === "string" && o.includes("plan · contextWindow"));
			return hit !== undefined ? { value: hit } : { cancelled: true };
		};
		const responses = [
			{ value: "session" },      // scope selector
			pickCtxWindow,             // setting selector (first attempt)
			{ value: "abc" },          // input: non-integer → parse error, no write
			pickCtxWindow,             // setting selector (second attempt)
			{ value: "250000" },       // input: ≥ Pi baseline → validation reject, no write
			pickCtxWindow,             // setting selector (third attempt)
			{ value: "150000" },       // input: valid → write
			{ value: "(back to scopes)" },
			{ value: "done" },
		];
		const result = await runRpcInteractive(
			RPC_ARGS,
			"/workflow:settings",
			tmpCwd7,
			RPC_ENV,
			responses,
			{ timeoutMs: 30000 },
		);

		const notifies = result.uiRequests.filter(
			(e) => e.method === "notify" && typeof e.message === "string",
		);
		assert(
			notifies.some((e) => e.message.includes("请输入十进制整数")),
			"non-integer input surfaces the strict parse error",
		);
		assert(
			notifies.some((e) => e.message.includes("严格小于") && e.message.includes("未保存")),
			"a value at/above the Pi baseline is rejected with the bound error and NOT saved",
		);

		// The session layer must now contain ONLY the valid value as a number.
		const stateFiles = [];
		const walk = (dir) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(p);
				else if (entry.name === "state.json") stateFiles.push(p);
			}
		};
		walk(path.join(tmpCwd7, ".pi", "workflow"));
		const states = stateFiles.map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
		const withWindow = states.filter(
			(s) => s?.sessionConfig?.models?.plan?.contextWindow !== undefined,
		);
		assert(
			withWindow.length === 1 &&
				withWindow[0].sessionConfig.models.plan.contextWindow === 150000 &&
				typeof withWindow[0].sessionConfig.models.plan.contextWindow === "number",
			"the valid value is persisted to the session layer as a JSON number",
		);

		const response = result.events.find((e) => e.type === "response");
		if (!response || response.success !== true) {
			console.error(`  stderr: ${result.stderr.slice(0, 2000)}`);
			console.error(`  exit code: ${result.code}`);
		}
		assert(!!response && response.success === true, "RPC contextWindow settings prompt accepted");
	} finally {
		fs.rmSync(tmpCwd7, { recursive: true, force: true });
	}
}

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);
