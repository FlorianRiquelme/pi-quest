/**
 * pi-quest shared types and utilities
 */

export type QuestStatus =
	| "intake"
	| "recon-ready"
	| "reviewing"
	| "needs-resolution"
	| "resolved"
	| "planned"
	| "launch-review"
	| "executing"
	| "blocked"
	| "verification"
	| "verification-ready"
	| "uat-ready"
	| "uat-failed"
	| "completed"
	| "archived";

export interface QuestSource {
	handoffPath?: string;
	branch?: string;
	commitAtIntake?: string;
}

export interface QuestArtifacts {
	handoff: string;
	recon?: string;
	review?: string;
	resolvedHandoff?: string;
	plan?: string;
	verification?: string;
	uat?: string;
	/**
	 * Homecoming Brief (ADR 015 / M4-1). Defaults to `"BRIEF.md"` for quests
	 * created after M4-1; older quests on disk may not have the field set and
	 * the generator backfills it on first run.
	 */
	brief?: string;
}

/**
 * Swarm-freeze state recorded by M3-2 / ADR 013 §8.
 *
 * Present only while a freeze is active. Soft freeze is reversible — the same
 * chord (Ctrl+P) clears the field. Hard freeze writes the field as part of
 * transitioning the quest to `blocked` (the freeze field itself is not
 * required for the blocked state, but the audit trail captures the cause).
 */
export interface QuestFreeze {
	mode: "soft" | "hard";
	engaged_at: string;
	triggered_by: "user";
}

export interface QuestWorkflow {
	id: string;
	title: string;
	status: QuestStatus;
	createdAt: string;
	updatedAt: string;
	source: QuestSource;
	artifacts: QuestArtifacts;
	/**
	 * ISO 8601 timestamp recorded the first time the UAT doorbell fired for
	 * this quest (see ADR 016). Used to make the doorbell idempotent across
	 * subsequent `uat-ready` re-entries (e.g. uat-failed → uat-ready loops).
	 */
	uat_doorbell_fired_at?: string;
	/**
	 * The git SHA the quest forked from, captured at first entry to `executing`
	 * (ADR 011 §2). Anchor for the Quest Branch and every Run Worktree.
	 */
	baseSha?: string;
	/**
	 * Name of the Quest Branch (`quest/<questId>`), captured alongside `baseSha`.
	 * Persisted so the merge target survives across pi restarts.
	 */
	questBranch?: string;
	/**
	 * Active swarm-freeze state, if any. See ADR 013 §8 and M3-2.
	 * Cleared (deleted from the workflow) when freeze is released.
	 */
	freeze?: QuestFreeze;
	/**
	 * Reason a quest moved into `blocked`. Set to `user_aborted` by a
	 * hard freeze (M3-2). Other rescue paths may set their own reasons.
	 */
	cancel_reason?: string;
}

export interface CurrentQuestState {
	currentQuestId?: string;
	/**
	 * Per-quest pointer to the most recent `events.jsonl` timestamp the user
	 * has "seen" (i.e. the last time the Homecoming Brief was displayed for
	 * that quest). Used by the `/quest` auto-display trigger (ADR 015 / M4-1):
	 * when there are newer events than this pointer for the active quest, the
	 * Brief regenerates and the pointer advances.
	 *
	 * Stored keyed by quest ID so a project can have several active quests
	 * each with its own homecoming cadence.
	 */
	lastSeenEventTimestamp?: Record<string, string>;
}

export interface QuestConfig {
	models: {
		recon: string;
		reviewDiscussion: string;
		planning: string;
		executionOrchestrator: string;
		implementation: { default: string; fallback: string };
		rescue: string;
		verification: string;
		fixPlanning: string;
	};
	parallelism: { maxBatchSizeWarning: number };
	verification: {
		batchStrongReview: "auto" | "always" | "never";
		finalStrongReview: boolean;
		requireApprovalForFixCycles: boolean;
	};
	workspace: {
		root: string;
		statePath: string;
		archiveRoot: string;
	};
	telemetry: {
		enabled: boolean;
		format: "jsonl";
	};
	defaultToolPolicy?: Record<string, string[]>;
}

export const DEFAULT_QUEST_CONFIG: QuestConfig = {
	models: {
		recon: "cheap-default",
		reviewDiscussion: "gpt-5.5",
		planning: "gpt-5.5",
		executionOrchestrator: "openrouter/moonshotai/kimi-k2.6",
		implementation: { default: "openrouter/moonshotai/kimi-k2.6", fallback: "minmax" },
		rescue: "gpt-5.5",
		verification: "gpt-5.5",
		fixPlanning: "gpt-5.5",
	},
	parallelism: { maxBatchSizeWarning: 5 },
	verification: {
		batchStrongReview: "auto",
		finalStrongReview: true,
		requireApprovalForFixCycles: true,
	},
	workspace: {
		root: ".pi/quests",
		statePath: ".pi/quest/state.json",
		archiveRoot: "~/.pi/agent/quest/archives",
	},
	telemetry: {
		enabled: true,
		format: "jsonl",
	},
};

export const VALID_STATUS_TRANSITIONS: Partial<Record<QuestStatus, QuestStatus[]>> = {
	intake: ["recon-ready", "reviewing"],
	"recon-ready": ["reviewing"],
	reviewing: ["needs-resolution", "resolved"],
	"needs-resolution": ["reviewing", "resolved"],
	resolved: ["planned"],
	planned: ["launch-review"],
	"launch-review": ["executing", "blocked"],
	executing: ["blocked", "verification"],
	blocked: ["executing", "needs-resolution", "reviewing", "resolved", "planned", "verification"],
	verification: ["verification-ready", "blocked"],
	"verification-ready": ["uat-ready"],
	"uat-ready": ["completed", "uat-failed"],
	"uat-failed": ["executing", "needs-resolution", "planned", "verification", "uat-ready", "completed"],
	completed: ["archived"],
	archived: [],
};

export function isValidTransition(from: QuestStatus, to: QuestStatus): boolean {
	const allowed = VALID_STATUS_TRANSITIONS[from];
	if (!allowed) return false;
	return allowed.includes(to);
}

export function deriveQuestId(options: {
	explicitId?: string;
	branch?: string;
	handoffPath?: string;
	handoffTitle?: string;
}): string | undefined {
	if (options.explicitId) return slugify(options.explicitId);

	if (options.branch) {
		const m = options.branch.match(/(?:feature|fix|bug)?\/?(\w+[\-_]\d+)/);
		if (m) return slugify(m[1]);
	}

	if (options.handoffPath) {
		const base = options.handoffPath.replace(/\.md$/i, "");
		const m = base.match(/(\w+[\-_]\d+)/);
		if (m) return slugify(m[1]);
		return slugify(base.split(/[\/]/).pop() || "quest");
	}

	if (options.handoffTitle) {
		const m = options.handoffTitle.match(/(\w+[\-_]\d+)/);
		if (m) return slugify(m[1]);
		return slugify(options.handoffTitle.slice(0, 40));
	}

	return undefined;
}

export function generateTimestampId(): string {
	const now = new Date();
	return `quest-${now.toISOString().replace(/[:T\-.]/g, "").slice(0, 14)}`;
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function collisionSuffixed(base: string, existing: Set<string>): string {
	if (!existing.has(base)) return base;
	let n = 2;
	while (existing.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}
