/**
 * Filesystem reads that produce a `WidgetSnapshot` for the Hearth Widget.
 *
 * Reads the active quest's workflow, run summaries, and event log. The
 * resulting snapshot is consumed by `widget-render.ts`. The 250ms cache
 * (`WidgetCache`) wraps this function so the file scan does not happen on
 * every pulse tick.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { questDirPath } from '../paths.js';
import { loadCurrentState, loadQuestWorkflow } from '../state.js';
import { listRunSummaries } from '../runs/runner.js';
import { readQuestEvents } from './data.js';
import { computeWall, computeCompute, shouldShowClocks } from './two-clocks.js';
import type { WidgetSnapshot } from './widget-cache.js';

export function collectWidgetSnapshot(cwd: string, now: number): WidgetSnapshot {
	const state = loadCurrentState(cwd);
	const questId = state.currentQuestId;
	if (!questId) {
		return emptySnapshot(now);
	}
	const qDir = questDirPath(cwd, questId);
	const workflow = loadQuestWorkflow(qDir);
	if (!workflow) {
		return emptySnapshot(now);
	}

	const events = readQuestEvents(cwd, questId);
	const runs = listRunSummaries(qDir);
	const runningCount = runs.filter((r) => r.status === 'running').length;
	const totalCount = countWorkItemFiles(qDir);
	const completedCount = countCompletedWorkItemsFromRuns(qDir, runs);

	// Beat aggregates
	let lastSyntheticBeatAt: number | undefined;
	let lastSemanticBeatAt: number | undefined;
	let lastLowConfidenceBeatAt: number | undefined;
	let lastRetrySignalAt: number | undefined;
	let hasPausedRun = false;

	for (const e of events) {
		if (e.event === 'progress_beat') {
			const ts = new Date(e.timestamp).getTime();
			if (e.phase === 'alive') {
				if (lastSyntheticBeatAt === undefined || ts > lastSyntheticBeatAt) {
					lastSyntheticBeatAt = ts;
				}
			} else {
				if (lastSemanticBeatAt === undefined || ts > lastSemanticBeatAt) {
					lastSemanticBeatAt = ts;
				}
			}
			if (typeof e.confidence === 'number' && e.confidence < 0.5) {
				if (
					lastLowConfidenceBeatAt === undefined ||
					ts > lastLowConfidenceBeatAt
				) {
					lastLowConfidenceBeatAt = ts;
				}
			}
		} else if (e.event === 'rescue_invoked') {
			const ts = new Date(e.timestamp).getTime();
			if (lastRetrySignalAt === undefined || ts > lastRetrySignalAt) {
				lastRetrySignalAt = ts;
			}
		} else if (e.event === 'anomaly_detected' && e.tier === 'pause') {
			// Pause-tier anomaly produces a paused run (ADR 014). The event log
			// and the run summary are both sources of truth; we check both.
			hasPausedRun = true;
		}
	}

	// Also surface paused runs from the run summary if any run carries an
	// explicit `paused` status (ADR 014 / M3-3).
	for (const r of runs) {
		if (r.status === 'paused') {
			hasPausedRun = true;
		}
	}

	// Soft freeze flag — M3-2 will wire `freeze.mode === "soft"` onto the
	// workflow. For M3-1 we look for the field optimistically.
	const softFreeze =
		(workflow as unknown as { freeze?: { mode?: string } }).freeze?.mode === 'soft';

	const wallMs = computeWall({ status: workflow.status, events, now });
	const computeMs = computeCompute(events);
	const showClocks = shouldShowClocks(workflow.status, events);

	return {
		hasActiveQuest: true,
		title: workflow.title,
		status: workflow.status,
		questId: workflow.id,
		runningCount,
		completedCount,
		totalCount,
		activeRunCount: runningCount,
		lastSyntheticBeatAt,
		lastSemanticBeatAt,
		lastLowConfidenceBeatAt,
		lastRetrySignalAt,
		hasPausedRun,
		softFreeze,
		wallMs,
		computeMs,
		showClocks,
		now,
	};
}

function emptySnapshot(now: number): WidgetSnapshot {
	return {
		hasActiveQuest: false,
		title: '',
		status: '',
		questId: '',
		runningCount: 0,
		completedCount: 0,
		totalCount: 0,
		activeRunCount: 0,
		lastSyntheticBeatAt: undefined,
		lastSemanticBeatAt: undefined,
		lastLowConfidenceBeatAt: undefined,
		lastRetrySignalAt: undefined,
		hasPausedRun: false,
		softFreeze: false,
		wallMs: 0,
		computeMs: 0,
		showClocks: false,
		now,
	};
}

function countWorkItemFiles(qDir: string): number {
	const dir = path.join(qDir, 'work-items');
	if (!fs.existsSync(dir)) return 0;
	return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
}

function countCompletedWorkItemsFromRuns(
	qDir: string,
	runs: ReturnType<typeof listRunSummaries>,
): number {
	const dir = path.join(qDir, 'work-items');
	if (!fs.existsSync(dir)) return 0;
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
	let completed = 0;
	for (const file of files) {
		const itemId = file.replace(/\.md$/, '');
		const itemRuns = runs.filter((r) => r.workItemId === itemId);
		const latest = itemRuns.at(-1);
		if (latest?.status === 'completed') completed++;
	}
	return completed;
}
