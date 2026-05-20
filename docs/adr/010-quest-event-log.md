# ADR 010: Quest Event Log — Audit Model, Typed Schema, Hybrid Emission

## Status
Accepted

## Context

`.pi/quests/<id>/telemetry/events.jsonl` already exists but uses a free-form `event: string` discriminator with only two emitted values (`agent_run_completed`, `rescue_invoked`). The M1 milestone needed to upgrade it into a foundation the later milestones can build on:

- M2 Trust Trinity records launch-gate outcomes.
- M3 Hearth Widget reads liveness pulses ("what is each run doing right now?").
- M3 Auto-Pause-on-Anomaly reacts to anomaly events.
- M4 Concession Ledger collects judgment calls during runs and surfaces them in the Homecoming Brief.
- M4 Quantified Relief counts what happened.

Three related decisions were grilled together.

## Decisions

### 1. The event log is an audit log, not the source of truth

`events.jsonl` is a write-once audit record. The Widget and Dashboard continue to read from current-state files (`workflow.json`, `runs/<id>.json`); the event log is read for postmortem, anomaly detection, and narrative composition — never for "what is the system's current state."

Considered: full event sourcing (events.jsonl as truth, projections derived for every read). Rejected because (a) the existing state-file model works, (b) the new event types are inherently audit-shaped ("a beat happened", "a concession was made"), and (c) the M3/M4 magical UX needs current state + a narrative read across the log — both satisfied by the audit model. Going A→B remains tractable later if a future feature genuinely needs time-travel.

### 2. Typed event union — minimum useful set

Nine event kinds, snake_case on the wire, with `event` as discriminator (preserves the field name already used):

| `event` | Purpose | Drives |
|---|---|---|
| `stage_entered` | Router moves quest to a new status | Timeline, two-clocks |
| `run_started` | Subagent run begins | Hearth running count |
| `run_finished` | Subagent run ends (completed/failed/cancelled) | Hearth done count, Quantified Relief |
| `run_orphaned` | Reaper marked an unreachable run | Recovery audit |
| `progress_beat` | Phase change or liveness pulse from a run | Hearth pulse, "what it's doing", narrative |
| `concession` | Agent made a judgment call without asking | Concession Ledger |
| `anomaly_detected` | Supervisor caught risky behavior | Auto-Pause, "I paused because..." |
| `launch_gate` | Trust Trinity gate outcome (passed/blocked) | Trust ceremony record |
| `rescue_invoked` | Rescue subagent ran | "I asked for help" |

Every event has `timestamp` (ISO 8601), `questId`, and an open `details?: Record<string, unknown>` slot for forward-compat.

Considered and rejected: separate `kind`/`type` discriminator (preserves an existing field instead), PascalCase wire format (mismatched with existing values), distinct `stage_started` + `stage_ended` pair (collapsed; "ended" is implicit in the next `stage_entered`), distinct `work_item_spawned` event (subsumed by `run_started`), distinct `heartbeat_missed` event (expressed as `anomaly_detected` with `rule: "heartbeat_missed"` — one way to say it).

### 3. Hybrid emission — explicit tools plus synthetic liveness

Two sources, deliberately separate:

- **Semantic events** (rich `progress_beat` with phase/confidence/note, and all `concession` events) come from explicit subagent tool calls: `quest_progress_beat` and `quest_concession`. The subagent learns its `runId` via env-var injection (`PI_QUEST_RUN_ID`, `PI_QUEST_QUEST_ID`, `PI_QUEST_WORK_ITEM_ID`) on spawn, plus a documentation sentence in the task prompt so the agent knows the tools exist.
- **Liveness** is a synthetic `progress_beat` with `phase: "alive"`, emitted by the parent's run supervisor every ~60s when no explicit beat has arrived in that window and `process.kill(pid, 0)` succeeds.

Considered: tool-only (Hearth Widget looks dead during long shell commands), synthetic-only (no semantic info; Concession Ledger impossible), stdout-convention parsing (lossy, pollutes transcript). Rejected.

The two sources are deliberately distinct so that an explicit-beat silence with PID-alive becomes itself a signal — likely a stuck shell command — which Auto-Pause-on-Anomaly can catch.

## Consequences

### Positive
- One schema covers M2–M4 with no speculative events.
- Hybrid emission gives the Hearth Widget a heartbeat floor that survives long shell commands.
- The `details` slot lets us add fields without re-typing the union every milestone.
- No migration concerns — pi-quest is solo-developer pre-release; old `events.jsonl` files can be wiped.

### Negative
- Subagents must remember to call `quest_progress_beat` / `quest_concession`; discipline is required in agent definitions and system prompts. The synthetic beat mitigates the Hearth case but not the Concession Ledger case.
- Two beat sources means readers must understand the distinction (semantic vs synthetic).

## Followups

- **M1 code**: define the typed union in `extensions/events.ts`; add `quest_progress_beat` and `quest_concession` tools; inject `PI_QUEST_*` env vars in `startSubagentRun`; add the 60s synthetic-beat interval driven by `pid` liveness; rename emitted `agent_run_completed` → `run_finished`.
- **M1 agent definitions**: update `agents/*.md` frontmatter to grant `quest_progress_beat, quest_concession` to autonomous agents; update each system prompt to instruct beat/concession emission discipline.
- **M1 rate limiting**: cap explicit `progress_beat` at 1 per 15s per run; concessions are unbounded.

## References
- M1 grilling session.
- `extensions/tools.ts:407` — current `quest_telemetry_event` implementation.
- `extensions/agents.ts:298` — current hard-coded telemetry emission from `startSubagentRun`.
- ADR 009 — In-process supervision (this ADR assumes the in-process model).
