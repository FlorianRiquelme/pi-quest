/**
 * Tests for the per-run anomaly polling loop (ADR 014, M3-3).
 *
 * Three pause-tier rules: `lockfile_drift`, `unbounded_diff`, `heartbeat_missed`.
 * Plus log-only `locked_out_write` wired through the same poll.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fs, vol } from "memfs";
import {
	checkLockfileDrift,
	checkUnboundedDiff,
	checkHeartbeatMissed,
	parseShortStat,
	pauseRun,
	pollAnomaliesOnce,
	startAnomalyPoller,
	ANOMALY_POLL_INTERVAL_MS,
	HEARTBEAT_MISS_THRESHOLD_MS,
	UNBOUNDED_DIFF_FILES,
	UNBOUNDED_DIFF_LINES,
	LOCKFILE_NAMES,
} from "./anomaly-poller.js";
import type { BackgroundRunSummary } from "./types.js";

vi.mock("node:fs", async () => {
	const { fs } = await import("memfs");
	return { default: fs, ...fs };
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

vi.mock("./worktree.js", () => ({
	removeRunWorktree: vi.fn().mockResolvedValue(undefined),
	mergeRunBranchIntoQuest: vi.fn().mockResolvedValue({ ok: true }),
}));

/* ============================== parseShortStat ============================== */

describe("parseShortStat", () => {
	it("parses files+insertions+deletions", () => {
		expect(parseShortStat(" 3 files changed, 100 insertions(+), 20 deletions(-)")).toEqual({
			filesChanged: 3,
			totalLines: 120,
		});
	});

	it("handles single-file shortstat", () => {
		expect(parseShortStat(" 1 file changed, 5 insertions(+)")).toEqual({
			filesChanged: 1,
			totalLines: 5,
		});
	});

	it("handles deletions-only", () => {
		expect(parseShortStat(" 2 files changed, 10 deletions(-)")).toEqual({
			filesChanged: 2,
			totalLines: 10,
		});
	});

	it("returns zeros on empty/missing input", () => {
		expect(parseShortStat("")).toEqual({ filesChanged: 0, totalLines: 0 });
		expect(parseShortStat("   ")).toEqual({ filesChanged: 0, totalLines: 0 });
	});
});

/* ============================== checkLockfileDrift ============================== */

