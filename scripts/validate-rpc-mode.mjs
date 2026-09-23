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

import { spawn, execFileSync } from "node:child_process";
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

/**
 * Spawn Pi in RPC mode and send a sequence of prompts (slash commands),
 * collecting per-prompt events. Each prompt runs to its response event, then
 * a short settle window captures late events (kickoff user messages, late
 * notifies) before the next prompt starts. `onSettled(index, bucket)` runs
 * between prompts so tests can read on-disk state mid-session. Interactive
 * extension dialogs are cancelled — the tested work entries must never ask.
 */
function runRpcSequence(args, prompts, cwd, env, { timeoutMs = 25000, settleAfterMs = 800, onSettled } = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(PI_BIN, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
		const perPrompt = prompts.map(() => ({ events: [], response: null }));
		const uiRequests = [];
		const stderrChunks = [];
		let idx = -1;
		let buffer = "";
		let settled = false;
		let timer = null;
		let settleTimer = null;

		const finish = (fn) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (settleTimer) clearTimeout(settleTimer);
			fn();
		};
		const fail = (msg) => finish(() => {
			try { proc.kill("SIGKILL"); } catch { /* already dead */ }
			reject(new Error(msg));
		});

		const sendPrompt = (i) => {
			idx = i;
			timer = setTimeout(() => fail(`RPC sequence timed out at prompt ${i}: ${prompts[i]}`), timeoutMs);
			proc.stdin.write(JSON.stringify({ id: `p${i}`, type: "prompt", message: prompts[i] }) + "\n");
		};

		const handleLine = (line) => {
			let event;
			try { event = JSON.parse(line); } catch { return; }
			if (idx >= 0) perPrompt[idx].events.push(event);
			if (event.type === "extension_ui_request") {
				uiRequests.push(event);
				if (["select", "confirm", "input"].includes(event.method)) {
					const reply = JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n";
					try { proc.stdin.write(reply); } catch { /* stdin closed */ }
				}
				return;
			}
			if (event.type === "response" && event.id === `p${idx}`) {
				perPrompt[idx].response = event;
				settleTimer = setTimeout(async () => {
					if (onSettled) {
						try { await onSettled(idx, perPrompt[idx]); } catch { /* assertion-side concern */ }
					}
					if (idx + 1 < prompts.length) sendPrompt(idx + 1);
					else { try { proc.stdin.end(); } catch { /* already closed */ } }
				}, settleAfterMs);
			}
		};

		proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let nl;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line) handleLine(line);
			}
		});
		proc.stderr.on("data", (c) => stderrChunks.push(c));
		proc.once("error", (error) => fail(error.message));
		proc.on("exit", () => finish(() => resolve({ perPrompt, uiRequests, stderr: Buffer.concat(stderrChunks).toString("utf8") })));
		proc.once("spawn", () => sendPrompt(0));
	});
}

// ── Setup throwaway project ──────────────────────────────────────────────────

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
			notifies.some((e) => e.message.includes("Enter a plain decimal integer")),
			"non-integer input surfaces the strict parse error",
		);
		assert(
			notifies.some((e) => e.message.includes("strictly below the Pi default window") && e.message.includes("未保存")),
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

// ── Direct Work --worktree: real command fixtures ─────────────────────

/** Environment variant with a dummy key so role-model application succeeds
 *  offline (commands never issue model requests). */
const RPC_ENV_KEYED = { ...RPC_ENV, ANTHROPIC_API_KEY: "dummy-key-for-rpc-work-fixture" };

/** Create a throwaway git repo; cleanup removes the repo AND its sibling
 *  workflow-worktree dirs (`<repo>-wf-*`). Returns { repo, cleanup }. */
function makeWorkRepo(prefix) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	execFileSync("git", ["init", "-b", "master"], { cwd: repo, stdio: "pipe" });
	fs.writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
	execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "pipe" });
	const cleanup = () => {
		const parent = path.dirname(repo);
		const wfPrefix = `${path.basename(repo)}-wf-`;
		for (const entry of fs.existsSync(parent) ? fs.readdirSync(parent) : []) {
			if (entry.startsWith(wfPrefix)) {
				fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
			}
		}
		fs.rmSync(repo, { recursive: true, force: true });
	};
	return { repo, cleanup };
}

/** Read the (single) session state.json under a repo, if any. */
function readWorkState(repo) {
	const sessions = path.join(repo, ".pi", "workflow", "sessions");
	if (!fs.existsSync(sessions)) return undefined;
	for (const dir of fs.readdirSync(sessions)) {
		const sp = path.join(sessions, dir, "state.json");
		if (fs.existsSync(sp)) return JSON.parse(fs.readFileSync(sp, "utf8"));
	}
	return undefined;
}

