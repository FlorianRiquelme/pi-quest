/**
 * Tool execute logic and render helpers for pi-quest tools.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isValidTransition, QuestStatus } from "../lib.js";
import { fireUatDoorbell } from "./commands.js";
import { MAX_SUBAGENT_CAPTURE_CHARS } from "./fs-utils.js";
import { ensureDir } from "./fs-utils.js";
import { questDirPath } from "./paths.js";
import { loadQuestWorkflow, saveQuestWorkflow } from "./state.js";
import {
	__lastBeatAtForTests,
	activeRuns,
	compactRunLine,
	listRunSummaries,
	PROGRESS_BEAT_RATE_LIMIT_MS,
	recordSemanticBeat,
	runSubagent,
	startSubagentRun,
} from "./agents.js";
import { validateEvent } from "./events.js";
import type { BackgroundRunSummary, ToolContext } from "./types.js";

/* ================================ Theme helpers ================================ */

interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface RenderContext {
	lastComponent?: unknown;
}

/* ================================ quest_run_work_item ================================ */

export interface QuestRunWorkItemParams {
	questId: string;
	workItemId: string;
	optionalModel?: string;
}

export async function executeQuestRunWorkItem(
	params: QuestRunWorkItemParams,
	ctx: ToolContext,
) {
	const questDir = questDirPath(ctx.cwd, params.questId);
	if (!fs.existsSync(questDir)) {
		return {
			content: [{ type: "text" as const, text: `Quest '${params.questId}' not found.` }],
			isError: true,
			details: {},
		};
	}

	const workItemPath = path.join(questDir, "work-items", `${params.workItemId}.md`);
	if (!fs.existsSync(workItemPath)) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Work item '${params.workItemId}' not found at ${workItemPath}.`,
				},
			],
			isError: true,
			details: {},
		};
	}

	const task = [
		`Execute the work item: ${workItemPath}`,
		`The quest workspace is: ${questDir}`,
		`Read the work-item file, then read RESOLVED_HANDOFF.md and RECON.md as needed.`,
		`Implement the changes described. Run any verification commands.`,
		`Write your compact report to: ${path.join(questDir, "reports", `${params.workItemId}.md`)}`,
	].join("\n");

	const summary = await startSubagentRun({
		cwd: ctx.cwd,
		questId: params.questId,
		questDir,
		workItemId: params.workItemId,
		agentName: "quest-implementation",
		task,
		model: params.optionalModel,
		onStatus: (run) => {
			const active = activeRuns.size;
			ctx.ui.setStatus("quest", active > 0 ? `quest: ${active} work item(s) running` : undefined);
			if (run.status !== "running") {
				ctx.ui.notify(
					`Quest work item ${run.workItemId} ${run.status} (${run.runId})`,
					run.status === "completed" ? "info" : "warning",
				);
			}
		},
	});

	return {
		content: [
			{
				type: "text" as const,
				text:
					`Started work item ${params.workItemId} in the background.\n` +
					`Run: ${summary.runId}\n` +
					`Status: ${summary.statusPath}\n` +
					`Report: ${summary.reportPath}\n` +
					`Stdout: ${summary.stdoutPath}\n` +
					`Stderr: ${summary.stderrPath}\n\n` +
					`This run is asynchronous. Return the run ID to the user for later follow-up; do not block the conversation by polling unless explicitly asked.`,
			},
		],
		details: summary,
	};
}

export function renderCallQuestRunWorkItem(
	args: Partial<QuestRunWorkItemParams>,
	theme: Theme,
	context: RenderContext,
) {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(
		theme.fg("toolTitle", theme.bold("quest_run_work_item ")) +
			theme.fg("accent", args.workItemId ?? "?") +
			theme.fg("dim", ` in ${args.questId ?? "?"}`) +
			(args.optionalModel ? theme.fg("muted", ` via ${args.optionalModel}`) : ""),
	);
	return text;
}

export function renderResultQuestRunWorkItem(
	result: { isError?: boolean; content?: Array<{ text?: string } | unknown>; details?: unknown },
	theme: Theme,
	context: RenderContext,
) {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const details = result.details as BackgroundRunSummary | undefined;
	if (!details?.runId) {
		const firstContent = result.content?.[0];
	const firstText =
		typeof firstContent === "object" && firstContent !== null && "text" in firstContent
			? (firstContent as { text?: string }).text
			: "";
	text.setText(theme.fg(result.isError ? "error" : "toolOutput", firstText ?? ""));
		return text;
	}
	text.setText(
		theme.fg("success", "↗ started background implementation agent") +
			"\n" +
			theme.fg("accent", `run ${details.runId}`) +
			theme.fg("muted", ` • status ${details.status}`) +
			"\n" +
			theme.fg("dim", `status file: ${details.statusPath}`) +
			"\n" +
			theme.fg("dim", `report: ${details.reportPath}`),
	);
	return text;
}

/* ================================ quest_work_item_status ================================ */

export interface QuestWorkItemStatusParams {
	questId: string;
	runId?: string;
	workItemId?: string;
}

export async function executeQuestWorkItemStatus(
	params: QuestWorkItemStatusParams,
	ctx: ToolContext,
) {
	const questDir = questDirPath(ctx.cwd, params.questId);
	if (!fs.existsSync(questDir)) {
		return {
			content: [{ type: "text" as const, text: `Quest '${params.questId}' not found.` }],
			isError: true,
			details: {},
		};
	}

	let summaries = listRunSummaries(questDir);
	if (params.runId) summaries = summaries.filter((summary) => summary.runId === params.runId);
	if (params.workItemId)
		summaries = summaries.filter((summary) => summary.workItemId === params.workItemId);
	const selected = summaries.at(-1);
	if (!selected) {
		return {
			content: [{ type: "text" as const, text: "No matching Quest work-item run found." }],
			isError: true,
			details: { runs: [] },
		};
	}

	const reportExists = fs.existsSync(selected.reportPath);
	const reportTail = reportExists ? fs.readFileSync(selected.reportPath, "utf-8").slice(-4000) : "";
	return {
		content: [
			{
				type: "text" as const,
				text:
					compactRunLine(selected) +
					(reportExists ? `\n\nReport tail:\n${reportTail}` : "\n\nReport has not been written yet."),
			},
		],
		details: { run: selected, reportExists, reportTail },
		isError: selected.status === "failed" || selected.status === "cancelled",
	};
}

export function renderCallQuestWorkItemStatus(
	args: Partial<QuestWorkItemStatusParams>,
	theme: Theme,
	context: RenderContext,
) {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(
		theme.fg("toolTitle", theme.bold("quest_work_item_status ")) +
			theme.fg("accent", args.runId ?? args.workItemId ?? "latest") +
			theme.fg("dim", ` in ${args.questId ?? "?"}`),
	);
	return text;
}

export function renderResultQuestWorkItemStatus(
	result: { isError?: boolean; details?: unknown },
	theme: Theme,
	context: RenderContext,
) {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const run = (result.details as { run?: BackgroundRunSummary } | undefined)?.run;
	if (!run) {
		text.setText(theme.fg(result.isError ? "error" : "toolOutput", "No matching run."));
		return text;
	}
	const color: "success" | "warning" | "error" =
		run.status === "completed" ? "success" : run.status === "running" ? "warning" : "error";
	text.setText(
		theme.fg(color, `${run.status} ${run.runId}`) +
			(run.exitCode === undefined ? "" : theme.fg("muted", ` • exit ${run.exitCode}`)) +
			"\n" +
			theme.fg("dim", `report: ${run.reportPath}`),
	);
	return text;
}

/* ================================ quest_rescue ================================ */

export interface QuestRescueParams {
	questId: string;
	workItemId: string;
	blockerDescription: string;
	hypothesesTried?: string;
	diffSummary?: string;
	errorOutput?: string;
}

export async function executeQuestRescue(
	params: QuestRescueParams,
	ctx: ToolContext,
	signal?: AbortSignal,
) {
	const questDir = questDirPath(ctx.cwd, params.questId);
	if (!fs.existsSync(questDir)) {
		return {
			content: [{ type: "text" as const, text: `Quest '${params.questId}' not found.` }],
			isError: true,
			details: {},
		};
	}

	const task = [
		`You are performing a rescue review for quest '${params.questId}', work item '${params.workItemId}'.`,
		`Quest workspace: ${questDir}`,
		`Blocker: ${params.blockerDescription}`,
		params.hypothesesTried ? `Hypotheses tried:\n${params.hypothesesTried}` : "",
		params.diffSummary ? `Current diff summary:\n${params.diffSummary}` : "",
		params.errorOutput ? `Error output:\n${params.errorOutput}` : "",
		`Read the work-item file (${path.join(questDir, "work-items", `${params.workItemId}.md`)}) and the plan.`,
		`Provide a concise rescue report with: Diagnosis, Recommendation (continue/revert/pause/ask-user), Exact Next Steps, Plan Change Required (yes/no), User Input Required (yes/no).`,
	]
		.filter(Boolean)
		.join("\n");

	const result = await runSubagent({
		cwd: ctx.cwd,
		agentName: "quest-rescue",
		task,
		signal,
	});

	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	const event = validateEvent({
		event: "rescue_invoked",
		timestamp: new Date().toISOString(),
		questId: params.questId,
		agentRole: "rescue",
		workItemId: params.workItemId,
		status: result.exitCode === 0 ? "completed" : "failed",
	});
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");

	return {
		content: [
			{
				type: "text" as const,
				text:
					`Rescue review for ${params.workItemId} finished with exit code ${result.exitCode}.\n` +
					(result.stdoutTruncated || result.stderrTruncated
						? `Output capture was truncated to the last ${MAX_SUBAGENT_CAPTURE_CHARS} chars per stream.\n`
						: "") +
					"\n" +
					(result.stderr ? `Stderr:\n${result.stderr.slice(-2000)}\n\n` : "") +
					`Rescue output:\n${result.stdout.slice(-4000)}`,
			},
		],
		details: {
			exitCode: result.exitCode,
			questId: params.questId,
			workItemId: params.workItemId,
		},
	};
}

/* ================================ quest_write_workflow ================================ */

export interface QuestWriteWorkflowParams {
	questId: string;
	action: "read" | "set-status";
	status?: string;
	force?: boolean;
}

export async function executeQuestWriteWorkflow(
	params: QuestWriteWorkflowParams,
	ctx: ToolContext,
) {
	const questDir = questDirPath(ctx.cwd, params.questId);
	const workflow = loadQuestWorkflow(questDir);
	if (!workflow) {
		return {
			content: [{ type: "text" as const, text: `Quest '${params.questId}' not found.` }],
			isError: true,
			details: {},
		};
	}

	if (params.action === "read") {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(workflow, null, 2) }],
			details: { workflow },
		};
	}

	if (params.action === "set-status" && params.status) {
		if (!params.force && !isValidTransition(workflow.status, params.status as QuestStatus)) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Invalid transition: ${workflow.status} → ${params.status}. Use force=true to override.`,
					},
				],
				isError: true,
				details: { currentStatus: workflow.status, requestedStatus: params.status },
			};
		}

		// Harness-level gate: verification-ready requires VERIFICATION.md to exist
		if (params.status === "verification-ready") {
			const verificationPath = path.join(questDir, workflow.artifacts.verification ?? "VERIFICATION.md");
			if (!params.force && !fs.existsSync(verificationPath)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Gate check failed: ${workflow.artifacts.verification ?? "VERIFICATION.md"} not found. Run the Verification Agent before marking verification-ready, or use force=true to override.`,
						},
					],
					isError: true,
					details: { currentStatus: workflow.status, requestedStatus: params.status, missingArtifact: verificationPath },
				};
			}
		}

		const previousStatus = workflow.status;
		workflow.status = params.status as QuestStatus;
		workflow.updatedAt = new Date().toISOString();
		saveQuestWorkflow(questDir, workflow);
		// M4-2: UAT doorbell at the verification-ready → uat-ready boundary
		// (ADR 016). Widget mood shift is M3-1's responsibility — not here.
		fireUatDoorbell(ctx, workflow, questDir, previousStatus);
		return {
			content: [
				{
					type: "text" as const,
					text: `Status updated to '${params.status}' for quest '${params.questId}'.`,
				},
			],
			details: { workflow },
		};
	}

	return {
		content: [{ type: "text" as const, text: "Invalid action." }],
		isError: true,
		details: {},
	};
}

/* ================================ quest_telemetry_event ================================ */

/**
 * The tool accepts any object payload — `validateEvent` is the single source
 * of truth for whether the payload matches one of the nine ADR-010 variants.
 */
export type QuestTelemetryEventParams = {
	questId: string;
	event: string;
} & Record<string, unknown>;

export async function executeQuestTelemetryEvent(
	params: QuestTelemetryEventParams,
	ctx: ToolContext,
) {
	const questDir = questDirPath(ctx.cwd, params.questId);
	if (!fs.existsSync(questDir)) {
		return {
			content: [{ type: "text" as const, text: `Quest '${params.questId}' not found.` }],
			isError: true,
			details: {},
		};
	}

	const candidate = {
		timestamp: new Date().toISOString(),
		...params,
	};

	let event;
	try {
		event = validateEvent(candidate);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text" as const, text: `Rejected telemetry event: ${message}` }],
			isError: true,
			details: { rejected: candidate, reason: message },
		};
	}

	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");

	return {
		content: [{ type: "text" as const, text: "Telemetry event recorded." }],
		details: { event },
	};
}

/* ================================ quest_progress_beat ================================ */

/**
 * Explicit semantic progress beat (ADR 010 §3).
 *
 * Approach B for env propagation: the tool takes `questId` + `runId` as
 * required params. pi tool calls execute in the parent extension process, so
 * the subagent's own `PI_QUEST_*` env vars don't reach the parent's
 * `process.env`. The subagent reads its IDs from its own environment when
 * constructing the tool call and passes them in. Env vars are injected on
 * spawn (in `startSubagentRun`) for the subagent's prompt construction.
 *
 * Rate-limited to one beat per {@link PROGRESS_BEAT_RATE_LIMIT_MS} per runId.
 * Beats inside the window return success but are a no-op (no append, no rate
 * stamp update — the synthetic loop will fill the gap if needed).
 */
export interface QuestProgressBeatParams {
	questId: string;
	runId: string;
	phase: string;
	confidence?: number;
	note?: string;
}

export async function executeQuestProgressBeat(
	params: QuestProgressBeatParams,
	ctx: ToolContext,
) {
	const questDir = questDirPath(ctx.cwd, params.questId);
	if (!fs.existsSync(questDir)) {
		return {
			content: [{ type: "text" as const, text: `Quest '${params.questId}' not found.` }],
			isError: true,
			details: {},
		};
	}

	const nowMs = Date.now();
	const last = __lastBeatAtForTests.get(params.runId);
	if (last !== undefined && nowMs - last < PROGRESS_BEAT_RATE_LIMIT_MS) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Rate-limited: progress beat for run '${params.runId}' suppressed (last beat <${PROGRESS_BEAT_RATE_LIMIT_MS}ms ago).`,
				},
			],
			details: { rateLimited: true, runId: params.runId },
		};
	}

	const candidate: Record<string, unknown> = {
		event: "progress_beat",
		timestamp: new Date(nowMs).toISOString(),
		questId: params.questId,
		runId: params.runId,
		phase: params.phase,
	};
	if (params.confidence !== undefined) candidate.confidence = params.confidence;
	if (params.note !== undefined) candidate.note = params.note;

	let event;
	try {
		event = validateEvent(candidate);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text" as const, text: `Rejected progress beat: ${message}` }],
			isError: true,
			details: { rejected: candidate, reason: message },
		};
	}

	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
	recordSemanticBeat(params.runId, nowMs);

	return {
		content: [{ type: "text" as const, text: "Progress beat recorded." }],
		details: { event },
	};
}

/* ================================ quest_concession ================================ */

/**
 * Explicit concession event (ADR 010 §3). Approach B same as
 * `executeQuestProgressBeat`.
 *
 * Concessions are NOT rate-limited — every judgment call the agent makes
 * without asking should land in the Concession Ledger.
 */
export interface QuestConcessionParams {
	questId: string;
	runId: string;
	decision: string;
	rationale: string;
}

export async function executeQuestConcession(
	params: QuestConcessionParams,
	ctx: ToolContext,
) {
	const questDir = questDirPath(ctx.cwd, params.questId);
	if (!fs.existsSync(questDir)) {
		return {
			content: [{ type: "text" as const, text: `Quest '${params.questId}' not found.` }],
			isError: true,
			details: {},
		};
	}

	const candidate = {
		event: "concession" as const,
		timestamp: new Date().toISOString(),
		questId: params.questId,
		runId: params.runId,
		decision: params.decision,
		rationale: params.rationale,
	};

	let event;
	try {
		event = validateEvent(candidate);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text" as const, text: `Rejected concession: ${message}` }],
			isError: true,
			details: { rejected: candidate, reason: message },
		};
	}

	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");

	return {
		content: [{ type: "text" as const, text: "Concession recorded." }],
		details: { event },
	};
}
