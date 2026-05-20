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
});
