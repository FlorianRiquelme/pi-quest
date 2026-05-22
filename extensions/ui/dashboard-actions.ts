/**
 * Dashboard actions on Paused Runs (ADR 014 §4, M3-3 + M4-4 / ADR 017).
 *
 * The three actions are intentionally presented as equal-weight choices to
 * the user — different anomalies call for different resolutions; the UI
 * doesn't recommend.
 *
 *   - **Resume** (M4-4) — spawn a new Run with a continuation packet in the
 *     paused Run's worktree, on the same Run Branch. Acknowledgment text is
 *     required (empty allowed with default fallback).
 *   - **Discard** — reap the worktree, mark the run `cancelled`, don't merge.
 *   - **Force-Complete** — merge the Run Branch into the Quest Branch as-is,
 *     mark the run `completed`, then reap the worktree.
 *
 * All three helpers refuse to operate on a run that is not in `paused` status
 * — the dashboard should only expose them for paused rows, but the gate is
 * here to keep the contract honest.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { validateEvent } from "./../events.js";
import { ensureDir, readJsonIfExists, writeJson } from "./../fs-utils.js";
import { resumeRun } from "./../runs/resume.js";
import { mergeRunBranchIntoQuest, removeRunWorktree } from "./../runs/worktree.js";
import type { BackgroundRunSummary } from "./../types.js";

interface ActionOptions {
	cwd: string;
	questId: string;
	runId: string;
}

function loadPausedSummary(opts: ActionOptions): BackgroundRunSummary | undefined {
	const summaryPath = path.join(
		opts.cwd,
		".pi",
		"quests",
		opts.questId,
		"runs",
		`${opts.runId}.json`,
	);
	return readJsonIfExists<BackgroundRunSummary>(summaryPath);
}

/**
 * Discard a Paused Run: remove its worktree, flip the summary to `cancelled`.
 * No merge to the Quest Branch — the work is thrown away.
 */
export async function discardRun(opts: ActionOptions): Promise<void> {
	const summary = loadPausedSummary(opts);
	if (!summary) return; // already discarded / missing — no-op

	if (summary.status !== "paused") {
		throw new Error(
			`discardRun: run ${opts.runId} is not paused (status=${summary.status}).`,
		);
	}

	if (summary.worktreePath) {
		try {
			await removeRunWorktree(summary.worktreePath);
		} catch {
			/* best-effort */
		}
	}

	const completedAt = new Date().toISOString();
	const updated: BackgroundRunSummary = {
		...summary,
		status: "cancelled",
		updatedAt: completedAt,
		completedAt,
	};
	writeJson(summary.statusPath, updated);
}

/**
 * Force-Complete a Paused Run: merge the Run Branch into the Quest Branch as-is,
 * flip the summary to `completed`, and remove the worktree on success.
 *
 * On merge conflict, the run stays paused (the user can still Discard), and a
 * halt-tier `merge_conflict` anomaly is appended — same handling as the normal
 * completion-path merge in {@link mergeCompletedRun}.
 */
export async function forceCompleteRun(opts: ActionOptions): Promise<void> {
	const summary = loadPausedSummary(opts);
	if (!summary) {
		throw new Error(`forceCompleteRun: run ${opts.runId} not found.`);
	}
	if (summary.status !== "paused") {
		throw new Error(
			`forceCompleteRun: run ${opts.runId} is not paused (status=${summary.status}).`,
		);
	}
	if (!summary.runBranch || !summary.questBranch) {
		throw new Error(
			`forceCompleteRun: run ${opts.runId} missing runBranch/questBranch — cannot merge.`,
		);
	}

	let result: { ok: boolean; conflict?: string };
	try {
		result = await mergeRunBranchIntoQuest({
			repoRoot: opts.cwd,
			questBranch: summary.questBranch,
			runBranch: summary.runBranch,
		});
	} catch (err) {
		result = { ok: false, conflict: err instanceof Error ? err.message : String(err) };
	}

	if (result.ok) {
		// Flip summary to completed.
		const completedAt = new Date().toISOString();
		const updated: BackgroundRunSummary = {
			...summary,
			status: "completed",
			updatedAt: completedAt,
			completedAt,
		};
		writeJson(summary.statusPath, updated);
		// Tidy: remove the worktree now that its work has landed.
		if (summary.worktreePath) {
			try {
				await removeRunWorktree(summary.worktreePath);
			} catch {
				/* best-effort */
			}
		}
		return;
	}

	// Conflict path — emit halt-tier merge_conflict, keep run paused.
	const questDir = path.join(opts.cwd, ".pi", "quests", opts.questId);
	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	const event = validateEvent({
		event: "anomaly_detected",
		timestamp: new Date().toISOString(),
		questId: opts.questId,
		runId: opts.runId,
		tier: "halt",
		rule: "merge_conflict",
		should_pause: false,
		details: {
			workItemId: summary.workItemId,
			runBranch: summary.runBranch,
			questBranch: summary.questBranch,
			conflict: result.conflict ?? "",
			source: "force_complete",
		},
	});
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
}

/**
 * Resume a Paused Run: spawn a new Run with a continuation packet in the
 * paused Run's worktree, on the same Run Branch.
 *
 * The acknowledgment is forwarded to {@link resumeRun}, which embeds it into
 * the packet section 2 and the `run_resumed` audit event. Empty input is
 * accepted; the default fallback text is applied inside `resumeRun`.
 */
export async function resumeRunAction(opts: ActionOptions & { acknowledgment: string }): Promise<void> {
	const summary = loadPausedSummary(opts);
	if (!summary) {
		throw new Error(`resumeRunAction: run ${opts.runId} not found.`);
	}
	if (summary.status !== "paused") {
		throw new Error(
			`resumeRunAction: run ${opts.runId} is not paused (status=${summary.status}).`,
		);
	}
	await resumeRun({
		cwd: opts.cwd,
		questId: opts.questId,
		pausedRunId: opts.runId,
		acknowledgment: opts.acknowledgment,
	});
}
