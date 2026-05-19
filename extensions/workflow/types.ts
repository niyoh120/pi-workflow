export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type Role = "plan" | "planReview" | "work" | "review" | "commit";

export type Mode =
  | "idle"
  | "planning"
  | "planReview"
  | "work"
  | "review"
  | "fix"
  | "commit";

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
  codeReviewLoops: number;
  autoCodeReview: boolean;
  todos: TodoItem[];
}
