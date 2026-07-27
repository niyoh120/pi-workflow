# AGENTS.md — pi-workflow

## 项目边界

- 本仓库是 `pi-coding-agent` 的 TypeScript 扩展包；扩展入口由 `package.json#pi.extensions` 注册为 `extensions/workflow/index.ts`。
- 使用 ESM、Node16 模块解析、TypeScript strict/noEmit；源码导入本地模块时保留 `.js` 后缀，Node 内置模块使用 `node:` 前缀。
- 当前 `@earendil-works/pi-*` 0.81.1 依赖要求 Node.js `>=22.19.0`。
- 不依赖其他 Pi 扩展。结构化问答包 `@juicesharp/rpiv-ask-user-question` 属于可选安装；代码审查依赖 PATH 中独立安装的 `ocr` CLI。

## 验证与本地安装

仓库没有 package scripts、CI 或部署流程。提交相关改动前运行：

```bash
npx tsc --noEmit
node scripts/validate-todo-regression.mjs
node scripts/validate-mode-injection.mjs
node scripts/validate-rpc-mode.mjs
```

本地安装与重载：

```bash
pi install .
# Pi 内执行
/reload
```

## 模块边界

- `index.ts`：扩展入口和注册编排。
- `commands.ts`：命令、事件钩子、模式入口与写入权限拦截。
- `tools.ts`：`workflow_*` 工具及持久化状态转换。
- `mode.ts` / `prompts.ts` / `helpers.ts`：模式工具可见性、模式提示词、运行时消息。
- `state.ts` / `paths.ts` / `config.ts` / `defaults.ts` / `types.ts`：状态、路径、配置合并、默认值和共享类型。
- `settings.ts`：`/wf-settings` 的 session/project/global 三层配置 TUI。
- `sidecall.ts`：Plan Review 的 `provider.streamSimple(...).result()` 同 turn 侧调用。
- `ocr-helpers.ts` / `review-tui.ts`：OCR 参数与执行、`/review` 范围选择 UI。
- `ocr-result.ts`：OCR JSON 解析、归一化、去重与 compact 结果；复用 `terminal-text.ts`。
- `terminal-text.ts`：无状态 ANSI/控制字符清理，提供保留换行与移除全部控制字符两种语义。
- `worktree.ts` / `guards.ts`：worktree 生命周期和文件/命令权限边界；worktree branch/workRun 匹配由 `worktree.ts` 导出的纯 helper 维护，`state.ts` normalization 复用。
- `todo-overlay.ts`：todo widget 生命周期与 session-local 隐藏 bookkeeping（不持久化）。

新增职责优先放入对应模块；跨模块共享类型集中在 `types.ts`，默认值集中在 `defaults.ts`。

## 持久化与状态机约束

- 运行时状态只能通过 `loadState()` / `saveState()` 访问；`saveState()` 负责建目录和规范化。业务代码不得直接写 session state 文件。
- session 状态位于 `.pi/workflow/sessions/<safeSessionKey>/state.json`；session key 由 session 标识哈希生成。计划文件共享存放在 `.pi/workflow/plan/`，文件名随机化。
- 配置优先级固定为 `DEFAULT_CONFIG ← global ← project ← session`。模型角色闭集为 `explore | plan | planReview | work | commit`；load-time gate 变更需要 `/reload`。
- `Mode` 是闭集。新增模式时同步更新 `types.ts`、`prompts.ts`、`helpers.ts`、`mode.ts` 的 exhaustive switch，并保留 `assertNever()` 保护。
- 状态变更后立即 `saveState()`；模式切换走现有 transition/runtime helper，保持持久化状态、工具可见性和当前模型同步。
- `workflow_plan_approve` 可选择创建独立 worktree。active worktree 存在时，文件工具只能写其绝对路径；bash cwd 由扩展重定向到 worktree。
- Init Mode 仅允许写记录在 `initTargetPath` 的单个 `AGENTS.md`；完成、跳过或取消均通过 `workflow_init_complete` 恢复原模式。

## 工作流特有行为

- Workflow 默认 opt-in；`/wf-settings` 始终可用，其他工作流命令由 `/wf` 或 `workflow.autoEnter` 开启。
- Explore/Plan 是只读模式；Plan 文件通过 `workflow_plan_save` 写入，Work 使用 `workflow_todo` 跟踪任务。
- Plan Mode 在最终保存前执行 grilling 并持久化 `grillTurns`。Plan Review 是启用后由模型按复杂度选择发起的可选 sidecall；它属于 Plan Mode 内工具调用。
- `/review` 复用 Work runtime，驱动 OCR review/fix/re-review 循环。`ocr` 二进制名固定，参数使用 argv 数组执行，避免 shell 插值。
- 新计划开始时清理 todo overlay bookkeeping，防止已隐藏 done 项跨计划泄漏；该 bookkeeping 是 session-local 的 overlay 内部状态，不持久化到 `WorkflowState`。

## 工作流启用判定

- `isWorkflowActive(state, config)`（`helpers.ts`）是 workflow 启用判定的单一来源：`(workflowEnabled || autoEnter) && !workflowExplicitlyDisabled`。`workflowExplicitlyDisabled` 对 `autoEnter` 保持最高会话优先级。
- workflow-owned 工具的状态/配置读取失败返回显式 tool error；普通 Pi 工具在 guard 内部状态读取失败时继续沿用 pass-through 策略，维持基础 Pi 可用性。
- Plan 保存拒绝纯空白 markdown；Plan 读取、Plan Review 和 approval 对丢失或空计划给出显式错误。approval 只有在有效 Final Plan 存在时生成 journal/handoff。
- `.pi/workflow/` 的直接 `read` 与 `write/edit` 在所有模式统一受保护；Plan 内容通过 Plan Mode 的 workflow plan 工具访问，Approved Work 依赖 handoff marker 与 approval journal。

## 代码与提交约定

- 文件使用 kebab-case；函数/变量 camelCase；类型 PascalCase；常量 UPPER_SNAKE_CASE。
- 仅类型依赖使用 `import type`。公共 API 或安全边界使用 JSDoc；文件内职责分区沿用 `// ── ... ──`。
- 路径操作使用 `node:path`；外部进程优先 `execFile`/argv，涉及 shell 命令时维持现有守卫和确认流程。
- git 历史采用 Conventional Commits：`feat`、`fix`、`refactor`、`docs`、`test`、`chore` 等，可使用 `(workflow)` 等 scope；主题行以英文祈使式为主。

- `paths.ts` 中的 `planDir()` 与 `globalConfigPath()` 是纯路径函数，目录创建集中到写入路径（`writeNewPlan`、`writeRawJsonAtomic`）。

## 已知仓库偏差

- 无。`config.json.example` 与五个模型角色闭集一致。
