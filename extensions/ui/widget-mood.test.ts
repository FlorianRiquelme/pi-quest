/**
 * Mood selection tests — see ADR 013, §1 Five-mood vocabulary.
 *
 * Mood selection is a pure function over:
 *   - workflow status
 *   - recent progress_beat timestamps (synthetic vs semantic)
 *   - run counts and retries
 *   - soft-freeze flag
 *
 * Priority order (first match wins):
 *   1. Needs you — interactive-stage entry, paused run, etc.
 *   2. Resting — no active quest, or soft-freeze
 *   3. Stuck — synthetic-fresh but semantic-stale (>5 min)
 *   4. Working hard — high activity (runs ≥ 2, low confidence, retries)
 *   5. Cruising — autonomous stage in progress
 */

import { describe, it, expect } from 'vitest';
import { selectMood, moodColor, moodGlyph, relativeLuminance, type MoodInput, type Mood } from './widget-mood.js';

const t = (mins: number) => new Date(Date.UTC(2026, 0, 1, 12, mins, 0)).toISOString();

const NOW = new Date(Date.UTC(2026, 0, 1, 12, 30, 0)).getTime();
const ONE_MIN = 60_000;

function input(partial: Partial<MoodInput>): MoodInput {
  return {
    hasActiveQuest: true,
    status: 'executing',
    activeRunCount: 0,
    lastSyntheticBeatAt: undefined,
    lastSemanticBeatAt: undefined,
    lastLowConfidenceBeatAt: undefined,
    lastRetrySignalAt: undefined,
    hasPausedRun: false,
    softFreeze: false,
    now: NOW,
    ...partial,
  };
}

describe('selectMood', () => {
  describe('Resting', () => {
    it('activates when no active quest', () => {
      expect(selectMood(input({ hasActiveQuest: false }))).toBe('resting');
    });

    it('activates under soft-freeze', () => {
      expect(selectMood(input({ softFreeze: true, activeRunCount: 1 }))).toBe('resting');
    });
  });

  describe('Needs you', () => {
    it('activates on launch-review', () => {
      expect(selectMood(input({ status: 'launch-review' }))).toBe('needs_you');
    });

    it('activates on recon-ready', () => {
      expect(selectMood(input({ status: 'recon-ready' }))).toBe('needs_you');
    });

    it('activates on uat-ready', () => {
      expect(selectMood(input({ status: 'uat-ready' }))).toBe('needs_you');
    });

    it('activates on verification-ready', () => {
      expect(selectMood(input({ status: 'verification-ready' }))).toBe('needs_you');
    });

    it('activates when there is a paused run', () => {
      expect(selectMood(input({ hasPausedRun: true }))).toBe('needs_you');
    });

    it('takes priority over working-hard', () => {
      // High activity (2 runs) + interactive-stage entry → Needs you wins
      expect(
        selectMood(input({ status: 'uat-ready', activeRunCount: 3 })),
      ).toBe('needs_you');
    });
  });

  describe('Stuck', () => {
    it('activates when synthetic beat is fresh and semantic beat is stale (> 5 min)', () => {
      const synthetic = NOW - 30_000; // 30s ago
      const semantic = NOW - 6 * ONE_MIN; // 6 min ago
      expect(
        selectMood(
          input({
            lastSyntheticBeatAt: synthetic,
            lastSemanticBeatAt: semantic,
          }),
        ),
      ).toBe('stuck');
    });

    it('does NOT activate when no semantic beat has ever fired', () => {
      // Falls through — Cruising (autonomous stage, executing)
      const synthetic = NOW - 30_000;
      expect(
        selectMood(
          input({
            lastSyntheticBeatAt: synthetic,
            lastSemanticBeatAt: undefined,
          }),
        ),
      ).not.toBe('stuck');
    });

    it('does NOT activate when synthetic beat is also stale', () => {
      const synthetic = NOW - 10 * ONE_MIN;
      const semantic = NOW - 12 * ONE_MIN;
      expect(
        selectMood(
          input({
            lastSyntheticBeatAt: synthetic,
            lastSemanticBeatAt: semantic,
          }),
        ),
      ).not.toBe('stuck');
    });

    it('does NOT activate when semantic beat is younger than 5 min', () => {
      const synthetic = NOW - 30_000;
      const semantic = NOW - 4 * ONE_MIN;
      expect(
        selectMood(
          input({
            lastSyntheticBeatAt: synthetic,
            lastSemanticBeatAt: semantic,
          }),
        ),
      ).not.toBe('stuck');
    });
  });

  describe('Working hard', () => {
    it('activates when activeRunCount ≥ 2', () => {
      expect(selectMood(input({ activeRunCount: 2 }))).toBe('working_hard');
    });

    it('activates when a recent beat has confidence < 0.5', () => {
      expect(
        selectMood(
          input({
            activeRunCount: 1,
            lastLowConfidenceBeatAt: NOW - 30_000,
          }),
        ),
      ).toBe('working_hard');
    });

    it('activates on a retry signal in the last 2 min', () => {
      expect(
        selectMood(
          input({
            activeRunCount: 1,
            lastRetrySignalAt: NOW - 60_000,
          }),
        ),
      ).toBe('working_hard');
    });

    it('does NOT activate when low-confidence beat is older than 2 min', () => {
      expect(
        selectMood(
          input({
            activeRunCount: 1,
            lastLowConfidenceBeatAt: NOW - 3 * ONE_MIN,
          }),
        ),
      ).toBe('cruising');
    });
  });

  describe('Cruising', () => {
    it('is the default when executing autonomously with 1 run', () => {
      expect(selectMood(input({ activeRunCount: 1 }))).toBe('cruising');
    });

    it('is the mood for autonomous verification', () => {
      expect(selectMood(input({ status: 'verification', activeRunCount: 1 }))).toBe('cruising');
    });
  });

  describe('priority ordering', () => {
    it('Needs you beats Working hard', () => {
      expect(
        selectMood(
          input({ status: 'uat-ready', activeRunCount: 5 }),
        ),
      ).toBe('needs_you');
    });

    it('Resting (soft freeze) beats Working hard', () => {
      expect(
        selectMood(input({ softFreeze: true, activeRunCount: 3 })),
      ).toBe('resting');
    });

    it('Working hard beats Cruising', () => {
      expect(
        selectMood(input({ activeRunCount: 2 })),
      ).toBe('working_hard');
    });
  });
});

