# AGENTS.md — pi-workflow

## 项目概述

**pi-workflow** 是一个轻量级软件开发工作流扩展，为 [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 提供 Plan → Plan Review → Work → Code Review → Commit 的全流程编排。

### 核心能力
- **Plan Mode** (`/plan`) — 生成实现计划
- **Plan Review Mode** (自动) — 隔离环境审查计划
- **Work Mode** (`/work`) — 执行已批准的计划
- **Fix Mode** (自动) — 修复 Code Review 发现的问题
- **Code Review Mode** (`/review`) — 基于 git diff 的隔离代码审查
- **Commit Mode** (`/commit`) — 生成符合 Conventional Commits 的提交信息
- **Explore** — 只读代码库探索 (由 `@tintinweb/pi-subagents` 提供)

### 依赖
- **必须**: `@tintinweb/pi-subagents` (隔离子代理运行时)
- **可选**: `@juicesharp/rpiv-ask-user-question` (结构化问答对话框)

### 技术栈
- **语言**: TypeScript (ESM, Node.js 原生模块)
- **运行时**: Node.js ≥ 18
- **核心 API**: `@earendil-works/pi-coding-agent` (ExtensionAPI)
- **类型系统**: `typebox` + `@earendil-works/pi-ai` (StringEnum)
- **扩展模式**: pi 扩展包，通过 `package.json#pi.extensions` 注册

## 构建/测试命令

### 安装
```bash
# 安装依赖子代理
pi install npm:@tintinweb/pi-subagents

# 安装本扩展（从项目根目录）
pi install .

# 同步审查容器 & 重载
/wf-install-subagents
/reload
```

### 验证
```bash
# todo 状态生命周期回归验证
node scripts/validate-todo-regression.mjs

# 子代理诊断检查
node scripts/check-subagent-diagnostics.mjs
```

### 工作流命令（Pi 内）
| 命令 | 用途 |
|------|------|
| `/plan` | 进入 Plan Mode |
| `/go [--force]` | 批准计划并交予 Work Mode |
| `/work [task]` | 跳过计划，直接实现 |
| `/review` | 手动触发 Code Review |
| `/commit [notes]` | 生成并执行 Conventional Commit |
| `/wf-status` | 查看当前工作流状态 |
| `/wf-exit` | 退出工作流模式 |
| `/wf-reset` | 清空工作流状态和计划目录 |
| `/wf-init` | 初始化 git 仓库并生成/更新 AGENTS.md |
| `/wf-install-subagents` | 安装子代理并同步审查容器 |

## 代码风格/规范

### TypeScript 编码规范
- **模块格式**: ESM (ECMAScript Modules)，使用 `import` / `export`
- **Node.js 原生模块**: 使用 `node:` 协议前缀 (`import fs from "node:fs"`, `import path from "node:path"`)
- **类型导入**: 使用 `import type` 语法导入仅类型所需的模块
- **命名约定**:
  - 变量/函数: camelCase (`loadState`, `getSessionKey`)
  - 类型/接口: PascalCase (`WorkflowState`, `SubagentRole`)
  - 常量: UPPER_SNAKE_CASE (`DEFAULT_STATE`, `TODO_STATUS`)
  - 文件: kebab-case (`todo-overlay.ts`, `plan-review agent md`)
- **选项对象**: 所有函数参数优先使用 `Type.Object()` (typebox) 或解构对象
- **异步**: 使用 `async/await`，避免裸 Promise
- **严格模式**: 启用 `strict` TypeScript 配置

### 导出规范
- 顶层模块通过 `index.ts` 聚合导出
- 每个概念一个文件: 将大模块按职责拆分（`state.ts`, `paths.ts`, `config.ts`, `tools.ts`, `commands.ts` 等）

### 注释规范
- JSDoc `/** ... */` 用于公共 API 和复杂函数
- `// ── Section separators ──────────` 用于文件内逻辑分区
- `//` 行内注释用于解释"为什么"而非"是什么"

## 目录约定

```
pi-workflow/
├── extensions/
│   └── workflow/                     # 扩展核心源码
│       ├── agents/                   # 审查容器定义（.md 文件）
│       │   ├── pi-workflow-code-review.md
│       │   └── pi-workflow-plan-review.md
│       ├── index.ts                  # 扩展入口，注册所有命令/工具
│       ├── types.ts                  # 核心类型定义
│       ├── state.ts                  # 工作流运行时状态管理
│       ├── paths.ts                  # 文件系统路径工具
│       ├── config.ts                 # 配置加载与合并
│       ├── defaults.ts               # 默认配置/状态常量
│       ├── tools.ts                  # 工具注册（workflow_todo / workflow_plan / workflow_subagent / workflow_status）
│       ├── commands.ts               # 命令注册（/plan /go /work /review /commit /wf-*）
│       ├── subagent.ts               # 子代理客户端（@tintinweb/pi-subagents 集成）
│       ├── prompts.ts                # 提示词和审查指令
│       ├── todo-overlay.ts           # 进度叠加层（widget）
│       ├── guards.ts                 # 守卫函数（模式控制、状态验证）
│       └── helpers.ts                # 通用辅助函数
├── scripts/                          # 回归验证和诊断脚本
│   ├── validate-todo-regression.mjs
│   └── check-subagent-diagnostics.mjs
├── .pi/
│   ├── agents/                       # 本地代理定义（审查容器副本）
│   ├── workflow/                     # 工作流运行时数据（gitignored，除 agents/ 外）
│   │   ├── config.json               # 项目级配置（可选）
│   │   ├── plan/                     # 计划文档（自动生成，随机命名）
│   │   └── sessions/                 # 会话隔离状态存储
│   └── subagent-schedules/
├── .gitignore
├── package.json                      # pi 扩展注册
└── README.md
```

### 关键约定
- **会话隔离**: 运行时工作流状态存储在 `.pi/workflow/sessions/<safeSessionKey>/`，每个 Pi 进程独立
- **计划文件**: 共享 `.pi/workflow/plan/` 目录，文件名随机化
- **审查容器**: agent `.md` 文件仅声明工具权限，不含模型配置（模型由 `config.json` 统一控制）
- **配置合并**: `DEFAULT_CONFIG` ← `~/.pi/agent/workflow/config.json` ← `.pi/workflow/config.json`
- **gitignore**: `.pi/*` 但不是 `.pi/agents/*` 和 `.pi/agents/*`

## 工作流规则

### 模式流转
```
idle → plan → planReview → work → review ↔ fix → commit → idle
        ↑______________________|   (auto loop)
```

- **Plan Mode**: 用户发起 `/plan`，AI 探索、讨论、确认需求充分后产出计划文档并保存。保存后自动触发 plan-review，评审通过后由用户确认执行
- **Plan Review Mode**: 计划保存后自动进入，最⼤ loop 次数由 `config.planReview.maxLoops` 控制
- **Work Mode**: 执行批准的计划，使用 `workflow_todo` 跟踪进度
- **Code Review Mode**: Work 完成后或手动 `/review`，触发隔离子代理审查
- **Fix Mode**: 审查发现 critical/important 问题后自动进入，修复后重新触发 review
- **Commit Mode**: review 通过后，生成 Conventional Commit

### 核心规则
1. **状态持久化**: 每次状态变更必须调用 `saveState()` 写盘
2. **计划批准先行**: Work Mode 前必须通过 `workflow_plan approve` 排队 handoff（`mode=workPending + pendingWorkHandoff`），由 `before_agent_start` 最终确认进入 Work Mode。Approval 以持久化状态（`mode`、`pendingWorkHandoff`、review status）为准，不依赖当前 turn 的 in-memory guard。除非 `/work` 跳过计划。
3. **审查隔离**: Plan Review 和 Code Review 必须在独立子代理中执行，使用 `workflow_subagent` 工具
4. **Review 循环防死锁**: Review loop 计数器作用域为每次 trigger，非全局 session
5. **Todo 管理**: 计划开始后通过 `workflow_todo` 跟踪每步进度，Work 完成后 todo 列表在 `workflow_plan save` 时自动清空
6. **进度叠加层**: 非 idle 模式下显示 todo 进度 widget，所有任务完成后自动隐藏（保留已隐藏的任务 ID，避免跨计划残留）
7. **子代理超时**: `resultTimeoutMs` 默认 10 分钟，超时或失败需调用诊断脚本定位问题
8. **会话无泄漏**: 同一项目目录下两个 Pi 进程使用独立状态路径，互不影响

### 安全/禁止事项

#### 禁止
- **禁止** 在审查容器 agent `.md` 中嵌入模型/thinking 配置 — 这些值必须在 `config.json` 中集中管理
- **禁止** 直接写入 `.pi/workflow` 下的 session 状态文件 — 必须通过 `saveState()` 操作
- **禁止** 修改扩展的 `.md` 文件中 `<!-- managed-by: pi-workflow -->` 标记
- **禁止** 在审查子代理中启用 `write`、`edit` 或 `extensions` 工具 — 审查代理必须是只读的
- **禁止** 在 Work Mode 中跳过 todo 进度追踪 — 每项任务必须至少标记一次 `in_progress` 和 `completed`
- **禁止** 在跨计划场景中重用未清理的 `hiddenDoneIds` — 必须调用 `clearBookkeeping()` 重置

#### 安全
- 所有文件路径操作使用 `node:path` 而非字符串拼接
- session key 通过 hash 派生，不直接使用原始 session ID 作为路径段
- 配置合并使用 `deepMerge()`，不直接修改默认值
- 所有 JSON 解析操作使用 try/catch 保护

## 提交规范

项目使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<type>: <description>

[optional body]
```

### 类型前缀
| 类型 | 用途 |
|------|------|
| `feat` | 新功能 / 新特性 |
| `fix` | 错误修复 |
| `refactor` | 代码重构（非功能变更） |
| `chore` | 构建/工具/配置变更 |
| `docs` | 文档变更 |
| `test` | 测试变更 |
| `style` | 代码风格变更（不影响功能） |
| `perf` | 性能改进 |

### 作用域 (可选)
使用括号表示作用域：`feat(workflow):`, `refactor(state):`, `fix(todo-overlay):`

### 语言
- **描述行**: 建议使用英文（如 `feat: add built-in workflow_todo progress overlay`）
- 中文提交信息也可以接受（如 `fix: 修复 commit 权限限制过于严格`）
- 描述使用祈使句、小写开头、句末无句号

### 提交示例
```
feat: add built-in workflow_todo progress overlay
refactor(workflow): redesign subagent types with bundled custom review agents
fix: scope review loop counters per trigger instead of per session
chore: update gitignore
```

## 启动/开发指引

1. 克隆仓库后使用 `pi install .` 安装扩展
2. 安装必须依赖：`pi install npm:@tintinweb/pi-subagents`
3. 在 Pi 中执行 `/wf-install-subagents` 同步审查容器
4. 执行 `/reload` 重载扩展
5. 执行 `node scripts/validate-todo-regression.mjs` 验证基础功能
6. 使用 `/wf-status` 确认工作流状态正常

---

*此文件由 `/wf-init` 命令管理和更新。请保持与项目实际结构同步。*