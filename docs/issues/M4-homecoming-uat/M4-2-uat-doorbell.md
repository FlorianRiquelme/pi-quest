# M4-2 — UAT Doorbell

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

At the `verification-ready → uat-ready` router transition, fire three channels in parallel per ADR 016:

- **Terminal bell**: write `\a` to stdout. Gracefully silent on terminals with bell disabled.
- **OS notification**: `ctx.ui.notify("UAT pending for <quest title>", "info")` — uses pi's existing facility.
- **Widget mood shift**: handled automatically by M3-1's Needs-you mood logic. No extra wiring required here.

Single trigger only — the bell does not repeat if the quest sits at `uat-ready` for a while or re-enters `uat-ready` later. No idle detection.

## Acceptance criteria

- [ ] Terminal bell character is written exactly once at the `verification-ready → uat-ready` transition
- [ ] `ctx.ui.notify` is called with the right message at the transition
- [ ] Widget mood becomes Needs-you (verified via M3-1 logic; no new code here)
- [ ] Bell does not re-fire if the quest re-enters `uat-ready` from `uat-failed` after iteration

## Blocked by

None — can start immediately.
