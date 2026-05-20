/**
 * Two Clocks tests — see ADR 013, §4 Two Clocks.
 *
 * Wall: from first `stage_entered: executing` to terminal status (or now).
 * Compute: sum of (run_finished − run_started) pairs, by runId.
 * Hidden before `executing`. Frozen at terminal status.
 * Format: <1m | <M>m | <H>h <M>m
 */

import { describe, it, expect } from 'vitest';
import type { QuestEvent } from '../events.js';
import {
  formatDuration,
  computeWall,
  computeCompute,
  shouldShowClocks,
} from './two-clocks.js';

const iso = (h: number, m = 0, s = 0) =>
  new Date(Date.UTC(2026, 0, 1, h, m, s)).toISOString();

const NOW = new Date(Date.UTC(2026, 0, 1, 15, 0, 0)).getTime();

describe('formatDuration', () => {
  it('shows <1m below 1 minute', () => {
    expect(formatDuration(0)).toBe('<1m');
    expect(formatDuration(59_000)).toBe('<1m');
  });

  it('shows minutes only below 1 hour', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(47 * 60_000)).toBe('47m');
    expect(formatDuration(59 * 60_000)).toBe('59m');
  });

  it('shows hours and minutes >= 1 hour', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h 0m');
    expect(formatDuration(3 * 60 * 60_000 + 12 * 60_000)).toBe('3h 12m');
    expect(formatDuration(24 * 60 * 60_000)).toBe('24h 0m');
  });

  it('does not include sub-minute precision', () => {
    expect(formatDuration(60_000 + 30_000)).toBe('1m');
    expect(formatDuration(60 * 60_000 + 30_000)).toBe('1h 0m');
  });

  it('clamps negative durations to <1m', () => {
    expect(formatDuration(-1000)).toBe('<1m');
  });
});

describe('shouldShowClocks', () => {
  it('hides clocks in intake', () => {
    expect(shouldShowClocks('intake', [])).toBe(false);
  });

  it('hides clocks in recon-ready', () => {
    expect(shouldShowClocks('recon-ready', [])).toBe(false);
  });

  it('hides clocks in resolved', () => {
    expect(shouldShowClocks('resolved', [])).toBe(false);
  });

  it('hides clocks in planned', () => {
    expect(shouldShowClocks('planned', [])).toBe(false);
  });

  it('hides clocks in launch-review', () => {
    expect(shouldShowClocks('launch-review', [])).toBe(false);
  });

  it('shows clocks in executing once stage_entered: executing has fired', () => {
    const events: QuestEvent[] = [
      { event: 'stage_entered', timestamp: iso(13), questId: 'q', to: 'executing' },
    ];
    expect(shouldShowClocks('executing', events)).toBe(true);
  });

  it('shows clocks in verification (post-executing)', () => {
    const events: QuestEvent[] = [
      { event: 'stage_entered', timestamp: iso(13), questId: 'q', to: 'executing' },
      { event: 'stage_entered', timestamp: iso(14), questId: 'q', to: 'verification' },
    ];
    expect(shouldShowClocks('verification', events)).toBe(true);
  });

  it('shows clocks in completed', () => {
    const events: QuestEvent[] = [
      { event: 'stage_entered', timestamp: iso(13), questId: 'q', to: 'executing' },
      { event: 'stage_entered', timestamp: iso(14), questId: 'q', to: 'completed' },
    ];
    expect(shouldShowClocks('completed', events)).toBe(true);
  });
});

