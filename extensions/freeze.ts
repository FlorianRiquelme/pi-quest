/**
 * Swarm-freeze chord handlers — M3-2 / ADR 013 §8.
 *
 * Two chords, exposed at the extension level by `index.ts`:
 *   - Alt+P         — soft freeze toggle (engage or release). Rotated from
 *                     Ctrl+P, which collides with pi v0.75's built-in
 *                     model-switch chord and is silently dropped at startup.
 *   - Ctrl+Shift+P  — hard freeze with confirmation, kills running runs.
 *
 * The `/quest freeze` and `/quest unfreeze` slash commands in `index.ts` are a
 * fallback alias for terminals that can't bind Alt-chords; they reuse
 * `handleSoftFreezeChord` so the audit-event trail is identical.
 *
 * Soft freeze sets `workflow.freeze = { mode: "soft", ... }` and is a no-spawn
 * guard: in-flight runs continue, but the router refuses to launch new runs
 * (see `startSubagentRun` in agents.ts).
 *
 * Hard freeze prompts the user, then SIGTERMs every running run (5s grace →
 * SIGKILL), marks each cancelled, transitions the quest to `blocked` with
 * `cancel_reason: "user_aborted"`, and emits a `freeze_engaged` audit event.
 *
 * Worktree reaping (M1-3) is deferred — see TODO inside hardFreeze.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { questDirPath } from "./paths.js";
import { loadCurrentState, loadQuestWorkflow, saveQuestWorkflow } from "./state.js";
import { listRunSummaries, writeRunSummary } from "./agents.js";
import { ensureDir } from "./fs-utils.js";
import { emitStageEntered, validateEvent } from "./events.js";
import type { QuestWorkflow } from "../lib.js";
import type { BackgroundRunSummary } from "./types.js";

/**
 * Structural subset of the extension context needed by freeze handlers.
 *
 * Both `ExtensionContext` (received by shortcut handlers) and
 * `ExtensionCommandContext` (received by command handlers) satisfy this
 * shape, so the handlers can be called from either entry point.
 */
export interface FreezeContext {
	cwd: string;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
	};
}

/** Grace period between SIGTERM and SIGKILL during hard freeze, per ADR 013 §8. */
export const HARD_FREEZE_KILL_GRACE_MS = 5_000;

/* ============================ helpers ============================ */

function appendEvent(qDir: string, event: unknown): void {
	const telemetryPath = path.join(qDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	const validated = validateEvent(event);
	fs.appendFileSync(telemetryPath, JSON.stringify(validated) + "\n", "utf-8");
}

function findActiveQuest(cwd: string):
	| { questId: string; qDir: string; workflow: QuestWorkflow }
	| undefined {
	const state = loadCurrentState(cwd);
	const id = state.currentQuestId;
	if (!id) return undefined;
	const qDir = questDirPath(cwd, id);
	const workflow = loadQuestWorkflow(qDir);
	if (!workflow) return undefined;
	return { questId: id, qDir, workflow };
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		return true;
	}
}

/* ============================ Soft freeze ============================ */

/**
 * Read the active quest's workflow and return true if a soft freeze is in
 * effect right now. Pure read; safe to call from anywhere.
 *
 * Returns false if there is no active quest or no workflow file.
 */
export function isSoftFrozen(cwd: string): boolean {
	const active = findActiveQuest(cwd);
	return active?.workflow.freeze?.mode === "soft";
}

/**
 * Read the workflow at `qDir` and return true iff a soft freeze is engaged.
 * Used by `startSubagentRun` to gate spawns without re-resolving the active
 * quest from `state.json`.
 */
export function isQuestSoftFrozen(qDir: string): boolean {
	const workflow = loadQuestWorkflow(qDir);
	return workflow?.freeze?.mode === "soft";
}

/**
 * Toggle handler for `Alt+P` (and the `/quest freeze` slash-command fallback).
 * Engages a soft freeze on the active quest, or releases it if already engaged.
 *
 * No-ops with an info notification if no quest is active.
 */
export async function handleSoftFreezeChord(ctx: FreezeContext): Promise<void> {
	const active = findActiveQuest(ctx.cwd);
	if (!active) {
		ctx.ui.notify("No active quest", "info");
		return;
	}

	if (active.workflow.freeze?.mode === "soft") {
		releaseSoftFreeze({ cwd: ctx.cwd, qDir: active.qDir, workflow: active.workflow });
		ctx.ui.notify("Soft freeze released", "info");
		return;
	}

	const inFlight = countRunningRuns(active.qDir);
	engageSoftFreeze({
		cwd: ctx.cwd,
		qDir: active.qDir,
		workflow: active.workflow,
		inFlightRuns: inFlight,
	});
	ctx.ui.notify(
		`Soft freeze engaged · ${inFlight} run${inFlight === 1 ? "" : "s"} completing · Alt+P to release`,
		"info",
	);
}

