/**
 * pi-quest extension
 *
 * Provides:
 * - /quest command for quest lifecycle management
 * - quest_run_work_item tool — start a background implementation subagent for a work item
 * - quest_work_item_status tool — inspect background work-item run status
 * - quest_rescue tool — spawn a rescue subagent for blocked work
 * - quest_write_workflow tool — update quest workflow status with transition safety
 * - quest_telemetry_event tool — record telemetry events
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { getAllQuestIds } from "./state.js";
import {
	cmdConfig,
	cmdIntake,
	cmdSelect,
	cmdSetStatus,
	listQuests,
	showStatus,
} from "./commands.js";
import {
	executeQuestRescue,
	executeQuestRunWorkItem,
	executeQuestTelemetryEvent,
	executeQuestWorkItemStatus,
	executeQuestWriteWorkflow,
	renderCallQuestRunWorkItem,
	renderCallQuestWorkItemStatus,
	renderResultQuestRunWorkItem,
	renderResultQuestWorkItemStatus,
} from "./tools.js";

export default function piQuestExtension(pi: ExtensionAPI) {
	/* ================================ Commands ================================ */

	pi.registerCommand("quest", {
		description:
			"Quest execution engine. /quest [status|list|intake <handoff.md>|select <id>|set-status <id> <status>|config]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";

			switch (subcommand) {
				case "":
				case "status":
					await showStatus(ctx);
					break;
				case "list":
					await listQuests(ctx);
					break;
				case "intake":
					await cmdIntake(ctx, parts.slice(1));
					break;
				case "select":
					await cmdSelect(ctx, parts.slice(1));
					break;
				case "config":
					await cmdConfig(ctx);
					break;
				case "set-status":
					await cmdSetStatus(ctx, parts.slice(1));
					break;
				default:
					ctx.ui.notify(`Unknown quest subcommand: ${subcommand}`, "error");
					ctx.ui.notify(
						"Usage: /quest [status|list|intake <handoff.md>|select <id>|set-status <id> <status>|config]",
						"info",
					);
			}
		},
	});

	/* ================================ Tools ================================ */

	pi.registerTool({
		name: "quest_run_work_item",
		label: "Run Quest Work Item",
		description: "Start an implementation subagent for a single Quest work item in the background.",
		promptSnippet: "Start a quest work item implementation subagent without blocking the orchestrator",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			workItemId: Type.String({ description: "Work item ID, e.g. 001" }),
			optionalModel: Type.Optional(Type.String({ description: "Override subagent model" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeQuestRunWorkItem(params, ctx);
		},
		renderCall(args, theme, context) {
			return renderCallQuestRunWorkItem(args, theme, context);
		},
		renderResult(result, _options, theme, context) {
			return renderResultQuestRunWorkItem(result, theme, context);
		},
	});

	pi.registerTool({
		name: "quest_work_item_status",
		label: "Quest Work Item Status",
		description:
			"Read background Quest work-item run status and report locations. For running items, do not poll repeatedly; return run IDs for later follow-up unless the user explicitly asks you to wait.",
		promptSnippet:
			"Check background quest work item implementation run status (avoid tight polling; return control unless explicitly asked to wait)",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			runId: Type.Optional(Type.String({ description: "Run ID returned by quest_run_work_item" })),
			workItemId: Type.Optional(
				Type.String({ description: "Work item ID; returns the latest run for that item" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeQuestWorkItemStatus(params, ctx);
		},
		renderCall(args, theme, context) {
			return renderCallQuestWorkItemStatus(args, theme, context);
		},
		renderResult(result, _options, theme, context) {
			return renderResultQuestWorkItemStatus(result, theme, context);
		},
	});

	pi.registerTool({
		name: "quest_rescue",
		label: "Quest Rescue",
		description: "Spawn a rescue subagent to diagnose a blocked quest work item.",
		promptSnippet: "Request a GPT-5.5-class rescue review for a blocked work item",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			workItemId: Type.String({ description: "Blocked work item ID" }),
			blockerDescription: Type.String({ description: "Description of the blocker" }),
			hypothesesTried: Type.Optional(Type.String({ description: "What was already tried" })),
			diffSummary: Type.Optional(Type.String({ description: "Summary of current diff" })),
			errorOutput: Type.Optional(Type.String({ description: "Failing command output" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeQuestRescue(params, ctx, signal);
		},
	});

	pi.registerTool({
		name: "quest_write_workflow",
		label: "Write Quest Workflow",
		description: "Read or update a quest's workflow.json with status transition safety.",
		promptSnippet: "Update quest workflow status safely with transition validation",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			action: StringEnum(["read", "set-status"] as const),
			status: Type.Optional(Type.String({ description: "New status (for set-status)" })),
			force: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeQuestWriteWorkflow(params, ctx);
		},
	});

	pi.registerTool({
		name: "quest_telemetry_event",
		label: "Quest Telemetry Event",
		description: "Record a telemetry event for a quest.",
		promptSnippet: "Log a structured telemetry event to the quest's telemetry/events.jsonl",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			event: Type.String({ description: "Event type" }),
			agentRole: Type.Optional(Type.String()),
			workItemId: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
			inputTokens: Type.Optional(Type.Number()),
			outputTokens: Type.Optional(Type.Number()),
			durationMs: Type.Optional(Type.Number()),
			status: Type.Optional(Type.String()),
			filesChanged: Type.Optional(Type.Array(Type.String())),
			commandsRun: Type.Optional(Type.Array(Type.String())),
			rescueUsed: Type.Optional(Type.Boolean()),
			details: Type.Optional(Type.Object({})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeQuestTelemetryEvent(params, ctx);
		},
	});

	/* ================================ Lifecycle ================================ */

	pi.on("session_start", async (_event, ctx) => {
		const ids = getAllQuestIds(ctx.cwd);
		for (const id of ids) {
			// side-effect: pre-load quest IDs into any future tracking structures
			void id;
		}
	});
}