describe('computeWall', () => {
  it('returns 0 when no stage_entered: executing event exists', () => {
    const wall = computeWall({
      status: 'intake',
      events: [],
      now: NOW,
    });
    expect(wall).toBe(0);
  });

  it('ticks from first stage_entered: executing to now', () => {
    // 13:00 → 15:00 = 2h
    const events: QuestEvent[] = [
      { event: 'stage_entered', timestamp: iso(13), questId: 'q', to: 'executing' },
    ];
    const wall = computeWall({ status: 'executing', events, now: NOW });
    expect(wall).toBe(2 * 60 * 60_000);
  });

  it('continues ticking through verification-ready and uat-ready', () => {
    const events: QuestEvent[] = [
      { event: 'stage_entered', timestamp: iso(13), questId: 'q', to: 'executing' },
      { event: 'stage_entered', timestamp: iso(14), questId: 'q', to: 'verification-ready' },
    ];
    const wall = computeWall({ status: 'verification-ready', events, now: NOW });
    expect(wall).toBe(2 * 60 * 60_000);
  });

  it('freezes at terminal status (completed) — uses stage-entered timestamp not now', () => {
    const events: QuestEvent[] = [
      { event: 'stage_entered', timestamp: iso(13), questId: 'q', to: 'executing' },
      { event: 'stage_entered', timestamp: iso(14, 30), questId: 'q', to: 'completed' },
    ];
    // Wall = 13:00 → 14:30 = 1h 30m, NOT NOW (15:00)
    const wall = computeWall({ status: 'completed', events, now: NOW });
    expect(wall).toBe(90 * 60_000);
  });

  it('freezes at terminal status (blocked)', () => {
    const events: QuestEvent[] = [
      { event: 'stage_entered', timestamp: iso(13), questId: 'q', to: 'executing' },
      { event: 'stage_entered', timestamp: iso(14, 30), questId: 'q', to: 'blocked' },
    ];
    const wall = computeWall({ status: 'blocked', events, now: NOW });
    expect(wall).toBe(90 * 60_000);
  });

  it('freezes at terminal status (uat-failed)', () => {
    const events: QuestEvent[] = [
      { event: 'stage_entered', timestamp: iso(13), questId: 'q', to: 'executing' },
      { event: 'stage_entered', timestamp: iso(14, 30), questId: 'q', to: 'uat-failed' },
    ];
    const wall = computeWall({ status: 'uat-failed', events, now: NOW });
    expect(wall).toBe(90 * 60_000);
  });

  it('uses the FIRST stage_entered: executing event (handles re-entry)', () => {
    const events: QuestEvent[] = [
      { event: 'stage_entered', timestamp: iso(13), questId: 'q', to: 'executing' },
      { event: 'stage_entered', timestamp: iso(13, 30), questId: 'q', to: 'blocked' },
      { event: 'stage_entered', timestamp: iso(14), questId: 'q', to: 'executing' },
    ];
    const wall = computeWall({ status: 'executing', events, now: NOW });
    expect(wall).toBe(2 * 60 * 60_000); // 13:00 → 15:00
  });
});

describe('computeCompute', () => {
  it('returns 0 when there are no run events', () => {
    expect(computeCompute([])).toBe(0);
  });

  it('sums (run_finished - run_started) per runId', () => {
    const events: QuestEvent[] = [
      {
        event: 'run_started',
        timestamp: iso(13),
        questId: 'q',
        runId: 'r1',
        workItemId: '001',
      },
      {
        event: 'run_finished',
        timestamp: iso(13, 10),
        questId: 'q',
        runId: 'r1',
        workItemId: '001',
      },
      {
        event: 'run_started',
        timestamp: iso(13, 30),
        questId: 'q',
        runId: 'r2',
        workItemId: '002',
      },
      {
        event: 'run_finished',
        timestamp: iso(14),
        questId: 'q',
        runId: 'r2',
        workItemId: '002',
      },
    ];
    // r1: 10m, r2: 30m → 40m
    expect(computeCompute(events)).toBe(40 * 60_000);
  });

  it('ignores unmatched run_started (still-running run)', () => {
    const events: QuestEvent[] = [
      {
        event: 'run_started',
        timestamp: iso(13),
        questId: 'q',
        runId: 'r1',
        workItemId: '001',
      },
    ];
    expect(computeCompute(events)).toBe(0);
  });

  it('ignores orphaned run_finished without a started match', () => {
    const events: QuestEvent[] = [
      {
        event: 'run_finished',
        timestamp: iso(13, 10),
        questId: 'q',
        runId: 'r1',
        workItemId: '001',
      },
    ];
    expect(computeCompute(events)).toBe(0);
  });
});
