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
	cmdBrief,
	cmdConfig,
	cmdDashboard,
	cmdIntake,
	cmdResume,
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
import { reapOrphanedRuns, reapOrphanWorktrees, startLivenessSupervisor } from "./runs/runner.js";
import { startAnomalyPoller } from "./runs/supervisor.js";
import { handleHardFreezeChord, handleSoftFreezeChord, isSoftFrozen } from "./freeze.js";
import type { FreezeContext } from "./freeze.js";
import { engageSkillFactory } from "./skill-engagement.js";
import { setQuestWidget } from "./ui/widget.js";

/**
 * Tokenize the `/quest` argument string into a positional array, respecting
 * single- and double-quoted strings so flag values like `--note "lockfile
 * drift is fine"` survive intact.
 *
 * Exported for unit tests.
 */
export function tokenizeQuestArgs(args: string): string[] {
	const tokens: string[] = [];
	const input = args.trim();
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === " " || ch === "\t" || ch === "\n") {
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			i++;
			let value = "";
			while (i < input.length && input[i] !== quote) {
				value += input[i];
				i++;
			}
			// Consume the closing quote (silently ignore unterminated quote).
			if (i < input.length) i++;
			tokens.push(value);
			continue;
		}
		// Plain token — read until whitespace.
		let value = "";
		while (i < input.length && input[i] !== " " && input[i] !== "\t" && input[i] !== "\n") {
			value += input[i];
			i++;
		}
		tokens.push(value);
	}
	return tokens;
}

export default function piQuestExtension(pi: ExtensionAPI) {
	// Bound once at registration so all stage-routing call sites engage skills
	// through the same pi instance (issue #4 / friction-elimination).
	const engageSkill = engageSkillFactory(pi);

	/* ================================ Commands ================================ */

	pi.registerCommand("quest", {
		description:
			"Quest execution engine. /quest [status|list|intake <handoff.md>|select <id>|set-status <id> <status>|brief|resume <runId> [--note \"...\"]|config|dashboard|freeze|unfreeze]",
		handler: async (args, ctx) => {
			// Resume's --note may carry spaces, so we tokenize while keeping
			// quoted strings together rather than naive split-on-whitespace.
			const parts = tokenizeQuestArgs(args);
			const subcommand = parts[0]?.toLowerCase() || "";

			switch (subcommand) {
				case "":
					// Auto-router (ADR 008): try to advance the active quest. If no
					// stage was advanced, fall back to the status display.
					if (!(await tryAutoRoute(ctx, engageSkill))) {
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
				case "brief":
					await cmdBrief(ctx);
					setQuestWidget(ctx);
					break;
				case "resume":
					await cmdResume(ctx, parts.slice(1));
					setQuestWidget(ctx);
					break;
				case "config":
					await cmdConfig(ctx);
					break;
				case "dashboard":
					await cmdDashboard(ctx);
					break;
				case "set-status":
					await cmdSetStatus(ctx, parts.slice(1), engageSkill);
					break;
				case "freeze":
					// Slash-command fallback alias for the Alt+P chord (ADR 013 §8).
					// Toggle semantics match the chord: invoking on a frozen quest
					// releases it. Same `freeze_engaged` / `freeze_released` audit
					// events are emitted.
					await handleSoftFreezeChord(ctx as FreezeContext);
					setQuestWidget(ctx);
					break;
				case "unfreeze":
					// Explicit release path. No-ops cleanly when no freeze is
					// active (the chord handler short-circuits without emitting
					// `freeze_released`).
					if (isSoftFrozen(ctx.cwd)) {
						await handleSoftFreezeChord(ctx as FreezeContext);
					}
					setQuestWidget(ctx);
					break;
				default:
					ctx.ui.notify(`Unknown quest subcommand: ${subcommand}`, "error");
					ctx.ui.notify(
						"Usage: /quest [status|list|intake <handoff.md>|select <id>|set-status <id> <status>|brief|resume <runId> [--note \"...\"]|config|dashboard|freeze|unfreeze]",
						"info",
					);
			}
		},
	});

	/* ================================ Shortcuts ================================ */

	// `ctrl+shift+g` opens the dashboard. The two freeze chords come from
	// ADR 013 §8. Soft freeze originally lived on `ctrl+p`, but pi v0.75 added
	// a built-in model-switch chord that claims `ctrl+p` and silently drops
	// extension registrations for it at startup (`Extension shortcut 'ctrl+p'
	// ... conflicts with built-in shortcut. Skipping.`). Rotated to `alt+p` to
	// preserve the single-key freeze property that ADR 013 calls Asymmetric
	// Interrupt Cost. Hard freeze stays on `ctrl+shift+p` — no collision.
	// `/quest freeze` and `/quest unfreeze` slash commands are a fallback alias
	// for terminals that can't bind Alt-chords.
	pi.registerShortcut("ctrl+shift+g", {
		description: "Open quest dashboard",
		handler: async (ctx) => {
			const { openDashboard } = await import("./ui/dashboard-opener.js");
			await openDashboard(ctx);
		},
	});

	pi.registerShortcut("alt+p", {
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
		description:
			"Start an implementation subagent for a single Quest work item in the background. " +
			"Per ADR 018: every call must pass batchId (Orchestrator-assigned grouping ID, " +
			"same on every call in the Batch) and batchSize (the total Run count the " +
			"Orchestrator commits to launching for that batchId). For a single Run, use " +
			"a unique batchId and batchSize=1.",
		promptSnippet:
			"Start a quest work item implementation subagent without blocking the orchestrator. Pass batchId + batchSize for every call (ADR 018 Batch Closeout).",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			workItemId: Type.String({ description: "Work item ID, e.g. 001" }),
			batchId: Type.String({
				description:
					"Orchestrator-assigned Batch grouping ID. Same on every call in the Batch (e.g. `batch-<questId>-<timestamp>`).",
			}),
			batchSize: Type.Integer({
				minimum: 1,
				description: "Total Run count the Orchestrator commits to launching for this batchId (≥ 1).",
			}),
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
			return executeQuestWriteWorkflow(params, ctx, engageSkill);
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
		// ADR 014 (amended 2026-05-22): start the 30s anomaly poller for the two
		// remaining pause-tier rules — `unbounded_diff`, `heartbeat_missed` — plus
		// the log-only `locked_out_write` rule. The interval unrefs itself so it
		// doesn't keep pi alive.
		startAnomalyPoller(ctx.cwd);
		setQuestWidget(ctx);
	});
}
