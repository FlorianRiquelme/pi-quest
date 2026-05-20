import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fs, vol } from 'memfs';
import { EventEmitter } from 'node:events';
import {
	parseAgentDef,
	normalizeModel,
	getAgentDef,
	compactRunLine,
	recordRunFinished,
	reapOrphanedRuns,
	recordSemanticBeat,
	emitSyntheticLivenessBeats,
	startSubagentRun,
	activeRuns,
	__lastBeatAtForTests,
} from './agents';
import type { BackgroundRunSummary } from './types';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  withFileMutationQueue: async (_path: string, fn: () => Promise<any>) => fn(),
}));

vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));

vi.mock('./paths.js', () => ({
  AGENTS_DIR: '/agents',
}));

describe('agents', () => {
  beforeEach(() => {
    vol.reset();
  });

  describe('normalizeModel', () => {
    it('returns undefined for empty input', () => {
      expect(normalizeModel(undefined)).toBeUndefined();
      expect(normalizeModel('')).toBeUndefined();
      expect(normalizeModel('  ')).toBeUndefined();
    });

    it('resolves known aliases', () => {
      expect(normalizeModel('kimi-2.6')).toBe('openrouter/moonshotai/kimi-k2.6');
      expect(normalizeModel('kimi-k2.6')).toBe('openrouter/moonshotai/kimi-k2.6');
    });

    it('passes through unknown models', () => {
      expect(normalizeModel('gpt-4')).toBe('gpt-4');
    });
  });

  describe('parseAgentDef', () => {
    it('parses frontmatter and body', () => {
      vol.mkdirSync('/agents', { recursive: true });
      const content = '---\nname: recon\ndescription: cheap recon agent\nmodel: cheap-default\n---\nYou are a recon agent.\n';
      vol.writeFileSync('/agents/recon.md', content);
      const def = parseAgentDef('/agents/recon.md');
      expect(def).toEqual({
        name: 'recon',
        description: 'cheap recon agent',
        model: 'cheap-default',
        systemPrompt: 'You are a recon agent.',
      });
    });

    it('returns undefined when file missing', () => {
      expect(parseAgentDef('/agents/missing.md')).toBeUndefined();
    });

    it('returns undefined for malformed frontmatter', () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.writeFileSync('/agents/bad.md', 'no frontmatter here');
      expect(parseAgentDef('/agents/bad.md')).toBeUndefined();
    });

    it('returns undefined when name or description missing', () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.writeFileSync('/agents/incomplete.md', '---\nname: only-name\n---\nbody');
      expect(parseAgentDef('/agents/incomplete.md')).toBeUndefined();
    });
  });

  describe('getAgentDef', () => {
    it('finds by filename when name matches', () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.writeFileSync(
        '/agents/recon.md',
        '---\nname: recon\ndescription: recon agent\n---\nDo recon.',
      );
      expect(getAgentDef('recon')?.name).toBe('recon');
    });

    it('falls back to scanning all files', () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.writeFileSync(
        '/agents/01-recon.md',
        '---\nname: recon\ndescription: recon agent\n---\nDo recon.',
      );
      expect(getAgentDef('recon')?.name).toBe('recon');
    });

    it('returns undefined when no match', () => {
      vol.mkdirSync('/agents', { recursive: true });
      expect(getAgentDef('missing')).toBeUndefined();
    });
  });

  describe('recordRunFinished', () => {
    it('writes a run_finished event (not agent_run_completed) to events.jsonl', () => {
      vol.mkdirSync('/project/.pi/quests/q1', { recursive: true });

      recordRunFinished({
        questDir: '/project/.pi/quests/q1',
        questId: 'q1',
        runId: 'run-1',
        workItemId: '001',
        model: 'kimi-2.6',
        status: 'completed',
        exitCode: 0,
        rescueUsed: false,
      });

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n');
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event.event).toBe('run_finished');
      expect(event.event).not.toBe('agent_run_completed');
      expect(event.questId).toBe('q1');
      expect(event.runId).toBe('run-1');
      expect(event.workItemId).toBe('001');
      expect(typeof event.timestamp).toBe('string');
      // status/exitCode/etc live inside the open details slot.
      expect(event.details.status).toBe('completed');
      expect(event.details.exitCode).toBe(0);
      expect(event.details.model).toBe('kimi-2.6');
      expect(event.details.rescueUsed).toBe(false);
    });
  });

  describe('startSubagentRun', () => {
    beforeEach(() => {
      activeRuns.clear();
      vi.clearAllMocks();
    });

    function makeFakeChild() {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
        unref: ReturnType<typeof vi.fn>;
        kill: ReturnType<typeof vi.fn>;
        killed: boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 42424;
      child.unref = vi.fn();
      child.kill = vi.fn();
      child.killed = false;
      return child;
    }

    it('spawns subagent with detached: true and calls unref on the child', async () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.mkdirSync('/tmp', { recursive: true });
      vol.writeFileSync(
        '/agents/quest-implementation.md',
        '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
      );

      const { spawn } = await import('node:child_process');
      const child = makeFakeChild();
      (spawn as any).mockReturnValue(child);

      await startSubagentRun({
        cwd: '/project',
        questId: 'q1',
        questDir: '/project/.pi/quests/q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        task: 'do the thing',
      });

      expect(spawn).toHaveBeenCalledTimes(1);
      const spawnOpts = (spawn as any).mock.calls[0][2];
      expect(spawnOpts.detached).toBe(true);
      expect(child.unref).toHaveBeenCalledTimes(1);
    });

    it('injects PI_QUEST_QUEST_ID, PI_QUEST_RUN_ID, PI_QUEST_WORK_ITEM_ID into the spawn env', async () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.mkdirSync('/tmp', { recursive: true });
      vol.writeFileSync(
        '/agents/quest-implementation.md',
        '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
      );

      const { spawn } = await import('node:child_process');
      const child = makeFakeChild();
      (spawn as any).mockReturnValue(child);

      const summary = await startSubagentRun({
        cwd: '/project',
        questId: 'q-alpha',
        questDir: '/project/.pi/quests/q-alpha',
        workItemId: 'WI-7',
        agentName: 'quest-implementation',
        task: 'do the thing',
      });

      const spawnOpts = (spawn as any).mock.calls[0][2];
      expect(spawnOpts.env).toBeDefined();
      expect(spawnOpts.env.PI_QUEST_QUEST_ID).toBe('q-alpha');
      expect(spawnOpts.env.PI_QUEST_WORK_ITEM_ID).toBe('WI-7');
      expect(spawnOpts.env.PI_QUEST_RUN_ID).toBe(summary.runId);
      // Existing env vars should still be present (e.g. PATH).
      expect(spawnOpts.env.PATH).toBe(process.env.PATH);
    });
  });

  describe('reapOrphanedRuns', () => {
    beforeEach(() => {
      activeRuns.clear();
      vi.restoreAllMocks();
    });

    it('promotes runs whose PID is dead to orphaned and emits a run_orphaned event', () => {
      const summary: BackgroundRunSummary = {
        runId: 'r1',
        questId: 'q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        status: 'running',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        pid: 99999,
        model: 'kimi-2.6',
        stdoutPath: '/project/.pi/quests/q1/runs/r1.stdout.log',
        stderrPath: '/project/.pi/quests/q1/runs/r1.stderr.log',
        reportPath: '/project/.pi/quests/q1/reports/001.md',
        statusPath: '/project/.pi/quests/q1/runs/r1.json',
      };
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      vol.writeFileSync('/project/.pi/quests/q1/runs/r1.json', JSON.stringify(summary));

      // process.kill(pid, 0) throws ESRCH for missing processes.
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, _sig) => {
        const err: NodeJS.ErrnoException = new Error('no such process');
        err.code = 'ESRCH';
        throw err;
      });

      const reaped = reapOrphanedRuns('/project');

      expect(reaped).toEqual(['r1']);

      const updated = JSON.parse(
        vol.readFileSync('/project/.pi/quests/q1/runs/r1.json', 'utf-8') as string,
      );
      expect(updated.status).toBe('orphaned');
      expect(typeof updated.completedAt).toBe('string');

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n');
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event.event).toBe('run_orphaned');
      expect(event.questId).toBe('q1');
      expect(event.runId).toBe('r1');
      expect(event.workItemId).toBe('001');

      killSpy.mockRestore();
    });

    it('preserves runs whose PID is alive', () => {
      const summary: BackgroundRunSummary = {
        runId: 'r2',
        questId: 'q1',
        workItemId: '002',
        agentName: 'quest-implementation',
        status: 'running',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        pid: 12345,
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: '/project/.pi/quests/q1/runs/r2.json',
      };
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      vol.writeFileSync('/project/.pi/quests/q1/runs/r2.json', JSON.stringify(summary));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const reaped = reapOrphanedRuns('/project');

      expect(reaped).toEqual([]);
      const updated = JSON.parse(
        vol.readFileSync('/project/.pi/quests/q1/runs/r2.json', 'utf-8') as string,
      );
      expect(updated.status).toBe('running');
      expect(
        vol.existsSync('/project/.pi/quests/q1/telemetry/events.jsonl'),
      ).toBe(false);

      killSpy.mockRestore();
    });

    it('treats EPERM as alive (process exists but signal denied)', () => {
      const summary: BackgroundRunSummary = {
        runId: 'r3',
        questId: 'q1',
        workItemId: '003',
        agentName: 'quest-implementation',
        status: 'running',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        pid: 54321,
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: '/project/.pi/quests/q1/runs/r3.json',
      };
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      vol.writeFileSync('/project/.pi/quests/q1/runs/r3.json', JSON.stringify(summary));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err: NodeJS.ErrnoException = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      });

      const reaped = reapOrphanedRuns('/project');
      expect(reaped).toEqual([]);

      killSpy.mockRestore();
    });

    it('skips runs not in running status', () => {
      const summary: BackgroundRunSummary = {
        runId: 'r4',
        questId: 'q1',
        workItemId: '004',
        agentName: 'quest-implementation',
        status: 'completed',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        pid: 11111,
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: '/project/.pi/quests/q1/runs/r4.json',
      };
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      vol.writeFileSync('/project/.pi/quests/q1/runs/r4.json', JSON.stringify(summary));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err: NodeJS.ErrnoException = new Error('no such process');
        err.code = 'ESRCH';
        throw err;
      });

      const reaped = reapOrphanedRuns('/project');
      expect(reaped).toEqual([]);

      killSpy.mockRestore();
    });
  });

  describe('synthetic liveness beats (emitSyntheticLivenessBeats)', () => {
    beforeEach(() => {
      activeRuns.clear();
      __lastBeatAtForTests.clear();
      vi.restoreAllMocks();
    });

    function seedRunningRun(opts: { questId: string; runId: string; workItemId: string; pid: number }) {
      const summary: BackgroundRunSummary = {
        runId: opts.runId,
        questId: opts.questId,
        workItemId: opts.workItemId,
        agentName: 'quest-implementation',
        status: 'running',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        pid: opts.pid,
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: `/project/.pi/quests/${opts.questId}/runs/${opts.runId}.json`,
      };
      vol.mkdirSync(`/project/.pi/quests/${opts.questId}/runs`, { recursive: true });
      vol.writeFileSync(
        `/project/.pi/quests/${opts.questId}/runs/${opts.runId}.json`,
        JSON.stringify(summary),
      );
      activeRuns.set(opts.runId, summary);
    }

    it('emits a synthetic progress_beat with phase "alive" when PID alive and no semantic beat in window', () => {
      seedRunningRun({ questId: 'q1', runId: 'r1', workItemId: '001', pid: 1234 });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      // No semantic beat → window is empty → liveness fires.
      const now = Date.parse('2024-02-01T00:00:00Z');
      emitSyntheticLivenessBeats({ cwd: '/project', now: () => now });

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n');
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event.event).toBe('progress_beat');
      expect(event.phase).toBe('alive');
      expect(event.runId).toBe('r1');
      expect(event.questId).toBe('q1');

      killSpy.mockRestore();
    });

    it('does not fire if a semantic beat was recorded within the 60s window', () => {
      seedRunningRun({ questId: 'q1', runId: 'r1', workItemId: '001', pid: 1234 });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const t0 = Date.parse('2024-02-01T00:00:00Z');
      // Semantic beat recorded at t=30s.
      __lastBeatAtForTests.set('r1', t0 + 30_000);
      // Synthetic check at t=60s — 30s since last beat — within window.
      emitSyntheticLivenessBeats({ cwd: '/project', now: () => t0 + 60_000 });

      expect(
        vol.existsSync('/project/.pi/quests/q1/telemetry/events.jsonl'),
      ).toBe(false);

      killSpy.mockRestore();
    });

    it('does not fire if the PID is dead', () => {
      seedRunningRun({ questId: 'q1', runId: 'r1', workItemId: '001', pid: 99999 });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err: NodeJS.ErrnoException = new Error('no such process');
        err.code = 'ESRCH';
        throw err;
      });

      const now = Date.parse('2024-02-01T00:00:00Z');
      emitSyntheticLivenessBeats({ cwd: '/project', now: () => now });

      expect(
        vol.existsSync('/project/.pi/quests/q1/telemetry/events.jsonl'),
      ).toBe(false);

      killSpy.mockRestore();
    });

    it('fires again when the prior synthetic beat is older than 60s', () => {
      seedRunningRun({ questId: 'q1', runId: 'r1', workItemId: '001', pid: 1234 });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const t0 = Date.parse('2024-02-01T00:00:00Z');
      emitSyntheticLivenessBeats({ cwd: '/project', now: () => t0 });
      // After 60s no semantic beat → fires again.
      emitSyntheticLivenessBeats({ cwd: '/project', now: () => t0 + 60_001 });

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);

      killSpy.mockRestore();
    });

    it('skips runs whose status is no longer "running"', () => {
      const summary: BackgroundRunSummary = {
        runId: 'r-done',
        questId: 'q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        status: 'completed',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        pid: 1234,
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: '/project/.pi/quests/q1/runs/r-done.json',
      };
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      vol.writeFileSync(
        '/project/.pi/quests/q1/runs/r-done.json',
        JSON.stringify(summary),
      );

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const now = Date.parse('2024-02-01T00:00:00Z');
      emitSyntheticLivenessBeats({ cwd: '/project', now: () => now });

      expect(
        vol.existsSync('/project/.pi/quests/q1/telemetry/events.jsonl'),
      ).toBe(false);

      killSpy.mockRestore();
    });
  });

  describe('recordSemanticBeat', () => {
    beforeEach(() => {
      __lastBeatAtForTests.clear();
    });

    it('updates the last-beat-at map for a given runId', () => {
      const t = Date.parse('2024-02-01T00:00:00Z');
      recordSemanticBeat('run-xyz', t);
      expect(__lastBeatAtForTests.get('run-xyz')).toBe(t);
    });
  });

  describe('compactRunLine', () => {
    it('formats a running run', () => {
      const summary: BackgroundRunSummary = {
        runId: '001-quest-20240101120000',
        questId: 'q1',
        workItemId: '001',
        agentName: 'impl',
        status: 'running',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        stdoutPath: '/out',
        stderrPath: '/err',
        reportPath: '/report.md',
        statusPath: '/status.json',
      };
      expect(compactRunLine(summary)).toContain('running');
      expect(compactRunLine(summary)).toContain('001');
    });

    it('includes exit code when present', () => {
      const summary: BackgroundRunSummary = {
        runId: '001-quest-20240101120000',
        questId: 'q1',
        workItemId: '001',
        agentName: 'impl',
        status: 'failed',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        exitCode: 1,
        stdoutPath: '/out',
        stderrPath: '/err',
        reportPath: '/report.md',
        statusPath: '/status.json',
      };
      expect(compactRunLine(summary)).toContain('exit=1');
    });
  });
});
