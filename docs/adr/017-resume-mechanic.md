# ADR 017: Resume Mechanic for Paused Runs

## Status
Accepted

## Context

ADR 014 introduced **Paused Run** as the state of a Run SIGTERM'd by the supervisor in response to a pause-tier **Anomaly**. ADR 014 listed Resume as an M4 followup; this ADR locks the design.

## Decisions

### 1. Resume = new Run with continuation context, same worktree, same Run Branch

Each subagent invocation is already a fresh `pi --mode json -p --no-session` call (`agents.ts:101`). There's no in-process pause; Resume is "spawn a new agent with enough context to continue."

| Concept | Behavior on Resume |
|---|---|
| Paused Run | Immutable — stays `paused`; remains in `runs/<runId>.json` as audit |
| New Run | Fresh `runId`, `status: running`, new field `continues_from: <paused_runId>` |
| **Run Worktree** | **Same path**. Preserved per ADR 014. Continuation in-place. |
| Run Branch | **Same** branch (`quest-run/<questId>/<originalRunId>`). New agent commits append. |
| Quest Branch merge | Standard `git merge --no-ff` (ADR 011) when the new Run finishes |

Multiple Resumes chain — each new Run's `continues_from` points to the prior one.

### 2. Continuation packet — template-driven, five sections

Composed at Resume time from artifacts already on disk (no extra subagent for composition):

1. **Identity** — quest ID, work item ID, paused run ID
2. **Anomaly + user acknowledgment** — the rule, details, and the acknowledgment the user supplied
3. **Last 5 progress beats** from the paused Run
4. **Last report content** (from `reports/<workItemId>.md`, if exists)
5. **Current worktree state** — branch, last commit, diff summary, untracked files

### 3. User acknowledgment is required

When triggering Resume, the user must supply an acknowledgment (free-form text). Empty defaults to `"User chose to resume without comment"`.

The acknowledgment goes into the continuation packet so the resumed agent knows the anomaly is accepted. Without it, Resume becomes a loop where the same anomaly re-trips immediately.

### 4. Trigger UX

| Surface | Mechanism |
|---|---|
| Dashboard | Paused Run row → Resume / Discard / Force-Complete buttons. Resume opens an acknowledgment prompt. |
| CLI | `/quest resume <runId>` with `--note "..."` flag or interactive prompt. |

The three actions (Resume / Discard / Force-Complete) are presented with **equal weight** — different anomalies call for different resolutions; the UI doesn't recommend.

### 5. Two new events

Extending ADR 010's space:
- `run_resumed` — emitted at Resume. Fields: `new_run_id`, `continues_from: <paused_run_id>`, `acknowledgment: <text>`.
- Standard `run_started` fires immediately after for the new Run.

The Homecoming Brief can narrate resumes specifically: *"WP-04 was paused once (unbounded_diff) and resumed after you noted the broad scope was intentional."*

## Considered Options

| Option | Rejected Because |
|---|---|
| Fresh worktree on each Resume | Loses the paused agent's work; defeats worktree-preservation from ADR 014 |
| Fresh branch on each Resume | Requires cherry-picking; complicates ADR 011 merge model |
| In-process pause-and-resume (SIGSTOP / SIGCONT) | Brittle across platforms; LLM API calls don't survive process pause well |
| Dedicated Resume Composer agent | Continuation packet is structured data, not narrative — template is enough |
| Optional acknowledgment | Without it, Resume re-trips the same anomaly. Required by design. |

## Consequences

### Positive
- Paused work is genuinely recoverable, not just discardable.
- Each Resume chains visibly in audit.
- No new architectural primitives — reuses ADR 011's worktree model and ADR 014's pause semantics.

### Negative
- Multiple Resumes can compound state if acknowledgments are vague.
- Same-branch lineage means a failed Resume's commits are still on the branch when the next Resume starts.

## Followups

- **M4 code**: implement Resume in `extensions/agents.ts` (new `startResumedRun` paralleling `startSubagentRun`); compose continuation packet from existing event-log readers.
- **M4 dashboard**: add Resume / Discard / Force-Complete buttons for Paused Runs.
- **M4 CLI**: `/quest resume <runId>` command.

## References
- M4 grilling session.
- ADR 010 — Event Log (gains `run_resumed` event).
- ADR 011 — Worktree Isolation (Run Branch + merge model).
- ADR 014 — Anomaly Classification (defines Paused Run; this ADR closes the M4 followup it listed).
