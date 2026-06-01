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
	workflow: {
		autoEnter: false,
	},
	planReview: {
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
	hiddenDoneIds: [],
};