function worktreeDirs(repo) {
	const parent = path.dirname(repo);
	const wfPrefix = `${path.basename(repo)}-wf-`;
	return (fs.existsSync(parent) ? fs.readdirSync(parent) : []).filter((e) => e.startsWith(wfPrefix));
}

const notifiesOf = (bucket) =>
	bucket.events
		.filter((e) => e.type === "extension_ui_request" && e.method === "notify")
		.map((e) => String(e.message ?? ""));
const branchExistsIn = (repo, branch) => {
	try {
		const out = execFileSync("git", ["for-each-ref", `refs/heads/${branch}`, "--format=%(refname)"], { cwd: repo, encoding: "utf8" });
		return out.trim().length > 0;
	} catch { return false; }
};

// ── Test 8: /workflow:work --worktree creates a managed worktree (no dialog) ─
console.log("\n=== Test 8: RPC /workflow:work --worktree creation (no dialog) ===");
{
	const { repo, cleanup } = makeWorkRepo("pi-wf-rpc-work8-");
	try {
		const result = await runRpcSequence(
			RPC_ARGS,
			["/workflow:work --worktree"],
			repo,
			RPC_ENV_KEYED,
			{ timeoutMs: 25000 },
		);

		const interactive = result.uiRequests.filter((e) => ["select", "confirm", "input"].includes(e.method));
		assert(interactive.length === 0, "worktree entry never asks for a selection dialog");

		const notifies = notifiesOf(result.perPrompt[0]);
		const okNotify = notifies.find((m) => m.includes("已进入 Work Mode（独立 worktree）"));
		assert(!!okNotify, "success notify names the standalone worktree entry");
		if (okNotify) {
			assert(okNotify.includes("提交基线"), "notify states the commit-baseline boundary");
			assert(okNotify.includes("未提交修改保留在原目录"), "notify states uncommitted changes stay in the source checkout");
		}

		const state = readWorkState(repo);
		assert(!!state && state.mode === "work", "state persisted mode=work");
		assert(
			!!state?.workRunId && !!state?.worktreePath && !!state?.worktreeBranch && !!state?.worktreeBaseBranch,
			"state carries workRunId + all three worktree fields",
		);
		assert(
			!!state && fs.existsSync(state.worktreePath) &&
				path.basename(state.worktreePath) === path.basename(repo) + "-wf-" + state.workRunId.slice(0, 8) &&
				state.worktreeBranch === `wf/${state.workRunId.slice(0, 8)}`,
			"worktree dir exists with the default wf/<8hex> naming",
		);
		assert(state.worktreeBaseBranch === "master", "base branch recorded from the source checkout");
		assert(branchExistsIn(repo, state.worktreeBranch), "workflow branch exists in the repo");

		// Empty task: mode switch only — no kickoff user message.
		const userMessages = result.perPrompt[0].events.filter(
			(e) => e.type === "message_start" && e.message?.role === "user",
		);
		assert(userMessages.length === 0, "empty task sends no kickoff message");

		const response = result.perPrompt[0].response;
		assert(!!response && response.success === true, "RPC /workflow:work --worktree prompt accepted");
	} finally {
		cleanup();
	}
}

