/**
 * Tests for Dashboard actions on Paused Runs (ADR 014 §4, M3-3).
 *
 * Resume is M4-4 — only Discard and Force-Complete are wired here.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fs, vol } from "memfs";
import { discardRun, forceCompleteRun, resumeRunAction } from "./dashboard-actions.js";
import type { BackgroundRunSummary } from "../types.js";

vi.mock("node:fs", async () => {
	const { fs } = await import("memfs");
	return { default: fs, ...fs };
});

vi.mock("../runs/worktree.js", () => ({
	removeRunWorktree: vi.fn().mockResolvedValue(undefined),
	mergeRunBranchIntoQuest: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../runs/resume.js", () => ({
	resumeRun: vi.fn().mockResolvedValue({
		newRunId: 'new-run-id',
		worktreePath: '/project/.pi/quests/q1/worktrees/r-paused',
		runBranch: 'quest-run/q1/r-paused',
		continuationPacket: '## Continuation',
	}),
}));

function seedPausedRun(): BackgroundRunSummary {
	const summary: BackgroundRunSummary = {
		runId: "r-paused",
		questId: "q1",
		workItemId: "001",
		agentName: "quest-implementation",
		status: "paused",
		startedAt: "2026-05-19T12:00:00.000Z",
		updatedAt: "2026-05-19T12:30:00.000Z",
		paused_at: "2026-05-19T12:30:00.000Z",
		paused_reason: "unbounded_diff",
		stdoutPath: "/x",
		stderrPath: "/y",
		reportPath: "/z",
		statusPath: "/project/.pi/quests/q1/runs/r-paused.json",
		worktreePath: "/project/.pi/quests/q1/worktrees/r-paused",
		runBranch: "quest-run/q1/r-paused",
		questBranch: "quest/q1",
	};
	vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
	vol.writeFileSync(
		"/project/.pi/quests/q1/runs/r-paused.json",
		JSON.stringify(summary),
	);
	return summary;
}

describe("discardRun", () => {
	beforeEach(async () => {
		vol.reset();
		const worktree = await import("../runs/worktree.js");
		(worktree.removeRunWorktree as any).mockClear().mockResolvedValue(undefined);
		(worktree.mergeRunBranchIntoQuest as any).mockClear();
	});

	it("removes the worktree and marks the run cancelled", async () => {
		seedPausedRun();
		const worktree = await import("../runs/worktree.js");
		await discardRun({ cwd: "/project", questId: "q1", runId: "r-paused" });

		expect(worktree.removeRunWorktree).toHaveBeenCalledWith(
			"/project/.pi/quests/q1/worktrees/r-paused",
		);
		expect(worktree.mergeRunBranchIntoQuest).not.toHaveBeenCalled();

		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r-paused.json", "utf-8") as string,
		);
		expect(updated.status).toBe("cancelled");
		expect(typeof updated.completedAt).toBe("string");
	});

	it("is a no-op when the run summary is missing", async () => {
		const worktree = await import("../runs/worktree.js");
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		await expect(
			discardRun({ cwd: "/project", questId: "q1", runId: "missing" }),
		).resolves.toBeUndefined();
		expect(worktree.removeRunWorktree).not.toHaveBeenCalled();
	});

	it("refuses to discard a non-paused run", async () => {
		const running: BackgroundRunSummary = {
			runId: "r-live",
			questId: "q1",
			workItemId: "001",
			agentName: "quest-implementation",
			status: "running",
			startedAt: "2026-05-19T12:00:00.000Z",
			updatedAt: "2026-05-19T12:00:00.000Z",
			stdoutPath: "/x",
			stderrPath: "/y",
			reportPath: "/z",
			statusPath: "/project/.pi/quests/q1/runs/r-live.json",
			worktreePath: "/project/.pi/quests/q1/worktrees/r-live",
		};
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/runs/r-live.json",
			JSON.stringify(running),
		);

		await expect(
			discardRun({ cwd: "/project", questId: "q1", runId: "r-live" }),
		).rejects.toThrow(/paused/i);
	});
});

describe("forceCompleteRun", () => {
	beforeEach(async () => {
		vol.reset();
		const worktree = await import("../runs/worktree.js");
		(worktree.removeRunWorktree as any).mockClear().mockResolvedValue(undefined);
		(worktree.mergeRunBranchIntoQuest as any).mockClear().mockResolvedValue({ ok: true });
	});

	it("merges the run branch and marks the run completed", async () => {
		seedPausedRun();
		const worktree = await import("../runs/worktree.js");

		await forceCompleteRun({ cwd: "/project", questId: "q1", runId: "r-paused" });

		expect(worktree.mergeRunBranchIntoQuest).toHaveBeenCalledWith({
			repoRoot: "/project",
			questBranch: "quest/q1",
			runBranch: "quest-run/q1/r-paused",
		});
		expect(worktree.removeRunWorktree).toHaveBeenCalledWith(
			"/project/.pi/quests/q1/worktrees/r-paused",
		);

		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r-paused.json", "utf-8") as string,
		);
		expect(updated.status).toBe("completed");
		expect(typeof updated.completedAt).toBe("string");
	});

	it("leaves the run status as paused on merge conflict and emits anomaly", async () => {
		seedPausedRun();
		const worktree = await import("../runs/worktree.js");
		(worktree.mergeRunBranchIntoQuest as any).mockResolvedValue({
			ok: false,
			conflict: "CONFLICT (content): src/a.ts",
		});

		await forceCompleteRun({ cwd: "/project", questId: "q1", runId: "r-paused" });

		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r-paused.json", "utf-8") as string,
		);
		// On conflict, the run stays paused (user keeps the option to discard).
		expect(updated.status).toBe("paused");
		// removeRunWorktree must NOT have been called — we still need it.
		expect(worktree.removeRunWorktree).not.toHaveBeenCalled();

		// A halt-tier merge_conflict anomaly is recorded.
		const jsonl = vol.readFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			"utf-8",
		) as string;
		const events = jsonl.trim().split("\n").map((l) => JSON.parse(l));
		const anomaly = events.find((e) => e.event === "anomaly_detected");
		expect(anomaly).toBeDefined();
		expect(anomaly.tier).toBe("halt");
		expect(anomaly.rule).toBe("merge_conflict");
	});

	it("refuses when run has no runBranch/questBranch", async () => {
		const noBranches: BackgroundRunSummary = {
			runId: "r-no-branch",
			questId: "q1",
			workItemId: "001",
			agentName: "quest-implementation",
			status: "paused",
			startedAt: "2026-05-19T12:00:00.000Z",
			updatedAt: "2026-05-19T12:30:00.000Z",
			paused_at: "2026-05-19T12:30:00.000Z",
			paused_reason: "unbounded_diff",
			stdoutPath: "/x",
			stderrPath: "/y",
			reportPath: "/z",
			statusPath: "/project/.pi/quests/q1/runs/r-no-branch.json",
		};
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/runs/r-no-branch.json",
			JSON.stringify(noBranches),
		);

		await expect(
			forceCompleteRun({ cwd: "/project", questId: "q1", runId: "r-no-branch" }),
		).rejects.toThrow(/runBranch|questBranch/i);
	});

	it("refuses when the run is not paused", async () => {
		const running: BackgroundRunSummary = {
			runId: "r-live",
			questId: "q1",
			workItemId: "001",
			agentName: "quest-implementation",
			status: "running",
			startedAt: "2026-05-19T12:00:00.000Z",
			updatedAt: "2026-05-19T12:00:00.000Z",
			stdoutPath: "/x",
			stderrPath: "/y",
			reportPath: "/z",
			statusPath: "/project/.pi/quests/q1/runs/r-live.json",
			runBranch: "quest-run/q1/r-live",
			questBranch: "quest/q1",
			worktreePath: "/project/.pi/quests/q1/worktrees/r-live",
		};
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/runs/r-live.json",
			JSON.stringify(running),
		);
		await expect(
			forceCompleteRun({ cwd: "/project", questId: "q1", runId: "r-live" }),
		).rejects.toThrow(/paused/i);
	});
});

/* ============================ resumeRunAction (M4-4) ============================ */

