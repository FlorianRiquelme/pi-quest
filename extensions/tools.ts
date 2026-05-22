/**
 * Tool execute logic and render helpers for pi-quest tools.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { QuestStatus } from "../lib.js";
import { MAX_SUBAGENT_CAPTURE_CHARS } from "./fs-utils.js";
import { ensureDir } from "./fs-utils.js";
import { questDirPath } from "./paths.js";
import { loadQuestWorkflow } from "./state.js";
import {
	__lastBeatAtForTests,
	activeRuns,
	compactRunLine,
	listRunSummaries,
	PROGRESS_BEAT_RATE_LIMIT_MS,
	recordSemanticBeat,
	runSubagent,
	startSubagentRun,
} from "./runs/runner.js";
import { validateEvent } from "./events.js";
import { transitionStage } from "./stage-transition.js";
import type { EngageSkill } from "./skill-engagement.js";
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
	/** ADR 018: Orchestrator-assigned grouping ID for this Batch. */
	batchId: string;
	/** ADR 018: declared total Run count for this Batch (≥ 1). */
	batchSize: number;
	optionalModel?: string;
}

/**
 * Pure validator: given the existing summaries on disk for a `batchId`, check
 * that a new `quest_run_work_item` call's `batchSize` is consistent with the
 * earlier declarations in the same Batch.
 *
 * Returns `{ ok: true }` when:
 *   - No prior summaries (this is the first call in the Batch), OR
 *   - All prior summaries with a `batchSize` agree with the new one.
 *
 * Returns `{ ok: false, declaredSize }` otherwise — `declaredSize` is the
 * earliest contradicting value, so the caller can surface a useful error.
 */
export function validateBatchSizeConsistency(
	existingSummariesForBatchId: BackgroundRunSummary[],
	newCallBatchSize: number,
): { ok: true } | { ok: false; declaredSize: number } {
	for (const s of existingSummariesForBatchId) {
		if (typeof s.batchSize === "number" && s.batchSize !== newCallBatchSize) {
			return { ok: false, declaredSize: s.batchSize };
		}
	}
	return { ok: true };
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

	// ADR 018 §Tool surface: reject batch_size_drift before spawning. A second
	// call in the same Batch with a different `batchSize` means the
	// Orchestrator's state has drifted; surface a halt-tier anomaly and refuse.
	if (!Number.isInteger(params.batchSize) || params.batchSize < 1) {
		return {
			content: [
				{
					type: "text" as const,
					text: `batchSize must be a positive integer (got ${params.batchSize}).`,
				},
			],
			isError: true,
			details: { reason: "invalid_batch_size", batchSize: params.batchSize },
		};
	}
	const existing = listRunSummaries(questDir).filter((s) => s.batchId === params.batchId);
	const drift = validateBatchSizeConsistency(existing, params.batchSize);
	if (!drift.ok) {
		const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
		ensureDir(path.dirname(telemetryPath));
		const event = validateEvent({
			event: "anomaly_detected",
			timestamp: new Date().toISOString(),
			questId: params.questId,
			tier: "halt",
			rule: "batch_size_drift",
			should_pause: false,
			details: {
				batchId: params.batchId,
				declaredSize: drift.declaredSize,
				newCallSize: params.batchSize,
			},
		});
		fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
		return {
			content: [
				{
					type: "text" as const,
					text:
						`Batch '${params.batchId}' was declared with batchSize=${drift.declaredSize}; ` +
						`this call passed batchSize=${params.batchSize}. Refusing — fix the ` +
						`Orchestrator state before retrying.`,
				},
			],
			isError: true,
			details: {
				reason: "batch_size_drift",
				batchId: params.batchId,
				declaredSize: drift.declaredSize,
				newCallSize: params.batchSize,
			},
		};
	}

	const task = [
		`Execute the work item: ${workItemPath}`,
		`The quest workspace is: ${questDir}`,
		`Read the work-item file, then read RESOLVED_HANDOFF.md and RECON.md as needed.`,
		`Implement the changes described. Run any verification commands.`,
		`Write your compact report to: ${path.join(questDir, "reports", `${params.workItemId}.md`)}`,
	].join("\n");

	// Pull Quest Branch + Base SHA from workflow if they have already been
	// captured (ADR 011 §2 — captured on first entry to executing).
	const workflow = loadQuestWorkflow(questDir);
	const summary = await startSubagentRun({
		cwd: ctx.cwd,
		questId: params.questId,
		questDir,
		workItemId: params.workItemId,
		agentName: "quest-implementation",
		task,
		model: params.optionalModel,
		batchId: params.batchId,
		batchSize: params.batchSize,
		questBranch: workflow?.questBranch,
		baseSha: workflow?.baseSha,
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
	engageSkill?: EngageSkill,
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
		const result = await transitionStage(
			ctx,
			params.questId,
			params.status as QuestStatus,
			{ force: !!params.force },
			engageSkill,
		);
		if (result.outcome === "rejected") {
			const suffix = result.reason === "quest_not_found" ? "" : " Use force=true to override.";
			const text =
				result.reason === "invalid_transition"
					? `Invalid transition: ${workflow.status} → ${params.status}.${suffix}`
					: result.message + suffix;
			return {
				content: [{ type: "text" as const, text }],
				isError: true,
				details: { reason: result.reason, ...(result.details ?? {}) },
			};
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `Status updated to '${params.status}' for quest '${params.questId}'.`,
				},
			],
			details: { workflow: result.workflow },
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
