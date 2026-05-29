import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelSpec, SubagentConfig, SubagentRole } from "./types.js";
import { isReviewAgentAvailable, reviewAgentMissingHint } from "./agents.js";

// ── Public result type (backward-compatible shape) ──

export interface SubagentResult {
  role: string;
  model: string | null;
  text: string;
  stopReason: string | null;
  exitCode: number;
  usage: { input: number; output: number; turns: number };
  stderr: string;
  statusMarker?: "PASS" | "FAIL" | null;
  /** Child agent id when known (populated after successful spawn). */
  agentId?: string;
  /** Subagent wall-clock duration in ms (derived from pi-subagents event). */
  durationMs?: number;
  /** Raw terminal status string from the pi-subagents completion/failure event. */
  eventStatus?: string;
}

// ── RPC reply shape (from pi-subagents cross-extension RPC) ──

interface RpcReply<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

interface SpawnReplyData {
  id: string;
}

// ── Completion event payload ──

interface CompletionEvent {
  id: string;
  type: string;
  description: string;
  result?: string;
  error?: string;
  status: string;
  toolUses: number;
  durationMs: number;
  tokens?: { input: number; output: number; total: number };
}

// ── Status marker extraction ─────────────────────

export function extractStatusMarker(text: string): "PASS" | "FAIL" | null {
  const planMatch = text.match(/PLAN_REVIEW_STATUS:\s*(PASS|FAIL)/);
  if (planMatch) return planMatch[1] as "PASS" | "FAIL";
  const reviewMatch = text.match(/REVIEW_STATUS:\s*(PASS|FAIL)/);
  if (reviewMatch) return reviewMatch[1] as "PASS" | "FAIL";
  return null;
}

// ── Error classes ────────────────────────────────

export class SubagentNotAvailableError extends Error {
  constructor(message?: string) {
    super(message ?? "pi-subagents extension is not available.");
    this.name = "SubagentNotAvailableError";
  }
}

export class SubagentSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentSpawnError";
  }
}

export class SubagentTimeoutError extends Error {
  public readonly agentId: string;
  constructor(agentId: string, timeoutMs: number) {
    super(`Subagent ${agentId} timed out after ${timeoutMs}ms.`);
    this.name = "SubagentTimeoutError";
    this.agentId = agentId;
  }
}

// ── Internal diagnostic formatter (not a public API contract) ──

/**
 * Build a human-readable failure summary from a SubagentResult.
 *
 * This is an internal helper — the string it produces is used in UI
 * notifications, plan review notes, and workflow_subagent tool error
 * content.  It must always return a string and must tolerate missing
 * optional fields.
 */
export function formatSubagentFailure(result: SubagentResult): string {
  const parts: string[] = [];

  // Header
  parts.push(`Subagent "${result.role}" failed (exit ${result.exitCode}).`);

  // Optional metadata (additive-only — consumers of details.result are unaffected)
  if (result.agentId) parts.push(`Agent ID: ${result.agentId}.`);
  if (result.model) parts.push(`Model: ${result.model}.`);
  if (result.eventStatus) parts.push(`Status: ${result.eventStatus}.`);
  if (result.durationMs != null) parts.push(`Duration: ${result.durationMs}ms.`);

  // stderr carries raw error detail
  const stderrTrimmed = (result.stderr ?? "").trim().slice(0, 500);
  if (stderrTrimmed) parts.push(`stderr: ${stderrTrimmed}`);

  // text for exitCode != 0 is usually an explanation (identity-marker validation, etc.)
  const textTrimmed = (result.text ?? "").trim().slice(0, 1000);
  if (result.exitCode !== 0 && textTrimmed) {
    const prefix = result.exitCode === 2 ? "Validation result: " : "Result: ";
    parts.push(`${prefix}${textTrimmed}`);
  }

  return parts.join("\n");
}

// ── Subagents client ────────────────────────────

export interface SubagentsClient {
  /** Check whether pi-subagents was detected (lazy, runs ping on first check or spawn). */
  isAvailable(): boolean;
  /** Spawn a subagent in background and wait for completion. */
  run(opts: {
    role: SubagentRole;
    task: string;
    systemPrompt: string;
    instructions?: string;
    subagentConfig?: SubagentConfig;
    modelSpec: ModelSpec;
    signal?: AbortSignal;
    /** Working directory for preflight agent availability checks. */
    cwd?: string;
    /** Agent directory for preflight checks and global agent lookup. */
    agentDir?: string;
  }): Promise<SubagentResult>;
  /** Return the install/reload hint text. */
  installHint(): string;
}

