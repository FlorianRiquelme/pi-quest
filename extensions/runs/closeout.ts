/**
 * Batch Closeout decider (ADR 018).
 *
 * Pure function: takes the known on-disk summaries, the `batchId` under
 * consideration, the extension's session start timestamp, and the pre-scanned
 * list of existing `batch_closeout` events. Returns either a `fire` decision
 * (with the payload to deliver) or a "why not" reason.
 *
 * No filesystem, no side effects — the watcher side-effect wrapper
 * (`tryFireCloseout`, slice 5) is responsible for reading state and writing
 * events.
 */

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
