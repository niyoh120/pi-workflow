export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type Role = "plan" | "planReview" | "work" | "review" | "commit" | "explore";

export type SubagentRole = "planReview" | "review" | "explore";

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

/** pi-subagents integration config. */
export interface SubagentConfig {
  /** Source for pi install, e.g. "npm:@tintinweb/pi-subagents". */
  installSource?: string;
  /** Timeout for RPC ping detection (ms). */
  rpcTimeoutMs?: number;
  /** Timeout waiting for subagent result (ms). 0 = no timeout. */
  resultTimeoutMs?: number;
  /** Opt-in auto-install. Off by default. */
  autoInstall?: boolean;
  /** Agent type names for workflow roles. */
  agentTypes?: {
    planReview?: string;
    review?: string;
    explore?: string;
  };
  /** Max turn limits per subagent role. Undefined or 0 = unlimited. */
  maxTurns?: Partial<Record<SubagentRole, number>>;
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

export interface WorkflowConfig {
  models: Record<Role, ModelSpec>;
  /** Plan review config. Review is always enabled (builtin step); this only
   *  controls model/thinking overrides and is kept for backward compat. */
  planReview: {
    enabled: boolean;
    maxLoops: number;
  };
  /** Code review config. Review is always enabled (builtin step);
   *  maxLoops and auto are kept for backward compat but no longer
   *  enforce hard limits — prompt constraints guide loop termination. */
  codeReview: {
    enabled: boolean;
    maxLoops: number;
    auto: boolean;
  };
  subagent: SubagentConfig;
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
  /** Git baseline ref captured at Work mode entry.
   *  Used by code review to diff only changes made during this work session.
   *  Cleared on review PASS, reset, new plan, or commit. */
  workBaselineRef?: string;
  /** Set of untracked file paths at Work mode entry.
   *  Used by code review to scope untracked content to only files created during this session. */
  workBaselineUntracked?: string[];
  /** Todo items tracking work progress. */
  todos: TodoItem[];
  /** IDs of completed todos that have been hidden from the overlay. */
  hiddenDoneIds: string[];
}