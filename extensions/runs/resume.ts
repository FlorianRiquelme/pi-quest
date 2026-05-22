/**
 * Resume mechanic for Paused Runs (M4-4, ADR 017).
 *
 * Resume creates a **new Run** with a fresh `runId` and `status: "running"`,
 * gaining a `continues_from: <paused_runId>` reference. The new Run executes
 * in the **same worktree** as the paused Run and on the **same Run Branch**
 * — commits append linearly so the standard merge into the Quest Branch
 * (ADR 011 §4) just works on completion.
 *
 * The paused Run's `runs/<paused_runId>.json` is treated as immutable audit
 * record. Multi-Resume chains follow `continues_from` one hop at a time
 * (always pointing at the immediate predecessor).
 *
 * Two exports:
 *   - {@link composeContinuationPacket} — pure 5-section template. Tests pass
 *     all inputs (including git-derived ones) explicitly so they never touch
 *     real git.
 *   - {@link resumeRun} — orchestrator: reads the paused run, computes the
 *     packet, writes the new run's JSON, spawns the subagent, emits the two
 *     audit events.
 */

import { spawn as defaultSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { generateTimestampId } from "../../lib.js";
import {
	getAgentDef,
	normalizeModel,
	writePromptToTempFile,
	writeRunSummary,
} from "./runner.js";
import { validateEvent } from "../events.js";
import { ensureDir, getPiInvocation, readJsonIfExists } from "../fs-utils.js";
import type { BackgroundRunSummary } from "./types.js";

/* ================================ Continuation packet ================================ */

export interface ContinuationBeat {
	timestamp: string;
	phase: string;
	note?: string;
}

export interface ContinuationPacketInput {
	questId: string;
	workItemId: string;
	pausedRunId: string;
	newRunId: string;
	/**
	 * 1-indexed "resumption # for this chain". A paused run that has never
	 * been resumed before yields chainLength `1`; a paused run with one prior
	 * `continues_from` link yields `2`; and so on.
	 */
	chainLength: number;
	pausedAt: string | undefined;
	pausedReason: string | undefined;
	anomalyDetails: Record<string, unknown> | undefined;
	acknowledgment: string;
	/** At most five entries (caller is responsible for slicing). */
	lastFiveBeats: ContinuationBeat[];
	lastReportContent: string | undefined;
	runBranch: string | undefined;
	lastCommit: string | undefined;
	diffShortstat: string | undefined;
	untrackedFiles: string[];
}

/** Acknowledgment fallback when the user passes an empty (or whitespace-only) note. */
export const EMPTY_ACK_FALLBACK = "User chose to resume without comment";

/**
 * Build the 5-section continuation packet prepended to the resumed subagent's
 * task prompt. Pure — every variable input is on `input`, so tests can drive
 * every branch without touching git, the filesystem, or environment.
 */
export function composeContinuationPacket(input: ContinuationPacketInput): string {
	const ack = input.acknowledgment.trim() ? input.acknowledgment.trim() : EMPTY_ACK_FALLBACK;
	const beats = input.lastFiveBeats.slice(-5);

	const lines: string[] = [];

	lines.push(`## Continuation — resuming paused run ${input.pausedRunId}`);
	lines.push("");

	// 1. Identity
	lines.push("### 1. Identity");
	lines.push(`- Quest: ${input.questId}`);
	lines.push(`- Work-item: ${input.workItemId}`);
	lines.push(`- Paused run: ${input.pausedRunId}`);
	lines.push(`- New run (this one): ${input.newRunId}`);
	lines.push(`- This is resumption #${input.chainLength}`);
	lines.push("");

	// 2. Anomaly + acknowledgment
	lines.push("### 2. Anomaly + user acknowledgment");
	const ruleLabel = input.pausedReason ?? "unknown";
	const pausedAtLabel = input.pausedAt ?? "unknown";
	lines.push(`The paused run halted with anomaly \`${ruleLabel}\` at ${pausedAtLabel}.`);
	if (input.anomalyDetails && Object.keys(input.anomalyDetails).length > 0) {
		lines.push(`Details: ${JSON.stringify(input.anomalyDetails)}`);
	}
	lines.push("The user acknowledged this and asked you to continue with:");
	lines.push("");
	lines.push(`> ${ack}`);
	lines.push("");

	// 3. Last 5 progress beats
	lines.push("### 3. Last 5 progress beats");
	if (beats.length === 0) {
		lines.push("_No semantic beats recorded._");
	} else {
		for (const b of beats) {
			const note = b.note ? ` ${b.note}` : "";
			lines.push(`- ${b.timestamp} [${b.phase}]${note}`);
		}
	}
	lines.push("");

	// 4. Last report content
	lines.push("### 4. Last report content");
	const trimmedReport = input.lastReportContent?.trim();
	lines.push(trimmedReport && trimmedReport.length > 0 ? trimmedReport : "_No report yet._");
	lines.push("");

	// 5. Current worktree state
	lines.push("### 5. Current worktree state");
	lines.push(`- Branch: ${input.runBranch ?? "(unknown)"}`);
	lines.push(`- Last commit: ${input.lastCommit ?? "(unknown)"}`);
	lines.push(`- Diff summary: ${input.diffShortstat?.trim() ?? "(unknown)"}`);
	const untracked = input.untrackedFiles.length > 0 ? input.untrackedFiles.join(", ") : "(none)";
	lines.push(`- Untracked files: ${untracked}`);

	return lines.join("\n");
}

/* ================================ Helpers ================================ */

/**
 * Walk the `continues_from` chain back from `summary`. Returns the number of
 * hops needed to reach a run with no `continues_from`. A paused run that was
 * never resumed has chainLength `1`; one prior link → `2`; etc.
 *
 * Defensive against missing intermediate run JSON: if a link is broken, the
 * walk stops and the partial count is returned.
 */
export function computeChainLength(
	runsDir: string,
	summary: BackgroundRunSummary,
): number {
	let count = 1;
	let current = summary;
	const seen = new Set<string>([current.runId]);
	while (current.continues_from) {
		const next = readJsonIfExists<BackgroundRunSummary>(
			path.join(runsDir, `${current.continues_from}.json`),
		);
		if (!next) break;
		if (seen.has(next.runId)) break; // cycle guard — should never happen
		seen.add(next.runId);
		count += 1;
		current = next;
	}
	return count;
}

/**
 * Read the last semantic + synthetic progress beats for a given run from the
 * quest's events.jsonl, oldest-first, capped at five. Best-effort — returns
 * `[]` if the log doesn't exist.
 */
export function readLastFiveBeats(
	telemetryPath: string,
	runId: string,
): ContinuationBeat[] {
	if (!fs.existsSync(telemetryPath)) return [];
	const lines = fs.readFileSync(telemetryPath, "utf-8").split("\n");
	const beats: ContinuationBeat[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		try {
			const ev = JSON.parse(t);
			if (ev.event === "progress_beat" && ev.runId === runId) {
				beats.push({
					timestamp: ev.timestamp,
					phase: ev.phase,
					note: ev.note,
				});
			}
		} catch {
			/* skip corrupt */
		}
	}
	return beats.slice(-5);
}

/**
 * Read the most recent `anomaly_detected` event for `runId` and return its
 * `details` slot. Returns `undefined` when no anomaly is recorded.
 */
export function readLastAnomalyDetails(
	telemetryPath: string,
	runId: string,
): Record<string, unknown> | undefined {
	if (!fs.existsSync(telemetryPath)) return undefined;
	const lines = fs.readFileSync(telemetryPath, "utf-8").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const t = lines[i].trim();
		if (!t) continue;
		try {
			const ev = JSON.parse(t);
			if (ev.event === "anomaly_detected" && ev.runId === runId) {
				return (ev.details ?? {}) as Record<string, unknown>;
			}
		} catch {
			/* skip */
		}
	}
	return undefined;
}

