/**
 * 250ms TTL cache for widget state — see ADR 013, §5 Pulse cost cap.
 *
 * Pulse animation re-renders at up to 2Hz (every 500ms), but the visual pulse
 * itself ticks faster (~50ms granularity). We cache the assembled snapshot so a
 * full event-log scan does not happen on every pulse frame; only the colour
 * recomputation runs at pulse rate.
 */

import type { Mood } from './widget-mood.js';

export interface WidgetSnapshot {
	hasActiveQuest: boolean;
	title: string;
	status: string;
	questId: string;

	// Counts used for line 2 detail + mood selection
	runningCount: number;
	completedCount: number;
	totalCount: number;
	activeRunCount: number;

	// Beat aggregates (epoch-ms) used for mood selection
	lastSyntheticBeatAt: number | undefined;
	lastSemanticBeatAt: number | undefined;
	lastLowConfidenceBeatAt: number | undefined;
	lastRetrySignalAt: number | undefined;

	hasPausedRun: boolean;
	softFreeze: boolean;

	// Two Clocks
	wallMs: number;
	computeMs: number;
	showClocks: boolean;

	now: number;
}

export interface MoodTransitionState {
	/** Mood currently being shown to the user. */
	displayed: Mood;
	/** Last-seen "candidate" mood (what selectMood would return now). */
	candidate: Mood;
	/** When `candidate` first started differing from `displayed`. */
	candidateSinceMs: number;
}

const TTL_MS = 250;

export class WidgetCache {
	private value: WidgetSnapshot | undefined;
	private mtime = 0;
	private readonly recompute: () => WidgetSnapshot;

	constructor(recompute: () => WidgetSnapshot) {
		this.recompute = recompute;
	}

	get(): WidgetSnapshot {
		const now = Date.now();
		if (this.value && now - this.mtime < TTL_MS) {
			return this.value;
		}
		this.value = this.recompute();
		this.mtime = now;
		return this.value;
	}

	/** Force the next call to `get()` to recompute. */
	invalidate(): void {
		this.mtime = 0;
	}
}
