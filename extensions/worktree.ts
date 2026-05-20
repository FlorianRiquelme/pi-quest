/**
 * Run-worktree lifecycle (ADR 011).
 *
 * Each Run gets its own git worktree under `.pi/quests/<questId>/worktrees/<runId>/`
 * checked out to the Run Branch `quest-run/<questId>/<runId>`. Completed runs
 * merge into the Quest Branch `quest/<questId>` via `git merge --no-ff`.
 *
 * Quest-Branch merge strategy: **throwaway worktree**. We add a temporary
 * worktree of the Quest Branch (under `os.tmpdir()`), run the merge there, then
 * remove the worktree. This keeps the user's main checkout untouched and lets
 * every merge run in its own clean working tree.
 *
 * Tests mock `child_process.spawn` — these helpers must be pure shells around
 * git invocations so the spawn args are the assertable surface.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Run a git command and capture its output. Resolves with `{ exitCode, stdout, stderr }`.
 */
function runGit(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
		proc.on("error", (err) =>
			resolve({ exitCode: 1, stdout, stderr: stderr + String(err) }),
		);
	});
}

/**
 * Compute the absolute path where a Run Worktree should live for the given
 * (questId, runId). Pure path arithmetic — does not touch disk.
 */
export function worktreePathFor(repoRoot: string, questId: string, runId: string): string {
	return path.join(repoRoot, ".pi", "quests", questId, "worktrees", runId);
}

/**
 * Resolve the SHA of `HEAD` in `repoRoot`. Rejects on git failure.
 */
export async function getHeadSha(repoRoot: string): Promise<string> {
	const result = await runGit(["rev-parse", "HEAD"], repoRoot);
	if (result.exitCode !== 0) {
		throw new Error(`git rev-parse HEAD failed in ${repoRoot}: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

/**
 * Create the Quest Branch `quest/<questId>` from `baseSha` if it doesn't
 * already exist. Idempotent — a second call with the same args is a no-op.
 */
export async function ensureQuestBranch(options: {
	repoRoot: string;
	questId: string;
	baseSha: string;
}): Promise<{ questBranch: string; created: boolean }> {
	const questBranch = `quest/${options.questId}`;
	const ref = `refs/heads/${questBranch}`;
	const probe = await runGit(["show-ref", "--verify", "--quiet", ref], options.repoRoot);
	if (probe.exitCode === 0) {
		return { questBranch, created: false };
	}
	const create = await runGit(["branch", questBranch, options.baseSha], options.repoRoot);
	if (create.exitCode !== 0) {
		throw new Error(
			`git branch ${questBranch} ${options.baseSha} failed: ${create.stderr.trim()}`,
		);
	}
	return { questBranch, created: true };
}

/**
 * Create a Run Worktree for `(questId, runId)` checked out to a fresh
 * `quest-run/<questId>/<runId>` branch, based on `questBranch` (or falling back
 * to `baseSha` if the Quest Branch has not been created yet).
 */
export async function createRunWorktree(options: {
	repoRoot: string;
	questId: string;
	runId: string;
	baseSha: string;
	questBranch: string;
}): Promise<{ worktreePath: string; runBranch: string }> {
	const worktreePath = worktreePathFor(options.repoRoot, options.questId, options.runId);
	const runBranch = `quest-run/${options.questId}/${options.runId}`;
	// `git worktree add -b <branch> <path> <committish>` creates the branch
	// from <committish> and checks it out into <path> in a single step.
	const result = await runGit(
		["worktree", "add", "-b", runBranch, worktreePath, options.questBranch],
		options.repoRoot,
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	return { worktreePath, runBranch };
}

/**
 * Remove a Run Worktree. Tolerates missing/already-removed worktrees — the
 * caller (e.g. the reaper) wants idempotency on best-effort cleanup paths.
 *
 * The git invocation runs in the **main checkout** (`repoRoot`). When
 * `repoRoot` isn't supplied, we infer it from the canonical layout
 * `<repoRoot>/.pi/quests/<questId>/worktrees/<runId>`.
 */
export async function removeRunWorktree(worktreePath: string, repoRoot?: string): Promise<void> {
	const cwd =
		repoRoot ??
		// Walk up `worktrees → quests → .pi → repoRoot`.
		path.dirname(path.dirname(path.dirname(path.dirname(worktreePath))));
	// `--force` even when the worktree is "locked" or has dirty state. The Run
	// finished (or was orphaned); we don't preserve in-progress state here.
	const result = await runGit(["worktree", "remove", "--force", worktreePath], cwd);
	if (result.exitCode !== 0) {
		// Silently tolerate "not a working tree" / "no such" cases — best-effort.
		return;
	}
}

/**
 * List all worktrees registered with the repo by parsing `git worktree list --porcelain`.
 * Returns `[]` when git fails.
 */
export async function listRunWorktrees(
	repoRoot: string,
): Promise<Array<{ path: string; branch: string }>> {
	const result = await runGit(["worktree", "list", "--porcelain"], repoRoot);
	if (result.exitCode !== 0) return [];
	// Porcelain format: blocks separated by blank lines; each block has lines
	// like `worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>\n`.
	const entries: Array<{ path: string; branch: string }> = [];
	const blocks = result.stdout.split(/\n\n+/);
	for (const block of blocks) {
		if (!block.trim()) continue;
		let p: string | undefined;
		let branch: string | undefined;
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) p = line.slice("worktree ".length).trim();
			else if (line.startsWith("branch ")) {
				const ref = line.slice("branch ".length).trim();
				branch = ref.replace(/^refs\/heads\//, "");
			}
		}
		if (p && branch) entries.push({ path: p, branch });
	}
	return entries;
}

/**
 * Merge `runBranch` into `questBranch`. Uses a throwaway worktree of
 * `questBranch` (under `os.tmpdir()`) so we never touch the user's checkout.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, conflict }` on merge
 * failure. The throwaway worktree is removed in both cases.
 */
export async function mergeRunBranchIntoQuest(options: {
	repoRoot: string;
	questBranch: string;
	runBranch: string;
}): Promise<{ ok: boolean; conflict?: string }> {
	// Throwaway worktree path: os.tmpdir/pi-quest-merge-<runBranch sanitized>-<rand>
	const safe = options.runBranch.replace(/[^a-zA-Z0-9_.-]+/g, "-");
	const mergeWorktreePath = path.join(
		os.tmpdir(),
		`pi-quest-merge-${safe}-${Math.random().toString(36).slice(2, 8)}`,
	);

	const addResult = await runGit(
		["worktree", "add", mergeWorktreePath, options.questBranch],
		options.repoRoot,
	);
	if (addResult.exitCode !== 0) {
		return {
			ok: false,
			conflict: `failed to create merge worktree: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
		};
	}

	try {
		const mergeResult = await runGit(
			["merge", "--no-ff", options.runBranch],
			mergeWorktreePath,
		);
		if (mergeResult.exitCode !== 0) {
			const conflict = (mergeResult.stderr || mergeResult.stdout).trim();
			// Try to abort the merge so the throwaway worktree can be removed
			// cleanly. Best-effort; ignore failure.
			await runGit(["merge", "--abort"], mergeWorktreePath);
			return { ok: false, conflict };
		}
		return { ok: true };
	} finally {
		// Throwaway: always remove. Best-effort.
		await runGit(["worktree", "remove", "--force", mergeWorktreePath], options.repoRoot);
	}
}
