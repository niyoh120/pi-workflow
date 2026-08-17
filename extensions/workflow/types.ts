import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type Thinking = ModelThinkingLevel;

/** Reviewer verdict submitted through the child-session-only `review_submit`
 *  tool. Shared by the independent reviewer runner result, both review
 *  result interfaces, and the persisted history rounds (which keep their own
 *  structurally identical local aliases). */
export type ReviewerVerdict = "PASS" | "FAIL";

/** Workflow roles — only the ones we actively configure models for. */
export type Role =
	| "explore"
	| "plan"
	| "planReview"
	| "review"
	| "work"
	| "commit";

/**
 * Simplified mode: idle plus explore/init/plan/work/commit workflow states.
 * `init` is a scoped write-only-for-AGENTS.md mode used by /wf-init.
 */
export type Mode = "idle" | "explore" | "init" | "plan" | "work" | "commit";

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TodoItem {
	id: string;
	title: string;
	status: TodoStatus;
	notes?: string;
}

/** Grilling 决策状态 — grill-me 式拷问阶段每题的落盘记录。 */
export type GrillDecisionStatus =
	| "resolved"
	| "open"
	| "needs-codebase-check";

/** 单次拷问记录：一个问题 + 推荐答案 + 用户答案 + 决策状态。 */
export interface GrillTurn {
	question: string;
	recommendedAnswer: string;
	userAnswer?: string;
	decisionStatus: GrillDecisionStatus;
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
	review?: Partial<WorkflowConfig["review"]>;
	codeReview?: Partial<WorkflowConfig["codeReview"]>;
}

export interface WorkflowConfig {
	models: Record<Role, ModelSpec>;
	/** Workflow entry gate — disabled by default until /wf is run. */
	workflow: {
		autoEnter: boolean;
	};
	/** Plan review via an independent reviewer agent — optional, controlled by enabled flag. */
	planReview: {
		enabled: boolean;
	};
	/**
	 * On-demand unified Review — gated by this enabled flag. When enabled
	 * (default), `/review` and the `workflow_review` tool are available in Work
	 * Mode. The Review Agent independently verifies requirements/plan/todos and,
	 * when `codeReview.enabled` is true, folds workspace OCR findings into the
	 * same review. Review output is transient (a tool result); it never gates
	 * `/commit` and is never persisted to WorkflowState.
	 */
	review: {
		enabled: boolean;
	};
	/** OCR toggle for the unified Review. When true, `workflow_review` runs the
	 *  workspace `ocr review` and feeds normalized findings into the reviewer
	 *  task. When false, the Review Agent reviews without OCR. */
	codeReview: {
		enabled: boolean;
	};
}

// ── OCR normalized finding/result types (cross-module) ─────────────────────

/** Severity bucket for display ordering; preserves unknown values. */
export type OcrSeverity = "critical" | "high" | "medium" | "low" | "info" | (string & {});

/** A single normalized OCR finding. `existingCode` is dropped from the
 *  model-visible view (it duplicates repo source); kept only in raw JSON. */
export interface OcrFinding {
	/** Stable fingerprint-based id (sha1 of normalized identity). */
	id: string;
	severity: OcrSeverity;
	/** Model-generated rule/category, e.g. bug, security. Preserved verbatim. */
	rule: string;
	file: string;
	/** 1-based start line; undefined when absent. */
	line?: number;
	/** 1-based end line (inclusive); undefined when absent. */
	endLine?: number;
	message: string;
	/** Proposed fix from the reviewer; omitted when empty. */
	suggestion?: string;
}

/** Compact review result sent to the model (content) and tools (details). */
export interface OcrReviewResult {
	status: string;
	/** Present on the no-comments success path. */
	message?: string;
	/** Absolute path to the saved raw JSON file. */
	rawPath: string;
	findings: OcrFinding[];
	/** Per-severity counts (keys are the observed severity strings). */
	counts: Record<string, number>;
	/** Files reviewed + token usage from summary, when present. */
	stats?: {
		filesReviewed?: number;
		totalTokens?: number;
		elapsed?: string;
	};
	sessionId?: string;
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
	/** Absolute path to the active git worktree used for this work run. */
	worktreePath?: string;
	/** Branch checked out in the active worktree. */
	worktreeBranch?: string;
	/** Base branch/ref the worktree was created from. */
	worktreeBaseBranch?: string;
	/** Todo items tracking work progress. */
	todos: TodoItem[];
	/** Plan Mode grilling 阶段记录的设计决策拷问序列。 */
	grillTurns: GrillTurn[];
	/**
	 * Session leaf entry id captured when `/plan` starts. Scopes authoritative
	 * requirement extraction to the current Plan lifecycle so the independent
	 * reviewer only sees user messages from this plan discussion. Undefined
	 * outside Plan Mode and on older sessions (extraction falls back to the
	 * whole active branch).
	 */
	planStartEntryId?: string;
	/**
	 * Confirmed grilling decisions snapshotted across the Plan lifecycle. Each
	 * plan save merges the current `grillTurns` here before clearing them, so a
	 * revised plan still carries earlier confirmed decisions to the reviewer.
	 * Cleared on approval/clear.
	 */
	planReviewDecisions: GrillTurn[];
	/**
	 * Immutable snapshot of the approved todo list, captured at plan
	 * approval time. Deep-copied so later todo mutations do not alter the
	 * snapshot the reviewer compares against. Undefined in Direct Work and
	 * on older sessions; the reviewer flags the gap rather than silently
	 * passing.
	 */
	approvedTodos?: TodoItem[];
	/**
	 * Session leaf entry id captured when `/work` starts a Direct Work run.
	 * Scopes authoritative requirement extraction to this Work lifecycle so the
	 * implementation reviewer only sees user messages from this work session.
	 * Undefined in Approved Work (which uses the Final Plan instead).
	 */
	workStartEntryId?: string;
/**
	 * Mode to restore after Init Mode ends. Undefined when not in init.
	 * `idle` and `init` are excluded as return targets (workflow auto-promotes
	 * idle → explore; init → init is a no-op); init_complete falls back to
	 * explore if the recorded value is missing or invalid.
	 */
	initReturnMode?: "explore" | "plan" | "work" | "commit";
	/**
	 * Absolute path of the single AGENTS.md file Init Mode may write/edit.
	 * Undefined when not in init. Enforced strictly by the tool_call guard.
	 */
	initTargetPath?: string;
	/**
	 * Work run ID awaiting kickoff. Set atomically with mode/workRunId at
	 * plan approval; cleared when durable post-marker user evidence confirms
	 * the Work run has started. Used by the agent_settled dispatcher.
	 */
	pendingWorkKickoff?: string;
	/**
	 * Session-scoped config overrides — highest-priority config layer.
	 * Merged on top of DEFAULT ← global ← project when resolving config for
	 * this session. Edited via /wf-settings (Session scope).
	 */
	sessionConfig?: WorkflowConfigOverride;
}
