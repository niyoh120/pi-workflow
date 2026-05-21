import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadState, saveState, readPlan, writePlanReview } from "./state.js";
import { loadConfig } from "./config.js";
import { COMMON_PROMPT, promptForMode, promptForSubagentRole } from "./prompts.js";
import { isReadonlyMode, isLocalFileMutatingShell, isCommitAllowedShell, extractAssistantText, isAllowedPlanScratchPath } from "./guards.js";
import { currentStatusText, modeLabel, todoText } from "./helpers.js";
import type { Mode, WorkflowState, ModelSpec } from "./types.js";
import { DEFAULT_STATE } from "./defaults.js";
import { planDir } from "./paths.js";
import { runSubagent } from "./subagent.js";
import fs from "node:fs";
import { execSync } from "node:child_process";
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

  return true;
}

/** Ensure workflow_todo, workflow_plan and workflow_subagent are in the active tools set. */
function ensureWorkflowToolsActive(pi: ExtensionAPI): void {
  const active = pi.getActiveTools().map((tool: any) => {
    if (typeof tool === "string") return tool;
    return tool.name;
  });
  const next = new Set(active);
  next.add("workflow_todo");
  next.add("workflow_plan");
  next.add("workflow_subagent");
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
    plan: "plan",
    planReview: "planReview",
    work: "work",
    fix: "work",
    review: "review",
    commit: "commit",
  };
  const role = roleMap[mode];
  if (role && !(await setRole(pi, ctx, role, getAgentDir))) return false;

  ensureWorkflowToolsActive(pi);
  ctx.ui.setStatus("lite-sp", modeLabel(mode));

  return true;
}

