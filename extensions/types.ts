/**
 * Shared local types for the pi-quest extension.
 *
 * Run-lifecycle types (`BackgroundRunSummary`, `RunStatus`, `STATUS_RANK`) live
 * in `runs/types.ts` — see issue #15. They are re-exported here for callers
 * outside `runs/` that historically imported from `./types.js`.
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

export type { BackgroundRunSummary, RunStatus } from "./runs/types.js";
export { STATUS_RANK, shouldOverwriteStatus } from "./runs/types.js";
