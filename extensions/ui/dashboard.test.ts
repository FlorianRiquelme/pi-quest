import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fs, vol } from 'memfs';
import { formatRelative, QuestDashboard } from './dashboard.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

vi.mock('../runs/worktree.js', () => ({
  removeRunWorktree: vi.fn().mockResolvedValue(undefined),
  mergeRunBranchIntoQuest: vi.fn().mockResolvedValue({ ok: true }),
}));

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

  /* ============================== Paused Runs (M3-3) ============================== */

  describe('Paused Run row + actions', () => {
    beforeEach(() => {
      // Seed a paused run on q1.
      vol.mkdirSync(`${cwd}/.pi/quests/q1/runs`, { recursive: true });
      vol.writeFileSync(`${cwd}/.pi/quests/q1/runs/r-paused.json`, JSON.stringify({
        runId: 'r-paused',
        questId: 'q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        status: 'paused',
        startedAt: '2026-05-19T17:00:00.000Z',
        updatedAt: '2026-05-19T17:25:00.000Z',
        paused_at: '2026-05-19T17:25:00.000Z',
        paused_reason: 'heartbeat_missed',
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: `${cwd}/.pi/quests/q1/runs/r-paused.json`,
        worktreePath: `${cwd}/.pi/quests/q1/worktrees/r-paused`,
        runBranch: 'quest-run/q1/r-paused',
        questBranch: 'quest/q1',
      }));
    });

    it('renders the Paused Run row with the pause reason', () => {
      const dashboard = new QuestDashboard(mockCtx, mockTheme, () => {});
      dashboard.setVisibleRows(40);
      const lines = dashboard.render(120);
      // Find a line that mentions the rule.
      const joined = lines.join('\n');
      expect(joined).toContain('Paused: heartbeat_missed');
      expect(joined).toContain('Paused Runs');
    });

    it('Discard action removes the worktree and marks the run cancelled', async () => {
      const dashboard = new QuestDashboard(mockCtx, mockTheme, () => {});
      dashboard.setVisibleRows(40);
      dashboard.render(120);

      const worktree = await import('../runs/worktree.js');
      (worktree.removeRunWorktree as any).mockClear();
      await dashboard.discardSelectedPausedRun();

      expect(worktree.removeRunWorktree).toHaveBeenCalledWith(
        `${cwd}/.pi/quests/q1/worktrees/r-paused`,
      );
      const updated = JSON.parse(
        vol.readFileSync(`${cwd}/.pi/quests/q1/runs/r-paused.json`, 'utf-8') as string,
      );
      expect(updated.status).toBe('cancelled');
    });

    it('Force-Complete action merges and marks the run completed', async () => {
      const dashboard = new QuestDashboard(mockCtx, mockTheme, () => {});
      dashboard.setVisibleRows(40);
      dashboard.render(120);

      const worktree = await import('../runs/worktree.js');
      (worktree.mergeRunBranchIntoQuest as any).mockClear().mockResolvedValue({ ok: true });
      (worktree.removeRunWorktree as any).mockClear();

      await dashboard.forceCompleteSelectedPausedRun();

      expect(worktree.mergeRunBranchIntoQuest).toHaveBeenCalledWith({
        repoRoot: cwd,
        questBranch: 'quest/q1',
        runBranch: 'quest-run/q1/r-paused',
      });
      const updated = JSON.parse(
        vol.readFileSync(`${cwd}/.pi/quests/q1/runs/r-paused.json`, 'utf-8') as string,
      );
      expect(updated.status).toBe('completed');
    });

    /* ============================ Resume (M4-4 / ADR 017) ============================ */

    it('renders the Paused Run action row with Resume, Discard, and Force-Complete in equal-weight styling', () => {
      const dashboard = new QuestDashboard(mockCtx, mockTheme, () => {});
      dashboard.setVisibleRows(40);
      const lines = dashboard.render(120);
      const joined = lines.join('\n');
      // The three actions render together; mockTheme.dim is identity so the raw
      // bracket markers should all show up on the same row.
      expect(joined).toContain('[r] Resume');
      expect(joined).toContain('[d] Discard');
      expect(joined).toContain('[f] Force-Complete');
      // Single line, same prefix indent → equal-weight rendering.
      const actionLine = lines.find(
        (l) => l.includes('[r] Resume') && l.includes('[d] Discard') && l.includes('[f] Force-Complete'),
      );
      expect(actionLine).toBeDefined();
    });

    it('footer hint advertises r/d/f as the paused-run action keys', () => {
      const dashboard = new QuestDashboard(mockCtx, mockTheme, () => {});
      dashboard.setVisibleRows(40);
      const lines = dashboard.render(120);
      const joined = lines.join('\n');
      expect(joined).toContain('d/f/r act on paused');
    });
  });
});
