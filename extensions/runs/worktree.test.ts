import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import { EventEmitter } from 'node:events';
import {
	worktreePathFor,
	createRunWorktree,
	removeRunWorktree,
	listRunWorktrees,
	mergeRunBranchIntoQuest,
	ensureQuestBranch,
	getHeadSha,
} from './worktree';

vi.mock('node:fs', async () => {
	const { fs } = await import('memfs');
	return { default: fs, ...fs };
});

vi.mock('node:child_process', () => ({
	spawn: vi.fn(),
}));

vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));

function makeFakeProc(opts: {
	exitCode?: number;
	stdout?: string;
	stderr?: string;
}) {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: ReturnType<typeof vi.fn>;
		killed: boolean;
	};
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn();
	proc.killed = false;
	queueMicrotask(() => {
		if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
		if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
		proc.emit('close', opts.exitCode ?? 0);
	});
	return proc;
}

describe('worktree helper module', () => {
	beforeEach(() => {
		vol.reset();
		vi.clearAllMocks();
	});

	describe('worktreePathFor', () => {
		it('returns absolute path under .pi/quests/<id>/worktrees/<runId>', () => {
			expect(worktreePathFor('/project', 'q1', 'run-1')).toBe(
				'/project/.pi/quests/q1/worktrees/run-1',
			);
		});

		it('preserves nested run-id segments', () => {
			expect(worktreePathFor('/repo', 'q-alpha', 'wi-001-20240101120000')).toBe(
				'/repo/.pi/quests/q-alpha/worktrees/wi-001-20240101120000',
			);
		});
	});

	describe('getHeadSha', () => {
		it('invokes `git rev-parse HEAD` and returns the trimmed SHA', async () => {
			const { spawn } = await import('node:child_process');
			(spawn as any).mockReturnValue(
				makeFakeProc({ stdout: 'abc123def456\n', exitCode: 0 }),
			);
			const sha = await getHeadSha('/project');
			expect(sha).toBe('abc123def456');
			expect(spawn).toHaveBeenCalledWith(
				'git',
				['rev-parse', 'HEAD'],
				expect.objectContaining({ cwd: '/project' }),
			);
		});

		it('rejects when git fails', async () => {
			const { spawn } = await import('node:child_process');
			(spawn as any).mockReturnValue(makeFakeProc({ exitCode: 1, stderr: 'fatal' }));
			await expect(getHeadSha('/project')).rejects.toThrow();
		});
	});

	describe('ensureQuestBranch', () => {
		it('creates quest/<id> branch from baseSha when absent', async () => {
			const { spawn } = await import('node:child_process');
			const calls: Array<{ cmd: string; args: string[] }> = [];
			(spawn as any).mockImplementation((cmd: string, args: string[]) => {
				calls.push({ cmd, args });
				// First call: show-ref --verify refs/heads/quest/q1 → not found (exit 1)
				// Second call: branch quest/q1 <sha> → ok
				if (args[0] === 'show-ref') {
					return makeFakeProc({ exitCode: 1 });
				}
				return makeFakeProc({ exitCode: 0 });
			});

			await ensureQuestBranch({
				repoRoot: '/project',
				questId: 'q1',
				baseSha: 'abc123',
			});

			expect(calls.length).toBeGreaterThanOrEqual(2);
			expect(calls[0].args).toEqual([
				'show-ref',
				'--verify',
				'--quiet',
				'refs/heads/quest/q1',
			]);
			expect(calls[1].args).toEqual(['branch', 'quest/q1', 'abc123']);
		});

		it('is idempotent — does not re-create when branch already exists', async () => {
			const { spawn } = await import('node:child_process');
			const calls: Array<{ args: string[] }> = [];
			(spawn as any).mockImplementation((_cmd: string, args: string[]) => {
				calls.push({ args });
				// show-ref returns 0 → branch exists
				if (args[0] === 'show-ref') return makeFakeProc({ exitCode: 0 });
				return makeFakeProc({ exitCode: 0 });
			});

			await ensureQuestBranch({
				repoRoot: '/project',
				questId: 'q1',
				baseSha: 'abc123',
			});

			expect(calls).toHaveLength(1);
			expect(calls[0].args[0]).toBe('show-ref');
		});
	});

	describe('createRunWorktree', () => {
		it('invokes `git worktree add -b <runBranch> <path> <questBranch>`', async () => {
			const { spawn } = await import('node:child_process');
			(spawn as any).mockReturnValue(makeFakeProc({ exitCode: 0 }));

			const result = await createRunWorktree({
				repoRoot: '/project',
				questId: 'q1',
				runId: 'run-1',
				baseSha: 'abc123',
				questBranch: 'quest/q1',
			});

			expect(result.worktreePath).toBe('/project/.pi/quests/q1/worktrees/run-1');
			expect(result.runBranch).toBe('quest-run/q1/run-1');
			expect(spawn).toHaveBeenCalledWith(
				'git',
				[
					'worktree',
					'add',
					'-b',
					'quest-run/q1/run-1',
					'/project/.pi/quests/q1/worktrees/run-1',
					'quest/q1',
				],
				expect.objectContaining({ cwd: '/project' }),
			);
		});

		it('rejects when git worktree add fails', async () => {
			const { spawn } = await import('node:child_process');
			(spawn as any).mockReturnValue(
				makeFakeProc({ exitCode: 1, stderr: 'fatal: worktree exists' }),
			);
			await expect(
				createRunWorktree({
					repoRoot: '/project',
					questId: 'q1',
					runId: 'run-1',
					baseSha: 'abc123',
					questBranch: 'quest/q1',
				}),
			).rejects.toThrow(/worktree/);
		});
	});

	describe('removeRunWorktree', () => {
		it('invokes `git worktree remove --force <path>`', async () => {
			const { spawn } = await import('node:child_process');
			(spawn as any).mockReturnValue(makeFakeProc({ exitCode: 0 }));

			await removeRunWorktree('/project/.pi/quests/q1/worktrees/run-1');

			expect(spawn).toHaveBeenCalledWith(
				'git',
				['worktree', 'remove', '--force', '/project/.pi/quests/q1/worktrees/run-1'],
				expect.any(Object),
			);
		});

		it('tolerates a missing path (does not throw)', async () => {
			const { spawn } = await import('node:child_process');
			(spawn as any).mockReturnValue(
				makeFakeProc({ exitCode: 128, stderr: "fatal: 'x' is not a working tree" }),
			);
			await expect(
				removeRunWorktree('/project/.pi/quests/q1/worktrees/missing'),
			).resolves.toBeUndefined();
		});
	});

	describe('listRunWorktrees', () => {
		it('parses porcelain output into { path, branch } entries', async () => {
			const { spawn } = await import('node:child_process');
			const porcelain =
				'worktree /project\nHEAD abcdef\nbranch refs/heads/main\n\n' +
				'worktree /project/.pi/quests/q1/worktrees/run-1\nHEAD 123456\nbranch refs/heads/quest-run/q1/run-1\n\n' +
				'worktree /project/.pi/quests/q1/worktrees/run-2\nHEAD 789abc\nbranch refs/heads/quest-run/q1/run-2\n\n';
			(spawn as any).mockReturnValue(
				makeFakeProc({ exitCode: 0, stdout: porcelain }),
			);

			const list = await listRunWorktrees('/project');

			expect(list).toEqual([
				{ path: '/project', branch: 'main' },
				{
					path: '/project/.pi/quests/q1/worktrees/run-1',
					branch: 'quest-run/q1/run-1',
				},
				{
					path: '/project/.pi/quests/q1/worktrees/run-2',
					branch: 'quest-run/q1/run-2',
				},
			]);
		});

		it('returns empty list when git fails', async () => {
			const { spawn } = await import('node:child_process');
			(spawn as any).mockReturnValue(makeFakeProc({ exitCode: 1 }));
			const list = await listRunWorktrees('/project');
			expect(list).toEqual([]);
		});
	});

	describe('mergeRunBranchIntoQuest', () => {
		it('returns { ok: true } when merge succeeds', async () => {
			const { spawn } = await import('node:child_process');
			(spawn as any).mockImplementation((_cmd: string, _args: string[]) => {
				// every git call succeeds
				return makeFakeProc({ exitCode: 0 });
			});

			const result = await mergeRunBranchIntoQuest({
				repoRoot: '/project',
				questBranch: 'quest/q1',
				runBranch: 'quest-run/q1/run-1',
			});
			expect(result.ok).toBe(true);
		});

		it('returns { ok: false, conflict } when merge fails', async () => {
			const { spawn } = await import('node:child_process');
			(spawn as any).mockImplementation((_cmd: string, args: string[]) => {
				// worktree add succeeds, merge fails, worktree remove succeeds
				if (args[0] === 'worktree' && args[1] === 'add') {
					return makeFakeProc({ exitCode: 0 });
				}
				if (args[0] === 'merge') {
					return makeFakeProc({
						exitCode: 1,
						stderr: 'CONFLICT (content): Merge conflict in src/foo.ts',
					});
				}
				return makeFakeProc({ exitCode: 0 });
			});

			const result = await mergeRunBranchIntoQuest({
				repoRoot: '/project',
				questBranch: 'quest/q1',
				runBranch: 'quest-run/q1/run-1',
			});
			expect(result.ok).toBe(false);
			expect(result.conflict).toMatch(/CONFLICT/);
		});

		it('invokes `git merge --no-ff <runBranch>` inside a worktree of <questBranch>', async () => {
			const { spawn } = await import('node:child_process');
			const calls: Array<{ args: string[] }> = [];
			(spawn as any).mockImplementation((_cmd: string, args: string[]) => {
				calls.push({ args });
				return makeFakeProc({ exitCode: 0 });
			});

			await mergeRunBranchIntoQuest({
				repoRoot: '/project',
				questBranch: 'quest/q1',
				runBranch: 'quest-run/q1/run-1',
			});

			// At least one of the git calls must be `merge --no-ff quest-run/q1/run-1`.
			const mergeCall = calls.find(
				(c) =>
					c.args[0] === 'merge' &&
					c.args.includes('--no-ff') &&
					c.args.includes('quest-run/q1/run-1'),
			);
			expect(mergeCall).toBeDefined();
		});
	});
});
