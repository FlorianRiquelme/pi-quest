# ADR 007: Mandatory UAT Before Quest Completion

## Status
Accepted

## Context
Quests currently transition from `verification-ready` directly to `completed` without a human acceptance step. The Verification Agent checks code correctness, test pass rates, and plan compliance, but it cannot verify actual user-facing behavior in the TUI — key bindings, overlay rendering, visual layout, and real terminal interaction.

The `dashboard-followup-handoff-2` quest exposed this gap: implementation was correct, tests passed, and verification passed, but a human still needed to confirm the Dashboard actually looked full-screen and the new shortcut felt right in the real TUI.

## Decision
Every quest **must** go through human UAT before it can be marked `completed`. The UAT agent writes a scenario-based guide; a human walks through each scenario in the real TUI and reports verdicts back to the orchestrator. Only after all scenarios pass (or accepted limitations are documented) may the quest advance to `completed`.

## Consequences

### Positive
- Catches UX regressions that automated tests miss (rendering, layout, shortcuts, perceived performance).
- Forces a pause for human judgment before declaring work done.
- Creates a reproducible acceptance record (`UAT.md` with filled verdicts).

### Negative
- Adds latency — a human must be available to run the scenarios.
- Small quests with zero user-facing changes still need a lightweight UAT sign-off.

## Mitigations
- UAT guides should be concise (typically 3–6 scenarios).
- Scenarios with no user-facing change can be marked N/A with a one-line justification.
- The orchestrator should walk the user through each scenario interactively rather than dumping a long document.

## Workflow Change

```
planned → executing → verification → verification-ready → uat-ready → completed
                                      ↑                          ↑
                                   Verification Agent          Human UAT
```

The `quest_write_workflow` tool (or manual edit) should enforce that the `completed` transition from `uat-ready` requires all UAT scenarios to have a Pass or accepted N/A verdict recorded.

## References
- `dashboard-followup-handoff-2/UAT.md` — first quest with full UAT walkthrough
