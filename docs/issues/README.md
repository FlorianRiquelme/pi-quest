# M1–M4 UX redesign issues

Tracer-bullet vertical slices for the pi-quest M1–M4 UX redesign. Each issue is end-to-end (schema + code + tests + docs as needed) and leaves pi-quest demoably more capable.

Design sources: ADRs 009–017 in `docs/adr/`; CONTEXT.md for the domain glossary.

## Discipline — TDD on every issue

Every issue is implemented **red-green-refactor**:

1. **Red** — write tests asserting the acceptance criteria *before* writing implementation. Tests should fail.
2. **Green** — implement the minimum code to make those tests pass.
3. **Refactor** — clean up while keeping the tests green.

Acceptance criteria in each issue are **test specs**. An issue is not done until every checkbox maps to a passing test committed to the repo. Code without a corresponding red-then-green test is not acceptable.

## Dependency graph

```
M1-1 ──┬─→ M1-2 ─→ M1-3
       ├─→ M2-1 ─→ M2-2 ──┬─→ M4-1
       ├─→ M3-1 ─→ M3-2   └─→ M4-3
       └─────────────────────→ M4-1

M1-2, M1-3 ─→ M3-3 ─→ M4-4

M4-2 — no blockers
```

## Issues

### M1 — Foundation

| # | Title | Type |
|---|---|---|
| [M1-1](M1-foundation/M1-1-typed-event-union.md) | Typed 9-event union | AFK |
| [M1-2](M1-foundation/M1-2-subagent-foundation.md) | Subagent foundation (detached + reaper + beat/concession tools + synthetic liveness) | AFK |
| [M1-3](M1-foundation/M1-3-worktree-per-run.md) | Worktree-per-run end-to-end | AFK |

### M2 — Trust Trinity

| # | Title | Type |
|---|---|---|
| [M2-1](M2-trust-trinity/M2-1-launch-review-tracer-bullet.md) | Launch Review tracer bullet (status + skill + gate) | HITL |
| [M2-2](M2-trust-trinity/M2-2-compiler-and-trinity-content.md) | Compiler + Blast Radius + Pre-Mortem content | AFK |

### M3 — Hearth Widget + Ambient state

| # | Title | Type |
|---|---|---|
| [M3-1](M3-hearth-widget/M3-1-hearth-widget-complete.md) | Hearth Widget complete (moods + Two Clocks + pulse) | AFK |
| [M3-2](M3-hearth-widget/M3-2-freeze-chords.md) | Freeze chords + audit events | HITL |
| [M3-3](M3-hearth-widget/M3-3-anomaly-polling-and-pause.md) | Anomaly polling + pause + Dashboard actions | AFK |

### M4 — Homecoming + UAT

| # | Title | Type |
|---|---|---|
| [M4-1](M4-homecoming-uat/M4-1-homecoming-brief.md) | Homecoming Brief (template + narrative agent + triggers) | AFK |
| [M4-2](M4-homecoming-uat/M4-2-uat-doorbell.md) | UAT Doorbell | AFK |
| [M4-3](M4-homecoming-uat/M4-3-uat-skill-rewrite.md) | UAT skill rewrite + scenario contract + failure loop | HITL |
| [M4-4](M4-homecoming-uat/M4-4-resume-mechanic.md) | Resume mechanic for Paused Runs | HITL |

## Suggested first slice

M1-1 → M1-2 → M1-3 → M3-1 → M3-3 gives you a Hearth Widget with real heartbeat over the new typed-event + worktree foundation. That's a satisfying first deliverable that exercises the new architecture end-to-end before the bigger M2/M4 surfaces land.
