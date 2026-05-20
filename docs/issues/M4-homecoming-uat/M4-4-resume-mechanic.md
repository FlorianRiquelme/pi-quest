# M4-4 — Resume mechanic for Paused Runs

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Implement Resume per ADR 017. A Resume creates a **new Run** with a fresh `runId` and `status: running`, gaining a new field `continues_from: <paused_runId>`. It executes in the **same worktree** as the paused Run, on the **same Run Branch** — commits append linearly. The paused Run stays in `runs/<paused_runId>.json` as immutable audit. Multiple Resumes chain (each new Run's `continues_from` points to its immediate predecessor).

Compose a 5-section continuation packet at Resume time (template-driven; no extra subagent for composition):

1. **Identity** — quest ID, work-item ID, paused run ID
2. **Anomaly + user acknowledgment** — the rule that paused, its details, the acknowledgment text the user supplied
3. **Last 5 progress beats** from the paused Run
4. **Last report content** (from `reports/<workItemId>.md`, if it exists)
5. **Current worktree state** — branch, last commit, diff summary, untracked files

The packet is appended to the subagent's task prompt.

**Acknowledgment is required.** The trigger UI (Dashboard buttons + `/quest resume <runId>` CLI) prompts the user for free-form text. Empty defaults to `"User chose to resume without comment"`. The acknowledgment is embedded in the continuation packet so the resumed agent knows the anomaly is accepted and doesn't re-trip it immediately.

Dashboard updates: Paused Run rows show three equal-weight buttons — **Resume**, **Discard**, **Force-Complete** (the latter two already wired in M3-3). CLI command: `/quest resume <runId> [--note "..."]`.

New audit event: `run_resumed` with `new_run_id`, `continues_from: <paused_run_id>`, `acknowledgment: <text>`. Standard `run_started` fires immediately after for the new Run.

## Acceptance criteria

- [ ] Resume creates a new Run with new `runId`, `status: running`, `continues_from: <paused_runId>`
- [ ] New Run executes in the paused Run's worktree (same path) and on the same Run Branch
- [ ] Continuation packet is correctly assembled with all 5 sections
- [ ] User acknowledgment is required at trigger time (empty allowed with default)
- [ ] Dashboard Resume button opens the acknowledgment prompt and launches the new Run
- [ ] `/quest resume <runId> --note "..."` works equivalently from CLI
- [ ] `run_resumed` event has correct fields
- [ ] On the new Run finishing successfully, standard merge to Quest Branch proceeds
- [ ] Chaining works: a paused → resumed → paused-again → resumed-again sequence creates a correct chain of `continues_from` references
- [ ] Resume / Discard / Force-Complete buttons are visually equal-weight in the Dashboard

## Blocked by

M3-3.