export function createSubagentsClient(pi: ExtensionAPI): SubagentsClient {
  const defaultInstallHint =
    "Install @tintinweb/pi-subagents:\n  pi install npm:@tintinweb/pi-subagents\nThen reload or restart Pi.";

  // Lazy detection state
  let availabilityChecked = false;
  let available = false;

  function isAvailable(): boolean {
    return available;
  }

  /**
   * Ensure we've checked availability. Runs ping once the first time it's called.
   * Once detected as unavailable, never re-pings (extension won't appear mid-session).
   */
  async function ensureAvailability(timeoutMs = 5000): Promise<void> {
    if (availabilityChecked) {
      if (!available) throw new SubagentNotAvailableError(defaultInstallHint);
      return;
    }

    availabilityChecked = true;
    const version = await pingOnce(timeoutMs);
    available = version !== null;
    if (!available) throw new SubagentNotAvailableError(defaultInstallHint);
  }

  /**
   * Ping pi-subagents RPC channel. Returns the protocol version or null if unavailable.
   */
  function pingOnce(timeoutMs: number): Promise<number | null> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        unsub();
        resolve(null);
      }, timeoutMs);

      const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
        clearTimeout(timer);
        unsub();
        const reply = raw as RpcReply<{ version: number }>;
        resolve(reply.success ? (reply.data?.version ?? null) : null);
      });

      pi.events.emit("subagents:rpc:ping", { requestId });
    });
  }

  /**
   * Spawn a subagent via RPC and wait for its completion/failure event.
   */
  function spawnAndWait(opts: {
    type: string;
    prompt: string;
    description: string;
    signal?: AbortSignal;
    subagentConfig?: SubagentConfig;
    /** Additional runtime options to forward to pi-subagents RPC. */
    rpcOptions?: {
      model?: string;
      thinkingLevel?: string;
      maxTurns?: number;
    };
  }): Promise<{ agentId: string; result: CompletionEvent }> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();

      // Placeholders declared early so cleanup is safe to call from any path.
      let unsubCompleted: () => void = () => {};
      let unsubFailed: () => void = () => {};
      let unsubSpawnReply: () => void = () => {};

      // Track the real agent id so timeout errors include it when spawn already succeeded.
      let spawnedAgentId = "(unknown)";

      // Timeout
      const resultTimeoutMs = opts.subagentConfig?.resultTimeoutMs ?? 600_000;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      if (resultTimeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          cleanup();
          reject(new SubagentTimeoutError(spawnedAgentId, resultTimeoutMs));
        }, resultTimeoutMs);
      }

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unsubSpawnReply();
        unsubCompleted();
        unsubFailed();
        if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
      };

      // Abort signal from parent
      let onAbort: (() => void) | undefined;
      if (opts.signal) {
        onAbort = () => {
          cleanup();
          reject(new Error("Aborted by parent."));
        };
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Step 1: Wait for spawn reply
      unsubSpawnReply = pi.events.on(
        `subagents:rpc:spawn:reply:${requestId}`,
        (raw: unknown) => {
          unsubSpawnReply();
          const reply = raw as RpcReply<SpawnReplyData>;
          if (!reply.success || !reply.data?.id) {
            cleanup();
            reject(new SubagentSpawnError(reply.error ?? "RPC spawn failed."));
            return;
          }

          const agentId = reply.data.id;
          spawnedAgentId = agentId;

          // Step 2: Listen for completion/failure of this specific agentId
          unsubCompleted = pi.events.on("subagents:completed", (raw: unknown) => {
            const event = raw as CompletionEvent;
            if (event.id !== agentId) return;
            cleanup();
            resolve({ agentId, result: event });
          });

          unsubFailed = pi.events.on("subagents:failed", (raw: unknown) => {
            const event = raw as CompletionEvent;
            if (event.id !== agentId) return;
            cleanup();
            resolve({ agentId, result: event });
          });
        },
      );

      // Emit the spawn RPC
      pi.events.emit("subagents:rpc:spawn", {
        requestId,
        type: opts.type,
        prompt: opts.prompt,
        options: {
          description: opts.description,
          isBackground: true,
          model: opts.rpcOptions?.model,
          thinkingLevel: opts.rpcOptions?.thinkingLevel,
          maxTurns: opts.rpcOptions?.maxTurns,
        },
      });
    });
  }

  // Identity markers that bundled custom review agents must include in their output.
  // If the marker is missing, the agent may have fallen back to general-purpose.
  const IDENTITY_MARKERS: Partial<Record<SubagentRole, string>> = {
    planReview: "[pi-workflow-plan-review/v1]",
    review: "[pi-workflow-code-review/v1]",
  };

  /** Normalize a configured maxTurns value for RPC. */
  function normalizeConfiguredMaxTurns(n: number | undefined): number | undefined {
    if (n == null || n === 0) return undefined;
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.max(1, Math.floor(n));
  }

  async function run(opts: {
    role: SubagentRole;
    task: string;
    systemPrompt: string;
    instructions?: string;
    subagentConfig?: SubagentConfig;
    modelSpec: ModelSpec;
    signal?: AbortSignal;
    cwd?: string;
    agentDir?: string;
  }): Promise<SubagentResult> {
    // Lazy ping to detect availability (cached after first call).
    const pingTimeoutMs = opts.subagentConfig?.rpcTimeoutMs ?? 5000;
    await ensureAvailability(pingTimeoutMs);

    const subagentConfig = opts.subagentConfig;

    // Resolve agent type name: config override → default matching DEFAULT_CONFIG.
    const roleToType: Record<SubagentRole, string> = {
      planReview: subagentConfig?.agentTypes?.planReview ?? "pi-workflow-plan-review",
      review: subagentConfig?.agentTypes?.review ?? "pi-workflow-code-review",
      explore: subagentConfig?.agentTypes?.explore ?? "Explore",
    };
    const agentType = roleToType[opts.role];

    // ── Preflight: custom review agents must be discoverable ──
    const customReviewNames: SubagentRole[] = ["planReview", "review"];
    if (customReviewNames.includes(opts.role)) {
      const customName = agentType as "pi-workflow-plan-review" | "pi-workflow-code-review";
      const cwd = opts.cwd ?? process.cwd();
      const agentDir = opts.agentDir ?? "";

      if (!isReviewAgentAvailable(cwd, agentDir, customName)) {
        throw new SubagentNotAvailableError(
          `${reviewAgentMissingHint()}\n\nChecked:\n` +
          `  - ${cwd}/.pi/agents/${customName}.md\n` +
          `  - ${agentDir}/agents/${customName}.md`,
        );
      }
    }

    // Build full task: system prompt + instructions + task
    let prompt = `You are running as an isolated subagent.\n\n`;
    prompt += opts.systemPrompt;
    if (opts.instructions?.trim()) {
      prompt += `\n\n# Additional Instructions\n${opts.instructions.trim()}\n`;
    }
    prompt += `\n\n# Task\n${opts.task}`;

    const description = `wf-${opts.role}`;

    // Spawn in background and wait for result
    const { agentId, result: event } = await spawnAndWait({
      type: agentType,
      prompt,
      description,
      signal: opts.signal,
      subagentConfig,
      rpcOptions: {
        model: `${opts.modelSpec.provider}/${opts.modelSpec.model}`,
        thinkingLevel: opts.modelSpec.thinking,
        maxTurns: normalizeConfiguredMaxTurns(subagentConfig?.maxTurns?.[opts.role]),
      },
    });

    const isError = event.status === "error" || event.status === "stopped" || event.status === "aborted";
    const text = event.result ?? "";

    // ── Terminal error events: surface immediately, skip identity-marker validation ──
    if (isError) {
      const subagentResult: SubagentResult = {
        role: opts.role,
        model: event.type ? `${agentType}(${event.type})` : agentType,
        text,
        stopReason: event.status,
        exitCode: 1,
        usage: {
          input: event.tokens?.input ?? 0,
          output: event.tokens?.output ?? 0,
          turns: event.toolUses ?? 0,
        },
        stderr: event.error ?? `status: ${event.status}`,
        statusMarker: null,
        agentId,
        durationMs: event.durationMs,
        eventStatus: event.status,
      };
      return subagentResult;
    }

    // ── Identity marker validation for custom review agents (successful completions only) ──
    const expectedMarker = IDENTITY_MARKERS[opts.role];
    if (expectedMarker && !text.includes(expectedMarker)) {
      // Graceful degradation: if the output contains a valid status marker
      // (PLAN_REVIEW_STATUS or REVIEW_STATUS), the review was substantive.
      // Accept the result with a warning instead of hard-rejecting.
      const hasValidStatusMarker = extractStatusMarker(text) !== null;
      if (hasValidStatusMarker) {
        // Identity marker missing but review content is valid — accept with warning.
        // Let the normal success path proceed. Log for diagnostics.
        console.warn(`[pi-workflow] Identity marker "${expectedMarker}" missing in subagent output, but valid review content detected (status marker present). Accepting result with warning.`);
      } else {
        // No identity marker AND no valid status marker — hard reject.
        // The output is not a substantive review.
        const subagentResult: SubagentResult = {
          role: opts.role,
          model: event.type ? `${agentType}(${event.type})` : agentType,
          text: `Review result validation failed. The subagent output did not contain the ` +
            `required pi-workflow identity marker "${expectedMarker}" and no valid review status was found. ` +
            `This may mean the review agent was not correctly loaded or the review prompt was not applied. ` +
            `Try running /wf-install-subagents then /reload, and verify the review agent file includes the managed marker (<!-- managed-by: pi-workflow -->). ` +
            `Refusing to accept an untrusted or incorrectly prompted review result.`,
          stopReason: "identity_marker_missing",
          exitCode: 2,
          usage: { input: 0, output: 0, turns: 0 },
          stderr: `Identity marker "${expectedMarker}" not found in agent output and no valid status marker present.`,
          statusMarker: null,
          agentId,
          durationMs: event.durationMs,
          eventStatus: event.status,
        };
        return subagentResult;
      }
    }

    const subagentResult: SubagentResult = {
      role: opts.role,
      model: event.type ? `${agentType}(${event.type})` : agentType,
      text,
      stopReason: null,
      exitCode: 0,
      usage: {
        input: event.tokens?.input ?? 0,
        output: event.tokens?.output ?? 0,
        turns: event.toolUses ?? 0,
      },
      stderr: "",
      statusMarker: extractStatusMarker(text),
      agentId,
      durationMs: event.durationMs,
      eventStatus: event.status,
    };

    return subagentResult;
  }

  function installHint(): string {
    return defaultInstallHint;
  }

  return { isAvailable, run, installHint };
}
