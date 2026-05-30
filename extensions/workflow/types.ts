export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Workflow roles — only the ones we actively configure models for. */
export type Role = "plan" | "planReview" | "work" | "review" | "commit";

/** Simplified mode: only 4 workflow states. */
export type Mode = "idle" | "plan" | "work" | "commit";

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  notes?: string;
}

export interface ModelSpec {
  provider: string;
  model: string;
  thinking?: Thinking;
}

/** Built-in workflow todo overlay config. Displayed above the editor in non-idle workflow modes. */
export interface TodoOverlayConfig {
  /** Enable the workflow todo progress overlay. */
  enabled: boolean;
}

/** Optional integration with @juicesharp/rpiv-ask-user-question. */
export interface AskUserQuestionConfig {
  /** Enable auto-activation of ask_user_question in Plan/approval contexts. */
  enabled: boolean;
  /** Tool name to look for (must match the registered tool). */
  toolName: string;
  /** Source for pi install hint, e.g. "npm:@juicesharp/rpiv-ask-user-question". */
  installSource: string;
}

/** Code review via alibaba/open-code-review CLI. */
export interface CodeReviewConfig {
  /** Enable code review as a built-in workflow step. */
  enabled: boolean;
  /** Path to the ocr binary. Defaults to "ocr" (assumes in PATH). */
  ocrBinary?: string;
  /** Timeout for ocr CLI execution in ms. Default: 300_000 (5 min). */
  timeoutMs?: number;
  /** Max review-then-fix loops. Prompt-constrained; this is a soft upper bound. */
  maxLoops?: number;
}

export interface WorkflowConfig {
  models: Record<Role, ModelSpec>;
  /** Plan review config. Review is always enabled (builtin step);
   *  this controls the model/thinking override for the sidecall. */
  planReview: {
    enabled: boolean;
  };
  /** Code review via alibaba/open-code-review CLI. */
  codeReview: CodeReviewConfig;
  todoOverlay: TodoOverlayConfig;
  askUserQuestion: AskUserQuestionConfig;
}

export interface WorkflowState {
  mode: Mode;
  /** Path to the current plan file (relative to cwd). */
  planPath?: string;
  /** Plan title. */
  planTitle?: string;
  /** Plan run id — identifies a plan document lifecycle. */
  planRunId?: string;
  /** Work run id — identifies a work session. */
  workRunId?: string;
  /** Todo items tracking work progress. */
  todos: TodoItem[];
  /** IDs of completed todos that have been hidden from the overlay. */
  hiddenDoneIds: string[];
}