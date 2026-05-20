# M4-3 — UAT skill rewrite + scenario contract + failure loop

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Rewrite `skills/uat/SKILL.md` for a single-scenario conversational flow per ADR 016. The skill reads `UAT.md` frontmatter with this contract:

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
    verdict: pending     # pending | pass | fail | n/a
    notes: ""            # filled if fail or n/a
---
```

Setup commands are **displayed as copy-pasteable blocks, not auto-executed**.

The skill walks one pending scenario at a time. Each scenario asks `[p]ass · [f]ail · [n]/a · [s]kip for now`. On `fail` or `n/a`, prompts for one-line notes. Verdicts and notes write back to UAT.md frontmatter.

Add a new compiler rule `vague_uat_scenario` (warning severity) — fires when a scenario's `verify:` is empty or contains only phrases like "looks right" / "works as expected".

**Failure loop**: when all scenarios are resolved, if any `fail` verdicts exist, offer the user two paths:
- **Iterate** — create new work items addressing the failures, update `IMPLEMENTATION_PLAN.md`, quest returns to `planned` and re-enters the Launch Review ceremony (per ADR 012)
- **Accept** — quest moves to `uat-failed` for manual iteration

If all scenarios pass: prompt to mark quest `completed`.

## Acceptance criteria

- [ ] UAT.md frontmatter contract is parsed by the skill
- [ ] Skill walks scenarios one at a time, not as a wall
- [ ] Setup commands are displayed as copy-pasteable blocks; not auto-executed
- [ ] Verdicts (`pass` / `fail` / `n/a` / `skip`) are recorded back to UAT.md
- [ ] `vague_uat_scenario` compiler warning fires on empty or vague `verify:` entries
- [ ] On `fail` verdicts at completion attempt: skill offers Iterate vs Accept
- [ ] Iterate creates new work items and returns the quest to `planned`; Launch Review re-engages on the new scope
- [ ] Accept moves the quest to `uat-failed`
- [ ] All-pass path leads to `completed`

## Blocked by

M2-2.
