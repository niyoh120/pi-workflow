import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadState, saveState } from "./state.js";
import { loadConfig } from "./config.js";
import { COMMON_PROMPT, promptForMode } from "./prompts.js";
import { isReadonlyMode, isLocalFileMutatingShell, isCommitAllowedShell, extractAssistantText } from "./guards.js";
import { currentStatusText } from "./helpers.js";
import type { Mode, WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { planDir } from "./paths.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Switch the model to the one configured for the given role,
 * ensure workflow tools are active, and update status line.
 */
async function setRole(
  pi: ExtensionAPI,
  ctx: any,
  role: string,
  getAgentDir: () => string
): Promise<boolean> {
  const config = loadConfig(ctx.cwd, getAgentDir());
  const spec = config.models[role];

  if (!spec) {
    ctx.ui.notify(`找不到 role 配置：${role}`, "error");
    return false;
  }

  const model = ctx.modelRegistry.find(spec.provider, spec.model);
  if (!model) {
    ctx.ui.notify(`找不到模型：${spec.provider}/${spec.model}`, "error");
    return false;
  }

  const ok = await pi.setModel(model);
  if (!ok) {
    ctx.ui.notify(
      `模型不可用或缺少 API key：${spec.provider}/${spec.model}`,
      "error"
    );
    return false;
  }

  if (spec.thinking) {
    pi.setThinkingLevel(spec.thinking);
  }

  ctx.ui.setStatus(
    "lite-sp-model",
    `${role}: ${spec.provider}/${spec.model}`
  );

  return true;
}

/** Ensure workflow_todo and workflow_plan are in the active tools set. */
function ensureWorkflowToolsActive(pi: ExtensionAPI): void {
  const active = pi.getActiveTools().map((tool: any) => {
    if (typeof tool === "string") return tool;
    return tool.name;
  });
  const next = new Set(active);
  next.add("workflow_todo");
  next.add("workflow_plan");
  pi.setActiveTools([...next]);
}

/** Switch to a new mode, update state, set role & tools. */
async function switchMode(
  pi: ExtensionAPI,
  ctx: any,
  mode: Mode,
  getAgentDir: () => string
): Promise<boolean> {
  const state = loadState(ctx.cwd);
  state.mode = mode;
  saveState(ctx.cwd, state);

  const roleMap: Record<string, string> = {
    planning: "plan",
    planReview: "planReview",
    work: "work",
    fix: "work",
    review: "review",
    commit: "commit",
  };
  const role = roleMap[mode];
  if (role && !(await setRole(pi, ctx, role, getAgentDir))) return false;

  ensureWorkflowToolsActive(pi);
  ctx.ui.setStatus("lite-sp", mode);

  return true;
}

/** Follow-up that transitions from planning to work based on current plan. */
async function startWorkerFromPlan(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string
): Promise<void> {
  const state = loadState(ctx.cwd);

  state.mode = "work";
  state.autoCodeReview = true;
  state.codeReviewLoops = 0;
  saveState(ctx.cwd, state);

  await switchMode(pi, ctx, "work", getAgentDir);

  const planPathText = state.planPath ?? "当前计划文件";

  pi.sendUserMessage(
    `按已确认计划实现。请先读取 ${planPathText} 和 workflow_todo，然后按 todo 顺序执行。`,
    { deliverAs: "followUp" }
  );
}

/** Follow-up that starts plan review on the current plan. */
async function startPlanReview(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string
): Promise<void> {
  const state = loadState(ctx.cwd);
  state.mode = "planReview";
  saveState(ctx.cwd, state);

  await switchMode(pi, ctx, "planReview", getAgentDir);

  const planPathText = state.planPath ?? "当前计划文件";

  pi.sendUserMessage(
    `请评审 ${planPathText}。只评审计划，不要实现。评审结束必须调用 workflow_plan 记录 review_pass 或 review_fail。`,
    { deliverAs: "followUp" }
  );
}

/** Follow-up that starts code review on the current diff. */
async function startCodeReview(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string
): Promise<void> {
  const state = loadState(ctx.cwd);
  state.mode = "review";
  saveState(ctx.cwd, state);

  await switchMode(pi, ctx, "review", getAgentDir);

  pi.sendUserMessage(
    "请评审当前工作区相对 HEAD 的修改。必须查看 git status 和 git diff，最后输出 REVIEW_STATUS。",
    { deliverAs: "followUp" }
  );
}

// ──────────────────────────────────────────────
// Event handlers registered by the extension
// ──────────────────────────────────────────────

/**
 * Register the "before_agent_start" hook:
 * - ensure workflow tools are active
 * - inject mode-specific system prompt and current state
 */
export function registerBeforeAgentStart(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const state = loadState(ctx.cwd);
    const config = loadConfig(ctx.cwd, getAgentDir());

    ensureWorkflowToolsActive(pi);

    if (state.mode === "idle") return;

    const modePrompt = promptForMode(state.mode);

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        COMMON_PROMPT +
        "\n\n" +
        modePrompt +
        "\n\n" +
        `# Current Workflow State\n` +
        `mode: ${state.mode}\n` +
        currentStatusText(config, state) +
        "\n",
    };
  });
}

