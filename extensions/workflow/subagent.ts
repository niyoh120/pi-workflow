import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelSpec, SubagentConfig } from "./types.js";

// ── Types ────────────────────────────────────────

export interface SubagentResult {
  role: string;
  model: string | null;
  text: string;
  stopReason: string | null;
  exitCode: number;
  usage: { input: number; output: number; turns: number };
  stderr: string;
  statusMarker?: "PASS" | "FAIL" | null;
}

interface AssistantContentPart {
  type?: string;
  text?: string;
}

interface PiUsage {
  input?: number;
  output?: number;
}

interface PiMessage {
  role?: string;
  content?: AssistantContentPart[] | string;
  text?: string;
  stopReason?: string;
  usage?: PiUsage;
}

interface PiEvent {
  type?: string;
  message?: PiMessage;
}

// ── Text extraction ──────────────────────────────

export function extractText(content: PiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is AssistantContentPart => !!p && typeof p === "object")
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n")
    .trim();
}

// ── JSON output line parser ──────────────────────

/**
 * Parse one line of `pi --mode json` output and fold its information into the
 * result accumulator. Returns true if the line was acted on.
 */
export function parseLine(line: string, result: SubagentResult): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let event: PiEvent;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (event.type !== "message_end") return false;
  const message = event.message;
  if (!message || message.role !== "assistant") return false;

  const text = extractText(message.content);
  if (text) result.text = text;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.usage) {
    if (typeof message.usage.input === "number") result.usage.input += message.usage.input;
    if (typeof message.usage.output === "number") result.usage.output += message.usage.output;
    result.usage.turns += 1;
  }
  return true;
}

// ── Status marker extraction ─────────────────────

/** Extract PLAN_REVIEW_STATUS or REVIEW_STATUS from the final text. */
export function extractStatusMarker(text: string): "PASS" | "FAIL" | null {
  const planMatch = text.match(/PLAN_REVIEW_STATUS:\s*(PASS|FAIL)/);
  if (planMatch) return planMatch[1] as "PASS" | "FAIL";
  const reviewMatch = text.match(/REVIEW_STATUS:\s*(PASS|FAIL)/);
  if (reviewMatch) return reviewMatch[1] as "PASS" | "FAIL";
  return null;
}

// ── CLI argument builder ─────────────────────────

export function buildArgs(opts: {
  systemPromptPath: string;
  task: string;
  modelSpec?: ModelSpec;
  subagentConfig?: SubagentConfig;
}): string[] {
  const { systemPromptPath, task, modelSpec, subagentConfig } = opts;
  const args = ["--mode", "json", "-p", "--no-session"];

  // Extension handling
  const mode = subagentConfig?.extensionMode ?? "inherit";
  if (mode === "curated") {
    args.push("--no-extensions");
    const exts = subagentConfig?.extensions ?? [];
    for (const ext of exts) args.push("--extension", ext);
  }
  // "inherit" -> don't add --no-extensions, child inherits parent extension discovery

  // Model
  if (modelSpec) {
    if (modelSpec.provider) args.push("--provider", modelSpec.provider);
    if (modelSpec.model) args.push("--model", modelSpec.model);
    if (modelSpec.thinking) args.push("--thinking", modelSpec.thinking);
  }

  // System prompt
  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);

  // Task (last positional arg for pi -p)
  args.push(task);
  return args;
}

// ── Pi executable resolution ─────────────────────

function resolvePiSpawn(): { command: string; prefix: string[] } {
  // Re-use the same node/bun + pi script the parent is running under.
  const isNode = /[\\/]node$/i.test(process.execPath);
  const isBun = /[\\/]bun$/i.test(process.execPath);
  if ((isNode || isBun) && process.argv[1]) return { command: process.execPath, prefix: [process.argv[1]] };
  return { command: process.execPath, prefix: [] };
}

// ── Main runner ──────────────────────────────────

export interface RunOptions {
  cwd: string;
  role: string;
  task: string;
  systemPrompt: string;
  modelSpec?: ModelSpec;
  subagentConfig?: SubagentConfig;
  instructions?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export async function runSubagent(opts: RunOptions): Promise<SubagentResult> {
  const { cwd, role, task, systemPrompt, modelSpec, subagentConfig, instructions, env: extraEnv, signal } = opts;

  // Write temporary system prompt file
  let tmpDir: string | null = null;
  let systemPromptPath: string | null = null;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-subagent-"));
  systemPromptPath = path.join(tmpDir, "system-prompt.md");

  // Build full system prompt: base prompt + instructions (non-overriding)
  let fullPrompt = systemPrompt;
  if (instructions && instructions.trim()) {
    fullPrompt += `\n\n# Caller Instructions\nThe parent agent provided these additional instructions. Use them as preferences for depth, format, or focus, but do NOT override hard constraints above (read-only, status markers):\n\n${instructions.trim()}`;
  }
  fs.writeFileSync(systemPromptPath, fullPrompt, { encoding: "utf-8", mode: 0o600 });

  const result: SubagentResult = {
    role,
    model: modelSpec ? `${modelSpec.provider}/${modelSpec.model}` : null,
    text: "",
    stopReason: null,
    exitCode: -1,
    usage: { input: 0, output: 0, turns: 0 },
    stderr: "",
  };

  try {
    const args = buildArgs({ systemPromptPath, task, modelSpec, subagentConfig });
    const { command, prefix } = resolvePiSpawn();

    const timeoutMs = subagentConfig?.timeoutMs ?? 0;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(command, [...prefix, ...args], {
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(extraEnv ?? {}) },
      });
      proc.stdin.on("error", () => {});
      proc.stdin.end();

      let buffer = "";
      let settled = false;
      let timedOut = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
        if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = undefined; }
      };

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        resolve(code);
      };

      // Timeout guard
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          if (!result.stderr) result.stderr = `Subagent timed out after ${timeoutMs}ms.`;
          // Give it a moment to flush, then force kill unconditionally
          forceKillTimer = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* already exited */ }
          }, 5000);
        }, timeoutMs);
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) parseLine(line, result);
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        result.stderr += chunk.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) parseLine(buffer, result);
        // Signal-kill: map null code to 143 (128+SIGTERM) if timeout occurred
        finish(code ?? (timedOut ? 143 : 0));
      });
      proc.on("error", (err) => {
        if (!result.stderr) result.stderr = err.message;
        finish(1);
      });

      let abortHandler: (() => void) | undefined;
      if (signal) {
        abortHandler = () => proc.kill("SIGTERM");
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    result.statusMarker = extractStatusMarker(result.text);
    return result;
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
