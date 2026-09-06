# AGENTS.md — pi-workflow

## 项目边界

- 本仓库是 `pi-coding-agent` 的 TypeScript 扩展包；扩展入口由 `package.json#pi.extensions` 注册为 `extensions/workflow/index.ts`。
- 使用 ESM、Node16 模块解析、TypeScript strict/noEmit；源码导入本地模块时保留 `.js` 后缀，Node 内置模块使用 `node:` 前缀。
- 当前 `@earendil-works/pi-*` 0.84.3 依赖要求 Node.js `>=22.19.0`。
- 不依赖其他 Pi 扩展。结构化问答包 `@juicesharp/rpiv-ask-user-question` 属于可选安装。

## 验证与本地安装

仓库没有 package scripts、CI 或部署流程。提交相关改动前运行：

```bash
npx tsc --noEmit
node scripts/validate-todo-regression.mjs
node scripts/validate-mode-injection.mjs
node scripts/validate-rpc-mode.mjs
node scripts/validate-plan-review-agent.mjs
node scripts/validate-git-integration.mjs
node scripts/validate-model-context.mjs
```

本地安装与重载：

```bash
pi install .
# Pi 内执行
/reload
```

## 模块边界

- `index.ts`：扩展入口和注册编排。
- `commands.ts`：命令、事件钩子、模式入口与写入权限拦截。`/workflow:merge` 解析 `--target`/`--`/尾随指令并经 preflight 后原子持久化 mergeContext、切换 Merge Mode、发送简短 kickoff（active merge 重入不覆盖基线/授权）；`/workflow:commit`（原 `/commit`，无兼容 alias）与所有会切换模式的入口在 active merge 时给出完成/取消提示，`/workflow:reset` 先复用 abort/forced-reattach 再清 state；Work/Merge 共用 worktree 文件边界，Merge 走 merge-aware 校验。
- `tools.ts`：`workflow_*` 工具及持久化状态转换。`workflow_merge_complete`（status completed/cancelled + optional finalize ff-only/already-integrated）：defaultStrategy 强制 ff-only（误传 already-integrated 显式拒绝且保留 state）、default 路径 finalizer + 严格完成校验、custom 路径健康诊断并在用户指令删除 worktree 时清理 state 字段、cancel 走 sequencer abort + guarded reattach，成功后清 mergeContext、恢复 returnMode 并 terminate 当前 turn；`resolveEffectiveCwd` 在 Merge Mode（workflow-worktree 来源）改用 merge-aware 校验。`workflow_plan_review` 在启动 child agent 前完成：旧会话 `planRunId` 自愈/saveState、单次 requirements/tool-surface/protocol 快照、repository fingerprint、basis/task/decision hash、历史加载与 full/incremental/reused 判定、effective verdict（submitted PASS 缺少成功仓库检查时降级 FAIL）、短路复用与轮次持久化；工具参数为单个 optional `feedback`（仅上一轮存在时接受），legacy `task/context/instructions` 继续丢弃。
- `git-integration.ts`：/workflow:merge 的 Git 集成纯模块（argv-only git，无本地 value import，可被验证脚本直接 import）：命令参数解析（`--target`/`--target=`/`--` 与逐字尾随指令）、repo root/来源分支/同仓 worktree 映射、sequencer 检测（rebase-merge/rebase-apply/MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD）、preflight（来源判定优先级、target 推断 origin/HEAD 映射分支 → master → main、dirty/detached/source==target/未结束操作拒绝、基线 heads 与 source-only 计数）、default ff finalizer（目标已 checkout 走该 worktree `merge --ff-only`，未 checkout 走 ancestor + expected-old `update-ref` CAS）、default 完成校验、custom 完成健康诊断（含 worktreeGone 判定）、cancel/abort + guarded forced reattach（`checkout -f` 按取消语义丢弃在途冲突解决）。
- `mode.ts` / `prompts.ts` / `helpers.ts`：模式工具可见性、模式提示词、运行时消息。`merge` Mode 复用 `work` 模型角色，工具面仅 `workflow_merge_complete`；`helpers.ts` 提供 MERGE_CONTEXT_MARKER 与 `buildMergeContextBody`，context 处理器每轮从 state 重建隐藏 canonical user 消息。`mode.ts#setRole` 在应用角色模型时校验并浅克隆 `contextWindow`（registry 对象不变），维护 session-local ownership bookkeeping（不持久化）；`restoreModeRuntime` 前置幂等窗口 reconcile（同 provider/id 且窗口漂移才重应用，保存/恢复用户 thinking；手动非角色模型不动）；`model_select`/`session_tree` 事件与 `reconcileContextWindowForSession` 复用同一逻辑；disable/reset/shutdown 通过 `releaseContextWindowOverride`/`clearContextWindowOwnership` 释放仅匹配活动克隆的覆盖。
- `state.ts` / `paths.ts` / `config.ts` / `defaults.ts` / `types.ts`：状态、路径、配置合并、默认值和共享类型。`ModelSpec` 支持可选 `contextWindow`（tokens），`normalizeConfig` 原样保留非法值，仅在应用/编辑边界报错。
- `model-context.ts`：per-role `contextWindow` 的纯数值解析/校验、模型浅克隆、压缩设置快照（主会话 trust-aware 磁盘快照；reviewer 用准备阶段共享的 SettingsManager 实例）与哈希序列化。硬约束：正整数 safe integer，严格小于 Pi registry 基准窗口（含相等），大于 `reserveTokens + keepRecentTokens`；非法值显式报错，禁止 clamp/静默丢弃。
- `settings.ts`：`/workflow:settings` 的 session/project/global 三层配置 TUI/RPC。六角色提供 `contextWindow` 数值输入（TUI 复用单行输入、RPC `ui.input`；空白清除继承；非法输入报错并保持原值；写入前按“合并到正在编辑层”的候选配置 + registry 模型 + 磁盘压缩快照校验，provider/model 变更同步复核保留的窗口）。
- `plan-review-history.ts`：Plan Review 轮次历史与缓存决策纯函数——session 级 `plan-review-history.json` 按 `planRunId` 隔离、最多 3 个实际 reviewer 轮次（短路不追加）、fail-safe 加载（缺失/损坏/非法 effective verdict 一律视为无历史）、aliased `normalizePlanReviewFeedback` 与显式 `PLAN_PREVIOUS_ROUND_TEXT_BUDGET`、fenced-code-aware Markdown section hash/delta、basis/task/decision hash（protocol 文本经参数传入避免运行时环；basis hash 额外包含结构化 reviewer context basis：configured 覆盖、Pi 基准、有效窗口、压缩快照，任何变化触发 full review 并一次性失效旧缓存）、`decidePlanReviewMode` 判定与短路诊断。
- `plan-review-agent.ts`：独立 reviewer 的共享 runner 与 Plan Review 入口——`runIndependentReviewer`（参数化 review cwd、`{ primaryCwd, reviewCwd }` 双 workflow-root 安全扩展、system prompt、authoritative task、进度标签；父会话活动工具面重建排除 workflow 工具，内置工具由 `createAgentSession` 重建，外部扩展/MCP/Web 工具从 sourceInfo.path 重建，pi-workflow 自身不加载；optional `toolSurface` 预计算快照，缺省时内部重建；`tool_execution_start` 计数进度并记录 `calledToolNames`、`tool_execution_end` 仅在 `isError === false` 时收集 `successfulToolNames`）、`prepareReviewerModelPlan` 在 tools 层缓存判断前准备 child ModelRuntime + 解析模型 + 应用已校验的 contextWindow 克隆 + 创建与父会话对齐 Project Trust 的 SettingsManager（同一实例交给校验、DefaultResourceLoader 与 createAgentSession；未信任项目 child 改用 global/default 压缩设置）、`contextBasis` 结构化上下文基准供双哈希使用、child-session-only `review_submit` 终止工具（StringEnum PASS/FAIL schema、`executionMode: "sequential"`、`terminate: true`；runner-owned collector 重复提交 last-success-wins、零提交 fail-closed FAIL；工具追加进 child `tools` allowlist 且不进入继承面 diagnostics 与任何 repo-evidence 集合）、共享结果携带 `verdict`/`verdictReason`、reviewer 模型/auth 复制、隔离 in-memory AgentSession、总时限中断与 `finally` 清理、进度与嵌套用量聚合。Plan 专属：单一静态协议常量源 + `buildPlanReviewProtocolText()`（task 与 protocol hash 同源，prompt 编辑自动失效旧缓存）、`buildReviewerTask` 的 previous-round/sectionDelta/decisionsChanged/feedback 注入、`PlanReviewResult.hasSuccessfulRepoInspection`（strict finalized builtin repo tools）。`runPlanReviewAgent` 接收工具层已提取的 requirements、预计算 toolSurface 与 prepared 模型快照。
- `review-agent.ts`：统一按需 Review Agent——独立 system prompt（验证需求覆盖、todo 真实完成、跨模块接入、验收与错误路径；`codeReview.enabled` 时注入 workspace OCR normalized findings 并要求逐条 disposition/误判举证；Work feedback 明确标记为非权威、逐条独立查证、无法证实即忽略、不可豁免 requirements/todos/prior findings 也不可单独支持 PASS；禁 edit/write/git mutation/依赖安装/后台进程，结束前检查 `git status`）、Approved/Direct task builder（仅权威输入，排除父 Work 总结/diff/测试声明；唯一例外是 Work 显式提交的单条标注为 Untrusted、必须独立复核的非权威 feedback，按 markdown indented code block 隔离，正文里的 heading/verdict 不会成为 task 结构元素）、`buildImplementationReviewProtocolText()` 单一构建函数（system prompt + submit 指令，作为 workflow_review 的 task-input hash 输入，协议变化一次性失效旧协议缓存轮）、`runReviewAgent` 在 validated review cwd 委托共享 runner 并从 `calledToolNames ∩ REPO_TOOL_NAMES` 追踪 `madeRepoToolCall`（零仓库工具调用的 PASS 被拒绝；强制 `review_submit` 提交本身不构成仓库检查证据）。`includeOcr` 控制是否运行 workspace `runOcrReview` + `parseOcrReviewJson` 并把 findings 注入 task；OCR CLI 缺失/执行失败/解析失败拋出显式错误，本轮不产生 verdict。reviewer 在同一最终 assistant message 内输出完整报告并调用 `review_submit` 提交 verdict（缺失提交 fail-closed FAIL），verdict 瞬时，不写入 WorkflowState，也不门禁 `/workflow:commit`。
- `ocr-helpers.ts` / `ocr-result.ts`：OCR 参数与执行、`buildReviewArgv`（workspace-only）、JSON 解析、归一化、去重与 compact 结果；复用 `terminal-text.ts`。
- `review-history.ts`：review 轮次持久化与增量——每轮 verdict/完整输出/OCR findings/diff 指纹/task-input hash 写入 session 级 `review-history.json`（按 workRunId 隔离、最多 3 轮、原子写、`/workflow:reset` 清理），`computeWorkspaceDiffSnapshot`（git argv，HEAD + `diff HEAD` + porcelain 文件名集合 + untracked 内容 hash，staging 不扰动指纹，超界标记 unknown），纯函数 `computeTodoHash`/`filesChangedSince`/`boundedHeadTail`/`computeTaskInputHash`（输入含当前 reviewer protocol text 与结构化 reviewer context basis，协议或上下文基准变化使 unchanged-diff 短路对旧轮失效一次）。verdict 仍瞬时，不写入 WorkflowState。
- `ocr-result.ts`：OCR JSON 解析、归一化、去重与 compact 结果；复用 `terminal-text.ts`。
- `terminal-text.ts`：无状态 ANSI/控制字符清理，提供保留换行与移除全部控制字符两种语义。
- `worktree.ts` / `guards.ts`：worktree 生命周期和文件/命令权限边界；worktree branch/workRun 匹配由 `worktree.ts` 导出的纯 helper 维护，`state.ts` normalization 复用。worktree 校验分三层：`validateWorktreeIdentity`（身份：绝对路径、真实目录、非主 checkout、同 git common dir）、`validateWorktreeState`（严格 = identity + branch checkout，供 Work/Review/Commit/reset）、`validateMergeWorktreeState`（merge-aware：仅 merge mode、workflow-worktree 来源、sourceBranch 与 worktreeBranch 一致且该 worktree 检测到 rebase sequencer 时容忍 detached HEAD；sequencer 消失即恢复严格匹配）。
- `todo-overlay.ts`：todo widget 生命周期与 session-local 隐藏 bookkeeping（不持久化）。

