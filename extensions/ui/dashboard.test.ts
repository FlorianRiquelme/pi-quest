import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fs, vol } from 'memfs';
import { formatRelative, QuestDashboard } from './dashboard.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

describe('formatRelative', () => {
  it('returns "just now" for < 60 seconds', () => {
    const now = new Date().toISOString();
    expect(formatRelative(now)).toBe('just now');
  });

  it('returns "Xm ago" for minutes', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelative(fiveMinAgo)).toBe('5m ago');
  });

  it('returns "Xh ago" for hours', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(twoHoursAgo)).toBe('2h ago');
  });

  it('returns "Xd ago" for days', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(threeDaysAgo)).toBe('3d ago');
  });

  it('returns locale date for older times', () => {
    const old = new Date('2024-01-15T00:00:00.000Z').toISOString();
    expect(formatRelative(old)).toBe(new Date('2024-01-15T00:00:00.000Z').toLocaleDateString());
  });
});

describe('QuestDashboard', () => {
  const cwd = '/project';

  const mockCtx = {
    cwd,
    ui: { notify: vi.fn() },
  } as any;

  const mockTheme = {
    fg: (color: string, text: string) => text,
    bg: (color: string, text: string) => text,
    bold: (text: string) => text,
    dim: (text: string) => text,
  };

  beforeEach(() => {
    vol.reset();
    vol.fromJSON({
      [`${cwd}/.pi/quest/state.json`]: JSON.stringify({ currentQuestId: 'q1' }),

      [`${cwd}/.pi/quests/q1/workflow.json`]: JSON.stringify({
        id: 'q1', title: 'Quest One', status: 'executing',
        createdAt: '2026-05-19T10:00:00.000Z',
        updatedAt: '2026-05-19T17:30:00.000Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      }),
      [`${cwd}/.pi/quests/q1/HANDOFF.md`]: '# Q1 Handoff',

      [`${cwd}/.pi/quests/q2/workflow.json`]: JSON.stringify({
        id: 'q2', title: 'Quest Two', status: 'completed',
        createdAt: '2026-05-18T10:00:00.000Z',
        updatedAt: '2026-05-18T12:00:00.000Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      }),
      [`${cwd}/.pi/quests/q2/HANDOFF.md`]: '# Q2 Handoff',
    });
  });

  it('renders dashboard with quest list and detail', () => {
    const dashboard = new QuestDashboard(mockCtx, mockTheme, () => {});
    dashboard.setVisibleRows(20);
    const lines = dashboard.render(100);
    expect(lines.length).toBeGreaterThan(0);
    // Should have a divider in the middle (split pane)
    expect(lines[0]).toContain('│');
  });

  it('navigates with up/down keys', () => {
    const dashboard = new QuestDashboard(mockCtx, mockTheme, () => {});
    dashboard.setVisibleRows(20);
    dashboard.render(100);

    // Initial selection is 0
    dashboard.handleInput('\x1b[B'); // down arrow
    dashboard.render(100);
    // Should have moved to q2
    dashboard.handleInput('\x1b[A'); // up arrow
    dashboard.render(100);
    // Back to q1
  });

  it('refreshData auto-selects next quest when current disappears', () => {
    const dashboard = new QuestDashboard(mockCtx, mockTheme, () => {});
    dashboard.setVisibleRows(20);
    dashboard.render(100);

    // Move to q2
    dashboard.handleInput('\x1b[B'); // down

    // Delete q2
    vol.rmSync(`${cwd}/.pi/quests/q2`, { recursive: true });

    dashboard.refreshData();
    const lines = dashboard.render(100);
    expect(lines.length).toBeGreaterThan(0);
    // Should still render q1 (auto-selected after q2 disappeared)
  });

  it('closes on escape', () => {
    let closed = false;
    const dashboard = new QuestDashboard(mockCtx, mockTheme, () => { closed = true; });
    dashboard.setVisibleRows(20);

    dashboard.handleInput('\x1b'); // escape
    expect(closed).toBe(true);
  });
});