// ── Test 9: reentry reuse / name mismatch / parse error / plain path ──
console.log("\n=== Test 9: RPC /workflow:work reentry, mismatch, parse error, plain path ===");
{
	const { repo, cleanup } = makeWorkRepo("pi-wf-rpc-work9-");
	try {
		const snapshots = [];
		const result = await runRpcSequence(
			RPC_ARGS,
			[
				"/workflow:work --worktree",                       // 0: create
				"/workflow:work --worktree othername",             // 1: mismatch rejected
				"/workflow:work --worktree a b -- task",           // 2: parse error, zero side effects
				"/workflow:work --worktree",                       // 3: bare flag reuses
				"/workflow:work",                                  // 4: plain empty reuses too
			],
			repo,
			RPC_ENV_KEYED,
			{ timeoutMs: 25000, onSettled: () => { snapshots.push(readWorkState(repo)); } },
		);

		const [create, mismatch, parseErr, bareReuse, plainReuse] = result.perPrompt;
		assert(create.response?.success === true && mismatch.response?.success === true &&
			parseErr.response?.success === true && bareReuse.response?.success === true && plainReuse.response?.success === true,
			"all five prompts accepted");
		assert(snapshots.length === 5, "state snapshotted after every prompt");

		const s0 = snapshots[0];
		assert(!!s0?.worktreePath && !!s0?.worktreeBranch, "prompt 0 created the worktree fields");
		const dirsAfterCreate = worktreeDirs(repo);
		assert(dirsAfterCreate.length === 1, "exactly one worktree dir after creation");

		const mismatchNotifies = notifiesOf(mismatch);
		assert(
			mismatchNotifies.some((m) => m.includes("不匹配") && m.includes("新开一个独立 Pi 会话")),
			"name mismatch reports the conflict and points at a fresh Pi session",
		);
		const s1 = snapshots[1];
		assert(s1?.worktreePath === s0.worktreePath && s1?.worktreeBranch === s0.worktreeBranch && s1?.workRunId === s0.workRunId,
			"mismatched name leaves state untouched");
		assert(worktreeDirs(repo).length === 1, "no extra dir after mismatch");

		assert(
			notifiesOf(parseErr).some((m) => m.includes("分支名后最多一个 token")),
			"extra-token parse error surfaces the usage denial",
		);
		const s2 = snapshots[2];
		assert(s2?.worktreePath === s0.worktreePath && s2?.workRunId === s0.workRunId && s2?.mode === "work",
			"parse error keeps the previous state byte-identical");
		assert(worktreeDirs(repo).length === 1, "no extra dir after parse error");

		assert(
			notifiesOf(bareReuse).some((m) => m.includes("复用 active worktree") && m.includes(s0.worktreePath)),
			"bare --worktree reentry reuses the active worktree",
		);
		const s3 = snapshots[3];
		assert(s3?.workRunId === s0.workRunId && s3?.worktreeBranch === s0.worktreeBranch, "reentry keeps workRunId and branch");

		assert(
			notifiesOf(plainReuse).some((m) => m.includes("复用 active worktree")),
			"plain /workflow:work keeps reusing the active worktree",
			);
		const s4 = snapshots[4];
		assert(s4?.workRunId === s0.workRunId, "plain path keeps the same workRunId");
	} finally {
		cleanup();
	}
}

// ── Test 10: task body via `--` separator: branch naming + literal kickoff ──
console.log("\n=== Test 10: RPC /workflow:work --worktree <name> -- <task> kickoff ===");
{
	const { repo, cleanup } = makeWorkRepo("pi-wf-rpc-work10-");
	try {
		const result = await runRpcSequence(
			RPC_ARGS,
			["/workflow:work --worktree fix/log-rotation -- 修复日志轮转任务"],
			repo,
			RPC_ENV_KEYED,
			{ timeoutMs: 25000 },
		);

		const state = readWorkState(repo);
		assert(
			!!state?.worktreeBranch && state.worktreeBranch === `fix/log-rotation@wf-${(state.workRunId ?? "").slice(0, 8)}`,
			`semantic branch <name>@wf-<8hex> created (got ${state?.worktreeBranch})`,
		);
		assert(fs.existsSync(state.worktreePath), "worktree dir exists");

		const kickoffs = result.perPrompt[0].events.filter(
			(e) => e.type === "message_end" && e.message?.role === "user",
			);
		assert(
			kickoffs.some((e) => e.message?.content?.[0]?.text === "修复日志轮转任务"),
			"kickoff message carries the parsed task body verbatim",
			);
		const nameEvent = result.perPrompt[0].events.find((e) => e.type === "session_info_changed");
		assert(
			!!nameEvent && nameEvent.name === "work: 修复日志轮转任务",
			"session named from the parsed task body",
		);
	} finally {
		cleanup();
	}
}