新增职责优先放入对应模块；跨模块共享类型集中在 `types.ts`，默认值集中在 `defaults.ts`。

## 持久化与状态机约束

- 运行时状态只能通过 `loadState()` / `saveState()` 访问；`saveState()` 负责建目录和规范化。业务代码不得直接写 session state 文件。
- session 状态位于 `.pi/workflow/sessions/<safeSessionKey>/state.json`；session key 由 session 标识哈希生成。计划文件共享存放在 `.pi/workflow/plan/`，文件名随机化。
- 配置优先级固定为 `DEFAULT_CONFIG ← global ← project ← session`。模型角色闭集为 `explore | plan | planReview | review | work | commit`；load-time gate（`workflow.autoEnter`、`planReview.enabled`、`review.enabled`）变更需要 `/reload`；`codeReview.enabled` 是统一 Review 内部的 OCR 开关，可随会话即时覆盖。
- `Mode` 是闭集。新增模式时同步更新 `types.ts`、`prompts.ts`、`helpers.ts`、`mode.ts` 的 exhaustive switch，并保留 `assertNever()` 保护。
- 状态变更后立即 `saveState()`；模式切换走现有 transition/runtime helper，保持持久化状态、工具可见性和当前模型同步。
- `workflow_plan_approve` 要求当前 todo 非空，深拷贝为不可变 `approvedTodos`；可选择创建独立 worktree。active worktree 存在时，文件工具只能写其绝对路径；bash cwd 由扩展重定向到 worktree。
- Init Mode 仅允许写记录在 `initTargetPath` 的单个 `AGENTS.md`；完成、跳过或取消均通过 `workflow_init_complete` 恢复原模式。`/workflow:merge` 在 Init Mode 显式拒绝，防止 mode 切换清掉 `initTargetPath`/`initReturnMode`。
- Merge Mode 的 `mergeContext` 只在 `mode === "merge"` 且完整基线形状通过 `normalizeMergeContext` 校验时保留（来源/目标分支、基线 heads、计数、defaultStrategy、returnMode 缺一即 fail-closed 为 undefined）；其他模式一律清除，防止陈旧 merge 基线泄漏。Work Mode 维持全部 Git 写禁令；常规提交只由 `/workflow:commit` 执行；分支集成及其必要提交只由 Merge Mode 执行。

