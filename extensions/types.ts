/**
 * Shared local types for the pi-quest extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ */
/*  Context types (structural subsets of the real ExtensionAPI types)  */
/* ------------------------------------------------------------------ */

type CommandHandler = NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>;
export type CommandContext = Parameters<CommandHandler>[1];

type ToolExecute = NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>;
export type ToolContext = Parameters<ToolExecute>[4];

/* ------------------------------------------------------------------ */
/*  Agent / run types                                                  */
/* ------------------------------------------------------------------ */

export interface AgentDef {
	name: string;
	description: string;
	tools?: string;
	model?: string;
	systemPrompt: string;
}

export interface BackgroundRunSummary {
	runId: string;
	questId: string;
	workItemId: string;
	agentName: string;
	status: "running" | "completed" | "failed" | "cancelled" | "orphaned" | "paused";
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	exitCode?: number;
	pid?: number;
	model?: string;
	stdoutPath: string;
	stderrPath: string;
	reportPath: string;
	statusPath: string;
	/** Path to the Run Worktree where this run executed (ADR 011). */
	worktreePath?: string;
	/** Run Branch ref (e.g. `quest-run/<questId>/<runId>`). */
	runBranch?: string;
	/** Quest Branch this run targets (e.g. `quest/<questId>`). */
	questBranch?: string;
	/** ADR 014: when the supervisor SIGTERM'd this run on a pause-tier anomaly. */
	paused_at?: string;
	/** ADR 014: which pause-tier rule fired (e.g. `lockfile_drift`). */
	paused_reason?: "lockfile_drift" | "unbounded_diff" | "heartbeat_missed";
	/**
	 * ADR 017: when this run was spawned by Resume, the runId of its **immediate**
	 * predecessor (the just-paused Run). Multi-Resume chains follow this back
	 * one hop at a time, not back to the original.
	 */
	continues_from?: string;
}
