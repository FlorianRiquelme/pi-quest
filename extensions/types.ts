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
	status: "running" | "completed" | "failed" | "cancelled";
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
}
