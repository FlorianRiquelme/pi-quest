/**
 * Closeout watcher (ADR 018).
 *
 * Watches `.pi/quests/*\/runs/` directories for changes to per-Run summary
 * JSON files. When a write fires, read the affected summary, identify its
 * `batchId`, and dispatch to `tryFireCloseout`. Un-batched legacy summaries
 * (no `batchId`) are ignored.
 *
 * Two implementations:
 *   - `fs.watch` (default) — kernel-backed, low latency.
 *   - Polling fallback when `fs.watch` throws `EMFILE`/`ENOSPC` — uses
 *     `setInterval` + `handle.unref()` so the watcher doesn't keep pi alive
 *     by itself (same pattern as `startAnomalyPoller`).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readJsonIfExists } from "../fs-utils.js";
import { tryFireCloseout } from "./closeout.js";
import type { BackgroundRunSummary } from "./types.js";

/** Polling fallback period when `fs.watch` is unavailable. */
export const CLOSEOUT_POLL_INTERVAL_MS = 5_000;

interface WatcherDeps {
	pi: Pick<ExtensionAPI, "sendMessage">;
	extensionStartTime: string;
	firedInProcess: Set<string>;
}

function questIdsUnder(cwd: string): string[] {
	const questsDir = path.join(cwd, ".pi", "quests");
	if (!fs.existsSync(questsDir)) return [];
	return fs
		.readdirSync(questsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}

function runsDirFor(cwd: string, questId: string): string {
	return path.join(cwd, ".pi", "quests", questId, "runs");
}

/**
 * Inspect a single `runs/<filename>.json` and, if it carries a `batchId`,
 * invoke `tryFireCloseout`. Best-effort: missing / corrupt files no-op.
 */
async function handleRunFile(
	cwd: string,
	questId: string,
	filename: string,
	deps: WatcherDeps,
): Promise<void> {
	if (!filename.endsWith(".json")) return;
	const summaryPath = path.join(runsDirFor(cwd, questId), filename);
	const summary = readJsonIfExists<BackgroundRunSummary>(summaryPath);
	if (!summary || typeof summary.batchId !== "string") return;
	try {
		await tryFireCloseout({
			cwd,
			questId,
			batchId: summary.batchId,
			pi: deps.pi,
			extensionStartTime: deps.extensionStartTime,
			firedInProcess: deps.firedInProcess,
		});
	} catch {
		/* never crash the watcher */
	}
}

/**
 * Scan every quest's runs directory once, dispatching any batched summary
 * through `tryFireCloseout`. Used both by the polling fallback (recurring) and
 * by the watcher's initial pass (catch summaries that completed before the
 * watcher armed).
 */
export async function scanAllOnce(cwd: string, deps: WatcherDeps): Promise<void> {
	const ids = questIdsUnder(cwd);
	for (const questId of ids) {
		const runsDir = runsDirFor(cwd, questId);
		if (!fs.existsSync(runsDir)) continue;
		const entries = fs.readdirSync(runsDir);
		for (const entry of entries) {
			await handleRunFile(cwd, questId, entry, deps);
		}
	}
}

/**
 * Start watching `.pi/quests/*\/runs/` for Closeout candidates.
 *
 * Returns a `stop` function the caller can invoke to release watchers /
 * intervals. The returned handle is `unref`ed where applicable so the watcher
 * never keeps pi alive on its own.
 *
 * Errors during `fs.watch` setup (EMFILE / ENOSPC) flip the implementation to
 * the polling fallback transparently.
 */
export function startCloseoutWatcher(
	cwd: string,
	pi: Pick<ExtensionAPI, "sendMessage">,
	extensionStartTime: string,
): () => void {
	const firedInProcess = new Set<string>();
	const deps: WatcherDeps = { pi, extensionStartTime, firedInProcess };
	const watchers: fs.FSWatcher[] = [];
	let pollHandle: NodeJS.Timeout | undefined;

	// Initial pass — catch any Runs that landed terminal status between the
	// extension's startup observations and now.
	void scanAllOnce(cwd, deps).catch(() => {
		/* never crash on initial pass */
	});

	const ids = questIdsUnder(cwd);
	let watchFailed = false;
	for (const questId of ids) {
		const runsDir = runsDirFor(cwd, questId);
		if (!fs.existsSync(runsDir)) continue;
		try {
			const w = fs.watch(runsDir, (_eventType, filename) => {
				if (!filename) return;
				void handleRunFile(cwd, questId, String(filename), deps);
			});
			w.unref?.();
			watchers.push(w);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EMFILE" || code === "ENOSPC") {
				watchFailed = true;
				break;
			}
			// Other errors: treat as unrecoverable for this dir, but keep going.
		}
	}

	if (watchFailed) {
		// Close any watchers we did manage to create, then fall back to polling.
		for (const w of watchers) {
			try {
				w.close();
			} catch {
				/* ignore */
			}
		}
		watchers.length = 0;
		pollHandle = setInterval(() => {
			void scanAllOnce(cwd, deps).catch(() => {
				/* never crash the polling loop */
			});
		}, CLOSEOUT_POLL_INTERVAL_MS);
		pollHandle.unref?.();
	}

	return () => {
		for (const w of watchers) {
			try {
				w.close();
			} catch {
				/* ignore */
			}
		}
		if (pollHandle) {
			clearInterval(pollHandle);
			pollHandle = undefined;
		}
	};
}
