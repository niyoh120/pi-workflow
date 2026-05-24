/**
 * WorkflowTodoOverlay — Persistent widget showing workflow_todo progress above the editor.
 *
 * Reads live TodoItem[] at update() time. Follows the Pi TUI setWidget factory
 * pattern (aboveEditor placement). Auto-hides when the task list is empty.
 *
 * Done items are briefly visible after completion, then hidden when the next
 * agent turn starts — matching the rpiv-todo overlay UX without copying its
 * implementation or depending on it as a package.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { TodoItem, TodoStatus } from "./types.js";

const WIDGET_KEY = "pi-workflow-tasks";
const MAX_LINES = 12;

const STATUS_SYMBOL: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "◐",
  done: "✓",
  blocked: "⊘",
};

const STATUS_COLOR: Record<TodoStatus, string> = {
  pending: "dim",
  in_progress: "accent",
  done: "success",
  blocked: "warning",
};

function formatTaskLine(task: TodoItem, theme: Theme): string {
  const sym = STATUS_SYMBOL[task.status] ?? "?";
  const color = STATUS_COLOR[task.status] ?? "dim";
  const notes = task.notes ? ` — ${task.notes}` : "";
  return `${theme.fg(color, sym)} ${task.id}: ${task.title}${notes}`;
}

// ── Module-level registry ──────────────────────────
// tools.ts and commands.ts call this back through getWorkflowOverlay().

let _overlay: WorkflowTodoOverlay | undefined;

export function setWorkflowOverlay(o: WorkflowTodoOverlay | undefined): void {
  _overlay = o;
}

export function getWorkflowOverlay(): WorkflowTodoOverlay | undefined {
  return _overlay;
}

// ── Overlay class ──────────────────────────────────

export class WorkflowTodoOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private todos: TodoItem[] = [];
  private doneIdsPendingHide = new Set<string>();
  private hiddenDoneIds = new Set<string>();

  // ── Public API ──────────────────────────────────

  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  /** Refresh the overlay content. Pass the full current workflow_todo list. */
  update(todos: TodoItem[]): void {
    if (!this.uiCtx) return;
    this.todos = todos;

    if (todos.length === 0) {
      this.dispose();
      return;
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(theme, width),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  /** Call at the start of each agent turn. Moves done items to hidden. */
  hideDoneFromLastTurn(): void {
    if (this.doneIdsPendingHide.size === 0) return;
    for (const id of this.doneIdsPendingHide) {
      this.hiddenDoneIds.add(id);
    }
    this.doneIdsPendingHide.clear();
    this.tui?.requestRender();
  }

  /** Remove the widget and clear UI state. */
  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.doneIdsPendingHide.clear();
    this.hiddenDoneIds.clear();
  }

  // ── Private helpers ─────────────────────────────

  private cleanupStaleDoneIds(): void {
    const currentDone = new Set(
      this.todos.filter((t) => t.status === "done").map((t) => t.id),
    );
    for (const id of this.doneIdsPendingHide) {
      if (!currentDone.has(id)) this.doneIdsPendingHide.delete(id);
    }
    for (const id of this.hiddenDoneIds) {
      if (!currentDone.has(id)) this.hiddenDoneIds.delete(id);
    }
  }

  private getVisibleTodos(): TodoItem[] {
    this.cleanupStaleDoneIds();
    const visible: TodoItem[] = [];
    for (const t of this.todos) {
      if (t.status === "done" && this.hiddenDoneIds.has(t.id)) continue;
      visible.push(t);
    }
    return visible;
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const visible = this.getVisibleTodos();
    if (visible.length === 0) {
      // All visible tasks gone; hide the widget.
      // Use setTimeout so dispose() runs outside the render phase.
      setTimeout(() => this.dispose(), 0);
      return [];
    }

    // Counts
    const total = this.todos.length;
    const doneCnt = this.todos.filter((t) => t.status === "done").length;
    const hasActive = visible.some((t) => t.status === "in_progress");
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const heading = truncateToWidth(
      `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, `Workflow Progress (${doneCnt}/${total})`)}`,
      width,
      "…",
    );

    // Track newly visible done items so they are hidden at the next agent start.
    const newlyDone = visible
      .filter((t) => t.status === "done" && !this.doneIdsPendingHide.has(t.id))
      .map((t) => t.id);
    for (const id of newlyDone) this.doneIdsPendingHide.add(id);

    // Truncate to MAX_LINES (including heading)
    const maxTaskLines = MAX_LINES - 1;
    const truncated = visible.length > maxTaskLines;
    const displayTasks = truncated
      ? visible.slice(0, maxTaskLines - 1)
      : visible;

    const lines: string[] = [heading];
    for (const task of displayTasks) {
      lines.push(
        truncateToWidth(
          `${theme.fg("dim", "├─")} ${formatTaskLine(task, theme)}`,
          width,
          "…",
        ),
      );
    }

    if (truncated) {
      const hidden = visible.length - (maxTaskLines - 1);
      lines.push(
        truncateToWidth(
          `${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} more`)}`,
          width,
          "…",
        ),
      );
    } else if (lines.length > 1) {
      lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
    }

    return lines;
  }
}
