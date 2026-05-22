/**
 * Batch Closeout decider (ADR 018).
 *
 * Pure function `decideBatchCloseout` takes the known on-disk summaries, the
 * `batchId` under consideration, the extension's session start timestamp, and
 * the pre-scanned list of existing `batch_closeout` events. Returns either a
 * `fire` decision (with the payload to deliver) or a "why not" reason.
 *
 * Side-effect wrapper `tryFireCloseout` (used by the in-process watcher) reads
 * filesystem state, calls the decider, sends the synthetic message, and
 * appends the audit event. The wrapper is the only path that touches I/O.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { validateEvent } from "../events.js";
import { ensureDir } from "../fs-utils.js";
import { listRunSummaries } from "./runner.js";
import type { BackgroundRunSummary, RunStatus } from "./types.js";

/** Statuses that mean a Run is no longer in flight. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
	"completed",
	"failed",
	"cancelled",
	"paused",
	"orphaned",
]);

export interface BatchCloseoutRunEntry {
	workItemId: string;
	runId: string;
	status: RunStatus;
	reportPath: string;
	/** Optional, populated by the watcher when an anomaly is associated. */
	anomalyTier?: string;
	anomalyRule?: string;
	lastBeatPhase?: string;
}

export interface BatchCloseoutPayload {
	questId: string;
	batchId: string;
	batchSize: number;
	runs: BatchCloseoutRunEntry[];
}

export interface DecideBatchCloseoutInput {
	knownRunSummaries: BackgroundRunSummary[];
	batchId: string;
	/** ISO 8601 — recorded at extension `session_start`. */
	extensionStartTime: string;
	/** Pre-scanned `batch_closeout` events from `telemetry/events.jsonl`. */
	existingCloseoutEvents: Array<{ batchId: string }>;
}

export type DecideBatchCloseoutResult =
	| { fire: true; payload: BatchCloseoutPayload }
	| { fire: false; reason: "size-not-met" | "cross-session" | "already-fired" };

/**
 * Decide whether to fire a Closeout for `batchId`.
 *
 * Gates (in order, short-circuiting on the first failure):
 *
 *   1. Already fired (durable dedupe by `events.jsonl` scan) → `already-fired`.
 *      Checked first so a re-fire attempt during the same session is cheap.
 *   2. Filter summaries to those whose `batchId` matches.
 *   3. Counted-invariant: every filtered summary must be terminal, and the
 *      count must equal `batchSize` (read from any summary in the batch).
 *      Otherwise → `size-not-met`.
 *   4. Cross-session gate: `min(completedAt)` across the batch must be ≥
 *      `extensionStartTime`. Otherwise → `cross-session` — the Homecoming
 *      Brief (ADR 015) owns that narrative.
 *
 * On `fire: true`, the payload carries every Run's identity, status, and
 * report path for the Orchestrator to read.
 */
export function decideBatchCloseout(
	input: DecideBatchCloseoutInput,
): DecideBatchCloseoutResult {
	if (input.existingCloseoutEvents.some((e) => e.batchId === input.batchId)) {
		return { fire: false, reason: "already-fired" };
	}

	const inBatch = input.knownRunSummaries.filter((s) => s.batchId === input.batchId);
	if (inBatch.length === 0) {
		return { fire: false, reason: "size-not-met" };
	}

	// `batchSize` is the same on every summary in the batch (the
	// validator at tool boundary enforces it). Pull from the first one.
	const declared = inBatch[0].batchSize;
	if (typeof declared !== "number" || declared < 1) {
		// Defensive: a summary in the batch is missing the declared size.
		// Treat as not-yet-ready rather than fire with bad data.
		return { fire: false, reason: "size-not-met" };
	}

	const allTerminal = inBatch.every((s) => TERMINAL_STATUSES.has(s.status));
	if (!allTerminal || inBatch.length !== declared) {
		return { fire: false, reason: "size-not-met" };
	}

	// Cross-session gate.
	const completedAts = inBatch
		.map((s) => s.completedAt)
		.filter((t): t is string => typeof t === "string");
	if (completedAts.length === 0) {
		// Terminal but no completedAt anywhere — degenerate; defer to
		// Homecoming Brief by treating as cross-session.
		return { fire: false, reason: "cross-session" };
	}
	const minCompletedAt = completedAts.slice().sort()[0];
	if (minCompletedAt < input.extensionStartTime) {
		return { fire: false, reason: "cross-session" };
	}

	const payload: BatchCloseoutPayload = {
		questId: inBatch[0].questId,
		batchId: input.batchId,
		batchSize: declared,
		runs: inBatch.map((s) => ({
			workItemId: s.workItemId,
			runId: s.runId,
			status: s.status,
			reportPath: s.reportPath,
		})),
	};
	return { fire: true, payload };
}

