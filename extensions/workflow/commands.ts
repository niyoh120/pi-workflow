import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import { getSessionKey, loadState, saveState, readPlan } from "./state.js";
import { loadConfig } from "./config.js";
import { COMMON_PROMPT, promptForMode } from "./prompts.js";
import { isWorkflowDataPath, isReadonlyMode, isLocalFileMutatingShell, isAllowedPlanScratchPath } from "./guards.js";
import { currentStatusText, todoText } from "./helpers.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { planDir } from "./paths.js";
import {
  activateWorkflowToolsIfAllowed,
  applyModeRuntime,
  setCurrentTurnGuardMode,
  getCurrentTurnGuardMode,
  clearCurrentTurnGuardMode,
} from "./mode.js";
import { execSync } from "node:child_process";
import path from "node:path";
import { hasInitialCommit, gitRepoPreflight as gitRepoPreflightFn, createWorkBaseline, captureBaselineUntracked, clearWorkBaseline } from "./baseline.js";

// ── /wf-init helpers ─────────────────────────────────────────────────────────

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getGitRoot(cwd: string): string {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
    })
      .toString()
      .trim();
    return root;
  } catch {
    return cwd;
  }
}

function findExistingAgentsFile(root: string): string | null {
  const agMd = path.join(root, "AGENTS.md");
  const agMdLower = path.join(root, "agents.md");
  if (fs.existsSync(agMd)) return "AGENTS.md";
  if (fs.existsSync(agMdLower)) return "agents.md";
  return null;
}

function isProjectEmpty(root: string): boolean {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const meaningful = entries.filter((e) => !e.name.startsWith("."));
  return meaningful.length === 0;
}

// ── OCR CLI helpers ──────────────────────────────────────────────────────────

/** Check whether the `ocr` CLI is available in PATH or at a configured path. */
function checkOcrAvailable(binary: string): boolean {
  try {
    execSync(`${binary} version`, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Run `ocr review` CLI and return its stdout. */
function runOcrReview(
  binary: string,
  cwd: string,
  fromRef: string,
  timeoutMs: number,
): string {
  const args = ["review", "--from", fromRef, "--to", "HEAD"];
  return execSync(`${binary} ${args.join(" ")}`, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
  }).toString();
}

/**
 * Parse OCR output into a structured format compatible with workflow's
 * Critical/Important/Minor severity classification.
 *
 * OCR produces line-level comments and a summary. We extract severity
 * from the comment category labels when present, and map:
 *   Security/Defect → Critical
 *   Maintainability/Quality → Important
 *   everything else → Minor
 *
 * If OCR output doesn't have structured categories, we fall back to
 * delivering the raw text directly.
 */
function parseOcrOutput(raw: string): {
  hasCritical: boolean;
  hasImportant: boolean;
  formatted: string;
} {
  // OCR output is typically a structured report with line comments.
  // For now, deliver it as-is and let the executor model classify severity.
  // A more sophisticated parser can be added later based on OCR's JSON output format.
  const lines = raw.split("\n");
  let hasCritical = false;
  let hasImportant = false;

  // Heuristic: check for common severity indicators in OCR output
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/\b(security|critical|bug|defect|npe|dead\s*loop|sql\s*injection|xss|buffer\s*overflow)\b/.test(lower)) {
      hasCritical = true;
    }
    if (/\b(important|maintainability|quality|error\s*handling|edge\s*case|test\s*gap)\b/.test(lower)) {
      hasImportant = true;
    }
  }

  return { hasCritical, hasImportant, formatted: raw };
}

// ── Session key helper ───────────────────────────────────────────────────────

/**
 * Extract session key from ctx, bridging the ReadonlySessionManager → SessionKeySource gap.
 * ReadonlySessionManager.getSessionFile returns string | undefined,
 * but SessionKeySource expects string | null.
 */
function ctxSessionKey(ctx: any): string {
  return getSessionKey({
    getSessionId: () => ctx.sessionManager?.getSessionId?.(),
    getSessionFile: () => ctx.sessionManager?.getSessionFile?.() ?? null,
  });
}

// ── Event handlers ────────────────────────────────────────────────────────────

export function registerBeforeAgentStart(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionKey = ctxSessionKey(ctx);

    activateWorkflowToolsIfAllowed(pi, ctx.cwd, getAgentDir);

    // Hide done items at the start of each new turn.
    const overlay = getWorkflowOverlay();
    if (overlay) {
      overlay.hideDoneFromLastTurn();
    }

    // Load current state
    const state = loadState(ctx.cwd, sessionKey);

    // Set per-turn guard mode from persisted state
    if (state.mode !== "idle") {
      setCurrentTurnGuardMode(sessionKey, state.mode);
    }

    // Overlay setup
    if (overlay) {
      if (state.mode === "idle") {
        overlay.dispose();
        return;
      }
      overlay.update(state.todos);
    }

    if (state.mode === "idle") return;

    // Apply mode runtime (model/tools/status) for non-idle modes
    await applyModeRuntime(pi, ctx, state.mode, getAgentDir);

    // Inject system prompt
    const modePrompt = promptForMode(state.mode);
    if (!modePrompt) return;

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        COMMON_PROMPT +
        "\n\n" +
        modePrompt +
        "\n\n" +
        `# Current Workflow State\n` +
        currentStatusText(state) +
        "\n",
    };
  });
}

