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

  it('registers one command and five tools', () => {
    piQuestExtension(mockPi as any);
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