/* ================================ resumeRun ================================ */

export interface ResumeRunInput {
	cwd: string;
	questId: string;
	pausedRunId: string;
	acknowledgment: string;
	/** Test-only: override the spawn function. */
	spawnFn?: typeof defaultSpawn;
	/** Test-only: override `Date` for reproducible runIds / timestamps. */
	now?: () => Date;
	/**
	 * Test-only: read git state (last commit oneline, diff shortstat, untracked
	 * files) without invoking real git. Defaults to a no-op stub returning
	 * empty strings; production code overrides this via {@link resumeRun}
	 * caller wiring if needed.
	 */
	readWorktreeState?: (worktreePath: string) => Promise<{
		lastCommit: string | undefined;
		diffShortstat: string | undefined;
		untrackedFiles: string[];
	}>;
}

export interface ResumeRunResult {
	newRunId: string;
	worktreePath: string;
	runBranch: string;
	continuationPacket: string;
}

/**
 * Spawn a new Run that continues a Paused Run.
 *
 * Steps:
 *   1. Load the paused run's JSON. Throw if missing or not in `paused` status.
 *   2. Read the last anomaly + beats + report content for the packet.
 *   3. Generate a fresh runId, compose the continuation packet, persist a new
 *      `runs/<newRunId>.json` carrying `continues_from`.
 *   4. Spawn the subagent in the paused run's worktree with the packet
 *      prepended to its task prompt.
 *   5. Emit `run_resumed` then `run_started`.
 */
