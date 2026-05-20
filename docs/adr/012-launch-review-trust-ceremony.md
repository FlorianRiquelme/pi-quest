# ADR 012: Launch Review — Interactive Trust Trinity Ceremony

## Status
Accepted

## Context

ADR 008 established an auto-router that drives quests through the **Stage Pipeline**, halting only at interactive stages (`review-discussion`, `uat`) or failures. M2 grilling introduced the **Trust Trinity** as the pre-execution ceremony: Handoff Compiler diagnostics, Blast Radius, Pre-Mortem.

Initially the Trinity was modeled as a *check* — a Launch Gate that runs and either blocks or passes. User feedback reshaped it: the user must be *in the dialogue*. Static checks at the gate are surveillance theater; an active sign-off ceremony is what earns trust. A pre-mortem nobody read is no different from no pre-mortem at all.

## Decision

Insert a new interactive stage **`launch-review`** between `planned` and `executing` in the Stage Pipeline. It is the human-engagement moment for the Trust Trinity.

### Updated Stage Pipeline

```
intake → recon-ready → resolved → planned → launch-review → executing → verification → verification-ready → uat-ready → completed
```

`launch-review` joins `review-discussion` and `uat` as **Interactive Stages** — the router loads the skill's instructions inline in the main session rather than spawning a subagent.

### What the Launch Review skill does

The skill (`skills/launch-review/SKILL.md`) walks the user through the three Trinity pieces in order:

1. **Compiler diagnostics**: any `severity: error` must be addressed (user edits the plan or re-runs planning); `severity: warning` requires explicit acknowledgement.
2. **Blast Radius**: presented for review; user can add paths to `locked_out`.
3. **Pre-Mortem**: presented; user reacts.

For Pre-Mortem, four user-driven outcomes:

| Reaction | Skill behavior |
|---|---|
| Accept | Records sign-off; gate opens |
| Too defensive / too weak / wrong mode | User edits the pre-mortem text inline; revision recorded in `pre_mortem_edits` |
| Has questions | Main-session agent answers from plan + recon + handoff artifacts |
| Wants to mitigate | Skill offers (a) add a new work item directly, or (b) re-run planning with the mitigation as a new constraint (quest returns to `resolved`) |
| Cancel | Quest transitions to `blocked` with cancel reason |

### Sign-off contract

On acceptance, the skill writes `launch_review` to `IMPLEMENTATION_PLAN.md` frontmatter:

```yaml
launch_review:
  signed_off_at: "2026-05-20T11:30:00+02:00"
  signed_off_by: "user"
  acknowledged_warnings:
    - "WP-03:missing_verification"
    - "WP-05:empty_claims"
  pre_mortem_edits:                # only if user revised
    original_most_likely_failure: "..."
    revised_most_likely_failure: "..."
  mitigations:                     # only if user requested any
    - description: "Added rollback test"
      action: "added_work_item"     # | added_locked_out_path | reran_planning
      work_item_id: "WP-06"
```

### Launch Gate vs Launch Review

Two distinct concepts:

- **Launch Review** (interactive, status `launch-review`): the *ceremony*. User engages.
- **Launch Gate** (automated, runs at `launch-review → executing` transition): the *validation*. Verifies:
  1. All Trinity artifacts exist (plan frontmatter has `blast_radius`, `pre_mortem`).
  2. `compiler_diagnostics` has zero `severity: error` entries.
  3. `launch_review.signed_off_at` is present.

On any failure: emit `launch_gate` event with `outcome: "blocked"` and `reasons: [...]`. Quest stays at `launch-review`.

### Compiler re-runs inside the skill

Because user edits or mitigations can change the plan, the compiler re-runs after each change inside the Launch Review skill. The Gate's compiler check just verifies the *final* state has no errors — it doesn't run the compiler itself.

### Force override

`/quest set-status <id> executing --force` bypasses the Launch Review entirely. The `launch_gate` event records `outcome: "force_passed"` so the audit trail shows the ceremony was skipped. Intended for dev iteration; not normal use.

## Considered Options

| Option | Rejected Because |
|---|---|
| Launch Gate as automated-only check (no ceremony) | Surveillance theater; static checks don't earn trust |
| Fold into `review-discussion` | Different concerns (handoff resolution vs plan acceptance); muddies the existing stage |
| Make `planned` interactive at its tail | Breaks the autonomous nature of planning; harder to model in the router |
| Single consolidated `LAUNCH_GATE.md` artifact | Trinity is already distributed across plan + handoff (M2 Q1 decision); adding a fourth artifact duplicates state |

## Consequences

### Positive
- The user owns the launch moment — explicit sign-off, not silent passing.
- The user can adjust Blast Radius, edit Pre-Mortem, or request mitigation before launch.
- Audit trail records what was acknowledged, edited, or mitigated.
- `--force` escape hatch preserves dev velocity for trivial cases.
- The four user reactions cover every realistic response — there is no path where the user is *forced* through silent passage.

### Negative
- Adds a stop point to the auto-router. Trivial quests pay the ceremony cost.
- Re-running planning on mitigation is potentially slow.
- The skill must be carefully designed to feel like collaboration, not interrogation.

## Followups

- **M2 code**: create `skills/launch-review/SKILL.md`; add `launch-review` to `QuestStatus` (`lib.ts`); update `isValidTransition`; extend the router's status table to load the new skill.
- **M2 router**: implement Launch Gate verification at the `launch-review → executing` transition.
- **M2 compiler**: implement as a library callable from the skill so it can re-run after edits.

## References
- M2 grilling session.
- ADR 008 — Quest Auto-Routing (extended; `launch-review` joins the interactive stages).
- ADR 010 — Event Log (defines `launch_gate` event used here).
- Brainstorm: Claude's "Pre-Mortem Ceremony" pattern.
