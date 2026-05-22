/**
 * M1-3 end-to-end integration test.
 *
 * Drives a multi-Run quest through:
 *  1. Status enters `executing` → baseSha + Quest Branch captured on workflow.
 *  2. Two Runs start in sequence → each gets its own Run Worktree.
 *  3. Both Runs complete → both attempt to merge into the Quest Branch.
 *  4. The second merge collides → `anomaly_detected` (tier: halt,
 *     rule: merge_conflict) emitted; the first merge proceeds independently.
 *
 * Real git is **not** invoked. The worktree helper is mocked and called from
 * the production code paths under test (the parent process logic).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import { EventEmitter } from 'node:events';

vi.mock('node:fs', async () => {
	const { fs } = await import('memfs');
	return { default: fs, ...fs };
});

vi.mock('node:child_process', () => ({
	spawn: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
	withFileMutationQueue: async (_p: string, fn: () => Promise<any>) => fn(),
}));

vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));

vi.mock('./paths.js', async () => {
	const actual = await vi.importActual<typeof import('./paths.js')>('./paths.js');
	return { ...actual, AGENTS_DIR: '/agents' };
});

vi.mock('./runs/worktree.js', () => ({
	getHeadSha: vi.fn().mockResolvedValue('basesha-deadbeef'),
	ensureQuestBranch: vi.fn().mockResolvedValue({
		questBranch: 'quest/q1',
		created: true,
	}),
	createRunWorktree: vi.fn(),
	removeRunWorktree: vi.fn().mockResolvedValue(undefined),
	listRunWorktrees: vi.fn().mockResolvedValue([]),
	mergeRunBranchIntoQuest: vi.fn(),
	worktreePathFor: (repoRoot: string, questId: string, runId: string) =>
		`${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
}));

import { captureQuestBranchOnExecuting } from './commands';
import { mergeCompletedRun, startSubagentRun, activeRuns } from './runs/runner';
import * as worktreeMod from './runs/worktree';

function makeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
		unref: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
		killed: boolean;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.pid = Math.floor(Math.random() * 100000);
	child.unref = vi.fn();
	child.kill = vi.fn();
	child.killed = false;
	return child;
}

describe('M1-3 end-to-end multi-run worktree integration', () => {
	beforeEach(() => {
		vol.reset();
		activeRuns.clear();
		vi.clearAllMocks();
		(worktreeMod.getHeadSha as any).mockResolvedValue('basesha-deadbeef');
		(worktreeMod.ensureQuestBranch as any).mockResolvedValue({
			questBranch: 'quest/q1',
			created: true,
		});
		(worktreeMod.removeRunWorktree as any).mockResolvedValue(undefined);
		(worktreeMod.createRunWorktree as any).mockImplementation(
			async ({ questId, runId, repoRoot }: any) => ({
				worktreePath: `${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
				runBranch: `quest-run/${questId}/${runId}`,
			}),
		);
	});

	it('captures Base SHA + Quest Branch on entry to executing, then runs two Runs whose Run Worktrees diverge', async () => {
		const workflow = {
			id: 'q1',
			title: 'Multi-run Quest',
			status: 'launch-review' as const,
			createdAt: '2024-01-01T00:00:00Z',
			updatedAt: '2024-01-01T00:00:00Z',
			source: {},
			artifacts: { handoff: 'H.md', plan: 'IMPLEMENTATION_PLAN.md' },
		};
		vol.fromJSON({
			'/agents/quest-implementation.md':
				'---\nname: quest-implementation\ndescription: impl\n---\nBody.',
			'/project/.pi/quests/q1/workflow.json': JSON.stringify(workflow),
		});
		vol.mkdirSync('/tmp', { recursive: true });

		// 1. Status transition: launch-review → executing captures baseSha.
		await captureQuestBranchOnExecuting(
			'/project',
			workflow as any,
			'executing',
		);
		expect((workflow as any).baseSha).toBe('basesha-deadbeef');
		expect((workflow as any).questBranch).toBe('quest/q1');
		expect(worktreeMod.getHeadSha).toHaveBeenCalledWith('/project');
		expect(worktreeMod.ensureQuestBranch).toHaveBeenCalledWith({
			repoRoot: '/project',
			questId: 'q1',
			baseSha: 'basesha-deadbeef',
		});

		// 2. Two Runs in sequence, each in its own Run Worktree.
		const { spawn } = await import('node:child_process');
		const childA = makeChild();
		const childB = makeChild();
		const seq: any[] = [childA, childB];
		(spawn as any).mockImplementation(() => seq.shift());

		const a = await startSubagentRun({
			cwd: '/project',
			questId: 'q1',
			questDir: '/project/.pi/quests/q1',
			workItemId: 'WI-A',
			agentName: 'quest-implementation',
			task: 'A',
			questBranch: 'quest/q1',
			baseSha: 'basesha-deadbeef',
		});
		const b = await startSubagentRun({
			cwd: '/project',
			questId: 'q1',
			questDir: '/project/.pi/quests/q1',
			workItemId: 'WI-B',
			agentName: 'quest-implementation',
			task: 'B',
			questBranch: 'quest/q1',
			baseSha: 'basesha-deadbeef',
		});

		expect(a.worktreePath).toBe(`/project/.pi/quests/q1/worktrees/${a.runId}`);
		expect(b.worktreePath).toBe(`/project/.pi/quests/q1/worktrees/${b.runId}`);
		expect(a.runBranch).toBe(`quest-run/q1/${a.runId}`);
		expect(b.runBranch).toBe(`quest-run/q1/${b.runId}`);
		expect(a.worktreePath).not.toBe(b.worktreePath);
		expect(a.runBranch).not.toBe(b.runBranch);

		// 3. Both runs complete; one merge succeeds, the other conflicts.
		(worktreeMod.mergeRunBranchIntoQuest as any)
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({
				ok: false,
				conflict: 'CONFLICT (content): src/foo.ts',
			});

		// Manually invoke mergeCompletedRun for each (the finalize close handler
		// would do this fire-and-forget in the real flow).
		await mergeCompletedRun({
			repoRoot: '/project',
			questDir: '/project/.pi/quests/q1',
			questId: 'q1',
			runId: a.runId,
			workItemId: 'WI-A',
			runBranch: a.runBranch!,
			questBranch: 'quest/q1',
			worktreePath: a.worktreePath!,
		});
		await mergeCompletedRun({
			repoRoot: '/project',
			questDir: '/project/.pi/quests/q1',
			questId: 'q1',
			runId: b.runId,
			workItemId: 'WI-B',
			runBranch: b.runBranch!,
			questBranch: 'quest/q1',
			worktreePath: b.worktreePath!,
		});

		// First merge succeeded → removed the worktree.
		expect(worktreeMod.removeRunWorktree).toHaveBeenCalledWith(a.worktreePath!);

		// 4. The conflict produced an anomaly_detected halt-tier event for run B
		// only, and the run summary was flipped to failed.
		const jsonl = vol.readFileSync(
			'/project/.pi/quests/q1/telemetry/events.jsonl',
			'utf-8',
		) as string;
		const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
		const anomalies = events.filter((e) => e.event === 'anomaly_detected');
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0].tier).toBe('halt');
		expect(anomalies[0].rule).toBe('merge_conflict');
		expect(anomalies[0].runId).toBe(b.runId);
		expect(anomalies[0].details.questBranch).toBe('quest/q1');

		// The events.jsonl also contains run_started + run_finished entries
		// (from startSubagentRun's writeRunSummary cascade and recordRunFinished).
		// We don't assert their exact count here — just that the conflict
		// surface is correct.
	});
});
