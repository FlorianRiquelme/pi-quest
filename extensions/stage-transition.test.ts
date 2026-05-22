import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import { transitionStage } from './stage-transition';
import type { QuestStatus } from '../lib';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

vi.mock('./runs/worktree.js', () => ({
  getHeadSha: vi.fn().mockResolvedValue('basesha-deadbeef'),
  ensureQuestBranch: vi.fn().mockResolvedValue({ questBranch: 'quest/q1', created: true }),
}));

describe('transitionStage', () => {
  let notifyCalls: Array<{ msg: string; level: string }> = [];

  const mockCtx = (cwd: string) => ({
    cwd,
    ui: {
      notify: vi.fn((msg: string, level?: string) => {
        notifyCalls.push({ msg, level: level ?? 'info' });
      }),
    },
  });

  const baseWorkflow = (overrides: Record<string, unknown> = {}) => ({
    id: 'q1',
    title: 'Q',
    status: 'intake' as QuestStatus,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    source: {},
    artifacts: { handoff: 'H.md' },
    ...overrides,
  });

  beforeEach(() => {
    vol.reset();
    notifyCalls = [];
  });

  describe('rejection: quest_not_found', () => {
    it('returns rejected when workflow.json missing', async () => {
      vol.fromJSON({});
      const result = await transitionStage(mockCtx('/project'), 'missing', 'reviewing', {});
      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') return;
      expect(result.reason).toBe('quest_not_found');
      expect(result.message).toContain("'missing'");
      expect(result.message).toContain('not found');
    });
  });

  describe('rejection: invalid_transition', () => {
    it('returns rejected for intake → completed', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'completed', {});
      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') return;
      expect(result.reason).toBe('invalid_transition');
      expect(result.message).toContain('intake');
      expect(result.message).toContain('completed');
    });

    it('does not persist the bad status', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
      });
      await transitionStage(mockCtx('/project'), 'q1', 'completed', {});
      const persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('intake');
    });

    it('force=true bypasses the validity check', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'completed', { force: true });
      expect(result.outcome).toBe('applied');
    });
  });

  describe('rejection: missing_verification_artifact', () => {
    it('blocks → verification-ready when VERIFICATION.md is absent', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(
          baseWorkflow({ status: 'verification', artifacts: { handoff: 'H.md', verification: 'VERIFICATION.md' } }),
        ),
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'verification-ready', {});
      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') return;
      expect(result.reason).toBe('missing_verification_artifact');
      expect(result.message).toContain('Gate check failed');
      expect(result.message).toContain('VERIFICATION.md');
      expect(result.details?.missingArtifact).toContain('VERIFICATION.md');
    });

    it('passes when VERIFICATION.md exists', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(
          baseWorkflow({ status: 'verification', artifacts: { handoff: 'H.md', verification: 'VERIFICATION.md' } }),
        ),
        '/project/.pi/quests/q1/VERIFICATION.md': '# verdict\npass',
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'verification-ready', {});
      expect(result.outcome).toBe('applied');
    });

    it('force=true bypasses the gate', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(
          baseWorkflow({ status: 'verification', artifacts: { handoff: 'H.md', verification: 'VERIFICATION.md' } }),
        ),
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'verification-ready', { force: true });
      expect(result.outcome).toBe('applied');
    });
  });

  describe('rejection: launch_gate_blocked', () => {
    const launchReviewWorkflow = (overrides: Record<string, unknown> = {}) =>
      baseWorkflow({
        status: 'launch-review',
        artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' },
        ...overrides,
      });

    it('blocks when plan frontmatter missing blast_radius', async () => {
      const plan =
        '---\n' +
        'pre_mortem:\n' +
        '  most_likely_failure: oops\n' +
        'launch_review:\n' +
        '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
        '  signed_off_by: user\n' +
        '---\n';
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(launchReviewWorkflow()),
        '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': plan,
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'executing', {});
      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') return;
      expect(result.reason).toBe('launch_gate_blocked');
      expect(result.message).toContain('Launch Gate');
      expect(result.message).toContain('missing_blast_radius');
    });

    it('emits launch_gate event even when blocked', async () => {
      const plan = '---\nfoo: bar\n---\n';
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(launchReviewWorkflow()),
        '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': plan,
      });
      await transitionStage(mockCtx('/project'), 'q1', 'executing', {});
      const jsonl = vol.readFileSync('/project/.pi/quests/q1/telemetry/events.jsonl', 'utf-8') as string;
      const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const gate = events.find((e) => e.event === 'launch_gate');
      expect(gate).toBeDefined();
      expect(gate.outcome).toBe('blocked');
    });

    it('force=true passes the gate with force_passed outcome', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(launchReviewWorkflow()),
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'executing', { force: true });
      expect(result.outcome).toBe('applied');
      const jsonl = vol.readFileSync('/project/.pi/quests/q1/telemetry/events.jsonl', 'utf-8') as string;
      const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const gate = events.find((e) => e.event === 'launch_gate');
      expect(gate.outcome).toBe('force_passed');
    });
  });

  describe('rejection: quest_branch_capture_failed', () => {
    it('returns rejected when ensureQuestBranch throws', async () => {
      const worktree = await import('./runs/worktree.js');
      (worktree.ensureQuestBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('not a git repo'),
      );
      const fullPassPlan =
        '---\n' +
        'blast_radius:\n  in_scope:\n    - src/foo.ts\n' +
        'pre_mortem:\n  most_likely_failure: oops\n' +
        'compiler_diagnostics: []\n' +
        'launch_review:\n  signed_off_at: "2026-05-20T11:30:00Z"\n  signed_off_by: user\n' +
        '---\n';
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(
          baseWorkflow({ status: 'launch-review', artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' } }),
        ),
        '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': fullPassPlan,
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'executing', {});
      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') return;
      expect(result.reason).toBe('quest_branch_capture_failed');
      expect(result.message).toContain('not a git repo');
    });

    it('does not persist the new status when capture fails', async () => {
      const worktree = await import('./runs/worktree.js');
      (worktree.ensureQuestBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('boom'),
      );
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(
          baseWorkflow({ status: 'launch-review' }),
        ),
      });
      await transitionStage(mockCtx('/project'), 'q1', 'executing', { force: true });
      const persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('launch-review');
    });
  });

  describe('outcome: applied', () => {
    it('persists the new status and updatedAt', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'reviewing', {});
      expect(result.outcome).toBe('applied');
      if (result.outcome !== 'applied') return;
      expect(result.previousStatus).toBe('intake');
      expect(result.newStatus).toBe('reviewing');
      const persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('reviewing');
      expect(persisted.updatedAt).not.toBe('2024-01-01T00:00:00Z');
    });

    it('emits stage_entered event', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
      });
      await transitionStage(mockCtx('/project'), 'q1', 'reviewing', {});
      const jsonl = vol.readFileSync('/project/.pi/quests/q1/telemetry/events.jsonl', 'utf-8') as string;
      const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const ev = events.find((e) => e.event === 'stage_entered');
      expect(ev).toBeDefined();
      expect(ev.from).toBe('intake');
      expect(ev.to).toBe('reviewing');
      expect(ev.questId).toBe('q1');
    });

    it('captures Quest Branch on first entry to executing', async () => {
      const fullPassPlan =
        '---\n' +
        'blast_radius:\n  in_scope:\n    - src/foo.ts\n' +
        'pre_mortem:\n  most_likely_failure: oops\n' +
        'compiler_diagnostics: []\n' +
        'launch_review:\n  signed_off_at: "2026-05-20T11:30:00Z"\n  signed_off_by: user\n' +
        '---\n';
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(
          baseWorkflow({ status: 'launch-review', artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' } }),
        ),
        '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': fullPassPlan,
      });
      const result = await transitionStage(mockCtx('/project'), 'q1', 'executing', {});
      expect(result.outcome).toBe('applied');
      if (result.outcome !== 'applied') return;
      expect(result.workflow.baseSha).toBe('basesha-deadbeef');
      expect(result.workflow.questBranch).toBe('quest/q1');
    });

    it('fires UAT doorbell on verification-ready → uat-ready', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        vol.fromJSON({
          '/project/.pi/quests/q-uat/workflow.json': JSON.stringify(
            baseWorkflow({ id: 'q-uat', status: 'verification-ready' }),
          ),
        });
        const result = await transitionStage(mockCtx('/project'), 'q-uat', 'uat-ready', {});
        expect(result.outcome).toBe('applied');
        if (result.outcome !== 'applied') return;
        expect(result.doorbellFired).toBe(true);
        const bell = stdoutSpy.mock.calls.filter((c) => c[0] === '\x07');
        expect(bell).toHaveLength(1);
        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q-uat/workflow.json', 'utf-8') as string,
        );
        expect(persisted.uat_doorbell_fired_at).toBeDefined();
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it('engages quest-uat on verification-ready → uat-ready', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(
            baseWorkflow({ status: 'verification-ready' }),
          ),
        });
        const engageSkill = vi.fn().mockResolvedValue(true);
        const result = await transitionStage(
          mockCtx('/project'),
          'q1',
          'uat-ready',
          {},
          engageSkill,
        );
        expect(result.outcome).toBe('applied');
        expect(engageSkill).toHaveBeenCalledWith('quest-uat');
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it('re-engages quest-uat on uat-failed → uat-ready re-entry (re-entry policy)', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(
          baseWorkflow({
            status: 'uat-failed',
            // Doorbell already fired on the original entry; engagement should
            // still re-fire on every re-entry (issue #4 resolution).
            uat_doorbell_fired_at: '2024-01-02T00:00:00.000Z',
          }),
        ),
      });
      const engageSkill = vi.fn().mockResolvedValue(true);
      const result = await transitionStage(
        mockCtx('/project'),
        'q1',
        'uat-ready',
        {},
        engageSkill,
      );
      expect(result.outcome).toBe('applied');
      expect(engageSkill).toHaveBeenCalledWith('quest-uat');
    });

    it('engages quest-review-discussion when entering the reviewing stage', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
      });
      const engageSkill = vi.fn().mockResolvedValue(true);
      const result = await transitionStage(
        mockCtx('/project'),
        'q1',
        'reviewing',
        {},
        engageSkill,
      );
      expect(result.outcome).toBe('applied');
      expect(engageSkill).toHaveBeenCalledWith('quest-review-discussion');
    });

    it('does not fire doorbell on uat-failed → uat-ready re-entry', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        vol.fromJSON({
          '/project/.pi/quests/q-uat/workflow.json': JSON.stringify(
            baseWorkflow({
              id: 'q-uat',
              status: 'uat-failed',
              uat_doorbell_fired_at: '2024-01-02T00:00:00.000Z',
            }),
          ),
        });
        const result = await transitionStage(mockCtx('/project'), 'q-uat', 'uat-ready', {});
        expect(result.outcome).toBe('applied');
        if (result.outcome !== 'applied') return;
        expect(result.doorbellFired).toBe(false);
        const bell = stdoutSpy.mock.calls.filter((c) => c[0] === '\x07');
        expect(bell).toHaveLength(0);
      } finally {
        stdoutSpy.mockRestore();
      }
    });
  });
});
