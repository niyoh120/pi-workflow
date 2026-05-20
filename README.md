# pi-workflow

Lightweight software development workflow extension for pi-coding-agent: plan, plan review, implementation, code review, and commit orchestration.

## Installation

From the package root directory:

```bash
# Install globally (available across all projects)
pi install .

# Install per-project (stored in .pi/settings.json)
pi install -l .
```

After installation, the extension auto-loads on every pi session.

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
    }
  },
  "planReview": {
    "enabled": true,
    "maxLoops": 2
  },
  "codeReview": {
    "enabled": true,
    "maxLoops": 3
  }
}
```

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

This allows multiple plans to coexist in the same project without conflicts. The current active plan is tracked in `state.planPath` within `.pi/workflow/state.json`.

### Review Files

Each plan automatically gets a corresponding review file (`<plan-basename>.review.md`) when review notes are recorded via `workflow_plan review_pass` or `workflow_plan review_fail`.

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Enter Plan Mode |
| `/go [--force]` | Approve current plan and hand off to Work Mode |
| `/work [task]` | Skip Plan Mode, go straight to implementation |
| `/review` | Manual code review on current diff |
| `/commit [notes]` | Generate commit message and commit |
| `/wf-status` | Show current workflow state |
| `/wf-exit` | Exit workflow mode |
| `/wf-reset` | Clear workflow state and plan directory |

## Tools

| Tool | Purpose |
|------|---------|
| `workflow_todo` | Maintain the todo list (reset, add, set, list) |
| `workflow_plan` | Manage plans (save, approve, review, read, clear) |

## Storage

| Path | Purpose |
|------|---------|
| `.pi/workflow/state.json` | Current workflow state |
| `.pi/workflow/config.json` | Project-level config |
| `.pi/workflow/plan/` | Plan documents and review notes |
| `~/.pi/agent/workflow/config.json` | Global config |
