export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type Role = "plan" | "planReview" | "work" | "review" | "commit" | "explore";

export type SubagentRole = "planReview" | "review" | "explore";

export type SubagentExtensionMode = "inherit" | "curated";

export type Mode =
  | "idle"
  | "plan"
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

export interface SubagentConfig {
  enabled: boolean;
  timeoutMs: number;
  extensionMode: SubagentExtensionMode;
  extensions: string[];
  fallbackToInlineReview: boolean;
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
  codeReviewLoops: number;
  autoCodeReview: boolean;
  todos: TodoItem[];
}