describe("checkLockfileDrift", () => {
	it("fires when pnpm-lock.yaml is in diff", () => {
		const result = checkLockfileDrift(["src/foo.ts", "pnpm-lock.yaml"]);
		expect(result).toEqual({ tripped: true, lockfiles: ["pnpm-lock.yaml"] });
	});

	it("fires when bun.lock is in diff", () => {
		expect(checkLockfileDrift(["bun.lock"])).toEqual({
			tripped: true,
			lockfiles: ["bun.lock"],
		});
	});

	it("fires when yarn.lock is in diff", () => {
		expect(checkLockfileDrift(["yarn.lock"])).toEqual({
			tripped: true,
			lockfiles: ["yarn.lock"],
		});
	});

	it("fires when package-lock.json is in diff", () => {
		expect(checkLockfileDrift(["package-lock.json"])).toEqual({
			tripped: true,
			lockfiles: ["package-lock.json"],
		});
	});

	it("does not fire when no lockfiles are touched", () => {
		const result = checkLockfileDrift(["src/foo.ts", "README.md"]);
		expect(result.tripped).toBe(false);
	});

	it("reports multiple lockfiles when all change", () => {
		const result = checkLockfileDrift(["bun.lock", "pnpm-lock.yaml"]);
		expect(result.tripped).toBe(true);
		expect(result.lockfiles.sort()).toEqual(["bun.lock", "pnpm-lock.yaml"]);
	});

	it("LOCKFILE_NAMES list matches the four tracked names", () => {
		expect(LOCKFILE_NAMES.sort()).toEqual(
			["bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].sort(),
		);
	});
});

/* ============================== checkUnboundedDiff ============================== */

describe("checkUnboundedDiff", () => {
	it("does not fire at threshold-1 files", () => {
		const result = checkUnboundedDiff({ filesChanged: 50, totalLines: 100 });
		expect(result.tripped).toBe(false);
	});

	it("fires at 51 files", () => {
		const result = checkUnboundedDiff({ filesChanged: 51, totalLines: 100 });
		expect(result).toEqual({ tripped: true, filesChanged: 51, totalLines: 100 });
	});

	it("does not fire at threshold-1 lines", () => {
		const result = checkUnboundedDiff({ filesChanged: 5, totalLines: 2000 });
		expect(result.tripped).toBe(false);
	});

	it("fires at 2001 lines", () => {
		const result = checkUnboundedDiff({ filesChanged: 5, totalLines: 2001 });
		expect(result).toEqual({ tripped: true, filesChanged: 5, totalLines: 2001 });
	});

	it("exposes thresholds as constants matching the spec", () => {
		expect(UNBOUNDED_DIFF_FILES).toBe(50);
		expect(UNBOUNDED_DIFF_LINES).toBe(2000);
	});
});

/* ============================== checkHeartbeatMissed ============================== */

describe("checkHeartbeatMissed", () => {
	const now = Date.parse("2026-05-19T12:30:00.000Z");

	it("fires when last semantic beat is older than 5 minutes and PID alive", () => {
		const lastBeatMs = now - 6 * 60_000;
		const result = checkHeartbeatMissed({
			lastSemanticBeatMs: lastBeatMs,
			now,
			pidAlive: true,
		});
		expect(result).toEqual({ tripped: true, lastSemanticBeatMs: lastBeatMs });
	});

	it("does not fire when PID is dead (reaper territory)", () => {
		const lastBeatMs = now - 6 * 60_000;
		const result = checkHeartbeatMissed({
			lastSemanticBeatMs: lastBeatMs,
			now,
			pidAlive: false,
		});
		expect(result.tripped).toBe(false);
	});

	it("does not fire when last semantic beat is within window", () => {
		const lastBeatMs = now - 4 * 60_000;
		const result = checkHeartbeatMissed({
			lastSemanticBeatMs: lastBeatMs,
			now,
			pidAlive: true,
		});
		expect(result.tripped).toBe(false);
	});

	it("does not fire when no semantic beat has been observed yet", () => {
		const result = checkHeartbeatMissed({
			lastSemanticBeatMs: undefined,
			now,
			pidAlive: true,
		});
		expect(result.tripped).toBe(false);
	});

	it("exposes the threshold as a 5-minute constant", () => {
		expect(HEARTBEAT_MISS_THRESHOLD_MS).toBe(5 * 60_000);
	});
});

/* ============================== pauseRun (integration of state mutation) ============================== */

describe("pauseRun", () => {
	beforeEach(() => {
		vol.reset();
		vi.useFakeTimers();
		vi.setSystemTime(Date.parse("2026-05-19T12:30:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function seedRunning(pid = 1234): BackgroundRunSummary {
		const summary: BackgroundRunSummary = {
			runId: "r1",
			questId: "q1",
			workItemId: "001",
			agentName: "quest-implementation",
			status: "running",
			startedAt: "2026-05-19T12:00:00.000Z",
			updatedAt: "2026-05-19T12:00:00.000Z",
			pid,
			stdoutPath: "/x",
			stderrPath: "/y",
			reportPath: "/z",
			statusPath: "/project/.pi/quests/q1/runs/r1.json",
			worktreePath: "/project/.pi/quests/q1/worktrees/r1",
			runBranch: "quest-run/q1/r1",
			questBranch: "quest/q1",
		};
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/runs/r1.json",
			JSON.stringify(summary),
		);
		return summary;
	}

	it("SIGTERMs the PID, marks the run paused, emits anomaly_detected + run_finished", async () => {
		const summary = seedRunning();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		await pauseRun({
			cwd: "/project",
			summary,
			rule: "lockfile_drift",
			details: { files: ["bun.lock"] },
		});

		// SIGTERM was issued.
		expect(killSpy).toHaveBeenCalledWith(1234, "SIGTERM");

		// Run status flipped to paused with reason.
		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r1.json", "utf-8") as string,
		) as BackgroundRunSummary & { paused_at?: string; paused_reason?: string };
		expect(updated.status).toBe("paused");
		expect(updated.paused_reason).toBe("lockfile_drift");
		expect(typeof updated.paused_at).toBe("string");

		// Anomaly + run_finished events landed.
		const jsonl = vol.readFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			"utf-8",
		) as string;
		const events = jsonl.trim().split("\n").map((l) => JSON.parse(l));

		const anomaly = events.find((e) => e.event === "anomaly_detected");
		expect(anomaly).toBeDefined();
		expect(anomaly.tier).toBe("pause");
		expect(anomaly.should_pause).toBe(true);
		expect(anomaly.rule).toBe("lockfile_drift");
		expect(anomaly.runId).toBe("r1");
		expect(anomaly.details.files).toEqual(["bun.lock"]);

		const finished = events.find((e) => e.event === "run_finished");
		expect(finished).toBeDefined();
		expect(finished.runId).toBe("r1");
		expect(finished.details.status).toBe("paused");
		expect(finished.details.paused_reason).toBe("lockfile_drift");

		killSpy.mockRestore();
	});

	it("SIGKILLs after 5s grace if process is still alive", async () => {
		const summary = seedRunning();
		let alive = true;
		const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, sig) => {
			if (sig === "SIGTERM") return true;
			if (sig === "SIGKILL") {
				alive = false;
				return true;
			}
			// liveness probe (sig 0)
			if (!alive) {
				const err: NodeJS.ErrnoException = new Error("no such process");
				err.code = "ESRCH";
				throw err;
			}
			return true;
		});

		await pauseRun({
			cwd: "/project",
			summary,
			rule: "unbounded_diff",
			details: { filesChanged: 60, totalLines: 100 },
		});

		// SIGTERM at t0.
		expect(killSpy).toHaveBeenCalledWith(1234, "SIGTERM");
		// After 5s grace, SIGKILL fires.
		vi.advanceTimersByTime(5000);
		expect(killSpy).toHaveBeenCalledWith(1234, "SIGKILL");

		killSpy.mockRestore();
	});

	it("does NOT remove the worktree (preserve for inspection)", async () => {
		const summary = seedRunning();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		const worktree = await import("./worktree.js");
		(worktree.removeRunWorktree as any).mockClear();

		await pauseRun({
			cwd: "/project",
			summary,
			rule: "heartbeat_missed",
			details: { lastSemanticBeatAt: "2026-05-19T12:24:00.000Z" },
		});

		expect(worktree.removeRunWorktree).not.toHaveBeenCalled();

		killSpy.mockRestore();
	});

	it("is idempotent — calling twice does not emit duplicate events", async () => {
		const summary = seedRunning();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		await pauseRun({
			cwd: "/project",
			summary,
			rule: "lockfile_drift",
			details: { files: ["bun.lock"] },
		});
		// Refresh summary from disk to mimic the second poll tick reading
		// the same already-paused row.
		const reread = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r1.json", "utf-8") as string,
		) as BackgroundRunSummary;
		await pauseRun({
			cwd: "/project",
			summary: reread,
			rule: "lockfile_drift",
			details: { files: ["bun.lock"] },
		});

		const jsonl = vol.readFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			"utf-8",
		) as string;
		const events = jsonl.trim().split("\n").map((l) => JSON.parse(l));
		// Exactly one anomaly + one run_finished, even though pauseRun was called twice.
		expect(events.filter((e) => e.event === "anomaly_detected")).toHaveLength(1);
		expect(events.filter((e) => e.event === "run_finished")).toHaveLength(1);

		killSpy.mockRestore();
	});
});

