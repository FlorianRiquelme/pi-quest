/**
 * Pure rendering for the Hearth Widget — see ADR 013.
 *
 * Takes a `WidgetSnapshot` plus render options (width, theme, true-color
 * capability, current pulse phase 0..1) and produces the two output lines.
 *
 * Color path:
 *   - trueColor=true  → emit raw 24-bit ANSI (`ESC[38;2;R;G;Bm…ESC[39m`),
 *     modulated by `pulsePhase` (only for pulsing moods).
 *   - trueColor=false → fall back to the theme's named colors via `theme.fg`,
 *     ignoring `pulsePhase` entirely (no pulse animation in fallback mode).
 */

import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { selectMood, moodColor, moodGlyph, moodPulses, type Mood } from './widget-mood.js';
import { formatTwoClocks } from './two-clocks.js';
import type { WidgetSnapshot } from './widget-cache.js';

export interface RenderOptions {
	width: number;
	theme: Pick<Theme, 'fg' | 'bold'>;
	trueColor: boolean;
	/** 0..1 — only used in true-color path, only for pulsing moods. */
	pulsePhase: number;
	/**
	 * Optional override for the mood to render with. When omitted, the mood is
	 * derived from the snapshot directly. The widget's debounce layer uses
	 * this to keep `displayed` mood stable across brief candidate flips.
	 */
	moodOverride?: Mood;
}

/* ============================ Terminal capability ============================ */

export function detectTrueColor(): boolean {
	const colorterm = process.env.COLORTERM;
	if (colorterm === 'truecolor' || colorterm === '24bit') return true;
	if (process.env.WT_SESSION) return true;
	return false;
}

/* ============================ Color helpers ============================ */

const RESET_FG = '\x1b[39m';

function ansiTrueColor(r: number, g: number, b: number, text: string): string {
	return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m${text}${RESET_FG}`;
}

/**
 * Pulse modulation: cosine-shaped 0.7..1.0 swing over `pulsePhase` 0..1.
 * Keeps the text readable (never goes below 70% of the base color).
 */
function pulseScale(pulsePhase: number): number {
	const cos = Math.cos(2 * Math.PI * pulsePhase);
	return 0.85 + 0.15 * cos; // 0.7..1.0
}

/** Mood → named theme color used in the fallback (non-truecolor) path. */
const MOOD_FALLBACK_COLOR: Record<Mood, ThemeColor> = {
	resting: 'dim',
	cruising: 'accent',
	working_hard: 'warning',
	stuck: 'warning', // amber-ish in most themes
	needs_you: 'success',
};

function colorize(
	mood: Mood,
	text: string,
	opts: RenderOptions,
): string {
	if (opts.trueColor && moodPulses(mood)) {
		const { r, g, b } = moodColor(mood);
		const scale = pulseScale(opts.pulsePhase);
		return ansiTrueColor(r * scale, g * scale, b * scale, text);
	}
	if (opts.trueColor) {
		const { r, g, b } = moodColor(mood);
		return ansiTrueColor(r, g, b, text);
	}
	// Fallback: theme.fg with a named theme color. No pulse.
	return opts.theme.fg(MOOD_FALLBACK_COLOR[mood], text);
}

/* ============================ Mood selection from snapshot ============================ */

export function selectMoodFromSnapshot(s: WidgetSnapshot): Mood {
	return selectMood({
		hasActiveQuest: s.hasActiveQuest,
		status: s.status,
		activeRunCount: s.activeRunCount,
		lastSyntheticBeatAt: s.lastSyntheticBeatAt,
		lastSemanticBeatAt: s.lastSemanticBeatAt,
		lastLowConfidenceBeatAt: s.lastLowConfidenceBeatAt,
		lastRetrySignalAt: s.lastRetrySignalAt,
		hasPausedRun: s.hasPausedRun,
		softFreeze: s.softFreeze,
		now: s.now,
	});
}

/* ============================ Assembly ============================ */

const STATUS_WORD: Record<Mood, string> = {
	resting: 'resting',
	cruising: 'cruising',
	working_hard: 'working hard',
	stuck: 'stuck',
	needs_you: 'needs you',
};

export function assembleWidgetLines(
	snapshot: WidgetSnapshot,
	opts: RenderOptions,
): [string, string] {
	const mood = opts.moodOverride ?? selectMoodFromSnapshot(snapshot);
	const glyph = moodGlyph(mood);

	/* -------- Line 1: title + mood word -------- */
	if (!snapshot.hasActiveQuest) {
		const prompt = opts.theme.fg('dim', 'No active quest — /quest intake <handoff.md>');
		const line2 = colorize(mood, `  ${glyph} ${STATUS_WORD[mood]}`, opts);
		return [
			truncateToWidth(prompt, opts.width),
			truncateToWidth(line2, opts.width),
		];
	}

	const prefix = opts.theme.fg('dim', 'Active: ');
	const moodWord = colorize(mood, STATUS_WORD[mood], opts);
	const sep = opts.theme.fg('dim', ' — ');
	const prefixW = visibleWidth(prefix);
	const moodWordW = visibleWidth(moodWord);
	const sepW = visibleWidth(sep);
	const titleMaxW = Math.max(0, opts.width - prefixW - sepW - moodWordW);
	const title = truncateToWidth(opts.theme.fg('text', snapshot.title), titleMaxW);
	const line1 = prefix + title + sep + moodWord;

	/* -------- Line 2: glyph + run summary + clocks --------
	 *
	 * Soft-freeze override (M3-2 / ADR 013 §8): when the quest is soft-frozen,
	 * replace the standard run summary with `❄ frozen · N runs completing ·
	 * Ctrl+P to release`. Clocks still render to keep the Two Clocks signal
	 * available. Mood is Resting in this branch.
	 */
	const glyphPart = colorize(mood, `  ${glyph} `, opts);
	const detailParts: string[] = [];
	if (snapshot.softFreeze) {
		const inFlight = snapshot.runningCount;
		const wordRuns = inFlight === 1 ? 'run' : 'runs';
		detailParts.push(opts.theme.fg('accent', '❄ frozen'));
		detailParts.push(
			opts.theme.fg('dim', `${inFlight} ${wordRuns} completing`),
		);
		detailParts.push(opts.theme.fg('dim', 'Ctrl+P to release'));
	} else {
		if (snapshot.runningCount > 0) {
			detailParts.push(opts.theme.fg('warning', `${snapshot.runningCount} running`));
		}
		if (snapshot.totalCount > 0) {
			detailParts.push(
				opts.theme.fg('dim', `${snapshot.completedCount}/${snapshot.totalCount} done`),
			);
		}
	}

	if (snapshot.showClocks) {
		detailParts.push(
			opts.theme.fg('dim', formatTwoClocks(snapshot.wallMs, snapshot.computeMs)),
		);
	}

	const detailJoined = detailParts.join(opts.theme.fg('dim', '  •  '));
	const line2 = glyphPart + detailJoined;
	return [line1, truncateToWidth(line2, opts.width)];
}