function engageSoftFreeze(options: {
	cwd: string;
	qDir: string;
	workflow: QuestWorkflow;
	inFlightRuns: number;
}): void {
	const now = new Date().toISOString();
	const updated: QuestWorkflow = {
		...options.workflow,
		freeze: { mode: "soft", engaged_at: now, triggered_by: "user" },
		updatedAt: now,
	};
	saveQuestWorkflow(options.qDir, updated);
	appendEvent(options.qDir, {
		event: "freeze_engaged",
		timestamp: now,
		questId: updated.id,
		mode: "soft",
		in_flight_runs: options.inFlightRuns,
		triggered_by: "user",
	});
}

function releaseSoftFreeze(options: {
	cwd: string;
	qDir: string;
	workflow: QuestWorkflow;
}): void {
	const now = new Date().toISOString();
	// Strip the freeze field rather than setting it to undefined; writeJson
	// serialises undefined as missing, but being explicit keeps the file shape
	// predictable for grep-based debugging.
	const { freeze: _freeze, ...rest } = options.workflow;
	void _freeze;
	const updated: QuestWorkflow = { ...rest, updatedAt: now };
	saveQuestWorkflow(options.qDir, updated);
	appendEvent(options.qDir, {
		event: "freeze_released",
		timestamp: now,
		questId: updated.id,
		triggered_by: "user",
	});
}

function countRunningRuns(qDir: string): number {
	return listRunSummaries(qDir).filter((r) => r.status === "running").length;
}

/* ============================ Hard freeze ============================ */

/**
 * Confirm-and-abort handler for `Ctrl+Shift+P`. Per ADR 013 §8:
 *
 *  1. Read the in-flight run count.
 *  2. Ask the user `Abort N runs and discard their work?` — falsy answer cancels.
 *  3. SIGTERM each running pid.
 *  4. After {@link HARD_FREEZE_KILL_GRACE_MS}, SIGKILL any pid still alive.
 *  5. Transition the quest to `blocked` with `cancel_reason: "user_aborted"`.
 *  6. Emit `freeze_engaged(mode: "hard")` and, for each killed run, a
 *     `run_finished` event with `status: "cancelled"`.
 */
export async function handleHardFreezeChord(ctx: FreezeContext): Promise<void> {
	const active = findActiveQuest(ctx.cwd);
	if (!active) {
		ctx.ui.notify("No active quest", "info");
		return;
	}

	const runningRuns = listRunSummaries(active.qDir).filter((r) => r.status === "running");
	const count = runningRuns.length;

	const confirmed = await ctx.ui.confirm(
		"Hard freeze",
		`Abort ${count} run${count === 1 ? "" : "s"} and discard their work? [y/N]`,
	);
	if (!confirmed) {
		ctx.ui.notify("Hard freeze cancelled", "info");
		return;
	}

	// Step 3: SIGTERM each pid we can reach.
	const pidsAlive: number[] = [];
	for (const run of runningRuns) {
		if (typeof run.pid !== "number") continue;
		try {
			process.kill(run.pid, "SIGTERM");
			pidsAlive.push(run.pid);
		} catch {
			/* already dead or unreachable; nothing to escalate */
		}
	}

	// Step 4: schedule SIGKILL escalation after the grace window.
	const sigkillTimer = setTimeout(() => {
		for (const pid of pidsAlive) {
			if (!isPidAlive(pid)) continue;
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already dead */
			}
		}
	}, HARD_FREEZE_KILL_GRACE_MS);
	// Don't pin the host process alive on this timer.
	(sigkillTimer as { unref?: () => void }).unref?.();

	// Step 5: transition the quest and emit the freeze_engaged event.
	const now = new Date().toISOString();
	const previousStatus = active.workflow.status;
	const updated: QuestWorkflow = {
		...active.workflow,
		status: "blocked",
		cancel_reason: "user_aborted",
		updatedAt: now,
	};
	saveQuestWorkflow(active.qDir, updated);
	emitStageEntered(active.qDir, updated.id, previousStatus, updated.status);

	appendEvent(active.qDir, {
		event: "freeze_engaged",
		timestamp: now,
		questId: updated.id,
		mode: "hard",
		in_flight_runs: count,
		triggered_by: "user",
		details: { cancel_reason: "user_aborted" },
	});

	// Step 6: mark each run cancelled and emit `run_finished`.
	for (const run of runningRuns) {
		const updatedRun: BackgroundRunSummary = {
			...run,
			status: "cancelled",
			completedAt: now,
			updatedAt: now,
		};
		writeRunSummary(updatedRun);
		appendEvent(active.qDir, {
			event: "run_finished",
			timestamp: now,
			questId: updated.id,
			runId: run.runId,
			workItemId: run.workItemId,
			details: {
				status: "cancelled",
				cancel_reason: "user_aborted",
				agentRole: "implementation",
				model: run.model,
			},
		});
	}

	// TODO(M1-3): when extensions/worktree.ts lands, call removeRunWorktree for
	// each cancelled run here. Until then, leave the worktree on disk; the
	// SIGTERM/SIGKILL pair is the load-bearing part of the abort.

	ctx.ui.notify(`Hard freeze: aborted ${count} run${count === 1 ? "" : "s"}`, "warning");
}
