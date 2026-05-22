/**
 * Per-run anomaly polling loop (ADR 014, M3-3; amended 2026-05-22).
 *
 * Every 30s, scan each Quest's `runs/*.json`, filter to runs with
 * `status === "running"`, and apply the two remaining pause-tier rules:
 *
 *   - `unbounded_diff`   > 50 files OR > 2000 changed lines
 *   - `heartbeat_missed` last semantic `progress_beat` > 5min ago and PID alive
 *
 * The legacy lockfile-touch pause-tier rule was removed in the ADR 014
 * 2026-05-22 amendment (issue #14): monorepo `bun install` correctly rewrites
 * lockfiles when new workspace packages exist, and the supervisor was
 * punishing legitimate Runs. Real dependency tampering now surfaces at merge
 * time (Worktree Isolation, ADR 011) and in the Homecoming Brief narrative.
 *
 * On any pause trigger: emit `anomaly_detected` (tier: "pause", should_pause:
 * true), SIGTERM the run (5s grace → SIGKILL), flip its summary to
 * `status: "paused"` with `paused_at` + `paused_reason`, emit `run_finished`
 * with `status: "paused"`. The worktree is preserved for inspection or future
 * Resume (M4-4).
 *
 * Also wires the `locked_out_write` log-only rule from M2-2's
 * {@link checkLockedOutWrites} — same per-run touched-files diff feeds both.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { validateEvent } from "../events.js";
import { ensureDir, readJsonIfExists, writeJson } from "../fs-utils.js";
import { recordRunFinished } from "./runner.js";
import { checkLockedOutWrites } from "../handoff-compiler.js";
import { readPlanFrontmatter, type FrontmatterValue } from "../launch-review.js";
import { shouldOverwriteStatus, type BackgroundRunSummary, type RunStatus } from "./types.js";

/* ================================ Constants ================================ */

/** Per ADR 014: supervisor polls each active run every ~30s. */
export const ANOMALY_POLL_INTERVAL_MS = 30_000;

/** Per ADR 014: heartbeat_missed threshold. */
export const HEARTBEAT_MISS_THRESHOLD_MS = 5 * 60_000;

/** Per ADR 014: unbounded_diff file-count threshold. Trigger is `> N`. */
export const UNBOUNDED_DIFF_FILES = 50;

/** Per ADR 014: unbounded_diff line-count threshold. Trigger is `> N`. */
export const UNBOUNDED_DIFF_LINES = 2000;

/** Grace period between SIGTERM and SIGKILL when pausing. */
export const SIGKILL_GRACE_MS = 5_000;

/* ================================ Pure rule checks ================================ */

export interface ShortStat {
	filesChanged: number;
	totalLines: number;
}

/**
 * Parse `git diff --shortstat` output. Examples:
 *   ` 3 files changed, 100 insertions(+), 20 deletions(-)`
 *   ` 1 file changed, 5 insertions(+)`
 *   ` 2 files changed, 10 deletions(-)`
 */
export function parseShortStat(line: string): ShortStat {
	const trimmed = line.trim();
	if (!trimmed) return { filesChanged: 0, totalLines: 0 };
	const filesMatch = trimmed.match(/(\d+)\s+files?\s+changed/);
	const insMatch = trimmed.match(/(\d+)\s+insertions?\(\+\)/);
	const delMatch = trimmed.match(/(\d+)\s+deletions?\(-\)/);
	return {
		filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
		totalLines:
			(insMatch ? Number(insMatch[1]) : 0) +
			(delMatch ? Number(delMatch[1]) : 0),
	};
}

export function checkUnboundedDiff(
	stat: ShortStat,
): { tripped: boolean; filesChanged: number; totalLines: number } {
	const tripped =
		stat.filesChanged > UNBOUNDED_DIFF_FILES ||
		stat.totalLines > UNBOUNDED_DIFF_LINES;
	return { tripped, filesChanged: stat.filesChanged, totalLines: stat.totalLines };
}

export function checkHeartbeatMissed(input: {
	lastSemanticBeatMs: number | undefined;
	now: number;
	pidAlive: boolean;
}): { tripped: boolean; lastSemanticBeatMs?: number } {
	if (!input.pidAlive) return { tripped: false };
	if (input.lastSemanticBeatMs === undefined) return { tripped: false };
	const elapsed = input.now - input.lastSemanticBeatMs;
	if (elapsed <= HEARTBEAT_MISS_THRESHOLD_MS) return { tripped: false };
	return { tripped: true, lastSemanticBeatMs: input.lastSemanticBeatMs };
}

