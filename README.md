# pi-workflow

Lightweight software development workflow extension for pi-coding-agent: plan, isolated plan review, implementation, isolated code review, codebase exploration subagents, and commit orchestration.

**Requirements:** `@tintinweb/pi-subagents` must be installed and loaded before pi-workflow. Without it, subagent-backed features (plan review, code review, `workflow_subagent`) will fail with an install/reload hint.

## Installation

```bash
# 1. Install required dependency
pi install npm:@tintinweb/pi-subagents

# 2. (Optional) Structured user-question dialog — enables tabbed option selectors in plan/approval flows
pi install npm:@juicesharp/rpiv-ask-user-question

# 3. Install pi-workflow globally
pi install .

# 4. Inside Pi, sync minimal review containers and reload
/wf-install-subagents
/reload
```

> **Note:** `@juicesharp/rpiv-ask-user-question` is optional. Without it, Plan Mode uses normal chat for clarifying questions and approval confirmation. Install it for a richer tabbed-dialog experience (multi-select, side-by-side previews, typed notes). As with any third-party Pi package, review the source before installing.

## Modes

| Mode | Command | Description |
|------|---------|-------------|
| Plan Mode | `/plan` | Brainstorm and produce an implementation plan |
| Plan Review Mode | (auto) | Review the plan before execution |
| Work Mode | `/work` | Implement the approved plan |
| Fix | (auto) | Fix critical/important issues from code review |
| Code Review Mode | `/review` | Review the current git diff |
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
    },
    "explore": {
      "provider": "openai",
      "model": "gpt-5.1",
      "thinking": "high"
    }
  },
  "planReview": {
    "enabled": true,
    "maxLoops": 2
  },
  "codeReview": {
    "enabled": true,
    "maxLoops": 3
  },
  "subagent": {
    "installSource": "npm:@tintinweb/pi-subagents",
    "rpcTimeoutMs": 5000,
    "resultTimeoutMs": 300000,
    "autoInstall": false,
    "agentTypes": {
      "planReview": "pi-workflow-plan-review",
      "review": "pi-workflow-code-review",
      "explore": "Explore"
    },
    "maxTurns": {
      "planReview": 30,
      "review": 30,
      "explore": 30
    }
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

**Legacy config fields:** Old `subagent` fields (`enabled`, `timeoutMs`, `extensionMode`, `extensions`, `fallbackToInlineReview`) are silently ignored. They do not cause errors.

### Project config

`.pi/workflow/config.json` — same structure as the global config. Project values override global values.

## Plan Document Management

### Directory

All plan documents are stored under `.pi/workflow/plan/`.

### Random Naming

Each `workflow_plan save` creates a new plan file with a random name:

```
.pi/workflow/plan/plan-a3b9f2c1.md          ← plan document
.pi/workflow/plan/plan-a3b9f2c1.review.md   ← plan review notes
```

This allows multiple plans to coexist in the same project without conflicts.

### Plan Path Visibility

Every plan save, read, review, and `/wf-status` explicitly shows the plan file path (e.g., `.pi/workflow/plan/plan-a3b9f2c1.md`) so you can easily find and inspect the document.

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Enter Plan Mode |
| `/go [--force]` | Approve current plan and hand off to Work Mode |
| `/work [task]` | Skip Plan Mode, go straight to implementation |
| `/review` | Manual code review on current diff |
| `/commit [notes]` | Generate commit message and commit |
| `/wf-status` | Show current workflow state (includes plan path and run IDs) |
| `/wf-exit` | Exit workflow mode |
| `/wf-reset` | Clear workflow state and plan directory |
| `/wf-init` | Initialize agent workspace: ensure git repo, generate/update AGENTS.md |
| `/wf-install-subagents` | Install @tintinweb/pi-subagents and sync minimal review containers |

## Subagents

Plan review, code review, and exploration run as **fresh-context subagents via @tintinweb/pi-subagents**. This provides:

- **Clean context** — the reviewer sees only the plan or diff, not your full conversation.
- **Parallel execution** — multiple subagents can run concurrently.
- **Live widget UI** — see agent progress, tool usage, and token counts.
- **Minimal containers** — `planReview` and `review` use lightweight pi-workflow custom agent files that only declare tool permissions; the actual review rules come from workflow-injected prompts.
- **Exploration** — `explore` uses the built-in `Explore` agent type.

Review agents are **not a hard OS/tool sandbox** — they disable `write` / `edit` but retain `bash` for read-only operations. They run as fresh sessions without parent conversation history. (`extensions: false` limits them to built-in tools only; if web search or MCP tools are desired for review, set `extensions: true` in the agent `.md` frontmatter.)

### Agent Types

| Role | Agent Type | Source |
|------|-----------|--------|
| `planReview` | `pi-workflow-plan-review` | Minimal container — bundled and synced via `/wf-install-subagents` |
| `review` | `pi-workflow-code-review` | Minimal container — bundled and synced via `/wf-install-subagents` |
| `explore` | `Explore` | Built-in (from `@tintinweb/pi-subagents`) |

Custom review agents are defined under `extensions/workflow/agents/` in the pi-workflow package. `/wf-install-subagents` syncs them to the global agents directory (`~/.pi/agent/agents/`) so pi-subagents discovers them in any project.

If custom review agents are missing from both project (`.pi/agents/`) and global paths, review operations will fail with a clear error and install instructions — there is no silent fallback.

Custom review agent files are **minimal containers** — they only declare tool permissions and a short neutral prompt. The complete review rules and output format requirements come from pi-workflow's isolated review prompts, which are injected at runtime. This means:

- **Model, thinking level, and turn limits are controlled exclusively by your workflow config** (`config.json`), not by the agent `.md` file.
- The `.md` files contain no model configuration — there is no conflict between frontmatter and workflow config.

Custom review agent frontmatter:

```yaml
tools: read, bash, grep, find, ls
disallowed_tools: write, edit
extensions: false
skills: false
```

## Workflow Status (auto review trigger)

Work/Fix mode no longer uses text markers (`WORK_STATUS: READY_FOR_REVIEW`). Instead, the agent must call:

```
workflow_status({ status: "ready_for_review", runId: currentRunId, summary: "...", tests: "..." })
```

or:

```
workflow_status({ status: "blocked", runId: currentRunId, error: "..." })
```

This is the **only** way to trigger automatic code review. The tool validates the current mode and run ID. If not called, or called with a stale run ID, auto review does not start and a diagnostic is shown.

## Trigger-Scoped Review Counters

Plan review and code review loop counters limit review retries per trigger, not across the whole session.

- `planReviewLoops` resets to `0` on every `workflow_plan save`. A save is a fresh plan-review trigger.
- If plan review is enabled, each save creates a `pending` review status. Review failures increment `planReviewLoops` within that save-trigger only. When `planReviewLoops` reaches `maxLoops`, auto review stops and the user must decide manually.
- `codeReviewLoops` resets to `0` when the Work-mode agent reports `ready_for_review` via `workflow_status`. This starts a fresh automatic review/fix sequence.
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

**Legacy migration:** If a session has no state but the old `.pi/workflow/state.json` exists, it is imported once into the session-scoped path. The legacy file is not deleted.

## Tools

| Tool | Purpose |
|------|---------|
| `workflow_todo` | Maintain the todo list (reset, add, set, list) |
| `workflow_plan` | Manage plans (save, approve, review, read, clear) — responses include plan path |
| `workflow_subagent` | Spawn a read-only subagent via pi-subagents for review or exploration |
| `workflow_status` | Report Work/Fix completion status — triggers auto code review |

### workflow_subagent

Spawn a role-shaped, read-only subagent via @tintinweb/pi-subagents.

**Parameters:**
- `role` (required): `planReview` | `review` | `explore`
- `task` (required): the focused task for the subagent
- `context` (optional): explicit context for the subagent (parent session history is NOT available)
- `instructions` (optional): additional preferences — depth, format, focus, search strategy

**Roles:**
- `planReview`: Isolated plan review using pi-workflow custom agent. Subagent outputs `PLAN_REVIEW_STATUS: PASS|FAIL`.
- `review`: Isolated code diff review using pi-workflow custom agent. Subagent outputs `REVIEW_STATUS: PASS|FAIL`.
- `explore`: Fast read-only codebase exploration using built-in `Explore` agent. Returns findings — no status marker required.

### workflow_status

Report completion status of Work/Fix mode. Must be called to trigger auto code review.

**Parameters:**
- `status` (required): `ready_for_review` | `blocked`
- `runId` (required): the current `workRunId` from the workflow state — must match exactly
- `summary` (optional): short summary of what was done
- `tests` (optional): test results
- `error` (optional): reason if blocked

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

pi-workflow includes a built-in progress overlay displayed above the editor in non-idle workflow modes (plan, work, fix, review). It does **not** require `@juicesharp/rpiv-todo` — the overlay reads `workflow_todo` state directly through extension code, so there is no manual sync step and no risk of two todo lists drifting apart.

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
| `.pi/workflow/plan/` | Plan documents and review notes (shared, randomized filenames) |
| `.pi/workflow/sessions/<key>/state.json` | Session-scoped runtime state |
| `~/.pi/agent/workflow/config.json` | Global config |