/**
 * Register the "tool_call" hook:
 * - in readonly modes (planning / planReview / review): block writes and mutating shell commands
 * - in commit mode: only allow git status/diff/add/commit
 * - workflow_todo / workflow_plan are always allowed
 */
export function registerToolCallGuard(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.on("tool_call", async (event, ctx) => {
    const state = loadState(ctx.cwd);

    // Allow workflow's own tools through.
    if (
      event.toolName === "workflow_plan" ||
      event.toolName === "workflow_todo"
    ) {
      return;
    }

    // Read-only modes: block local file mutations.
    if (isReadonlyMode(state.mode)) {
      if (event.toolName === "write" || event.toolName === "edit") {
        return {
          block: true,
          reason: `当前是 ${state.mode}，禁止修改本地文件。联网搜索、读取、分析工具仍可使用。`,
        };
      }

      if (event.toolName === "bash") {
        const command = String(event.input?.command ?? "");

        if (isLocalFileMutatingShell(command)) {
          return {
            block: true,
            reason: `当前是 ${state.mode}，禁止执行会修改本地文件的 shell 命令：${command}`,
          };
        }
      }

      return;
    }

    // Commit mode: only git status/diff/add/commit allowed.
    if (state.mode === "commit") {
      if (event.toolName === "write" || event.toolName === "edit") {
        return {
          block: true,
          reason: "Commit Mode 禁止修改代码文件。",
        };
      }

      if (event.toolName === "bash") {
        const command = String(event.input?.command ?? "");

        if (!isCommitAllowedShell(command)) {
          return {
            block: true,
            reason:
              `Commit Mode 只允许 git status/diff/add/commit/log/show。` +
              `被拦截：${command}`,
          };
        }
      }

      return;
    }

    // Work / Fix / Idle: no extra restrictions.
  });
}

/**
 * Register the "agent_end" hook:
 * - plan → plan review (auto if enabled)
 * - plan review → back to planning with feedback
 * - work → auto code review if worker signals READY_FOR_REVIEW
 * - code review → fix or idle depending on result
 */
