export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Workflow roles — only the ones we actively configure models for. */
export type Role = "explore" | "plan" | "planReview" | "work" | "commit";

/** Simplified mode: idle plus explore/plan/work/commit workflow states. */
export type Mode = "idle" | "explore" | "plan" | "work" | "commit";

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

/**
 * Deep-partial override of WorkflowConfig used as the highest-priority config
 * layer (session scope). Any single nested field may be overridden without
 * supplying the rest of its parent object.
 */
export interface WorkflowConfigOverride {
	models?: Partial<Record<Role, Partial<ModelSpec>>>;
	workflow?: Partial<WorkflowConfig["workflow"]>;
	planReview?: Partial<WorkflowConfig["planReview"]>;
	codeReview?: Partial<WorkflowConfig["codeReview"]>;
}

export interface WorkflowConfig {
	models: Record<Role, ModelSpec>;
	/** Workflow entry gate — disabled by default until /wf is run. */
	workflow: {
		autoEnter: boolean;
	};
	/** Plan review via sidecall — optional, controlled by enabled flag. */
	planReview: {
		enabled: boolean;
	};
	/** Code review via alibaba/open-code-review CLI — optional, controlled by enabled flag. */
	codeReview: {
		enabled: boolean;
	};
}

export interface WorkflowState {
	/** Whether workflow commands/tools are enabled for this session. */
	workflowEnabled: boolean;
	/** Whether the user explicitly disabled workflow this session (overrides autoEnter). */
	workflowExplicitlyDisabled: boolean;
	mode: Mode;
	/** Path to the current plan file (relative to cwd). */
	planPath?: string;
	/** Plan title. */
	planTitle?: string;
	/** Plan run id — identifies a plan document lifecycle. */
	planRunId?: string;
	/** Work run id — identifies a work session. */
	workRunId?: string;
	/** Todo items tracking work progress. */
	todos: TodoItem[];
	/** IDs of completed todos that have been hidden from the overlay. */
	hiddenDoneIds: string[];
	/**
	 * Session-scoped config overrides — highest-priority config layer.
	 * Merged on top of DEFAULT ← global ← project when resolving config for
	 * this session. Edited via /wf-settings (Session scope).
	 */
	sessionConfig?: WorkflowConfigOverride;
}
