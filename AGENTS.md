# AGENTS.md — pi-workflow

## 项目边界

- 本仓库是 `pi-coding-agent` 的 TypeScript 扩展包；扩展入口由 `package.json#pi.extensions` 注册为 `extensions/workflow/index.ts`。
- 使用 ESM、Node16 模块解析、TypeScript strict/noEmit；源码导入本地模块时保留 `.js` 后缀，Node 内置模块使用 `node:` 前缀。
- 当前 `@earendil-works/pi-*` 0.81.1 依赖要求 Node.js `>=22.19.0`。
- 不依赖其他 Pi 扩展。结构化问答包 `@juicesharp/rpiv-ask-user-question` 属于可选安装。

## 验证与本地安装

仓库没有 package scripts、CI 或部署流程。提交相关改动前运行：

```bash
npx tsc --noEmit
node scripts/validate-todo-regression.mjs
node scripts/validate-mode-injection.mjs
node scripts/validate-rpc-mode.mjs
node scripts/validate-plan-review-agent.mjs
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
- `tools.ts`：`workflow_*` 工具及持久化状态转换。`workflow_plan_review` 在启动 child agent 前完成：旧会话 `planRunId` 自愈/saveState、单次 requirements/tool-surface/protocol 快照、repository fingerprint、basis/task/decision hash、历史加载与 full/incremental/reused 判定、effective verdict（parsed PASS 缺少成功仓库检查时降级 FAIL）、短路复用与轮次持久化；工具参数为单个 optional `feedback`（仅上一轮存在时接受），legacy `task/context/instructions` 继续丢弃。
- `mode.ts` / `prompts.ts` / `helpers.ts`：模式工具可见性、模式提示词、运行时消息。
- `state.ts` / `paths.ts` / `config.ts` / `defaults.ts` / `types.ts`：状态、路径、配置合并、默认值和共享类型。
- `settings.ts`：`/wf-settings` 的 session/project/global 三层配置 TUI。
- `plan-review-history.ts`：Plan Review 轮次历史与缓存决策纯函数——session 级 `plan-review-history.json` 按 `planRunId` 隔离、最多 3 个实际 reviewer 轮次（短路不追加）、fail-safe 加载（缺失/损坏/非法 effective verdict 一律视为无历史）、aliased `normalizePlanReviewFeedback` 与显式 `PLAN_PREVIOUS_ROUND_TEXT_BUDGET`、fenced-code-aware Markdown section hash/delta、basis/task/decision hash（protocol 文本经参数传入避免运行时环）、`decidePlanReviewMode` 判定与短路诊断。
- `plan-review-agent.ts`：独立 reviewer 的共享 runner 与 Plan Review 入口——`runIndependentReviewer`（参数化 review cwd、`{ primaryCwd, reviewCwd }` 双 workflow-root 安全扩展、system prompt、authoritative task、进度标签；父会话活动工具面重建排除 workflow 工具，内置工具由 `createAgentSession` 重建，外部扩展/MCP/Web 工具从 sourceInfo.path 重建，pi-workflow 自身不加载；optional `toolSurface` 预计算快照，缺省时内部重建；`tool_execution_start` 计数进度、`tool_execution_end` 仅在 `isError === false` 时收集 `successfulToolNames`）、reviewer 模型/auth 复制、隔离 in-memory AgentSession、总时限中断与 `finally` 清理、进度与嵌套用量聚合。Plan 专属：单一静态协议常量源 + `buildPlanReviewProtocolText()`（task 与 protocol hash 同源，prompt 编辑自动失效旧缓存）、`buildReviewerTask` 的 previous-round/sectionDelta/decisionsChanged/feedback 注入、独立 fail-closed `parsePlanReviewVerdict`（前缀 `PLAN_REVIEW_VERDICT:`）、`PlanReviewResult.hasSuccessfulRepoInspection`（strict finalized builtin repo tools）。`runPlanReviewAgent` 接收工具层已提取的 requirements 与预计算 toolSurface。
- `review-agent.ts`：统一按需 Review Agent——独立 system prompt（验证需求覆盖、todo 真实完成、跨模块接入、验收与错误路径；`codeReview.enabled` 时注入 workspace OCR normalized findings 并要求逐条 disposition/误判举证；Work feedback 明确标记为非权威、逐条独立查证、无法证实即忽略、不可豁免 requirements/todos/prior findings 也不可单独支持 PASS；禁 edit/write/git mutation/依赖安装/后台进程，结束前检查 `git status`）、Approved/Direct task builder（仅权威输入，排除父 Work 总结/diff/测试声明；唯一例外是 Work 显式提交的单条标注为 Untrusted、必须独立复核的非权威 feedback，按 markdown indented code block 隔离，正文里的 heading/verdict 不会成为 task 结构元素）、`parseReviewVerdict` 严格 fail-closed 终行解析、`runReviewAgent` 在 validated review cwd 委托共享 runner 并追踪 `madeRepoToolCall`（零仓库工具调用的 PASS 被拒绝）。`includeOcr` 控制是否运行 workspace `runOcrReview` + `parseOcrReviewJson` 并把 findings 注入 task；OCR CLI 缺失/执行失败/解析失败拋出显式错误，本轮不产生 verdict。reviewer 输出 `REVIEW_VERDICT: PASS|FAIL`，verdict 瞬时，不写入 WorkflowState，也不门禁 `/commit`。
- `ocr-helpers.ts` / `ocr-result.ts`：OCR 参数与执行、`buildReviewArgv`（workspace-only）、JSON 解析、归一化、去重与 compact 结果；复用 `terminal-text.ts`。
- `review-history.ts`：review 轮次持久化与增量——每轮 verdict/完整输出/OCR findings/diff 指纹/task-input hash 写入 session 级 `review-history.json`（按 workRunId 隔离、最多 3 轮、原子写、`/wf-reset` 清理），`computeWorkspaceDiffSnapshot`（git argv，HEAD + `diff HEAD` + porcelain 文件名集合 + untracked 内容 hash，staging 不扰动指纹，超界标记 unknown），纯函数 `computeTodoHash`/`filesChangedSince`/`boundedHeadTail`/`computeTaskInputHash`。verdict 仍瞬时，不写入 WorkflowState。
- `ocr-result.ts`：OCR JSON 解析、归一化、去重与 compact 结果；复用 `terminal-text.ts`。
- `terminal-text.ts`：无状态 ANSI/控制字符清理，提供保留换行与移除全部控制字符两种语义。
- `worktree.ts` / `guards.ts`：worktree 生命周期和文件/命令权限边界；worktree branch/workRun 匹配由 `worktree.ts` 导出的纯 helper 维护，`state.ts` normalization 复用。
- `todo-overlay.ts`：todo widget 生命周期与 session-local 隐藏 bookkeeping（不持久化）。

新增职责优先放入对应模块；跨模块共享类型集中在 `types.ts`，默认值集中在 `defaults.ts`。

## 持久化与状态机约束

- 运行时状态只能通过 `loadState()` / `saveState()` 访问；`saveState()` 负责建目录和规范化。业务代码不得直接写 session state 文件。
- session 状态位于 `.pi/workflow/sessions/<safeSessionKey>/state.json`；session key 由 session 标识哈希生成。计划文件共享存放在 `.pi/workflow/plan/`，文件名随机化。
- 配置优先级固定为 `DEFAULT_CONFIG ← global ← project ← session`。模型角色闭集为 `explore | plan | planReview | review | work | commit`；load-time gate（`workflow.autoEnter`、`planReview.enabled`、`review.enabled`）变更需要 `/reload`；`codeReview.enabled` 是统一 Review 内部的 OCR 开关，可随会话即时覆盖。
- `Mode` 是闭集。新增模式时同步更新 `types.ts`、`prompts.ts`、`helpers.ts`、`mode.ts` 的 exhaustive switch，并保留 `assertNever()` 保护。
- 状态变更后立即 `saveState()`；模式切换走现有 transition/runtime helper，保持持久化状态、工具可见性和当前模型同步。
- `workflow_plan_approve` 要求当前 todo 非空，深拷贝为不可变 `approvedTodos`；可选择创建独立 worktree。active worktree 存在时，文件工具只能写其绝对路径；bash cwd 由扩展重定向到 worktree。
- Init Mode 仅允许写记录在 `initTargetPath` 的单个 `AGENTS.md`；完成、跳过或取消均通过 `workflow_init_complete` 恢复原模式。

## 工作流特有行为

- Workflow 默认 opt-in；`/wf-settings` 始终可用，其他工作流命令由 `/wf` 或 `workflow.autoEnter` 开启。
- Explore/Plan 是只读模式；Plan 文件通过 `workflow_plan_save` 写入，Work 使用 `workflow_todo` 跟踪任务。
- Plan Mode 在最终保存前执行 grilling 并持久化 `grillTurns`；`workflow_plan_save` 同时将已确认决策快照到 `planReviewDecisions`。Plan Review 是启用后由模型按复杂度选择发起的可选独立 agent：它在隔离的 in-memory AgentSession 中继承当前 Plan 会话的信息工具面（排除 workflow 工具），自行探索仓库与外部信息工具重新验证计划，只收到权威输入（本轮计划生命周期内的用户需求 + `planReviewDecisions` + 保存的 Final Plan）；它属于 Plan Mode 内工具调用，受一条 30 分钟总时限约束。同 plan run 内轮次有连续性（plan-review-history）：仓库 + basis（需求/模型/thinking/工具面/实际协议文本）+ 完整 task input（Final Plan + confirmed decisions + feedback）一致时短路复用上一轮（零本轮开销、不追加轮次）；计划/决策/feedback 变化时增量复核（注入上一轮 bounded 输出 + section delta + `decisionsChanged`，要求重新验证完整需求→决策→计划映射并逐条 re-disposition）；仓库、需求或 basis 变化时完整重审。verdict 前缀 `PLAN_REVIEW_VERDICT:`，瞬时评估信号，不门禁 approval（始终由用户确认驱动）。
- `/review` 复用 Work runtime，驱动 OCR review/fix/re-review 循环。`ocr` 二进制名固定，参数使用 argv 数组执行，避免 shell 插值。
- 两个独立的审查概念：(1) 可选 Plan Review（`workflow_plan_review`，Plan Mode 内模型按复杂度发起，`planReview.enabled` 控制；optional `feedback` 仅在当前 plan run 已有上一轮 review 时接受，注入为 UNTRUSTED 缩进代码块，reviewer 逐条独立验证）；(2) 按需统一 Review（`workflow_review`，默认开启，`review.enabled` 控制 `/review` 与工具可用性；`codeReview.enabled` 控制统一 Review 是否包含 workspace OCR）。两套 reviewer 的仓库检查证据与短路 round 策略不同：Plan Review 使用 strict finalized builtin repo tools（`tool_execution_end` 且 `isError === false` 的 read/bash/grep/find/ls）作为 cacheability 与 effective-PASS 门槛（parsed PASS 缺证据降级 FAIL），短路不写新 round；Implementation Review 维持现有 active-tools `madeRepoToolCall` 判定，short-circuited round 仍持久化。Review 结果是瞬时工具输出，不写入 WorkflowState，也不门禁 `/commit`。同 work run 内 review 轮次有连续性：下一轮任务注入上一轮的 findings/verdict/变更文件 delta 并要求逐条 re-disposition（复用上一轮证据，不从头推导）；diff 指纹未变时复用缓存的 OCR findings；diff + 全部权威输入与上一轮完全一致时直接短路返回上一轮 verdict；Work 可通过 `workflow_review({ feedback })` 对上一轮争议 finding 提交非权威技术理由，feedback 纳入 task hash（变化会绕过短路、启动新 reviewer），但正文不写入 WorkflowState，也不单独持久化到 review-history。
- 最终提交流程：实现完成后用户可选用 `/review` 跑统一 Review（包含可选 workspace OCR）；Review verdict 与 `/commit` 解耦——`/commit` 始终直接可用，无需 Review PASS。
- Plan save 后必须写入完整 todos 才能 approve（`workflow_plan_approve` 拒绝空 todo，并把当前 todos 深拷贝为不可变 `approvedTodos`）；Reviewer 的 bash mutation 属于 prompt-governed 限制（文件工具与主/worktree 两个 `.pi/workflow/` 根受硬 guard）。
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

- 无。`config.json.example` 与六个模型角色闭集（含 `review`）一致。
