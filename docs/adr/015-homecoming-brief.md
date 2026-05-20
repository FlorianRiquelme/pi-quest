# ADR 015: Homecoming Brief — Postcard, Not Log Dump

## Status
Accepted

## Context

M4 grilling shaped what the user sees when they return to an active **Quest** after autonomous work has progressed. The brainstorm framed this as pi-quest's deepest UX claim: a "relationship UX" rather than a "tool UX." The **Homecoming Brief** is the postcard the user receives at homecoming — specific, warm, human, never a CSV.

## Decisions

### 1. When the Brief appears

Two triggers:
- **Auto on `/quest` invocation** when there's new state since last view, detected by comparing `events.jsonl` timestamps against a `lastSeenEventTimestamp` pointer per quest in `.pi/quest/state.json`.
- **Auto at autonomous-to-interactive stage transitions** (`executing → verification-ready`, `verification-ready → uat-ready`, etc.).

Manual `/quest brief` always works as escape hatch.

### 2. Persistence

The Brief is a workspace **Artifact** at `.pi/quests/<questId>/BRIEF.md`. Regenerated on trigger; cached between regenerations. Joins HANDOFF.md, RECON.md, etc. in the artifact list — appearing in the Dashboard, persisting across pi restarts, sharable as a markdown file.

### 3. Structure — six sections

1. **Title bar**: quest name (auto-name or quest ID), status, run counts, Two Clocks, Base SHA + Quest Branch.
2. **Narrative**: 3–5 sentence LLM-composed prose. First person, specific, no adjectives like "elegant" or "brilliant."
3. **Concessions**: from `concession` events, one line each.
4. **Anomalies**: from `anomaly_detected` events across all tiers, one line each.
5. **Receipt** (Quantified Relief): files touched, lines, tests, commits, tokens, cost, estimated human time saved.
6. **Next**: single sentence + action pointer.

Example skeleton:

```
## Quest of the Tangled Cookies
✓ 3 work items completed · 1 paused · 0 blocked
Wall 3h 12m · Compute 47m (4.1x parallelism)
Base SHA: a7b2c3d · Quest Branch: quest/auth-001

> I started on the auth refactor, ran into a tricky session-cookie
> edge case in WP-04, paused after the diff size shot past 50 files,
> then completed the other 3 work items. Tests are green; UAT is
> waiting for you.

### Concessions (4) ...
### Anomalies (2) ...
### Receipt ...
### Next
► UAT pending — run /quest to enter the acceptance walkthrough
```

### 4. Narrative composed by a dedicated Homecoming Agent

The narrative is a small subagent spawned at trigger time. Reads event log + run reports + concessions; writes 3–5 sentences. Prompt discipline: first person, specific, concrete, no adjectives, no narration of every step. The user infers competence from outcomes, not from how the agent describes itself.

**Pre-composition matters**: the agent runs *during* the autonomous-to-interactive transition (in the background). By the time the user invokes `/quest`, the Brief already exists. Latency lives in autonomous time, not at the user-facing moment.

Cost estimate: ~50K input tokens per generation is cents per quest. Acceptable.

### 5. Quest auto-naming — deferred slot

The Brief title bar reserves a slot for an evocative auto-name (e.g., "Quest of the Tangled Cookies"). Implementation deferred: a quest without an auto-name shows its ID. Auto-naming can come from the Homecoming Agent or a one-shot at quest creation.

## Considered Options

| Option | Rejected Because |
|---|---|
| On-demand only (no auto-trigger) | Discoverability problem; users may not know it exists |
| Pure template Brief (no LLM) | "12 files changed, 47 tests passing" is correct and emotionally useless |
| Main-session agent composes inline | Pollutes main session; user waits for narrative at the homecoming moment |
| Brief as dashboard-only section, not an artifact | Loses portability and version-control persistence |

## Consequences

### Positive
- The user comes home to a postcard, not a log dump.
- Brief is a regular artifact — appears in dashboard, can be re-read, persists across pi restarts.
- Latency absorbed in autonomous time; the user never waits at the moment of return.

### Negative
- Homecoming Agent adds token cost per quest (modest).
- LLM narratives can vary in quality; prompt discipline is non-trivial to maintain over time.

## Followups

- **M4 code**: Brief generator (read event log + reports → assemble sections + invoke agent for narrative).
- **M4 agent**: create `agents/homecoming.md` with the narrative-composition prompt.
- **M4 router**: trigger Brief generation at autonomous-to-interactive transitions.
- **M4 schema**: extend `state.json` with `lastSeenEventTimestamp` per quest.
- **Post-M4**: implement quest auto-naming (slot already reserved).

## References
- M4 grilling session.
- Brainstorm: Claude's "Homecoming Brief" / "Returning Traveler Briefing."
- ADR 010 — Event Log (Brief reads it).
