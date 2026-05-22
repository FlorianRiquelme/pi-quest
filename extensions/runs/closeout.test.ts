/**
 * Tests for the pure Batch Closeout decider (ADR 018, issue #15).
 *
 * Each branch of the decision tree is covered with mocked inputs only — no
 * filesystem, no side effects.
 */

import { describe, it, expect } from "vitest";
import { decideBatchCloseout } from "./closeout.js";
import type { BackgroundRunSummary, RunStatus } from "./types.js";

const EXT_START = "2026-05-22T10:00:00.000Z";
const AFTER = "2026-05-22T10:05:00.000Z";
const BEFORE = "2026-05-22T09:55:00.000Z";

function mkSummary(overrides: Partial<BackgroundRunSummary>): BackgroundRunSummary {
	return {
		runId: overrides.runId ?? "r1",
		questId: "q1",
		workItemId: overrides.workItemId ?? "001",
		agentName: "quest-implementation",
		status: (overrides.status ?? "completed") as RunStatus,
		startedAt: "2026-05-22T10:01:00.000Z",
		updatedAt: AFTER,
		completedAt: AFTER,
		stdoutPath: "/x",
		stderrPath: "/y",
		reportPath: `/reports/${overrides.workItemId ?? "001"}.md`,
		statusPath: `/runs/${overrides.runId ?? "r1"}.json`,
		batchId: "batch-1",
		batchSize: 2,
		...overrides,
	};
}

describe("decideBatchCloseout", () => {
	it("fires when all runs in batch are completed, in-session, not yet fired", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1", workItemId: "001" }),
				mkSummary({ runId: "r2", workItemId: "002" }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result.fire).toBe(true);
		if (!result.fire) return;
		expect(result.payload.batchId).toBe("batch-1");
		expect(result.payload.batchSize).toBe(2);
		expect(result.payload.runs).toHaveLength(2);
		expect(result.payload.runs.map((r) => r.runId).sort()).toEqual(["r1", "r2"]);
	});

	it("fires on mixed terminal statuses (paused + completed)", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1", workItemId: "001", status: "completed" }),
				mkSummary({ runId: "r2", workItemId: "002", status: "paused" }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result.fire).toBe(true);
	});

	it("returns size-not-met when a run is still running", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1", status: "completed" }),
				mkSummary({ runId: "r2", status: "running", completedAt: undefined }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result).toEqual({ fire: false, reason: "size-not-met" });
	});

	it("returns size-not-met when count < declared batchSize", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1", batchSize: 3 }),
				mkSummary({ runId: "r2", batchSize: 3 }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result).toEqual({ fire: false, reason: "size-not-met" });
	});

	it("returns size-not-met when batchSize is missing on summaries", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1", batchId: "batch-1", batchSize: undefined }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result).toEqual({ fire: false, reason: "size-not-met" });
	});

	it("returns already-fired when an event for the batch is in the existing list", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1" }),
				mkSummary({ runId: "r2" }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [{ batchId: "batch-1" }],
		});
		expect(result).toEqual({ fire: false, reason: "already-fired" });
	});

	it("returns cross-session when min(completedAt) < extensionStartTime", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1", completedAt: BEFORE }),
				mkSummary({ runId: "r2", completedAt: AFTER }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result).toEqual({ fire: false, reason: "cross-session" });
	});

	it("filters out summaries that belong to a different batchId", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1", batchId: "batch-1" }),
				mkSummary({ runId: "r2", batchId: "batch-1" }),
				mkSummary({ runId: "rZ", batchId: "batch-99", status: "running" }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result.fire).toBe(true);
	});

	it("returns size-not-met when no summaries match batchId", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [mkSummary({ batchId: "batch-99" })],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result).toEqual({ fire: false, reason: "size-not-met" });
	});

	it("already-fired short-circuits even when other gates would fail", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1", status: "running", completedAt: undefined }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [{ batchId: "batch-1" }],
		});
		expect(result).toEqual({ fire: false, reason: "already-fired" });
	});

	it("treats orphaned as terminal (sealed at session_start by reaper)", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [
				mkSummary({ runId: "r1", status: "completed" }),
				mkSummary({ runId: "r2", status: "orphaned" }),
			],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result.fire).toBe(true);
	});

	it("fires for a single-Run Batch (batchSize=1)", () => {
		const result = decideBatchCloseout({
			knownRunSummaries: [mkSummary({ runId: "r1", batchSize: 1 })],
			batchId: "batch-1",
			extensionStartTime: EXT_START,
			existingCloseoutEvents: [],
		});
		expect(result.fire).toBe(true);
		if (!result.fire) return;
		expect(result.payload.batchSize).toBe(1);
		expect(result.payload.runs).toHaveLength(1);
	});
});
