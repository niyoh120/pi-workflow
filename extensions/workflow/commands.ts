import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import { getSessionKey, loadState, saveState, readPlan, writePlanReview } from "./state.js";
import { loadConfig } from "./config.js";
import { COMMON_PROMPT, promptForMode, promptForSubagentRole } from "./prompts.js";
import { isReadonlyMode, isLocalFileMutatingShell, isAllowedPlanScratchPath } from "./guards.js";
import { currentStatusText, modeLabel, todoText } from "./helpers.js";
import { getWorkflowOverlay } from "./todo-overlay.js";
import type { Mode, WorkflowState } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { planDir } from "./paths.js";
import type { SubagentsClient } from "./subagent.js";
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { syncReviewAgentsToGlobal, getGlobalAgentsDir } from "./agents.js";

/** Store active subagent client reference set by index.ts. */
let _subagentsClient: SubagentsClient;
export function setSubagentsClient(c: SubagentsClient): void {
  _subagentsClient = c;
}

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

  return true;
}

/** Ensure workflow tools are active, including optional ask_user_question when available. */
function ensureWorkflowToolsActive(pi: ExtensionAPI, cwd: string, getAgentDir: () => string): void {
  const active = pi.getActiveTools().map((tool: any) => {
    if (typeof tool === "string") return tool;
    return tool.name;
  });
  const next = new Set(active);
  next.add("workflow_todo");
  next.add("workflow_plan");
  next.add("workflow_subagent");
  next.add("workflow_status");

  // Optionally activate ask_user_question when installed by another package.
  try {
    const config = loadConfig(cwd, getAgentDir());
    if (config.askUserQuestion.enabled) {
      const allTools = pi.getAllTools();
      if (allTools.some((t: any) => t.name === config.askUserQuestion.toolName)) {
        next.add(config.askUserQuestion.toolName);
      }
    }
  } catch {
    // If config load or getAllTools fails, skip silently — workflow still works.
  }

  pi.setActiveTools([...next]);
}

/** Switch to a new mode, update state, set role & tools. */
async function switchMode(
  pi: ExtensionAPI,
  ctx: any,
  mode: Mode,
  getAgentDir: () => string
): Promise<boolean> {
  const sessionKey = getSessionKey(ctx.sessionManager);
  const state = loadState(ctx.cwd, sessionKey);
  state.mode = mode;
  saveState(ctx.cwd, sessionKey, state);

  const roleMap: Record<string, string> = {
    plan: "plan",
    planReview: "planReview",
    work: "work",
    fix: "work",
    review: "review",
    commit: "commit",
  };
  const role = roleMap[mode];
  if (role && !(await setRole(pi, ctx, role, getAgentDir))) return false;

  ensureWorkflowToolsActive(pi, ctx.cwd, getAgentDir);
  ctx.ui.setStatus("lite-sp", modeLabel(mode));

  return true;
}

/** Send a handoff user message: direct delivery when idle, followUp when busy.
 *  Always triggers a turn. When idle, sends directly to avoid missing the
 *  followUp drain window (especially in agent_end callbacks).  When busy or
 *  isIdle unavailable, falls back to queued followUp to stay streaming-safe. */
function sendHandoffUserMessage(
  pi: ExtensionAPI,
  ctx: any,
  message: string
): void {
  if (ctx.isIdle?.()) {
    pi.sendUserMessage(message);
  } else {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  }
}

/** Follow-up that transitions from plan to work based on current plan. */
async function startWorkFromPlan(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string
): Promise<void> {
  const sessionKey = getSessionKey(ctx.sessionManager);
  const state = loadState(ctx.cwd, sessionKey);

  state.mode = "work";
  state.autoCodeReview = true;
  state.codeReviewLoops = 0;
  state.workRunId = crypto.randomUUID();
  state.workStatus = undefined;
  state.workStatusRunId = undefined;
  state.workStatusSummary = undefined;
  state.workStatusTests = undefined;
  state.workStatusError = undefined;
  state.workStatusUpdatedAt = undefined;
  saveState(ctx.cwd, sessionKey, state);

  await switchMode(pi, ctx, "work", getAgentDir);

  const planPathText = state.planPath ?? "当前计划文件";

  sendHandoffUserMessage(
    pi,
    ctx,
    `按已确认计划实现。计划文件：${planPathText}。请先读取计划和 workflow_todo，然后按 todo 顺序执行。`
  );
}

