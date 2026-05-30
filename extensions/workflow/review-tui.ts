/**
 * review-tui.ts — OCR review TUI wizard
 *
 * Provides typed OCR review option model, argv-safe command construction,
 * and multi-step TUI components for interactive review configuration.
 */

import { Container, type SelectItem, SelectList, Spacer, Text, Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";

// ── Terminal control character stripping (shared helper) ─────────────────────

/** Strip ANSI escape sequences, OSC/DCS/PM/APC sequences, and C0/C1 control characters for safe terminal rendering. */
function stripTerminalControlChars(s: string): string {
  return s
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|P[^\x1B]*(?:\x1B\\)|[\^_][^\x1B]*(?:\x1B\\))/g, "")
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

// ── OCR review option types ──────────────────────────────────────────────────

export type ReviewScope =
  | { kind: "workspace" }
  | { kind: "range"; from: string; to: string }
  | { kind: "commit"; commit: string };

// ── TUI: Step 1 — Scope mode selector ───────────────────────────────────────

const SCOPE_ITEMS: SelectItem[] = [
  {
    value: "workspace",
    label: "Workspace changes (Recommended)",
    description: "Review staged + unstaged + untracked changes",
  },
  {
    value: "range",
    label: "Custom ref range",
    description: "Review diff between two refs (--from/--to)",
  },
  {
    value: "commit",
    label: "Single commit",
    description: "Review a specific commit against its parent",
  },
];

/**
 * Create a scope-selector overlay component.
 * Resolves with the selected scope kind string, or null on cancel.
 */
export function scopeSelectorComponent(
  theme: Theme,
  done: (value: ReviewScope["kind"] | null) => void,
): { render: (w: number) => string[]; invalidate: () => void; handleInput: (data: string) => void } {
  const container = new Container();

  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(
    new Text(theme.fg("accent", theme.bold("Review Scope")), 1, 0),
  );
  container.addChild(new Text(theme.fg("dim", "Select what to review"), 1, 0));
  container.addChild(new Spacer(1));

  const selectList = new SelectList(SCOPE_ITEMS, 6, {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  });
  selectList.onSelect = (item) => {
    // Only valid scope kinds are in SCOPE_ITEMS, but assert defensively
    if (item.value === "workspace" || item.value === "range" || item.value === "commit") {
      done(item.value);
    } else {
      done(null);
    }
  };
  selectList.onCancel = () => done(null);
  container.addChild(selectList);

  container.addChild(new Spacer(1));
  container.addChild(
    new Text(theme.fg("dim", "↑↓ navigate  •  enter select  •  esc cancel"), 1, 0),
  );
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  return {
    render: (w: number) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      selectList.handleInput(data);
      container.invalidate();
    },
  };
}

// ── TUI: Step 2 — Scope-specific inputs ──────────────────────────────────────

/** Valid scope kinds that require text input. */
type ScopeInputKind = Extract<ReviewScope["kind"], "range" | "commit">;

/**
 * Custom form component for scope inputs (from/to refs or commit hash).
 * Handles keyboard input for up to 2 text fields, tab to switch,
 * enter to confirm, escape to cancel.
 */
class ScopeInputForm {
  private scope: ScopeInputKind;
  private inputs: Input[];
  private labels: string[];
  private defaults: string[];
  private keys: string[];
  private activeField = 0;

  public onConfirm?: (values: Record<string, string>) => void;
  public onCancel?: () => void;

  private cachedLines: string[] | null = null;
  private cachedWidth = -1;

  constructor(scope: ScopeInputKind) {
    this.scope = scope;

    if (scope === "range") {
      this.labels = ["From ref:", "To ref:"];
      this.defaults = ["", ""];
      this.keys = ["from", "to"];
    } else {
      this.labels = ["Commit:"];
      this.defaults = [""];
      this.keys = ["commit"];
    }

    this.inputs = this.defaults.map((d) => {
      const input = new Input();
      input.setValue(d);
      input.onSubmit = (_value: string) => this.handleConfirm();
      return input;
    });
  }

  private handleConfirm(): void {
    const values: Record<string, string> = {};
    for (let i = 0; i < this.keys.length; i++) {
      values[this.keys[i]] = stripTerminalControlChars(this.inputs[i].getValue()).trim();
    }
    this.onConfirm?.(values);
  }

  private handleCancel(): void {
    this.onCancel?.();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      // If the active input has text, clear it first; ESC again to cancel
      const activeHasText = this.inputs[this.activeField].getValue().length > 0;
      if (activeHasText) {
        this.inputs[this.activeField].setValue("");
        this.invalidate();
        return;
      }
      this.handleCancel();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      if (matchesKey(data, Key.shift("tab"))) {
        this.activeField =
          (this.activeField - 1 + this.inputs.length) % this.inputs.length;
      } else {
        this.activeField =
          (this.activeField + 1) % this.inputs.length;
      }
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.activeField > 0) {
        this.activeField--;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.activeField < this.inputs.length - 1) {
        this.activeField++;
        this.invalidate();
      }
      return;
    }

    // Delegate to active input
    this.inputs[this.activeField].handleInput(data);
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = null;
    this.cachedWidth = -1;
    for (const input of this.inputs) input.invalidate();
  }

  render(theme: Theme, width: number): string[] {
    if (this.cachedLines !== null && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    // Title bar
    const scopeLabelMap: Record<string, string> = {
      range: "Custom Ref Range",
      commit: "Single Commit",
    };
    const scopeLabel = scopeLabelMap[this.scope] ?? "Unknown";
    lines.push(theme.fg("accent", theme.bold(`Review Scope: ${scopeLabel}`)));
    lines.push(theme.fg("dim", "─".repeat(Math.max(0, width - 2))));

    // Input fields
    for (let i = 0; i < this.inputs.length; i++) {
      const isActive = i === this.activeField;
      const label = this.labels[i];
      const inputText = stripTerminalControlChars(this.inputs[i].getValue());

      const prefix = isActive
        ? theme.fg("accent", "▶")
        : "  ";
      const labelStyled = isActive
        ? theme.fg("accent", label)
        : theme.fg("muted", label);

      let line: string;
      if (inputText.length === 0) {
        line = `${prefix} ${labelStyled} ${theme.fg("dim", "(empty)")}`;
      } else {
        line = `${prefix} ${labelStyled} ${inputText}`;
      }

      line = truncateToWidth(line, width, "…");

      lines.push(line);
    }

    // Help bar
    lines.push("");
    lines.push(
      theme.fg("dim", "tab/shift+tab  switch field  •  enter  confirm  •  esc  clear/cancel"),
    );

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }
}

/**
 * Create a scope-input overlay component.
 * Resolves with field values or null on cancel.
 */
export function scopeInputComponent(
  scope: ScopeInputKind,
  theme: Theme,
  done: (values: Record<string, string> | null) => void,
): { render: (w: number) => string[]; invalidate: () => void; handleInput: (data: string) => void } {
  const form = new ScopeInputForm(scope);

  form.onConfirm = (values) => done(values);
  form.onCancel = () => done(null);

  return {
    render: (w: number) => form.render(theme, w),
    invalidate: () => form.invalidate(),
    handleInput: (data: string) => form.handleInput(data),
  };
}