/* ================================ Pause action ================================ */

export type PauseRule = "unbounded_diff" | "heartbeat_missed";

/**
 * Execute the pause flow for a single run.
 *
 * Steps:
 *   1. SIGTERM the run's PID; schedule a SIGKILL 5s later (best-effort, unref'd).
 *   2. Flip the run summary to `status: "paused"` with `paused_at`/`paused_reason`.
 *   3. Emit `anomaly_detected` (tier: "pause") and `run_finished` (status: "paused").
 *   4. Preserve the worktree (caller of M4-4 will reuse it).
 *
 * Idempotent: a second call for an already-paused summary is a no-op.
 */
export async function pauseRun(options: {
	cwd: string;
	summary: BackgroundRunSummary;
	rule: PauseRule;
	details: Record<string, unknown>;
}): Promise<void> {
	const { cwd, summary, rule, details } = options;
	if (summary.status === "paused") return;

	// 1. SIGTERM with grace-period SIGKILL.
	if (typeof summary.pid === "number") {
		try {
			process.kill(summary.pid, "SIGTERM");
		} catch {
			/* PID already gone; nothing to terminate. */
		}
		const grace = setTimeout(() => {
			try {
				// Probe liveness via signal 0.
				process.kill(summary.pid!, 0);
				// Still alive → SIGKILL.
				try {
					process.kill(summary.pid!, "SIGKILL");
				} catch {
					/* race */
				}
			} catch {
				/* already dead — no-op. */
			}
		}, SIGKILL_GRACE_MS);
		grace.unref?.();
	}

	// 2. Flip the summary on disk. Re-read first so a concurrent runner-close
	// `cancelled` write (issue #13 race) doesn't get clobbered. The STATUS_RANK
	// lattice has `paused > cancelled`, so paused wins legitimately; the gate
	// exists for symmetry and so future rule additions don't bypass it.
	const pausedAt = new Date().toISOString();
	const disk = readJsonIfExists<BackgroundRunSummary>(summary.statusPath);
	const currentStatus: RunStatus = disk?.status ?? summary.status;
	if (!shouldOverwriteStatus(currentStatus, "paused")) return;
	const updated: BackgroundRunSummary & {
		paused_at?: string;
		paused_reason?: PauseRule;
	} = {
		...(disk ?? summary),
		status: "paused",
		updatedAt: pausedAt,
		paused_at: pausedAt,
		paused_reason: rule,
	};
	writeJson(summary.statusPath, updated);

	// 3. Append the two events.
	const questDir = path.join(cwd, ".pi", "quests", summary.questId);
	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));

	const anomaly = validateEvent({
		event: "anomaly_detected",
		timestamp: pausedAt,
		questId: summary.questId,
		runId: summary.runId,
		tier: "pause",
		rule,
		should_pause: true,
		details: { runId: summary.runId, ...details },
	});
	fs.appendFileSync(telemetryPath, JSON.stringify(anomaly) + "\n", "utf-8");

	recordRunFinished({
		questDir,
		questId: summary.questId,
		runId: summary.runId,
		workItemId: summary.workItemId,
		model: summary.model ?? "default",
		status: "paused",
		exitCode: summary.exitCode,
		rescueUsed: false,
		agentRole: "implementation",
	});

	// Re-write the run_finished event to embed `paused_reason` in the details
	// slot. `recordRunFinished` writes a generic `status` field; we add the
	// reason so Homecoming Brief / dashboard readers can show it without a
	// second event lookup.
	const lines = fs.readFileSync(telemetryPath, "utf-8").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			const ev = JSON.parse(line);
			if (
				ev.event === "run_finished" &&
				ev.runId === summary.runId &&
				ev.details?.status === "paused" &&
				ev.details?.paused_reason === undefined
			) {
				ev.details.paused_reason = rule;
				lines[i] = JSON.stringify(ev);
				break;
			}
		} catch {
			/* skip corrupt */
		}
	}
	fs.writeFileSync(telemetryPath, lines.join("\n"), "utf-8");
	// 4. Worktree intentionally preserved — Resume (M4-4) will pick it up.
}

