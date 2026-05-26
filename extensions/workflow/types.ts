export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type Role = "plan" | "planReview" | "work" | "review" | "commit" | "explore";

export type SubagentRole = "planReview" | "review" | "explore";

export type Mode =
  | "idle"
  | "plan"
  | "planReview"
  | "workPending"
  | "work"
  | "review"
  | "fix"
  | "commit";

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export type WorkStatus = "ready_for_review" | "blocked";

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

/** pi-subagents integration config. Legacy SubagentConfig fields are tolerated but ignored. */
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
  planReview: {
    enabled: boolean;
    maxLoops: number;
  };
  codeReview: {
    enabled: boolean;
    maxLoops: number;
  };
  subagent: SubagentConfig;
  todoOverlay: TodoOverlayConfig;
  askUserQuestion: AskUserQuestionConfig;
}

export type PlanReviewStatus = "none" | "pending" | "pass" | "fail";

export interface PendingWorkHandoff {
  id: string;
  marker: string;
  planPath: string;
  planRunId?: string;
  workRunId: string;
  createdAt: string;
  expiresAt: string;
  expectedPrompt: string;
}

export interface WorkflowState {
  mode: Mode;
  planPath?: string;
  planReviewPath?: string;
  planTitle?: string;
  /** Whether the current plan has been approved. No longer drives handoff
   *  — handoff is driven by mode=workPending + pendingWorkHandoff. */
  planApproved: boolean;
  planReviewStatus: PlanReviewStatus;
  planReviewLoops: number;
  planReviewNotes?: string;
  /** Plan run id — identifies a plan document lifecycle (not the review trigger). */
  planRunId?: string;
  /** Work run id — identifies a work session (not the auto-review trigger). */
  workRunId?: string;
  codeReviewLoops: number;
  autoCodeReview: boolean;
  todos: TodoItem[];
  /** Pending plan→work handoff (plan approved, waiting for before_agent_start finalize). */
  pendingWorkHandoff?: PendingWorkHandoff;
  /** Work status set by workflow_status tool. */
  workStatus?: WorkStatus;
  /** The run id this work status was set for. */
  workStatusRunId?: string;
  workStatusSummary?: string;
  workStatusTests?: string;
  workStatusUpdatedAt?: string;
  workStatusError?: string;
  /** Latest code review result text (stored when review fails, cleared on plan save / new work run). */
  lastReviewNotes?: string;
  /** Status marker from the latest code review. */
  lastReviewStatus?: "PASS" | "FAIL";
}