export async function resumeRun(input: ResumeRunInput): Promise<ResumeRunResult> {
	const now = input.now ?? (() => new Date());
	const spawn = input.spawnFn ?? defaultSpawn;
	const questDir = path.join(input.cwd, ".pi", "quests", input.questId);
	const runsDir = path.join(questDir, "runs");
	const pausedPath = path.join(runsDir, `${input.pausedRunId}.json`);

	const paused = readJsonIfExists<BackgroundRunSummary>(pausedPath);
	if (!paused) {
		throw new Error(`resumeRun: paused run ${input.pausedRunId} not found.`);
	}
	if (paused.status !== "paused") {
		throw new Error(
			`resumeRun: run ${input.pausedRunId} is not paused (status=${paused.status}).`,
		);
	}

	// Derive packet inputs from disk + the paused summary.
	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	const beats = readLastFiveBeats(telemetryPath, input.pausedRunId);
	const anomalyDetails = readLastAnomalyDetails(telemetryPath, input.pausedRunId);
	const reportContent =
		paused.reportPath && fs.existsSync(paused.reportPath)
			? fs.readFileSync(paused.reportPath, "utf-8")
			: undefined;
	const chainLength = computeChainLength(runsDir, paused);

	// Optional worktree probe (left as injectable so tests don't shell out).
	const probe = input.readWorktreeState
		? await input.readWorktreeState(paused.worktreePath ?? "")
		: { lastCommit: undefined, diffShortstat: undefined, untrackedFiles: [] as string[] };

	// New runId — same convention as startSubagentRun (workItemId-<timestampId>).
	const safeWorkItemId = paused.workItemId.replace(/[^a-zA-Z0-9_.-]+/g, "-");
	const newRunId = `${safeWorkItemId}-${generateTimestampId()}`;

	const continuationPacket = composeContinuationPacket({
		questId: input.questId,
		workItemId: paused.workItemId,
		pausedRunId: input.pausedRunId,
		newRunId,
		chainLength,
		pausedAt: paused.paused_at,
		pausedReason: paused.paused_reason,
		anomalyDetails,
		acknowledgment: input.acknowledgment,
		lastFiveBeats: beats,
		lastReportContent: reportContent,
		runBranch: paused.runBranch,
		lastCommit: probe.lastCommit,
		diffShortstat: probe.diffShortstat,
		untrackedFiles: probe.untrackedFiles,
	});

	// Build the new run's paths. Reuses the paused run's worktreePath and
	// runBranch — Resume executes in-place per ADR 017.
	const worktreePath = paused.worktreePath;
	if (!worktreePath) {
		throw new Error(
			`resumeRun: paused run ${input.pausedRunId} has no worktreePath — cannot resume.`,
		);
	}
	const runBranch = paused.runBranch ?? "";
	const stdoutPath = path.join(runsDir, `${newRunId}.stdout.log`);
	const stderrPath = path.join(runsDir, `${newRunId}.stderr.log`);
	const statusPath = path.join(runsDir, `${newRunId}.json`);

	// Resolve the subagent's prompt + model + tools from its agent def, same as
	// startSubagentRun (so the resumed run is wired identically apart from the
	// prepended packet).
	const agentDef = getAgentDef(paused.agentName);
	const basePrompt = agentDef?.systemPrompt ?? "";
	const model = normalizeModel(paused.model ?? agentDef?.model);
	const tools = agentDef?.tools ? agentDef.tools.split(/,\s*/) : undefined;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	if (basePrompt.trim()) {
		const tmp = await writePromptToTempFile(paused.agentName, basePrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
	}
	// The continuation packet is prepended to the task instruction so the
	// resumed agent sees it before any standard "Task:" framing.
	args.push(`${continuationPacket}\n\nTask: Continue the work for work-item ${paused.workItemId}.`);

	ensureDir(runsDir);
	ensureDir(path.dirname(telemetryPath));

	const startedAt = now().toISOString();
	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: worktreePath,
		shell: false,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_QUEST_QUEST_ID: input.questId,
			PI_QUEST_WORK_ITEM_ID: paused.workItemId,
			PI_QUEST_RUN_ID: newRunId,
			PI_QUEST_HOME: path.join(input.cwd, ".pi"),
		},
	}) as unknown as { pid?: number; unref?: () => void; stdout?: NodeJS.EventEmitter; stderr?: NodeJS.EventEmitter };
	proc.unref?.();

	// ADR 018 §Resume integration: synthesize a Batch-of-1 ID so the Closeout
	// watcher fires naturally when the resumed Run terminates. No special
	// casing in the runner — the standard `decideBatchCloseout` path serves
	// both Orchestrator-launched Batches and Resume.
	const newSummary: BackgroundRunSummary = {
		runId: newRunId,
		questId: input.questId,
		workItemId: paused.workItemId,
		agentName: paused.agentName,
		status: "running",
		startedAt,
		updatedAt: startedAt,
		pid: proc.pid,
		model: model ?? paused.model ?? "default",
		stdoutPath,
		stderrPath,
		reportPath: paused.reportPath,
		statusPath,
		worktreePath,
		runBranch,
		questBranch: paused.questBranch,
		continues_from: input.pausedRunId,
		batchId: `resume-${input.pausedRunId}`,
		batchSize: 1,
	};
	writeRunSummary(newSummary);

	// Pipe stdout/stderr to the new run's logs. Use any-cast so the test fakes
	// (EventEmitter) and real ChildProcess stream both satisfy the call.
	const stdoutHandler = (d: unknown) => {
		try {
			fs.appendFileSync(stdoutPath, d as Buffer);
		} catch {
			/* best-effort */
		}
	};
	const stderrHandler = (d: unknown) => {
		try {
			fs.appendFileSync(stderrPath, d as Buffer);
		} catch {
			/* best-effort */
		}
	};
	proc.stdout?.on("data", stdoutHandler);
	proc.stderr?.on("data", stderrHandler);

	// Best-effort cleanup of the temp prompt file when the process exits. We
	// piggyback on the `error`/`close` events of the EventEmitter shape.
	const procEvents = proc as unknown as NodeJS.EventEmitter;
	if (typeof procEvents.on === "function") {
		const cleanup = () => {
			if (tmpPromptPath) {
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			}
			if (tmpPromptDir) {
				try {
					fs.rmdirSync(tmpPromptDir);
				} catch {
					/* ignore */
				}
			}
		};
		procEvents.on("close", cleanup);
		procEvents.on("error", cleanup);
	}

	// Audit: run_resumed (with the acknowledgment as recorded) + run_started.
	const ackForEvent = input.acknowledgment.trim() ? input.acknowledgment.trim() : EMPTY_ACK_FALLBACK;
	const resumedEvent = validateEvent({
		event: "run_resumed",
		timestamp: startedAt,
		questId: input.questId,
		new_run_id: newRunId,
		continues_from: input.pausedRunId,
		acknowledgment: ackForEvent,
		details: {
			workItemId: paused.workItemId,
			resumption_number: chainLength,
		},
	});
	const startedEvent = validateEvent({
		event: "run_started",
		timestamp: startedAt,
		questId: input.questId,
		runId: newRunId,
		workItemId: paused.workItemId,
		details: {
			continues_from: input.pausedRunId,
			agentName: paused.agentName,
			model: model ?? paused.model ?? "default",
		},
	});
	fs.appendFileSync(
		telemetryPath,
		JSON.stringify(resumedEvent) + "\n" + JSON.stringify(startedEvent) + "\n",
		"utf-8",
	);

	return { newRunId, worktreePath, runBranch, continuationPacket };
}
