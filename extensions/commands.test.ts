import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import {
  showStatus,
  listQuests,
  cmdSelect,
  cmdSetStatus,
  cmdConfig,
  cmdBrief,
  tryAutoRoute,
  acceptLaunchReview,
  __setNarrativeSpawnerForTests,
} from './commands';
import type { CommandContext } from './types';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

vi.mock('./git.js', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue('feature/TEST-123'),
  getCurrentCommit: vi.fn().mockResolvedValue('abc1234'),
}));

vi.mock('./worktree.js', () => ({
  getHeadSha: vi.fn().mockResolvedValue('basesha-deadbeef'),
  ensureQuestBranch: vi.fn().mockResolvedValue({ questBranch: 'quest/q1', created: true }),
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

    it('emits stage_entered event on every transition (regression — UAT-discovered)', async () => {
      // The Two Clocks, Homecoming Brief, and anomaly poller all consume
      // stage_entered events. Without this emission, Wall time can't be
      // computed and the widget shows no clocks despite the quest being in
      // executing. Surfaced during M2-1 UAT, 2026-05-20.
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'intake',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
        }),
      });
      const ctx = mockCtx('/project');
      await cmdSetStatus(ctx, ['q1', 'reviewing']);
      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const stageEntered = events.find((e) => e.event === 'stage_entered');
      expect(stageEntered).toBeDefined();
      expect(stageEntered.from).toBe('intake');
      expect(stageEntered.to).toBe('reviewing');
      expect(stageEntered.questId).toBe('q1');
      expect(typeof stageEntered.timestamp).toBe('string');
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

    describe('Launch Gate (M2-1)', () => {
      const baseLaunchReviewWorkflow = (overrides: Record<string, unknown> = {}) => ({
        id: 'q1',
        title: 'Launch quest',
        status: 'launch-review',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' },
        ...overrides,
      });

      const fullPassPlan =
        '---\n' +
        'blast_radius:\n' +
        '  in_scope:\n' +
        '    - src/foo.ts\n' +
        'pre_mortem:\n' +
        '  most_likely_failure: oops\n' +
        'compiler_diagnostics: []\n' +
        'launch_review:\n' +
        '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
        '  signed_off_by: user\n' +
        '---\n\n# Plan\n';

      it('allows launch-review → executing when gate passes', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
          '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': fullPassPlan,
        });
        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);
        const lastNotify = notifyCalls[notifyCalls.length - 1];
        expect(lastNotify.level).toBe('info');
        expect(lastNotify.msg).toContain('status → executing');

        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
        );
        expect(persisted.status).toBe('executing');

        const jsonl = vol.readFileSync(
          '/project/.pi/quests/q1/telemetry/events.jsonl',
          'utf-8',
        ) as string;
        const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
        const gateEvent = events.find((e) => e.event === 'launch_gate');
        expect(gateEvent).toBeDefined();
        expect(gateEvent.outcome).toBe('passed');
        expect(gateEvent.reasons).toEqual([]);
      });

      it('blocks when blast_radius missing', async () => {
        const plan =
          '---\n' +
          'pre_mortem:\n' +
          '  most_likely_failure: oops\n' +
          'launch_review:\n' +
          '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
          '  signed_off_by: user\n' +
          '---\n\n# Plan\n';
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
          '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': plan,
        });
        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);
        const errorNotify = notifyCalls.find((c) => c.level === 'error');
        expect(errorNotify).toBeDefined();
        expect(errorNotify!.msg).toContain('Launch Gate');
        expect(errorNotify!.msg).toContain('missing_blast_radius');

        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
        );
        expect(persisted.status).toBe('launch-review');

        const jsonl = vol.readFileSync(
          '/project/.pi/quests/q1/telemetry/events.jsonl',
          'utf-8',
        ) as string;
        const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
        const gateEvent = events.find((e) => e.event === 'launch_gate');
        expect(gateEvent.outcome).toBe('blocked');
        expect(gateEvent.reasons).toContain('missing_blast_radius');
      });

      it('blocks when pre_mortem missing', async () => {
        const plan =
          '---\n' +
          'blast_radius:\n' +
          '  in_scope:\n' +
          '    - src/x.ts\n' +
          'launch_review:\n' +
          '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
          '  signed_off_by: user\n' +
          '---\n';
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
          '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': plan,
        });
        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);
        const errorNotify = notifyCalls.find((c) => c.level === 'error');
        expect(errorNotify!.msg).toContain('missing_pre_mortem');
      });

      it('blocks when compiler_diagnostics has severity:error', async () => {
        const plan =
          '---\n' +
          'blast_radius:\n' +
          '  in_scope:\n' +
          '    - src/x.ts\n' +
          'pre_mortem:\n' +
          '  most_likely_failure: oops\n' +
          'compiler_diagnostics:\n' +
          '  - severity: error\n' +
          '    rule: WP-02:missing_acceptance\n' +
          'launch_review:\n' +
          '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
          '  signed_off_by: user\n' +
          '---\n';
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
          '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': plan,
        });
        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);
        const errorNotify = notifyCalls.find((c) => c.level === 'error');
        expect(errorNotify!.msg).toContain('compiler_error');
        expect(errorNotify!.msg).toContain('WP-02:missing_acceptance');
      });

      it('blocks when sign-off missing', async () => {
        const plan =
          '---\n' +
          'blast_radius:\n' +
          '  in_scope:\n' +
          '    - src/x.ts\n' +
          'pre_mortem:\n' +
          '  most_likely_failure: oops\n' +
          '---\n';
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
          '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': plan,
        });
        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);
        const errorNotify = notifyCalls.find((c) => c.level === 'error');
        expect(errorNotify!.msg).toContain('missing_sign_off');
      });

      it('blocks when compiler_diagnostics contains unaddressed_requirement error (M2-2)', async () => {
        const plan =
          '---\n' +
          'blast_radius:\n' +
          '  in_scope:\n' +
          '    - src/x.ts\n' +
          'pre_mortem:\n' +
          '  most_likely_failure: oops\n' +
          'compiler_diagnostics:\n' +
          '  - severity: error\n' +
          '    rule: unaddressed_requirement\n' +
          '    message: "R2 not addressed by any work-item"\n' +
          'launch_review:\n' +
          '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
          '  signed_off_by: user\n' +
          '---\n';
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
          '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': plan,
        });
        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);
        const errorNotify = notifyCalls.find((c) => c.level === 'error');
        expect(errorNotify!.msg).toContain('compiler_error');
        expect(errorNotify!.msg).toContain('unaddressed_requirement');
        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
        );
        expect(persisted.status).toBe('launch-review');
      });

      it('passes when only warnings are present (M2-2: warnings don\'t block)', async () => {
        const plan =
          '---\n' +
          'blast_radius:\n' +
          '  in_scope:\n' +
          '    - src/x.ts\n' +
          'pre_mortem:\n' +
          '  most_likely_failure: oops\n' +
          'compiler_diagnostics:\n' +
          '  - severity: warning\n' +
          '    rule: empty_claims\n' +
          '    message: "WI-1 has no claims"\n' +
          '    work_item: WI-1\n' +
          'launch_review:\n' +
          '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
          '  signed_off_by: user\n' +
          '---\n';
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
          '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': plan,
        });
        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);
        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
        );
        expect(persisted.status).toBe('executing');

        const jsonl = vol.readFileSync(
          '/project/.pi/quests/q1/telemetry/events.jsonl',
          'utf-8',
        ) as string;
        const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
        const gateEvent = events.find((e) => e.event === 'launch_gate');
        expect(gateEvent.outcome).toBe('passed');
      });

      it('--force bypasses gate and emits force_passed', async () => {
        // No plan file at all — gate would normally block.
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
        });
        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing', '--force']);
        const lastNotify = notifyCalls[notifyCalls.length - 1];
        expect(lastNotify.msg).toContain('status → executing');

        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
        );
        expect(persisted.status).toBe('executing');

        const jsonl = vol.readFileSync(
          '/project/.pi/quests/q1/telemetry/events.jsonl',
          'utf-8',
        ) as string;
        const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
        const gateEvent = events.find((e) => e.event === 'launch_gate');
        expect(gateEvent.outcome).toBe('force_passed');
        expect(gateEvent.reasons).toContain('user_forced');
      });

      it('notify surfaces Quest Branch and short Base SHA on launch-review → executing (#6)', async () => {
        // ADRs 011 + 012: the Quest Branch and Base SHA are audit anchors
        // captured at this transition. The success notify must surface both so
        // the user has visible confirmation at the moment they're created.
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
          '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': fullPassPlan,
        });
        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);
        const lastNotify = notifyCalls[notifyCalls.length - 1];
        expect(lastNotify.msg).toContain('quest/q1');
        // Mock returns baseSha 'basesha-deadbeef' → first 8 chars is 'basesha-'.
        expect(lastNotify.msg).toContain('basesha-');
        // Don't surface the full SHA — short form only.
        expect(lastNotify.msg).not.toContain('basesha-deadbeef');
      });
    });

    it('notify stays terse for transitions that do not create a Quest Branch (#6)', async () => {
      // Regression guard: only transitions into `executing` capture a Quest
      // Branch (ADR 011 §2). Transitions like `intake → blocked` MUST NOT
      // surface fake/empty branch or SHA values.
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'intake',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
        }),
      });
      const ctx = mockCtx('/project');
      await cmdSetStatus(ctx, ['q1', 'blocked', '--force']);
      const lastNotify = notifyCalls[notifyCalls.length - 1];
      expect(lastNotify.msg).toContain('status → blocked');
      expect(lastNotify.msg).not.toContain('quest/');
      expect(lastNotify.msg).not.toContain('Base SHA');
    });

    it('notify stays terse on executing → blocked even though questBranch + baseSha are already persisted (#6)', async () => {
      // Regression guard for Codex review: the Quest Branch and Base SHA are
      // persisted on the workflow forever after the first entry into
      // `executing`. The enriched notify must be gated on the *destination*
      // status, not on the presence of the fields — otherwise every later
      // transition would re-surface the same audit anchors even though they
      // were not captured in that transition.
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'executing',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
          questBranch: 'quest/q1',
          baseSha: 'basesha-deadbeef',
        }),
      });
      const ctx = mockCtx('/project');
      await cmdSetStatus(ctx, ['q1', 'blocked']);
      const lastNotify = notifyCalls[notifyCalls.length - 1];
      expect(lastNotify.msg).toContain('status → blocked');
      expect(lastNotify.msg).not.toContain('quest/q1');
      expect(lastNotify.msg).not.toContain('Base SHA');
      expect(lastNotify.msg).not.toContain('basesha-');
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

    describe('UAT doorbell (M4-2)', () => {
      const baseWorkflow = (overrides: Record<string, unknown> = {}) => ({
        id: 'q1',
        title: 'My UAT Quest',
        status: 'verification-ready',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        source: {},
        artifacts: { handoff: 'H.md', verification: 'VERIFICATION.md' },
        ...overrides,
      });

      it('writes terminal bell character once at verification-ready → uat-ready', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
          const ctx = mockCtx('/project');
          await cmdSetStatus(ctx, ['q1', 'uat-ready']);
          const bellWrites = stdoutSpy.mock.calls.filter(
            (call) => call[0] === '\x07',
          );
          expect(bellWrites).toHaveLength(1);
        } finally {
          stdoutSpy.mockRestore();
        }
      });

      it('notifies "UAT pending for <title>" at verification-ready → uat-ready', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
          const ctx = mockCtx('/project');
          await cmdSetStatus(ctx, ['q1', 'uat-ready']);
        } finally {
          stdoutSpy.mockRestore();
        }
        const doorbellNotifications = notifyCalls.filter((c) =>
          c.msg.startsWith('UAT pending for'),
        );
        expect(doorbellNotifications).toHaveLength(1);
        expect(doorbellNotifications[0].msg).toBe('UAT pending for My UAT Quest');
        expect(doorbellNotifications[0].level).toBe('info');
      });

      it('suppresses generic "status →" notify when doorbell fires (pi collapses same-tick notifies)', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
          const ctx = mockCtx('/project');
          await cmdSetStatus(ctx, ['q1', 'uat-ready']);
        } finally {
          stdoutSpy.mockRestore();
        }
        const statusNotifications = notifyCalls.filter((c) =>
          c.msg.includes('status →'),
        );
        expect(statusNotifications).toHaveLength(0);
        const doorbellNotifications = notifyCalls.filter((c) =>
          c.msg.startsWith('UAT pending for'),
        );
        expect(doorbellNotifications).toHaveLength(1);
      });

      it('falls back to quest id when title is missing', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow({ title: '' })),
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
          const ctx = mockCtx('/project');
          await cmdSetStatus(ctx, ['q1', 'uat-ready']);
        } finally {
          stdoutSpy.mockRestore();
        }
        const doorbell = notifyCalls.find((c) => c.msg.startsWith('UAT pending for'));
        expect(doorbell?.msg).toBe('UAT pending for q1');
      });

      it('does not re-fire when re-entering uat-ready from uat-failed', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(
            baseWorkflow({
              status: 'uat-failed',
              uat_doorbell_fired_at: '2024-01-02T00:00:00Z',
            }),
          ),
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
          const ctx = mockCtx('/project');
          await cmdSetStatus(ctx, ['q1', 'uat-ready']);
          const bellWrites = stdoutSpy.mock.calls.filter(
            (call) => call[0] === '\x07',
          );
          expect(bellWrites).toHaveLength(0);
        } finally {
          stdoutSpy.mockRestore();
        }
        const doorbellNotifications = notifyCalls.filter((c) =>
          c.msg.startsWith('UAT pending for'),
        );
        expect(doorbellNotifications).toHaveLength(0);
      });

      it('does not fire when forced from a non-verification-ready state', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(
            baseWorkflow({ status: 'executing' }),
          ),
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
          const ctx = mockCtx('/project');
          await cmdSetStatus(ctx, ['q1', 'uat-ready', '--force']);
          const bellWrites = stdoutSpy.mock.calls.filter(
            (call) => call[0] === '\x07',
          );
          expect(bellWrites).toHaveLength(0);
        } finally {
          stdoutSpy.mockRestore();
        }
        const doorbellNotifications = notifyCalls.filter((c) =>
          c.msg.startsWith('UAT pending for'),
        );
        expect(doorbellNotifications).toHaveLength(0);
      });

      it('persists uat_doorbell_fired_at with an ISO 8601 timestamp after firing', async () => {
        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseWorkflow()),
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
          const ctx = mockCtx('/project');
          await cmdSetStatus(ctx, ['q1', 'uat-ready']);
        } finally {
          stdoutSpy.mockRestore();
        }
        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
        );
        expect(persisted.uat_doorbell_fired_at).toBeTruthy();
        // ISO 8601 with milliseconds + Z
        expect(persisted.uat_doorbell_fired_at).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
      });
    });
  });

    describe('Quest Branch capture (M1-3)', () => {
      const fullPassPlan =
        '---\n' +
        'blast_radius:\n' +
        '  in_scope:\n' +
        '    - src/foo.ts\n' +
        'pre_mortem:\n' +
        '  most_likely_failure: oops\n' +
        'compiler_diagnostics: []\n' +
        'launch_review:\n' +
        '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
        '  signed_off_by: user\n' +
        '---\n\n# Plan\n';

      it('records baseSha and creates Quest Branch on first entry to executing', async () => {
        const worktree = await import('./worktree.js');
        (worktree.getHeadSha as any).mockResolvedValue('basesha-deadbeef');
        (worktree.ensureQuestBranch as any).mockResolvedValue({
          questBranch: 'quest/q1',
          created: true,
        });

        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify({
            id: 'q1',
            title: 'Q',
            status: 'launch-review',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            source: {},
            artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' },
          }),
          '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': fullPassPlan,
        });

        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);

        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
        );
        expect(persisted.status).toBe('executing');
        expect(persisted.baseSha).toBe('basesha-deadbeef');
        expect(persisted.questBranch).toBe('quest/q1');

        expect(worktree.getHeadSha).toHaveBeenCalledWith('/project');
        expect(worktree.ensureQuestBranch).toHaveBeenCalledWith({
          repoRoot: '/project',
          questId: 'q1',
          baseSha: 'basesha-deadbeef',
        });
      });

      it('is idempotent — second entry to executing does not re-capture baseSha', async () => {
        const worktree = await import('./worktree.js');
        (worktree.getHeadSha as any).mockClear();
        (worktree.ensureQuestBranch as any).mockClear();

        vol.fromJSON({
          '/project/.pi/quests/q1/workflow.json': JSON.stringify({
            id: 'q1',
            title: 'Q',
            status: 'blocked',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            source: {},
            artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' },
            baseSha: 'preserved-sha',
            questBranch: 'quest/q1',
          }),
        });

        const ctx = mockCtx('/project');
        await cmdSetStatus(ctx, ['q1', 'executing']);

        const persisted = JSON.parse(
          vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
        );
        expect(persisted.baseSha).toBe('preserved-sha');
        expect(worktree.getHeadSha).not.toHaveBeenCalled();
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

  describe('Homecoming Brief (M4-1 / ADR 015)', () => {
    beforeEach(() => {
      __setNarrativeSpawnerForTests(async () => 'STUB NARRATIVE');
    });

    const verificationWorkflow = (overrides: Record<string, unknown> = {}) => ({
      id: 'q1',
      title: 'My Quest',
      status: 'verification',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      source: {},
      artifacts: { handoff: 'HANDOFF.md', verification: 'VERIFICATION.md', brief: 'BRIEF.md' },
      baseSha: 'abc1234',
      questBranch: 'quest/q1',
      ...overrides,
    });

    it('regenerates BRIEF.md at executing → verification-ready transition (cmdSetStatus path)', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(verificationWorkflow()),
        '/project/.pi/quests/q1/VERIFICATION.md': '# Verification\npass\n',
      });
      const ctx = mockCtx('/project');
      await cmdSetStatus(ctx, ['q1', 'verification-ready']);
      // BRIEF.md should exist now.
      expect(vol.existsSync('/project/.pi/quests/q1/BRIEF.md')).toBe(true);
      const brief = vol.readFileSync('/project/.pi/quests/q1/BRIEF.md', 'utf-8') as string;
      expect(brief).toContain('STUB NARRATIVE');
      expect(brief).toContain('## Narrative');
    });

    it('does NOT regenerate BRIEF.md on non-autonomous-to-interactive transitions', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'intake',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md', brief: 'BRIEF.md' },
        }),
      });
      const ctx = mockCtx('/project');
      await cmdSetStatus(ctx, ['q1', 'reviewing']);
      // intake → reviewing is not an autonomous-to-interactive transition.
      expect(vol.existsSync('/project/.pi/quests/q1/BRIEF.md')).toBe(false);
    });

    it('cmdBrief always regenerates and notifies the user with the content', async () => {
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q1' }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(verificationWorkflow()),
      });
      const ctx = mockCtx('/project');
      await cmdBrief(ctx);
      expect(vol.existsSync('/project/.pi/quests/q1/BRIEF.md')).toBe(true);
      // The notify should include the brief content (markdown header).
      const briefNotify = notifyCalls.find((c) => c.msg.includes('# My Quest'));
      expect(briefNotify).toBeDefined();
    });

    it('cmdBrief warns when there is no active quest', async () => {
      const ctx = mockCtx('/project');
      await cmdBrief(ctx);
      expect(notifyCalls[0].level).toBe('warning');
      expect(notifyCalls[0].msg).toContain('No active quest');
    });

    it('cmdBrief updates lastSeenEventTimestamp after generating', async () => {
      const eventLine = JSON.stringify({
        event: 'stage_entered',
        timestamp: '2026-05-19T17:00:00.000Z',
        questId: 'q1',
        to: 'verification-ready',
      });
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q1' }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(verificationWorkflow()),
        '/project/.pi/quests/q1/telemetry/events.jsonl': eventLine + '\n',
      });
      const ctx = mockCtx('/project');
      await cmdBrief(ctx);
      const persistedState = JSON.parse(
        vol.readFileSync('/project/.pi/quest/state.json', 'utf-8') as string,
      );
      expect(persistedState.lastSeenEventTimestamp?.q1).toBe('2026-05-19T17:00:00.000Z');
    });

    it('tryAutoRoute displays the Brief and advances lastSeenEventTimestamp when there are newer events', async () => {
      const eventLine = JSON.stringify({
        event: 'stage_entered',
        timestamp: '2026-05-19T17:00:00.000Z',
        questId: 'q1',
        to: 'verification-ready',
      });
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q1' }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(verificationWorkflow({
          status: 'verification-ready',
        })),
        '/project/.pi/quests/q1/telemetry/events.jsonl': eventLine + '\n',
      });
      const ctx = mockCtx('/project');
      const advanced = await tryAutoRoute(ctx);
      expect(advanced).toBe(true);
      // The brief content should have been notified to the user.
      const briefNotify = notifyCalls.find((c) => c.msg.includes('# My Quest'));
      expect(briefNotify).toBeDefined();
      // Pointer advanced.
      const persistedState = JSON.parse(
        vol.readFileSync('/project/.pi/quest/state.json', 'utf-8') as string,
      );
      expect(persistedState.lastSeenEventTimestamp?.q1).toBe('2026-05-19T17:00:00.000Z');
    });

    it('tryAutoRoute does NOT re-display the Brief when no new events since last seen', async () => {
      const eventLine = JSON.stringify({
        event: 'stage_entered',
        timestamp: '2026-05-19T17:00:00.000Z',
        questId: 'q1',
        to: 'verification-ready',
      });
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({
          currentQuestId: 'q1',
          lastSeenEventTimestamp: { q1: '2026-05-19T17:00:00.000Z' },
        }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(verificationWorkflow({
          status: 'verification-ready',
        })),
        '/project/.pi/quests/q1/telemetry/events.jsonl': eventLine + '\n',
      });
      const ctx = mockCtx('/project');
      const advanced = await tryAutoRoute(ctx);
      expect(advanced).toBe(false);
      // No brief content was notified.
      const briefNotify = notifyCalls.find((c) => c.msg.includes('# My Quest'));
      expect(briefNotify).toBeUndefined();
    });

    it('intake creates a workflow whose artifacts.brief defaults to BRIEF.md', async () => {
      vol.fromJSON({
        '/project/handoff.md': '# Handoff Title\n\nbody',
      });
      const { cmdIntake } = await import('./commands');
      const ctx = mockCtx('/project');
      await cmdIntake(ctx, ['handoff.md']);
      // Find the persisted workflow under .pi/quests/<id>/workflow.json
      const questIds = vol.readdirSync('/project/.pi/quests') as string[];
      expect(questIds.length).toBe(1);
      const wf = JSON.parse(
        vol.readFileSync(`/project/.pi/quests/${questIds[0]}/workflow.json`, 'utf-8') as string,
      );
      expect(wf.artifacts.brief).toBe('BRIEF.md');
    });
  });

  describe('cmdResume (M4-4)', () => {
    beforeEach(async () => {
      vi.resetModules();
    });

    it('warns when no runId is supplied', async () => {
      vi.doMock('./resume.js', () => ({
        resumeRun: vi.fn(),
      }));
      const { cmdResume } = await import('./commands');
      const ctx = mockCtx('/project');
      await cmdResume(ctx, []);
      expect(notifyCalls.find((c) => c.level === 'warning')).toBeDefined();
    });

    it('calls resumeRun with empty acknowledgment when --note is not supplied', async () => {
      const resumeFn = vi.fn().mockResolvedValue({
        newRunId: 'new-run',
        worktreePath: '/wt',
        runBranch: 'quest-run/q1/r-paused',
        continuationPacket: '## Continuation',
      });
      vi.doMock('./resume.js', () => ({
        resumeRun: resumeFn,
      }));
      const { cmdResume } = await import('./commands');
      const ctx = mockCtx('/project');
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q1' }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'executing',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
        }),
      });
      await cmdResume(ctx, ['r-paused']);
      expect(resumeFn).toHaveBeenCalledWith({
        cwd: '/project',
        questId: 'q1',
        pausedRunId: 'r-paused',
        acknowledgment: '',
      });
    });

    it('passes the --note value through to resumeRun verbatim', async () => {
      const resumeFn = vi.fn().mockResolvedValue({
        newRunId: 'new-run',
        worktreePath: '/wt',
        runBranch: 'quest-run/q1/r-paused',
        continuationPacket: '## Continuation',
      });
      vi.doMock('./resume.js', () => ({
        resumeRun: resumeFn,
      }));
      const { cmdResume } = await import('./commands');
      const ctx = mockCtx('/project');
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q1' }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'executing',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
        }),
      });
      await cmdResume(ctx, ['r-paused', '--note', 'the lockfile drift is fine']);
      expect(resumeFn).toHaveBeenCalledWith({
        cwd: '/project',
        questId: 'q1',
        pausedRunId: 'r-paused',
        acknowledgment: 'the lockfile drift is fine',
      });
    });

    it('surfaces failures via ctx.ui.notify(error) and does not throw', async () => {
      vi.doMock('./resume.js', () => ({
        resumeRun: vi.fn().mockRejectedValue(new Error('not paused')),
      }));
      const { cmdResume } = await import('./commands');
      const ctx = mockCtx('/project');
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q1' }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'executing',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md' },
        }),
      });
      await expect(cmdResume(ctx, ['r-paused'])).resolves.toBeUndefined();
      expect(notifyCalls.find((c) => c.level === 'error')).toBeDefined();
    });
  });

  describe('acceptLaunchReview (issue #3)', () => {
    const baseLaunchReviewWorkflow = (overrides: Record<string, unknown> = {}) => ({
      id: 'q1',
      title: 'Launch quest',
      status: 'launch-review',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      source: {},
      artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' },
      ...overrides,
    });

    const trinityPlanWithoutSignOff =
      '---\n' +
      'blast_radius:\n' +
      '  in_scope:\n' +
      '    - src/foo.ts\n' +
      'pre_mortem:\n' +
      '  most_likely_failure: oops\n' +
      'compiler_diagnostics: []\n' +
      '---\n\n# Plan\n';

    it('Accept on gate-pass writes sign-off, transitions to executing, surfaces a single outcome notify', async () => {
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
        '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': trinityPlanWithoutSignOff,
      });
      const ctx = mockCtx('/project');

      const result = await acceptLaunchReview(
        ctx,
        'q1',
        '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md',
      );

      expect(result.outcome).toBe('applied');

      // Sign-off was written.
      const { readPlanFrontmatter } = await import('./launch-review');
      const fm = readPlanFrontmatter('/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md');
      const lr = fm.launch_review as Record<string, unknown>;
      expect(typeof lr.signed_off_at).toBe('string');
      expect(lr.signed_off_by).toBe('user');

      // Quest now sits at executing.
      const persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('executing');

      // One outcome notify confirming the transition.
      const statusNotifies = notifyCalls.filter((c) => c.msg.includes('status → executing'));
      expect(statusNotifies).toHaveLength(1);
      expect(statusNotifies[0].level).toBe('info');

      // Launch Gate event landed with outcome: passed.
      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const gate = events.find((e) => e.event === 'launch_gate');
      expect(gate.outcome).toBe('passed');
    });

    it('Accept on gate-block keeps quest at launch-review and surfaces reasons inline', async () => {
      // Plan is missing blast_radius — Launch Gate will block.
      const planMissingBlastRadius =
        '---\n' +
        'pre_mortem:\n' +
        '  most_likely_failure: oops\n' +
        'compiler_diagnostics: []\n' +
        '---\n\n# Plan\n';
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
        '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md': planMissingBlastRadius,
      });
      const ctx = mockCtx('/project');

      const result = await acceptLaunchReview(
        ctx,
        'q1',
        '/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md',
      );

      // Result reflects the gate-block.
      expect(result.outcome).toBe('rejected');
      if (result.outcome !== 'rejected') return;
      expect(result.reason).toBe('launch_gate_blocked');

      // Quest still at launch-review.
      const persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('launch-review');

      // One error notify surfacing the missing reason inline.
      const errorNotifies = notifyCalls.filter((c) => c.level === 'error');
      expect(errorNotifies).toHaveLength(1);
      expect(errorNotifies[0].msg).toContain('Launch Gate');
      expect(errorNotifies[0].msg).toContain('missing_blast_radius');

      // Sign-off was still written (per issue: step 1 happens regardless).
      const { readPlanFrontmatter } = await import('./launch-review');
      const fm = readPlanFrontmatter('/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md');
      const lr = fm.launch_review as Record<string, unknown>;
      expect(typeof lr.signed_off_at).toBe('string');

      // launch_gate event recorded as blocked with the reason.
      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const gate = events.find((e) => e.event === 'launch_gate');
      expect(gate.outcome).toBe('blocked');
      expect(gate.reasons).toContain('missing_blast_radius');
    });

    it('tryAutoRoute notify no longer instructs the user to manually type /quest set-status executing (issue #3)', async () => {
      // The skill's Accept handler now triggers the transition. The auto-router
      // should point the user at the skill, not at the manual command.
      vol.fromJSON({
        '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q1' }),
        '/project/.pi/quests/q1/workflow.json': JSON.stringify({
          id: 'q1', title: 'Q', status: 'planned',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
          source: {}, artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' },
        }),
      });
      const ctx = mockCtx('/project');
      await tryAutoRoute(ctx);
      const lrNotify = notifyCalls.find((c) => c.msg.includes('Launch Review'));
      expect(lrNotify).toBeDefined();
      // The notify must not bundle the manual "set-status ... executing"
      // instruction with a "when ready" prompt — the skill now handles that
      // transition on Accept. The --force escape hatch can still be referenced
      // in a separate sentence/clause, but it is not the primary path.
      expect(lrNotify!.msg).not.toContain('executing` (or `--force`) when ready');
    });

    it('--force regression: /quest set-status <id> executing --force still bypasses the skill', async () => {
      // No plan file at all — gate would normally block. Confirm the --force path
      // through cmdSetStatus is untouched by issue #3 (Accept lives in the skill;
      // --force lives in the slash command).
      vol.fromJSON({
        '/project/.pi/quests/q1/workflow.json': JSON.stringify(baseLaunchReviewWorkflow()),
      });
      const ctx = mockCtx('/project');
      await cmdSetStatus(ctx, ['q1', 'executing', '--force']);

      const persisted = JSON.parse(
        vol.readFileSync('/project/.pi/quests/q1/workflow.json', 'utf-8') as string,
      );
      expect(persisted.status).toBe('executing');

      const jsonl = vol.readFileSync(
        '/project/.pi/quests/q1/telemetry/events.jsonl',
        'utf-8',
      ) as string;
      const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
      const gate = events.find((e) => e.event === 'launch_gate');
      expect(gate.outcome).toBe('force_passed');
      expect(gate.reasons).toContain('user_forced');

      // The force path must NOT write a sign-off — its audit trail is the
      // force_passed event, not a `signed_off_at` in plan frontmatter.
      // (Plan file doesn't exist; verify no implicit creation.)
      expect(fs.existsSync('/project/.pi/quests/q1/IMPLEMENTATION_PLAN.md')).toBe(false);
    });
  });
});
