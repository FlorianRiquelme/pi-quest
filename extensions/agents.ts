/**
 * Agent definition parsing, model resolution, and subagent execution.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { generateTimestampId } from "../lib.js";
import {
	appendCappedTail,
	ensureDir,
	getPiInvocation,
	MAX_SUBAGENT_CAPTURE_CHARS,
	readJsonIfExists,
	writeJson,
} from "./fs-utils.js";
import { validateEvent } from "./events.js";
import { AGENTS_DIR } from "./paths.js";
import {
	createRunWorktree,
	listRunWorktrees,
	mergeRunBranchIntoQuest,
	removeRunWorktree,
	worktreePathFor,
} from "./worktree.js";
import type { AgentDef, BackgroundRunSummary } from "./types.js";

export const MODEL_ALIASES: Record<string, string> = {
	"kimi-2.6": "openrouter/moonshotai/kimi-k2.6",
	"kimi-k2.6": "openrouter/moonshotai/kimi-k2.6",
	"moonshotai/kimi-k2.6": "openrouter/moonshotai/kimi-k2.6",
};

export function normalizeModel(model: string | undefined): string | undefined {
	const trimmed = model?.trim();
	if (!trimmed) return undefined;
	return MODEL_ALIASES[trimmed] ?? trimmed;
}

export function parseAgentDef(filePath: string): AgentDef | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const content = fs.readFileSync(filePath, "utf-8");
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!fmMatch) return undefined;
	const fm: Record<string, string> = {};
	for (const line of fmMatch[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	if (!fm.name || !fm.description) return undefined;
	return {
		name: fm.name,
		description: fm.description,
		tools: fm.tools,
		model: fm.model,
		systemPrompt: fmMatch[2].trim(),
	};
}

export function getAgentDef(name: string): AgentDef | undefined {
	const direct = parseAgentDef(path.join(AGENTS_DIR, `${name}.md`));
	if (direct) return direct;

	if (!fs.existsSync(AGENTS_DIR)) return undefined;
	for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const agent = parseAgentDef(path.join(AGENTS_DIR, entry.name));
		if (agent?.name === name) return agent;
	}

	return undefined;
}

export async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-quest-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

/**
 * Detect the project's package manager from the lockfile in `repoRoot`, with
 * the priority order defined in ADR 011 §6.
 *
 *   pnpm-lock.yaml   → pnpm
 *   bun.lock         → bun
 *   yarn.lock        → yarn
 *   package-lock.json → npm
 *   (none)           → undefined (no install command)
 */
