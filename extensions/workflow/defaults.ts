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
	},
	codeReview: {
		enabled: true,
	},
};

export const DEFAULT_STATE: WorkflowState = {
	mode: "idle",
	todos: [],
	hiddenDoneIds: [],
};
