/**
 * Hearth Widget — persistent 2-line ambient display above the editor.
 *
 * See ADR 013 for the design (5 moods, brightness-earned, pulse only when
 * alive and working, Two Clocks, 250ms cache, terminal capability fallback).
 *
 * Implementation split:
 *   - `widget-mood.ts`   — pure mood selection
 *   - `two-clocks.ts`    — pure clock math and formatting
 *   - `widget-data.ts`   — filesystem reads → WidgetSnapshot
 *   - `widget-cache.ts`  — 250ms TTL cache
 *   - `widget-render.ts` — pure rendering (lines + colors)
 *
 * This file is the thin glue: it wires the factory into pi's setWidget API,
 * owns the pulse interval, and triggers TUI re-renders.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { selectMoodFromSnapshot, assembleWidgetLines, detectTrueColor } from './widget-render.js';
import { collectWidgetSnapshot } from './widget-data.js';
import { WidgetCache, type MoodTransitionState } from './widget-cache.js';
import { moodPulses, moodPulsePeriodMs, type Mood } from './widget-mood.js';

/* ============================ Transition debounce ============================ */

const MOOD_DEBOUNCE_MS = 1500;

/**
 * Debounce mood transitions between Cruising and Working hard so a brief
 * activity spike does not cause flicker.
 *
 * - Transitions involving Needs-you, Resting, or Stuck are immediate (those
 *   moods carry meaning the user needs to see right away).
 * - Transitions between Cruising and Working hard wait `MOOD_DEBOUNCE_MS` of
 *   sustained candidate before flipping `displayed`.
 */
export function nextDisplayedMood(
	state: MoodTransitionState,
	candidate: Mood,
	now: number,
): MoodTransitionState {
	if (candidate === state.displayed) {
		return { displayed: state.displayed, candidate, candidateSinceMs: now };
	}

	const isCruisingWorkingPair =
		(state.displayed === 'cruising' && candidate === 'working_hard') ||
		(state.displayed === 'working_hard' && candidate === 'cruising');

	if (!isCruisingWorkingPair) {
		// Immediate flip — every other transition.
		return { displayed: candidate, candidate, candidateSinceMs: now };
	}

	// Track how long the candidate has been different.
	const newSince =
		state.candidate === candidate ? state.candidateSinceMs : now;

	if (now - newSince >= MOOD_DEBOUNCE_MS) {
		return { displayed: candidate, candidate, candidateSinceMs: now };
	}
	return { displayed: state.displayed, candidate, candidateSinceMs: newSince };
}

/* ============================ Widget factory ============================ */

export function setQuestWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget(
		'quest',
		(tui, theme) => {
			const cache = new WidgetCache(() => collectWidgetSnapshot(ctx.cwd, Date.now()));
			const trueColor = detectTrueColor();

			let transition: MoodTransitionState | undefined;
			let pulseTimer: NodeJS.Timeout | undefined;
			let currentPulseStartMs = Date.now();
			let currentPulsingMood: Mood | undefined;

			const stopPulse = () => {
				if (pulseTimer) {
					clearInterval(pulseTimer);
					pulseTimer = undefined;
				}
				currentPulsingMood = undefined;
			};

			const startPulse = (mood: Mood) => {
				stopPulse();
				if (!trueColor) return; // No pulse in fallback mode.
				if (!moodPulses(mood)) return;
				currentPulsingMood = mood;
				currentPulseStartMs = Date.now();
				const tick = 50; // 50ms granularity → smooth animation
				const timer = setInterval(() => {
					tui.requestRender();
				}, tick);
				if (typeof (timer as { unref?: () => void }).unref === 'function') {
					(timer as { unref?: () => void }).unref!();
				}
				pulseTimer = timer;
			};

			const computePulsePhase = (mood: Mood, now: number): number => {
				const period = moodPulsePeriodMs(mood);
				if (period <= 0) return 0;
				return ((now - currentPulseStartMs) % period) / period;
			};

			return {
				render: (width: number) => {
					const snap = cache.get();
					const now = Date.now();
					const candidate = selectMoodFromSnapshot(snap);

					if (!transition) {
						transition = { displayed: candidate, candidate, candidateSinceMs: now };
					} else {
						transition = nextDisplayedMood(transition, candidate, now);
					}
					const mood = transition.displayed;

					// Manage pulse timer lifecycle. If the displayed mood pulses, ensure
					// the timer is running for it; otherwise stop the timer.
					if (moodPulses(mood) && trueColor) {
						if (currentPulsingMood !== mood) startPulse(mood);
					} else if (pulseTimer) {
						stopPulse();
					}

					const pulsePhase = computePulsePhase(mood, now);

					// Render using the displayed mood — possibly one debounce-tick behind
					// the candidate to suppress brief Cruising ↔ Working-hard flicker.
					return assembleWidgetLines(snap, {
						width,
						theme,
						trueColor,
						pulsePhase,
						moodOverride: mood,
					});
				},
				invalidate: () => {
					cache.invalidate();
				},
				dispose: () => {
					stopPulse();
				},
			};
		},
		{ placement: 'aboveEditor' },
	);
}

export function clearQuestWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget('quest', undefined);
}
