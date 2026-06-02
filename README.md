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
idle → explore → plan → work → review ⟷ fix → commit → idle
```

- **Explore Mode**: Default landing after `/wf`. Read-only codebase exploration and Q&A (same permissions as Plan Mode). Use `/plan` when ready to design.
- **Plan Review**: Optional, model-initiated `workflow_plan_review` tool call — the plan agent may invoke it after saving a plan. Same-turn `completeSimple()` sidecall with curated context (plan text + auto-extracted key file snippets + tool inventory). Not a separate mode; runs within Plan Mode.
- **Code Review**: Tool-driven via `workflow_code_review`. The model selects review scope (workspace by default) and provides context. `/review` is a TUI scope-selector that prompts the model to invoke the tool.

## Modes

Workflow tools and commands are **opt-in by default**: only `/wf` is visible until you enter workflow mode. Set `workflow.autoEnter: true` in config to enable them on startup.

| Mode | Command | Description |
|------|---------|-------------|
| Entry | `/wf` | Enter workflow mode — enables all workflow commands and tools |
| Explore Mode | (default) | Read-only codebase exploration and Q&A — same permissions as Plan Mode |
| Explore Mode | `/explore` | Return to Explore Mode from any mode (non-destructive — keeps plan/todos) |
| Plan Mode | `/plan` | Brainstorm and produce an implementation plan |
| Work Mode | `/work` | Implement the approved plan |
| Fix | (auto) | Fix critical/important issues from code review |
| Code Review Mode | `/review` | Interactive TUI: choose scope, then run `ocr review` |
| Commit Mode | `/commit` | Generate and execute a conventional commit |

## Configuration

### Config merge order

`DEFAULT_CONFIG` ← `global config` ← `project config` ← `session overrides`

The session layer is the highest priority. It is stored in the current session's
runtime state (not a shared file) and edited via `/wf-settings` (Session scope).
This lets one Pi process temporarily override models or flags without touching
the shared project/global config files.

### Workflow entry gate

By default, workflow commands and tools are hidden. Users must run `/wf` to enable them.

```json
{
  "workflow": {
    "autoEnter": false
  }
}
```

Set `workflow.autoEnter: true` to enable workflow commands and tools automatically on Pi startup.

### Global config

`~/.pi/agent/workflow/config.json`

```json
{
  "models": {
    "explore": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "thinking": "medium"
    },
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
    "enabled": true
  }
}
```

See `config.json.example` for the canonical config template.

### Plan review (optional tool)

Plan review is an **optional** feature — when `planReview.enabled` is `true`, the `workflow_plan_review` tool becomes available. The plan agent decides whether to call it based on plan complexity and risk.

The reviewer uses `completeSimple()` — a single LLM API call with no tools and no subprocess — receiving:

- The full plan text
- Auto-extracted file snippets from paths referenced in the plan
- The executor's tool inventory

**Configuration** needs the model spec (`models.planReview`) and `planReview.enabled: true`. When `thinking` is `"off"`, the reasoning parameter is omitted entirely.

### Code review (optional tool)

Code review is also **optional** — when `codeReview.enabled` is `true`, the `workflow_code_review` tool (and the `/review` command) become available.

- **Workspace** (default): reviews staged + unstaged + untracked changes.
- **Custom ref range** or **single commit**: via `/review` command TUI.

The model fills in the `--background` parameter based on current task context. The `/review` command opens a TUI for scope selection and then prompts the model to call the tool.

The `ocr` binary is assumed to be in PATH (hardcoded). No additional OCR configuration is exposed.

### Project config

`.pi/workflow/config.json` — same structure as the global config. Project values override global values.

### Stale config cleanup

On load, pi-workflow strips stale config keys from old versions:
- The `workflow` section is preserved (only `autoEnter` is kept).
- Removed `subagent` section (no longer exists)
- Removed `todoOverlay` section (no longer user-configurable)
- Removed `askUserQuestion` section (no longer user-configurable)
- Removed `codeReview.ocrBinary/timeoutMs/maxLoops` (hardcoded, no longer configurable)
- Removed `planReview.maxLoops` (no longer used)
- Removed `codeReview.auto` (no longer used)
- Unknown models keys are stripped; only `explore/plan/planReview/work/review/commit` are recognized

## Settings Menu (`/wf-settings`)

`/wf-settings` opens a TUI to edit every config option without hand-editing JSON.
It is always available, even before you run `/wf` (so you can set
`workflow.autoEnter` up front).

Flow:

1. Pick a scope: **Session**, **Project**, or **Global** (or **Done** to close).
2. Edit options in a searchable list:
   - `models.<role>.provider` / `models.<role>.model` — free-text input (clear the field to inherit).
   - `models.<role>.thinking` — cycle through `inherit / off / minimal / low / medium / high / xhigh`.
   - `workflow.autoEnter`, `planReview.enabled`, `codeReview.enabled` — toggle through `inherit / true / false` (**Project / Global scopes only**, see below).
3. Press Esc to return to the scope picker; pick **Done** to finish.

Each row shows what the selected scope contributes on the right and the merged
**effective** value in its description, so inherited values are easy to spot.
Setting a row to `inherit` (or clearing a text field) removes that key from the
layer, letting lower layers take over.

### Where each scope writes

| Scope | Storage | Visibility |
|-------|---------|-----------|
| Session | current session runtime state (`sessionConfig`) | this Pi process only |
| Project | `.pi/workflow/config.json` | shared with the project |
| Global | `~/.pi/agent/workflow/config.json` | all projects |

### When changes take effect

- **Model / thinking** changes apply immediately to the current and later turns
  (the active mode's model is re-applied when the menu closes). These are
  editable in all three scopes.
- **`workflow.autoEnter`, `planReview.enabled`, `codeReview.enabled`** gate
  command/tool registration, which happens at extension load time using the
  Project/Global layers. They are editable only in **Project** and **Global**
  scopes (the Session layer cannot influence load-time registration), and need
  `/reload` (or the next startup) to take effect. The menu shows a reminder when
  you change one of them.

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

Before producing and saving the final plan, Plan Mode explicitly asks whether the discussion is sufficient:

> "Is the discussion sufficient? Shall I write the final plan?"

Only after the user confirms the discussion is complete does the agent write the final plan document and call `workflow_plan(action="save")`. If plan review is enabled, the agent may optionally call `workflow_plan_review` for an independent review.

This prevents wasting tokens when the user still wants to refine the design.

## Commands

| Command | Description |
|---------|-------------|
| `/wf` | Enter workflow mode — enables all other workflow commands and tools |
| `/wf-settings` | Open the settings menu — edit all config options across session/project/global scopes (always available) |
| `/explore` | Enter Explore Mode (non-destructive — preserves plan/todos) |
| `/plan` | Enter Plan Mode |
| `/go [--force]` | Approve current plan and hand off to Work Mode |
| `/work [task]` | Skip Plan Mode, go straight to implementation |
| `/review` | TUI scope selector for code review — prompts model to call workflow_code_review |
| `/commit [notes]` | Generate commit message and commit |
| `/wf-status` | Show current workflow state (includes plan path and run IDs) |
| `/wf-exit` | Exit workflow mode |
| `/wf-reset` | Clear workflow state and plan directory |
| `/wf-init` | Initialize agent workspace: ensure git repo, generate/update AGENTS.md |

## Plan Review (Sidecall)

Plan review runs as an **optional, model-initiated** `completeSimple()` sidecall — no subprocess, no agent containers, no RPC. The plan agent calls `workflow_plan_review` when the plan is complex or the user requests it.

- **Curated context** — the reviewer sees the plan text, auto-extracted file snippets, and executor tool inventory.
- **Fast & reliable** — single LLM API call, no subprocess communication risk.
- **Zero config** — just set `models.planReview` in your config.
- **Structured output** — the prompt asks the reviewer to produce Critical/Important/Minor severity classification.
- **No marker validation** — the full review text is passed back for the plan agent to evaluate. No strict format requirement.

## Code Review (OCR CLI)

Code review uses the `workflow_code_review` tool, which wraps alibaba/open-code-review's `ocr review` CLI:

- **Deterministic rules** — Built-in detectors for NPE, thread safety, XSS, SQL injection, etc. Not LLM-dependent.
- **Dedicated review tools** — `code_search` for cross-file reference checking, `code_comment` for line-level annotations.
- **Parallel execution** — Per-file goroutines (default 8 concurrent).
- **Line-level comments** — Precise issue locations, not vague text descriptions.
- **Severity classification** — Security/Defect → Critical, Maintainability/Quality → Important.

The `workflow_code_review` tool:
1. Always runs with `--audience agent` for structured output.
2. Requires a model-supplied `--background` with task context.
3. Defaults to workspace scope (staged + unstaged + untracked changes).

For interactive scope selection, use `/review` — it shows a TUI and prompts the model to call the tool.

## Session-Scoped Runtime State

Runtime workflow state is scoped to the current Pi session:

```
.pi/workflow/sessions/<safeSessionKey>/state.json
```

The session key is derived by hashing the Pi session ID or session file path — raw IDs are never used directly as path segments.

This means two Pi processes in the same project directory can run independent workflow state machines without overwriting each other. Plan files remain in the shared `.pi/workflow/plan/` directory with randomized names.

Config files (`.pi/workflow/config.json`, `~/.pi/agent/workflow/config.json`) are directory/global scoped and shared intentionally. Session-scoped config overrides (set via `/wf-settings` Session scope) live inside the session `state.json` as a `sessionConfig` field and are never shared across sessions.

## Tools

| Tool | Purpose |
|------|---------|
| `workflow_todo` | Maintain the todo list (reset, add, set, list) |
| `workflow_plan` | Manage plans (save, approve, read, clear) — responses include plan path |
| `workflow_plan_review` | Run an optional plan review sidecall via completeSimple |
| `workflow_code_review` | Run OCR code review on workspace or git ref range |

### workflow_plan_review

Run a same-turn plan review via `completeSimple()` sidecall (only available when `planReview.enabled: true`). The reviewer receives curated context (plan + file snippets + tool inventory) and returns structured feedback.

**Parameters:**
- `task` (required): the plan content or a brief task description
- `context` (optional): extra background (user constraints, discussion points)
- `instructions` (optional): review preferences (depth, focus areas)

### workflow_code_review

Run OCR code review (only available when `codeReview.enabled: true`). Defaults to workspace scope.

**Parameters:**
- `background` (required): task context and review focus
- `scope`: `"workspace"` (default), `"range"`, or `"commit"`
- `from` / `to` / `commit`: scope-specific refs

| Path | Purpose |
|------|---------|
| `.pi/workflow/config.json` | Project-level config |
| `.pi/workflow/plan/` | Plan documents (shared, randomized filenames) |
| `.pi/workflow/sessions/<key>/state.json` | Session-scoped runtime state |
| `~/.pi/agent/workflow/config.json` | Global config |