export function registerAgentEnd(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.on("agent_end", async (event, ctx) => {
    const state = loadState(ctx.cwd);
    const config = loadConfig(ctx.cwd, getAgentDir());
    const text = extractAssistantText(event);

    if (state.mode === "planning") {
      if (
        config.planReview.enabled &&
        state.planPath &&
        state.planReviewStatus === "pending" &&
        state.planReviewLoops < config.planReview.maxLoops
      ) {
        await startPlanReview(pi, ctx, getAgentDir);
        return;
      }

      if (state.planApproved) {
        await startWorkerFromPlan(pi, ctx, getAgentDir);
        return;
      }
    }

    if (state.mode === "planReview") {
      if (state.planReviewStatus === "pass") {
        state.mode = "planning";
        saveState(ctx.cwd, state);

        await switchMode(pi, ctx, "planning", getAgentDir);

        pi.sendUserMessage(
          '计划评审已通过。请向用户展示最终计划摘要，并等待用户确认。用户确认后调用 workflow_plan(action="approve")。',
          { deliverAs: "followUp" }
        );
        return;
      }

      if (state.planReviewStatus === "fail") {
        state.mode = "planning";
        saveState(ctx.cwd, state);

        await switchMode(pi, ctx, "planning", getAgentDir);

        if (state.planReviewLoops >= config.planReview.maxLoops) {
          pi.sendUserMessage(
            `计划评审未通过，且已达到最大评审轮数。请向用户展示评审意见并等待用户决定。\n\n评审意见：\n${state.planReviewNotes ?? ""}`,
            { deliverAs: "followUp" }
          );
          return;
        }

        pi.sendUserMessage(
          `计划评审未通过。请根据以下意见修订计划，并重新调用 workflow_plan(action="save") 保存。\n\n评审意见：\n${state.planReviewNotes ?? ""}`,
          { deliverAs: "followUp" }
        );
        return;
      }
    }

    if (
      (state.mode === "work" || state.mode === "fix") &&
      state.autoCodeReview &&
      config.codeReview.enabled
    ) {
      if (text.includes("WORK_STATUS: BLOCKED")) {
        state.autoCodeReview = false;
        saveState(ctx.cwd, state);
        ctx.ui.notify("Worker blocked，已停止自动 review。", "warning");
        return;
      }

      if (text.includes("WORK_STATUS: READY_FOR_REVIEW")) {
        await startCodeReview(pi, ctx, getAgentDir);
        return;
      }

      ctx.ui.notify(
        "Worker 没有输出 WORK_STATUS，未自动进入 review。你可以手动 /review。",
        "warning"
      );
      return;
    }

    if (state.mode === "review" && state.autoCodeReview) {
      if (text.includes("REVIEW_STATUS: PASS")) {
        state.mode = "idle";
        state.autoCodeReview = false;
        saveState(ctx.cwd, state);

        ctx.ui.setStatus("lite-sp", "review passed");
        ctx.ui.notify("代码评审通过。现在你可以手动跑测试，确认后 /commit。", "info");
        return;
      }

      if (text.includes("REVIEW_STATUS: FAIL")) {
        state.codeReviewLoops += 1;

        if (state.codeReviewLoops > config.codeReview.maxLoops) {
          state.mode = "idle";
          state.autoCodeReview = false;
          saveState(ctx.cwd, state);

          ctx.ui.setStatus("lite-sp", "review stopped");
          ctx.ui.notify("达到最大 code review 修复轮数，请手动介入。", "warning");
          return;
        }

        state.mode = "fix";
        saveState(ctx.cwd, state);

        await switchMode(pi, ctx, "fix", getAgentDir);

        pi.sendUserMessage(
          "请只修复上一轮 reviewer 指出的 Critical / Important 问题。修复后运行相关测试，并以 WORK_STATUS 结束。",
          { deliverAs: "followUp" }
        );
        return;
      }

      ctx.ui.notify("Reviewer 没有输出 REVIEW_STATUS，自动循环停止。", "warning");
      state.autoCodeReview = false;
      saveState(ctx.cwd, state);
    }
  });
}

// ──────────────────────────────────────────────
// Command registrations
// ──────────────────────────────────────────────

/** Register the /plan command. */
export function registerPlanCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("plan", {
    description: "进入计划模式：头脑风暴、产出计划、等待确认",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const state: WorkflowState = {
        ...DEFAULT_STATE,
        mode: "planning",
        autoCodeReview: false,
      };
      saveState(ctx.cwd, state);

      const ok = await switchMode(pi, ctx, "planning", getAgentDir);
      if (!ok) return;

      ctx.ui.notify(
        "已进入 Planning Mode。直接描述需求；产出计划并确认后会自动交给 worker。",
        "info"
      );
    },
  });
}

