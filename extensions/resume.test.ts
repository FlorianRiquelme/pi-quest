/**
 * Tests for the Resume mechanic (M4-4, ADR 017).
 *
 * Two flavours:
 *   - Pure unit tests for `composeContinuationPacket` (mocked git callbacks).
 *   - Integration tests for `resumeRun` (memfs + mocked child_process).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fs, vol } from 'memfs';
import { EventEmitter } from 'node:events';
import {
	composeContinuationPacket,
	resumeRun,
	type ContinuationPacketInput,
} from './resume';
import type { BackgroundRunSummary } from './types';

vi.mock('node:fs', async () => {
	const { fs } = await import('memfs');
	return { default: fs, ...fs };
});

vi.mock('node:child_process', () => ({
	spawn: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
	withFileMutationQueue: async (_path: string, fn: () => Promise<any>) => fn(),
}));

vi.mock('./worktree.js', () => ({
	createRunWorktree: vi.fn(),
	removeRunWorktree: vi.fn().mockResolvedValue(undefined),
	listRunWorktrees: vi.fn().mockResolvedValue([]),
	mergeRunBranchIntoQuest: vi.fn().mockResolvedValue({ ok: true }),
	worktreePathFor: (repoRoot: string, questId: string, runId: string) =>
		`${repoRoot}/.pi/quests/${questId}/worktrees/${runId}`,
	getHeadSha: vi.fn().mockResolvedValue('basesha'),
	ensureQuestBranch: vi.fn().mockResolvedValue({ questBranch: 'quest/q1', created: false }),
}));

/* ============================ composeContinuationPacket ============================ */

describe('composeContinuationPacket', () => {
	function baseInput(overrides: Partial<ContinuationPacketInput> = {}): ContinuationPacketInput {
		return {
			questId: 'q1',
			workItemId: '001',
			pausedRunId: 'r-paused',
			newRunId: 'r-new',
			chainLength: 1,
			pausedAt: '2026-05-19T17:25:00.000Z',
			pausedReason: 'lockfile_drift',
			anomalyDetails: { files: ['pnpm-lock.yaml'] },
			acknowledgment: 'lockfile drift is intentional',
			lastFiveBeats: [
				{ timestamp: '2026-05-19T17:10:00.000Z', phase: 'reading-docs', note: 'reviewed PRD' },
				{ timestamp: '2026-05-19T17:15:00.000Z', phase: 'implementing', note: 'started edits' },
			],
			lastReportContent: '# Report\nProgress noted.',
			runBranch: 'quest-run/q1/r-paused',
			lastCommit: 'a1b2c3d feat: drop tests',
			diffShortstat: ' 3 files changed, 10 insertions(+), 2 deletions(-)',
			untrackedFiles: ['notes.md'],
			...overrides,
		};
	}

	it('renders the Identity section with quest, work-item, paused/new run IDs and resumption #', () => {
		const out = composeContinuationPacket(baseInput({ chainLength: 1 }));
		expect(out).toContain('### 1. Identity');
		expect(out).toContain('Quest: q1');
		expect(out).toContain('Work-item: 001');
		expect(out).toContain('Paused run: r-paused');
		expect(out).toContain('New run (this one): r-new');
		expect(out).toContain('This is resumption #1');
	});

	it('renders the Anomaly + acknowledgment section', () => {
		const out = composeContinuationPacket(baseInput());
		expect(out).toContain('### 2. Anomaly + user acknowledgment');
		expect(out).toContain('lockfile_drift');
		expect(out).toContain('pnpm-lock.yaml');
		expect(out).toContain('> lockfile drift is intentional');
	});

	it('defaults empty acknowledgment to the fallback text', () => {
		const out = composeContinuationPacket(baseInput({ acknowledgment: '' }));
		expect(out).toContain('> User chose to resume without comment');
	});

	it('treats whitespace-only acknowledgment as empty', () => {
		const out = composeContinuationPacket(baseInput({ acknowledgment: '   \n  ' }));
		expect(out).toContain('> User chose to resume without comment');
	});

	it('renders the Last 5 progress beats section with timestamps + phases', () => {
		const out = composeContinuationPacket(baseInput());
		expect(out).toContain('### 3. Last 5 progress beats');
		expect(out).toContain('2026-05-19T17:10:00.000Z');
		expect(out).toContain('reading-docs');
		expect(out).toContain('implementing');
		expect(out).toContain('reviewed PRD');
	});

	it('renders the Last report content section verbatim', () => {
		const out = composeContinuationPacket(baseInput());
		expect(out).toContain('### 4. Last report content');
		expect(out).toContain('# Report');
		expect(out).toContain('Progress noted.');
	});

	it('renders the placeholder when no report content is available', () => {
		const out = composeContinuationPacket(baseInput({ lastReportContent: undefined }));
		expect(out).toContain('_No report yet._');
	});

	it('renders the worktree state section with branch, last commit, diff and untracked files', () => {
		const out = composeContinuationPacket(baseInput());
		expect(out).toContain('### 5. Current worktree state');
		expect(out).toContain('Branch: quest-run/q1/r-paused');
		expect(out).toContain('a1b2c3d feat: drop tests');
		expect(out).toContain('3 files changed');
		expect(out).toContain('notes.md');
	});

	it('caps the beats list at five entries even when more are supplied', () => {
		const beats = Array.from({ length: 10 }, (_, i) => ({
			timestamp: `2026-05-19T17:${String(i).padStart(2, '0')}:00.000Z`,
			phase: `phase-${i}`,
		}));
		const out = composeContinuationPacket(baseInput({ lastFiveBeats: beats }));
		// All five most-recent beats should appear; the older five must not.
		for (let i = 5; i < 10; i++) {
			expect(out).toContain(`phase-${i}`);
		}
		expect(out).not.toContain('phase-0');
		expect(out).not.toContain('phase-4');
	});
});

