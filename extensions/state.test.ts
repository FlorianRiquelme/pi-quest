import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import { loadCurrentState, saveCurrentState, loadQuestWorkflow, saveQuestWorkflow, getAllQuestIds } from './state';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

describe('state', () => {
  beforeEach(() => {
    vol.reset();
  });

  describe('loadCurrentState / saveCurrentState', () => {
    it('round-trips current quest state', () => {
      saveCurrentState('/project', { currentQuestId: 'q1' });
      expect(loadCurrentState('/project')).toEqual({ currentQuestId: 'q1' });
    });

    it('returns empty object when state file missing', () => {
      expect(loadCurrentState('/project')).toEqual({});
    });
  });

  describe('loadQuestWorkflow / saveQuestWorkflow', () => {
    it('round-trips workflow', () => {
      const wf = {
        id: 'q1',
        title: 'Test Quest',
        status: 'intake' as const,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'HANDOFF.md' },
      };
      saveQuestWorkflow('/project/.pi/quests/q1', wf);
      expect(loadQuestWorkflow('/project/.pi/quests/q1')).toEqual(wf);
    });

    it('returns undefined when workflow missing', () => {
      expect(loadQuestWorkflow('/project/.pi/quests/missing')).toBeUndefined();
    });
  });

  describe('getAllQuestIds', () => {
    it('lists directory names under quests root', () => {
      vol.mkdirSync('/project/.pi/quests/q1', { recursive: true });
      vol.mkdirSync('/project/.pi/quests/q2', { recursive: true });
      expect(getAllQuestIds('/project')).toEqual(['q1', 'q2']);
    });

    it('returns empty array when quests dir missing', () => {
      expect(getAllQuestIds('/project')).toEqual([]);
    });
  });
});