/** Register the /go command. */
export function registerGoCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("go", {
    description:
      "手动批准当前计划并交给 worker；如计划评审未通过，需要 /go --force",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const state = loadState(ctx.cwd);
      const config = loadConfig(ctx.cwd, getAgentDir());
      const force = args.includes("--force");

      if (!state.planPath) {
        ctx.ui.notify("没有 active plan。请先 /plan 并保存计划。", "error");
        return;
      }

      if (
        config.planReview.enabled &&
        state.planReviewStatus !== "pass" &&
        !force
      ) {
        ctx.ui.notify(
          `计划评审未通过或未完成：${state.planReviewStatus}。如确认要跳过，使用 /go --force。`,
          "warning"
        );
        return;
      }

      state.planApproved = true;
      saveState(ctx.cwd, state);

      await startWorkerFromPlan(pi, ctx, getAgentDir);
    },
  });
}

/** Register the /work command. */
export function registerWorkCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("work", {
    description: "跳过计划，直接进入 worker；适合小改动，完成后自动 code-review",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const state: WorkflowState = {
        ...DEFAULT_STATE,
        mode: "work",
        autoCodeReview: true,
        codeReviewLoops: 0,
      };
      saveState(ctx.cwd, state);

      const ok = await switchMode(pi, ctx, "work", getAgentDir);
      if (!ok) return;

      ctx.ui.notify("已进入 Work Mode。小改动可以直接描述任务。", "info");

      if (args.trim()) {
        pi.sendUserMessage(args.trim());
      }
    },
  });
}

/** Register the /review command. */
export function registerReviewCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("review", {
    description: "手动切到 code-review 模型检查当前 diff",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const state = { ...loadState(ctx.cwd), mode: "review" as const, autoCodeReview: false };
      saveState(ctx.cwd, state);

      const ok = await switchMode(pi, ctx, "review", getAgentDir);
      if (!ok) return;

      pi.sendUserMessage(
        "请评审当前工作区相对 HEAD 的修改。必须查看 git status 和 git diff，最后输出 REVIEW_STATUS。"
      );
    },
  });
}

/** Register the /commit command. */
export function registerCommitCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("commit", {
    description: "切到小模型，根据当前 diff 生成 commit message 并直接提交",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const state = {
        ...loadState(ctx.cwd),
        mode: "commit" as const,
        autoCodeReview: false,
      };
      saveState(ctx.cwd, state);

      const ok = await switchMode(pi, ctx, "commit", getAgentDir);
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

/** Register the /wf-status command. */
export function registerWfStatusCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("wf-status", {
    description: "显示当前轻量 workflow 状态",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const state = loadState(ctx.cwd);
      const config = loadConfig(ctx.cwd, getAgentDir());

      ctx.ui.notify(currentStatusText(config, state), "info");
    },
  });
}

/** Register the /wf-exit command. */
export function registerWfExitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("wf-exit", {
    description: "退出 workflow mode，恢复普通 Pi",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const state = loadState(ctx.cwd);
      state.mode = "idle";
      state.autoCodeReview = false;
      saveState(ctx.cwd, state);

      ctx.ui.setStatus("lite-sp", undefined);
      ctx.ui.setStatus("lite-sp-model", undefined);
      ctx.ui.notify("已退出 workflow mode。", "info");
    },
  });
}

/** Register the /wf-reset command. */
export function registerWfResetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("wf-reset", {
    description: "清空 workflow 状态、plan 目录和 todo",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const state: WorkflowState = { ...DEFAULT_STATE };
      saveState(ctx.cwd, state);

      // Clean up plan directory
      const pdir = planDir(ctx.cwd);
      if (fs.existsSync(pdir)) {
        for (const entry of fs.readdirSync(pdir)) {
          fs.rmSync(path.join(pdir, entry));
        }
      }

      ctx.ui.setStatus("lite-sp", undefined);
      ctx.ui.setStatus("lite-sp-model", undefined);
      ctx.ui.notify("已清空 workflow 状态。", "info");
    },
  });
}
