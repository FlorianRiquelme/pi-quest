# ADR 016: UAT Doorbell + Reverse Prompting — The One Moment That Earns a Sound

## Status
Accepted

## Context

ADR 007 made UAT mandatory before quest completion. M4 grilling tightened *how* UAT is invoked and walked through. The **Doorbell** announces the moment; **Reverse Prompting** structures the walkthrough so cognitive load is minimal when the user is most fatigued.

## Decisions

### 1. The Doorbell — three channels, single trigger

Fires once at the `verification-ready → uat-ready` transition. Never repeats.

| Channel | Mechanism |
|---|---|
| Terminal bell | Write `\a` to stdout (gracefully silent on terminals with bell disabled) |
| OS notification | `ctx.ui.notify("UAT pending for <quest title>", "info")` — uses pi's existing facility |
| Widget mood shift | Covered by ADR 013 — mood becomes Needs-you (green steady) |

No idle detection (platform-fiddly and brittle). Each channel is brief and once-only.

### 2. Reverse Prompting — tightened UAT.md contract

UAT.md frontmatter:

```yaml
---
uat_scenarios:
  - id: S1
    name: "<scenario name>"
    setup:        # commands user runs to prepare staging env
      - "Run: <command>"
      - "Wait for: <signal>"
    actions:      # what the user does
      - "Open: <url>"
      - "Click: <element>"
    verify:       # what the user checks
      - "<expected outcome>"
    verdict: pending    # pending | pass | fail | n/a
    notes: ""           # filled if fail or n/a
---
```

**Setup commands are displayed as copy-pasteable blocks, not auto-executed.** Auto-running shell commands at UAT time is risky (port conflicts, dev-server collisions). The user runs them when ready.

### 3. UAT skill conversation flow

Single-screen, single-scenario at a time:

1. Skill opens UAT.md, reads frontmatter.
2. Presents first `verdict: pending` scenario in full.
3. Prompts: `[p]ass · [f]ail · [n]/a · [s]kip for now`.
4. On `fail` or `n/a`: prompts for one-line notes.
5. Records verdict + notes back to UAT.md.
6. Continues with next pending scenario.
7. When all resolved: asks "ready to mark `completed`?"

### 4. New Compiler rule — `vague_uat_scenario`

Extending the Handoff Compiler's rule space (ADR 010 + M2 Q2): emit `warning` when a scenario's `verify:` is empty or contains only vague language ("looks right", "works as expected"). Vague scenarios train users to rubber-stamp.

### 5. UAT failure loop

If any `fail` verdict exists at completion attempt, the skill offers:
- **Iterate**: create new work items addressing the failures; plan updates; quest returns to `planned`. **Launch Review** re-engages on the new scope (per ADR 012).
- **Accept**: quest moves to `uat-failed` for manual iteration.

This closes the loop: UAT failures don't dead-end — they become new work, re-feeding the Trust Trinity ceremony.

## Considered Options

| Option | Rejected Because |
|---|---|
| Auto-execute setup commands | Port conflicts, dev-server collisions; too risky for unattended moment |
| Notify only via Widget mood | Misses users not watching the terminal |
| Repeated notifications | Trains the user to ignore — opposite of "one dignified sound" |
| All scenarios shown at once | Cognitive overload at peak fatigue; rubber-stamping risk |

## Consequences

### Positive
- One sound that matters; users learn it means UAT specifically.
- Reverse Prompting reduces cognitive load when the user is most fatigued.
- Failure loop turns UAT into iteration, not dead-end.

### Negative
- Setup commands aren't auto-executed; small friction.
- Multi-channel notification can feel intense for users already in pi (mitigated: each channel is brief and singular).

## Followups

- **M4 code**: implement Doorbell at router's `verification-ready → uat-ready` transition.
- **M4 skill**: rewrite `skills/uat/SKILL.md` for single-scenario conversational flow.
- **M4 compiler**: add `vague_uat_scenario` rule.
- **M4 router**: implement the "create new work items from failures" flow with re-entry into Launch Review.

## References
- M4 grilling session.
- ADR 007 — Mandatory UAT.
- ADR 008 — Auto-Routing.
- ADR 012 — Launch Review (re-engaged on UAT failure iteration).
- ADR 013 — Hearth Widget (Needs-you mood for UAT).
- Brainstorm: Gemini's "Reverse Prompting" / Claude's "UAT Doorbell" / "Theater Budget."