/* ============================== pollAnomaliesOnce ============================== */

describe("pollAnomaliesOnce", () => {
	beforeEach(() => {
		vol.reset();
	});

	function seedRunning(opts: { questId: string; runId: string; pid: number }) {
		const summary: BackgroundRunSummary = {
			runId: opts.runId,
			questId: opts.questId,
			workItemId: "001",
			agentName: "quest-implementation",
			status: "running",
			startedAt: "2026-05-19T12:00:00.000Z",
			updatedAt: "2026-05-19T12:00:00.000Z",
			pid: opts.pid,
			stdoutPath: "/x",
			stderrPath: "/y",
			reportPath: "/z",
			statusPath: `/project/.pi/quests/${opts.questId}/runs/${opts.runId}.json`,
			worktreePath: `/project/.pi/quests/${opts.questId}/worktrees/${opts.runId}`,
			runBranch: `quest-run/${opts.questId}/${opts.runId}`,
			questBranch: `quest/${opts.questId}`,
		};
		vol.mkdirSync(`/project/.pi/quests/${opts.questId}/runs`, { recursive: true });
		vol.writeFileSync(
			`/project/.pi/quests/${opts.questId}/runs/${opts.runId}.json`,
			JSON.stringify(summary),
		);
	}

	it("skips runs that are not 'running'", async () => {
		const summary: BackgroundRunSummary = {
			runId: "r-done",
			questId: "q1",
			workItemId: "001",
			agentName: "quest-implementation",
			status: "completed",
			startedAt: "2026-05-19T12:00:00.000Z",
			updatedAt: "2026-05-19T12:00:00.000Z",
			stdoutPath: "/x",
			stderrPath: "/y",
			reportPath: "/z",
			statusPath: "/project/.pi/quests/q1/runs/r-done.json",
		};
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/runs/r-done.json",
			JSON.stringify(summary),
		);

		const reads = vi.fn();
		await pollAnomaliesOnce({
			cwd: "/project",
			now: () => Date.parse("2026-05-19T12:30:00.000Z"),
			readDiffNames: reads,
			readDiffShortstat: vi.fn(),
			isPidAlive: () => true,
			lastSemanticBeatMs: (_q, _r) => undefined,
		});
		expect(reads).not.toHaveBeenCalled();
	});

	it("pauses with rule lockfile_drift when a tracked lockfile is in the diff", async () => {
		seedRunning({ questId: "q1", runId: "r1", pid: 1111 });
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		await pollAnomaliesOnce({
			cwd: "/project",
			now: () => Date.parse("2026-05-19T12:30:00.000Z"),
			readDiffNames: async () => ["bun.lock", "src/foo.ts"],
			readDiffShortstat: async () => ({ filesChanged: 2, totalLines: 10 }),
			isPidAlive: () => true,
			lastSemanticBeatMs: (_q, _r) => Date.parse("2026-05-19T12:29:00.000Z"),
		});

		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r1.json", "utf-8") as string,
		);
		expect(updated.status).toBe("paused");
		expect(updated.paused_reason).toBe("lockfile_drift");

		killSpy.mockRestore();
	});

	it("pauses with rule unbounded_diff when diff exceeds size threshold", async () => {
		seedRunning({ questId: "q1", runId: "r2", pid: 2222 });
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		await pollAnomaliesOnce({
			cwd: "/project",
			now: () => Date.parse("2026-05-19T12:30:00.000Z"),
			readDiffNames: async () => ["src/a.ts"],
			readDiffShortstat: async () => ({ filesChanged: 5, totalLines: 2500 }),
			isPidAlive: () => true,
			lastSemanticBeatMs: (_q, _r) => Date.parse("2026-05-19T12:29:00.000Z"),
		});

		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r2.json", "utf-8") as string,
		);
		expect(updated.status).toBe("paused");
		expect(updated.paused_reason).toBe("unbounded_diff");

		killSpy.mockRestore();
	});

	it("pauses with rule heartbeat_missed when no semantic beat in 5min and PID alive", async () => {
		seedRunning({ questId: "q1", runId: "r3", pid: 3333 });
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const now = Date.parse("2026-05-19T12:30:00.000Z");

		await pollAnomaliesOnce({
			cwd: "/project",
			now: () => now,
			readDiffNames: async () => [],
			readDiffShortstat: async () => ({ filesChanged: 0, totalLines: 0 }),
			isPidAlive: () => true,
			lastSemanticBeatMs: (_q, _r) => now - 6 * 60_000,
		});

		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r3.json", "utf-8") as string,
		);
		expect(updated.status).toBe("paused");
		expect(updated.paused_reason).toBe("heartbeat_missed");

		killSpy.mockRestore();
	});

	it("emits log-only locked_out_write anomaly without pausing the run", async () => {
		seedRunning({ questId: "q1", runId: "r4", pid: 4444 });
		// Plan with blast_radius.locked_out: ['src/secret/**']
		vol.mkdirSync("/project/.pi/quests/q1", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md",
			"---\nblast_radius:\n  locked_out:\n    - 'src/secret/**'\nwork_items: []\n---\n",
		);
		const workflow = {
			id: "q1",
			title: "Q1",
			status: "executing",
			createdAt: "2026-05-19T12:00:00.000Z",
			updatedAt: "2026-05-19T12:00:00.000Z",
			source: {},
			artifacts: { plan: "IMPLEMENTATION_PLAN.md" },
		};
		vol.writeFileSync(
			"/project/.pi/quests/q1/workflow.json",
			JSON.stringify(workflow),
		);

		await pollAnomaliesOnce({
			cwd: "/project",
			now: () => Date.parse("2026-05-19T12:30:00.000Z"),
			readDiffNames: async () => ["src/secret/key.ts", "src/ok.ts"],
			readDiffShortstat: async () => ({ filesChanged: 2, totalLines: 10 }),
			isPidAlive: () => true,
			lastSemanticBeatMs: (_q, _r) => Date.parse("2026-05-19T12:29:00.000Z"),
		});

		// Run remains running.
		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r4.json", "utf-8") as string,
		);
		expect(updated.status).toBe("running");

		// Anomaly was logged.
		const jsonl = vol.readFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			"utf-8",
		) as string;
		const events = jsonl.trim().split("\n").map((l) => JSON.parse(l));
		const anomaly = events.find((e) => e.event === "anomaly_detected");
		expect(anomaly).toBeDefined();
		expect(anomaly.tier).toBe("log");
		expect(anomaly.rule).toBe("locked_out_write");
		expect(anomaly.should_pause).toBe(false);
		expect(anomaly.details.path).toBe("src/secret/key.ts");
		expect(anomaly.details.lockedOutPattern).toBe("src/secret/**");
	});

	it("does NOT pause for log-only locked_out_write — locked_out_write alone never triggers SIGTERM", async () => {
		seedRunning({ questId: "q1", runId: "r5", pid: 5555 });
		vol.mkdirSync("/project/.pi/quests/q1", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md",
			"---\nblast_radius:\n  locked_out:\n    - 'src/secret/**'\nwork_items: []\n---\n",
		);
		vol.writeFileSync(
			"/project/.pi/quests/q1/workflow.json",
			JSON.stringify({
				id: "q1",
				title: "Q1",
				status: "executing",
				createdAt: "2026-05-19T12:00:00.000Z",
				updatedAt: "2026-05-19T12:00:00.000Z",
				source: {},
				artifacts: { plan: "IMPLEMENTATION_PLAN.md" },
			}),
		);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		await pollAnomaliesOnce({
			cwd: "/project",
			now: () => Date.parse("2026-05-19T12:30:00.000Z"),
			readDiffNames: async () => ["src/secret/key.ts"],
			readDiffShortstat: async () => ({ filesChanged: 1, totalLines: 1 }),
			isPidAlive: () => true,
			lastSemanticBeatMs: (_q, _r) => Date.parse("2026-05-19T12:29:00.000Z"),
		});

		// process.kill must NOT have been called with SIGTERM for the run pid.
		const sigtermCalls = killSpy.mock.calls.filter(
			([, sig]) => sig === "SIGTERM",
		);
		expect(sigtermCalls).toHaveLength(0);
		killSpy.mockRestore();
	});

	it("derives heartbeat_missed from the events log — synthetic beats do not count", async () => {
		seedRunning({ questId: "q1", runId: "r-beat", pid: 9999 });
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const now = Date.parse("2026-05-19T12:30:00.000Z");
		// Telemetry: a 6-min-old semantic beat, then a fresh synthetic 'alive' beat.
		vol.mkdirSync("/project/.pi/quests/q1/telemetry", { recursive: true });
		const lines = [
			JSON.stringify({
				event: "progress_beat",
				timestamp: new Date(now - 6 * 60_000).toISOString(),
				questId: "q1",
				runId: "r-beat",
				phase: "implementing",
			}),
			JSON.stringify({
				event: "progress_beat",
				timestamp: new Date(now - 30_000).toISOString(),
				questId: "q1",
				runId: "r-beat",
				phase: "alive",
			}),
		];
		vol.writeFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			lines.join("\n") + "\n",
		);

		// No `lastSemanticBeatMs` override → uses the default reader.
		await pollAnomaliesOnce({
			cwd: "/project",
			now: () => now,
			readDiffNames: async () => [],
			readDiffShortstat: async () => ({ filesChanged: 0, totalLines: 0 }),
			isPidAlive: () => true,
		});

		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r-beat.json", "utf-8") as string,
		);
		expect(updated.status).toBe("paused");
		expect(updated.paused_reason).toBe("heartbeat_missed");

		killSpy.mockRestore();
	});

	it("does NOT fire heartbeat_missed when the only beats are synthetic", async () => {
		seedRunning({ questId: "q1", runId: "r-syn", pid: 8888 });
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const now = Date.parse("2026-05-19T12:30:00.000Z");
		vol.mkdirSync("/project/.pi/quests/q1/telemetry", { recursive: true });
		// Only synthetic beats — old or new. Rule must not fire because there's
		// no semantic beat to anchor against (run is too new to judge).
		vol.writeFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			JSON.stringify({
				event: "progress_beat",
				timestamp: new Date(now - 10 * 60_000).toISOString(),
				questId: "q1",
				runId: "r-syn",
				phase: "alive",
			}) + "\n",
		);

		await pollAnomaliesOnce({
			cwd: "/project",
			now: () => now,
			readDiffNames: async () => [],
			readDiffShortstat: async () => ({ filesChanged: 0, totalLines: 0 }),
			isPidAlive: () => true,
		});

		const updated = JSON.parse(
			vol.readFileSync("/project/.pi/quests/q1/runs/r-syn.json", "utf-8") as string,
		);
		expect(updated.status).toBe("running");

		killSpy.mockRestore();
	});

	it("never reaches diff for a run with no worktreePath", async () => {
		const summary: BackgroundRunSummary = {
			runId: "r-no-wt",
			questId: "q1",
			workItemId: "001",
			agentName: "quest-implementation",
			status: "running",
			startedAt: "2026-05-19T12:00:00.000Z",
			updatedAt: "2026-05-19T12:00:00.000Z",
			pid: 7777,
			stdoutPath: "/x",
			stderrPath: "/y",
			reportPath: "/z",
			statusPath: "/project/.pi/quests/q1/runs/r-no-wt.json",
		};
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		vol.writeFileSync(
			"/project/.pi/quests/q1/runs/r-no-wt.json",
			JSON.stringify(summary),
		);

		const reads = vi.fn();
		await pollAnomaliesOnce({
			cwd: "/project",
			now: () => Date.parse("2026-05-19T12:30:00.000Z"),
			readDiffNames: reads,
			readDiffShortstat: vi.fn(),
			isPidAlive: () => true,
			lastSemanticBeatMs: (_q, _r) => undefined,
		});
		expect(reads).not.toHaveBeenCalled();
	});
});

/* ============================== startAnomalyPoller ============================== */

describe("startAnomalyPoller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("exposes the 30s interval as a constant matching the spec", () => {
		expect(ANOMALY_POLL_INTERVAL_MS).toBe(30_000);
	});

	it("returns a timer handle that is unref'd", () => {
		const handle = startAnomalyPoller("/project");
		// Ensure the handle was unref'd; setInterval returns a Timeout with unref.
		expect(typeof (handle as any).unref).toBe("function");
		clearInterval(handle);
	});
});