/** Run isolated plan-review via pi-subagents. */
async function runPlanReviewSubagent(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string
): Promise<void> {
  const sessionKey = getSessionKey(ctx.sessionManager);
  const state = loadState(ctx.cwd, sessionKey);
  const config = loadConfig(ctx.cwd, getAgentDir());

  // Read plan content for the child
  const planContent = state.planPath ? readPlan(ctx.cwd, state.planPath) : "";
  const planPathText = state.planPath ?? "current plan";

  // Build context for the child: plan file + todo summary
  const context = [
    `Plan file: ${planPathText}`,
    ``,
    `## Plan Content`,
    planContent || "(empty plan)",
    ``,
    `## Todo Status`,
    todoText(state),
  ].join("\n");

  const systemPrompt = promptForSubagentRole("planReview");

  ctx.ui.notify("正在运行 isolated plan review 子代理...", "info");

  try {
    const result = await _subagentsClient.run({
      role: "planReview",
      task: `Review the plan below thoroughly. Check coverage, scope creep, dependencies, compatibility, risks, and todo granularity.\n\n${context}`,
      systemPrompt,
      subagentConfig: config.subagent,
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
    });

    if (result.exitCode !== 0) {
      ctx.ui.notify(
        `Plan review subagent failed (exit ${result.exitCode}). stderr: ${result.stderr.slice(-300)}`,
        "error"
      );
      state.planReviewStatus = "fail";
      state.planReviewLoops += 1;
      state.planReviewNotes = `Subagent error (exit ${result.exitCode}): ${result.stderr.slice(-500)}`;
      if (state.planReviewPath) writePlanReview(ctx.cwd, state.planReviewPath, state.planReviewNotes);
      state.mode = "plan";
      saveState(ctx.cwd, sessionKey, state);
      await switchMode(pi, ctx, "plan", getAgentDir);
      pi.sendUserMessage(
        `计划评审子代理执行失败 (exit ${result.exitCode})。请手动检查或重试。`,
        { deliverAs: "followUp" }
      );
      return;
    }

    // Write review notes to plan review file
    state.planReviewNotes = result.text;
    if (state.planReviewPath) {
      writePlanReview(ctx.cwd, state.planReviewPath, result.text);
    }

    if (result.statusMarker === "PASS") {
      state.planReviewStatus = "pass";
      state.mode = "plan";
      saveState(ctx.cwd, sessionKey, state);

      await switchMode(pi, ctx, "plan", getAgentDir);

      pi.sendUserMessage(
        `计划评审已通过。请向用户展示最终计划摘要（包含 plan path: ${planPathText}），并等待用户确认。` +
        (config.askUserQuestion.enabled
          ? `如果 ask_user_question 工具可用，建议用结构化选项让用户一键确认（如：执行计划 / 修改计划 / 继续讨论），减少打字摩擦。`
          : ``) +
        `用户确认后调用 workflow_plan(action="approve")。`,
        { deliverAs: "followUp" }
      );
      return;
    }

    // FAIL or no status marker → fail
    state.planReviewStatus = "fail";
    state.planReviewLoops += 1;
    state.mode = "plan";
    saveState(ctx.cwd, sessionKey, state);

    await switchMode(pi, ctx, "plan", getAgentDir);

    if (state.planReviewLoops >= config.planReview.maxLoops) {
      pi.sendUserMessage(
        `计划评审未通过，且已达到最大评审轮数（${config.planReview.maxLoops}）。请向用户展示评审意见并等待用户决定。\n\n评审意见：\n${result.text}`,
        { deliverAs: "followUp" }
      );
      return;
    }

    pi.sendUserMessage(
      `计划评审未通过。请根据以下意见修订计划，并重新调用 workflow_plan(action="save") 保存。\n\n评审意见：\n${result.text}`,
      { deliverAs: "followUp" }
    );
  } catch (err: any) {
    ctx.ui.notify(
      `Plan review subagent error: ${err.message ?? String(err)}`,
      "error"
    );
    state.planReviewStatus = "fail";
    state.planReviewLoops += 1;
    state.planReviewNotes = `Subagent exception: ${err.message ?? String(err)}`;
    if (state.planReviewPath) writePlanReview(ctx.cwd, state.planReviewPath, state.planReviewNotes);
    state.mode = "plan";
    saveState(ctx.cwd, sessionKey, state);
    await switchMode(pi, ctx, "plan", getAgentDir);
    pi.sendUserMessage(
      `计划评审子代理异常：${err.message ?? String(err)}。请手动检查或重试。`,
      { deliverAs: "followUp" }
    );
    return;
  }
}