## 工作流特有行为

- 六个模型角色支持可选 `contextWindow`（tokens，严格小于 Pi 默认窗口且大于压缩预留）：主会话以浅克隆应用并维护 session-local ownership（disable/reset/shutdown/清除字段释放仅匹配活动克隆的覆盖，恢复幂等零额外切换）；独立 reviewer 由 `prepareReviewerModelPlan` 在缓存判断前统一准备模型克隆与 SettingsManager 快照（Project Trust 与父会话对齐，未信任项目 child 使用 global/default 压缩设置），双缓存哈希纳入结构化 context basis。缩小窗口会收紧 Pi 的请求输出 clamp 并增加压缩频率。详见 `model-context.ts` 与 README。
- Workflow 默认 opt-in；`/workflow:settings` 始终可用，其他工作流命令由 `/workflow:enable` 或 `workflow.autoEnter` 开启。
- Explore/Plan 是只读模式；Plan 文件通过 `workflow_plan_save` 写入，Work 使用 `workflow_todo` 跟踪任务。
- Plan Mode 在最终保存前执行 grilling 并持久化 `grillTurns`；`workflow_plan_save` 同时将已确认决策快照到 `planReviewDecisions`。Plan Review 是启用后由模型按复杂度选择发起的可选独立 agent：它在隔离的 in-memory AgentSession 中继承当前 Plan 会话的信息工具面（排除 workflow 工具），自行探索仓库与外部信息工具重新验证计划，只收到权威输入（本轮计划生命周期内的用户需求 + `planReviewDecisions` + 保存的 Final Plan）；它属于 Plan Mode 内工具调用，受一条 30 分钟总时限约束。同 plan run 内轮次有连续性（plan-review-history）：仓库 + basis（需求/模型/thinking/工具面/实际协议文本）+ 完整 task input（Final Plan + confirmed decisions + feedback）一致时短路复用上一轮（零本轮开销、不追加轮次）；计划/决策/feedback 变化时增量复核（注入上一轮 bounded 输出 + section delta + `decisionsChanged`，要求重新验证完整需求→决策→计划映射并逐条 re-disposition）；仓库、需求或 basis 变化时完整重审。verdict 由 reviewer 在同一最终 assistant message 末尾通过 child-only `review_submit` 工具提交（零提交 fail-closed FAIL、重复提交 last-success-wins），瞬时评估信号，不门禁 approval（始终由用户确认驱动）。
- `/workflow:review` 复用 Work runtime，驱动 OCR review/fix/re-review 循环。`ocr` 二进制名固定，参数使用 argv 数组执行，避免 shell 插值。
- 两个独立的审查概念：(1) 可选 Plan Review（`workflow_plan_review`，Plan Mode 内模型按复杂度发起，`planReview.enabled` 控制；optional `feedback` 仅在当前 plan run 已有上一轮 review 时接受，注入为 UNTRUSTED 缩进代码块，reviewer 逐条独立验证）；(2) 按需统一 Review（`workflow_review`，默认开启，`review.enabled` 控制 `/workflow:review` 与工具可用性；`codeReview.enabled` 控制统一 Review 是否包含 workspace OCR）。两套 reviewer 的仓库检查证据与短路 round 策略不同：Plan Review 使用 strict finalized builtin repo tools（`tool_execution_end` 且 `isError === false` 的 read/bash/grep/find/ls）作为 cacheability 与 effective-PASS 门槛（submitted PASS 缺证据降级 FAIL），短路不写新 round；Implementation Review 的 `madeRepoToolCall` 改由 `calledToolNames`（实际发起的工具调用）判定，short-circuited round 仍持久化；两套 reviewer 的强制 `review_submit` 提交都不计入仓库检查证据。Review 结果是瞬时工具输出，不写入 WorkflowState，也不门禁 `/workflow:commit`。同 work run 内 review 轮次有连续性：下一轮任务注入上一轮的 findings/verdict/变更文件 delta 并要求逐条 re-disposition（复用上一轮证据，不从头推导）；diff 指纹未变时复用缓存的 OCR findings；diff + 全部权威输入（含当前 reviewer protocol text）与上一轮完全一致时直接短路返回上一轮 verdict；Work 可通过 `workflow_review({ feedback })` 对上一轮争议 finding 提交非权威技术理由，feedback 纳入 task hash（变化会绕过短路、启动新 reviewer），但正文不写入 WorkflowState，也不单独持久化到 review-history。
- 最终提交流程：实现完成后用户可选用 `/workflow:review` 跑统一 Review（包含可选 workspace OCR）；Review verdict 与 `/workflow:commit` 解耦——`/workflow:commit` 始终直接可用，无需 Review PASS。
- Merge Mode（`/workflow:merge [--target <branch>] [指令]`）是用户显式触发的 Git 集成入口：来源优先取 session state 的 active workflow worktree 分支（bash/read/edit/write 继续作用于 worktree），否则取当前 checkout 的普通本地分支；target 显式指定（本地分支）或按 worktreeBaseBranch / origin-HEAD→master→main 推断。默认策略（无尾随指令）= rebase 来源到目标 + `workflow_merge_complete(finalize="ff-only")` 确定性 ff，目标已 checkout 在 worktree 时用 `merge --ff-only`、未 checkout 时用 ancestor+expected-old `update-ref`；全程保留来源分支/worktree 并停留来源分支，禁止 push/force/clean/删除。尾随指令是本轮唯一授权来源，仅逐字点名的动作可突破默认禁令；custom 完成走策略无关健康诊断（`already-integrated`），也可复用 ff finalizer。`defaultStrategy` 在工具层强制 ff-only，误传 `already-integrated` 显式报错并保留 state。mergeContext 基线（heads/计数/授权/returnMode）在 kickoff 前原子持久化，仅 `mode === "merge"` 时保留，每轮由 context 处理器从 state 重建隐藏 user 消息注入；cancel/reset 复用 sequencer abort + guarded forced reattach（丢弃在途冲突解决，与 abort 语义对齐），已完成的 ref 移动只报告不隐式回滚。
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

- 无。`config.json.example` 与六个模型角色闭集（含 `review`）一致；示例 `plan.contextWindow: 150000` 小于 claude-opus-4-5 的 Pi 默认窗口 200000 且大于默认压缩预留 36384，满足严格校验。
