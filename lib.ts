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
}

export interface QuestWorkflow {
	id: string;
	title: string;
	status: QuestStatus;
	createdAt: string;
	updatedAt: string;
	source: QuestSource;
	artifacts: QuestArtifacts;
}

export interface CurrentQuestState {
	currentQuestId?: string;
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
	planned: ["executing"],
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
