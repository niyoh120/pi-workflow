# pi-workflow

Lightweight software development workflow extension for pi-coding-agent: plan, built-in plan review (sidecall), implementation, code review via alibaba/open-code-review CLI, and commit orchestration.

**Zero external Pi extension dependencies.** Plan review uses `completeSimple()` — a same-turn LLM sidecall with no subprocess. Code review runs via the standalone `ocr review` CLI. No `@tintinweb/pi-subagents` required.

## Installation

```bash
# 1. (Optional) Structured user-question dialog — enables tabbed option selectors in plan/approval flows
pi install npm:@juicesharp/rpiv-ask-user-question

# 2. Install pi-workflow
pi install .

# 3. (For code review) Install alibaba/open-code-review CLI
#    See: https://github.com/alibaba/open-code-review#install
#    e.g.: go install github.com/alibaba/open-code-review/cmd/ocr@latest

# 4. Reload
/reload
```

> **Note:** `@juicesharp/rpiv-ask-user-question` is optional. Without it, Plan Mode uses normal chat for clarifying questions and approval confirmation. Install it for a richer tabbed-dialog experience (multi-select, side-by-side previews, typed notes). As with any third-party Pi package, review the source before installing.

## Architecture

```
idle → plan → planReview → work → review ⟷ fix → commit → idle
```

- **Plan Review**: Same-turn `completeSimple()` sidecall with curated context (plan text + auto-extracted key file snippets + conversation summary + tool inventory). The reviewer model sees exactly what it needs — no subprocess, no isolation overhead.
- **Code Review**: Interactive TUI wizard for `ocr review`. Choose scope (workspace/baseline/range/single-commit) and run via alibaba/open-code-review CLI.
- **Explore**: Not included. Install `@tintinweb/pi-subagents` separately if you want its built-in explore agent.

## Modes

| Mode | Command | Description |
|------|---------|-------------|
| Plan Mode | `/plan` | Brainstorm and produce an implementation plan |
| Plan Review Mode | (auto) | Same-turn plan review via completeSimple sidecall |
| Work Mode | `/work` | Implement the approved plan |
| Fix | (auto) | Fix critical/important issues from code review |
| Code Review Mode | `/review` | Interactive TUI: choose scope, then run `ocr review` |
| Commit Mode | `/commit` | Generate and execute a conventional commit |

## Configuration

### Config merge order

`DEFAULT_CONFIG` ← `global config` ← `project config`

### Global config

`~/.pi/agent/workflow/config.json`

```json
{
  "models": {
    "plan": {
      "provider": "anthropic",
      "model": "claude-opus-4-5",
      "thinking": "high"
    },
    "planReview": {
      "provider": "openai",
      "model": "gpt-5.1",
      "thinking": "high"
    },
    "work": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "thinking": "medium"
    },
    "review": {
      "provider": "openai",
      "model": "gpt-5.1",
      "thinking": "high"
    },
    "commit": {
      "provider": "openai",
      "model": "gpt-5.1-mini",
      "thinking": "low"
    }
  },
  "planReview": {
    "enabled": true
  },
  "codeReview": {
    "enabled": true,
    "ocrBinary": "ocr",
    "timeoutMs": 300000,
    "maxLoops": 3
  },
  "askUserQuestion": {
    "enabled": true,
    "toolName": "ask_user_question",
    "installSource": "npm:@juicesharp/rpiv-ask-user-question"
  },
  "todoOverlay": {
    "enabled": true
  }
}
```

### Plan review sidecall

The plan review sidecall uses `completeSimple()` — a single LLM API call with no tools and no subprocess. The reviewer receives:

- The full plan text
- Auto-extracted file snippets from paths referenced in the plan
- The executor's tool inventory (so it can assess whether the right tools are available)
- (Future) A conversation summary capturing key user constraints and decisions

**Configuration** only needs the model spec (`models.planReview`) — no agent containers, RPC timeouts, or subprocess management.

**Thinking level "off"**: When `thinking` is set to `"off"`, the reasoning parameter is omitted from the completeSimple call entirely. The reviewer model runs without extended thinking.

### Code review via OCR CLI (TUI-driven)

`/review` opens an interactive TUI wizard:

1. **Scope selector** — Choose what to review:
   - **Workspace changes**: `ocr review` (no scope flags)
   - **Workflow baseline → HEAD**: `ocr review --from <workBaselineRef> --to HEAD`
   - **Custom ref range**: `ocr review --from <ref> --to <ref>`
   - **Single commit**: `ocr review --commit <hash>`
2. **Scope inputs** — Enter from/to refs or commit hash (with sensible defaults for baseline mode); confirm to run.

The resulting command is built into a safe `argv` array and executed via `execFileSync` (no shell interpolation).

- `ocrBinary` — Path to the `ocr` binary (default: `"ocr"` — assumes in PATH).
- `timeoutMs` — Maximum execution time in ms (default: 300,000 = 5 min).

### Project config

`.pi/workflow/config.json` — same structure as the global config. Project values override global values.

### Stale config cleanup

On load, pi-workflow strips stale config keys from old versions:
- Removed `subagent` section (no longer exists)
- Removed `planReview.maxLoops` (no longer used)
- Removed `codeReview.auto` (no longer used)
- Removed `models.explore` (Explore removed)

## Plan Document Management

### Directory

All plan documents are stored under `.pi/workflow/plan/`.

### Random Naming

Each `workflow_plan save` creates a new plan file with a random name:

```
.pi/workflow/plan/plan-a3b9f2c1.md          ← plan document
```

This allows multiple plans to coexist in the same project without conflicts.

### Plan Path Visibility

Every plan save, read, and `/wf-status` explicitly shows the plan file path (e.g., `.pi/workflow/plan/plan-a3b9f2c1.md`) so you can easily find and inspect the document.

### Plan Mode Confirmation Gate

Before producing and saving the final plan (which triggers automatic plan review), Plan Mode explicitly asks whether the discussion is sufficient:

> "Is the discussion sufficient? Shall I write the final plan?"

Only after the user confirms the discussion is complete does the agent:
1. Write the final plan document.
2. Call `workflow_plan(action="save")` and `workflow_todo(action="reset")` — which triggers automatic plan review via sidecall.

This prevents wasting tokens on auto-review when the user still wants to refine the design. Ordinary clarification replies or approach confirmations are NOT treated as permission to save.

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Enter Plan Mode |
| `/go [--force]` | Approve current plan and hand off to Work Mode |
| `/work [task]` | Skip Plan Mode, go straight to implementation |
| `/review` | Run `ocr review` on current diff |
| `/commit [notes]` | Generate commit message and commit |
| `/wf-status` | Show current workflow state (includes plan path and run IDs) |
| `/wf-exit` | Exit workflow mode |
| `/wf-reset` | Clear workflow state and plan directory |
| `/wf-init` | Initialize agent workspace: ensure git repo, generate/update AGENTS.md |

## Plan Review (Sidecall)

Plan review runs as a **same-turn `completeSimple()` sidecall** — no subprocess, no agent containers, no RPC. This provides:

- **Curated context** — the reviewer sees the plan text, auto-extracted file snippets, conversation summary, and executor tool inventory. No irrelevant conversation history.
- **Fast & reliable** — single LLM API call, no subprocess communication risk.
- **Zero config** — just set `models.planReview` in your config. No agent `.md` files to sync.
- **Structured output** — `[pi-workflow-plan-review/v1]` identity marker + Critical/Important/Minor severity classification.
- **Identity marker validation** — the sidecall validates the marker and returns an error if the reviewer model didn't follow the prompt correctly.

## Code Review (OCR CLI)

Code review uses alibaba/open-code-review's `ocr review` CLI:

- **Deterministic rules** — Built-in detectors for NPE, thread safety, XSS, SQL injection, etc. Not LLM-dependent.
- **Dedicated review tools** — `code_search` for cross-file reference checking, `code_comment` for line-level annotations.
- **Parallel execution** — Per-file goroutines (default 8 concurrent).
- **Line-level comments** — Precise issue locations, not vague text descriptions.
- **Severity classification** — Security/Defect → Critical, Maintainability/Quality → Important.

