# M1-2 — Subagent foundation (detached + reaper + beat/concession tools + synthetic liveness)

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Three changes to background subagent lifecycle, all per ADR 009 and ADR 010:

1. **Detached children**: flip subagent spawning to `detached: true` so children survive parent exits.
2. **Startup reaper**: on extension start, scan all `runs/*.json` for entries with `status: running` and check their PID liveness. Unreachable runs are promoted to a new `orphaned` status; emit `run_orphaned` events. Extend the Run status enum accordingly.
3. **Semantic-event tools**: add two new extension tools, `quest_progress_beat({phase, confidence?, note?})` and `quest_concession({decision, rationale})`. Inject `PI_QUEST_QUEST_ID`, `PI_QUEST_WORK_ITEM_ID`, `PI_QUEST_RUN_ID` env vars on subagent spawn so the tools can attribute events without arguments. Rate-limit explicit beats to 1 per 15s per run.

In parallel, add a 60s synthetic liveness loop in the parent supervisor: when no semantic `progress_beat` has arrived from a run in that window AND `process.kill(pid, 0)` succeeds, emit a synthetic `progress_beat` with `phase: "alive"`.

Update autonomous agent definitions (`agents/*.md`) to grant the two new tools and instruct beat/concession discipline in their system prompts.

## Acceptance criteria

- [ ] Subagents spawn with `detached: true` and survive a parent exit
- [ ] Startup reaper detects stale runs, promotes them to `orphaned`, emits `run_orphaned`
- [ ] Run status enum and `BackgroundRunSummary.status` include `orphaned`
- [ ] `quest_progress_beat` emits a valid `progress_beat` event with the expected fields
- [ ] `quest_concession` emits a valid `concession` event
- [ ] `PI_QUEST_*` env vars are present in the subagent process and consumed by the tools
- [ ] Synthetic liveness beat fires every 60s when no semantic beat has arrived and PID is alive
- [ ] Explicit semantic beats are rate-limited to 1 per 15s per run
- [ ] At least one autonomous agent definition is updated to declare + instruct the new tools

## Blocked by

M1-1.
