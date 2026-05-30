# 重构方案：移除 @tintinweb/pi-subagents

## 新架构概览

```
当前:
  Plan Review ──→ pi-subagents (spawnAndWait, 隔离子进程, 有工具)
  Code Review ──→ pi-subagents (spawnAndWait, 隔离子进程, 有工具)
  Explore     ──→ pi-subagents (spawnAndWait, 隔离子进程)
  依赖: @tintinweb/pi-subagents (必须安装+配置+同步agent containers)

重构后:
  Plan Review ──→ completeSimple() (同一 turn, 无工具, 注入关键上下文)
  Code Review ──→ alibaba/open-code-review (独立 CLI `ocr review`)
  Explore     ──→ 移除 (用户自行安装 pi-subagents 使用其自带 explore)
  依赖: 无外部必须依赖 (ocr CLI 需要单独安装但非 pi 扩展依赖)
```

## 一、Plan Review: completeSimple 方案

### 与当前 pi-subagents 子代理对比

| 维度 | 当前 (pi-subagents) | 新方案 (completeSimple) |
|------|---------------------|------------------------|
| 调用方式 | `spawnAndWait()` — spawn 独立 Pi 进程 | `completeSimple()` — 同进程一次 API 调用 |
| 上下文 | 只传计划文本, 子代理自行读文件 | 计划文本 + 对话摘要 + 关键文件片段(预注入) |
| 隔离 | 完全隔离进程, 无 parent session 历史 | 同 session API 调用, 我们控制传入内容 |
| 工具 | 子代理有受限工具集(read/bash) | 无工具, 纯文本响应 |
| 延迟 | 子进程启动 + 多 turn 迭代 | 单次 API 调用, 秒级 |
| 可靠性 | spawn/RPC/超时风险 | 无子进程通信风险 |
| 依赖 | pi-subagents 必须安装 | 仅 pi-ai (Pi 内置) |
| 输出格式 | `[pi-workflow-plan-review/v1]` + 分级 | 相同格式 (prompt 控制) |
| Identity marker | 需验证子代理是否正确加载 | 不需要 (我们自己构建 prompt) |
| 配置 | agentTypes/installSource/rpcTimeout/resultTimeout/agent.md 同步 | 只需 modelSpec (provider/model/thinking) |

### 优势

1. **零外部依赖** — plan review 不需要任何额外安装
2. **反而信息更多** — 可以注入对话摘要(当前子代理完全看不到用户讨论了什么)
3. **更可靠更快** — 无子进程通信问题, 同一 turn 内完成
4. **配置大幅简化** — 只需一行 modelSpec

### 代价与缓解

| 代价 | 缓解措施 |
|------|----------|
| 审查者无工具(不能读文件) | 自动提取计划中引用的文件路径, 预读关键片段注入 prompt |
| 单次调用(不能迭代) | plan review 本身不需要迭代 — 看完计划给一次评审意见即可 |
| 非进程隔离 | 我们控制传入内容, 不传完整对话只传精选信息; 审查者无 workflow 工具, 无法操作状态 |

### 实现 Sketch

```typescript
// sidecall.ts
import { completeSimple, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function executePlanReviewSidecall(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  opts: {
    planMarkdown: string;
    conversationSummary?: string;  // 从 sessionManager 提取的关键摘要
    keyFileSnippets?: Record<string, string>;  // 计划引用文件的关键片段
    modelSpec: ModelSpec;
    signal?: AbortSignal;
  },
): Promise<AgentToolResult> {
  const systemPrompt = buildPlanReviewSystemPrompt(opts);
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.planMarkdown },
  ];

  const response = await completeSimple({
    model: `${opts.modelSpec.provider}/${opts.modelSpec.model}`,
    messages,
    thinking: opts.modelSpec.thinking,
    signal: opts.signal,
  });

  return {
    content: [{ type: "text", text: response.text }],
    details: {
      advisorModel: `${opts.modelSpec.provider}/${opts.modelSpec.model}`,
      effort: opts.modelSpec.thinking,
      usage: response.usage,
      stopReason: response.stopReason,
    },
  };
}
```

## 二、Code Review: alibaba/open-code-review 方案

### OCR 核心能力 (vs 当前 pi-subagents 子代理)

| 维度 | 当前 (pi-subagents) | alibaba/open-code-review |
|------|---------------------|--------------------------|
| 确定性规则 | ❌ 无 (纯 LLM 判断) | ✅ 内置: NPE/thread-safety/XSS/SQL-injection 等, 按文件类型匹配 |
| LLM Agent | 通用子代理(受限工具) | 专用审查 Agent(code_search/file_read/code_comment/file_find/file_read_diff) |
| 并行 | ❌ 单进程 | ✅ per-file goroutine 并行(默认8) |
| 上下文管理 | 子代理自行管理 | 三分区(frozen/compress/active), 超60%异步压缩 |
| 行级评论 | LLM 自由文本输出 | `code_comment` 工具 → 精确行级定位 |
| 规模 | 无特殊设计 | "Battle-tested at Alibaba's scale" |
| 语言支持 | 取决于 LLM | 系统规则: Java/TS/JS/KT/Go/Py/C++/C 等 |

### 这是升级而非降级

