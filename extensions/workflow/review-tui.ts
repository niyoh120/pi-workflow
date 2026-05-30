/**
 * review-tui.ts — OCR review TUI wizard
 *
 * Provides typed OCR review option model, argv-safe command construction,
 * and multi-step TUI components for interactive review configuration.
 */

import { Container, type SelectItem, SelectList, Spacer, Text, Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";

// ── OCR review option types ──────────────────────────────────────────────────

export type ReviewScope =
  | { kind: "workspace" }
  | { kind: "baseline"; from: string; to: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "commit"; commit: string };

// ── Argv builder (no shell interpolation) ────────────────────────────────────

export function buildScopeArgv(scope: ReviewScope): string[] {
  const argv: string[] = ["review"];

  switch (scope.kind) {
    case "baseline":
    case "range":
      argv.push("--from", scope.from, "--to", scope.to);
      break;
    case "commit":
      argv.push("--commit", scope.commit);
      break;
    // workspace: no extra scope flags
  }

  return argv;
}

/** Human-readable summary of the review command for confirmation UI.
 *  Strips ANSI/control characters, then shell-quotes args so the display matches argv boundaries. */
export function ocrCommandSummary(binary: string, argv: string[]): string {
  function quoteArg(arg: string): string {
    const safeArg = stripTerminalControlChars(arg);
    if (/^[A-Za-z0-9_\/:\-=@%+.,~]+$/.test(safeArg)) return safeArg;
    return `'${safeArg.replace(/'/g, `'\\''`)}'`;
  }
  return [binary, ...argv].map(quoteArg).join(" ");
}

/** Strip ANSI escape sequences, OSC/DCS/PM/APC sequences, and C0/C1 control characters for safe terminal rendering. */
function stripTerminalControlChars(s: string): string {
  return s
    // Full ANSI/OSC/DCS/PM/APC escape sequence removal (CSI, OSC, DCS, PM, APC, SOS, C1 single-byte)
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|P[^\x1B]*(?:\x1B\\)|[\^_][^\x1B]*(?:\x1B\\))/g, "")
    // Remove remaining C0 and C1 control characters
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

// ── TUI: Step 1 — Scope mode selector ───────────────────────────────────────

const SCOPE_ITEMS: SelectItem[] = [
  {
    value: "workspace",
    label: "Workspace changes",
    description: "Review staged + unstaged + untracked changes",
  },
  {
    value: "baseline",
    label: "Workflow baseline → HEAD",
    description: "Review changes since the Work-mode entry ref",
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
    if (item.value === "workspace" || item.value === "baseline" || item.value === "range" || item.value === "commit") {
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
type ScopeInputKind = Extract<ReviewScope["kind"], "baseline" | "range" | "commit">;

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

  constructor(scope: ScopeInputKind, baselineRef?: string) {
    this.scope = scope;

    if (scope === "baseline") {
      this.labels = ["From ref:", "To ref:"];
      this.defaults = [baselineRef ?? "", "HEAD"];
      this.keys = ["from", "to"];
    } else if (scope === "range") {
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
      baseline: "Baseline to HEAD",
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
  baselineRef: string | undefined,
  done: (values: Record<string, string> | null) => void,
): { render: (w: number) => string[]; invalidate: () => void; handleInput: (data: string) => void } {
  const form = new ScopeInputForm(scope, baselineRef);

  form.onConfirm = (values) => done(values);
  form.onCancel = () => done(null);

  return {
    render: (w: number) => form.render(theme, w),
    invalidate: () => form.invalidate(),
    handleInput: (data: string) => form.handleInput(data),
  };
}

// ── TUI: Step 3 — Fix confirmation ────────────────────────────────────────

const FIX_CONFIRM_ITEMS: SelectItem[] = [
  {
    value: "yes",
    label: "Yes — fix issues",
    description: "Proceed with fixing issues found in review",
  },
  {
    value: "no",
    label: "No — stay as-is",
    description: "Keep current state, do not fix anything",
  },
];

/**
 * Create a fix-confirmation overlay component.
 * Resolves with "yes" or "no", or null on cancel (esc).
 */
export function fixConfirmationComponent(
  theme: Theme,
  done: (value: "yes" | "no" | null) => void,
): { render: (w: number) => string[]; invalidate: () => void; handleInput: (data: string) => void } {
  const container = new Container();

  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(
    new Text(theme.fg("accent", theme.bold("Code Review Complete")), 1, 0),
  );
  container.addChild(new Text(theme.fg("dim", "Fix the issues found above?"), 1, 0));
  container.addChild(new Spacer(1));

  const selectList = new SelectList(FIX_CONFIRM_ITEMS, 4, {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  });
  selectList.onSelect = (item) => {
    if (item.value === "yes" || item.value === "no") {
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


