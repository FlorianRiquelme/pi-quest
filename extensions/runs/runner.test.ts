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
	reapOrphanWorktrees,
	mergeCompletedRun,
	recordSemanticBeat,
	emitSyntheticLivenessBeats,
	startSubagentRun,
	activeRuns,
	__lastBeatAtForTests,
} from './runner';
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

vi.mock('../paths.js', () => ({
  AGENTS_DIR: '/agents',
}));

vi.mock('./worktree.js', () => ({
  createRunWorktree: vi.fn(),
  removeRunWorktree: vi.fn().mockResolvedValue(undefined),
  listRunWorktrees: vi.fn().mockResolvedValue([]),
  mergeRunBranchIntoQuest: vi.fn().mockResolvedValue({ ok: true }),
  worktreePathFor: (repoRoot: string, questId: string, runId: string) =>
    `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
  getHeadSha: vi.fn().mockResolvedValue('basesha'),
  ensureQuestBranch: vi.fn().mockResolvedValue({ questBranch: 'quest/q1', created: false }),
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

      const worktree = await import('./worktree');
      (worktree.createRunWorktree as any).mockImplementation(
        async ({ questId, runId, repoRoot }: any) => ({
          worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
          runBranch: `quest-run/${questId}/${runId}`,
        }),
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

    it('creates a Run Worktree before spawning and uses it as cwd', async () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.mkdirSync('/tmp', { recursive: true });
      vol.writeFileSync(
        '/agents/quest-implementation.md',
        '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
      );

      const worktree = await import('./worktree');
      (worktree.createRunWorktree as any).mockImplementation(
        async ({ questId, runId, repoRoot }: any) => ({
          worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
          runBranch: `quest-run/${questId}/${runId}`,
        }),
      );

      const { spawn } = await import('node:child_process');
      const child = makeFakeChild();
      (spawn as any).mockReturnValue(child);

      const summary = await startSubagentRun({
        cwd: '/project',
        questId: 'q1',
        questDir: '/project/.pi/quests/q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        task: 'do the thing',
      });

      expect(worktree.createRunWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          repoRoot: '/project',
          questId: 'q1',
          runId: summary.runId,
        }),
      );

      const spawnOpts = (spawn as any).mock.calls[0][2];
      expect(spawnOpts.cwd).toBe(`/project/.pi/quests/q1/worktrees/${summary.runId}`);
    });

    it('injects PI_QUEST_HOME (main-checkout .pi/) into the spawn env', async () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.mkdirSync('/tmp', { recursive: true });
      vol.writeFileSync(
        '/agents/quest-implementation.md',
        '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
      );

      const worktree = await import('./worktree');
      (worktree.createRunWorktree as any).mockImplementation(
        async ({ questId, runId, repoRoot }: any) => ({
          worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
          runBranch: `quest-run/${questId}/${runId}`,
        }),
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

      const spawnOpts = (spawn as any).mock.calls[0][2];
      expect(spawnOpts.env.PI_QUEST_HOME).toBe('/project/.pi');
    });

    it('detects bun lockfile and runs `bun install` inside the worktree before spawning', async () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.mkdirSync('/tmp', { recursive: true });
      vol.writeFileSync(
        '/agents/quest-implementation.md',
        '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
      );
      // Seed bun.lock at the main-checkout root.
      vol.mkdirSync('/project', { recursive: true });
      vol.writeFileSync('/project/bun.lock', '');

      const worktree = await import('./worktree');
      (worktree.createRunWorktree as any).mockImplementation(
        async ({ questId, runId, repoRoot }: any) => ({
          worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
          runBranch: `quest-run/${questId}/${runId}`,
        }),
      );

      const { spawn } = await import('node:child_process');
      const installChild = makeFakeChild();
      const subagentChild = makeFakeChild();
      let call = 0;
      (spawn as any).mockImplementation((cmd: string, args: string[], opts: any) => {
        call++;
        if (call === 1) {
          // First spawn must be the install.
          expect(cmd).toBe('bun');
          expect(args).toEqual(['install']);
          expect(opts.cwd).toMatch(/\.pi\/quests\/q1\/worktrees\//);
          // Mimic install completing successfully via close event.
          queueMicrotask(() => installChild.emit('close', 0));
          return installChild;
        }
        return subagentChild;
      });

      const summary = await startSubagentRun({
        cwd: '/project',
        questId: 'q1',
        questDir: '/project/.pi/quests/q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        task: 'do the thing',
      });

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(summary.status).toBe('running');
    });

    it('detects pnpm lockfile (priority over bun if both present)', async () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.mkdirSync('/tmp', { recursive: true });
      vol.writeFileSync(
        '/agents/quest-implementation.md',
        '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
      );
      vol.mkdirSync('/project', { recursive: true });
      vol.writeFileSync('/project/pnpm-lock.yaml', '');
      vol.writeFileSync('/project/bun.lock', '');

      const worktree = await import('./worktree');
      (worktree.createRunWorktree as any).mockImplementation(
        async ({ questId, runId, repoRoot }: any) => ({
          worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
          runBranch: `quest-run/${questId}/${runId}`,
        }),
      );

      const { spawn } = await import('node:child_process');
      const installChild = makeFakeChild();
      const subagentChild = makeFakeChild();
      let call = 0;
      (spawn as any).mockImplementation((cmd: string, _args: string[], _opts: any) => {
        call++;
        if (call === 1) {
          expect(cmd).toBe('pnpm');
          queueMicrotask(() => installChild.emit('close', 0));
          return installChild;
        }
        return subagentChild;
      });

      await startSubagentRun({
        cwd: '/project',
        questId: 'q1',
        questDir: '/project/.pi/quests/q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        task: 'do the thing',
      });

      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('skips install when no lockfile is present', async () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.mkdirSync('/tmp', { recursive: true });
      vol.writeFileSync(
        '/agents/quest-implementation.md',
        '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
      );
      vol.mkdirSync('/project', { recursive: true });
      // No lockfile.

      const worktree = await import('./worktree');
      (worktree.createRunWorktree as any).mockImplementation(
        async ({ questId, runId, repoRoot }: any) => ({
          worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
          runBranch: `quest-run/${questId}/${runId}`,
        }),
      );

      const { spawn } = await import('node:child_process');
      const subagentChild = makeFakeChild();
      (spawn as any).mockReturnValue(subagentChild);

      await startSubagentRun({
        cwd: '/project',
        questId: 'q1',
        questDir: '/project/.pi/quests/q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        task: 'do the thing',
      });

      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('injects PI_QUEST_QUEST_ID, PI_QUEST_RUN_ID, PI_QUEST_WORK_ITEM_ID into the spawn env', async () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.mkdirSync('/tmp', { recursive: true });
      vol.writeFileSync(
        '/agents/quest-implementation.md',
        '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
      );

      const worktree = await import('./worktree');
      (worktree.createRunWorktree as any).mockImplementation(
        async ({ questId, runId, repoRoot }: any) => ({
          worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
          runBranch: `quest-run/${questId}/${runId}`,
        }),
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

    it('STATUS_RANK gate: finalize("cancelled") does NOT overwrite an already-paused disk row (issue #13 race)', async () => {
      vol.mkdirSync('/agents', { recursive: true });
      vol.mkdirSync('/tmp', { recursive: true });
      vol.writeFileSync(
        '/agents/quest-implementation.md',
        '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
      );

      const worktree = await import('./worktree');
      (worktree.createRunWorktree as any).mockImplementation(
        async ({ questId, runId, repoRoot }: any) => ({
          worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
          runBranch: `quest-run/${questId}/${runId}`,
        }),
      );

      const { spawn } = await import('node:child_process');
      const child = makeFakeChild();
      (spawn as any).mockReturnValue(child);

      const summary = await startSubagentRun({
        cwd: '/project',
        questId: 'q1',
        questDir: '/project/.pi/quests/q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        task: 'do the thing',
      });

      // Simulate the supervisor's pauseRun: rewrite disk to `paused` while
      // the subprocess is still alive in the runner's eyes.
      const statusPath = summary.statusPath;
      const onDiskPaused = {
        ...(JSON.parse(fs.readFileSync(statusPath, 'utf-8') as string) as BackgroundRunSummary),
        status: 'paused',
        paused_at: new Date().toISOString(),
        paused_reason: 'unbounded_diff',
      };
      fs.writeFileSync(statusPath, JSON.stringify(onDiskPaused), 'utf-8');

      // Now the SIGTERM propagates and the runner's close handler fires with
      // a signal — that path calls finalize("cancelled"). The STATUS_RANK
      // gate must reject the downgrade.
      child.emit('close', null, 'SIGTERM');

      // Yield a microtask for any synchronous follow-ups.
      await Promise.resolve();

      const afterRunnerClose = JSON.parse(
        fs.readFileSync(statusPath, 'utf-8') as string,
      ) as BackgroundRunSummary;
      expect(afterRunnerClose.status).toBe('paused');
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

  describe('mergeCompletedRun (M1-3)', () => {
    beforeEach(async () => {
      const worktree = await import('./worktree');
      (worktree.mergeRunBranchIntoQuest as any).mockReset();
      (worktree.removeRunWorktree as any).mockReset().mockResolvedValue(undefined);
    });

    it('invokes mergeRunBranchIntoQuest and removes worktree on success', async () => {
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      const runSummary: BackgroundRunSummary = {
        runId: 'r1',
        questId: 'q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        status: 'completed',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:01:00Z',
        completedAt: '2024-01-01T12:01:00Z',
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: '/project/.pi/quests/q1/runs/r1.json',
      };
      vol.writeFileSync('/project/.pi/quests/q1/runs/r1.json', JSON.stringify(runSummary));

      const worktree = await import('./worktree');
      (worktree.mergeRunBranchIntoQuest as any).mockResolvedValue({ ok: true });

      await mergeCompletedRun({
        repoRoot: '/project',
        questDir: '/project/.pi/quests/q1',
        questId: 'q1',
        runId: 'r1',
        workItemId: '001',
        runBranch: 'quest-run/q1/r1',
        questBranch: 'quest/q1',
        worktreePath: '/project/.pi/quests/q1/worktrees/r1',
      });

      expect(worktree.mergeRunBranchIntoQuest).toHaveBeenCalledWith({
        repoRoot: '/project',
        questBranch: 'quest/q1',
        runBranch: 'quest-run/q1/r1',
      });
      expect(worktree.removeRunWorktree).toHaveBeenCalledWith(
        '/project/.pi/quests/q1/worktrees/r1',
      );
    });

    it('merges a resumed Run (with continues_from) using the same Run Branch — chain support (M4-4)', async () => {
      // A run spawned by Resume carries `continues_from`. Its runBranch is the
      // SAME as the paused predecessor — commits append linearly. The standard
      // merge path must pick it up exactly like any other completed run.
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      const resumedRun: BackgroundRunSummary = {
        runId: 'r-resumed',
        questId: 'q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        status: 'completed',
        startedAt: '2024-01-01T13:00:00Z',
        updatedAt: '2024-01-01T13:30:00Z',
        completedAt: '2024-01-01T13:30:00Z',
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: '/project/.pi/quests/q1/runs/r-resumed.json',
        continues_from: 'r-paused',
        worktreePath: '/project/.pi/quests/q1/worktrees/r-paused',
        runBranch: 'quest-run/q1/r-paused',
        questBranch: 'quest/q1',
      };
      vol.writeFileSync('/project/.pi/quests/q1/runs/r-resumed.json', JSON.stringify(resumedRun));

      const worktree = await import('./worktree');
      (worktree.mergeRunBranchIntoQuest as any).mockResolvedValue({ ok: true });

      await mergeCompletedRun({
        repoRoot: '/project',
        questDir: '/project/.pi/quests/q1',
        questId: 'q1',
        runId: 'r-resumed',
        workItemId: '001',
        runBranch: 'quest-run/q1/r-paused', // same as the paused predecessor
        questBranch: 'quest/q1',
        worktreePath: '/project/.pi/quests/q1/worktrees/r-paused',
      });

      expect(worktree.mergeRunBranchIntoQuest).toHaveBeenCalledWith({
        repoRoot: '/project',
        questBranch: 'quest/q1',
        runBranch: 'quest-run/q1/r-paused',
      });
      expect(worktree.removeRunWorktree).toHaveBeenCalledWith(
        '/project/.pi/quests/q1/worktrees/r-paused',
      );
    });

    it('emits anomaly_detected (tier: halt, rule: merge_conflict) on merge failure', async () => {
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      const runSummary: BackgroundRunSummary = {
        runId: 'r1',
        questId: 'q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        status: 'completed',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:01:00Z',
        completedAt: '2024-01-01T12:01:00Z',
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: '/project/.pi/quests/q1/runs/r1.json',
      };
      vol.writeFileSync('/project/.pi/quests/q1/runs/r1.json', JSON.stringify(runSummary));

      const worktree = await import('./worktree');
      (worktree.mergeRunBranchIntoQuest as any).mockResolvedValue({
        ok: false,
        conflict: 'CONFLICT (content): src/foo.ts',
      });

      await mergeCompletedRun({
        repoRoot: '/project',
        questDir: '/project/.pi/quests/q1',
        questId: 'q1',
        runId: 'r1',
        workItemId: '001',
        runBranch: 'quest-run/q1/r1',
        questBranch: 'quest/q1',
        worktreePath: '/project/.pi/quests/q1/worktrees/r1',
      });

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const anomaly = events.find((e) => e.event === 'anomaly_detected');
      expect(anomaly).toBeDefined();
      expect(anomaly.tier).toBe('halt');
      expect(anomaly.rule).toBe('merge_conflict');
      expect(anomaly.runId).toBe('r1');
      expect(anomaly.details.runBranch).toBe('quest-run/q1/r1');
      expect(anomaly.details.questBranch).toBe('quest/q1');
      expect(anomaly.details.conflict).toContain('CONFLICT');

      // Run status should be flipped to failed.
      const updated = JSON.parse(
        vol.readFileSync('/project/.pi/quests/q1/runs/r1.json', 'utf-8') as string,
      );
      expect(updated.status).toBe('failed');
    });
  });

  describe('reapOrphanWorktrees (M1-3)', () => {
    beforeEach(async () => {
      const worktree = await import('./worktree');
      (worktree.listRunWorktrees as any).mockReset();
      (worktree.removeRunWorktree as any).mockReset().mockResolvedValue(undefined);
    });

    it('prunes worktrees whose run summary does not exist', async () => {
      const worktree = await import('./worktree');
      (worktree.listRunWorktrees as any).mockResolvedValue([
        { path: '/project', branch: 'main' },
        {
          path: '/project/.pi/quests/q1/worktrees/orphan-run',
          branch: 'quest-run/q1/orphan-run',
        },
      ]);

      // No runs/orphan-run.json exists → orphan.
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });

      const pruned = await reapOrphanWorktrees('/project');

      expect(pruned).toEqual(['/project/.pi/quests/q1/worktrees/orphan-run']);
      expect(worktree.removeRunWorktree).toHaveBeenCalledWith(
        '/project/.pi/quests/q1/worktrees/orphan-run',
      );
    });

    it('prunes worktrees whose run status is orphaned/cancelled/failed/completed', async () => {
      const worktree = await import('./worktree');
      (worktree.listRunWorktrees as any).mockResolvedValue([
        {
          path: '/project/.pi/quests/q1/worktrees/r-orphaned',
          branch: 'quest-run/q1/r-orphaned',
        },
        {
          path: '/project/.pi/quests/q1/worktrees/r-cancelled',
          branch: 'quest-run/q1/r-cancelled',
        },
        {
          path: '/project/.pi/quests/q1/worktrees/r-failed',
          branch: 'quest-run/q1/r-failed',
        },
        {
          path: '/project/.pi/quests/q1/worktrees/r-completed',
          branch: 'quest-run/q1/r-completed',
        },
      ]);

      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      const mkRun = (runId: string, status: BackgroundRunSummary['status']) => {
        const summary: BackgroundRunSummary = {
          runId,
          questId: 'q1',
          workItemId: '001',
          agentName: 'quest-implementation',
          status,
          startedAt: '2024-01-01T12:00:00Z',
          updatedAt: '2024-01-01T12:01:00Z',
          stdoutPath: '/x',
          stderrPath: '/y',
          reportPath: '/z',
          statusPath: `/project/.pi/quests/q1/runs/${runId}.json`,
        };
        vol.writeFileSync(`/project/.pi/quests/q1/runs/${runId}.json`, JSON.stringify(summary));
      };
      mkRun('r-orphaned', 'orphaned');
      mkRun('r-cancelled', 'cancelled');
      mkRun('r-failed', 'failed');
      mkRun('r-completed', 'completed');

      const pruned = await reapOrphanWorktrees('/project');
      expect(pruned.sort()).toEqual([
        '/project/.pi/quests/q1/worktrees/r-cancelled',
        '/project/.pi/quests/q1/worktrees/r-completed',
        '/project/.pi/quests/q1/worktrees/r-failed',
        '/project/.pi/quests/q1/worktrees/r-orphaned',
      ]);
    });

    it('preserves worktrees whose run is still running', async () => {
      const worktree = await import('./worktree');
      (worktree.listRunWorktrees as any).mockResolvedValue([
        {
          path: '/project/.pi/quests/q1/worktrees/r-live',
          branch: 'quest-run/q1/r-live',
        },
      ]);
      vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
      const summary: BackgroundRunSummary = {
        runId: 'r-live',
        questId: 'q1',
        workItemId: '001',
        agentName: 'quest-implementation',
        status: 'running',
        startedAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:01:00Z',
        stdoutPath: '/x',
        stderrPath: '/y',
        reportPath: '/z',
        statusPath: '/project/.pi/quests/q1/runs/r-live.json',
      };
      vol.writeFileSync('/project/.pi/quests/q1/runs/r-live.json', JSON.stringify(summary));

      const pruned = await reapOrphanWorktrees('/project');
      expect(pruned).toEqual([]);
      expect(worktree.removeRunWorktree).not.toHaveBeenCalled();
    });

    it('ignores the main checkout worktree (no quest-run/ branch)', async () => {
      const worktree = await import('./worktree');
      (worktree.listRunWorktrees as any).mockResolvedValue([
        { path: '/project', branch: 'main' },
      ]);
      const pruned = await reapOrphanWorktrees('/project');
      expect(pruned).toEqual([]);
      expect(worktree.removeRunWorktree).not.toHaveBeenCalled();
    });
  });
});
