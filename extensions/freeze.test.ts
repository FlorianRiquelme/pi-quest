/**
 * Freeze chord tests — M3-2 / ADR 013 §8.
 *
 * Covers:
 *   - soft freeze toggle (engage, then release)
 *   - `freeze_engaged` / `freeze_released` events emitted with correct fields
 *   - startSubagentRun refuses to spawn while soft freeze is active
 *   - hard freeze confirmation gate ('y' aborts, anything else cancels)
 *   - hard freeze SIGTERM → 5s grace → SIGKILL escalation
 *   - hard freeze transitions quest to `blocked` with `cancel_reason: user_aborted`
 *   - hard freeze marks each killed run cancelled and emits `run_finished`
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  withFileMutationQueue: async (_path: string, fn: () => Promise<any>) => fn(),
}));

import { vol } from 'memfs';
import {
  handleSoftFreezeChord,
  handleHardFreezeChord,
} from './freeze';
import { startSubagentRun, activeRuns } from './runs/runner';
import type { BackgroundRunSummary } from './types';

const cwd = '/project';
const questId = 'q1';
const qDir = `/project/.pi/quests/${questId}`;

function seedQuest(workflowOverrides: Partial<any> = {}) {
  const workflow = {
    id: questId,
    title: 'Test Quest',
    status: 'executing',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    source: {},
    artifacts: { handoff: 'H.md' },
    ...workflowOverrides,
  };
  vol.fromJSON({
    '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: questId }),
    [`${qDir}/workflow.json`]: JSON.stringify(workflow),
  });
}

function seedRunningRun(opts: { runId: string; workItemId: string; pid: number }) {
  const summary: BackgroundRunSummary = {
    runId: opts.runId,
    questId,
    workItemId: opts.workItemId,
    agentName: 'quest-implementation',
    status: 'running',
    startedAt: '2024-01-01T12:00:00Z',
    updatedAt: '2024-01-01T12:00:00Z',
    pid: opts.pid,
    stdoutPath: '/x',
    stderrPath: '/y',
    reportPath: '/z',
    statusPath: `${qDir}/runs/${opts.runId}.json`,
  };
  vol.mkdirSync(`${qDir}/runs`, { recursive: true });
  vol.writeFileSync(`${qDir}/runs/${opts.runId}.json`, JSON.stringify(summary));
  return summary;
}

function readWorkflow() {
  return JSON.parse(vol.readFileSync(`${qDir}/workflow.json`, 'utf-8') as string);
}

function readEvents(): any[] {
  const path = `${qDir}/telemetry/events.jsonl`;
  if (!vol.existsSync(path)) return [];
  const raw = vol.readFileSync(path, 'utf-8') as string;
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function makeCtx(overrides: any = {}) {
  return {
    cwd,
    ui: {
      notify: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      ...overrides,
    },
  };
}

describe('Alt+P (soft freeze toggle)', () => {
  beforeEach(() => {
    vol.reset();
    activeRuns.clear();
    vi.restoreAllMocks();
  });

  it('notifies and no-ops when no active quest', async () => {
    vol.fromJSON({ '/project/.pi/quest/state.json': JSON.stringify({}) });
    const ctx = makeCtx();

    await handleSoftFreezeChord(ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('No active quest'),
      'info',
    );
  });

  it('engages soft freeze when no freeze is active and counts in-flight runs', async () => {
    seedQuest();
    seedRunningRun({ runId: 'r1', workItemId: '001', pid: 111 });
    seedRunningRun({ runId: 'r2', workItemId: '002', pid: 222 });
    const ctx = makeCtx();

    await handleSoftFreezeChord(ctx as any);

    const wf = readWorkflow();
    expect(wf.freeze).toBeDefined();
    expect(wf.freeze.mode).toBe('soft');
    expect(wf.freeze.triggered_by).toBe('user');
    expect(typeof wf.freeze.engaged_at).toBe('string');

    const events = readEvents();
    const engaged = events.find((e) => e.event === 'freeze_engaged');
    expect(engaged).toBeDefined();
    expect(engaged.mode).toBe('soft');
    expect(engaged.in_flight_runs).toBe(2);
    expect(engaged.triggered_by).toBe('user');
    expect(engaged.questId).toBe(questId);

    // The user-visible hint must point at the new Alt+P chord, not the old
    // Ctrl+P (which pi v0.75 silently drops as a built-in conflict).
    const engagedNotify = ctx.ui.notify.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('Soft freeze engaged'),
    );
    expect(engagedNotify).toBeDefined();
    expect(engagedNotify[0]).toContain('Alt+P to release');
    expect(engagedNotify[0]).not.toContain('Ctrl+P');
  });

  it('releases soft freeze on second tap, emits freeze_released, clears workflow.freeze', async () => {
    seedQuest({
      freeze: {
        mode: 'soft',
        engaged_at: '2024-01-01T00:00:00Z',
        triggered_by: 'user',
      },
    });
    const ctx = makeCtx();

    await handleSoftFreezeChord(ctx as any);

    const wf = readWorkflow();
    expect(wf.freeze).toBeUndefined();

    const events = readEvents();
    const released = events.find((e) => e.event === 'freeze_released');
    expect(released).toBeDefined();
    expect(released.triggered_by).toBe('user');
    expect(released.questId).toBe(questId);
  });
});

describe('startSubagentRun refuses to spawn during soft freeze', () => {
  beforeEach(() => {
    vol.reset();
    activeRuns.clear();
    vi.restoreAllMocks();
  });

  it('throws (or returns an error result) and emits no run_started while soft freeze is active', async () => {
    seedQuest({
      freeze: {
        mode: 'soft',
        engaged_at: '2024-01-01T00:00:00Z',
        triggered_by: 'user',
      },
    });
    vol.mkdirSync('/agents', { recursive: true });
    vol.writeFileSync(
      '/agents/quest-implementation.md',
      '---\nname: quest-implementation\ndescription: impl\n---\nBody.',
    );

    const { spawn } = await import('node:child_process');

    await expect(
      startSubagentRun({
        cwd,
        questId,
        questDir: qDir,
        workItemId: '003',
        agentName: 'quest-implementation',
        task: 'do the thing',
      }),
    ).rejects.toThrow(/soft freeze/i);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not affect already-running runs (no kill called by the freeze guard)', async () => {
    seedQuest({
      freeze: {
        mode: 'soft',
        engaged_at: '2024-01-01T00:00:00Z',
        triggered_by: 'user',
      },
    });
    seedRunningRun({ runId: 'r1', workItemId: '001', pid: 111 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    // The freeze guard itself is the unit under test here — it must not signal
    // existing pids. (Hard freeze is the path that kills; soft freeze never does.)
    // We trigger the soft-freeze engage path again (idempotent) — observe no kill.
    // Workflow is already soft-frozen; release it, then engage again.
    const ctx = makeCtx();
    await handleSoftFreezeChord(ctx as any); // releases
    await handleSoftFreezeChord(ctx as any); // re-engages

    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});

describe('Ctrl+Shift+P (hard freeze)', () => {
  beforeEach(() => {
    vol.reset();
    activeRuns.clear();
    vi.restoreAllMocks();
  });

  it('notifies and no-ops when no active quest', async () => {
    vol.fromJSON({ '/project/.pi/quest/state.json': JSON.stringify({}) });
    const ctx = makeCtx();

    await handleHardFreezeChord(ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('No active quest'),
      'info',
    );
  });

  it('prompts with the in-flight run count and cancels on confirm=false', async () => {
    seedQuest();
    seedRunningRun({ runId: 'r1', workItemId: '001', pid: 111 });
    seedRunningRun({ runId: 'r2', workItemId: '002', pid: 222 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const ctx = makeCtx({ confirm: vi.fn().mockResolvedValue(false) });

    await handleHardFreezeChord(ctx as any);

    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    const confirmArgs = ctx.ui.confirm.mock.calls[0];
    // Prompt message should include the run count.
    expect(JSON.stringify(confirmArgs)).toMatch(/2/);

    // No kills, no events, workflow unchanged.
    expect(killSpy).not.toHaveBeenCalled();
    const events = readEvents();
    expect(events.filter((e) => e.event === 'freeze_engaged')).toHaveLength(0);
    expect(events.filter((e) => e.event === 'run_finished')).toHaveLength(0);

    const wf = readWorkflow();
    expect(wf.status).toBe('executing');
    expect(wf.cancel_reason).toBeUndefined();

    killSpy.mockRestore();
  });

  it('on confirm=true: SIGTERMs all running runs, then SIGKILLs after 5s if still alive', async () => {
    vi.useFakeTimers();
    try {
      seedQuest();
      seedRunningRun({ runId: 'r1', workItemId: '001', pid: 111 });
      seedRunningRun({ runId: 'r2', workItemId: '002', pid: 222 });

      // Simulate PIDs still alive after SIGTERM (process.kill(pid, 0) succeeds).
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const ctx = makeCtx({ confirm: vi.fn().mockResolvedValue(true) });

      const done = handleHardFreezeChord(ctx as any);

      // Allow microtasks to flush; SIGTERMs go out before the 5s timer.
      await vi.advanceTimersByTimeAsync(0);

      const termCalls = killSpy.mock.calls.filter((c) => c[1] === 'SIGTERM');
      const termPids = termCalls.map((c) => c[0]);
      expect(termPids).toEqual(expect.arrayContaining([111, 222]));

      // Before the grace window, no SIGKILLs.
      let killCalls = killSpy.mock.calls.filter((c) => c[1] === 'SIGKILL');
      expect(killCalls).toHaveLength(0);

      // Advance 5s; SIGKILLs fire for pids still alive.
      await vi.advanceTimersByTimeAsync(5_000);

      killCalls = killSpy.mock.calls.filter((c) => c[1] === 'SIGKILL');
      const killPids = killCalls.map((c) => c[0]);
      expect(killPids).toEqual(expect.arrayContaining([111, 222]));

      await done;

      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('on confirm=true: transitions quest to blocked with cancel_reason=user_aborted and emits freeze_engaged(mode=hard)', async () => {
    seedQuest();
    seedRunningRun({ runId: 'r1', workItemId: '001', pid: 111 });
    seedRunningRun({ runId: 'r2', workItemId: '002', pid: 222 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const ctx = makeCtx({ confirm: vi.fn().mockResolvedValue(true) });

    await handleHardFreezeChord(ctx as any);

    const wf = readWorkflow();
    expect(wf.status).toBe('blocked');
    expect(wf.cancel_reason).toBe('user_aborted');

    const events = readEvents();
    const engaged = events.find(
      (e) => e.event === 'freeze_engaged' && e.mode === 'hard',
    );
    expect(engaged).toBeDefined();
    expect(engaged.triggered_by).toBe('user');
    expect(engaged.in_flight_runs).toBe(2);

    killSpy.mockRestore();
  });

  it('on confirm=true: marks each killed run cancelled and emits run_finished with status=cancelled', async () => {
    seedQuest();
    seedRunningRun({ runId: 'r1', workItemId: '001', pid: 111 });
    seedRunningRun({ runId: 'r2', workItemId: '002', pid: 222 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const ctx = makeCtx({ confirm: vi.fn().mockResolvedValue(true) });

    await handleHardFreezeChord(ctx as any);

    const r1 = JSON.parse(
      vol.readFileSync(`${qDir}/runs/r1.json`, 'utf-8') as string,
    );
    const r2 = JSON.parse(
      vol.readFileSync(`${qDir}/runs/r2.json`, 'utf-8') as string,
    );
    expect(r1.status).toBe('cancelled');
    expect(r2.status).toBe('cancelled');

    const events = readEvents();
    const finishedR1 = events.find(
      (e) => e.event === 'run_finished' && e.runId === 'r1',
    );
    const finishedR2 = events.find(
      (e) => e.event === 'run_finished' && e.runId === 'r2',
    );
    expect(finishedR1?.details?.status).toBe('cancelled');
    expect(finishedR2?.details?.status).toBe('cancelled');

    killSpy.mockRestore();
  });
});