/** Follow-up that transitions from plan to work based on current plan. */
async function startWorkFromPlan(
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

/** Inline plan-review fallback (old behavior). */
async function startPlanReviewInline(
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

/** Run isolated plan-review via subagent runner. */
async function runPlanReviewSubagent(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string
): Promise<void> {
  const state = loadState(ctx.cwd);
  const config = loadConfig(ctx.cwd, getAgentDir());

  if (!config.subagent.enabled) {
    if (config.subagent.fallbackToInlineReview) {
      await startPlanReviewInline(pi, ctx, getAgentDir);
      return;
    }
    ctx.ui.notify(
      "Isolated plan-review is disabled (subagent.enabled=false). Skipping.",
      "warning"
    );
    return;
  }

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

  const modelSpec: ModelSpec | undefined =
    config.models.planReview;
  const systemPrompt = promptForSubagentRole("planReview");

  ctx.ui.notify("正在运行 isolated plan review 子代理...", "info");

  const result = await runSubagent({
    cwd: ctx.cwd,
    role: "planReview",
    task: `Review the plan below thoroughly. Check coverage, scope creep, dependencies, compatibility, risks, and todo granularity.\n\n${context}`,
    systemPrompt,
    modelSpec,
    subagentConfig: config.subagent,
    env: { PI_WORKFLOW_SUBAGENT: "planReview" },
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
    saveState(ctx.cwd, state);
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
    saveState(ctx.cwd, state);

    await switchMode(pi, ctx, "plan", getAgentDir);

    pi.sendUserMessage(
      `计划评审已通过。请向用户展示最终计划摘要，并等待用户确认。用户确认后调用 workflow_plan(action="approve")。`,
      { deliverAs: "followUp" }
    );
    return;
  }

  // FAIL or no status marker → fail
  state.planReviewStatus = "fail";
  state.planReviewLoops += 1;
  state.mode = "plan";
  saveState(ctx.cwd, state);

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
}

/**
 * Check that the working directory is a git repo with a reachable HEAD.
 * Returns true if preflight passes; otherwise prints a warning and returns false.
 * Does NOT auto-initialize git or create commits.
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

/** Check if the given directory is inside a git work tree. */
function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Get the absolute git repository root for the given directory.
 *  Returns the original cwd if the command fails. */
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

/** Find an existing AGENTS.md or agents.md in the given directory.
 *  Returns the found filename (AGENTS.md or agents.md) or null.
 *  Prefers AGENTS.md over agents.md if both exist. */
function findExistingAgentsFile(root: string): string | null {
  const agMd = path.join(root, "AGENTS.md");
  const agMdLower = path.join(root, "agents.md");
  if (fs.existsSync(agMd)) return "AGENTS.md";
  if (fs.existsSync(agMdLower)) return "agents.md";
  return null;
}

/** Check if the project directory is empty (no meaningful source/config/doc files).
 *  Excludes .git, .pi, AGENTS.md, agents.md and other dotfiles/dotdirs.
 *  Returns true if only metadata/hidden files are present. */
function isProjectEmpty(root: string): boolean {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const meaningful = entries.filter((e) => !e.name.startsWith("."));
  return meaningful.length === 0;
}

/** Inline code-review fallback (old behavior). */
async function startCodeReviewInline(
  pi: ExtensionAPI,
  ctx: any,
  getAgentDir: () => string
): Promise<void> {
  const state = loadState(ctx.cwd);

  if (!gitRepoPreflight(ctx.cwd, ctx)) {
    state.autoCodeReview = false;
    saveState(ctx.cwd, state);
    return;
  }

  state.mode = "review";
  saveState(ctx.cwd, state);

  await switchMode(pi, ctx, "review", getAgentDir);

  pi.sendUserMessage(
    "请评审当前工作区相对 HEAD 的修改。必须查看 git status 和 git diff，最后输出 REVIEW_STATUS。",
    { deliverAs: "followUp" }
  );
}

/** Run isolated code-review via subagent runner.
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
  const state = loadState(ctx.cwd);
  const config = loadConfig(ctx.cwd, getAgentDir());

  if (!config.subagent.enabled) {
    if (config.subagent.fallbackToInlineReview) {
      await startCodeReviewInline(pi, ctx, getAgentDir);
      return true;
    }
    ctx.ui.notify(
      "Isolated code-review is disabled (subagent.enabled=false). Skipping.",
      "warning"
    );
    state.autoCodeReview = false;
    saveState(ctx.cwd, state);
    return false;
  }

  if (!gitRepoPreflight(ctx.cwd, ctx)) {
    state.autoCodeReview = false;
    saveState(ctx.cwd, state);
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

  const modelSpec: ModelSpec | undefined =
    config.models.review;
  const systemPrompt = promptForSubagentRole("review");

  ctx.ui.notify("正在运行 isolated code review 子代理...", "info");

  const result = await runSubagent({
    cwd: ctx.cwd,
    role: "review",
    task: `Review the current working tree changes (git diff) provided below. Check the diff against the plan and todo context.\n\n${context}`,
    systemPrompt,
    modelSpec,
    subagentConfig: config.subagent,
    env: { PI_WORKFLOW_SUBAGENT: "review" },
  });

  if (result.exitCode !== 0) {
    ctx.ui.notify(
      `Code review subagent failed (exit ${result.exitCode}). stderr: ${result.stderr.slice(-300)}`,
      "error"
    );
    state.autoCodeReview = false;
    saveState(ctx.cwd, state);
    return false;
  }

  if (result.statusMarker === "PASS") {
    state.mode = "idle";
    state.autoCodeReview = false;
    saveState(ctx.cwd, state);

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
    saveState(ctx.cwd, state);
    ctx.ui.setStatus("lite-sp", undefined);
    const note = result.text ? `\n\n评审意见：\n${result.text.slice(-2000)}` : "";
    ctx.ui.notify(`代码评审未通过。${note}`, "warning");
    return true;
  }

  if (state.codeReviewLoops > config.codeReview.maxLoops) {
    state.mode = "idle";
    state.autoCodeReview = false;
    saveState(ctx.cwd, state);

    ctx.ui.setStatus("lite-sp", undefined);
    ctx.ui.notify(
      `达到最大 code review 修复轮数（${config.codeReview.maxLoops}），请手动介入。\n\n评审意见：\n${result.text.slice(-2000)}`,
      "warning"
    );
    return true;
  }

  state.mode = "fix";
  saveState(ctx.cwd, state);

  await switchMode(pi, ctx, "fix", getAgentDir);

  pi.sendUserMessage(
    `请只修复上一轮 reviewer 指出的 Critical / Important 问题。修复后运行相关测试，并以 WORK_STATUS 结束。\n\n评审意见：\n${result.text.slice(-4000)}`,
    { deliverAs: "followUp" }
  );
  return true;
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
 * - in readonly modes (plan / planReview / review): block writes and mutating shell commands
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
        // Plan Mode: allow writes/edits to safe scratch paths only.
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
          return; // allowed scratch write
        }

        // Plan Review / Code Review: fully block write/edit.
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
 * - plan review → back to plan with feedback
 * - work → auto code review if Work Mode signals READY_FOR_REVIEW
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

    if (state.mode === "plan") {
      if (
        config.planReview.enabled &&
        state.planPath &&
        state.planReviewStatus === "pending" &&
        state.planReviewLoops < config.planReview.maxLoops
      ) {
        // Run isolated plan-review subagent (inline, synchronous from hook)
        await runPlanReviewSubagent(pi, ctx, getAgentDir);
        return;
      }

      if (state.planApproved) {
        await startWorkFromPlan(pi, ctx, getAgentDir);
        return;
      }
    }

    // planReview and review modes: only used by inline fallback (subagent disabled + fallbackToInlineReview)
    if (state.mode === "planReview") {
      if (state.planReviewStatus === "pass") {
        state.mode = "plan";
        saveState(ctx.cwd, state);

        await switchMode(pi, ctx, "plan", getAgentDir);

        pi.sendUserMessage(
          '计划评审已通过。请向用户展示最终计划摘要，并等待用户确认。用户确认后调用 workflow_plan(action="approve")。',
          { deliverAs: "followUp" }
        );
        return;
      }

      if (state.planReviewStatus === "fail") {
        state.mode = "plan";
        saveState(ctx.cwd, state);

        await switchMode(pi, ctx, "plan", getAgentDir);

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

    if (state.mode === "review" && state.autoCodeReview) {
      if (text.includes("REVIEW_STATUS: PASS")) {
        state.mode = "idle";
        state.autoCodeReview = false;
        saveState(ctx.cwd, state);

        ctx.ui.setStatus("lite-sp", undefined);
        ctx.ui.notify("代码评审通过。现在你可以手动跑测试，确认后 /commit。", "info");
        return;
      }

      if (text.includes("REVIEW_STATUS: FAIL")) {
        state.codeReviewLoops += 1;

        if (state.codeReviewLoops > config.codeReview.maxLoops) {
          state.mode = "idle";
          state.autoCodeReview = false;
          saveState(ctx.cwd, state);

          ctx.ui.setStatus("lite-sp", undefined);
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

    if (
      (state.mode === "work" || state.mode === "fix") &&
      state.autoCodeReview &&
      config.codeReview.enabled
    ) {
      if (text.includes("WORK_STATUS: BLOCKED")) {
        state.autoCodeReview = false;
        saveState(ctx.cwd, state);
        ctx.ui.notify("Work Mode blocked，已停止自动 review。", "warning");
        return;
      }

      if (text.includes("WORK_STATUS: READY_FOR_REVIEW")) {
        // Run isolated code-review subagent (inline, synchronous from hook)
        await runCodeReviewSubagent(pi, ctx, getAgentDir);
        return;
      }

      ctx.ui.notify(
        "Work Mode 没有输出 WORK_STATUS，未自动进入 review。你可以手动 /review。",
        "warning"
      );
      return;
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
        mode: "plan",
        autoCodeReview: false,
      };
      saveState(ctx.cwd, state);

      const ok = await switchMode(pi, ctx, "plan", getAgentDir);
      if (!ok) return;

      ctx.ui.notify(
        "已进入 Plan Mode。直接描述需求；产出计划并确认后会自动转交 Work Mode。",
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
      "手动批准当前计划并交给 Work Mode；如计划评审未通过，需要 /go --force",
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

      await startWorkFromPlan(pi, ctx, getAgentDir);
    },
  });
}

/** Register the /work command. */
export function registerWorkCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("work", {
    description: "跳过计划，直接进入 Work Mode；适合直接实现，完成后自动 code-review",
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

      ctx.ui.notify("已进入 Work Mode。可以直接描述任务。", "info");

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
    description: "使用 isolated subagent 检查当前 diff",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const config = loadConfig(ctx.cwd, getAgentDir());

      if (!config.subagent.enabled) {
        if (config.subagent.fallbackToInlineReview) {
          await startCodeReviewInline(pi, ctx, getAgentDir);
          return;
        }
        ctx.ui.notify(
          "Isolated code-review is disabled (subagent.enabled=false).",
          "warning"
        );
        return;
      }

      const performed = await runCodeReviewSubagent(pi, ctx, getAgentDir, false);
      if (!performed) {
        ctx.ui.notify("Code review aborted (no git repo or subagent error).", "warning");
      }
    },
  });
}

/** Register the /commit command. */
export function registerCommitCommand(
  pi: ExtensionAPI,
  getAgentDir: () => string
): void {
  pi.registerCommand("commit", {
    description: "切到 commit 模型，根据当前 diff 生成 commit message 并直接提交",
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
      ctx.ui.notify("已清空 workflow 状态。", "info");
    },
  });
}

/** Register the /wf-init command.
 *  Ensures the cwd is a git repo (git init if not),
 *  then guides the agent to create or update AGENTS.md. */
export function registerWfInitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("wf-init", {
    description:
      "初始化 agent 工作区：确保 git 仓库存在，生成/更新 AGENTS.md",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      // Step 1: check / init git repo
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

      // Step 2: determine target root (repo root if inside a repo)
      const root = getGitRoot(ctx.cwd);

      // Step 3: check existing AGENTS files
      const existingFile = findExistingAgentsFile(root);

      if (existingFile) {
        // Existing file found — ask user if they want to update
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

      // Step 4: no AGENTS file — check if project is empty
      if (isProjectEmpty(root)) {
        // Empty project: ask user for project info first
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

      // Non-empty project: let agent analyze and generate AGENTS.md
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
