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
 * - Active quest widget above editor
 * - Interactive dashboard overlay (ctrl+shift+g or /quest dashboard)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { QUEST_EVENT_KINDS } from "./events.js";
import { getAllQuestIds } from "./state.js";
import {
	cmdConfig,
	cmdDashboard,
	cmdIntake,
	cmdSelect,
	cmdSetStatus,
	listQuests,
	showStatus,
	tryAutoRoute,
} from "./commands.js";
import {
	executeQuestConcession,
	executeQuestProgressBeat,
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
import { reapOrphanedRuns, reapOrphanWorktrees, startLivenessSupervisor } from "./agents.js";
import { startAnomalyPoller } from "./anomaly-poller.js";
import { handleHardFreezeChord, handleSoftFreezeChord } from "./freeze.js";
import { setQuestWidget } from "./ui/widget.js";

export default function piQuestExtension(pi: ExtensionAPI) {
	/* ================================ Commands ================================ */

	pi.registerCommand("quest", {
		description:
			"Quest execution engine. /quest [status|list|intake <handoff.md>|select <id>|set-status <id> <status>|config|dashboard]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";

			switch (subcommand) {
				case "":
					// Auto-router (ADR 008): try to advance the active quest. If no
					// stage was advanced, fall back to the status display.
					if (!(await tryAutoRoute(ctx))) {
						await showStatus(ctx);
					} else {
						setQuestWidget(ctx);
					}
					break;
				case "status":
					await showStatus(ctx);
					break;
				case "list":
					await listQuests(ctx);
					break;
				case "intake":
					await cmdIntake(ctx, parts.slice(1));
					setQuestWidget(ctx);
					break;
				case "select":
					await cmdSelect(ctx, parts.slice(1));
					setQuestWidget(ctx);
					break;
				case "config":
					await cmdConfig(ctx);
					break;
				case "dashboard":
					await cmdDashboard(ctx);
					break;
				case "set-status":
					await cmdSetStatus(ctx, parts.slice(1));
					break;
				default:
					ctx.ui.notify(`Unknown quest subcommand: ${subcommand}`, "error");
					ctx.ui.notify(
						"Usage: /quest [status|list|intake <handoff.md>|select <id>|set-status <id> <status>|config|dashboard]",
						"info",
					);
			}
		},
	});

	/* ================================ Shortcuts ================================ */

	// `ctrl+shift+g` opens the dashboard. The two freeze chords (`ctrl+p`,
	// `ctrl+shift+p`) come from ADR 013 §8. These chords were picked because
	// they do not collide with any pi-coding-agent editor binding documented in
	// `examples/`; if a future pi release reclaims them, the chord can be moved
	// here without touching the handler.
	pi.registerShortcut("ctrl+shift+g", {
		description: "Open quest dashboard",
		handler: async (ctx) => {
			const { openDashboard } = await import("./ui/dashboard-opener.js");
			await openDashboard(ctx);
		},
	});

	pi.registerShortcut("ctrl+p", {
		description: "Toggle quest soft freeze (block new run spawns)",
		handler: async (ctx) => {
			await handleSoftFreezeChord(ctx);
			setQuestWidget(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+p", {
		description: "Quest hard freeze — abort all running runs",
		handler: async (ctx) => {
			await handleHardFreezeChord(ctx);
			setQuestWidget(ctx);
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
		description:
			"Record one of the nine typed Quest events (ADR 010) to telemetry/events.jsonl. " +
			`Allowed event kinds: ${QUEST_EVENT_KINDS.join(", ")}.`,
		promptSnippet:
			"Append a typed Quest audit event (stage_entered, run_started, run_finished, run_orphaned, progress_beat, concession, anomaly_detected, launch_gate, rescue_invoked) to telemetry/events.jsonl",
		// Variant-specific top-level fields are typed loosely here so the schema
		// describes the surface area for tool-callers; `validateEvent` is the
		// runtime gate that rejects unknown kinds and shape mismatches.
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID." }),
			event: Type.String({
				description: `Event discriminator. Must be one of: ${QUEST_EVENT_KINDS.join(", ")}.`,
			}),
			runId: Type.Optional(Type.String()),
			workItemId: Type.Optional(Type.String()),
			from: Type.Optional(Type.String()),
			to: Type.Optional(Type.String()),
			phase: Type.Optional(Type.String()),
			confidence: Type.Optional(Type.Number()),
			note: Type.Optional(Type.String()),
			decision: Type.Optional(Type.String()),
			rationale: Type.Optional(Type.String()),
			tier: Type.Optional(Type.String()),
			rule: Type.Optional(Type.String()),
			should_pause: Type.Optional(Type.Boolean()),
			outcome: Type.Optional(Type.String()),
			reasons: Type.Optional(Type.Array(Type.String())),
			agentRole: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
			details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeQuestTelemetryEvent(params, ctx);
		},
	});

	pi.registerTool({
		name: "quest_progress_beat",
		label: "Quest Progress Beat",
		description:
			"Emit a semantic progress_beat event from inside a running subagent. " +
			"Rate-limited to 1 per 15s per run; later beats inside the window return success but are no-ops. " +
			"The parent supervisor emits a synthetic 'alive' beat every 60s when no semantic beat arrives, " +
			"so prefer one beat per phase change with a meaningful `phase` and optional `confidence`/`note`.",
		promptSnippet:
			"Emit a semantic Quest progress beat (rate-limited to 1 per 15s per run); pass questId, runId, phase",
		// Approach B (see executeQuestProgressBeat): questId and runId are required tool args.
		// The subagent reads them from PI_QUEST_QUEST_ID / PI_QUEST_RUN_ID env vars injected by startSubagentRun.
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID (from PI_QUEST_QUEST_ID)." }),
			runId: Type.String({ description: "Run ID (from PI_QUEST_RUN_ID)." }),
			phase: Type.String({
				description: 'Phase string, e.g. "implementing", "verifying", "reading-docs".',
			}),
			confidence: Type.Optional(
				Type.Number({ description: "Subjective confidence 0..1 (optional)." }),
			),
			note: Type.Optional(Type.String({ description: "Short free-text note (optional)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeQuestProgressBeat(params, ctx);
		},
	});

	pi.registerTool({
		name: "quest_concession",
		label: "Quest Concession",
		description:
			"Emit a concession event recording a judgment call the agent made without asking the user. " +
			"Not rate-limited — every concession should land in the Concession Ledger.",
		promptSnippet:
			"Emit a Quest concession (decision the agent made without asking the user); pass questId, runId, decision, rationale",
		// Approach B (see executeQuestConcession): questId and runId are required tool args.
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID (from PI_QUEST_QUEST_ID)." }),
			runId: Type.String({ description: "Run ID (from PI_QUEST_RUN_ID)." }),
			decision: Type.String({
				description: "What the agent decided (e.g. 'used existing helper instead of adding a dep').",
			}),
			rationale: Type.String({
				description: "Why the agent took this path without asking.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeQuestConcession(params, ctx);
		},
	});

	/* ================================ Live widget refresh ================================ */

	pi.on("tool_execution_end", async (event, ctx) => {
		if (
			event.toolName === "quest_run_work_item" ||
			event.toolName === "quest_rescue" ||
			event.toolName === "quest_work_item_status"
		) {
			setQuestWidget(ctx);
		}
	});

	/* ================================ Lifecycle ================================ */

	pi.on("session_start", async (_event, ctx) => {
		const ids = getAllQuestIds(ctx.cwd);
		for (const id of ids) {
			// side-effect: pre-load quest IDs into any future tracking structures
			void id;
		}
		// ADR 009: reconcile background runs lost across pi restarts.
		try {
			reapOrphanedRuns(ctx.cwd);
		} catch {
			/* never let reconciliation crash the session */
		}
		// ADR 011: prune orphan Run Worktrees alongside orphan runs. This is
		// fire-and-forget — git invocations are async and shouldn't block
		// `session_start`.
		void reapOrphanWorktrees(ctx.cwd).catch(() => {
			/* never let reconciliation crash the session */
		});
		// ADR 010 §3: start the 60s synthetic liveness loop. The interval
		// unrefs itself so it doesn't keep pi alive on its own.
		startLivenessSupervisor(ctx.cwd);
		// ADR 014: start the 30s anomaly poller (lockfile_drift, unbounded_diff,
		// heartbeat_missed pause-tier rules + log-only locked_out_write). The
		// interval unrefs itself so it doesn't keep pi alive.
		startAnomalyPoller(ctx.cwd);
		setQuestWidget(ctx);
	});
}