export function detectPackageManager(repoRoot: string): "pnpm" | "bun" | "yarn" | "npm" | undefined {
	if (fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
	if (fs.existsSync(path.join(repoRoot, "bun.lock"))) return "bun";
	if (fs.existsSync(path.join(repoRoot, "yarn.lock"))) return "yarn";
	if (fs.existsSync(path.join(repoRoot, "package-lock.json"))) return "npm";
	return undefined;
}

/**
 * Run `<pm> install` inside `worktreePath`. Resolves with the exit code.
 * Errors during spawn surface as exit code 1.
 */
function runInstallInWorktree(
	pm: "pnpm" | "bun" | "yarn" | "npm",
	worktreePath: string,
): Promise<number> {
	return new Promise((resolve) => {
		const proc = spawn(pm, ["install"], {
			cwd: worktreePath,
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.on("close", (code) => resolve(code ?? 0));
		proc.on("error", () => resolve(1));
	});
}

export async function runSubagent(options: {
	cwd: string;
	agentName: string;
	task: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	signal?: AbortSignal;
}): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}> {
	const agentDef = getAgentDef(options.agentName);
	const basePrompt = options.systemPrompt ?? agentDef?.systemPrompt ?? "";
	const model = normalizeModel(options.model ?? agentDef?.model);
	const tools = options.tools ?? (agentDef?.tools ? agentDef.tools.split(/,\s*/) : undefined);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	try {
		if (basePrompt.trim()) {
			const tmp = await writePromptToTempFile(options.agentName, basePrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${options.task}`);

		const invocation = getPiInvocation(args);
		return new Promise((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let stdoutTruncated = false;
			let stderrTruncated = false;

			proc.stdout.on("data", (d) => {
				const next = appendCappedTail(stdout, d);
				stdout = next.value;
				stdoutTruncated ||= next.truncated;
			});
			proc.stderr.on("data", (d) => {
				const next = appendCappedTail(stderr, d);
				stderr = next.value;
				stderrTruncated ||= next.truncated;
			});

			proc.on("close", (code) =>
				resolve({ exitCode: code ?? 0, stdout, stderr, stdoutTruncated, stderrTruncated }),
			);
			proc.on("error", () =>
				resolve({ exitCode: 1, stdout, stderr, stdoutTruncated, stderrTruncated }),
			);

			if (options.signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}
		});
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}

export const activeRuns = new Map<string, BackgroundRunSummary>();

/**
 * In-memory map of `runId → epoch-ms-of-last-progress-beat`. Updated by both
 * the explicit `quest_progress_beat` tool (via {@link recordSemanticBeat}) and
 * by {@link emitSyntheticLivenessBeats}. Read by the synthetic liveness loop
 * to decide whether the 60s window has elapsed since the last beat.
 *
 * Exported only for tests.
 */
export const __lastBeatAtForTests = new Map<string, number>();

/** Rate-limit window for explicit progress beats. */
export const PROGRESS_BEAT_RATE_LIMIT_MS = 15_000;

/** Synthetic liveness interval — every {@link LIVENESS_BEAT_INTERVAL_MS}, the supervisor checks each running run. */
export const LIVENESS_BEAT_INTERVAL_MS = 60_000;

/**
 * Record that a semantic `progress_beat` has been emitted for `runId` at `nowMs`.
 *
 * Updates the in-memory last-beat map so the synthetic liveness loop and the
 * rate-limiter both see the new timestamp.
 */
export function recordSemanticBeat(runId: string, nowMs: number): void {
	__lastBeatAtForTests.set(runId, nowMs);
}

export function writeRunSummary(summary: BackgroundRunSummary) {
	writeJson(summary.statusPath, summary);
}

export function readRunSummary(questDir: string, runId: string): BackgroundRunSummary | undefined {
	return readJsonIfExists<BackgroundRunSummary>(path.join(questDir, "runs", `${runId}.json`));
}

export function listRunSummaries(questDir: string): BackgroundRunSummary[] {
	const runsDir = path.join(questDir, "runs");
	if (!fs.existsSync(runsDir)) return [];
	return fs
		.readdirSync(runsDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readJsonIfExists<BackgroundRunSummary>(path.join(runsDir, name)))
		.filter((summary): summary is BackgroundRunSummary => Boolean(summary))
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function compactRunLine(summary: BackgroundRunSummary): string {
	const code = summary.exitCode === undefined ? "" : ` exit=${summary.exitCode}`;
	return `${summary.runId} ${summary.status}${code} • work-item ${summary.workItemId} • report ${summary.reportPath}`;
}

/**
 * Append a `run_finished` event (per ADR 010) to a quest's audit log.
 *
 * Variant-required fields (`runId`, `workItemId`) live at the top level; the
 * legacy free-form payload (`status`, `exitCode`, `model`, `rescueUsed`,
 * `agentRole`) is captured in the open `details` slot so future readers can
 * mine it without re-typing the union.
 */
export function recordRunFinished(options: {
	questDir: string;
	questId: string;
	runId: string;
	workItemId: string;
	model: string;
	status: BackgroundRunSummary["status"];
	exitCode?: number;
	rescueUsed?: boolean;
	agentRole?: string;
}): void {
	const telemetryPath = path.join(options.questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	const event = validateEvent({
		event: "run_finished",
		timestamp: new Date().toISOString(),
		questId: options.questId,
		runId: options.runId,
		workItemId: options.workItemId,
		details: {
			agentRole: options.agentRole ?? "implementation",
			model: options.model,
			status: options.status,
			exitCode: options.exitCode,
			rescueUsed: options.rescueUsed ?? false,
		},
	});
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
}

export async function startSubagentRun(options: {
	cwd: string;
	questId: string;
	questDir: string;
	workItemId: string;
	agentName: string;
	task: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	/**
	 * Quest Branch ref name (e.g. `quest/<questId>`). When provided, the new
	 * Run Worktree is checked out from this branch; on completion, the Run
	 * Branch is merged back into it. Defaults to `quest/<questId>`.
	 */
	questBranch?: string;
	/** Base SHA the Quest forked from. Passed through to `createRunWorktree`. */
	baseSha?: string;
	onStatus?: (summary: BackgroundRunSummary) => void;
}): Promise<BackgroundRunSummary> {
	// M3-2: soft-freeze guard. While a soft freeze is active on the quest,
	// in-flight runs continue but no new runs may spawn. The chord handler
	// (Alt+P, or `/quest unfreeze` as a fallback) is the only way to clear the
	// freeze. Reading the workflow is cheap; we avoid importing the freeze
	// module to keep the dependency one-way.
	const wf = readJsonIfExists<{ freeze?: { mode?: string } }>(
		path.join(options.questDir, "workflow.json"),
	);
	if (wf?.freeze?.mode === "soft") {
		throw new Error(
			`Soft freeze is active for quest ${options.questId}; new runs are blocked. Press Alt+P (or run /quest unfreeze) to release.`,
		);
	}

	const agentDef = getAgentDef(options.agentName);
	const basePrompt = options.systemPrompt ?? agentDef?.systemPrompt ?? "";
	const model = normalizeModel(options.model ?? agentDef?.model);
	const tools = options.tools ?? (agentDef?.tools ? agentDef.tools.split(/,\s*/) : undefined);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	if (basePrompt.trim()) {
		const tmp = await writePromptToTempFile(options.agentName, basePrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
	}
	args.push(`Task: ${options.task}`);

	ensureDir(path.join(options.questDir, "runs"));
	ensureDir(path.join(options.questDir, "reports"));
	const safeWorkItemId = options.workItemId.replace(/[^a-zA-Z0-9_.-]+/g, "-");
	const runId = `${safeWorkItemId}-${generateTimestampId()}`;
	const stdoutPath = path.join(options.questDir, "runs", `${runId}.stdout.log`);
	const stderrPath = path.join(options.questDir, "runs", `${runId}.stderr.log`);
	const statusPath = path.join(options.questDir, "runs", `${runId}.json`);
	const reportPath = path.join(options.questDir, "reports", `${options.workItemId}.md`);
	const startedAt = new Date().toISOString();
	const invocation = getPiInvocation(args);

	// Per ADR 011: create a Run Worktree before spawning. The subagent runs
	// inside the worktree on its own Run Branch. `options.questBranch` falls
	// back to `quest/<questId>` for callers that have not yet captured the
	// Quest Branch onto workflow.json (defence-in-depth — the executing-status
	// hook owns first-time capture).
	const questBranch = options.questBranch ?? `quest/${options.questId}`;
	const worktreeResult = await createRunWorktree({
		repoRoot: options.cwd,
		questId: options.questId,
		runId,
		baseSha: options.baseSha ?? "HEAD",
		questBranch,
	});
	const worktreePath = worktreeResult.worktreePath;

	// Detect package manager from the **main checkout** and run the matching
	// install command **inside the worktree** before the subagent starts.
	const pm = detectPackageManager(options.cwd);
	if (pm) {
		const installExit = await runInstallInWorktree(pm, worktreePath);
		if (installExit !== 0) {
			// Best-effort anomaly log and abort — caller sees a failed install
			// and can investigate.
			try {
				const telemetryPath = path.join(options.questDir, "telemetry", "events.jsonl");
				ensureDir(path.dirname(telemetryPath));
				const event = validateEvent({
					event: "anomaly_detected",
					timestamp: new Date().toISOString(),
					questId: options.questId,
					tier: "halt",
					rule: "install_failed",
					should_pause: false,
					details: { packageManager: pm, exitCode: installExit, worktreePath },
				});
				fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
			} catch {
				/* never let telemetry crash the spawn path */
			}
			throw new Error(`${pm} install in ${worktreePath} exited with code ${installExit}`);
		}
	}

	// Per ADR 009: subagents must survive parent exit. `detached: true` plus
	// `child.unref()` (below) detaches the child from the parent's process
	// group so closing pi doesn't SIGHUP all background runs.
	//
	// Per ADR 010 §3: inject PI_QUEST_* env vars so subagents can attribute
	// their explicit `quest_progress_beat` / `quest_concession` tool calls
	// without guessing. The tools also accept the IDs as explicit params
	// (Approach B) — env vars exist so the agent's prompt can read them out
	// of its own process environment.
	//
	// Per ADR 011 §5: inject PI_QUEST_HOME (absolute path to the main
	// checkout's `.pi/`) so tools running inside the worktree can resolve
	// quest state — the worktree has no `.pi/` of its own.
	const proc = spawn(invocation.command, invocation.args, {
		cwd: worktreePath,
		shell: false,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_QUEST_QUEST_ID: options.questId,
			PI_QUEST_WORK_ITEM_ID: options.workItemId,
			PI_QUEST_RUN_ID: runId,
			PI_QUEST_HOME: path.join(options.cwd, ".pi"),
		},
	});
	// Detach from the parent's event loop — closing pi while detached runs
	// continue will not block, and the parent's `process.exit()` doesn't wait
	// on us. Re-attachment for reaping happens at the next pi startup.
	proc.unref();

	const summary: BackgroundRunSummary = {
		runId,
		questId: options.questId,
		workItemId: options.workItemId,
		agentName: options.agentName,
		status: "running",
		startedAt,
		updatedAt: startedAt,
		pid: proc.pid,
		model: model ?? "default",
		stdoutPath,
		stderrPath,
		reportPath,
		statusPath,
		worktreePath,
		runBranch: worktreeResult.runBranch,
		questBranch,
	};
	activeRuns.set(runId, summary);
	writeRunSummary(summary);
	options.onStatus?.(summary);

	proc.stdout.on("data", (d) => fs.appendFileSync(stdoutPath, d));
	proc.stderr.on("data", (d) => fs.appendFileSync(stderrPath, d));

	let finalized = false;
	const finalize = (status: BackgroundRunSummary["status"], exitCode?: number) => {
		if (finalized) return;
		finalized = true;
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
		const completedAt = new Date().toISOString();
		summary.status = status;
		summary.exitCode = exitCode;
		summary.completedAt = completedAt;
		summary.updatedAt = completedAt;
		activeRuns.delete(runId);
		writeRunSummary(summary);
		recordRunFinished({
			questDir: options.questDir,
			questId: options.questId,
			runId,
			workItemId: options.workItemId,
			model: model ?? "default",
			status,
			exitCode,
			rescueUsed: false,
			agentRole: "implementation",
		});
		options.onStatus?.(summary);

		// ADR 011 §4: on Run completion, merge Run Branch into Quest Branch.
		// Failure → halt-tier anomaly; other runs proceed independently. Fire
		// and forget: finalize is a sync close handler, but the merge work is
		// async. Errors are caught inside `mergeCompletedRun`.
		if (status === "completed" && summary.runBranch && summary.questBranch) {
			void mergeCompletedRun({
				repoRoot: options.cwd,
				questDir: options.questDir,
				questId: options.questId,
				runId,
				workItemId: options.workItemId,
				runBranch: summary.runBranch,
				questBranch: summary.questBranch,
				worktreePath,
			});
		}
	};

	proc.on("close", (code, signal) => {
		if (signal) finalize("cancelled", code ?? undefined);
		else finalize(code === 0 ? "completed" : "failed", code ?? 1);
	});
	proc.on("error", () => finalize("failed", 1));

	return summary;
}

/* ================================ Merge on completion (ADR 011 §4) ================================ */

/**
 * Merge a completed Run's Run Branch into the Quest Branch.
 *
 * On success: the Run Worktree is removed (best-effort).
 * On failure (merge conflict): emit `anomaly_detected` with
 * `tier: "halt"`, `rule: "merge_conflict"`. The Run's status is flipped to
 * `failed` so the user can see which run blocked. Other runs' merges proceed
 * independently — this function is single-Run scoped.
 */
export async function mergeCompletedRun(options: {
	repoRoot: string;
	questDir: string;
	questId: string;
	runId: string;
	workItemId: string;
	runBranch: string;
	questBranch: string;
	worktreePath: string;
}): Promise<void> {
	let result: { ok: boolean; conflict?: string };
	try {
		result = await mergeRunBranchIntoQuest({
			repoRoot: options.repoRoot,
			questBranch: options.questBranch,
			runBranch: options.runBranch,
		});
	} catch (err) {
		result = { ok: false, conflict: err instanceof Error ? err.message : String(err) };
	}

	if (result.ok) {
		// Tidy up: remove the worktree now that its work has landed.
		try {
			await removeRunWorktree(options.worktreePath);
		} catch {
			/* best-effort */
		}
		return;
	}

	// Merge failed → halt-tier anomaly.
	const telemetryPath = path.join(options.questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	const event = validateEvent({
		event: "anomaly_detected",
		timestamp: new Date().toISOString(),
		questId: options.questId,
		runId: options.runId,
		tier: "halt",
		rule: "merge_conflict",
		should_pause: false,
		details: {
			workItemId: options.workItemId,
			runBranch: options.runBranch,
			questBranch: options.questBranch,
			conflict: result.conflict ?? "",
		},
	});
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");

	// Flip the run's status to "failed" so the dashboard surfaces it.
	const summary = readRunSummary(options.questDir, options.runId);
	if (summary) {
		const completedAt = new Date().toISOString();
		const updated: BackgroundRunSummary = {
			...summary,
			status: "failed",
			completedAt: summary.completedAt ?? completedAt,
			updatedAt: completedAt,
		};
		writeRunSummary(updated);
	}
}

/* ================================ Startup reaper (ADR 009) ================================ */

/**
 * Return `true` if `pid` is currently reachable, `false` if it isn't.
 *
 * Wraps `process.kill(pid, 0)` to translate the POSIX errno into a boolean:
 *   - success → alive
 *   - `ESRCH` → no such process → dead
 *   - `EPERM` → process exists but we lack permission → treat as alive
 *   - any other error → conservatively treat as alive (don't reap on bugs)
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		return true;
	}
}

/**
 * Scan every quest's `runs/*.json` for `status: "running"` entries whose PID is
 * no longer alive. Promote each to `"orphaned"`, write the summary back, and
 * append a `run_orphaned` event to that quest's `telemetry/events.jsonl`.
 *
 * Per ADR 009: this is the startup reconciliation pass that recovers state the
 * parent process lost when it died. Run once on extension `session_start`; the
 * supervisor takes over polling for the rest of the session.
 *
 * Returns the list of run IDs that were reaped (for testing / observability).
 */
export function reapOrphanedRuns(cwd: string): string[] {
	const reaped: string[] = [];
	const questsDir = path.join(cwd, ".pi", "quests");
	if (!fs.existsSync(questsDir)) return reaped;

	const questIds = fs
		.readdirSync(questsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const questId of questIds) {
		const questDir = path.join(questsDir, questId);
		const runsDir = path.join(questDir, "runs");
		if (!fs.existsSync(runsDir)) continue;

		for (const entry of fs.readdirSync(runsDir)) {
			if (!entry.endsWith(".json")) continue;
			const statusPath = path.join(runsDir, entry);
			const summary = readJsonIfExists<BackgroundRunSummary>(statusPath);
			if (!summary || summary.status !== "running") continue;
			if (typeof summary.pid !== "number" || isPidAlive(summary.pid)) continue;

			const completedAt = new Date().toISOString();
			const updated: BackgroundRunSummary = {
				...summary,
				status: "orphaned",
				completedAt,
				updatedAt: completedAt,
			};
			writeRunSummary(updated);

			const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
			ensureDir(path.dirname(telemetryPath));
			const event = validateEvent({
				event: "run_orphaned",
				timestamp: completedAt,
				questId: summary.questId,
				runId: summary.runId,
				workItemId: summary.workItemId,
				details: {
					pid: summary.pid,
					model: summary.model,
					agentName: summary.agentName,
				},
			});
			fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");

			reaped.push(summary.runId);
		}
	}

	return reaped;
}

/* ================================ Worktree reaper (ADR 011) ================================ */

/**
 * Match a worktree path of the form `.../pi/quests/<questId>/worktrees/<runId>`
 * and return `{ questId, runId }`, or `undefined` if the path is the main
 * checkout or some other worktree we don't own.
 */
function parseRunWorktreePath(p: string): { questId: string; runId: string } | undefined {
	// We rely on the path layout we own; segments after `quests/<id>/worktrees`.
	const norm = p.replace(/\\/g, "/");
	const m = norm.match(/\/\.pi\/quests\/([^/]+)\/worktrees\/([^/]+)\/?$/);
	if (!m) return undefined;
	return { questId: m[1], runId: m[2] };
}

/**
 * Prune orphan Run Worktrees on startup.
 *
 * Policy (commented per the M1-3 spec): a worktree is an orphan when the run
 * it represents is no longer live. Concretely we remove a worktree when:
 *   - the `runs/<runId>.json` summary is missing, OR
 *   - the summary's status is `orphaned`, `cancelled`, `failed`, or `completed`.
 *
 * Paused runs (ADR 014) keep their worktree — Resume (M4-4) and the dashboard
 * Discard/Force-Complete actions need the worktree intact.
 *
 * Running runs are kept (their work is in flight). The main-checkout worktree
 * — anything that does not match the `.pi/quests/<id>/worktrees/<runId>`
 * layout — is ignored unconditionally.
 *
 * Returns the list of worktree paths that were actually removed (best-effort
 * — git `worktree remove` may fail silently for already-gone paths).
 */
export async function reapOrphanWorktrees(cwd: string): Promise<string[]> {
	const pruned: string[] = [];
	const worktrees = await listRunWorktrees(cwd);
	for (const wt of worktrees) {
		const parsed = parseRunWorktreePath(wt.path);
		if (!parsed) continue; // main checkout / non-quest worktree
		const summaryPath = path.join(
			cwd,
			".pi",
			"quests",
			parsed.questId,
			"runs",
			`${parsed.runId}.json`,
		);
		const summary = readJsonIfExists<BackgroundRunSummary>(summaryPath);
		const shouldPrune =
			!summary ||
			summary.status === "orphaned" ||
			summary.status === "cancelled" ||
			summary.status === "failed" ||
			summary.status === "completed";
		if (!shouldPrune) continue;
		try {
			await removeRunWorktree(wt.path);
		} catch {
			/* best-effort */
		}
		pruned.push(wt.path);
	}
	return pruned;
}

/* ================================ Synthetic liveness loop (ADR 010 §3) ================================ */

/**
 * Walk the running runs (from `activeRuns` and `runs/*.json`) and, for each,
 * emit a synthetic `progress_beat` with `phase: "alive"` when:
 *   - the PID is still alive (`process.kill(pid, 0)` succeeds), AND
 *   - no beat (semantic or synthetic) has been recorded in the last
 *     {@link LIVENESS_BEAT_INTERVAL_MS}.
 *
 * Per ADR 010 §3 ("Hybrid emission"), the synthetic beat is the heartbeat
 * floor that survives long shell commands; an explicit-beat silence with a
 * live PID is itself a signal that Auto-Pause-on-Anomaly can detect later.
 *
 * `now` is injectable for tests. The default uses `Date.now()`.
 */
export function emitSyntheticLivenessBeats(options: {
	cwd: string;
	now?: () => number;
}): void {
	const now = options.now ?? (() => Date.now());
	const nowMs = now();

	const questsDir = path.join(options.cwd, ".pi", "quests");
	if (!fs.existsSync(questsDir)) return;

	const questIds = fs
		.readdirSync(questsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const questId of questIds) {
		const questDir = path.join(questsDir, questId);
		const runsDir = path.join(questDir, "runs");
		if (!fs.existsSync(runsDir)) continue;

		for (const entry of fs.readdirSync(runsDir)) {
			if (!entry.endsWith(".json")) continue;
			const summary = readJsonIfExists<BackgroundRunSummary>(path.join(runsDir, entry));
			if (!summary || summary.status !== "running") continue;
			if (typeof summary.pid !== "number" || !isPidAlive(summary.pid)) continue;

			const last = __lastBeatAtForTests.get(summary.runId);
			if (last !== undefined && nowMs - last < LIVENESS_BEAT_INTERVAL_MS) continue;

			const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
			ensureDir(path.dirname(telemetryPath));
			const event = validateEvent({
				event: "progress_beat",
				timestamp: new Date(nowMs).toISOString(),
				questId: summary.questId,
				runId: summary.runId,
				phase: "alive",
			});
			fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
			__lastBeatAtForTests.set(summary.runId, nowMs);
		}
	}
}

/**
 * Start the in-process supervisor: a 60s `setInterval` that calls
 * {@link emitSyntheticLivenessBeats}.
 *
 * The returned handle is `unref`ed so it doesn't keep the parent process
 * alive — pi can exit cleanly even with the interval armed.
 */
export function startLivenessSupervisor(cwd: string): NodeJS.Timeout {
	const handle = setInterval(() => {
		try {
			emitSyntheticLivenessBeats({ cwd });
		} catch {
			/* never let the supervisor crash the host process */
		}
	}, LIVENESS_BEAT_INTERVAL_MS);
	handle.unref?.();
	return handle;
}