OCR 提供了我们 pi-subagents 子代理**做不到的能力**:
- **确定性规则** — 不依赖 LLM 判断就能发现 NPE/XSS 等常见问题, 减少漏检
- **专用审查工具** — `code_search` 可以跨文件引用审查, `code_comment` 精确行级定位
- **并行处理** — 大 diff 不需要串行逐文件审查
- **上下文压缩** — 长审查不会因 token 溢出丢失关键信息

### 需要解决的差异

| 问题 | 方案 |
|------|------|
| OCR 是独立 CLI, 不在 Pi session 内 | pi-workflow 的 `/review` 命令调用 `ocr review` CLI, 解析输出 |
| OCR 输出格式与 workflow 不同 | 需要适配层: OCR → workflow review 结果格式 (Critical/Important/Minor) |
| OCR 用自己的 LLM (独立配置) | 可以配置 OCR 使用与 workflow review 相同的模型 |
| workflow 的 baseline diff 语义 | `ocr review --from <workBaselineRef> --to HEAD` 直接复用 |
| 无 initial commit 的 repo | OCR 可能不支持; 需要保留 fallback 或预检 |
| OCR 结果的 workflow 状态更新 | 解析 OCR 输出后, 根据是否有 Critical 问题决定进入 fix 模式 |

### 集成方式

```typescript
// commands.ts 中 /review 命令的重写
async function handleReviewCommand(ctx, pi, state) {
  // 1. Pre-check: ocr binary 是否可用
  const ocrAvailable = checkOcrAvailable(); // `ocr version` exit code
  
  // 2. 构建 OCR 参数
  const fromRef = state.workBaselineRef ?? "HEAD~1";
  const ocrArgs = ["review", "--from", fromRef, "--to", "HEAD"];
  
  // 3. 调用 OCR CLI
  const ocrResult = execSync(`ocr ${ocrArgs.join(" ")}`, {
    cwd: ctx.cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300_000, // 5 min
  });
  
  // 4. 解析 OCR 输出 → workflow review 格式
  const reviewResult = parseOcrOutput(ocrResult);
  
  // 5. 更新 workflow 状态
  if (reviewResult.hasCritical) {
    // 进入 fix 模式
  } else {
    // review pass → 可以 commit
  }
}
```

## 三、需要删除/重构的模块

| 模块 | 操作 |
|------|------|
| `subagent.ts` (SubagentsClient) | **删除** → 新建 `sidecall.ts` (completeSimple) |
| `agents.ts` (agent .md 管理/同步/检测) | **删除** |
| `agents/pi-workflow-plan-review.md` | **删除** — prompt 内置到代码 |
| `agents/pi-workflow-code-review.md` | **删除** — 用 OCR CLI |
| `/wf-install-subagents` 命令 | **删除** — 不再需要 |
| `SubagentConfig` type | **简化** → 只保留 modelSpec, 删除 installSource/agentTypes/rpcTimeout/resultTimeout/autoInstall |
| `SubagentRole` type | **简化** → 移除 "review" 和 "explore", 只保留 "planReview" |
| `workflow_subagent` tool | **重写** → planReview 用 completeSimple, 移除 review/explore 路径 |
| `prompts.ts` 子代理 prompt | **重构** → plan review 合并为 sidecall 用的完整 system+user message |
| `baseline.ts` | **保留** — OCR CLI 需要相同语义的 baseline ref; `collectBaselineDiff` 等可能不再需要(OCR 自行处理 diff), 但 `workBaselineRef` 创建逻辑仍需要 |
| `index.ts` 的 pi-subagents 初始化 | **删除** — 不再需要 SubagentsClient |
| `scripts/check-subagent-diagnostics.mjs` | **删除** — 不再需要 |

## 四、配置对比

### 当前配置
```json
{
  "models": { "planReview": {...}, "review": {...}, "explore": {...} },
  "planReview": { "enabled": true, "maxLoops": 2 },
  "codeReview": { "enabled": true, "maxLoops": 3, "auto": true },
  "subagent": {
    "installSource": "npm:@tintinweb/pi-subagents",
    "rpcTimeoutMs": 5000,
    "resultTimeoutMs": 600000,
    "autoInstall": false,
    "agentTypes": { "planReview": "...", "review": "...", "explore": "..." },
    "maxTurns": { "planReview": 30, "review": 30, "explore": 30 }
  }
}
```

### 新配置
```json
{
  "models": { "planReview": {...} },
  "planReview": { "enabled": true },
  "codeReview": { "enabled": true },
  // 删除 subagent 整个 section
  // code review 的模型由 OCR 自行配置 (ocr config set)
}
```

配置项从 ~15 个减少到 ~4 个。

## 五、实施顺序

1. **创建 `sidecall.ts`** — completeSimple 调用 + prompt 构建 + 关键文件自动提取
2. **重写 `workflow_subagent` tool** — planReview 路径用 sidecall, 移除 review/explore
3. **重写 `/review` 命令** — 调用 OCR CLI + 解析输出 + 状态更新
4. **删除 pi-subagents 相关代码** — subagent.ts, agents.ts, agent .md, wf-install-subagents
5. **简化类型** — SubagentConfig/SubagentRole
6. **更新文档** — AGENTS.md, README
7. **测试** — plan review sidecall 回归, code review OCR 集成