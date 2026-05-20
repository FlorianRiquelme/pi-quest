/**
 * Hearth Widget assembly tests — see ADR 013.
 *
 * Tests focus on:
 *   - Each mood produces the correct glyph in line 2
 *   - Cache hits within 250ms; recomputes after
 *   - Terminal capability fallback: when truecolor is unset, named-color output, no pulse
 *
 * Direct render assembly (no TUI required) is tested via `assembleWidgetLines`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fs, vol } from 'memfs';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

import { WidgetCache, type WidgetSnapshot, type MoodTransitionState } from './widget-cache.js';
import { assembleWidgetLines } from './widget-render.js';
import { detectTrueColor } from './widget-render.js';
import { collectWidgetSnapshot } from './widget-data.js';
import { nextDisplayedMood } from './widget.js';

const cwd = '/project';
const ISO = (h: number, m = 0, s = 0) =>
  new Date(Date.UTC(2026, 0, 1, h, m, s)).toISOString();
const NOW = new Date(Date.UTC(2026, 0, 1, 15, 0, 0)).getTime();

describe('WidgetCache (250ms TTL)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  it('returns cached value within 250ms window', () => {
    let computeCount = 0;
    const cache = new WidgetCache(() => {
      computeCount++;
      return { kind: 'fresh', value: computeCount } as unknown as WidgetSnapshot;
    });
    cache.get();
    cache.get();
    vi.advanceTimersByTime(100);
    cache.get();
    expect(computeCount).toBe(1);
  });

  it('recomputes after 250ms have elapsed', () => {
    let computeCount = 0;
    const cache = new WidgetCache(() => {
      computeCount++;
      return { kind: 'fresh', value: computeCount } as unknown as WidgetSnapshot;
    });
    cache.get();
    vi.advanceTimersByTime(251);
    cache.get();
    expect(computeCount).toBe(2);
  });

  it('does not recompute at 249ms', () => {
    let computeCount = 0;
    const cache = new WidgetCache(() => {
      computeCount++;
      return { kind: 'fresh', value: computeCount } as unknown as WidgetSnapshot;
    });
    cache.get();
    vi.advanceTimersByTime(249);
    cache.get();
    expect(computeCount).toBe(1);
  });
});

describe('detectTrueColor', () => {
  const origColorterm = process.env.COLORTERM;
  const origTerm = process.env.TERM;
  const origWt = process.env.WT_SESSION;

  afterEach(() => {
    if (origColorterm === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = origColorterm;
    if (origTerm === undefined) delete process.env.TERM;
    else process.env.TERM = origTerm;
    if (origWt === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = origWt;
  });

  it('returns true when COLORTERM=truecolor', () => {
    process.env.COLORTERM = 'truecolor';
    expect(detectTrueColor()).toBe(true);
  });

  it('returns true when COLORTERM=24bit', () => {
    process.env.COLORTERM = '24bit';
    expect(detectTrueColor()).toBe(true);
  });

  it('returns true when WT_SESSION is set (Windows Terminal)', () => {
    delete process.env.COLORTERM;
    delete process.env.TERM;
    process.env.WT_SESSION = '1';
    expect(detectTrueColor()).toBe(true);
  });

  it('returns false when COLORTERM is unset', () => {
    delete process.env.COLORTERM;
    delete process.env.WT_SESSION;
    process.env.TERM = 'xterm-256color';
    expect(detectTrueColor()).toBe(false);
  });
});

describe('assembleWidgetLines — mood glyph in line 2', () => {
  function fakeTheme() {
    return {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    };
  }

  function snapshot(overrides: Partial<WidgetSnapshot> = {}): WidgetSnapshot {
    return {
      hasActiveQuest: true,
      title: 'Test Quest',
      status: 'executing',
      questId: 'q',
      runningCount: 1,
      completedCount: 0,
      totalCount: 2,
      activeRunCount: 1,
      lastSyntheticBeatAt: undefined,
      lastSemanticBeatAt: NOW - 30_000,
      lastLowConfidenceBeatAt: undefined,
      lastRetrySignalAt: undefined,
      hasPausedRun: false,
      softFreeze: false,
      wallMs: 60 * 60_000,
      computeMs: 12 * 60_000,
      showClocks: true,
      now: NOW,
      ...overrides,
    };
  }

  it('renders · for resting', () => {
    const lines = assembleWidgetLines(snapshot({ hasActiveQuest: false }), {
      width: 100,
      theme: fakeTheme() as any,
      trueColor: false,
      pulsePhase: 1,
    });
    expect(lines[1]).toContain('·');
  });

  it('renders ◌ for cruising', () => {
    const lines = assembleWidgetLines(
      snapshot({ activeRunCount: 1, status: 'executing' }),
      { width: 100, theme: fakeTheme() as any, trueColor: false, pulsePhase: 1 },
    );
    expect(lines[1]).toContain('◌');
  });

  it('renders ● for working hard', () => {
    const lines = assembleWidgetLines(
      snapshot({ activeRunCount: 3 }),
      { width: 100, theme: fakeTheme() as any, trueColor: false, pulsePhase: 1 },
    );
    expect(lines[1]).toContain('●');
  });

  it('renders ! for stuck', () => {
    const lines = assembleWidgetLines(
      snapshot({
        lastSyntheticBeatAt: NOW - 30_000,
        lastSemanticBeatAt: NOW - 6 * 60_000,
      }),
      { width: 100, theme: fakeTheme() as any, trueColor: false, pulsePhase: 1 },
    );
    expect(lines[1]).toContain('!');
  });

  it('renders ► for needs-you', () => {
    const lines = assembleWidgetLines(
      snapshot({ status: 'uat-ready' }),
      { width: 100, theme: fakeTheme() as any, trueColor: false, pulsePhase: 1 },
    );
    expect(lines[1]).toContain('►');
  });
});

describe('assembleWidgetLines — soft-freeze line-2 indicator (M3-2)', () => {
  function fakeTheme() {
    return {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    };
  }

  function snapshot(overrides: Partial<WidgetSnapshot> = {}): WidgetSnapshot {
    return {
      hasActiveQuest: true,
      title: 'Frozen Quest',
      status: 'executing',
      questId: 'q',
      runningCount: 3,
      completedCount: 0,
      totalCount: 5,
      activeRunCount: 3,
      lastSyntheticBeatAt: undefined,
      lastSemanticBeatAt: NOW - 30_000,
      lastLowConfidenceBeatAt: undefined,
      lastRetrySignalAt: undefined,
      hasPausedRun: false,
      softFreeze: true,
      wallMs: 60 * 60_000,
      computeMs: 12 * 60_000,
      showClocks: true,
      now: NOW,
      ...overrides,
    };
  }

  it('renders the freeze snowflake glyph on line 2 when softFreeze=true', () => {
    const lines = assembleWidgetLines(snapshot(), {
      width: 120,
      theme: fakeTheme() as any,
      trueColor: false,
      pulsePhase: 0,
    });
    expect(lines[1]).toContain('❄'); // ❄
  });

  it('renders "frozen · N runs completing · Ctrl+P to release" on line 2', () => {
    const lines = assembleWidgetLines(snapshot({ runningCount: 3 }), {
      width: 120,
      theme: fakeTheme() as any,
      trueColor: false,
      pulsePhase: 0,
    });
    expect(lines[1]).toMatch(/frozen/);
    expect(lines[1]).toMatch(/3 runs? completing/);
    expect(lines[1]).toMatch(/Ctrl\+P/);
  });

  it('uses singular "run completing" when exactly one run is in flight', () => {
    const lines = assembleWidgetLines(snapshot({ runningCount: 1 }), {
      width: 120,
      theme: fakeTheme() as any,
      trueColor: false,
      pulsePhase: 0,
    });
    expect(lines[1]).toMatch(/1 run completing/);
  });

  it('selects the Resting mood (· glyph in line 1 word "resting")', () => {
    const lines = assembleWidgetLines(snapshot(), {
      width: 120,
      theme: fakeTheme() as any,
      trueColor: false,
      pulsePhase: 0,
    });
    expect(lines[0]).toMatch(/resting/);
  });
});

describe('assembleWidgetLines — Two Clocks visibility', () => {
  function fakeTheme() {
    return {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    };
  }

  function snapshot(overrides: Partial<WidgetSnapshot> = {}): WidgetSnapshot {
    return {
      hasActiveQuest: true,
      title: 'Q',
      status: 'executing',
      questId: 'q',
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
      wallMs: 3 * 60 * 60_000 + 12 * 60_000,
      computeMs: 47 * 60_000,
      showClocks: true,
      now: NOW,
      ...overrides,
    };
  }

  it('shows "3h 12m / 47m" once executing has been entered', () => {
    const lines = assembleWidgetLines(snapshot(), {
      width: 100,
      theme: fakeTheme() as any,
      trueColor: false,
      pulsePhase: 1,
    });
    expect(lines[1]).toContain('3h 12m / 47m');
  });

  it('hides clocks before executing', () => {
    const lines = assembleWidgetLines(
      snapshot({ status: 'planned', showClocks: false }),
      { width: 100, theme: fakeTheme() as any, trueColor: false, pulsePhase: 1 },
    );
    expect(lines[1]).not.toContain('/');
  });
});

describe('assembleWidgetLines — terminal capability fallback', () => {
  function fakeTheme() {
    return {
      // theme.fg adds named-color ANSI; in our fake we tag with a marker
      fg: (c: string, t: string) => `[fg:${c}]${t}`,
      bold: (t: string) => t,
    };
  }

  function snapshot(overrides: Partial<WidgetSnapshot> = {}): WidgetSnapshot {
    return {
      hasActiveQuest: true,
      title: 'Q',
      status: 'executing',
      questId: 'q',
      runningCount: 1,
      completedCount: 0,
      totalCount: 1,
      activeRunCount: 1,
      lastSyntheticBeatAt: undefined,
      lastSemanticBeatAt: NOW - 30_000,
      lastLowConfidenceBeatAt: undefined,
      lastRetrySignalAt: undefined,
      hasPausedRun: false,
      softFreeze: false,
      wallMs: 60_000,
      computeMs: 0,
      showClocks: true,
      now: NOW,
      ...overrides,
    };
  }

  it('emits named-theme ANSI (via theme.fg) when trueColor=false', () => {
    const lines = assembleWidgetLines(snapshot(), {
      width: 100,
      theme: fakeTheme() as any,
      trueColor: false,
      pulsePhase: 0.5,
    });
    // Named-color path: theme.fg has been called
    const joined = lines.join('|');
    expect(joined).toContain('[fg:');
    // 24-bit ANSI escape sequence ESC[38;2;R;G;Bm must NOT appear
    expect(joined).not.toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
  });

  it('emits 24-bit ANSI ESC[38;2;...m when trueColor=true', () => {
    const lines = assembleWidgetLines(snapshot(), {
      width: 100,
      theme: fakeTheme() as any,
      trueColor: true,
      pulsePhase: 1.0,
    });
    const joined = lines.join('|');
    expect(joined).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
  });

  it('does not pulse when trueColor=false (color is independent of pulsePhase)', () => {
    const linesA = assembleWidgetLines(snapshot(), {
      width: 100,
      theme: fakeTheme() as any,
      trueColor: false,
      pulsePhase: 0.7,
    });
    const linesB = assembleWidgetLines(snapshot(), {
      width: 100,
      theme: fakeTheme() as any,
      trueColor: false,
      pulsePhase: 1.0,
    });
    expect(linesA).toEqual(linesB);
  });
});

describe('nextDisplayedMood — Cruising ↔ Working-hard debounce', () => {
  const initial = (mood: any = 'cruising'): MoodTransitionState => ({
    displayed: mood,
    candidate: mood,
    candidateSinceMs: 1000,
  });

  it('returns the same displayed mood when candidate equals displayed', () => {
    const next = nextDisplayedMood(initial('cruising'), 'cruising', 2000);
    expect(next.displayed).toBe('cruising');
  });

  it('does NOT flip Cruising→Working-hard until 1500ms have passed', () => {
    const state = initial('cruising');
    // 1499ms after the candidate first differed
    const next = nextDisplayedMood(state, 'working_hard', 2499);
    expect(next.displayed).toBe('cruising');
  });

  it('flips Cruising→Working-hard after 1500ms', () => {
    const state = initial('cruising');
    // First call: candidate first differs at t=2000
    const s1 = nextDisplayedMood(state, 'working_hard', 2000);
    expect(s1.displayed).toBe('cruising');
    // Second call: at t=3500 (1500ms later) — flip
    const s2 = nextDisplayedMood(s1, 'working_hard', 3500);
    expect(s2.displayed).toBe('working_hard');
  });

  it('immediately flips when candidate becomes Needs-you', () => {
    const state = initial('cruising');
    const next = nextDisplayedMood(state, 'needs_you', 1001);
    expect(next.displayed).toBe('needs_you');
  });

  it('immediately flips when candidate becomes Stuck', () => {
    const state = initial('working_hard');
    const next = nextDisplayedMood(state, 'stuck', 1001);
    expect(next.displayed).toBe('stuck');
  });

  it('immediately flips when candidate becomes Resting', () => {
    const state = initial('working_hard');
    const next = nextDisplayedMood(state, 'resting', 1001);
    expect(next.displayed).toBe('resting');
  });

  it('resets the timer when candidate oscillates back to displayed', () => {
    const state = initial('cruising');
    // Brief spike: candidate=working_hard at t=2000
    const s1 = nextDisplayedMood(state, 'working_hard', 2000);
    // Spike subsides at t=2500
    const s2 = nextDisplayedMood(s1, 'cruising', 2500);
    expect(s2.displayed).toBe('cruising');
    // New spike at t=3000 — debounce timer should restart, not have accumulated
    const s3 = nextDisplayedMood(s2, 'working_hard', 3000);
    expect(s3.displayed).toBe('cruising'); // not yet flipped
    // At t=4000 (only 1000ms since latest spike) — still cruising
    const s4 = nextDisplayedMood(s3, 'working_hard', 4000);
    expect(s4.displayed).toBe('cruising');
    // At t=4500 (1500ms since spike start) — flip
    const s5 = nextDisplayedMood(s4, 'working_hard', 4500);
    expect(s5.displayed).toBe('working_hard');
  });
});

describe('collectWidgetSnapshot', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('returns hasActiveQuest=false when no active quest', () => {
    vol.fromJSON({
      [`${cwd}/.pi/quest/state.json`]: JSON.stringify({}),
    });
    const snap = collectWidgetSnapshot(cwd, NOW);
    expect(snap.hasActiveQuest).toBe(false);
  });

  it('reads progress_beat events from telemetry/events.jsonl and tracks synthetic vs semantic', () => {
    const events = [
      {
        event: 'stage_entered',
        timestamp: ISO(13),
        questId: 'q',
        to: 'executing',
      },
      {
        event: 'progress_beat',
        timestamp: ISO(14, 50),
        questId: 'q',
        runId: 'r1',
        phase: 'implementing',
        confidence: 0.9,
      },
      {
        event: 'progress_beat',
        timestamp: ISO(14, 59),
        questId: 'q',
        runId: 'r1',
        phase: 'alive',
      },
    ];

    vol.fromJSON({
      [`${cwd}/.pi/quest/state.json`]: JSON.stringify({ currentQuestId: 'q' }),
      [`${cwd}/.pi/quests/q/workflow.json`]: JSON.stringify({
        id: 'q',
        title: 'Q',
        status: 'executing',
        createdAt: ISO(12),
        updatedAt: ISO(15),
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      }),
      [`${cwd}/.pi/quests/q/telemetry/events.jsonl`]: events
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    });

    const snap = collectWidgetSnapshot(cwd, NOW);
    expect(snap.hasActiveQuest).toBe(true);
    expect(snap.lastSemanticBeatAt).toBe(
      new Date(ISO(14, 50)).getTime(),
    );
    expect(snap.lastSyntheticBeatAt).toBe(
      new Date(ISO(14, 59)).getTime(),
    );
  });

  it('reflects status from workflow.json', () => {
    vol.fromJSON({
      [`${cwd}/.pi/quest/state.json`]: JSON.stringify({ currentQuestId: 'q' }),
      [`${cwd}/.pi/quests/q/workflow.json`]: JSON.stringify({
        id: 'q',
        title: 'Q',
        status: 'uat-ready',
        createdAt: ISO(12),
        updatedAt: ISO(15),
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      }),
    });
    const snap = collectWidgetSnapshot(cwd, NOW);
    expect(snap.status).toBe('uat-ready');
  });

  it('computes wallMs and computeMs from event log', () => {
    const events = [
      { event: 'stage_entered', timestamp: ISO(13), questId: 'q', to: 'executing' },
      { event: 'run_started', timestamp: ISO(13, 30), questId: 'q', runId: 'r1', workItemId: '001' },
      { event: 'run_finished', timestamp: ISO(13, 40), questId: 'q', runId: 'r1', workItemId: '001' },
    ];

    vol.fromJSON({
      [`${cwd}/.pi/quest/state.json`]: JSON.stringify({ currentQuestId: 'q' }),
      [`${cwd}/.pi/quests/q/workflow.json`]: JSON.stringify({
        id: 'q',
        title: 'Q',
        status: 'executing',
        createdAt: ISO(12),
        updatedAt: ISO(15),
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      }),
      [`${cwd}/.pi/quests/q/telemetry/events.jsonl`]: events
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    });

    const snap = collectWidgetSnapshot(cwd, NOW);
    expect(snap.wallMs).toBe(2 * 60 * 60_000);
    expect(snap.computeMs).toBe(10 * 60_000);
    expect(snap.showClocks).toBe(true);
  });
});
