# M3-1 — Hearth Widget complete (moods + Two Clocks + pulse)

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Full redesign of the active-quest widget per ADR 013. Five-mood vocabulary:

| Mood | Visual | When |
|---|---|---|
| **Resting** | Dim white/grey, no rhythm | No active quest, interactive stage waiting on user, or under soft-freeze |
| **Cruising** | Soft blue, slow pulse (~1Hz) | Autonomous stage running normally |
| **Working hard** | Warm amber, faster pulse (~2Hz) | High activity: multiple runs, low-confidence beats, retries |
| **Stuck** | Yellow steady, no rhythm | Synthetic beats arriving but no semantic beats for 5+ min |
| **Needs you** | Green steady, no rhythm | Interactive-stage entry, UAT pending, paused run, freeze confirmation |

Brightness-earned rule: Resting is dim; brightness escalates with state demand. Rhythm only in Cruising / Working hard; other moods are still.

Two Clocks (`wall / compute`, e.g. `3h 12m / 47m`) render in line 2, dim. Wall = time from first `stage_entered: executing` to terminal status; ticks through all subsequent stages. Compute = sum of `(run_finished − run_started)`. Hidden before `executing`. Frozen at terminal status. Human-friendly format (no sub-minute precision).

Accessibility: one-character glyph in line 2 per mood (`·`, `◌`, `●`, `!`, `►`). Terminal capability detection: if 24-bit isn't available, fall back to 5 named theme colors and skip rhythm (static color only).

Cache state reads (active-quest summary, run counts) at 250ms granularity so pulse animation doesn't re-scan files at full pulse rate. Mood selection derives from recent `progress_beat` event timestamps (semantic vs synthetic), run counts, status, and freeze state.

## Acceptance criteria

- [ ] Widget renders all 5 moods with distinct colors and the correct rhythm/stillness
- [ ] Brightness is observably lower in Resting than in Needs-you
- [ ] Two Clocks appear in line 2 once `executing` is entered, in human-friendly format
- [ ] Clocks are hidden in `intake` / `recon-ready` / `resolved` / `planned` / `launch-review`
- [ ] Each mood has the correct glyph in line 2
- [ ] When 24-bit color isn't supported, palette degrades to named colors and pulse stops; widget still useful
- [ ] State reads cache at 250ms; full re-scan does not happen on pulse ticks
- [ ] Stuck mood activates after 5 min of no semantic `progress_beat` while synthetic alive beats keep arriving
- [ ] Mood transitions are smooth (no flicker between Cruising and Working hard)

## Blocked by

M1-1.
