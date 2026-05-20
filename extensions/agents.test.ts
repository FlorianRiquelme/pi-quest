import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import {
	parseAgentDef,
	normalizeModel,
	getAgentDef,
	compactRunLine,
	recordRunFinished,
} from './agents';
import type { BackgroundRunSummary } from './types';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

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
