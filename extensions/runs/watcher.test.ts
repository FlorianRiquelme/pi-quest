/**
 * Tests for the closeout watcher (ADR 018, issue #15).
 *
 * Covers the side-effect wrapper `tryFireCloseout` and the `scanAllOnce`
 * helper. The watcher itself (fs.watch wiring) is exercised via the
 * scan-once + tryFireCloseout pair — exactly what fs.watch ends up
 * triggering when a run summary lands on disk.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fs, vol } from "memfs";
import type { BackgroundRunSummary } from "./types.js";

vi.mock("node:fs", async () => {
	const { fs } = await import("memfs");
	return { default: fs, ...fs };
});

import { tryFireCloseout } from "./closeout.js";
import { scanAllOnce } from "./watcher.js";

const EXT_START = "2026-05-22T10:00:00.000Z";

function mkSummary(overrides: Partial<BackgroundRunSummary>): BackgroundRunSummary {
	return {
		runId: overrides.runId ?? "r1",
		questId: overrides.questId ?? "q1",
		workItemId: overrides.workItemId ?? "001",
		agentName: "quest-implementation",
		status: overrides.status ?? "completed",
		startedAt: "2026-05-22T10:01:00.000Z",
		updatedAt: "2026-05-22T10:05:00.000Z",
		completedAt: "2026-05-22T10:05:00.000Z",
		stdoutPath: "/x",
		stderrPath: "/y",
		reportPath: `/project/.pi/quests/${overrides.questId ?? "q1"}/reports/${overrides.workItemId ?? "001"}.md`,
		statusPath: `/project/.pi/quests/${overrides.questId ?? "q1"}/runs/${overrides.runId ?? "r1"}.json`,
		batchId: "batch-x",
		batchSize: 2,
		...overrides,
	};
}

function seedRunOnDisk(cwd: string, summary: BackgroundRunSummary): void {
	const questDir = `${cwd}/.pi/quests/${summary.questId}`;
	vol.mkdirSync(`${questDir}/runs`, { recursive: true });
	vol.mkdirSync(`${questDir}/reports`, { recursive: true });
	vol.mkdirSync(`${questDir}/telemetry`, { recursive: true });
	vol.writeFileSync(summary.statusPath, JSON.stringify(summary));
}

describe("tryFireCloseout — integration", () => {
	beforeEach(() => {
		vol.reset();
	});

	it("fires exactly one sendMessage + one batch_closeout event for a complete 2-run Batch", async () => {
		const cwd = "/project";
		seedRunOnDisk(cwd, mkSummary({ runId: "r1", workItemId: "001" }));
		seedRunOnDisk(cwd, mkSummary({ runId: "r2", workItemId: "002" }));

		const sendMessage = vi.fn();
		const firedInProcess = new Set<string>();
		const pi = { sendMessage } as any;

		await tryFireCloseout({
			cwd,
			questId: "q1",
			batchId: "batch-x",
			pi,
			extensionStartTime: EXT_START,
			firedInProcess,
		});

		expect(sendMessage).toHaveBeenCalledTimes(1);
		const [msg, opts] = sendMessage.mock.calls[0];
		expect(msg.customType).toBe("quest-batch-closeout");
		expect(msg.display).toBe(false);
		expect(opts).toEqual({ triggerTurn: true });
		const runIds = msg.details.runs.map((r: { runId: string }) => r.runId).sort();
		expect(runIds).toEqual(["r1", "r2"]);

		const jsonl = vol.readFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			"utf-8",
		) as string;
		const events = jsonl.trim().split("\n").map((l) => JSON.parse(l));
		const closeouts = events.filter((e) => e.event === "batch_closeout");
		expect(closeouts).toHaveLength(1);
		expect(closeouts[0].batchId).toBe("batch-x");
		expect(closeouts[0].batchSize).toBe(2);
		expect(closeouts[0].delivered).toBe(true);
		expect(closeouts[0].runIds.sort()).toEqual(["r1", "r2"]);

		expect(firedInProcess.has("batch-x")).toBe(true);
	});

	it("short-circuits when batchId is in firedInProcess (within-process dedupe)", async () => {
		const cwd = "/project";
		seedRunOnDisk(cwd, mkSummary({ runId: "r1", workItemId: "001" }));
		seedRunOnDisk(cwd, mkSummary({ runId: "r2", workItemId: "002" }));

		const sendMessage = vi.fn();
		const firedInProcess = new Set<string>(["batch-x"]);
		const pi = { sendMessage } as any;

		await tryFireCloseout({
			cwd,
			questId: "q1",
			batchId: "batch-x",
			pi,
			extensionStartTime: EXT_START,
			firedInProcess,
		});

		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("records delivered: false when sendMessage throws but still appends the audit event", async () => {
		const cwd = "/project";
		seedRunOnDisk(cwd, mkSummary({ runId: "r1", workItemId: "001" }));
		seedRunOnDisk(cwd, mkSummary({ runId: "r2", workItemId: "002" }));

		const sendMessage = vi.fn().mockImplementation(() => {
			throw new Error("pi not listening");
		});
		const firedInProcess = new Set<string>();
		const pi = { sendMessage } as any;

		await tryFireCloseout({
			cwd,
			questId: "q1",
			batchId: "batch-x",
			pi,
			extensionStartTime: EXT_START,
			firedInProcess,
		});

		const jsonl = vol.readFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			"utf-8",
		) as string;
		const events = jsonl.trim().split("\n").map((l) => JSON.parse(l));
		const closeouts = events.filter((e) => e.event === "batch_closeout");
		expect(closeouts).toHaveLength(1);
		expect(closeouts[0].delivered).toBe(false);
	});

	it("dedupes against an existing batch_closeout event in events.jsonl (durable)", async () => {
		const cwd = "/project";
		seedRunOnDisk(cwd, mkSummary({ runId: "r1", workItemId: "001" }));
		seedRunOnDisk(cwd, mkSummary({ runId: "r2", workItemId: "002" }));
		// Pre-existing audit row.
		vol.writeFileSync(
			"/project/.pi/quests/q1/telemetry/events.jsonl",
			JSON.stringify({
				event: "batch_closeout",
				timestamp: "2026-05-22T10:06:00.000Z",
				questId: "q1",
				batchId: "batch-x",
				batchSize: 2,
				runIds: ["r1", "r2"],
				statuses: { r1: "completed", r2: "completed" },
				delivered: true,
			}) + "\n",
		);

		const sendMessage = vi.fn();
		const firedInProcess = new Set<string>();
		const pi = { sendMessage } as any;

		await tryFireCloseout({
			cwd,
			questId: "q1",
			batchId: "batch-x",
			pi,
			extensionStartTime: EXT_START,
			firedInProcess,
		});

		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("legacy un-batched summary never triggers a Closeout (story 21)", async () => {
		const cwd = "/project";
		// Summary missing batchId/batchSize entirely (pre-amendment legacy shape).
		const legacy = {
			runId: "r-legacy",
			questId: "q1",
			workItemId: "999",
			agentName: "quest-implementation",
			status: "completed",
			startedAt: "2026-05-22T10:01:00.000Z",
			updatedAt: "2026-05-22T10:05:00.000Z",
			completedAt: "2026-05-22T10:05:00.000Z",
			stdoutPath: "/x",
			stderrPath: "/y",
			reportPath: "/project/.pi/quests/q1/reports/999.md",
			statusPath: "/project/.pi/quests/q1/runs/r-legacy.json",
		};
		vol.mkdirSync("/project/.pi/quests/q1/runs", { recursive: true });
		vol.writeFileSync(legacy.statusPath, JSON.stringify(legacy));

		const sendMessage = vi.fn();
		const firedInProcess = new Set<string>();
		const pi = { sendMessage } as any;

		// scanAllOnce drives the same code path the watcher's fs.watch handler does.
		await scanAllOnce(cwd, { pi, extensionStartTime: EXT_START, firedInProcess });

		expect(sendMessage).not.toHaveBeenCalled();
		const eventsPath = "/project/.pi/quests/q1/telemetry/events.jsonl";
		expect(vol.existsSync(eventsPath)).toBe(false);
	});

	it("scanAllOnce fires Closeouts discovered on the initial pass", async () => {
		const cwd = "/project";
		seedRunOnDisk(cwd, mkSummary({ runId: "r1", workItemId: "001" }));
		seedRunOnDisk(cwd, mkSummary({ runId: "r2", workItemId: "002" }));

		const sendMessage = vi.fn();
		const firedInProcess = new Set<string>();
		const pi = { sendMessage } as any;

		await scanAllOnce(cwd, { pi, extensionStartTime: EXT_START, firedInProcess });

		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(firedInProcess.has("batch-x")).toBe(true);
	});

	it("cross-session gate suppresses Closeout when min(completedAt) < extensionStartTime", async () => {
		const cwd = "/project";
		// Both summaries finished before the extension started.
		seedRunOnDisk(
			cwd,
			mkSummary({
				runId: "r1",
				workItemId: "001",
				completedAt: "2026-05-22T09:30:00.000Z",
			}),
		);
		seedRunOnDisk(
			cwd,
			mkSummary({
				runId: "r2",
				workItemId: "002",
				completedAt: "2026-05-22T09:31:00.000Z",
			}),
		);

		const sendMessage = vi.fn();
		const firedInProcess = new Set<string>();
		const pi = { sendMessage } as any;

		await tryFireCloseout({
			cwd,
			questId: "q1",
			batchId: "batch-x",
			pi,
			extensionStartTime: EXT_START,
			firedInProcess,
		});

		expect(sendMessage).not.toHaveBeenCalled();
		const eventsPath = "/project/.pi/quests/q1/telemetry/events.jsonl";
		expect(vol.existsSync(eventsPath)).toBe(false);
	});
});
