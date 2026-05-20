# M3-2 — Freeze chords + audit events

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Two keybinding handlers at the extension level per ADR 013:

- **`Ctrl+P`** — soft freeze toggle. Sets `no_new_spawns: true` on the active quest's `workflow.json`. In-flight runs continue and complete normally; the router refuses to launch new runs while the flag is true. Tapping the chord again clears the flag. Widget reflects soft-freeze with the Resting mood and a line-2 indicator: `❄ frozen · N runs completing · Ctrl+P to release`.
- **`Ctrl+Shift+P`** — hard freeze. Confirmation prompt in the widget area: `Abort N runs and discard their work? [y/N]`. On `y`: SIGTERM all active runs (5s grace → SIGKILL), reap their worktrees, transition the quest to `blocked` with `cancel_reason: user_aborted`. On any other key: cancel.

Two new audit events:
- `freeze_engaged` — fields: `mode: "soft" | "hard"`, `in_flight_runs: N`, `triggered_by: "user"`
- `freeze_released` — fields: `triggered_by: "user" | "auto"`

Verify neither chord collides with pi's existing editor bindings before locking them in.

## Acceptance criteria

- [ ] `Ctrl+P` toggles soft freeze; second tap releases
- [ ] During soft freeze: no new runs spawn; in-flight runs continue and complete normally
- [ ] Widget renders the Resting mood + line-2 freeze indicator while soft-frozen
- [ ] `Ctrl+Shift+P` shows the confirmation prompt; `y` aborts, anything else cancels
- [ ] Hard freeze: all active runs receive SIGTERM, then SIGKILL after 5s; worktrees reaped; quest → `blocked` with `cancel_reason: user_aborted`
- [ ] `freeze_engaged` event emitted with correct fields on each freeze
- [ ] `freeze_released` event emitted on soft-freeze release
- [ ] Neither chord collides with pi's existing key bindings (verified empirically)

## Blocked by

M3-1.
