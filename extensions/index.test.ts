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

  it('registers one command and five tools', () => {
    piQuestExtension(mockPi as any);
    expect(mockPi.registerShortcut).toHaveBeenCalledTimes(1);
    expect(mockPi.registerShortcut).toHaveBeenCalledWith(
      'ctrl+shift+g',
      expect.objectContaining({ description: 'Open quest dashboard' }),
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
    ]);
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
});
