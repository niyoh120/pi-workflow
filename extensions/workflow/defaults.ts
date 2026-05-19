import type { WorkflowConfig, WorkflowState } from "./types.js";

export const DEFAULT_CONFIG: WorkflowConfig = {
  models: {
    plan: {
      provider: "anthropic",
      model: "claude-opus-4-5",
      thinking: "high",
    },
    planReview: {
      provider: "openai",
      model: "gpt-5.1",
      thinking: "high",
    },
    work: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinking: "medium",
    },
    review: {
      provider: "openai",
      model: "gpt-5.1",
      thinking: "high",
    },
    commit: {
      provider: "openai",
      model: "gpt-5.1-mini",
      thinking: "low",
    },
  },
  planReview: {
    enabled: true,
    maxLoops: 2,
  },
  codeReview: {
    enabled: true,
    maxLoops: 3,
  },
};

export const DEFAULT_STATE: WorkflowState = {
  mode: "idle",
  planApproved: false,
  planReviewStatus: "none",
  planReviewLoops: 0,
  codeReviewLoops: 0,
  autoCodeReview: false,
  todos: [],
};