export function registerToolCallGuard(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.on("tool_call", async (event, ctx) => {
    const sessionKey = ctxSessionKey(ctx);
    const state = loadState(ctx.cwd, sessionKey);

    // Allow workflow's own tools through.
    if (
      event.toolName === "workflow_plan" ||
      event.toolName === "workflow_todo" ||
      event.toolName === "workflow_subagent"
    ) {
      return;
    }

    // Use per-turn effective guard mode; fall back to state mode.
    const effectiveMode = getCurrentTurnGuardMode(sessionKey) ?? state.mode;

    // ── Plan directory protection: block write/edit to .pi/workflow/plan/ in all modes ──
    if (event.toolName === "write" || event.toolName === "edit") {
      const targetPath: string | undefined =
        (event.input as any)?.path ?? (event.input as any)?.filePath;

      if (targetPath) {
        // Block writes to .pi/workflow/ data directory
        if (isWorkflowDataPath(targetPath, ctx.cwd)) {
          return {
            block: true,
            reason:
              "Workflow data files (.pi/workflow/) must be operated via workflow tools, not with write/edit.",
          };
        }

        // Block writes to plan directory specifically
        const resolved = path.resolve(ctx.cwd, targetPath);
        const planDirAbs = path.resolve(ctx.cwd, ".pi", "workflow", "plan");
        if (resolved.startsWith(planDirAbs + path.sep) || resolved === planDirAbs) {
          return {
            block: true,
            reason:
              "Plan files (.pi/workflow/plan/) must be updated via workflow_plan(action='save', markdown='完整计划内容'), " +
              "not with write/edit.",
          };
        }
      }
    }

    // Read-only modes: block local file mutations.
    if (isReadonlyMode(effectiveMode)) {
      if (event.toolName === "read") {
        const filePath: string | undefined =
          (event.input as any)?.path ?? (event.input as any)?.filePath;

        if (filePath && isWorkflowDataPath(filePath, ctx.cwd)) {
          return {
            block: true,
            reason: "Workflow data files (.pi/workflow/) must be read via workflow tools, not directly.",
          };
        }
        return;
      }

      if (event.toolName === "write" || event.toolName === "edit") {
        if (effectiveMode === "plan") {
          const targetPath: string | undefined =
            (event.input as any)?.path ?? (event.input as any)?.filePath;
          if (!targetPath) {
            return {
              block: true,
              reason: "Plan Mode: write/edit requires an absolute path under the scratch root.",
            };
          }
          const denial = isAllowedPlanScratchPath(ctx.cwd, targetPath);
          if (denial) {
            return { block: true, reason: `Plan Mode: ${denial}` };
          }
          return;
        }

        return {
          block: true,
          reason: `当前是 ${effectiveMode}，禁止修改本地文件。联网搜索、读取、分析工具仍可使用。`,
        };
      }

      if (event.toolName === "bash") {
        const command = String(event.input?.command ?? "");

        if (isLocalFileMutatingShell(command)) {
          return {
            block: true,
            reason: `当前是 ${effectiveMode}，禁止执行会修改本地文件的 shell 命令：${command}`,
          };
        }
      }

      return;
    }

    // Commit mode: prevent direct code file edits.
    if (state.mode === "commit") {
      if (event.toolName === "write" || event.toolName === "edit") {
        return {
          block: true,
          reason: "Commit Mode 禁止修改代码文件。",
        };
      }

      return;
    }
  });
}

export function registerAgentEnd(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.on("agent_end", async (event, ctx) => {
    const sessionKey = ctxSessionKey(ctx);
    const state = loadState(ctx.cwd, sessionKey);

    // Clean up per-turn in-memory state.
    clearCurrentTurnGuardMode(sessionKey);

    // Update overlay with current todos
    const overlay = getWorkflowOverlay();
    if (overlay && state.mode !== "idle") {
      overlay.update(state.todos);
    }
  });
}

// ── Command registrations ────────────────────────────────────────────────────