The `/review` command:
1. Checks git repo and ocr CLI availability
2. Runs `ocr review --from <workBaselineRef or HEAD~1> --to HEAD`
3. Parses output and delivers results to the agent

## Trigger-Scoped Review Counters

Plan review and code review loop counters limit review retries per trigger, not across the whole session.

- `planReviewLoops` resets to `0` on every `workflow_plan save`. A save is a fresh plan-review trigger.
- If plan review is enabled, each save creates a `pending` review status. Review failures increment `planReviewLoops` within that save-trigger only.
- `codeReviewLoops` resets to `0` when the Work-mode agent reports `ready_for_review`. This starts a fresh automatic review/fix sequence.
- Fix-mode `ready_for_review` does **not** reset `codeReviewLoops` — retries in the same auto sequence accumulate.
- Manual `/review` never increments `codeReviewLoops` and does not consume the automatic fix-loop budget.
- A prior trigger's review failures never block a later trigger in the same session.

## Session-Scoped Runtime State

Runtime workflow state is scoped to the current Pi session:

```
.pi/workflow/sessions/<safeSessionKey>/state.json
```

The session key is derived by hashing the Pi session ID or session file path — raw IDs are never used directly as path segments.

This means two Pi processes in the same project directory can run independent workflow state machines without overwriting each other. Plan files remain in the shared `.pi/workflow/plan/` directory with randomized names.

Config files (`.pi/workflow/config.json`, `~/.pi/agent/workflow/config.json`) are directory/global scoped and shared intentionally.

## Tools

| Tool | Purpose |
|------|---------|
| `workflow_todo` | Maintain the todo list (reset, add, set, list) |
| `workflow_plan` | Manage plans (save, approve, read, clear) — responses include plan path |
| `workflow_subagent` | Run a plan review sidecall via completeSimple (role=planReview only) |

### workflow_subagent

Run a same-turn plan review via `completeSimple()` sidecall. The reviewer receives curated context (plan + file snippets + conversation summary + tool inventory) and returns structured feedback.

**Parameters:**
- `role` (required): `planReview` (the only supported role)
- `task` (required): the plan content or a brief task description
- `context` (optional): extra background (user constraints, discussion points)
- `instructions` (optional): review preferences (depth, focus areas)

## Structured User Questions

When `@juicesharp/rpiv-ask-user-question` is installed, Plan Mode uses tabbed dialog boxes for structured interaction:

- **Clarifying questions** — decisions with clear trade-offs are presented as option sheets (2-4 options, optional markdown previews) instead of plain text.
- **Approval confirmation** — after plan review passes, the agent presents a structured confirmation: "Execute plan / Revise plan / Discuss more".
- **Graceful fallback** — without the package, workflow uses normal chat and works identically to previous versions.

### Configuring

```json
{
  "askUserQuestion": {
    "enabled": true,
    "toolName": "ask_user_question",
    "installSource": "npm:@juicesharp/rpiv-ask-user-question"
  }
}
```

Disable `enabled` to prevent activation even when the package is installed. Change `toolName` if a different question tool is registered under another name.

## Built-in Todo Overlay

pi-workflow includes a built-in progress overlay displayed above the editor in non-idle workflow modes (plan, work). It does **not** require `@juicesharp/rpiv-todo` — the overlay reads `workflow_todo` state directly through extension code, so there is no manual sync step and no risk of two todo lists drifting apart.

**Behavior:**
- Shows pending, in-progress, done, and blocked tasks with status symbols (○ ◐ ✓ ⊘).
- Done items stay visible for the remainder of the current agent turn, then hide when the next turn starts.
- Auto-hides when the workflow mode is idle (`/wf-exit`) or the todo list is empty.
- Truncates to at most 12 lines to stay unobtrusive.

**Disabling:**

```json
{
  "todoOverlay": { "enabled": false }
}
```

Set `todoOverlay.enabled` to `false` in the global or project config to hide the overlay.

## Storage

| Path | Purpose |
|------|---------|
| `.pi/workflow/config.json` | Project-level config |
| `.pi/workflow/plan/` | Plan documents (shared, randomized filenames) |
| `.pi/workflow/sessions/<key>/state.json` | Session-scoped runtime state |
| `~/.pi/agent/workflow/config.json` | Global config |