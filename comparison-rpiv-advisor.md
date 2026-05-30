# rpiv-advisor vs pi-workflow Plan Review 对比分析

## 1. 架构原理对比

### rpiv-advisor — "Advisor-Strategy Pattern"（顾问策略模式）

**核心思想**: 工作模型（executor）在遇到自己无法合理解决的决策时，主动调用 `advisor()` 工具，将完整对话分支交给一个更强/不同的审查模型（如 Opus），获取 guidance 后继续执行。

**运行机制**:
- executor 在当前 session 的一个 **tool call** 中调用 `advisor()`
- `advisor()` 是零参数工具 — 不需要 LLM 传递上下文，代码自动从 `ctx.sessionManager` 序列化完整对话分支
- 对话分支经过精心处理:
  1. `stripInflightAdvisorCall()` — 移除 executor 正在进行的 `advisor()` toolCall（避免 orphan toolCall 导致 provider 拒绝）
  2. `ensureUserTailForAdvisor()` — 确保对话末尾是 user-role（某些 provider 拒绝 assistant-prefill 尾部）
  3. `getInventoryMessage()` — 在对话前插入 executor 的完整工具清单（让 advisor 能判断工具选择是否正确）
  4. `buildSessionContext()` — 保留 Pi 的已解析 LLM 上下文（包括 compaction summaries 和 branch summaries），而非重新 replay 原始分支消息
- advisor 模型通过 `completeSimple()` 进行一次 **无工具** 的 LLM 调用（纯文本响应，不迭代）
- advisor 系统提示:
  > "You are an advisor model in an advisor-strategy pattern... You read the shared conversation context and return ONE of: a plan (concrete next steps), a correction (redirect wrong path), a stop signal (halt and escalate to user)."
- advisor 结果作为 tool result 返回给 executor，executor 消取 guidance 后继续当前 turn 的后续行动
- **整个 advisor 交互发生在 executor 的同一个 turn 内**，不会中断用户对话流程

### pi-workflow Plan Review — "Subagent Isolation Pattern"（子代理隔离模式）

**核心思想**: 计划保存后，工作流状态机自动进入 `planReview` 步骤，主模型调用 `workflow_subagent(type="plan-review")`，在一个完全隔离的子代理进程中审查计划，结果返回给主模型进行讨论。

**运行机制**:
- 工作流状态机从 `plan` → `planReview`（自动，无需用户干预）
- 主模型调用 `workflow_subagent(type="plan-review")` 工具
- 工具内部通过 `@tintinweb/pi-subagents` 的 `spawnAndWait()` 在独立进程中 spawn 一个子代理
- 子代理配置:
  - agent `.md` 文件定义工具权限（只读，禁止 write/edit/extensions）
  - `disallowed_tools: workflow_plan, workflow_todo, workflow_subagent, workflow_status` — 防止审查代理操作工作流状态
  - 模型/thinking 由 `config.json` 统一配置
- 子代理的 prompt 由 `promptForSubagentRole("planReview")` 生成，包含:
  - 隔离声明："You are running as an isolated subagent with a fresh context — no parent session history"
  - 审查焦点（Spec Compliance, Feasibility, Execution Readiness, Coverage, Scope Creep, Dependencies, Risks, Todo Granularity）
  - 结构化输出格式（`[pi-workflow-plan-review/v1]` + Critical/Important/Minor 分级）
  - Identity marker 验证（确保审查代理正确加载了审查提示）
- 子代理可以有多个 turn（多轮对话），直到完成任务或达到 `maxTurns` 限制
- 结果通过 `spawnAndWait()` 返回给主模型
- 主模型拿到审查结果后自行评估:
  - Critical/Important → 修订计划 → 重新保存 → 再次审查（循环）
  - Minor → 接受并继续
  - 分歧无法解决 → 2-3 轮后交用户裁决
- 审查循环由 prompt 自约束（不需要外部硬限制）
- **子代理是完全隔离的进程**，有自己的 context window，不共享主 session 的对话历史

---

## 2. 关键差异总结

