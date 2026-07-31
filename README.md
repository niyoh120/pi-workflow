# pi-workflow

Lightweight software development workflow extension for pi-coding-agent: plan, independent plan-review agent, implementation, code review via alibaba/open-code-review CLI, and commit orchestration.

**Zero external Pi extension dependencies.** Plan review runs as a fresh, in-memory child AgentSession that independently re-validates the saved plan. Code review runs via the standalone `ocr review` CLI. No `@tintinweb/pi-subagents` required.

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
idle → explore → plan → work → /review loop → commit → idle
```

- **Tool ownership**: pi-workflow manages only its own `workflow_*` tools. Built-in tools and other extension tools preserve their active/inactive state across mode changes; mode permissions apply to every active tool through prompts and stable path guards. There is no special auto-activation of `ask_user_question`.
- **Mode runtime**: workflow applies the configured model role only on explicit mode transitions (slash commands, `/wf` first entry, `idle→explore` promotion) and `/wf-settings` saves. Session restore (`/reload`, `/resume`) and per-turn startup preserve Pi's active session model/thinking (chosen via `/model`, Ctrl+P, or Shift+Tab), so manual selections survive within the current workflow mode; only workflow tools and the status line are reconciled. `before_agent_start` appends the stable `COMMON_PROMPT` to the system prompt and only falls back to the role config when no active model is present.
- **Mode context**: the current mode prompt and worktree notice are injected into the stable system prompt (via `before_agent_start`), and the Approved-Plan Work handoff is isolated via a canonical marker so Plan→Work transitions within the same agent run always see the latest mode. Dynamic state (todos, run IDs) comes from tool results, not the system prompt.
- **Explore Mode**: Default landing after `/wf`. Read-only codebase exploration and Q&A (same permissions as Plan Mode). Explore exposes no workflow tools; a preserved plan is read in Plan Mode. Use `/plan` when ready to design.
- **Plan Review**: Optional, model-initiated `workflow_plan_review` tool call — the plan agent may invoke it after saving a plan. Spawns a fresh, isolated in-memory AgentSession that inherits the parent Plan session's information-tool surface (minus workflow tools), independently explores the repository and active external tools, and returns structured Critical/Important/Minor/Summary findings grounded in repository evidence. Not a separate mode; runs within Plan Mode under a single 30-minute total timeout.
- **Code Review**: `/review` selects scope, prompts the model to invoke `workflow_code_review`, and runs the review/fix/re-review loop. Work Mode points users to `/review` after implementation.

## Modes

Workflow tools and commands are **opt-in by default**: only `/wf` is visible until you enter workflow mode. Set `workflow.autoEnter: true` in config to enable them on startup.

| Mode | Command | Description |
|------|---------|-------------|
| Entry | `/wf` | Enter workflow mode — enables all workflow commands and tools |
| Explore Mode | (default) | Read-only codebase exploration and Q&A — same permissions as Plan Mode |
| Explore Mode | `/explore` | Return to Explore Mode from any mode (non-destructive — keeps plan/todos) |
| Plan Mode | `/plan` | Brainstorm and produce an implementation plan |
| Work Mode | `/work` | Implement the approved plan |
| Review/Fix Loop | `/review` | Interactive TUI: choose scope, run `ocr review`, fix Critical/Important issues, and re-review |
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

The reviewer is a **fresh, independent AgentSession** (no subprocess, no RPC): `SessionManager.inMemory(...)` gives it isolated, non-persistent conversation state. It runs the configured `models.planReview` model and thinking level, and receives only authoritative inputs:

- The original user requirements from the current Plan lifecycle (captured via the `/plan` session-leaf marker)
- The confirmed grilling decisions (snapshotted into `planReviewDecisions` at plan-save time)
- The saved Final Plan

The planner's reasoning, thinking, tool results, and prior review output are **excluded by construction** — the reviewer re-derives its own view by exploring the repository.

**Inherited tool surface (best-effort).** At review time the parent's active tools are snapshotted, every workflow-owned tool is removed, and the remainder is reconstructed in the child: built-in tools (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`) are rebuilt by `createAgentSession`; active extension/MCP/Web/remote/memory tools are rebuilt from their owning extension source paths via `DefaultResourceLoader({ noExtensions: true, additionalExtensionPaths })`. pi-workflow itself is never loaded into the child (its bash override is treated as builtin, so its path is never collected). Tool reconstruction differences never block review and surface only as `requestedTools`/`activeTools`/`unavailableTools` diagnostics.

**Read-only safety boundary.** An inline child extension reuses the existing pure path guards: direct reads of `.pi/workflow/` are blocked, and `write`/`edit` are confined to the Plan scratch root (`/tmp/pi-workflow-plan-scratch/`). Bash mutation is governed by the reviewer system prompt (read-only + scratch probes only).

**Runtime budget.** A single 30-minute total timeout (`1_800_000ms`) bounds the whole run, combined with the parent turn's AbortSignal. There is no turn or tool-call limit — the reviewer controls its own exploration. The child session is always disposed in `finally`; timeout or user cancellation aborts the active AgentSession and returns an explicit tool error.

