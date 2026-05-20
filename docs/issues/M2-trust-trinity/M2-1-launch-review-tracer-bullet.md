# M2-1 — Launch Review tracer bullet

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

End-to-end skeleton of the Launch Review interactive stage per ADR 012. The compiler rules and trinity content arrive in M2-2; this slice exercises the pipeline path.

Add `launch-review` to the QuestStatus enum, placed between `planned` and `executing` in the Stage Pipeline. Update transition validation to allow `planned → launch-review → executing` (and `launch-review → blocked` for cancel).

Create a new skill `skills/launch-review/SKILL.md` that loads inline in the main session (parallel to `review-discussion` and `uat`). For M2-1, the skill walks the user through three placeholder sections (Compiler diagnostics, Blast Radius, Pre-Mortem) — real content arrives in M2-2. User acceptance records sign-off in `IMPLEMENTATION_PLAN.md` frontmatter:

```yaml
launch_review:
  signed_off_at: "<iso8601>"
  signed_off_by: "user"
```

Implement the Launch Gate as an automated check at the `launch-review → executing` transition. Required for gate to pass: `blast_radius` exists in plan frontmatter, `pre_mortem` exists in plan frontmatter, `compiler_diagnostics` has zero `severity: error` entries, `launch_review.signed_off_at` exists. Emit `launch_gate` events with `outcome: "passed" | "blocked" | "force_passed"`. `/quest set-status <id> executing --force` bypasses with `force_passed`.

## Acceptance criteria

- [ ] `launch-review` is in the QuestStatus enum and transition whitelist
- [ ] `/quest` auto-routes from `planned` to `launch-review`
- [ ] `skills/launch-review/SKILL.md` exists and loads inline on stage entry
- [ ] User sign-off writes `launch_review.signed_off_at` to plan frontmatter
- [ ] Launch Gate blocks the transition if any of: missing `blast_radius`, missing `pre_mortem`, any `severity: error` in `compiler_diagnostics`, missing sign-off
- [ ] Launch Gate emits `launch_gate` event with `outcome` and `reasons[]`
- [ ] `--force` flag emits `outcome: "force_passed"` and bypasses checks
- [ ] An end-to-end quest can be driven from `planned` to `executing` via the ceremony

## Blocked by

M1-1.