/* ================================ Side-effect wrapper ================================ */

/**
 * Read existing `batch_closeout` events from a quest's `telemetry/events.jsonl`.
 * Best-effort — returns `[]` if the file does not exist or contains corrupt
 * lines. Each result carries the minimal `{ batchId }` shape the pure decider
 * consumes; richer fields are ignored.
 */
function readExistingCloseoutEvents(questDir: string): Array<{ batchId: string }> {
	const eventsPath = path.join(questDir, "telemetry", "events.jsonl");
	if (!fs.existsSync(eventsPath)) return [];
	const raw = fs.readFileSync(eventsPath, "utf-8");
	const out: Array<{ batchId: string }> = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const ev = JSON.parse(t) as { event?: string; batchId?: string };
			if (ev.event === "batch_closeout" && typeof ev.batchId === "string") {
				out.push({ batchId: ev.batchId });
			}
		} catch {
			/* skip corrupt */
		}
	}
	return out;
}

export interface TryFireCloseoutInput {
	cwd: string;
	questId: string;
	batchId: string;
	pi: Pick<ExtensionAPI, "sendMessage">;
	extensionStartTime: string;
	firedInProcess: Set<string>;
}

/**
 * Attempt to fire a Batch Closeout for `batchId`.
 *
 * Flow:
 *   1. In-memory short-circuit if `firedInProcess.has(batchId)`.
 *   2. Read all summaries for the quest, scan existing `batch_closeout` events.
 *   3. Call `decideBatchCloseout` (pure).
 *   4. On `fire: true`: invoke `pi.sendMessage({ customType: "quest-batch-
 *      closeout", display: false, ... }, { triggerTurn: true })`. Wrap in a
 *      try/catch so a delivery failure still lands the audit event with
 *      `delivered: false`.
 *   5. Append a `batch_closeout` event via `validateEvent` + appendFileSync.
 *   6. Add `batchId` to `firedInProcess` (durable dedupe via events.jsonl is
 *      checked at step 3; the Set is the within-process fast path against
 *      fs.watch double-fires).
 *
 * No-op on `fire: false`. Never throws; all errors are swallowed.
 */
export async function tryFireCloseout(input: TryFireCloseoutInput): Promise<void> {
	const { cwd, questId, batchId, pi, extensionStartTime, firedInProcess } = input;
	if (firedInProcess.has(batchId)) return;

	const questDir = path.join(cwd, ".pi", "quests", questId);
	if (!fs.existsSync(questDir)) return;

	const summaries = listRunSummaries(questDir);
	const existingCloseoutEvents = readExistingCloseoutEvents(questDir);

	const decision = decideBatchCloseout({
		knownRunSummaries: summaries,
		batchId,
		extensionStartTime,
		existingCloseoutEvents,
	});
	if (!decision.fire) return;

	const payload = decision.payload;
	const statuses: Record<string, RunStatus> = {};
	for (const r of payload.runs) statuses[r.runId] = r.status;

	// Per ADR 018: send the hidden synthetic message that re-engages the
	// Orchestrator. `display: false` keeps the chat history quiet (story 4);
	// `triggerTurn: true` is what makes pi take another turn (story 1).
	let delivered = true;
	try {
		pi.sendMessage(
			{
				customType: "quest-batch-closeout",
				display: false,
				content: JSON.stringify(payload),
				details: payload,
			},
			{ triggerTurn: true },
		);
	} catch {
		delivered = false;
	}

	// Append the durable audit event regardless of delivery.
	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	const event = validateEvent({
		event: "batch_closeout",
		timestamp: new Date().toISOString(),
		questId,
		batchId,
		batchSize: payload.batchSize,
		runIds: payload.runs.map((r) => r.runId),
		statuses,
		delivered,
	});
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");

	firedInProcess.add(batchId);
}