/* ============================ resumeRun integration ============================ */

function makeFakeChild() {
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
	child.pid = 99999;
	child.unref = vi.fn();
	child.kill = vi.fn();
	child.killed = false;
	return child;
}

function seedPausedRun(overrides: Partial<BackgroundRunSummary> = {}): BackgroundRunSummary {
	const runId = overrides.runId ?? 'r-paused';
	const summary: BackgroundRunSummary = {
		runId,
		questId: 'q1',
		workItemId: '001',
		agentName: 'quest-implementation',
		status: 'paused',
		startedAt: '2026-05-19T17:00:00.000Z',
		updatedAt: '2026-05-19T17:25:00.000Z',
		paused_at: '2026-05-19T17:25:00.000Z',
		paused_reason: 'lockfile_drift',
		stdoutPath: `/project/.pi/quests/q1/runs/${runId}.stdout.log`,
		stderrPath: `/project/.pi/quests/q1/runs/${runId}.stderr.log`,
		reportPath: '/project/.pi/quests/q1/reports/001.md',
		statusPath: `/project/.pi/quests/q1/runs/${runId}.json`,
		worktreePath: '/project/.pi/quests/q1/worktrees/r-paused',
		runBranch: 'quest-run/q1/r-paused',
		questBranch: 'quest/q1',
		model: 'kimi-2.6',
		...overrides,
	};
	vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
	vol.mkdirSync('/project/.pi/quests/q1/reports', { recursive: true });
	vol.mkdirSync('/project/.pi/quests/q1/telemetry', { recursive: true });
	vol.writeFileSync(
		`/project/.pi/quests/q1/runs/${runId}.json`,
		JSON.stringify(summary),
	);
	return summary;
}