/* ================================ Poll loop ================================ */

export interface PollOnceOptions {
	cwd: string;
	now?: () => number;
	/** Resolve `git diff --name-only HEAD` for a worktree path. */
	readDiffNames?: (worktreePath: string) => Promise<string[]>;
	/** Resolve `git diff --shortstat HEAD` parsed for a worktree path. */
	readDiffShortstat?: (worktreePath: string) => Promise<ShortStat>;
	/** Probe whether a PID is alive. Default uses {@link defaultIsPidAlive}. */
	isPidAlive?: (pid: number) => boolean;
	/**
	 * Get the last semantic-beat (non-`alive`-phase) epoch-ms for a runId.
	 *
	 * Defaults to scanning the quest's `telemetry/events.jsonl` tail for the
	 * most recent `progress_beat` whose `phase !== "alive"` (per ADR 014:
	 * synthetic liveness beats don't count toward `heartbeat_missed`).
	 */
	lastSemanticBeatMs?: (questId: string, runId: string) => number | undefined;
}

/**
 * One pass of the anomaly poller. Exported so `startAnomalyPoller` can drive it
 * via `setInterval` and tests can drive it directly.
 */
export async function pollAnomaliesOnce(options: PollOnceOptions): Promise<void> {
	const now = options.now ?? (() => Date.now());
	const nowMs = now();
	const readNames = options.readDiffNames ?? defaultReadDiffNames;
	const readShortstat = options.readDiffShortstat ?? defaultReadDiffShortstat;
	const isAlive = options.isPidAlive ?? defaultIsPidAlive;
	const getLastBeat =
		options.lastSemanticBeatMs ??
		((questId, runId) => defaultLastSemanticBeatMs(options.cwd, questId, runId));

	const questsDir = path.join(options.cwd, ".pi", "quests");
	if (!fs.existsSync(questsDir)) return;

	const questIds = fs
		.readdirSync(questsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const questId of questIds) {
		const questDir = path.join(questsDir, questId);
		const runsDir = path.join(questDir, "runs");
		if (!fs.existsSync(runsDir)) continue;
		for (const entry of fs.readdirSync(runsDir)) {
			if (!entry.endsWith(".json")) continue;
			const summary = readJsonIfExists<BackgroundRunSummary>(
				path.join(runsDir, entry),
			);
			if (!summary) continue;
			if (summary.status !== "running") continue;
			if (!summary.worktreePath) continue;

			let diffNames: string[];
			let stat: ShortStat;
			try {
				diffNames = await readNames(summary.worktreePath);
			} catch {
				diffNames = [];
			}
			try {
				stat = await readShortstat(summary.worktreePath);
			} catch {
				stat = { filesChanged: 0, totalLines: 0 };
			}

			// Log-only locked_out_write check (M2-2 wiring). Read the plan
			// frontmatter for `blast_radius.locked_out` patterns. Best-effort.
			emitLockedOutWriteAnomalies({
				cwd: options.cwd,
				questId,
				runId: summary.runId,
				touchedFiles: diffNames,
			});

			// Pause-tier rules. Rule order matches ADR 014 §3 table
			// (post-2026-05-22 amendment — legacy lockfile rule removed).
			const big = checkUnboundedDiff(stat);
			if (big.tripped) {
				await pauseRun({
					cwd: options.cwd,
					summary,
					rule: "unbounded_diff",
					details: {
						filesChanged: big.filesChanged,
						totalLines: big.totalLines,
					},
				});
				continue;
			}
			const pidAlive =
				typeof summary.pid === "number" ? isAlive(summary.pid) : false;
			const beat = checkHeartbeatMissed({
				lastSemanticBeatMs: getLastBeat(questId, summary.runId),
				now: nowMs,
				pidAlive,
			});
			if (beat.tripped) {
				await pauseRun({
					cwd: options.cwd,
					summary,
					rule: "heartbeat_missed",
					details: {
						lastSemanticBeatAt:
							beat.lastSemanticBeatMs !== undefined
								? new Date(beat.lastSemanticBeatMs).toISOString()
								: undefined,
					},
				});
				continue;
			}
		}
	}
}

