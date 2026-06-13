# AGENTS.md — pi-workflow

## 项目概述

**pi-workflow** 是一个轻量级软件开发工作流扩展，为 [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 提供 Explore → Plan → Plan Review → Work → Code Review → Commit 的全流程编排。

### 核心能力
- **Explore Mode** (默认) — 进入 workflow 后默认落点，只读探索代码库、回答问题
- **Plan Mode** (`/plan`) — 生成实现计划
- **Plan Review Mode** (自动) — same-turn `completeSimple()` 侧调用审查计划，无需子进程
- **Work Mode** (`/work`) — 执行已批准的计划，完成后提示用户运行 `/review`
- **Code Review Mode** (`/review`) — 基于 alibaba/open-code-review CLI (`ocr review`) 的代码审查与修复循环
- **Commit Mode** (`/commit`) — 生成符合 Conventional Commits 的提交信息

### 依赖
- **必须**: 无外部 Pi 扩展依赖。Plan Review 使用内置 `completeSimple()` 侧调用；Code Review 使用外部 `ocr` CLI（需单独安装）
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
# 安装本扩展（从项目根目录）
pi install .

# 重载
/reload

# (可选) 安装 alibaba/open-code-review CLI 用于 Code Review
# go install github.com/alibaba/open-code-review/cmd/ocr@latest
```

### 验证
```bash
# todo 状态生命周期回归验证
node scripts/validate-todo-regression.mjs
```

### 工作流命令（Pi 内）
| 命令 | 用途 |
|------|------|
| `/wf` | 进入 workflow 模式，启用其它工作流命令和工具 |
| `/explore` | 进入 Explore Mode（非破坏性） |
| `/plan` | 进入 Plan Mode |
| `/go [--force]` | 批准计划并交予 Work Mode |
| `/work [task]` | 跳过计划，直接实现 |
| `/review` | 触发 Code Review 与修复循环 (调用 `ocr review`) |
| `/commit [notes]` | 生成并执行 Conventional Commit |
| `/wf-status` | 查看当前工作流状态 |
| `/wf-exit` | 退出工作流模式 |
| `/wf-reset` | 清空工作流状态和计划目录 |
| `/wf-init` | 初始化 git 仓库并生成/更新 AGENTS.md |

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
│       ├── index.ts                  # 扩展入口，注册所有命令/工具
│       ├── types.ts                  # 核心类型定义
│       ├── state.ts                  # 工作流运行时状态管理
│       ├── paths.ts                  # 文件系统路径工具
│       ├── config.ts                 # 配置加载与合并
│       ├── defaults.ts               # 默认配置/状态常量
│       ├── tools.ts                  # 工具注册（workflow_todo / workflow_plan_* / review 工具）
│       ├── commands.ts               # 命令注册（/plan /work /review /commit /wf-*）
│       ├── sidecall.ts               # Plan Review sidecall（completeSimple 侧调用）
│       ├── prompts.ts                # 提示词和审查指令
│       ├── todo-overlay.ts           # 进度叠加层（widget）
│       ├── guards.ts                 # 守卫函数（模式控制、状态验证）
│       ├── mode.ts                   # 运行时模式切换
│       ├── helpers.ts                # 通用辅助函数
│       └── baseline.ts               # git baseline 工具（Work mode entry 快照）
├── scripts/                          # 回归验证脚本
│   └── validate-todo-regression.mjs
├── .pi/
│   ├── workflow/                     # 工作流运行时数据（gitignored）
│   │   ├── config.json               # 项目级配置（可选）
│   │   ├── plan/                     # 计划文档（自动生成，随机命名）
│   │   └── sessions/                 # 会话隔离状态存储
├── .gitignore
├── package.json                      # pi 扩展注册
└── README.md
```

### 关键约定
- **会话隔离**: 运行时工作流状态存储在 `.pi/workflow/sessions/<safeSessionKey>/`，每个 Pi 进程独立
- **计划文件**: 共享 `.pi/workflow/plan/` 目录，文件名随机化
- **Plan Review**: 使用 `completeSimple()` 同一 turn 内 LLM 侧调用，无子进程、无 agent 容器
- **Code Review**: 使用 alibaba/open-code-review CLI (`ocr review`)，独立进程运行
- **配置合并**: `DEFAULT_CONFIG` ← `~/.pi/agent/workflow/config.json` ← `.pi/workflow/config.json`

## 工作流规则

### 模式流转

Workflow 命令和工具默认为 opt-in：普通 Pi 仅暴露 `/wf`，使用 `/wf` 后方可访问 `/plan`、`/work` 等命令。
在 config 中设置 `workflow.autoEnter: true` 可在启动时自动启用。

```
/wf → idle → explore → plan → work → /review loop → commit → /wf-exit
```

- **Explore Mode**: 进入 workflow 后默认进入的只读模式，用于探索代码库、了解现状
- **Entry**: 用户发起 `/wf`，启用 workflow 命令和工具，自动进入 Explore Mode
- **Plan Mode**: 用户发起 `/plan`，AI 探索、讨论、确认需求充分后产出计划文档并保存。保存后自动触发 plan-review，评审通过后由用户确认执行
- **Plan Review Mode**: 计划保存后自动进入，通过 `completeSimple()` 侧调用审查（同一 turn 内完成），最大 loop 由 prompt 自约束
- **Work Mode**: 执行批准的计划，使用 `workflow_todo` 跟踪进度，完成后提示用户运行 `/review`
- **Code Review Mode**: 用户发起 `/review` 后调用 `ocr review` CLI；模型修复确认存在的 Critical/Important 问题并重新触发 review，直到通过或将分歧交给用户裁决
- **Commit Mode**: review 通过后，生成 Conventional Commit

### 核心规则
1. **状态持久化**: 每次状态变更必须调用 `saveState()` 写盘
2. **计划批准先行**: Work Mode 前必须通过 `workflow_plan_approve` 批准计划并立即切换到 Work Mode。Approval 以持久化状态（`mode`、`workRunId`）为准。除非 `/work` 跳过计划。
3. **审查隔离**: Plan Review 使用 same-turn `completeSimple()` 侧调用（`workflow_plan_review` 工具）；Code Review 使用 OCR CLI 独立进程
4. **Review 循环防死锁**: Review loop 计数器作用域为每次 trigger，非全局 session
5. **Todo 管理**: 计划开始后通过 `workflow_todo` 跟踪每步进度，Work 完成后 todo 列表在 `workflow_plan_save` 时自动清空
6. **进度叠加层**: 非 idle 模式下显示 todo 进度 widget，所有任务完成后自动隐藏（保留已隐藏的任务 ID，避免跨计划残留）
7. **会话无泄漏**: 同一项目目录下两个 Pi 进程使用独立状态路径，互不影响

### 安全/禁止事项

#### 禁止
- **禁止** 直接写入 `.pi/workflow` 下的 session 状态文件 — 必须通过 `saveState()` 操作
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
2. 执行 `/reload` 重载扩展
3. 执行 `node scripts/validate-todo-regression.mjs` 验证基础功能
4. 使用 `/wf-status` 确认工作流状态正常
5. (可选) 安装 `ocr` CLI 以启用 Code Review 功能

---

*此文件由 `/wf-init` 命令管理和更新。请保持与项目实际结构同步。*