describe('resumeRun', () => {
	beforeEach(() => {
		vol.reset();
		vi.clearAllMocks();
	});

	it('refuses to resume a run that is not paused', async () => {
		seedPausedRun({ status: 'running' });
		await expect(
			resumeRun({
				cwd: '/project',
				questId: 'q1',
				pausedRunId: 'r-paused',
				acknowledgment: 'go',
			}),
		).rejects.toThrow(/paused/i);
	});

	it('refuses when the paused run JSON does not exist', async () => {
		vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
		await expect(
			resumeRun({
				cwd: '/project',
				questId: 'q1',
				pausedRunId: 'missing',
				acknowledgment: 'go',
			}),
		).rejects.toThrow(/not found/i);
	});

	it('creates a new running run with continues_from pointing at the paused run', async () => {
		seedPausedRun();
		const { spawn } = await import('node:child_process');
		const child = makeFakeChild();
		(spawn as any).mockReturnValue(child);

		const result = await resumeRun({
			cwd: '/project',
			questId: 'q1',
			pausedRunId: 'r-paused',
			acknowledgment: 'looks fine',
		});

		expect(result.newRunId).toBeTruthy();
		expect(result.newRunId).not.toBe('r-paused');

		const newJson = JSON.parse(
			vol.readFileSync(
				`/project/.pi/quests/q1/runs/${result.newRunId}.json`,
				'utf-8',
			) as string,
		);
		expect(newJson.status).toBe('running');
		expect(newJson.continues_from).toBe('r-paused');
		expect(newJson.workItemId).toBe('001');
		expect(newJson.agentName).toBe('quest-implementation');
		// Model is normalized through MODEL_ALIASES, same as startSubagentRun.
		expect(newJson.model).toBe('openrouter/moonshotai/kimi-k2.6');
	});

	it('spawns the new run in the paused run worktree path and on the same Run Branch', async () => {
		seedPausedRun();
		const { spawn } = await import('node:child_process');
		const child = makeFakeChild();
		(spawn as any).mockReturnValue(child);

		const result = await resumeRun({
			cwd: '/project',
			questId: 'q1',
			pausedRunId: 'r-paused',
			acknowledgment: 'looks fine',
		});

		expect(result.worktreePath).toBe('/project/.pi/quests/q1/worktrees/r-paused');
		expect(result.runBranch).toBe('quest-run/q1/r-paused');

		const spawnOpts = (spawn as any).mock.calls[0][2];
		expect(spawnOpts.cwd).toBe('/project/.pi/quests/q1/worktrees/r-paused');
	});

	it('does not mutate the paused run JSON', async () => {
		const seeded = seedPausedRun();
		const before = vol.readFileSync(
			'/project/.pi/quests/q1/runs/r-paused.json',
			'utf-8',
		) as string;

		const { spawn } = await import('node:child_process');
		(spawn as any).mockReturnValue(makeFakeChild());

		await resumeRun({
			cwd: '/project',
			questId: 'q1',
			pausedRunId: 'r-paused',
			acknowledgment: 'go',
		});

		const after = vol.readFileSync(
			'/project/.pi/quests/q1/runs/r-paused.json',
			'utf-8',
		) as string;
		expect(after).toBe(before);
		expect(JSON.parse(after).status).toBe('paused');
		expect(seeded.runId).toBe('r-paused');
	});

	it('emits run_resumed then run_started in telemetry', async () => {
		seedPausedRun();
		const { spawn } = await import('node:child_process');
		(spawn as any).mockReturnValue(makeFakeChild());

		const result = await resumeRun({
			cwd: '/project',
			questId: 'q1',
			pausedRunId: 'r-paused',
			acknowledgment: 'the unbounded diff is fine',
		});

		const jsonl = vol.readFileSync(
			'/project/.pi/quests/q1/telemetry/events.jsonl',
			'utf-8',
		) as string;
		const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));

		const resumed = events.find((e) => e.event === 'run_resumed');
		expect(resumed).toBeDefined();
		expect(resumed.new_run_id).toBe(result.newRunId);
		expect(resumed.continues_from).toBe('r-paused');
		expect(resumed.acknowledgment).toBe('the unbounded diff is fine');

		const started = events.find((e) => e.event === 'run_started' && e.runId === result.newRunId);
		expect(started).toBeDefined();
		expect(started.workItemId).toBe('001');

		// Order matters: run_resumed precedes run_started.
		const resumedIdx = events.findIndex((e) => e.event === 'run_resumed');
		const startedIdx = events.findIndex(
			(e) => e.event === 'run_started' && e.runId === result.newRunId,
		);
		expect(resumedIdx).toBeLessThan(startedIdx);
	});

	it('chain support: a paused run that itself has continues_from yields a new run whose continues_from is the immediate predecessor', async () => {
		// Seed a paused run that was itself resumed earlier (continues_from: 'r-original').
		seedPausedRun({ runId: 'r-paused', continues_from: 'r-original' });
		const { spawn } = await import('node:child_process');
		(spawn as any).mockReturnValue(makeFakeChild());

		const result = await resumeRun({
			cwd: '/project',
			questId: 'q1',
			pausedRunId: 'r-paused',
			acknowledgment: 'continuing',
		});

		const newJson = JSON.parse(
			vol.readFileSync(
				`/project/.pi/quests/q1/runs/${result.newRunId}.json`,
				'utf-8',
			) as string,
		);
		// Must point at the immediate predecessor, NOT at r-original.
		expect(newJson.continues_from).toBe('r-paused');
		expect(newJson.continues_from).not.toBe('r-original');
	});

	it('continuation packet appears in the spawned subagent task prompt (last arg)', async () => {
		seedPausedRun();
		// Seed a report so the packet section 4 has content.
		vol.writeFileSync(
			'/project/.pi/quests/q1/reports/001.md',
			'# Report for 001\nProgress.',
		);
		const { spawn } = await import('node:child_process');
		(spawn as any).mockReturnValue(makeFakeChild());

		await resumeRun({
			cwd: '/project',
			questId: 'q1',
			pausedRunId: 'r-paused',
			acknowledgment: 'go go go',
		});

		const args = (spawn as any).mock.calls[0][1] as string[];
		const taskArg = args[args.length - 1];
		expect(taskArg).toContain('Continuation');
		expect(taskArg).toContain('### 1. Identity');
		expect(taskArg).toContain('### 5. Current worktree state');
		expect(taskArg).toContain('go go go');
	});

	it('injects PI_QUEST_RUN_ID with the new runId, not the paused runId', async () => {
		seedPausedRun();
		const { spawn } = await import('node:child_process');
		(spawn as any).mockReturnValue(makeFakeChild());

		const result = await resumeRun({
			cwd: '/project',
			questId: 'q1',
			pausedRunId: 'r-paused',
			acknowledgment: 'ok',
		});

		const spawnOpts = (spawn as any).mock.calls[0][2];
		expect(spawnOpts.env.PI_QUEST_RUN_ID).toBe(result.newRunId);
		expect(spawnOpts.env.PI_QUEST_QUEST_ID).toBe('q1');
		expect(spawnOpts.env.PI_QUEST_WORK_ITEM_ID).toBe('001');
	});

	it('defaults empty acknowledgment to the fallback text in the run_resumed event', async () => {
		seedPausedRun();
		const { spawn } = await import('node:child_process');
		(spawn as any).mockReturnValue(makeFakeChild());

		await resumeRun({
			cwd: '/project',
			questId: 'q1',
			pausedRunId: 'r-paused',
			acknowledgment: '',
		});

		const jsonl = vol.readFileSync(
			'/project/.pi/quests/q1/telemetry/events.jsonl',
			'utf-8',
		) as string;
		const events = jsonl.trim().split('\n').map((l) => JSON.parse(l));
		const resumed = events.find((e) => e.event === 'run_resumed');
		expect(resumed.acknowledgment).toBe('User chose to resume without comment');
	});

	it('multi-Resume chain: pause → resume → pause-again → resume-again creates a correct chain of continues_from references', async () => {
		// Start: r-original is paused. Resume it → r-second (continues_from: r-original).
		// Then r-second pauses. Resume r-second → r-third (continues_from: r-second).
		// Final chain check: r-third.continues_from === r-second.
		const { spawn } = await import('node:child_process');
		(spawn as any).mockReturnValue(makeFakeChild());

		// generateTimestampId() uses `new Date()` at second resolution. Two
		// Resumes within the same test run can collide. Use vi fake timers to
		// advance the clock between calls so the runIds differ.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-19T18:00:00.000Z'));

		try {
			seedPausedRun({ runId: 'r-original' });
			// First Resume.
			const first = await resumeRun({
				cwd: '/project',
				questId: 'q1',
				pausedRunId: 'r-original',
				acknowledgment: 'first resume',
			});
			// Advance the clock so the second `generateTimestampId()` differs.
			vi.setSystemTime(new Date('2026-05-19T18:05:00.000Z'));

			// Simulate r-second pausing — overwrite its status JSON.
			const secondJson = JSON.parse(
				vol.readFileSync(`/project/.pi/quests/q1/runs/${first.newRunId}.json`, 'utf-8') as string,
			);
			secondJson.status = 'paused';
			secondJson.paused_at = '2026-05-19T18:05:00.000Z';
			secondJson.paused_reason = 'heartbeat_missed';
			vol.writeFileSync(
				`/project/.pi/quests/q1/runs/${first.newRunId}.json`,
				JSON.stringify(secondJson),
			);

			// Second Resume.
			const second = await resumeRun({
				cwd: '/project',
				questId: 'q1',
				pausedRunId: first.newRunId,
				acknowledgment: 'second resume',
			});

			// Sanity: the two new runIds must differ.
			expect(second.newRunId).not.toBe(first.newRunId);

			const thirdJson = JSON.parse(
				vol.readFileSync(`/project/.pi/quests/q1/runs/${second.newRunId}.json`, 'utf-8') as string,
			);
			// r-third → r-second → r-original is the chain.
			expect(thirdJson.continues_from).toBe(first.newRunId);
			// Walk back one more hop and confirm the next link.
			const linkedJson = JSON.parse(
				vol.readFileSync(`/project/.pi/quests/q1/runs/${thirdJson.continues_from}.json`, 'utf-8') as string,
			);
			expect(linkedJson.continues_from).toBe('r-original');
		} finally {
			vi.useRealTimers();
		}
	});

	it('resumption # counter reflects chain length (paused run with one prior continues_from → resumption #2)', async () => {
		// Chain: r-original → r-prev (resumed once) → r-paused (paused after second attempt).
		// Resume of r-paused should mark this as resumption #2.
		vol.mkdirSync('/project/.pi/quests/q1/runs', { recursive: true });
		vol.mkdirSync('/project/.pi/quests/q1/telemetry', { recursive: true });
		vol.writeFileSync(
			'/project/.pi/quests/q1/runs/r-original.json',
			JSON.stringify({
				runId: 'r-original',
				questId: 'q1',
				workItemId: '001',
				agentName: 'quest-implementation',
				status: 'paused',
				startedAt: '2026-05-19T10:00:00.000Z',
				updatedAt: '2026-05-19T10:30:00.000Z',
				stdoutPath: '/x',
				stderrPath: '/y',
				reportPath: '/z',
				statusPath: '/project/.pi/quests/q1/runs/r-original.json',
			}),
		);
		seedPausedRun({ continues_from: 'r-original' });
		const { spawn } = await import('node:child_process');
		(spawn as any).mockReturnValue(makeFakeChild());

		await resumeRun({
			cwd: '/project',
			questId: 'q1',
			pausedRunId: 'r-paused',
			acknowledgment: 'ok',
		});

		const args = (spawn as any).mock.calls[0][1] as string[];
		const taskArg = args[args.length - 1];
		// r-original → r-paused → new run = resumption #2.
		expect(taskArg).toContain('This is resumption #2');
	});
});