/**
 * Start the 30s anomaly poller. The returned handle is `unref`ed so the
 * interval doesn't keep pi alive on its own.
 */
export function startAnomalyPoller(cwd: string): NodeJS.Timeout {
	const handle = setInterval(() => {
		void pollAnomaliesOnce({ cwd }).catch(() => {
			/* never crash the host process */
		});
	}, ANOMALY_POLL_INTERVAL_MS);
	handle.unref?.();
	return handle;
}

/* ================================ Internals ================================ */

/**
 * Read the quest's `telemetry/events.jsonl` and return the epoch-ms of the
 * most recent `progress_beat` for `runId` whose `phase !== "alive"`.
 *
 * Per ADR 014: synthetic liveness beats (`phase: "alive"`) document PID
 * liveness, not work-in-progress. The `heartbeat_missed` rule wants the last
 * *semantic* beat — anything else means the subagent is silently stuck.
 *
 * Returns `undefined` when no semantic beat has been observed yet (in which
 * case the rule does not fire; the run is too new to judge).
 */
function defaultLastSemanticBeatMs(
	cwd: string,
	questId: string,
	runId: string,
): number | undefined {
	const eventsPath = path.join(
		cwd,
		".pi",
		"quests",
		questId,
		"telemetry",
		"events.jsonl",
	);
	if (!fs.existsSync(eventsPath)) return undefined;
	const raw = fs.readFileSync(eventsPath, "utf-8");
	const lines = raw.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			const ev = JSON.parse(line) as {
				event?: string;
				runId?: string;
				phase?: string;
				timestamp?: string;
			};
			if (
				ev.event === "progress_beat" &&
				ev.runId === runId &&
				ev.phase !== "alive" &&
				typeof ev.timestamp === "string"
			) {
				const t = Date.parse(ev.timestamp);
				if (!Number.isNaN(t)) return t;
			}
		} catch {
			/* skip corrupt */
		}
	}
	return undefined;
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		return true;
	}
}

function runGit(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) =>
			resolve({ exitCode: code ?? 0, stdout, stderr }),
		);
		proc.on("error", () => resolve({ exitCode: 1, stdout, stderr }));
	});
}

async function defaultReadDiffNames(worktreePath: string): Promise<string[]> {
	const result = await runGit(["diff", "--name-only", "HEAD"], worktreePath);
	if (result.exitCode !== 0) return [];
	return result.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

async function defaultReadDiffShortstat(worktreePath: string): Promise<ShortStat> {
	const result = await runGit(["diff", "--shortstat", "HEAD"], worktreePath);
	if (result.exitCode !== 0) return { filesChanged: 0, totalLines: 0 };
	return parseShortStat(result.stdout);
}

function emitLockedOutWriteAnomalies(input: {
	cwd: string;
	questId: string;
	runId: string;
	touchedFiles: string[];
}): void {
	const questDir = path.join(input.cwd, ".pi", "quests", input.questId);
	const workflow = readJsonIfExists<{
		artifacts?: { plan?: string };
	}>(path.join(questDir, "workflow.json"));
	const planFile = workflow?.artifacts?.plan;
	if (!planFile) return;
	const planPath = path.join(questDir, planFile);
	if (!fs.existsSync(planPath)) return;
	const fm = readPlanFrontmatter(planPath);
	const patterns = extractLockedOutPatterns(fm.blast_radius);
	if (patterns.length === 0) return;

	const anomalies = checkLockedOutWrites({
		questId: input.questId,
		runId: input.runId,
		lockedOutPatterns: patterns,
		touchedFiles: input.touchedFiles,
	});
	if (anomalies.length === 0) return;

	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	for (const a of anomalies) {
		const event = validateEvent({
			event: "anomaly_detected",
			timestamp: new Date().toISOString(),
			questId: a.questId,
			runId: a.runId,
			tier: a.tier,
			rule: a.rule,
			should_pause: a.should_pause,
			details: { runId: a.runId, ...a.details },
		});
		fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
	}
}

function extractLockedOutPatterns(value: FrontmatterValue | undefined): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const lockedOut = (value as { [k: string]: FrontmatterValue }).locked_out;
	if (!Array.isArray(lockedOut)) return [];
	return lockedOut.filter((v): v is string => typeof v === "string");
}