// ── Test 11: runtime failure + failed restore → resources kept + diagnostics ──
console.log("\n=== Test 11: RPC transition+restore failure keeps resources (unkeyed env) ===");
{
	const { repo, cleanup } = makeWorkRepo("pi-wf-rpc-work11-");
	try {
		// Unkeyed RPC_ENV: model application fails for BOTH the work transition
		// and the explore restore, exercising the keep-resources branch.
		const result = await runRpcSequence(
			RPC_ARGS,
			["/workflow:work --worktree"],
			repo,
			RPC_ENV,
			{ timeoutMs: 25000 },
		);

		const notifies = notifiesOf(result.perPrompt[0]);
		const failNotify = notifies.find((m) => m.includes("进入 Work Mode 失败"));
		assert(!!failNotify, "failure notify emitted");
		if (failNotify) {
			assert(failNotify.includes("恢复原状态失败"), "notify reports the failed restore");
			assert(failNotify.includes("已保留本次创建的 worktree"), "notify names the retained worktree");
			assert(failNotify.includes("/workflow:status") && failNotify.includes("/workflow:reset"), "notify lists recovery entries");
		}

		const state = readWorkState(repo);
		assert(!!state && state.mode !== "work", "state restored away from work mode");
		assert(!state?.worktreePath && !state?.worktreeBranch, "persisted state holds no dangling worktree fields");
		assert(worktreeDirs(repo).length === 1, "worktree dir retained on failed restore");
		const dirs = worktreeDirs(repo);
		if (dirs.length === 1) {
			const wtPath = path.join(path.dirname(repo), dirs[0]);
			assert(fs.existsSync(wtPath), "retained worktree dir exists on disk");
		}
	} finally {
		cleanup();
	}
}

// ── Test 12: failed transition + successful restore → created worktree cleaned ──
console.log("\n=== Test 12: RPC restore-success cleanup removes only this call's worktree ===");
{
	const { repo, cleanup } = makeWorkRepo("pi-wf-rpc-work12-");
	try {
		// Project config breaks ONLY the work role model: the work transition
		// fails at model resolution while the explore restore succeeds. Project
		// trust passes via --approve.
		const wfDir = path.join(repo, ".pi", "workflow");
		fs.mkdirSync(wfDir, { recursive: true });
		fs.writeFileSync(
			path.join(wfDir, "config.json"),
			JSON.stringify({ models: { work: { provider: "nonexistent", model: "ghost" } } }, null, 2),
			"utf8",
			);

		const result = await runRpcSequence(
			[...RPC_ARGS, "--approve"],
			["/workflow:work --worktree"],
			repo,
			RPC_ENV_KEYED,
			{ timeoutMs: 25000 },
			);

		const notifies = notifiesOf(result.perPrompt[0]);
		assert(
			notifies.some((m) => m.includes("找不到模型：nonexistent/ghost")),
			"work transition fails at model resolution (injected)",
		);
		const failNotify = notifies.find((m) => m.includes("进入 Work Mode 失败"));
		assert(!!failNotify, "failure notify emitted");
		assert(
			!!failNotify && failNotify.includes("已恢复原 workflow 状态") && !failNotify.includes("已保留本次创建的"),
			"notify reports a verified restore (no retained-residue wording)",
		);

		const state = readWorkState(repo);
		assert(!!state && state.mode === "explore", "state restored to the prior mode");
		assert(!state?.worktreePath && !state?.worktreeBranch, "restored state has no worktree fields");
		assert(worktreeDirs(repo).length === 0, "this call's worktree dir removed after verified restore");
	} finally {
		cleanup();
	}
}

// ── Test 13: source-level wiring of the work command (supplementary) ──
console.log("\n=== Test 13: /workflow:work source wiring ===");
{
	const commandsSrc = fs.readFileSync(path.join(REPO, "extensions/workflow/commands.ts"), "utf8");
	const worktreeSrc = fs.readFileSync(path.join(REPO, "extensions/workflow/worktree.ts"), "utf8");
	assert(
		worktreeSrc.includes("export function parseWorkCommandArgs") &&
			worktreeSrc.includes("export function removeCreatedWorktree") &&
			worktreeSrc.includes("WorktreeCleanupOutcome"),
		"worktree.ts exports the parse + diagnosable-cleanup facilities",
	);
	assert(
		commandsSrc.includes("parseWorkCommandArgs(args ?? \"\")") &&
			commandsSrc.includes("const created = createWorktree(ctx.cwd, workRunId, semanticBranch)"),
		"work command parses args and creates via the shared git helper",
	);
	assert(
		/removeCreatedWorktree\([\s\S]*?createdWorktree\.path/.test(commandsSrc),
		"rollback cleans only the worktree created by this invocation",
	);
	assert(
		commandsSrc.includes('wantWorktree && current.mode === "init"'),
		"worktree creation is refused in Init Mode",
	);
	const workBlock = commandsSrc.slice(
		commandsSrc.indexOf("registerCommand(\"workflow:work\""),
		commandsSrc.indexOf("// registerWorkflowReviewCommand"),
	);
	assert(!workBlock.includes("ctx.ui.select"), "work entry has no interactive execution-mode dialog");
	assert(
		workBlock.includes("workStartEntryId") && workBlock.includes("approvedTodos: undefined"),
		"Direct Work requirement boundary preserved",
	);
}

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);
