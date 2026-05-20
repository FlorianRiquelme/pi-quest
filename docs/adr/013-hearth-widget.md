# ADR 013: Hearth Widget — Ambient, Rhythmic, Glance-Readable

## Status
Accepted

## Context

The pi-quest **Widget** today (`extensions/ui/widget.ts`) is text-only, two lines, above-editor, at full theme brightness. It surfaces title, status, and run count — competing with the editor for attention.

M3 grilling redesigned it around **Calm Technology** principles: information lives at the periphery; brightness is earned; rhythm carries meaning where text would be noise. The user accepted a five-mood vocabulary, **Two Clocks**, and single-key swarm freeze.

This ADR locks the redesign as a coherent system.

## Decisions

### 1. Five-mood vocabulary

| Mood | Visual | When |
|---|---|---|
| **Resting** | Dim white/grey, no rhythm | No active quest, quest in interactive stage waiting on user, or quest under soft-freeze |
| **Cruising** | Soft blue, slow pulse (~1Hz) | Autonomous stage running normally; semantic beats arriving |
| **Working hard** | Warm amber, faster pulse (~2Hz) | High-activity period (multiple runs, low-confidence beats, retries) |
| **Stuck** | Yellow steady, no rhythm | Synthetic beats arriving but no semantic beats for 5+ minutes |
| **Needs you** | Green steady, no rhythm | User input structurally required (interactive stage entry, UAT pending, paused run, freeze confirmation) |

### 2. Two baked rules

- **Brightness is earned**. Resting is dim. Brightness escalates only with state demand.
- **Rhythm only when alive and working**. Stalled, Resting, and Needs-you are still. Motion = work; stillness = waiting or stuck.

### 3. Layout — line 1 carries mood, line 2 carries detail

```
[mood-colored title]                              [mood-colored status word]
  [glyph] [run summary]  [last beat phase]                [wall / compute]
```

Line 1 is the peripheral signal. Line 2 is the read-on-demand detail.

### 4. Two Clocks

`wall / compute` in line 2, dim by default. Human-friendly format (`3h 12m / 47m`).
- **Wall**: time from first `stage_entered: executing` event to terminal status; ticks through subsequent stages including interactive ones.
- **Compute**: sum of `(run_finished − run_started)` across all runs.
- Hidden until `executing` is entered. Frozen at terminal status.

State reads cache at 250ms granularity to keep pulse animation cheap.

### 5. Pulse cost cap

Pulse re-renders at most 2Hz (Working hard) or 1Hz (Cruising). Only color recomputation runs at pulse rate; state reads (`getActiveQuestSummary`, `countRunningWorkItems`) cache.

### 6. Accessibility — redundant glyph per mood

| Mood | Glyph |
|---|---|
| Resting | `·` |
| Cruising | `◌` |
| Working hard | `●` |
| Stuck | `!` |
| Needs you | `►` |

The glyph appears at the start of line 2. Color-blind users still receive the signal.

### 7. Terminal capability fallback

If 24-bit color isn't available: fall back to 5 named theme colors, skip the breathing rhythm (static color shifts only). Matches the existing widget's pattern.

### 8. Single-key swarm freeze

| Chord | Action |
|---|---|
| `Ctrl+P` | Soft freeze toggle. Sets a "no new spawns" flag on the active quest. In-flight runs continue; new runs blocked. Mood becomes Resting; line 2 shows `❄ frozen · N runs completing · Ctrl+P to release`. Reversible. |
| `Ctrl+Shift+P` | Hard freeze. Confirmation in widget area: `Abort N runs and discard their work? [y/N]`. On `y`: SIGTERM all runs (5s grace → SIGKILL), reap worktrees, quest → `blocked` with reason `user_aborted`. |

Two new audit events: `freeze_engaged` (with `mode: "soft" | "hard"`, `in_flight_runs: <count>`) and `freeze_released`.

Per-run pause is intentionally deferred to M4 (dashboard surface).

## Considered Options

| Option | Rejected Because |
|---|---|
| Keep existing static text widget | No peripheral readability; user must read to extract any signal |
| More than 5 moods (separate Blocked, Idle, Failed states) | Vocabulary becomes unlearnable; let line 2 disambiguate fine cases |
| ASCII gauge / progress bar | Reads as "spinner," not "alive"; doesn't convey state at a glance |
| Hold-Esc-for-1s freeze | Hold detection is platform-fiddly; chord is universal |
| Single freeze level | Soft is for thinking, hard is for panic — collapsing one loses work or makes panic slow |

## Consequences

### Positive
- Peripheral readability: user can leave the editor focused while staying ambient-aware.
- Two Clocks reframes long autonomous runs as "ambient companionship" rather than "guard duty."
- Single-chord freeze enforces Asymmetric Interrupt Cost.
- Accessibility through glyph redundancy and graceful color degradation.

### Negative
- Pulse animation requires ongoing re-render; CPU cost must be managed via the 250ms cache.
- Terminals with poor 24-bit support degrade to flat color; usable but less expressive.
- Two new event types grow the schema.

## Followups

- **M3 code**: refactor `extensions/ui/widget.ts` to support mood + rhythm + 250ms cache + glyph + Two Clocks.
- **M3 code**: add key-binding handlers for `Ctrl+P` / `Ctrl+Shift+P` at the extension level.
- **M3 schema**: add `freeze_engaged` and `freeze_released` events (extends ADR 010).

## References
- M3 grilling session.
- Brainstorm: Gemini's "Calm-Tech Breathing Widget", Claude's "Hearth, not the Cockpit" and "Asymmetric Interrupt Cost".
- `extensions/ui/widget.ts` — current implementation.
- ADR 010 — Event Log (gains 2 new event types from this ADR).
- ADR 014 — Anomaly Classification (paused runs surface as Needs-you mood here).