/**
 * Check that the working directory is a git repo with a reachable HEAD.
 * Returns true if preflight passes; otherwise prints a warning and returns false.
 */
function gitRepoPreflight(cwd: string, ctx: any): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
  } catch {
    ctx.ui.notify(
      "无法执行 code review：当前目录不是 git 仓库。请先 git init 并创建 baseline commit，或在已有 git 仓库根目录运行 pi。",
      "error"
    );
    return false;
  }

  try {
    execSync("git rev-parse --verify HEAD", { cwd, stdio: "pipe" });
  } catch {
    ctx.ui.notify(
      "无法执行 code review：git 仓库中没有 HEAD commit。请先创建 baseline commit（git add -A && git commit）。",
      "error"
    );
    return false;
  }

  return true;
}

// ──────────────────────────────────────────────
// /wf-init helpers
// ──────────────────────────────────────────────

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

/** Run isolated code-review via pi-subagents.
 *  Parent pre-collects git status and diff, passes to child.
 *  When autoFix is true (auto review loop), FAIL triggers fix mode.
 *  When autoFix is false (manual /review), FAIL only notifies.
 *  Returns true if review was performed, false if skipped (no git). */
async function runCodeReviewSubagent(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string,
  autoFix = true
): Promise<boolean> {
  const sessionKey = getSessionKey(ctx.sessionManager);
  const state = loadState(ctx.cwd, sessionKey);
  const config = loadConfig(ctx.cwd, getAgentDir());

  if (!gitRepoPreflight(ctx.cwd, ctx)) {
    if (autoFix) {
      state.autoCodeReview = false;
      saveState(ctx.cwd, sessionKey, state);
    }
    return false;
  }

  // Pre-collect git status and diff
  let statusText = "";
  let diffStatText = "";
  let diffText = "";

  try {
    statusText = execSync("git status --short", {
      cwd: ctx.cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }).toString();
  } catch {
    statusText = "(could not run git status)";
  }
  try {
    diffStatText = execSync("git diff --stat", {
      cwd: ctx.cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }).toString();
  } catch {
    diffStatText = "(could not run git diff --stat)";
  }
  try {
    diffText = execSync("git diff", {
      cwd: ctx.cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }).toString();
  } catch {
    diffText = "(could not run git diff)";
  }

  // Build context: git info + plan + todo summary
  const planContent = state.planPath ? readPlan(ctx.cwd, state.planPath) : "";
  const planContext = state.planPath
    ? [`Plan file: ${state.planPath}`, planContent].join("\n\n")
    : "(no plan)";

  const context = [
    `## Git Status`,
    statusText || "(no changes)",
    ``,
    `## Git Diff Stat`,
    diffStatText || "(empty)",
    ``,
    `## Git Diff`,
    diffText || "(empty)",
    ``,
    `## Plan / Todo Context`,
    planContext,
    ``,
    `## Todo Status`,
    todoText(state),
  ].join("\n");

  const systemPrompt = promptForSubagentRole("review");

  ctx.ui.notify("正在运行 isolated code review 子代理...", "info");

  try {
    const result = await _subagentsClient.run({
      role: "review",
      task: `Review the current working tree changes (git diff) provided below. Check the diff against the plan and todo context.\n\n${context}`,
      systemPrompt,
      subagentConfig: config.subagent,
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
    });

    if (result.exitCode !== 0) {
      ctx.ui.notify(
        `Code review subagent failed (exit ${result.exitCode}). stderr: ${result.stderr.slice(-300)}`,
        "error"
      );
      if (autoFix) {
        state.autoCodeReview = false;
        saveState(ctx.cwd, sessionKey, state);
      }
      return false;
    }

    if (result.statusMarker === "PASS") {
      state.mode = "idle";
      state.autoCodeReview = false;
      saveState(ctx.cwd, sessionKey, state);

      ctx.ui.setStatus("lite-sp", undefined);
      ctx.ui.notify(
        `代码评审通过。现在你可以手动跑测试，确认后 /commit。`,
        "info"
      );
      return true;
    }

    // FAIL or no marker → fail
    state.codeReviewLoops += 1;

    if (!autoFix) {
      // Manual review: just display result, don't enter fix loop
      state.mode = "idle";
      state.autoCodeReview = false;
      saveState(ctx.cwd, sessionKey, state);
      ctx.ui.setStatus("lite-sp", undefined);
      const note = result.text ? `\n\n评审意见：\n${result.text.slice(-2000)}` : "";
      ctx.ui.notify(`代码评审未通过。${note}`, "warning");
      return true;
    }

    if (state.codeReviewLoops > config.codeReview.maxLoops) {
      state.mode = "idle";
      state.autoCodeReview = false;
      saveState(ctx.cwd, sessionKey, state);

      ctx.ui.setStatus("lite-sp", undefined);
      ctx.ui.notify(
        `达到最大 code review 修复轮数（${config.codeReview.maxLoops}），请手动介入。\n\n评审意见：\n${result.text.slice(-2000)}`,
        "warning"
      );
      return true;
    }

    state.mode = "fix";
    // Keep same workRunId for fix mode, but clear stale work status
    // so the Fix agent must call workflow_status itself.
    state.workStatus = undefined;
    state.workStatusRunId = undefined;
    state.workStatusSummary = undefined;
    state.workStatusTests = undefined;
    state.workStatusError = undefined;
    state.workStatusUpdatedAt = undefined;
    saveState(ctx.cwd, sessionKey, state);

    await switchMode(pi, ctx, "fix", getAgentDir);

    sendHandoffUserMessage(
      pi,
      ctx,
      `请修复上一轮 reviewer 指出的 Critical / Important 问题。修复后调用 workflow_status 工具。\n\n评审意见：\n${result.text.slice(-4000)}`
    );
    return true;
  } catch (err: any) {
    ctx.ui.notify(
      `Code review subagent error: ${err.message ?? String(err)}`,
      "error"
    );
    if (autoFix) {
      state.autoCodeReview = false;
      saveState(ctx.cwd, sessionKey, state);
    }
    return false;
  }
}

