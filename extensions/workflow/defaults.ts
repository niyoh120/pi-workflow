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
    explore: {
      provider: "openai",
      model: "gpt-5.1",
      thinking: "high",
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
  todoOverlay: {
    enabled: true,
  },
  subagent: {
    installSource: "npm:@tintinweb/pi-subagents",
    rpcTimeoutMs: 5000,
    resultTimeoutMs: 300_000,
    autoInstall: false,
    agentTypes: {
      planReview: "pi-workflow-plan-review",
      review: "pi-workflow-code-review",
      explore: "Explore",
    },
  },
  askUserQuestion: {
    enabled: true,
    toolName: "ask_user_question",
    installSource: "npm:@juicesharp/rpiv-ask-user-question",
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
