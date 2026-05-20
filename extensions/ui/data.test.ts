import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fs, vol } from 'memfs';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});
import {
  getQuestSummaries,
  getQuestDetail,
  getActiveQuestSummary,
  countRunningWorkItems,
  countCompletedWorkItems,
  getTotalWorkItems,
  readArtifactFile,
  readQuestEvents,
  getPausedRuns,
  formatPausedRunLabel,
} from './data.js';

describe('UI data layer', () => {
  const cwd = '/project';

  beforeEach(() => {
    vol.reset();
    vol.fromJSON({
      [`${cwd}/.pi/quest/state.json`]: JSON.stringify({ currentQuestId: 'active-quest' }),

      // Active quest
      [`${cwd}/.pi/quests/active-quest/workflow.json`]: JSON.stringify({
        id: 'active-quest',
        title: 'Active Quest',
        status: 'executing',
        createdAt: '2026-05-19T10:00:00.000Z',
        updatedAt: '2026-05-19T17:30:00.000Z',
        source: {},
        artifacts: {
          handoff: 'HANDOFF.md',
          recon: 'RECON.md',
          plan: 'IMPLEMENTATION_PLAN.md',
        },
      }),
      [`${cwd}/.pi/quests/active-quest/HANDOFF.md`]: '# Handoff',
      [`${cwd}/.pi/quests/active-quest/RECON.md`]: '# Recon',
      [`${cwd}/.pi/quests/active-quest/IMPLEMENTATION_PLAN.md`]: '# Plan',
      [`${cwd}/.pi/quests/active-quest/work-items/001.md`]: '# WI 1',
      [`${cwd}/.pi/quests/active-quest/work-items/002.md`]: '# WI 2',
      [`${cwd}/.pi/quests/active-quest/reports/001.md`]: '# Report 1',
      [`${cwd}/.pi/quests/active-quest/runs/001.json`]: JSON.stringify({
        runId: 'r1', questId: 'active-quest', workItemId: '001',
        agentName: 'quest-implementation', status: 'completed',
        startedAt: '2026-05-19T17:00:00.000Z', updatedAt: '2026-05-19T17:10:00.000Z',
        completedAt: '2026-05-19T17:10:00.000Z', exitCode: 0,
        stdoutPath: '/dev/null', stderrPath: '/dev/null',
        reportPath: '/dev/null', statusPath: '/dev/null',
      }),
      [`${cwd}/.pi/quests/active-quest/runs/002.json`]: JSON.stringify({
        runId: 'r2', questId: 'active-quest', workItemId: '002',
        agentName: 'quest-implementation', status: 'running',
        startedAt: '2026-05-19T17:20:00.000Z', updatedAt: '2026-05-19T17:20:00.000Z',
        stdoutPath: '/dev/null', stderrPath: '/dev/null',
        reportPath: '/dev/null', statusPath: '/dev/null',
      }),

      // Second quest
      [`${cwd}/.pi/quests/other-quest/workflow.json`]: JSON.stringify({
        id: 'other-quest',
        title: 'Other Quest',
        status: 'completed',
        createdAt: '2026-05-18T10:00:00.000Z',
        updatedAt: '2026-05-18T12:00:00.000Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      }),
      [`${cwd}/.pi/quests/other-quest/HANDOFF.md`]: '# Other',
    });
  });

  it('getQuestSummaries returns all quests sorted by updatedAt desc', () => {
    const summaries = getQuestSummaries(cwd);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].id).toBe('active-quest');
    expect(summaries[1].id).toBe('other-quest');
    expect(summaries[0].isActive).toBe(true);
    expect(summaries[1].isActive).toBe(false);
  });

  it('getActiveQuestSummary returns the active quest', () => {
    const active = getActiveQuestSummary(cwd);
    expect(active).toBeDefined();
    expect(active?.id).toBe('active-quest');
    expect(active?.status).toBe('executing');
  });

  it('getActiveQuestSummary returns undefined when no active quest', () => {
    vol.writeFileSync(`${cwd}/.pi/quest/state.json`, JSON.stringify({}));
    const active = getActiveQuestSummary(cwd);
    expect(active).toBeUndefined();
  });

  it('getQuestDetail returns full detail', () => {
    const detail = getQuestDetail(cwd, 'active-quest');
    expect(detail).toBeDefined();
    expect(detail?.workflow.id).toBe('active-quest');
    expect(detail?.artifacts).toHaveLength(8); // all artifact keys, including Homecoming Brief (M4-1)
    expect(detail?.artifacts.filter(a => a.exists)).toHaveLength(3);
    expect(detail?.workItems).toHaveLength(2);
    expect(detail?.recentRuns).toHaveLength(2);
  });

  it('getQuestDetail surfaces the Homecoming Brief artifact when BRIEF.md exists (M4-1)', () => {
    vol.writeFileSync(`${cwd}/.pi/quests/active-quest/BRIEF.md`, '# Brief');
    const detail = getQuestDetail(cwd, 'active-quest');
    const brief = detail?.artifacts.find((a) => a.key === 'brief');
    expect(brief).toBeDefined();
    expect(brief?.label).toBe('Homecoming Brief');
    expect(brief?.exists).toBe(true);
    expect(brief?.filePath).toBe(`${cwd}/.pi/quests/active-quest/BRIEF.md`);
  });

  it('getQuestDetail returns undefined for missing quest', () => {
    const detail = getQuestDetail(cwd, 'missing');
    expect(detail).toBeUndefined();
  });

  it('countRunningWorkItems counts only running', () => {
    expect(countRunningWorkItems(cwd, 'active-quest')).toBe(1);
  });

  it('countCompletedWorkItems counts only completed', () => {
    expect(countCompletedWorkItems(cwd, 'active-quest')).toBe(1);
  });

  it('getTotalWorkItems returns total count', () => {
    expect(getTotalWorkItems(cwd, 'active-quest')).toBe(2);
  });

  it('readArtifactFile reads existing files', () => {
    const content = readArtifactFile(`${cwd}/.pi/quests/active-quest/HANDOFF.md`);
    expect(content).toBe('# Handoff');
  });

  it('readArtifactFile returns undefined for missing files', () => {
    const content = readArtifactFile(`${cwd}/.pi/quests/active-quest/MISSING.md`);
    expect(content).toBeUndefined();
  });

  it('readQuestEvents returns [] when telemetry/events.jsonl missing', () => {
    expect(readQuestEvents(cwd, 'other-quest')).toEqual([]);
  });

  it('readQuestEvents parses each JSONL line, skips blanks and corrupt lines', () => {
    const lines = [
      JSON.stringify({
        event: 'stage_entered',
        timestamp: '2026-05-19T17:00:00.000Z',
        questId: 'active-quest',
        to: 'executing',
      }),
      '',
      'not json {',
      JSON.stringify({
        event: 'progress_beat',
        timestamp: '2026-05-19T17:05:00.000Z',
        questId: 'active-quest',
        runId: 'r1',
        phase: 'alive',
      }),
    ].join('\n');
    vol.mkdirSync(`${cwd}/.pi/quests/active-quest/telemetry`, { recursive: true });
    vol.writeFileSync(`${cwd}/.pi/quests/active-quest/telemetry/events.jsonl`, lines);
    const events = readQuestEvents(cwd, 'active-quest');
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('stage_entered');
    expect(events[1].event).toBe('progress_beat');
  });

  it('handles corrupted workflow.json gracefully', () => {
    vol.mkdirSync(`${cwd}/.pi/quests/bad-quest`, { recursive: true });
    vol.writeFileSync(`${cwd}/.pi/quests/bad-quest/workflow.json`, 'not json {');
    const summaries = getQuestSummaries(cwd);
    // Should not include bad quest, should not crash
    expect(summaries.every(q => q.id !== 'bad-quest')).toBe(true);
  });

  /* ============================== Paused runs (M3-3) ============================== */

  describe('getPausedRuns', () => {
    it('returns only paused runs, sorted by paused_at ascending', () => {
      vol.writeFileSync(`${cwd}/.pi/quests/active-quest/runs/003.json`, JSON.stringify({
        runId: 'r3', questId: 'active-quest', workItemId: '003',
        agentName: 'quest-implementation', status: 'paused',
        startedAt: '2026-05-19T17:00:00.000Z', updatedAt: '2026-05-19T17:25:00.000Z',
        paused_at: '2026-05-19T17:25:00.000Z', paused_reason: 'unbounded_diff',
        stdoutPath: '/dev/null', stderrPath: '/dev/null',
        reportPath: '/dev/null', statusPath: '/dev/null',
      }));
      vol.writeFileSync(`${cwd}/.pi/quests/active-quest/runs/004.json`, JSON.stringify({
        runId: 'r4', questId: 'active-quest', workItemId: '004',
        agentName: 'quest-implementation', status: 'paused',
        startedAt: '2026-05-19T17:10:00.000Z', updatedAt: '2026-05-19T17:30:00.000Z',
        paused_at: '2026-05-19T17:30:00.000Z', paused_reason: 'lockfile_drift',
        stdoutPath: '/dev/null', stderrPath: '/dev/null',
        reportPath: '/dev/null', statusPath: '/dev/null',
      }));
      const paused = getPausedRuns(cwd, 'active-quest');
      expect(paused).toHaveLength(2);
      expect(paused[0].runId).toBe('r3');
      expect(paused[1].runId).toBe('r4');
    });

    it('returns [] when no runs are paused', () => {
      expect(getPausedRuns(cwd, 'active-quest')).toEqual([]);
    });
  });

  describe('formatPausedRunLabel', () => {
    it('formats reason and elapsed time', () => {
      const now = Date.parse('2026-05-19T17:35:23.000Z');
      const pausedAt = '2026-05-19T17:30:00.000Z';
      expect(formatPausedRunLabel(pausedAt, 'heartbeat_missed', now)).toBe(
        'Paused: heartbeat_missed (5m23s)',
      );
    });

    it('handles missing paused_at by omitting the timer', () => {
      expect(formatPausedRunLabel(undefined, 'lockfile_drift', Date.now())).toBe(
        'Paused: lockfile_drift',
      );
    });

    it('defends against missing reason', () => {
      const now = Date.parse('2026-05-19T17:30:30.000Z');
      const pausedAt = '2026-05-19T17:30:00.000Z';
      expect(formatPausedRunLabel(pausedAt, undefined, now)).toBe('Paused: unknown (0m30s)');
    });
  });
});
