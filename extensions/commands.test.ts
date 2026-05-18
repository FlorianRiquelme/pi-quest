import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import { showStatus, listQuests, cmdSelect, cmdSetStatus, cmdConfig } from './commands';
import type { CommandContext } from './types';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

vi.mock('./git.js', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue('feature/TEST-123'),
  getCurrentCommit: vi.fn().mockResolvedValue('abc1234'),
}));

describe('commands', () => {
  let notifyCalls: Array<{ msg: string; level: string }> = [];

  const mockCtx = (cwd: string): CommandContext =>
    ({
      cwd,
      ui: {
        notify: vi.fn((msg: string, level?: string) => {
          notifyCalls.push({ msg, level: level ?? "info" });
        }),
      },
    }) as unknown as CommandContext;

  beforeEach(() => {
    vol.reset();
    notifyCalls = [];
  });

  describe('showStatus', () => {
    it('notifies when no active quest', async () => {
      const ctx = mockCtx('/project');
      await showStatus(ctx);
      expect(notifyCalls[0].msg).toContain('No active quest');
    });

    it('shows active quest status', async () => {
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q1' }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1',
          title: 'My Quest',
          status: 'intake',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          source: {},
          artifacts: { handoff: 'H.md' },
        }),
      });
      const ctx = mockCtx('/project');
      await showStatus(ctx);
      expect(notifyCalls[0].msg).toContain('q1');
      expect(notifyCalls[0].msg).toContain('intake');
      expect(notifyCalls[0].msg).toContain('My Quest');
    });
  });

  describe('listQuests', () => {
    it('lists quests with markers', async () => {
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q2' }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'First', status: 'intake',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
        }),
        '/project/.pi/quests/q2/workflow.json': JSON.stringify({
          id: 'q2', title: 'Second', status: 'planned',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
        }),
      });
      const ctx = mockCtx('/project');
      await listQuests(ctx);
      expect(notifyCalls[0].msg).toContain('q1 [intake] First');
      expect(notifyCalls[0].msg).toContain('* q2 [planned] Second');
    });
  });

  describe('cmdSelect', () => {
    it('selects an existing quest', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': '{}',
      });
      const ctx = mockCtx('/project');
      await cmdSelect(ctx, ['q1']);
      expect(notifyCalls[0].msg).toContain("Active quest set to 'q1'");
    });

    it('warns when id missing', async () => {
      const ctx = mockCtx('/project');
      await cmdSelect(ctx, []);
      expect(notifyCalls[0].level).toBe('warning');
    });
  });

  describe('cmdSetStatus', () => {
    it('updates status with valid transition', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'intake',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
        }),
      });
      const ctx = mockCtx('/project');
      await cmdSetStatus(ctx, ['q1', 'reviewing']);
      expect(notifyCalls[0].msg).toContain("status → reviewing");
    });

    it('rejects invalid transition without force', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'intake',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
        }),
      });
      const ctx = mockCtx('/project');
      await cmdSetStatus(ctx, ['q1', 'completed']);
      expect(notifyCalls[0].level).toBe('error');
      expect(notifyCalls[0].msg).toContain('Invalid status transition');
    });

    it('rejects verification-ready without VERIFICATION.md', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'verification',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md', verification: 'VERIFICATION.md' },
        }),
      });
      const ctx = mockCtx('/project');
      await cmdSetStatus(ctx, ['q1', 'verification-ready']);
      expect(notifyCalls[0].level).toBe('error');
      expect(notifyCalls[0].msg).toContain('Gate check failed');
    });
  });

  describe('cmdConfig', () => {
    it('shows default config when no overrides exist', async () => {
      const ctx = mockCtx('/project');
      await cmdConfig(ctx);
      expect(notifyCalls[0].msg).toContain('Global config');
      expect(notifyCalls[0].msg).toContain('\nDefaults:');
    });
  });
});