export function registerPlanCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("plan", {
    description: "进入计划模式：头脑风暴、产出计划、等待确认",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = ctxSessionKey(ctx);

      const state: WorkflowState = {
        ...DEFAULT_STATE,
        mode: "plan",
        planRunId: crypto.randomUUID(),
      };
      saveState(ctx.cwd, sessionKey, state);

      const overlay = getWorkflowOverlay();
      if (overlay) {
        overlay.clearBookkeeping();
        overlay.update(state.todos);
      }

      const ok = await applyModeRuntime(pi, ctx, "plan", getAgentDir);
      if (!ok) return;

      ctx.ui.notify(
        "已进入 Plan Mode。直接描述需求；产出计划并确认后会自动转交 Work Mode。",
        "info"
      );
    },
  });
}

export function registerWorkCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("work", {
    description: "跳过计划，直接进入 Work Mode",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = ctxSessionKey(ctx);

      const workArgs = args.trim();

      const state: WorkflowState = {
        ...DEFAULT_STATE,
        mode: "work",
        workRunId: crypto.randomUUID(),
        workBaselineRef: createWorkBaseline(ctx.cwd),
        workBaselineUntracked: captureBaselineUntracked(ctx.cwd),
      };
      saveState(ctx.cwd, sessionKey, state);

      const overlay = getWorkflowOverlay();
      if (overlay) {
        overlay.clearBookkeeping();
        overlay.update(state.todos);
      }

      const ok = await applyModeRuntime(pi, ctx, "work", getAgentDir);
      if (!ok) return;

      ctx.ui.notify(
        "已进入 Work Mode。可以直接描述任务。",
        "info"
      );

      if (workArgs) {
        pi.sendUserMessage(workArgs);
      }
    },
  });
}

export function registerReviewCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("review", {
    description: "使用 alibaba/open-code-review (ocr) CLI 检查当前 diff",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = ctxSessionKey(ctx);
      const state = loadState(ctx.cwd, sessionKey);
      const config = loadConfig(ctx.cwd, getAgentDir());

      // 1. Git repo check
      if (!gitRepoPreflightFn(ctx.cwd, ctx)) {
        ctx.ui.notify("Code review aborted: no git repo.", "warning");
        return;
      }

      if (!hasInitialCommit(ctx.cwd)) {
        ctx.ui.notify("Code review aborted: no HEAD commit to diff against. Commit at least once first.", "warning");
        return;
      }

      // 2. Check OCR availability
      const ocrBinary = config.codeReview.ocrBinary ?? "ocr";
      if (!checkOcrAvailable(ocrBinary)) {
        ctx.ui.notify(
          `ocr CLI not found. Install alibaba/open-code-review:\n` +
          `  https://github.com/alibaba/open-code-review\n` +
          `  Download binary or: go install github.com/alibaba/open-code-review/cmd/ocr@latest`,
          "error"
        );
        pi.sendUserMessage(
          "Code review 无法执行：ocr CLI 未安装。\n" +
          "请安装 alibaba/open-code-review 后再运行 /review。\n" +
          "安装指南：https://github.com/alibaba/open-code-review#install"
        );
        return;
      }

      // 3. Determine baseline ref
      const fromRef = state.workBaselineRef ?? "HEAD~1";

      ctx.ui.notify(`正在运行 ocr review (--from ${fromRef} --to HEAD)...`, "info");

      // 4. Run OCR review
      const timeoutMs = config.codeReview.timeoutMs ?? 300_000;
      try {
        const rawOutput = runOcrReview(ocrBinary, ctx.cwd, fromRef, timeoutMs);
        const parsed = parseOcrOutput(rawOutput);

        // 5. Deliver results
        ctx.ui.notify(
          parsed.hasCritical ? "Code review 发现 Critical 问题。" :
          parsed.hasImportant ? "Code review 发现 Important 问题。" :
          "Code review 完成。",
          parsed.hasCritical ? "warning" : "info"
        );

        pi.sendUserMessage(
          `Code Review Result (via ocr review --from ${fromRef} --to HEAD):\n\n${parsed.formatted || "(empty output)"}`
        );
      } catch (err: any) {
        const errMsg = err?.message ?? String(err);
        const stderr = err?.stderr ?? "";
        ctx.ui.notify(`ocr review 执行失败: ${errMsg}`, "error");
        pi.sendUserMessage(
          `Code review 执行失败。\n\n错误：${errMsg}\nstderr：${stderr.slice(0, 2000)}\n\n` +
          `请检查 ocr 配置和 LLM 连接。运行 ocr llm test 验证 LLM 连通性。`
        );
      }
    },
  });
}

