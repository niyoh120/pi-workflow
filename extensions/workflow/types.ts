export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type Role = "plan" | "planReview" | "work" | "review" | "commit" | "explore";

export type SubagentRole = "planReview" | "review" | "explore";

export type Mode =
  | "idle"
  | "plan"
  | "planReview"
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
}

export type PlanReviewStatus = "none" | "pending" | "pass" | "fail";

export interface WorkflowState {
  mode: Mode;
  planPath?: string;
  planReviewPath?: string;
  planTitle?: string;
  planApproved: boolean;
  planReviewStatus: PlanReviewStatus;
  planReviewLoops: number;
  planReviewNotes?: string;
  /** Plan run id — new /plan creates a fresh id and resets planReviewLoops. */
  planRunId?: string;
  /** Work run id — new Work entry creates a fresh id and resets codeReviewLoops. */
  workRunId?: string;
  codeReviewLoops: number;
  autoCodeReview: boolean;
  todos: TodoItem[];
  /** Work status set by workflow_status tool. */
  workStatus?: WorkStatus;
  /** The run id this work status was set for. */
  workStatusRunId?: string;
  workStatusSummary?: string;
  workStatusTests?: string;
  workStatusUpdatedAt?: string;
  workStatusError?: string;
}
