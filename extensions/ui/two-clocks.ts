/**
 * Two Clocks — see ADR 013, §4.
 *
 * Wall    = first `stage_entered: executing` → terminal status (or now)
 * Compute = sum of (run_finished − run_started) pairs by runId
 *
 * Hidden before `executing` is ever entered. Frozen at terminal status.
 * Human-friendly format: `<1m` | `<M>m` | `<H>h <M>m`.
 */

import type { QuestEvent } from '../events.js';

export interface ClocksInput {
	status: string;
	events: QuestEvent[];
	now: number;
}

/** Statuses for which clocks remain hidden (pre-`executing`). */
const PRE_EXECUTING = new Set([
	'intake',
	'recon-ready',
	'reviewing',
	'needs-resolution',
	'resolved',
	'planned',
	'launch-review',
]);

/** Terminal statuses — Wall freezes at the stage_entered timestamp for these. */
const TERMINAL = new Set(['completed', 'uat-failed', 'blocked', 'cancelled', 'archived']);

export function shouldShowClocks(status: string, events: QuestEvent[]): boolean {
	if (PRE_EXECUTING.has(status)) return false;
	// For all post-`executing` states, confirm that `stage_entered: executing` has fired at least once
	// (defensive — generally the workflow guarantees it).
	if (status === 'executing') return true;
	return events.some((e) => e.event === 'stage_entered' && e.to === 'executing');
}

export function computeWall(input: ClocksInput): number {
	const firstExecuting = input.events.find(
		(e) => e.event === 'stage_entered' && e.to === 'executing',
	);
	if (!firstExecuting) return 0;
	const start = new Date(firstExecuting.timestamp).getTime();

	if (TERMINAL.has(input.status)) {
		// Freeze Wall at the timestamp of the stage_entered event into this terminal status.
		// Walk events in order; the last `stage_entered` whose `to` is a terminal status is the
		// freeze point. If multiple terminal entries exist, take the most recent one.
		let frozenAt: number | undefined;
		for (const e of input.events) {
			if (e.event === 'stage_entered' && TERMINAL.has(e.to)) {
				frozenAt = new Date(e.timestamp).getTime();
			}
		}
		if (frozenAt !== undefined) return Math.max(0, frozenAt - start);
	}

	return Math.max(0, input.now - start);
}

export function computeCompute(events: QuestEvent[]): number {
	const startedAt = new Map<string, number>();
	let total = 0;
	for (const e of events) {
		if (e.event === 'run_started') {
			startedAt.set(e.runId, new Date(e.timestamp).getTime());
		} else if (e.event === 'run_finished') {
			const start = startedAt.get(e.runId);
			if (start !== undefined) {
				total += Math.max(0, new Date(e.timestamp).getTime() - start);
				startedAt.delete(e.runId);
			}
		}
	}
	return total;
}

export function formatDuration(ms: number): string {
	if (ms < 60_000) return '<1m';
	const totalMinutes = Math.floor(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	return `${hours}h ${minutes}m`;
}

export function formatTwoClocks(wallMs: number, computeMs: number): string {
	return `${formatDuration(wallMs)} / ${formatDuration(computeMs)}`;
}