| 维度 | rpiv-advisor | pi-workflow Plan Review |
|------|-------------|------------------------|
| **触发方式** | executor 主动决定何时需要 advice | 工作流状态机自动触发，计划保存后必经 |
| **上下文传递** | 自动序列化完整对话分支（含 compaction） | 只传递计划文本 + 预设审查提示 |
| **隔离级别** | 同 session 内的 side-call（无独立进程） | 完全隔离的子代理进程 |
| **advisor 能力** | 看到完整对话历史，能判断工具使用是否正确 | 只看到计划文本，看不到对话历史 |
| **迭代模式** | 单次 `completeSimple()`（无工具，不迭代） | 子代理可多 turn 迭代（受限工具集） |
| **结果形态** | plan / correction / stop signal（自由文本） | 结构化分级（Critical/Important/Minor） |
| **模型选择** | 用户通过 `/advisor` UI 任意选择 | `config.json` 固定配置 |
| **何时生效** | 零参数，默认关闭，选择模型后启用 | 工作流内置步骤，不可关闭（只能调模型/thinking） |
| **与工作流集成** | 通用顾问，无工作流状态绑定 | 严格嵌入 Plan→Work→Review→Commit 流程 |
| **错误处理** | 详尽的 error path（no model, no API key, abort, empty, call failed） | identity marker 验证 + subagent spawn 诊断脚本 |
| **对话中断** | 不中断 — executor 在同一 turn 内继续 | 跨 turn — 等待子代理返回后下一个 turn 处理 |

---

## 3. 可借鉴之处

### 3.1 ⭐ 高价值：自动序列化对话分支作为审查输入

**rpiv-advisor 的做法**: `buildSessionContext()` + `convertToLlm()` 自动获取完整对话上下文（含 compaction summaries），advisor 能看到 executor 做了什么、为什么这样做。

**pi-workflow 当前**: plan review 子代理只看到计划文本，不知道主模型在对话中讨论了什么、用户提出了什么约束。

**借鉴**: 在 `workflow_subagent` 的 prompt 构建中，除了计划文本，可以增加：
- 主模型与用户的对话摘要（关键决策点和用户约束）
- 相关文件的关键片段（子代理当前也能通过 read 工具访问，但需要自己判断读什么）
- 历次计划修订的 diff（让审查者知道修订了什么）

**实现方式**: 在 `promptForSubagentRole("planReview")` 中，从 `ctx.sessionManager` 提取摘要信息注入到 prompt。不过需要注意 — 我们的子代理是完全隔离进程，无法直接访问 `ctx.sessionManager`。可以考虑在 `spawnAndWait` 之前，由主模型代码提取关键上下文片段，作为 prompt 的一部分传递。

### 3.2 ⭐ 高价值：`completeSimple` 单次调用模式作为 "快速审查"

**rpiv-advisor 的做法**: advisor 只做一次 `completeSimple()` 调用（无工具），快速返回结构化意见。轻量、确定性高、延迟可控。

**pi-workflow 当前**: 子代理可以多 turn 迭代，不确定性更高（可能超时、可能跑偏）。

**借鉴**: 可以为 plan review 提供两种模式:
- **快速审查模式**: 一次 `completeSimple`（类似 advisor），只返回结构化意见，延迟可控
- **深度审查模式**: 当前子代理模式，可读文件、多 turn 迭代

这在 `workflow_subagent` 中可以作为 `quick` 选项实现:
```typescript
workflow_subagent(type="plan-review", mode="quick")  // 单次 completeSimple
workflow_subagent(type="plan-review", mode="deep")   // 当前子代理模式
```

### 3.3 ⭐ 中价值：Executor 主动触发 vs 状态机强制触发

**rpiv-advisor**: executor 自己决定什么时候需要 advice — 更灵活，减少不必要审查。

**pi-workflow**: 状态机强制触发 — 保证每份计划都经过审查，但可能审查一些已经很简单的计划。

**借鉴**: 可以考虑增加配置选项，让用户决定 plan review 是否每次都强制触发:
```json
{
  "planReview": {
    "autoTrigger": true,   // 当前行为：计划保存后自动触发
    "manualTrigger": false  // 新选项：只让 executor 自行决定是否调用
  }
}
```

