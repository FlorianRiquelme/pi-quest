/**
 * Run-lifecycle types — `BackgroundRunSummary`, `RunStatus`, and the
 * `STATUS_RANK` precedence lattice that disambiguates concurrent terminal-
 * status writes (issue #13 secondary race).
 *
 * The lattice is `paused > cancelled > failed > completed > running`. `orphaned`
 * sits outside the lattice — once reaped at `session_start` it is sealed and
 * cannot be overwritten by any later write except by an explicit `running`
 * arrival (which the orphan reaper itself never produces). Treating `orphaned`
 * as terminal-and-immutable is the safe default; the reaper is the only writer
 * that flips a stale `running` to `orphaned`.
 */

export type RunStatus =
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "orphaned"
	| "paused";

export interface BackgroundRunSummary {
	runId: string;
	questId: string;
	workItemId: string;
	agentName: string;
	status: RunStatus;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	exitCode?: number;
	pid?: number;
	model?: string;
	stdoutPath: string;
	stderrPath: string;
	reportPath: string;
	statusPath: string;
	/** Path to the Run Worktree where this run executed (ADR 011). */
	worktreePath?: string;
	/** Run Branch ref (e.g. `quest-run/<questId>/<runId>`). */
	runBranch?: string;
	/** Quest Branch this run targets (e.g. `quest/<questId>`). */
	questBranch?: string;
	/** ADR 014: when the supervisor SIGTERM'd this run on a pause-tier anomaly. */
	paused_at?: string;
	/** ADR 014: which pause-tier rule fired (post-2026-05-22 amendment). */
	paused_reason?: "unbounded_diff" | "heartbeat_missed";
	/**
	 * ADR 017: when this run was spawned by Resume, the runId of its **immediate**
	 * predecessor (the just-paused Run). Multi-Resume chains follow this back
	 * one hop at a time, not back to the original.
	 */
	continues_from?: string;
	/** ADR 018: Orchestrator-assigned grouping ID for the Batch this Run belongs to. */
	batchId?: string;
	/** ADR 018: declared total number of Runs in the Batch (≥ 1). */
	batchSize?: number;
}

/**
 * Precedence lattice for terminal-status writes. Higher number wins.
 *
 * Rationale: the supervisor's `pauseRun` path writes `paused`, then the
 * runner's `close` handler fires with `cancelled` (because the SIGTERM signal
 * is what closed the child). Without an arbiter, the second write clobbers
 * `paused` to `cancelled` and the user's Discard / Force-Complete / Resume
 * flow operates on the wrong state.
 */
export const STATUS_RANK: Record<RunStatus, number> = {
	paused: 4,
	cancelled: 3,
	failed: 2,
	completed: 1,
	running: 0,
	orphaned: 0,
};

/**
 * Decide whether `proposed` should be written over `current`.
 *
 * - `orphaned` is treated as sealed (outside the lattice): once orphaned, no
 *   later write may overwrite. The orphan reaper itself only promotes
 *   `running → orphaned`, never the reverse.
 * - `proposed === "orphaned"` is only legal when `current === "running"` (the
 *   reaper's contract).
 * - For every other pair, the higher `STATUS_RANK` wins. Equal ranks do not
 *   overwrite (idempotent / no churn).
 */
export function shouldOverwriteStatus(
	current: RunStatus,
	proposed: RunStatus,
): boolean {
	if (current === "orphaned") return false;
	if (proposed === "orphaned") return current === "running";
	return STATUS_RANK[proposed] > STATUS_RANK[current];
}
