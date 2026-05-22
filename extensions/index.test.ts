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

vi.mock('@earendil-works/pi-tui', () => ({
  Text: class Text {
    text: string;
    constructor(text: string, public x: number, public y: number) {
      this.text = text;
    }
    setText(text: string) {
      this.text = text;
    }
  },
}));

vi.mock('@earendil-works/pi-ai', () => ({
  StringEnum: (values: readonly string[]) => ({ type: 'string', enum: [...values] }),
}));

vi.mock('./runs/worktree.js', () => ({
  getHeadSha: vi.fn().mockResolvedValue('basesha-deadbeef'),
  ensureQuestBranch: vi
    .fn()
    .mockImplementation(async ({ questId }: { questId: string }) => ({
      questBranch: `quest/${questId}`,
      created: true,
    })),
  createRunWorktree: vi.fn().mockImplementation(async ({ questId, runId, repoRoot }: any) => ({
    worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
    runBranch: `quest-run/${questId}/${runId}`,
  })),
  removeRunWorktree: vi.fn().mockResolvedValue(undefined),
  listRunWorktrees: vi.fn().mockResolvedValue([]),
  mergeRunBranchIntoQuest: vi.fn().mockResolvedValue({ ok: true }),
  worktreePathFor: (repoRoot: string, questId: string, runId: string) =>
    `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
}));

import { fs, vol } from 'memfs';
import piQuestExtension from './index';

describe('piQuestExtension', () => {
  let registeredCommands: Record<string, any> = {};
  let registeredTools: Record<string, any> = {};
  let eventHandlers: Record<string, any> = {};

  const mockUi = {
    notify: vi.fn(),
    setStatus: vi.fn(),
  };

  const mockPi = {
    registerCommand: vi.fn((name: string, def: any) => {
      registeredCommands[name] = def;
    }),
    registerTool: vi.fn((def: any) => {
      registeredTools[def.name] = def;
    }),
    registerShortcut: vi.fn(),
    on: vi.fn((event: string, handler: any) => {
      eventHandlers[event] = handler;
    }),
    // Issue #4: engageSkill is wired in via engageSkillFactory(pi), which calls
    // these at engagement time. The factory closure is built at extension
    // registration, so even tests that don't drive an interactive-stage entry
    // need the methods present.
    getCommands: vi.fn(() => [] as Array<{ name: string; source: string; sourceInfo: { path: string; baseDir?: string } }>),
    sendUserMessage: vi.fn(),
  };

  beforeEach(() => {
    vol.reset();
    registeredCommands = {};
    registeredTools = {};
    eventHandlers = {};
    vi.clearAllMocks();
  });

  describe('/quest auto-router (M2-1)', () => {
    const mockCtx = (cwd: string) => ({
      cwd,
      ui: { ...mockUi, setWidget: vi.fn() },
    });

    it('routes from planned → launch-review and loads the skill instructions inline', async () => {
      const workflow = {
        id: 'lr-quest',
        title: 'Launch quest',
        status: 'planned',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' },
      };
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'lr-quest' }),
        '/project/.pi/quests/lr-quest/workflow.json': JSON.stringify(workflow),
      });

      piQuestExtension(mockPi as any);
      const handler = registeredCommands['quest'].handler;
      await handler('', mockCtx('/project'));

      const persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/lr-quest/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('launch-review');

      // The router notifies the user that the Launch Review skill is loaded inline.
      const launchReviewNotify = (mockUi.notify as any).mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('Launch Review'),
      );
      expect(launchReviewNotify).toBeDefined();
    });

    it('drives an end-to-end quest from planned → launch-review → executing via the ceremony', async () => {
      const workflow = {
        id: 'e2e-quest',
        title: 'E2E Launch Review',
        status: 'planned',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' },
      };
      // Pre-populate the plan with the Trinity (minus sign-off).
      const planText =
        '---\n' +
        'blast_radius:\n' +
        '  in_scope:\n' +
        '    - src/foo.ts\n' +
        'pre_mortem:\n' +
        '  most_likely_failure: regression in callers\n' +
        'compiler_diagnostics: []\n' +
        '---\n\n# Plan\n';
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'e2e-quest' }),
        '/project/.pi/quests/e2e-quest/workflow.json': JSON.stringify(workflow),
        '/project/.pi/quests/e2e-quest/IMPLEMENTATION_PLAN.md': planText,
      });

      piQuestExtension(mockPi as any);
      const handler = registeredCommands['quest'].handler;
      const ctx = mockCtx('/project');

      // Step 1: /quest (auto-router) advances planned → launch-review.
      await handler('', ctx);
      let persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/e2e-quest/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('launch-review');

      // Step 2: the skill records sign-off into the plan frontmatter.
      const { recordLaunchReviewSignOff } = await import('./launch-review');
      recordLaunchReviewSignOff('/project/.pi/quests/e2e-quest/IMPLEMENTATION_PLAN.md');

      // Step 3: /quest set-status e2e-quest executing — gate passes.
      await handler('set-status e2e-quest executing', ctx);
      persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/e2e-quest/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('executing');

      // launch_gate event with outcome: passed must be in events.jsonl.
      const jsonl = vol.readFileSync(
        '/project/.pi/quests/e2e-quest/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const gateEvent = events.find((e) => e.event === 'launch_gate');
      expect(gateEvent).toBeDefined();
      expect(gateEvent.outcome).toBe('passed');
      expect(gateEvent.reasons).toEqual([]);
      expect(gateEvent.questId).toBe('e2e-quest');
    });

    it('does not auto-advance from intake', async () => {
      const workflow = {
        id: 'lr-quest',
        title: 'Launch quest',
        status: 'intake',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'H.md' },
      };
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'lr-quest' }),
        '/project/.pi/quests/lr-quest/workflow.json': JSON.stringify(workflow),
      });

      piQuestExtension(mockPi as any);
      const handler = registeredCommands['quest'].handler;
      await handler('', mockCtx('/project'));

      const persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/lr-quest/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('intake');
    });
  });

  it('registers one command, three shortcuts (dashboard + freeze chords), and seven tools', () => {
    piQuestExtension(mockPi as any);
    // Dashboard + Alt+P (soft freeze) + Ctrl+Shift+P (hard freeze)
    //
    // Soft freeze used to live on Ctrl+P, but that collides with pi v0.75's
    // built-in model-switch chord (pi logs `Extension shortcut 'ctrl+p' ...
    // conflicts with built-in shortcut. Skipping.` and silently drops the
    // registration). Alt+P avoids the collision while preserving the
    // single-key freeze property mandated by ADR 013's "Asymmetric Interrupt
    // Cost" principle.
    expect(mockPi.registerShortcut).toHaveBeenCalledTimes(3);
    expect(mockPi.registerShortcut).toHaveBeenCalledWith(
      'ctrl+shift+g',
      expect.objectContaining({ description: 'Open quest dashboard' }),
    );
    expect(mockPi.registerShortcut).toHaveBeenCalledWith(
      'alt+p',
      expect.objectContaining({
        description: expect.stringMatching(/soft freeze/i),
      }),
    );
    expect(mockPi.registerShortcut).toHaveBeenCalledWith(
      'ctrl+shift+p',
      expect.objectContaining({
        description: expect.stringMatching(/hard freeze/i),
      }),
    );

    // No chord collision: each chord registered exactly once.
    const chords = mockPi.registerShortcut.mock.calls.map((c: any[]) => c[0]);
    expect(new Set(chords).size).toBe(chords.length);

    // The old Ctrl+P binding must be gone — it collides with pi v0.75's
    // built-in model-switch chord and was silently dropped at startup.
    expect(mockPi.registerShortcut).not.toHaveBeenCalledWith(
      'ctrl+p',
      expect.anything(),
    );
    expect(mockPi.registerShortcut).not.toHaveBeenCalledWith(
      'alt+g',
      expect.anything(),
    );

    expect(Object.keys(registeredCommands)).toEqual(['quest']);
    expect(Object.keys(registeredTools)).toEqual([
      'quest_run_work_item',
      'quest_work_item_status',
      'quest_rescue',
      'quest_write_workflow',
      'quest_telemetry_event',
      'quest_progress_beat',
      'quest_concession',
    ]);
  });

  describe('/quest freeze and /quest unfreeze (slash-command fallback for Alt+P)', () => {
    // The single-key Alt+P chord is the load-bearing UX (ADR 013 §8 — Asymmetric
    // Interrupt Cost), but some terminals can't bind Alt-chords. These slash
    // commands give those users an equivalent path, emitting the same audit
    // events.
    const mockCtx = (cwd: string) => ({
      cwd,
      ui: { ...mockUi, setWidget: vi.fn() },
    });

    const questId = 'sf-quest';
    const qDir = `/project/.pi/quests/${questId}`;

    function seedQuest(overrides: any = {}) {
      const workflow = {
        id: questId,
        title: 'Soft Freeze Quest',
        status: 'executing',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'H.md' },
        ...overrides,
      };
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: questId }),
        [`${qDir}/workflow.json`]: JSON.stringify(workflow),
      });
    }

    function readEvents(): any[] {
      const path = `${qDir}/telemetry/events.jsonl`;
      if (!vol.existsSync(path)) return [];
      const raw = vol.readFileSync(path, 'utf-8') as string;
      return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }

    it('/quest freeze engages a soft freeze and emits freeze_engaged', async () => {
      seedQuest();
      piQuestExtension(mockPi as any);
      const handler = registeredCommands['quest'].handler;

      await handler('freeze', mockCtx('/project'));

      const persisted = JSON.parse(
        vol.readFileSync(`${qDir}/workflow.json`, 'utf-8') as string,
      );
      expect(persisted.freeze).toBeDefined();
      expect(persisted.freeze.mode).toBe('soft');
      expect(persisted.freeze.triggered_by).toBe('user');

      const events = readEvents();
      const engaged = events.find((e) => e.event === 'freeze_engaged');
      expect(engaged).toBeDefined();
      expect(engaged.mode).toBe('soft');
      expect(engaged.triggered_by).toBe('user');
      expect(engaged.questId).toBe(questId);
    });

    it('/quest unfreeze releases an active soft freeze and emits freeze_released', async () => {
      seedQuest({
        freeze: {
          mode: 'soft',
          engaged_at: '2024-01-01T00:00:00Z',
          triggered_by: 'user',
        },
      });
      piQuestExtension(mockPi as any);
      const handler = registeredCommands['quest'].handler;

      await handler('unfreeze', mockCtx('/project'));

      const persisted = JSON.parse(
        vol.readFileSync(`${qDir}/workflow.json`, 'utf-8') as string,
      );
      expect(persisted.freeze).toBeUndefined();

      const events = readEvents();
      const released = events.find((e) => e.event === 'freeze_released');
      expect(released).toBeDefined();
      expect(released.triggered_by).toBe('user');
      expect(released.questId).toBe(questId);
    });

    it('/quest freeze is idempotent — second invocation releases (toggle parity with Alt+P)', async () => {
      seedQuest();
      piQuestExtension(mockPi as any);
      const handler = registeredCommands['quest'].handler;

      await handler('freeze', mockCtx('/project'));
      await handler('freeze', mockCtx('/project'));

      const persisted = JSON.parse(
        vol.readFileSync(`${qDir}/workflow.json`, 'utf-8') as string,
      );
      // Second freeze call on an already-frozen quest releases it, matching
      // the toggle semantics of the Alt+P chord.
      expect(persisted.freeze).toBeUndefined();

      const events = readEvents();
      expect(events.filter((e) => e.event === 'freeze_engaged')).toHaveLength(1);
      expect(events.filter((e) => e.event === 'freeze_released')).toHaveLength(1);
    });

    it('/quest unfreeze on a non-frozen quest is a no-op (no freeze_released event)', async () => {
      seedQuest();
      piQuestExtension(mockPi as any);
      const handler = registeredCommands['quest'].handler;

      await handler('unfreeze', mockCtx('/project'));

      const events = readEvents();
      expect(events.filter((e) => e.event === 'freeze_released')).toHaveLength(0);
    });
  });

  describe('quest_write_workflow', () => {
    it('reads workflow.json when action is read', async () => {
      const workflow = {
        id: 'test-quest',
        title: 'Test Quest',
        status: 'intake',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: { handoffPath: 'handoff.md' },
        artifacts: { handoff: 'HANDOFF.md' },
      };

      vol.fromJSON({
        '/project/.pi/quests/test-quest/workflow.json': JSON.stringify(workflow, null, 2),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_write_workflow'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'test-quest', action: 'read' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBeFalsy();
      expect(result.details.workflow.id).toBe('test-quest');
      expect(result.content[0].text).toContain('test-quest');
    });

    it('returns error when quest not found', async () => {
      vol.fromJSON({});

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_write_workflow'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'missing-quest', action: 'read' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('updates status with valid transition', async () => {
      const workflow = {
        id: 'test-quest',
        title: 'Test Quest',
        status: 'intake',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      };

      vol.fromJSON({
        '/project/.pi/quests/test-quest/workflow.json': JSON.stringify(workflow),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_write_workflow'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'test-quest', action: 'set-status', status: 'reviewing' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Status updated to 'reviewing'");
      expect(result.details.workflow.status).toBe('reviewing');

      const updated = JSON.parse(
        vol.readFileSync('/project/.pi/quests/test-quest/workflow.json', 'utf-8') as string,
      );
      expect(updated.status).toBe('reviewing');
    });

    it('rejects invalid transition without force', async () => {
      const workflow = {
        id: 'test-quest',
        title: 'Test Quest',
        status: 'intake',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      };

      vol.fromJSON({
        '/project/.pi/quests/test-quest/workflow.json': JSON.stringify(workflow),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_write_workflow'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'test-quest', action: 'set-status', status: 'completed' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid transition');
    });

    it('rejects verification-ready without VERIFICATION.md', async () => {
      const workflow = {
        id: 'test-quest',
        title: 'Test Quest',
        status: 'verification',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md', verification: 'VERIFICATION.md' },
      };

      vol.fromJSON({
        '/project/.pi/quests/test-quest/workflow.json': JSON.stringify(workflow),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_write_workflow'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'test-quest', action: 'set-status', status: 'verification-ready' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Gate check failed');
      expect(result.details.missingArtifact).toContain('VERIFICATION.md');
    });

    it('allows verification-ready when VERIFICATION.md exists', async () => {
      const workflow = {
        id: 'test-quest',
        title: 'Test Quest',
        status: 'verification',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md', verification: 'VERIFICATION.md' },
      };

      vol.fromJSON({
        '/project/.pi/quests/test-quest/workflow.json': JSON.stringify(workflow),
        '/project/.pi/quests/test-quest/VERIFICATION.md': '# Verification\n\n## Verdict\npass',
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_write_workflow'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'test-quest', action: 'set-status', status: 'verification-ready' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBeFalsy();
      expect(result.details.workflow.status).toBe('verification-ready');
    });

    describe('UAT doorbell (M4-2)', () => {
      const baseWorkflow = (overrides: Record<string, unknown> = {}) => ({
        id: 'q-uat',
        title: 'Doorbell Quest',
        status: 'verification-ready',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md', verification: 'VERIFICATION.md' },
        ...overrides,
      });

      it('fires terminal bell + notify when transitioning from verification-ready', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q-uat/workflow.json': JSON.stringify(baseWorkflow()),
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
          piQuestExtension(mockPi as any);
          const tool = registeredTools['quest_write_workflow'];
          const result = await tool.execute(
            'tc-1',
            { questId: 'q-uat', action: 'set-status', status: 'uat-ready' },
            undefined,
            undefined,
            { cwd: '/project', ui: mockUi },
          );
          expect(result.isError).toBeFalsy();
          const bellWrites = stdoutSpy.mock.calls.filter((call) => call[0] === '\x07');
          expect(bellWrites).toHaveLength(1);
        } finally {
          stdoutSpy.mockRestore();
        }
        const doorbellCalls = (mockUi.notify as any).mock.calls.filter(
          (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('UAT pending for'),
        );
        expect(doorbellCalls).toHaveLength(1);
        expect(doorbellCalls[0][0]).toBe('UAT pending for Doorbell Quest');
        expect(doorbellCalls[0][1]).toBe('info');

        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q-uat/workflow.json', 'utf-8') as string,
        );
        expect(persisted.uat_doorbell_fired_at).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
      });

      it('does not re-fire on uat-failed → uat-ready re-entry', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q-uat/workflow.json': JSON.stringify(
            baseWorkflow({
              status: 'uat-failed',
              uat_doorbell_fired_at: '2024-01-02T00:00:00.000Z',
            }),
          ),
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
          piQuestExtension(mockPi as any);
          const tool = registeredTools['quest_write_workflow'];
          const result = await tool.execute(
            'tc-1',
            { questId: 'q-uat', action: 'set-status', status: 'uat-ready' },
            undefined,
            undefined,
            { cwd: '/project', ui: mockUi },
          );
          expect(result.isError).toBeFalsy();
          const bellWrites = stdoutSpy.mock.calls.filter((call) => call[0] === '\x07');
          expect(bellWrites).toHaveLength(0);
        } finally {
          stdoutSpy.mockRestore();
        }
        const doorbellCalls = (mockUi.notify as any).mock.calls.filter(
          (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('UAT pending for'),
        );
        expect(doorbellCalls).toHaveLength(0);
      });
    });

    it('allows invalid transition with force=true', async () => {
      const workflow = {
        id: 'test-quest',
        title: 'Test Quest',
        status: 'intake',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      };

      vol.fromJSON({
        '/project/.pi/quests/test-quest/workflow.json': JSON.stringify(workflow),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_write_workflow'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'test-quest', action: 'set-status', status: 'completed', force: true },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBeFalsy();
      expect(result.details.workflow.status).toBe('completed');
    });
  });

  describe('quest_telemetry_event', () => {
    it('appends a valid event to events.jsonl', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1',
          title: 'Q',
          status: 'intake',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          source: {},
          artifacts: { handoff: 'H.md' },
        }),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_telemetry_event'];

      const result = await tool.execute(
        'tc-1',
        {
          questId: 'q1',
          event: 'run_finished',
          runId: 'run-1',
          workItemId: '001',
          details: { status: 'completed', exitCode: 0 },
        },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('Telemetry event recorded.');

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n');
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event.event).toBe('run_finished');
      expect(event.runId).toBe('run-1');
      expect(event.workItemId).toBe('001');
      expect(event.questId).toBe('q1');
      expect(typeof event.timestamp).toBe('string');
    });

    it('rejects an unknown event kind', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1',
          title: 'Q',
          status: 'intake',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          source: {},
          artifacts: { handoff: 'H.md' },
        }),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_telemetry_event'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'q1', event: 'not_a_real_event' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not_a_real_event|unknown|invalid/i);

      // Nothing should have been written to events.jsonl.
      expect(
        vol.existsSync('/project/.pi/quests/q1/telemetry/events.jsonl'),
      ).toBe(false);
    });

    it('returns error when quest not found', async () => {
      vol.fromJSON({});

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_telemetry_event'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'missing', event: 'stage_entered', to: 'reviewing' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBe(true);
    });
  });

  describe('quest_progress_beat', () => {
    function workflowJSON() {
      return JSON.stringify({
        id: 'q1',
        title: 'Q',
        status: 'executing',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'H.md' },
      });
    }

    it('emits a valid progress_beat event when supplied phase, runId, questId', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': workflowJSON(),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_progress_beat'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'q1', runId: 'run-1', phase: 'implementing', confidence: 0.7, note: 'edited foo' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBeFalsy();

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event.event).toBe('progress_beat');
      expect(event.phase).toBe('implementing');
      expect(event.confidence).toBe(0.7);
      expect(event.note).toBe('edited foo');
      expect(event.runId).toBe('run-1');
      expect(event.questId).toBe('q1');
      expect(typeof event.timestamp).toBe('string');
    });

    it('rate-limits beats to 1 per 15s per runId (second beat is a success no-op)', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': workflowJSON(),
      });

      // Reset the in-memory last-beat map so the test is hermetic.
      const { __lastBeatAtForTests } = await import('./runs/runner');
      __lastBeatAtForTests.clear();

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_progress_beat'];

      const first = await tool.execute(
        'tc-1',
        { questId: 'q1', runId: 'run-1', phase: 'implementing' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );
      expect(first.isError).toBeFalsy();

      // Second call immediately after — within 15s window. Expect no-op.
      const second = await tool.execute(
        'tc-2',
        { questId: 'q1', runId: 'run-1', phase: 'still implementing' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );
      expect(second.isError).toBeFalsy();

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);

      // The result text or details should signal rate-limited.
      const text = (second.content?.[0] as { text?: string } | undefined)?.text ?? '';
      const flagged =
        text.toLowerCase().includes('rate') ||
        (second.details && (second.details as any).rateLimited === true);
      expect(flagged).toBeTruthy();
    });

    it('does NOT rate-limit a different runId', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': workflowJSON(),
      });
      const { __lastBeatAtForTests } = await import('./runs/runner');
      __lastBeatAtForTests.clear();

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_progress_beat'];

      await tool.execute(
        'tc-1',
        { questId: 'q1', runId: 'run-1', phase: 'a' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );
      await tool.execute(
        'tc-2',
        { questId: 'q1', runId: 'run-2', phase: 'b' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });

    it('returns error when quest not found', async () => {
      vol.fromJSON({});

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_progress_beat'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'missing', runId: 'run-1', phase: 'x' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBe(true);
    });
  });

  describe('quest_concession', () => {
    function workflowJSON() {
      return JSON.stringify({
        id: 'q1',
        title: 'Q',
        status: 'executing',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'H.md' },
      });
    }

    it('emits a valid concession event', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': workflowJSON(),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_concession'];

      const result = await tool.execute(
        'tc-1',
        {
          questId: 'q1',
          runId: 'run-1',
          decision: 'used existing helper instead of adding lib',
          rationale: 'simpler and faster',
        },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      expect(result.isError).toBeFalsy();

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event.event).toBe('concession');
      expect(event.decision).toBe('used existing helper instead of adding lib');
      expect(event.rationale).toBe('simpler and faster');
      expect(event.runId).toBe('run-1');
      expect(event.questId).toBe('q1');
    });

    it('is not rate-limited (two concessions in a row both land)', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': workflowJSON(),
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_concession'];

      await tool.execute(
        'tc-1',
        { questId: 'q1', runId: 'run-1', decision: 'd1', rationale: 'r1' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );
      await tool.execute(
        'tc-2',
        { questId: 'q1', runId: 'run-1', decision: 'd2', rationale: 'r2' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const lines = jsonl.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });

    it('returns error when quest not found', async () => {
      vol.fromJSON({});

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_concession'];

      const result = await tool.execute(
        'tc-1',
        { questId: 'missing', runId: 'r', decision: 'd', rationale: 'r' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe('autonomous agent definitions', () => {
    it('implementation agent declares quest_progress_beat and quest_concession tools', async () => {
      // Use real fs to read the on-disk agent file, since `node:fs` is mocked.
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const path = await import('node:path');
      const filePath = path.resolve(__dirname, '..', 'agents', 'implementation.md');
      const content = realFs.readFileSync(filePath, 'utf-8');
      expect(content).toMatch(/quest_progress_beat/);
      expect(content).toMatch(/quest_concession/);
    });
  });

  describe('Homecoming Brief auto-trigger via quest_write_workflow (M4-1)', () => {
    beforeEach(async () => {
      const { __setNarrativeSpawnerForTests } = await import('./commands');
      __setNarrativeSpawnerForTests(async () => 'STUB NARRATIVE BODY');
    });

    it('regenerates BRIEF.md when set-status advances executing → verification-ready', async () => {
      const workflow = {
        id: 'qb',
        title: 'Brief Test',
        status: 'verification',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: {
          handoff: 'HANDOFF.md',
          verification: 'VERIFICATION.md',
          brief: 'BRIEF.md',
        },
        baseSha: 'abc1234',
        questBranch: 'quest/qb',
      };
      vol.fromJSON({
        '/project/.pi/quests/qb/workflow.json': JSON.stringify(workflow),
        '/project/.pi/quests/qb/VERIFICATION.md': '# Verification\npass\n',
      });

      piQuestExtension(mockPi as any);
      const tool = registeredTools['quest_write_workflow'];
      const result = await tool.execute(
        'tc-1',
        { questId: 'qb', action: 'set-status', status: 'verification-ready' },
        undefined,
        undefined,
        { cwd: '/project', ui: mockUi },
      );
      expect(result.isError).toBeFalsy();
      expect(vol.existsSync('/project/.pi/quests/qb/BRIEF.md')).toBe(true);
      const brief = vol.readFileSync('/project/.pi/quests/qb/BRIEF.md', 'utf-8') as string;
      expect(brief).toContain('STUB NARRATIVE BODY');
      expect(brief).toContain('## Narrative');
    });
  });
});