// ──────────────────────────────────────────────
// Event handlers registered by the extension
// ──────────────────────────────────────────────

export function registerBeforeAgentStart(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionKey = getSessionKey(ctx.sessionManager);
    const state = loadState(ctx.cwd, sessionKey);
    const config = loadConfig(ctx.cwd, getAgentDir());

    ensureWorkflowToolsActive(pi, ctx.cwd, getAgentDir);

    // Hide done items at the start of each new turn.
    const overlay = getWorkflowOverlay();
    if (overlay) {
      overlay.hideDoneFromLastTurn();
      if (state.mode === "idle") {
        overlay.dispose();
        return;
      }
      overlay.update(state.todos);
    }

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

export function registerToolCallGuard(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.on("tool_call", async (event, ctx) => {
    const sessionKey = getSessionKey(ctx.sessionManager);
    const state = loadState(ctx.cwd, sessionKey);

    // Allow workflow's own tools through.
    if (
      event.toolName === "workflow_plan" ||
      event.toolName === "workflow_todo" ||
      event.toolName === "workflow_status"
    ) {
      return;
    }

    // Read-only modes: block local file mutations.
    if (isReadonlyMode(state.mode)) {
      if (event.toolName === "write" || event.toolName === "edit") {
        if (state.mode === "plan") {
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

    // Commit mode: prevent direct code file edits. Other tools (bash, RTK git
    // wrappers, etc.) are allowed — git command restrictions are guided by the
    // mode prompt (no push, no code edits, no formatting).
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
    const sessionKey = getSessionKey(ctx.sessionManager);
    const state = loadState(ctx.cwd, sessionKey);
    const config = loadConfig(ctx.cwd, getAgentDir());

    if (state.mode === "plan") {
      if (
        config.planReview.enabled &&
        state.planPath &&
        state.planReviewStatus === "pending" &&
        state.planReviewLoops < config.planReview.maxLoops
      ) {
        await runPlanReviewSubagent(pi, ctx, getAgentDir);
        return;
      }

      if (state.planApproved) {
        await startWorkFromPlan(pi, ctx, getAgentDir);
        return;
      }
    }

    // planReview mode: no longer used (inline fallback removed).
    // All plan reviews go through isolated subagent.

    // review mode with autoCodeReview: no longer used (inline fallback removed).
    // All code reviews go through isolated subagent.

    // Work / Fix mode: check for workflow_status tool-driven completion.
    if (
      (state.mode === "work" || state.mode === "fix") &&
      state.autoCodeReview &&
      config.codeReview.enabled
    ) {
      // Only act on a workflow_status that matches the current workRunId.
      if (!state.workRunId) {
        ctx.ui.notify(
          "Work Mode 没有设置 workRunId，无法触发自动 code review。",
          "warning"
        );
        return;
      }

      if (!state.workStatus || state.workStatusRunId !== state.workRunId) {
        ctx.ui.notify(
          `Work/Fix Mode 完成但未调用 workflow_status（或 run id 不匹配）。必须调用 workflow_status({ status: "ready_for_review" | "blocked" }) 来触发自动 review。`,
          "warning"
        );
        return;
      }

      if (state.workStatus === "blocked") {
        state.autoCodeReview = false;
        saveState(ctx.cwd, sessionKey, state);
        ctx.ui.notify(
          `Work/Fix Mode blocked: ${state.workStatusError ?? "(no details)"}。已停止自动 review。`,
          "warning"
        );
        return;
      }

      if (state.workStatus === "ready_for_review") {
        await runCodeReviewSubagent(pi, ctx, getAgentDir);
        return;
      }

      ctx.ui.notify(
        `Work Mode 的 workflow_status 状态不明确：${state.workStatus}。`,
        "warning"
      );
      return;
    }
  });
}

// ──────────────────────────────────────────────
// Command registrations
// ──────────────────────────────────────────────

export function registerPlanCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("plan", {
    description: "进入计划模式：头脑风暴、产出计划、等待确认",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = getSessionKey(ctx.sessionManager);

      const state: WorkflowState = {
        ...DEFAULT_STATE,
        mode: "plan",
        autoCodeReview: false,
        planRunId: crypto.randomUUID(),
      };
      saveState(ctx.cwd, sessionKey, state);

      const ok = await switchMode(pi, ctx, "plan", getAgentDir);
      if (!ok) return;

      ctx.ui.notify(
        "已进入 Plan Mode。直接描述需求；产出计划并确认后会自动转交 Work Mode。",
        "info"
      );
    },
  });
}

export function registerGoCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("go", {
    description:
      "手动批准当前计划并交给 Work Mode；如计划评审未通过，需要 /go --force",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = getSessionKey(ctx.sessionManager);

      const state = loadState(ctx.cwd, sessionKey);
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
      saveState(ctx.cwd, sessionKey, state);

      await startWorkFromPlan(pi, ctx, getAgentDir);
    },
  });
}

