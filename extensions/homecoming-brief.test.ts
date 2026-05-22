/**
 * Tests for the Homecoming Brief generator (M4-1, ADR 015).
 *
 * The Brief is a six-section markdown artifact at
 * `.pi/quests/<questId>/BRIEF.md`. Five sections are template-driven (events,
 * reports, git stats); the Narrative section is composed by an injected
 * callback so tests can stub the LLM spawn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import * as path from 'node:path';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

import {
  generateHomecomingBrief,
  renderTitleBar,
  renderConcessions,
  renderAnomalies,
  renderReceipt,
  renderNext,
  computeReceipt,
  AUTONOMOUS_TO_INTERACTIVE_TRIGGERS,
  isAutonomousToInteractiveTransition,
} from './homecoming-brief';
import type { QuestEvent } from './events';

describe('homecoming-brief', () => {
  beforeEach(() => {
    vol.reset();
  });

  describe('renderTitleBar', () => {
    it('uses the quest title when present', () => {
      const out = renderTitleBar({
        questId: 'q1',
        title: 'My Quest Title',
        status: 'verification-ready',
        runsCompleted: 3,
        runsTotal: 4,
        wallMs: 2 * 60 * 60_000,
        computeMs: 47 * 60_000,
        baseSha: 'abc1234deadbeef',
        questBranch: 'quest/q1',
      });
      expect(out).toContain('# My Quest Title');
      expect(out).toContain('verification-ready');
      expect(out).toContain('3/4');
      expect(out).toContain('2h 0m / 47m');
      expect(out).toContain('abc1234');
      expect(out).toContain('quest/q1');
    });

    it('falls back to the quest ID when title is missing (auto-name slot reserved)', () => {
      const out = renderTitleBar({
        questId: 'q1',
        title: undefined,
        status: 'executing',
        runsCompleted: 0,
        runsTotal: 0,
        wallMs: 0,
        computeMs: 0,
        baseSha: undefined,
        questBranch: undefined,
      });
      expect(out).toContain('# q1');
    });

    it('truncates the Base SHA to 7 characters', () => {
      const out = renderTitleBar({
        questId: 'q1',
        title: 'T',
        status: 'executing',
        runsCompleted: 0,
        runsTotal: 0,
        wallMs: 0,
        computeMs: 0,
        baseSha: 'a7b2c3d4e5f6g7h8',
        questBranch: 'quest/q1',
      });
      // Short SHA is the first 7 chars.
      expect(out).toContain('a7b2c3d');
      expect(out).not.toContain('a7b2c3d4e5f6g7h8');
    });

    it('omits Base SHA / Quest Branch line when neither is captured', () => {
      const out = renderTitleBar({
        questId: 'q1',
        title: 'T',
        status: 'intake',
        runsCompleted: 0,
        runsTotal: 0,
        wallMs: 0,
        computeMs: 0,
        baseSha: undefined,
        questBranch: undefined,
      });
      expect(out).not.toContain('Base ');
    });
  });

  describe('renderConcessions', () => {
    it('renders one line per concession event', () => {
      const events: QuestEvent[] = [
        {
          event: 'concession',
          timestamp: '2026-01-01T00:00:00Z',
          questId: 'q1',
          runId: 'r1',
          decision: 'used existing helper',
          rationale: 'simpler and faster',
        },
        {
          event: 'concession',
          timestamp: '2026-01-01T00:01:00Z',
          questId: 'q1',
          runId: 'r1',
          decision: 'skipped optional flag',
          rationale: 'not in scope',
        },
      ];
      const out = renderConcessions(events);
      expect(out).toContain('## Concessions');
      expect(out).toContain('- used existing helper — simpler and faster');
      expect(out).toContain('- skipped optional flag — not in scope');
    });

    it('renders placeholder when there are no concessions', () => {
      const out = renderConcessions([]);
      expect(out).toContain('## Concessions');
      expect(out).toContain('_No concessions recorded._');
    });
  });

  describe('renderAnomalies', () => {
    it('renders one line per anomaly across all tiers', () => {
      const events: QuestEvent[] = [
        {
          event: 'anomaly_detected',
          timestamp: '2026-01-01T00:00:00Z',
          questId: 'q1',
          tier: 'pause',
          rule: 'unbounded_diff',
          should_pause: true,
          details: { detail: 'too many files' },
        },
        {
          event: 'anomaly_detected',
          timestamp: '2026-01-01T00:01:00Z',
          questId: 'q1',
          tier: 'halt',
          rule: 'merge_conflict',
          should_pause: false,
        },
        {
          event: 'anomaly_detected',
          timestamp: '2026-01-01T00:02:00Z',
          questId: 'q1',
          tier: 'log',
          rule: 'locked_out_write',
          should_pause: false,
        },
      ];
      const out = renderAnomalies(events);
      expect(out).toContain('## Anomalies');
      expect(out).toContain('[pause] unbounded_diff');
      expect(out).toContain('[halt] merge_conflict');
      expect(out).toContain('[log] locked_out_write');
    });

    it('renders placeholder when there are no anomalies', () => {
      const out = renderAnomalies([]);
      expect(out).toContain('## Anomalies');
      expect(out).toContain('_No anomalies detected._');
    });
  });

  describe('computeReceipt', () => {
    it('aggregates tokens from run_finished events', () => {
      const events: QuestEvent[] = [
        {
          event: 'run_finished',
          timestamp: '2026-01-01T00:01:00Z',
          questId: 'q1',
          runId: 'r1',
          workItemId: '001',
          details: { inputTokens: 100_000, outputTokens: 5_000 },
        },
        {
          event: 'run_finished',
          timestamp: '2026-01-01T00:02:00Z',
          questId: 'q1',
          runId: 'r2',
          workItemId: '002',
          details: { inputTokens: 200_000, outputTokens: 7_500 },
        },
      ];
      const r = computeReceipt({
        events,
        gitStats: { filesChanged: 12, linesAdded: 47, linesRemoved: 3, commits: 4 },
        testBaseline: 100,
        testCurrent: 112,
        model: 'sonnet',
      });
      expect(r.inputTokens).toBe(300_000);
      expect(r.outputTokens).toBe(12_500);
      expect(r.filesChanged).toBe(12);
      expect(r.linesAdded).toBe(47);
      expect(r.linesRemoved).toBe(3);
      expect(r.commits).toBe(4);
      expect(r.testBaseline).toBe(100);
      expect(r.testCurrent).toBe(112);
      expect(r.testDelta).toBe(12);
      // Cost heuristic: (input / 1M) * 3 + (output / 1M) * 15 for sonnet.
      // 0.3 * 3 + 0.0125 * 15 = 0.9 + 0.1875 = 1.0875
      expect(r.costUsd).toBeCloseTo(1.0875, 3);
    });

    it('estimates human time saved as 30 min per 1000 lines changed', () => {
      const r = computeReceipt({
        events: [],
        gitStats: { filesChanged: 0, linesAdded: 1500, linesRemoved: 500, commits: 1 },
        testBaseline: undefined,
        testCurrent: undefined,
        model: 'sonnet',
      });
      // 2000 lines / 1000 * 30 = 60 minutes
      expect(r.humanTimeSavedMinutes).toBe(60);
    });
  });

  describe('renderReceipt', () => {
    it('renders all receipt fields', () => {
      const out = renderReceipt({
        filesChanged: 12,
        linesAdded: 47,
        linesRemoved: 3,
        commits: 4,
        testBaseline: 100,
        testCurrent: 112,
        testDelta: 12,
        inputTokens: 300_000,
        outputTokens: 12_500,
        costUsd: 1.0875,
        humanTimeSavedMinutes: 60,
      });
      expect(out).toContain('## Receipt');
      expect(out).toContain('Files changed: 12');
      expect(out).toContain('Lines (+/-): 47/3');
      expect(out).toContain('Tests: 100 → 112 (delta: +12)');
      expect(out).toContain('Commits: 4');
      expect(out).toContain('Tokens: 300000/12500');
      expect(out).toContain('Cost: $1.09');
      expect(out).toContain('Estimated human time saved: 1h 0m');
    });

    it('handles missing test baseline gracefully', () => {
      const out = renderReceipt({
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        commits: 0,
        testBaseline: undefined,
        testCurrent: 42,
        testDelta: undefined,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        humanTimeSavedMinutes: 0,
      });
      expect(out).toContain('Tests: 42 (baseline not recorded)');
    });
  });

  describe('renderNext', () => {
    it('maps executing to "subagents working"', () => {
      expect(renderNext('executing', 'q1')).toContain('subagents working');
    });
    it('maps verification-ready to VERIFICATION.md pointer', () => {
      expect(renderNext('verification-ready', 'q1')).toContain('VERIFICATION.md');
      expect(renderNext('verification-ready', 'q1')).toContain('uat-ready');
    });
    it('maps uat-ready to uat skill pointer', () => {
      expect(renderNext('uat-ready', 'q1')).toContain('UAT');
    });
    it('maps completed to ship it', () => {
      expect(renderNext('completed', 'q1')).toContain('quest/q1');
    });
    it('maps blocked and uat-failed to triage', () => {
      expect(renderNext('blocked', 'q1')).toContain('triage');
      expect(renderNext('uat-failed', 'q1')).toContain('triage');
    });
  });

  describe('isAutonomousToInteractiveTransition', () => {
    it('triggers on executing → verification-ready', () => {
      expect(isAutonomousToInteractiveTransition('executing', 'verification-ready')).toBe(true);
    });
    it('triggers on verification → verification-ready', () => {
      expect(isAutonomousToInteractiveTransition('verification', 'verification-ready')).toBe(true);
    });
    it('triggers on verification-ready → uat-ready', () => {
      expect(isAutonomousToInteractiveTransition('verification-ready', 'uat-ready')).toBe(true);
    });
    it('triggers on executing → blocked', () => {
      expect(isAutonomousToInteractiveTransition('executing', 'blocked')).toBe(true);
    });
    it('does NOT trigger on intake → reviewing (no autonomous work yet)', () => {
      expect(isAutonomousToInteractiveTransition('intake', 'reviewing')).toBe(false);
    });
    it('does NOT trigger on planned → launch-review (no autonomous work yet)', () => {
      expect(isAutonomousToInteractiveTransition('planned', 'launch-review')).toBe(false);
    });
    it('does NOT trigger on launch-review → executing (entering autonomous)', () => {
      expect(isAutonomousToInteractiveTransition('launch-review', 'executing')).toBe(false);
    });
  });

  describe('generateHomecomingBrief (integration)', () => {
    const setup = (overrides: Record<string, string> = {}) => {
      const baseFiles: Record<string, string> = {
        '/repo/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1',
          title: 'My Cool Quest',
          status: 'verification-ready',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T03:00:00Z',
          source: {},
          artifacts: { handoff: 'HANDOFF.md', brief: 'BRIEF.md' },
          baseSha: 'abc1234deadbeef',
          questBranch: 'quest/q1',
        }),
        '/repo/.pi/quests/q1/telemetry/events.jsonl':
          [
            {
              event: 'stage_entered',
              timestamp: '2026-01-01T00:00:00Z',
              questId: 'q1',
              to: 'executing',
            },
            {
              event: 'run_started',
              timestamp: '2026-01-01T00:10:00Z',
              questId: 'q1',
              runId: 'r1',
              workItemId: '001',
            },
            {
              event: 'run_finished',
              timestamp: '2026-01-01T00:20:00Z',
              questId: 'q1',
              runId: 'r1',
              workItemId: '001',
              details: { status: 'completed', inputTokens: 100_000, outputTokens: 5_000 },
            },
            {
              event: 'concession',
              timestamp: '2026-01-01T00:15:00Z',
              questId: 'q1',
              runId: 'r1',
              decision: 'used existing helper',
              rationale: 'simpler',
            },
            {
              event: 'anomaly_detected',
              timestamp: '2026-01-01T00:18:00Z',
              questId: 'q1',
              tier: 'log',
              rule: 'locked_out_write',
              should_pause: false,
            },
            {
              event: 'stage_entered',
              timestamp: '2026-01-01T03:00:00Z',
              questId: 'q1',
              to: 'verification-ready',
            },
          ]
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n',
        ...overrides,
      };
      vol.fromJSON(baseFiles);
    };

    it('writes BRIEF.md and returns the content + path', async () => {
      setup();
      const result = await generateHomecomingBrief({
        repoRoot: '/repo',
        questId: 'q1',
        spawnNarrativeAgent: async () => 'I built the foundation and verified it. Tests are green.',
        gitStats: async () => ({ filesChanged: 5, linesAdded: 100, linesRemoved: 10, commits: 2 }),
        now: () => new Date('2026-01-01T03:00:00Z').getTime(),
      });
      expect(result.briefPath).toBe('/repo/.pi/quests/q1/BRIEF.md');
      expect(result.content).toContain('# My Cool Quest');
      expect(result.content).toContain('## Narrative');
      expect(result.content).toContain('I built the foundation and verified it.');
      expect(result.content).toContain('## Concessions');
      expect(result.content).toContain('used existing helper');
      expect(result.content).toContain('## Anomalies');
      expect(result.content).toContain('locked_out_write');
      expect(result.content).toContain('## Receipt');
      expect(result.content).toContain('Files changed: 5');
      expect(result.content).toContain('## Next');
      expect(result.content).toContain('VERIFICATION.md');

      // File should have been written.
      expect(vol.existsSync('/repo/.pi/quests/q1/BRIEF.md')).toBe(true);
      const onDisk = vol.readFileSync('/repo/.pi/quests/q1/BRIEF.md', 'utf-8') as string;
      expect(onDisk).toBe(result.content);
    });

    it('uses the injected narrative callback (no real subagent spawn in tests)', async () => {
      setup();
      const spy = vi.fn(async (_input: { eventLogPath: string; reportsDir: string; questId: string; questDir: string }) => 'CANNED NARRATIVE TEXT');
      await generateHomecomingBrief({
        repoRoot: '/repo',
        questId: 'q1',
        spawnNarrativeAgent: spy,
        gitStats: async () => ({ filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 }),
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0]![0];
      expect(call.eventLogPath).toBe('/repo/.pi/quests/q1/telemetry/events.jsonl');
      expect(call.reportsDir).toBe('/repo/.pi/quests/q1/reports');
      const content = vol.readFileSync('/repo/.pi/quests/q1/BRIEF.md', 'utf-8') as string;
      expect(content).toContain('CANNED NARRATIVE TEXT');
    });

    it('returns gracefully when the quest does not exist', async () => {
      const result = await generateHomecomingBrief({
        repoRoot: '/repo',
        questId: 'nope',
        spawnNarrativeAgent: async () => 'x',
        gitStats: async () => ({ filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 }),
      });
      expect(result.briefPath).toBeUndefined();
      expect(result.content).toBe('');
    });

    it('integrates an in-flight Batch across a pi restart (ADR 018 cross-session gate, story 20)', async () => {
      // Scenario: a 3-Run Batch was launched, two completed and one was paused
      // by the supervisor, then pi was closed. On reopen, no Closeout fires
      // (cross-session gate in extensions/runs/closeout.ts suppresses it) — the
      // Brief is the canonical narrative for what happened. Assert the Brief
      // counts the Batch's runs correctly and surfaces the paused-Run anomaly.
      vol.fromJSON({
        '/repo/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1',
          title: 'In-Flight Quest',
          status: 'executing',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T01:00:00Z',
          source: {},
          artifacts: { handoff: 'HANDOFF.md', brief: 'BRIEF.md' },
          baseSha: 'abc1234deadbeef',
          questBranch: 'quest/q1',
        }),
        '/repo/.pi/quests/q1/runs/run-a.json': JSON.stringify({
          runId: 'run-a',
          status: 'completed',
          workItemId: '001',
          batchId: 'batch-q1-1700000000',
          batchSize: 3,
          completedAt: '2026-01-01T00:30:00Z',
          statusPath: '/repo/.pi/quests/q1/runs/run-a.json',
        }),
        '/repo/.pi/quests/q1/runs/run-b.json': JSON.stringify({
          runId: 'run-b',
          status: 'completed',
          workItemId: '002',
          batchId: 'batch-q1-1700000000',
          batchSize: 3,
          completedAt: '2026-01-01T00:45:00Z',
          statusPath: '/repo/.pi/quests/q1/runs/run-b.json',
        }),
        '/repo/.pi/quests/q1/runs/run-c.json': JSON.stringify({
          runId: 'run-c',
          status: 'paused',
          workItemId: '003',
          batchId: 'batch-q1-1700000000',
          batchSize: 3,
          paused_reason: 'unbounded_diff',
          statusPath: '/repo/.pi/quests/q1/runs/run-c.json',
        }),
        '/repo/.pi/quests/q1/telemetry/events.jsonl':
          [
            {
              event: 'stage_entered',
              timestamp: '2026-01-01T00:00:00Z',
              questId: 'q1',
              to: 'executing',
            },
            {
              event: 'anomaly_detected',
              timestamp: '2026-01-01T00:50:00Z',
              questId: 'q1',
              runId: 'run-c',
              tier: 'pause',
              rule: 'unbounded_diff',
              should_pause: true,
              details: { files: 73, lines: 2841 },
            },
          ]
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n',
      });

      const result = await generateHomecomingBrief({
        repoRoot: '/repo',
        questId: 'q1',
        spawnNarrativeAgent: async () => 'Two Runs completed, one paused on unbounded_diff. Inspect run-c before resuming.',
        gitStats: async () => ({ filesChanged: 12, linesAdded: 340, linesRemoved: 20, commits: 4 }),
        now: () => new Date('2026-01-01T02:00:00Z').getTime(),
      });

      // Title bar reflects 2/3 completed — the paused Run is not counted as completed.
      expect(result.content).toContain('2/3');

      // Anomalies section surfaces the paused-Run's pause-tier anomaly so the
      // user can act on it via Discard / Force-Complete / Resume.
      expect(result.content).toContain('## Anomalies');
      expect(result.content).toContain('[pause] unbounded_diff');

      // No batch_closeout event was emitted (cross-session gate) — the Brief
      // owns the cross-session narrative.
      const events = (vol.readFileSync('/repo/.pi/quests/q1/telemetry/events.jsonl', 'utf-8') as string)
        .split('\n')
        .filter((l) => l.trim().length > 0);
      expect(events.some((l) => l.includes('"batch_closeout"'))).toBe(false);
    });
  });

  describe('AUTONOMOUS_TO_INTERACTIVE_TRIGGERS', () => {
    it('exposes the canonical list', () => {
      // Spec lists at least these:
      const set = new Set(AUTONOMOUS_TO_INTERACTIVE_TRIGGERS.map(([f, t]) => `${f}->${t}`));
      expect(set.has('executing->verification-ready')).toBe(true);
      expect(set.has('verification->verification-ready')).toBe(true);
      expect(set.has('verification-ready->uat-ready')).toBe(true);
    });
  });

  describe('homecoming agent definition', () => {
    it('exists with the right frontmatter and prompt discipline', async () => {
      // Use real fs to read on-disk agent file (node:fs is mocked above).
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const filePath = path.resolve(__dirname, '..', 'agents', 'homecoming.md');
      expect(realFs.existsSync(filePath)).toBe(true);
      const content = realFs.readFileSync(filePath, 'utf-8');

      // Frontmatter declares the right name + tools.
      expect(content).toMatch(/name:\s*quest-homecoming/);
      // Declares read-ish tools so it can scan reports + event log.
      expect(content).toMatch(/tools:\s*[^\n]*read/);

      // System prompt enforces forbidden adjectives (negative discipline).
      const forbidden = [
        'elegant',
        'brilliant',
        'smooth',
        'successfully',
      ];
      for (const word of forbidden) {
        // The prompt must mention each forbidden word as a constraint (so the
        // agent knows not to use it). The regex is case-insensitive.
        expect(content.toLowerCase()).toContain(word);
      }

      // Discipline asserted: 3–5 sentences, first person.
      expect(content.toLowerCase()).toMatch(/first person/);
      expect(content).toMatch(/3.*5 sentences|3 to 5 sentences/);
    });
  });
});