describe("resumeRunAction", () => {
	beforeEach(async () => {
		vol.reset();
		const resumeMod = await import("../runs/resume.js");
		(resumeMod.resumeRun as any).mockClear().mockResolvedValue({
			newRunId: 'new-run-id',
			worktreePath: '/project/.pi/quests/q1/worktrees/r-paused',
			runBranch: 'quest-run/q1/r-paused',
			continuationPacket: '## Continuation',
		});
	});

	it("calls resumeRun with the supplied acknowledgment", async () => {
		seedPausedRun();
		const resumeMod = await import("../runs/resume.js");
		await resumeRunAction({
			cwd: "/project",
			questId: "q1",
			runId: "r-paused",
			acknowledgment: "the lockfile drift is fine",
		});
		expect(resumeMod.resumeRun).toHaveBeenCalledWith({
			cwd: "/project",
			questId: "q1",
			pausedRunId: "r-paused",
			acknowledgment: "the lockfile drift is fine",
		});
	});

	it("passes an empty acknowledgment through unchanged (default text is applied inside resumeRun)", async () => {
		seedPausedRun();
		const resumeMod = await import("../runs/resume.js");
		await resumeRunAction({
			cwd: "/project",
			questId: "q1",
			runId: "r-paused",
			acknowledgment: "",
		});
		expect(resumeMod.resumeRun).toHaveBeenCalledWith({
			cwd: "/project",
			questId: "q1",
			pausedRunId: "r-paused",
			acknowledgment: "",
		});
	});

	it("refuses when the run is not paused", async () => {
		const running: BackgroundRunSummary = {
			runId: "r-live",
			questId: "q1",
			workItemId: "001",
			agentName: "quest-implementation",
			status: "running",
			startedAt: "2026-05-19T12:00:00.000Z",
			updatedAt: "2026-05-19T12:00:00.000Z",
			stdoutPath: "/x",
			stderrPath: "/y",
			reportPath: "/z",
			statusPath: "/project/.pi/quests/q1/runs/r-live.json",
		};
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/runs/r-live.json",
			JSON.stringify(running),
		);
		await expect(
			resumeRunAction({
				cwd: "/project",
				questId: "q1",
				runId: "r-live",
				acknowledgment: "go",
			}),
		).rejects.toThrow(/paused/i);
	});
});