**Result.** The tool is zero-argument; legacy `task`/`context`/`instructions` fields from resumed sessions are accepted and discarded via `prepareArguments`. The final text keeps the `Critical / Important / Minor / Summary` structure with concrete repository evidence, and the result carries aggregated nested usage on its top-level `usage` field plus operational metadata (reviewer model/thinking, elapsed time, turns, tool-call count, requested/active/unavailable tools, stop reason/error).

### Code review (optional tool)

Code review is also **optional** — when `codeReview.enabled` is `true`, the `workflow_code_review` tool (and the `/review` command) become available.

- **Workspace** (default): reviews staged + unstaged + untracked changes.
- **Custom ref range** or **single commit**: via `/review` command TUI.

The model fills in the `--background` parameter based on current task context. The `/review` command opens a TUI for scope selection, prompts the model to call the tool, and keeps the loop in the agent turn so confirmed Critical/Important findings are fixed and re-reviewed.

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
- Unknown models keys are stripped; only `explore/plan/planReview/work/commit` are recognized

## Settings Menu (`/wf-settings`)

`/wf-settings` opens a TUI to edit every config option without hand-editing JSON.
It is always available, even before you run `/wf` (so you can set
`workflow.autoEnter` up front).

Flow:

1. Pick a scope: **Session**, **Project**, **Global**, **Reset Session**, or **Reset Project** (or **Done** to close).
2. Edit options in a searchable list:
   - `models.<role>.provider` / `models.<role>.model` — free-text input (clear the field to inherit).
   - `models.<role>.thinking` — cycle through `inherit / off / minimal / low / medium / high / xhigh / max`.
   - `workflow.autoEnter`, `planReview.enabled`, `codeReview.enabled` — toggle through `inherit / true / false` (**Project / Global scopes only**, see below).
3. Press Esc to return to the scope picker; pick **Done** to finish.

**Reset Session** clears this Pi process's session overrides so it inherits Project / Global / default settings.
**Reset Project** clears `.pi/workflow/config.json` so the project inherits Global / default settings.

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
  editable in all three scopes. Note: inside a workflow mode, manual model
  or thinking switches made via `/model`, Ctrl+P, or Shift+Tab are preserved
  across turns, `/reload`, and `/resume` — workflow only re-applies the role
  config on explicit mode transitions and `/wf-settings` saves. Use `/wf-status`
  to compare the active runtime model/thinking against the configured role.
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

Each `workflow_plan_save` creates a new plan file with a random name:

```
.pi/workflow/plan/plan-a3b9f2c1.md          ← plan document
```

This allows multiple plans to coexist in the same project without conflicts.

### Plan Path Visibility

Every plan save, read, and `/wf-status` explicitly shows the plan file path (e.g., `.pi/workflow/plan/plan-a3b9f2c1.md`) so you can easily find and inspect the document.

### Plan Mode Confirmation Gate

Before producing and saving the final plan, Plan Mode explicitly asks whether the discussion is sufficient:

> "Is the discussion sufficient? Shall I write the final plan?"

Only after the user confirms the discussion is complete does the agent write the final plan document and call `workflow_plan_save`. If plan review is enabled, the agent may optionally call `workflow_plan_review` for an independent review.

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
| `/review` | TUI scope selector for code review — runs the workflow_code_review loop |
| `/commit [notes]` | Generate commit message and commit |
| `/wf-status` | Show current workflow state (mode, active runtime model/thinking vs configured role, plan path, run IDs) |
| `/wf-exit` | Exit workflow mode |
| `/wf-reset` | Clear workflow state and plan directory |
| `/wf-init` | Initialize agent workspace: ensure git repo, enter scoped Init Mode that audits/generates AGENTS.md via evidence-based grilling, then restore prior mode |

## Plan Review (Independent Agent)

Plan review runs an **optional, model-initiated** independent reviewer — no subprocess, no RPC, no Quick fallback. The plan agent calls `workflow_plan_review` (zero-argument) when the plan is complex or the user requests it.

- **Independent** — a fresh in-memory AgentSession re-validates the saved plan through its own repository and external-tool exploration. It never sees the planner's reasoning; only the authoritative requirements, confirmed decisions, and the Final Plan.
- **Inherits the parent tool surface** — active information tools (extension/MCP/Web/remote/memory) are reconstructed from their source paths; workflow tools stay absent; built-in read-only inspection tools are rebuilt.
- **Read-only** — `.pi/workflow/` reads are blocked and project writes are confined to the Plan scratch root.
- **Bounded** — one 30-minute total timeout; the reviewer chooses its own tool sequence and turn count within it.
- **Structured output** — Critical/Important/Minor/Summary with concrete repository evidence; nested usage is returned on the tool result.
- **Zero config** — just set `models.planReview` and `planReview.enabled: true` in your config.

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

For interactive scope selection and the full review/fix/re-review loop, use `/review` — it shows a TUI and prompts the model to call the tool.