export function registerCommitCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("commit", {
    description: "切到 commit 模型，根据当前 diff 生成 commit message 并直接提交",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = ctxSessionKey(ctx);

      const state = {
        ...loadState(ctx.cwd, sessionKey),
        mode: "commit" as const,
      };

      // Clear baseline — after commit, the diff context changes.
      clearWorkBaseline(state);
      saveState(ctx.cwd, sessionKey, state);

      const ok = await applyModeRuntime(pi, ctx, "commit", getAgentDir);
      if (!ok) return;

      const extra = args.trim()
        ? `\n\n用户对 commit 的额外要求：${args.trim()}`
        : "";

      pi.sendUserMessage(
        `请查看当前 diff，生成合适的 commit message，并直接执行 git add 和 git commit。${extra}`
      );
    },
  });
}

export function registerWfStatusCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("wf-status", {
    description: "显示当前轻量 workflow 状态",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = ctxSessionKey(ctx);

      const state = loadState(ctx.cwd, sessionKey);

      let msg = currentStatusText(state);
      ctx.ui.notify(msg, "info");
    },
  });
}

export function registerWfExitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("wf-exit", {
    description: "退出 workflow mode，恢复普通 Pi",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = ctxSessionKey(ctx);

      const state = loadState(ctx.cwd, sessionKey);
      state.mode = "idle";
      saveState(ctx.cwd, sessionKey, state);

      const overlay = getWorkflowOverlay();
      if (overlay) overlay.dispose();

      ctx.ui.setStatus("lite-sp", undefined);
      ctx.ui.notify("已退出 workflow mode。", "info");
    },
  });
}

export function registerWfResetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("wf-reset", {
    description: "清空 workflow 状态、plan 目录和 todo",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = ctxSessionKey(ctx);

      const state: WorkflowState = { ...DEFAULT_STATE };
      saveState(ctx.cwd, sessionKey, state);

      const overlay = getWorkflowOverlay();
      if (overlay) overlay.dispose();

      const pdir = planDir(ctx.cwd);
      if (fs.existsSync(pdir)) {
        for (const entry of fs.readdirSync(pdir)) {
          fs.rmSync(path.join(pdir, entry));
        }
      }

      ctx.ui.setStatus("lite-sp", undefined);
      ctx.ui.notify("已清空 workflow 状态。", "info");
    },
  });
}

export function registerWfInitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("wf-init", {
    description:
      "初始化 agent 工作区：确保 git 仓库存在，生成/更新 AGENTS.md",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      if (!isGitRepo(ctx.cwd)) {
        ctx.ui.notify("当前目录不是 git 仓库，正在执行 git init...", "info");
        try {
          execSync("git init", { cwd: ctx.cwd, stdio: "pipe" });
          ctx.ui.notify("git init 完成。", "info");
        } catch (err: any) {
          ctx.ui.notify(
            `git init 失败：${err?.stderr ?? err?.message ?? String(err)}`,
            "error"
          );
          return;
        }
      }

      const root = getGitRoot(ctx.cwd);
      const existingFile = findExistingAgentsFile(root);

      if (existingFile) {
        const filePath = path.join(root, existingFile);
        pi.sendUserMessage(
          `当前仓库已存在 ${existingFile} (${filePath})。\n\n` +
            `是否需要更新 AGENTS.md？如果需要，请回复确认，` +
            `我会读取当前的 ${existingFile} 内容和项目上下文，帮你更新内容。\n\n` +
            `确认前不会修改已有文件。`
        );
        return;
      }

      if (isProjectEmpty(root)) {
        pi.sendUserMessage(
          `当前仓库还没有实质项目文件。在生成 AGENTS.md 之前，请先回答以下问题：\n\n` +
            `1. 项目使用的编程语言/框架是什么？\n` +
            `2. 项目的代码风格/规范（例如 eslint、prettier、rustfmt 等）？\n` +
            `3. 如何构建和运行测试（例如 npm test、cargo test、pytest 等）？\n` +
            `4. 提交信息需要遵循什么规范（例如 conventional commits）？\n` +
            `5. 其他需要 agent 遵守的约定或限制？\n\n` +
            `了解这些信息后，我会在仓库根目录生成 AGENTS.md。`
        );
        return;
      }

      const rootRel =
        root === ctx.cwd ? "仓库根目录" : `仓库根目录 (${root})`;
      pi.sendUserMessage(
        `请在 ${rootRel} 生成 AGENTS.md。\n\n` +
          `请先探索项目上下文：README、docs、package/build/test 配置、目录结构、相关源码等，` +
          `然后生成一份适合该项目的 AGENTS.md，内容至少包含：\n` +
          `- 项目概述\n` +
          `- 构建/测试命令\n` +
          `- 代码风格/规范\n` +
          `- 目录约定\n` +
          `- 工作流规则（v2 模式：idle/plan/work/commit）\n` +
          `- 提交规范\n` +
          `- 安全/禁止事项\n\n` +
          `使用 write 工具将内容写入 ${path.join(root, "AGENTS.md")}。`
      );
    },
  });
}