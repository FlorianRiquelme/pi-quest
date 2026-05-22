/**
 * Tests for `quest_run_work_item` Batch surface (ADR 018, issue #15).
 *
 * - `validateBatchSizeConsistency`: pure happy + drift paths.
 * - Integration: a second `executeQuestRunWorkItem` call with same `batchId`
 *   but mismatched `batchSize` is rejected and emits a `batch_size_drift`
 *   halt-tier anomaly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fs, vol } from "memfs";
import type { BackgroundRunSummary } from "./runs/types.js";

vi.mock("node:fs", async () => {
	const { fs } = await import("memfs");
	return { default: fs, ...fs };
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

vi.mock("node:os", () => ({ tmpdir: () => "/tmp" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	withFileMutationQueue: async (_path: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("./runs/worktree.js", () => ({
	createRunWorktree: vi.fn().mockImplementation(async ({ questId, runId, repoRoot }: any) => ({
		worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
		runBranch: `quest-run/${questId}/${runId}`,
	})),
	removeRunWorktree: vi.fn().mockResolvedValue(undefined),
	listRunWorktrees: vi.fn().mockResolvedValue([]),
	mergeRunBranchIntoQuest: vi.fn().mockResolvedValue({ ok: true }),
	worktreePathFor: (repoRoot: string, questId: string, runId: string) =>
		`${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
}));

vi.mock("./paths.js", async () => {
	const actual = await vi.importActual<typeof import("./paths.js")>("./paths.js");
	return { ...actual, AGENTS_DIR: "/agents" };
});

import { executeQuestRunWorkItem, validateBatchSizeConsistency } from "./tools.js";

function baseSummary(overrides: Partial<BackgroundRunSummary> = {}): BackgroundRunSummary {
	return {
		runId: overrides.runId ?? "r1",
		questId: "q1",
		workItemId: overrides.workItemId ?? "001",
		agentName: "quest-implementation",
		status: "completed",
		startedAt: "2026-05-22T12:00:00.000Z",
		updatedAt: "2026-05-22T12:00:00.000Z",
		stdoutPath: "/x",
		stderrPath: "/y",
		reportPath: "/z",
		statusPath: "/project/.pi/quests/q1/runs/r1.json",
		...overrides,
	};
}

describe("validateBatchSizeConsistency", () => {
	it("returns ok when there are no existing summaries (first call wins)", () => {
		expect(validateBatchSizeConsistency([], 3)).toEqual({ ok: true });
	});

	it("returns ok when prior summaries agree on batchSize", () => {
		const prior = [
			baseSummary({ runId: "r1", batchId: "batch-1", batchSize: 3 }),
			baseSummary({ runId: "r2", batchId: "batch-1", batchSize: 3 }),
		];
		expect(validateBatchSizeConsistency(prior, 3)).toEqual({ ok: true });
	});

	it("returns drift when a prior summary's batchSize differs", () => {
		const prior = [baseSummary({ runId: "r1", batchId: "batch-1", batchSize: 2 })];
		expect(validateBatchSizeConsistency(prior, 3)).toEqual({
			ok: false,
			declaredSize: 2,
		});
	});

	it("ignores prior summaries that have no batchSize (legacy unbatched)", () => {
		const prior = [baseSummary({ runId: "r1" })]; // no batchSize
		expect(validateBatchSizeConsistency(prior, 5)).toEqual({ ok: true });
	});
});

describe("executeQuestRunWorkItem — batch_size_drift integration", () => {
	beforeEach(() => {
		vol.reset();
		vi.clearAllMocks();
	});

	function mkCtx(cwd: string) {
		return {
			cwd,
			ui: {
				notify: vi.fn(),
				setStatus: vi.fn(),
			},
		} as unknown as Parameters<typeof executeQuestRunWorkItem>[1];
	}

	function seedQuest() {
		vol.mkdirSync("/project/.pi/quests/q1/work-items", { recursive: true });
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		vol.mkdirSync("/project/.pi/quests/q1/telemetry", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/work-items/001.md",
			"# work item 001",
		);
		vol.writeFileSync(
			"/project/.pi/quests/q1/work-items/002.md",
			"# work item 002",
		);
	}

	it("rejects a second call with mismatched batchSize and writes a batch_size_drift anomaly", async () => {
		seedQuest();
		// Pre-seed: an existing run for batch-1 declared batchSize=2.
		vol.writeFileSync(
			"/project/.pi/quests/q1/runs/r-prior.json",
			JSON.stringify(
				baseSummary({
					runId: "r-prior",
					workItemId: "001",
					batchId: "batch-1",
					batchSize: 2,
				}),
			),
		);

		const result = await executeQuestRunWorkItem(
			{
				questId: "q1",
				workItemId: "002",
				batchId: "batch-1",
				batchSize: 3, // mismatch!
			},
			mkCtx("/project"),
		);

		expect(result.isError).toBe(true);
		expect((result.details as any).reason).toBe("batch_size_drift");
		expect((result.details as any).declaredSize).toBe(2);
		expect((result.details as any).newCallSize).toBe(3);

		// Anomaly event landed.
		const jsonl = vol.readFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			"utf-8",
		) as string;
		const events = jsonl.trim().split("\n").map((l) => JSON.parse(l));
		const anomaly = events.find((e) => e.event === "anomaly_detected");
		expect(anomaly).toBeDefined();
		expect(anomaly.rule).toBe("batch_size_drift");
		expect(anomaly.tier).toBe("halt");
		expect(anomaly.details.batchId).toBe("batch-1");
	});

	it("rejects when batchSize is < 1", async () => {
		seedQuest();
		const result = await executeQuestRunWorkItem(
			{
				questId: "q1",
				workItemId: "001",
				batchId: "batch-1",
				batchSize: 0,
			},
			mkCtx("/project"),
		);
		expect(result.isError).toBe(true);
		expect((result.details as any).reason).toBe("invalid_batch_size");
	});
});