## RPC / Paseo Compatibility

pi-workflow adapts to Pi's run modes so Paseo (and other Pi RPC clients) can drive the workflow without a terminal.

### Run-mode behavior matrix

| Command / surface | TUI | RPC (Paseo) | JSON / print |
|---|---|---|---|
| `/wf-settings` | `SettingsList` overlay + searchable model picker | basic-dialog wizard: scope → setting → value (select/input) | stderr guidance, no UI |
| `/review` | custom scope/ref overlay | basic-dialog wizard: scope (select) + refs (input) | stderr guidance, no UI |
| `/wf-status` | `notify` | `notify` (handled-command, Paseo surfaces it) | stderr text |
| todo tool | `workflow_todo` + TUI overlay | `update_plan` alias (Paseo native TodoListCard) | provider-dependent |
| `setStatus` / `setWidget` | footer + overlay widget | Pi emits events; Paseo currently ignores persistent status/widgets | n/a |

### Paseo native todo (`update_plan` compatibility)

In RPC mode, pi-workflow registers an `update_plan` tool whose arguments match Paseo's existing `UpdatePlanSchema (`{ plan: [{ step, status }] }`, status: `pending | in_progress | completed`). Paseo renders these as native TodoListCard entries; Pi's history mapper replays persisted tool calls, so resumed sessions reconstruct the todo card.

- **Full-list replacement**: providing `plan` replaces the entire todo list; IDs are per-call `T1..Tn` snapshots and must not be referenced across calls.
- **Read-only**: omitting `plan` returns the current list without mutating.
- **Blocked encoding**: pi-workflow's internal `blocked` status has no native slot in Paseo's three-state enum; it is encoded as a `[blocked] ` prefix on the step text. Structured `notes` are inlined into the step text.
- **Collision-safe**: if another extension already owns `update_plan`, pi-workflow skips the alias and falls back to `workflow_todo`; the active tool and mode prompt are recomputed each turn so fallback is consistent.

Verified against Paseo `0.2.1` (commit `65633004b23d6eeeda9321e04f096ca647694b2b`). Upgrading past the blocked/notes ceilings requires a Paseo mapper change.

### Project Trust

Config loading is trust-aware: `DEFAULT ← global ← trusted project ← session`. In an untrusted session the project layer is skipped for both effective config and source attribution, and `/wf-settings` refuses to read or write the Project scope. Use `--approve` (or `/trust` in interactive mode) to trust project-local config.

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
| `workflow_todo` | Maintain the todo list (reset, add, set, list). Mutations return a delta; `list` returns a full snapshot. Full todos are kept in `details` for the overlay and state recovery. |
| `workflow_plan_read` | Read the active plan — Plan Mode only. Approved Work relies on the handoff marker and approval journal for automatic recovery. |
| `workflow_plan_save` | Save or revise the active plan |
| `workflow_plan_approve` | Approve the active plan and hand off to Work Mode |
| `workflow_plan_clear` | Clear workflow state and return to idle mode |
| `workflow_grill_record` | Record grilling decisions (batch `decisions[]`; legacy single fields accepted) |
| `workflow_plan_review` | Launch the independent reviewer agent (zero-argument) |
| `workflow_code_review` | Run OCR code review on workspace or git ref range |

### workflow_plan_review

Launch the independent reviewer agent (only available when `planReview.enabled: true`). Zero-argument: the reviewer task is assembled from workflow state — the current Plan lifecycle's user requirements, the snapshotted confirmed decisions, and the saved Final Plan. Returns structured Critical/Important/Minor/Summary feedback with repository evidence; aggregated nested usage is returned on the top-level `usage` field, and operational metadata (reviewer model/thinking, elapsed time, turns, tool-call count, requested/active/unavailable tools, stop reason/error) is in `details`.

Legacy `task` / `context` / `instructions` fields carried by resumed sessions are accepted and discarded by `prepareArguments`.

### workflow_code_review

Run OCR code review (only available when `codeReview.enabled: true`). Defaults to workspace scope.

**Parameters:**
- `background` (required): task context and review focus
- `scope`: `"workspace"` (default), `"range"`, or `"commit"`
- `from` / `to` / `commit`: scope-specific refs

OCR runs with `--audience agent --format json`. The raw JSON is saved to a temp file and parsed into normalized findings (severity, rule, file, line range, message, suggestion); exact-duplicate findings are deduped. The model-visible result is a compact summary + finding list; the full raw JSON path, per-severity counts, and stats are kept in `details`. Preview output is ANSI text and is compacted into a file list. If JSON parsing fails, the raw file path is surfaced so the output can be inspected. The review → fix → re-review loop behavior is unchanged.

| Path | Purpose |
|------|---------|
| `.pi/workflow/config.json` | Project-level config |
| `.pi/workflow/plan/` | Plan documents (shared, randomized filenames) |
| `.pi/workflow/sessions/<key>/state.json` | Session-scoped runtime state |
| `~/.pi/agent/workflow/config.json` | Global config |