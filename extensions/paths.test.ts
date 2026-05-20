import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import {
	getQuestsDir,
	getStatePath,
	questDirPath,
	resolvePiHome,
	clearPiHomeCache,
} from './paths';

vi.mock('node:fs', async () => {
	const { fs } = await import('memfs');
	return { default: fs, ...fs };
});

describe('paths', () => {
	const originalEnv = process.env.PI_QUEST_HOME;

	beforeEach(() => {
		vol.reset();
		clearPiHomeCache();
		delete process.env.PI_QUEST_HOME;
	});

	afterEach(() => {
		if (originalEnv !== undefined) process.env.PI_QUEST_HOME = originalEnv;
		else delete process.env.PI_QUEST_HOME;
		clearPiHomeCache();
	});

	describe('getQuestsDir', () => {
		it('returns <cwd>/.pi/quests by default', () => {
			expect(getQuestsDir('/project')).toBe('/project/.pi/quests');
		});
	});

	describe('getStatePath', () => {
		it('returns <cwd>/.pi/quest/state.json by default', () => {
			expect(getStatePath('/project')).toBe('/project/.pi/quest/state.json');
		});
	});

	describe('questDirPath', () => {
		it('joins quest id under the quests root', () => {
			expect(questDirPath('/project', 'q1')).toBe('/project/.pi/quests/q1');
		});
	});

	describe('resolvePiHome', () => {
		it('prefers PI_QUEST_HOME env var when set', () => {
			process.env.PI_QUEST_HOME = '/elsewhere/.pi';
			expect(resolvePiHome('/project/.pi/quests/q1/worktrees/r1')).toBe('/elsewhere/.pi');
		});

		it('walks up from cwd looking for a .pi directory when env unset', () => {
			vol.fromJSON({
				'/project/.pi/quests/.keep': '',
			});
			const cwd = '/project/.pi/quests/q1/worktrees/r1';
			// Should walk up and find /project/.pi
			expect(resolvePiHome(cwd)).toBe('/project/.pi');
		});

		it('returns undefined when no .pi directory found in walk-up', () => {
			expect(resolvePiHome('/tmp/foo/bar')).toBeUndefined();
		});

		it('caches walk-up results across calls', () => {
			vol.fromJSON({
				'/project/.pi/quests/.keep': '',
			});
			// First call walks. Second call should hit cache (we test cache by
			// deleting the file after the first call; second call still returns
			// the cached value).
			const cwd = '/project/.pi/quests/q1/worktrees/r1';
			expect(resolvePiHome(cwd)).toBe('/project/.pi');
			vol.reset();
			expect(resolvePiHome(cwd)).toBe('/project/.pi');
		});

		it('env var overrides walk-up cache', () => {
			vol.fromJSON({
				'/project/.pi/quests/.keep': '',
			});
			const cwd = '/project/.pi/quests/q1/worktrees/r1';
			expect(resolvePiHome(cwd)).toBe('/project/.pi');
			process.env.PI_QUEST_HOME = '/other/.pi';
			// Env var consulted on every call — overrides cached walk.
			expect(resolvePiHome(cwd)).toBe('/other/.pi');
		});
	});
});