export function registerWorkCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("work", {
    description: "跳过计划，直接进入 Work Mode；适合直接实现，完成后自动 code-review",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = getSessionKey(ctx.sessionManager);

      const state: WorkflowState = {
        ...DEFAULT_STATE,
        mode: "work",
        autoCodeReview: true,
        codeReviewLoops: 0,
        workRunId: crypto.randomUUID(),
      };
      saveState(ctx.cwd, sessionKey, state);

      const ok = await switchMode(pi, ctx, "work", getAgentDir);
      if (!ok) return;

      ctx.ui.notify("已进入 Work Mode。可以直接描述任务。", "info");

      if (args.trim()) {
        pi.sendUserMessage(args.trim());
      }
    },
  });
}

export function registerReviewCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("review", {
    description: "使用 isolated subagent 检查当前 diff",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const performed = await runCodeReviewSubagent(pi, ctx, getAgentDir, false);
      if (!performed) {
        ctx.ui.notify("Code review aborted (no git repo or subagent error).", "warning");
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
      const sessionKey = getSessionKey(ctx.sessionManager);

      const state = {
        ...loadState(ctx.cwd, sessionKey),
        mode: "commit" as const,
        autoCodeReview: false,
      };
      saveState(ctx.cwd, sessionKey, state);

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

export function registerWfStatusCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("wf-status", {
    description: "显示当前轻量 workflow 状态",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = getSessionKey(ctx.sessionManager);

      const state = loadState(ctx.cwd, sessionKey);
      const config = loadConfig(ctx.cwd, getAgentDir());

      ctx.ui.notify(currentStatusText(config, state), "info");
    },
  });
}

export function registerWfExitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("wf-exit", {
    description: "退出 workflow mode，恢复普通 Pi",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sessionKey = getSessionKey(ctx.sessionManager);

      const state = loadState(ctx.cwd, sessionKey);
      state.mode = "idle";
      state.autoCodeReview = false;
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
      const sessionKey = getSessionKey(ctx.sessionManager);

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

/** Register the /wf-install-subagents command. */
export function registerWfInstallSubagentsCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string,
): void {
  pi.registerCommand("wf-install-subagents", {
    description: "安装 @tintinweb/pi-subagents 并同步 workflow review agents",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const agentDir = getAgentDir();

      // 1. Install pi-subagents dependency
      ctx.ui.notify("正在安装 @tintinweb/pi-subagents...", "info");

      try {
        execSync("pi install npm:@tintinweb/pi-subagents", {
          cwd: ctx.cwd,
          stdio: "pipe",
          encoding: "utf8",
          timeout: 60000,
        });
        ctx.ui.notify(
          "@tintinweb/pi-subagents 已安装。",
          "info"
        );
      } catch (err: any) {
        ctx.ui.notify(
          `安装 pi-subagents 失败：${err?.stderr ?? err?.message ?? String(err)}\n请手动执行：pi install npm:@tintinweb/pi-subagents`,
          "error"
        );
        return;
      }

      // 2. Sync bundled review agents to global agents directory
      const targetDir = getGlobalAgentsDir(agentDir);
      ctx.ui.notify(`正在同步 review agents 到 ${targetDir}...`, "info");

      const syncResult = syncReviewAgentsToGlobal(agentDir);

      const messages: string[] = [];
      if (syncResult.copied.length > 0) {
        messages.push(`已同步：${syncResult.copied.join(", ")}`);
      }
      if (syncResult.skipped.length > 0) {
        messages.push(`已跳过（用户文件）：${syncResult.skipped.join(", ")}`);
      }
      if (syncResult.errors.length > 0) {
        messages.push(`错误：${syncResult.errors.join("; ")}`);
      }

      ctx.ui.notify(messages.join("\n"), syncResult.errors.length > 0 ? "warning" : "info");

      // 3. Prompt reload
      ctx.ui.notify(
        "Custom review agents 已同步。请执行 /reload 或重启 Pi 使 pi-subagents 加载新 agents。",
        "info"
      );

      // 4. Hint about optional ask-user-question
      ctx.ui.notify(
        "可选：安装 @juicesharp/rpiv-ask-user-question 可在 Plan Mode 中获得结构化确认对话框。执行 pi install npm:@juicesharp/rpiv-ask-user-question 然后 /reload。",
        "info"
      );
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
            `确认前不会修改已有文件。`,
          { deliverAs: "followUp" }
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
            `了解这些信息后，我会在仓库根目录生成 AGENTS.md。`,
          { deliverAs: "followUp" }
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
          `- 工作流规则\n` +
          `- 提交规范\n` +
          `- 安全/禁止事项\n\n` +
          `使用 write 工具将内容写入 ${path.join(root, "AGENTS.md")}。`,
        { deliverAs: "followUp" }
      );
    },
  });
}
