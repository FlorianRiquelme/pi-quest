/**
 * Path resolution for quest workspaces.
 *
 * Subagents run inside Run Worktrees where `.pi/` does not exist (ADR 011 §5).
 * For shell commands the subagent runs inside its worktree, the parent
 * propagates the absolute path to the main checkout's `.pi/` via the
 * `PI_QUEST_HOME` env var (injected on spawn).
 *
 * `resolvePiHome` is the single entry point: it prefers `PI_QUEST_HOME` if
 * set, otherwise walks **up** from the provided cwd until it finds a `.pi/`
 * directory. The walk-up result is cached per starting cwd so repeated calls
 * from inside the same subagent worktree are cheap.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_QUEST_CONFIG } from "../lib.js";

export const EXTENSION_DIR = __dirname;
export const AGENTS_DIR = path.join(EXTENSION_DIR, "..", "agents");

export function getQuestsDir(cwd: string) {
	return path.join(cwd, DEFAULT_QUEST_CONFIG.workspace.root);
}

export function getStatePath(cwd: string) {
	return path.join(cwd, DEFAULT_QUEST_CONFIG.workspace.statePath);
}

export function questDirPath(cwd: string, questId: string) {
	return path.join(getQuestsDir(cwd), questId);
}

/* ============================ PI_QUEST_HOME resolution ============================ */

const walkUpCache = new Map<string, string | undefined>();

/**
 * Reset the walk-up cache. Used by tests so they can model freshly-started
 * processes without leaking state between cases.
 */
export function clearPiHomeCache(): void {
	walkUpCache.clear();
}

/**
 * Resolve the absolute path to the main checkout's `.pi/` directory.
 *
 * Order:
 *   1. `process.env.PI_QUEST_HOME` if set (injected by the parent into
 *      subagent spawns per ADR 011 §5).
 *   2. Walk up from `cwd` until a `.pi/` directory is found; cache the result.
 *   3. `undefined` if no `.pi/` exists in any ancestor.
 *
 * The env var is consulted on every call so that updates between calls take
 * effect immediately; only the walk-up branch is memoized.
 */
export function resolvePiHome(cwd: string): string | undefined {
	const envHome = process.env.PI_QUEST_HOME;
	if (envHome && envHome.trim()) return envHome.trim();

	if (walkUpCache.has(cwd)) return walkUpCache.get(cwd);

	let current = path.resolve(cwd);
	const root = path.parse(current).root;
	while (true) {
		const candidate = path.join(current, ".pi");
		if (fs.existsSync(candidate)) {
			walkUpCache.set(cwd, candidate);
			return candidate;
		}
		if (current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	walkUpCache.set(cwd, undefined);
	return undefined;
}
