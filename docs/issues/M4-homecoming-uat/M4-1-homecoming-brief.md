# M4-1 — Homecoming Brief (template + narrative agent + auto-triggers)

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Generate `.pi/quests/<questId>/BRIEF.md` as a six-section workspace artifact per ADR 015:

1. **Title bar**: quest name (slot for auto-name; show quest ID until that exists), status, run counts, Two Clocks, Base SHA + Quest Branch
2. **Narrative**: 3–5 sentence first-person prose composed by a Homecoming Agent
3. **Concessions**: from `concession` events, one line each
4. **Anomalies**: from `anomaly_detected` events across all tiers, one line each
5. **Receipt** (Quantified Relief): files / lines / tests / commits / tokens / cost / estimated human time saved
6. **Next**: single sentence + action pointer

Five sections are template-driven (read event log + run reports + git stats). The Narrative section is filled by a new `agents/homecoming.md` subagent — small autonomous agent with a tight prompt (first person, specific, concrete, no adjectives like "elegant" or "brilliant," no narration of every step).

Triggers:
- Auto-generate at autonomous-to-interactive stage transitions (e.g. `executing → verification-ready`, `verification-ready → uat-ready`). Generation runs *during* the transition so the Brief is ready when the user invokes `/quest`.
- Auto-display on `/quest` invocation when there's new state since last view (track via `lastSeenEventTimestamp` per quest in `.pi/quest/state.json`).
- Manual via `/quest brief`.

The Brief joins the existing artifact list in the Dashboard.

## Acceptance criteria

- [ ] `BRIEF.md` is generated at the expected path and registered as a workspace artifact
- [ ] All six sections render with the correct shape and content sources
- [ ] Title bar shows quest ID when no auto-name exists (slot reserved)
- [ ] Narrative is composed by a new homecoming agent definition
- [ ] Brief regenerates at autonomous-to-interactive transitions
- [ ] `/quest` with new state since `lastSeenEventTimestamp` displays the Brief and updates the pointer
- [ ] `/quest brief` always regenerates and displays
- [ ] Brief appears in the Dashboard artifact list

## Blocked by

M1-1, M2-2.
