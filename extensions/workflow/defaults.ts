import type { WorkflowConfig, WorkflowState } from "./types.js";

export const DEFAULT_CONFIG: WorkflowConfig = {
	models: {
		explore: {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			thinking: "medium",
		},
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
		implementationReview: {
			provider: "openai",
			model: "gpt-5.1",
			thinking: "high",
		},
		work: {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			thinking: "medium",
		},
		commit: {
			provider: "openai",
			model: "gpt-5.1-mini",
			thinking: "low",
		},
	},
	workflow: {
		autoEnter: false,
	},
	planReview: {
		enabled: true,
	},
	implementationReview: {
		enabled: true,
	},
	codeReview: {
		enabled: true,
	},
};

export const DEFAULT_STATE: WorkflowState = {
	workflowEnabled: false,
	workflowExplicitlyDisabled: false,
	mode: "idle",
	todos: [],
	grillTurns: [],
	planReviewDecisions: [],
};