但这会降低工作流的一致性保障，需要权衡。

### 3.4 ⭐ 中价值：Tool Inventory Prefix — 让审查者理解 executor 的能力边界

**rpiv-advisor**: 在对话前插入 executor 的完整工具清单，让 advisor 能判断"executor 是否使用了正确的工具"。

**pi-workflow**: plan review 子代理通过 agent `.md` 的 `disallowed_tools` 限制了工具，但没有明确告诉审查者 executor 有哪些可用工具。

**借鉴**: 在 plan review prompt 中注入 executor 的可用工具清单，让审查者能评估：
- 计划中提到的操作是否有对应工具支持
- executor 是否忽略了某些可用工具

### 3.5 ⭐ 低价值但有趣：Per-executor blocklist

**rpiv-advisor**: `disabledForModels` blocklist — 当 executor 本身就是强模型时（如已经是 Opus），自动禁用 advisor（避免 Opus 问 Opus）。

**pi-workflow**: 没有类似机制。如果 executor 和 reviewer 用的是同一个模型，审查意义降低。

**借鉴**: 在 `config.json` 中增加 `skipReviewForModels` 或类似配置:
```json
{
  "planReview": {
    "skipForExecutorModels": ["anthropic:claude-opus-4"]  // 如果 executor 已经是 Opus，跳过 plan review
  }
}
```

### 3.6 ⭐ 低价值：Guidance Fields / 结果结构化

**rpiv-advisor**: advisor 返回自由文本（plan/correction/stop），但结果 envelope 有结构化 `details` 字段（model, effort, usage, stopReason, errorMessage）。

**pi-workflow**: plan review 输出有 `[pi-workflow-plan-review/v1]` 结构化标记 + Critical/Important/Minor 分级。

我们的结构化做得更好，这方面不需要借鉴 advisor。

---

## 4. 不应借鉴之处

### 4.1 ❌ 放弃子代理隔离

rpiv-advisor 的 side-call 模式在同一 session 内运行，advisor 看到完整对话但无法独立操作。对于**通用顾问**这很好，但对于**工作流审查**，隔离是核心价值:
- 防止审查代理被 executor 的上下文偏见影响
- 防止审查代理操作工作流状态（approve/modify plan）
- 确保审查结果是独立视角

我们的子代理隔离模式更适合工作流场景。

### 4.2 ❌ 让审查者无工具

rpiv-advisor 的 advisor 无工具（纯文本响应），因为它的目标是快速 guidance。但 plan review 需要验证计划的可行性 — 这通常需要读代码、检查现有模式。我们的子代理有受限工具集（read 等），更适合深度审查。

### 4.3 ❌ 零参数自动传上下文

rpiv-advisor 的零参数 + 自动序列化对话对通用顾问很好（executor 不需要手动描述问题），但 plan review 的输入应该是**计划文本**而非对话历史。对话历史可能包含大量无关讨论，而计划是精炼后的产物。我们应该选择性传递关键上下文（如上 3.1 所述），而非盲目传递全部对话。

---

## 5. 总结

**rpiv-advisor 的核心创新**在于: "executor 在同一 turn 内调用更强模型获取 guidance" 的轻量模式。它精于**实时决策辅助**，而非**结构化工作流审查**。

**对我们最有价值的借鉴**:
1. **选择性注入对话上下文到审查 prompt** — 让审查者知道讨论了什么，不只是看到计划
2. **提供 `completeSimple` 快速审查模式** — 作为深度子代理审查的轻量替代
3. **注入 executor 工具清单到审查 prompt** — 让审查者评估工具选择
4. **同模型审查跳过机制** — 避免"Opus 审 Opus"的无意义审查

**不应改变的**:
- 子代理隔离架构（我们的核心优势）
- 结构化分级输出（比 advisor 的自由文本更适合工作流）
- 受限工具集（审查需要读代码）
- 状态机强制触发（保证每份计划都经过审查）