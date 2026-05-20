/**
 * Pure mood selection for the Hearth Widget — see ADR 013.
 *
 * Five moods: resting, cruising, working_hard, stuck, needs_you.
 *
 * Priority order (first match wins):
 *   1. Needs you — interactive-stage entry, paused run.
 *   2. Resting — no active quest, or soft-freeze.
 *   3. Stuck — synthetic-fresh but semantic-stale (>5 min).
 *   4. Working hard — high activity (runs ≥ 2, low confidence, retries).
 *   5. Cruising — default while executing autonomously.
 *
 * Mood selection is a pure function over a `MoodInput` snapshot so that
 * tests can exercise every branch without touching the filesystem.
 */

export type Mood = 'resting' | 'cruising' | 'working_hard' | 'stuck' | 'needs_you';

export interface MoodInput {
	hasActiveQuest: boolean;
	/** Workflow status (string so we tolerate `launch-review` before lib.ts adds it). */
	status: string;
	activeRunCount: number;
	/** Epoch-ms timestamp of the most recent synthetic ("alive") progress_beat. */
	lastSyntheticBeatAt: number | undefined;
	/** Epoch-ms timestamp of the most recent semantic (non-"alive") progress_beat. */
	lastSemanticBeatAt: number | undefined;
	/** Epoch-ms timestamp of the most recent beat with `confidence < 0.5`. */
	lastLowConfidenceBeatAt: number | undefined;
	/** Epoch-ms timestamp of the most recent rescue_invoked event (retry proxy). */
	lastRetrySignalAt: number | undefined;
	hasPausedRun: boolean;
	softFreeze: boolean;
	now: number;
}

const FIVE_MIN_MS = 5 * 60_000;
const TWO_MIN_MS = 2 * 60_000;

/** Statuses that structurally require user input. */
const NEEDS_YOU_STATUSES = new Set([
	'launch-review',
	'recon-ready',
	'verification-ready',
	'uat-ready',
]);

export function selectMood(input: MoodInput): Mood {
	// 1. Needs you wins above all else
	if (NEEDS_YOU_STATUSES.has(input.status)) return 'needs_you';
	if (input.hasPausedRun) return 'needs_you';

	// 2. Resting if no active quest or soft-freeze
	if (!input.hasActiveQuest) return 'resting';
	if (input.softFreeze) return 'resting';

	// 3. Stuck: synthetic-fresh + semantic-stale (both observed; semantic > 5 min)
	if (
		input.lastSyntheticBeatAt !== undefined &&
		input.lastSemanticBeatAt !== undefined &&
		input.now - input.lastSyntheticBeatAt <= FIVE_MIN_MS &&
		input.now - input.lastSemanticBeatAt > FIVE_MIN_MS
	) {
		return 'stuck';
	}

	// 4. Working hard
	if (input.activeRunCount >= 2) return 'working_hard';
	if (
		input.lastLowConfidenceBeatAt !== undefined &&
		input.now - input.lastLowConfidenceBeatAt <= TWO_MIN_MS
	) {
		return 'working_hard';
	}
	if (
		input.lastRetrySignalAt !== undefined &&
		input.now - input.lastRetrySignalAt <= TWO_MIN_MS
	) {
		return 'working_hard';
	}

	// 5. Cruising — default for autonomous stages
	return 'cruising';
}

/* ============================ Glyphs ============================ */

const GLYPHS: Record<Mood, string> = {
	resting: '·',
	cruising: '◌',
	working_hard: '●',
	stuck: '!',
	needs_you: '►',
};

export function moodGlyph(mood: Mood): string {
	return GLYPHS[mood];
}

/* ============================ Colors ============================ */

export interface RGB {
	r: number;
	g: number;
	b: number;
}

/**
 * 24-bit color per mood, brightness-earned (Resting dim, Needs-you bright).
 *
 * Resting:        dim grey               L ≈ 0.110
 * Cruising:       soft blue              L ≈ 0.246
 * Working hard:   warm amber             L ≈ 0.421
 * Stuck:          yellow                 L ≈ 0.674
 * Needs you:      green                  L ≈ 0.585
 *
 * All four "active" moods are observably brighter than Resting.
 */
const COLORS: Record<Mood, RGB> = {
	resting: { r: 90, g: 90, b: 90 },
	cruising: { r: 100, g: 140, b: 200 },
	working_hard: { r: 230, g: 160, b: 80 },
	stuck: { r: 230, g: 210, b: 70 },
	needs_you: { r: 100, g: 220, b: 140 },
};

export function moodColor(mood: Mood): RGB {
	return COLORS[mood];
}

/**
 * Relative luminance (sRGB → linear → weighted by the standard ITU-R BT.709
 * coefficients). Used only for test assertions; widget rendering itself
 * does not need this number.
 */
export function relativeLuminance(rgb: RGB): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/* ============================ Misc ============================ */

/** Whether the mood should breathe / pulse. Only Cruising and Working hard. */
export function moodPulses(mood: Mood): boolean {
	return mood === 'cruising' || mood === 'working_hard';
}

/** Pulse period in ms for moods that pulse. */
export function moodPulsePeriodMs(mood: Mood): number {
	if (mood === 'cruising') return 1000; // ~1Hz
	if (mood === 'working_hard') return 500; // ~2Hz
	return 0;
}
