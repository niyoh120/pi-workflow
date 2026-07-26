/**
 * RPC / JSON / print integration fixtures for pi-workflow.
 *
 * Drives the real Pi binary in RPC and print modes with a throwaway cwd so
 * no real session/state/config is touched. No API key or model calls are
 * needed: extension commands run without an agent turn, and we ignore
 * unrelated setStatus / model-unavailable notify events.
 *
 * Run: node scripts/validate-rpc-mode.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

// ── Setup throwaway project ────────────────────────────────────────────────

const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-"));
const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-agent-"));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-rpc-home-"));

// Enable workflow.autoEnter via a global config so /wf-status is registered
// without needing an interactive /wf first. Global config lives under the
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

// ── Test 1: RPC /wf-status emits an effective-config notify ─────────────────
console.log("=== Test 1: RPC /wf-status effective-config notify ===");
{
	const baseArgs = [
		"--mode", "rpc",
		"--offline",
		"--no-session",
		"--no-extensions",
		"-e", EXT,
	];
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: tmpAgent,
		HOME: tmpHome,
		PI_OFFLINE: "1",
	};

	let result;
	try {
		result = await runRpcPrompt(baseArgs, "/wf-status", tmpCwd, env, { timeoutMs: 15000 });
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
			"RPC /wf-status emits a notify containing 'Effective Config'",
		);
		if (statusNotify) {
			assert(
				statusNotify.message.includes("projectConfig:"),
				"/wf-status notify includes projectConfig trust line",
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
		assert(!!response && response.success === true, "RPC /wf-status prompt accepted");
	}
}

console.log(`\n${runs - failures}/${runs} checks passed.`);
if (failures > 0) process.exit(1);