describe('moodGlyph — accessibility', () => {
  it('returns · for resting', () => {
    expect(moodGlyph('resting')).toBe('·');
  });
  it('returns ◌ for cruising', () => {
    expect(moodGlyph('cruising')).toBe('◌');
  });
  it('returns ● for working hard', () => {
    expect(moodGlyph('working_hard')).toBe('●');
  });
  it('returns ! for stuck', () => {
    expect(moodGlyph('stuck')).toBe('!');
  });
  it('returns ► for needs you', () => {
    expect(moodGlyph('needs_you')).toBe('►');
  });
});

describe('moodColor — brightness-earned', () => {
  it('returns a 24-bit RGB triple for each mood', () => {
    const moods: Mood[] = ['resting', 'cruising', 'working_hard', 'stuck', 'needs_you'];
    for (const m of moods) {
      const c = moodColor(m);
      expect(c.r).toBeGreaterThanOrEqual(0);
      expect(c.r).toBeLessThanOrEqual(255);
      expect(c.g).toBeGreaterThanOrEqual(0);
      expect(c.g).toBeLessThanOrEqual(255);
      expect(c.b).toBeGreaterThanOrEqual(0);
      expect(c.b).toBeLessThanOrEqual(255);
    }
  });

  it('Resting is dimmer than Needs-you', () => {
    expect(relativeLuminance(moodColor('resting'))).toBeLessThan(
      relativeLuminance(moodColor('needs_you')),
    );
  });

  it('Resting is dimmer than Cruising', () => {
    expect(relativeLuminance(moodColor('resting'))).toBeLessThan(
      relativeLuminance(moodColor('cruising')),
    );
  });

  it('Working hard is brighter than Cruising', () => {
    expect(relativeLuminance(moodColor('working_hard'))).toBeGreaterThan(
      relativeLuminance(moodColor('cruising')),
    );
  });

  it('Resting is the dimmest of all moods', () => {
    const moods: Mood[] = ['cruising', 'working_hard', 'stuck', 'needs_you'];
    const restingL = relativeLuminance(moodColor('resting'));
    for (const m of moods) {
      expect(restingL).toBeLessThan(relativeLuminance(moodColor(m)));
    }
  });
});
