# ADR 009: No Daemon — In-Process Supervision

## Status
Accepted

## Context

The M1 "Foundation" milestone of the pi-quest UX redesign considered whether to introduce a standalone `pi-questd` daemon to supervise background subagents, own quest state, and drive projections for the Widget and Dashboard.

The Codex brainstorm assumed a daemon. The existing codebase does not have one. Today, background subagents are spawned children of the host pi process with `detached: false` (`extensions/agents.ts:247`), meaning they die when the user quits pi — even though `workflow.json` and `runs/*.json` persist.

A real failure scenario: user kicks off 4 parallel work items at 10pm, closes the terminal, comes back at 8am. With today's model, all four were killed at 10:01pm, but the Widget and Dashboard still show `executing` until the user reads the run summaries.

## Decision

pi-quest stays **in-process**. Background subagents become detached children of the pi extension (`detached: true`). On extension startup, a reconciliation pass — the **reaper** — scans `runs/*.json` against live PIDs and promotes unreachable runs to an **Orphaned Run** state.

## Considered Options

| Option | Rejected Because |
|--------|------------------|
| Standalone `pi-questd` (Unix socket / HTTP IPC) | Adds operational cost: install, autostart, port conflicts, version skew between daemon and extension. The marginal UX benefit (sub-second cross-session liveness) is not yet justified by the planned M3 Hearth Widget, which is polling-friendly. |
| In-process supervisor module | Reachable as an upgrade from the current model without re-opening the daemon question. Promote when needed. |
| Status quo (`detached: false`, no reaper) | Loses all running work on pi quit/crash; Widget displays a lie until user investigates. Unacceptable for hour-scale autonomous runs. |

## Consequences

### Positive
- No new process to install, supervise, or version-skew.
- Schema discipline and reaper logic deliver ~90% of the daemon's benefit at ~10% of the cost.
- The existing `spawn` + JSON-persisted state model continues to work.
- Reachable from here to an in-process supervisor module without revisiting this ADR.

### Negative
- If pi crashes hard mid-execution, runs are orphaned and stay orphaned until the next pi startup reconciles them.
- Multi-pi-session coordination (two terminals touching the same quest) remains undefined.
- Hour-scale runs depend on the user not killing pi — the reaper recovers state but not work.

## Followups

- **M1**: Flip `detached: true` on subagent spawn. Implement the reaper as a startup hook.
- **M1**: Add `orphaned` to the Run status enum (`extensions/types.ts:35`).
- **Post-M4**: Revisit if Hearth/Homecoming UX hits a wall only a daemon can solve (e.g. sub-second cross-session liveness, multi-terminal coordination, surviving a hard pi crash).

## References
- M1 brainstorm grilling session.
- `extensions/agents.ts:247` — current `detached: false`.
- `extensions/agents.ts:177` — `activeRuns` in-memory map, lost on restart.
- `extensions/types.ts:35` — current Run status enum.
