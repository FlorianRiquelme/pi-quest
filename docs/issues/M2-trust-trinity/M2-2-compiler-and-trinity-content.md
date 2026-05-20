# M2-2 — Handoff Compiler + Blast Radius + Pre-Mortem content

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Implement the Handoff Compiler as a library called from the Launch Review skill. The compiler cross-references `RESOLVED_HANDOFF.md` against `IMPLEMENTATION_PLAN.md` and writes a `compiler_diagnostics:` array into the plan's frontmatter. Each diagnostic has `severity` (`error` | `warning` | `info`), `rule`, `message`, and optional `work_item`.

**Seven starter rules** (per ADR 010 / M2 Q2):

| Rule | Severity |
|---|---|
| `unaddressed_requirement` | error |
| `unknown_dependency` | error |
| `cyclic_dependencies` | error |
| `missing_acceptance_criteria` | error |
| `missing_verification` | warning |
| `empty_claims` | warning |
| `untraced_uat_scenario` | warning |

The `## Acceptance Criteria` section is now required in `RESOLVED_HANDOFF.md` with labeled items (e.g., `- [R1] User can log in with OAuth`). The review-discussion skill or agent must produce this section.

Update the planning agent's system prompt (`agents/planning.md`) to require:
- `blast_radius:` in plan frontmatter — `in_scope` auto-aggregated from work-item `claims:`, `locked_out` explicitly planner-declared
- `pre_mortem:` in plan frontmatter — singular `most_likely_failure` / `detection_signal` / `recovery_plan` strings

Add the new `locked_out_write` log-only anomaly rule to the supervisor: when a run writes to a path in `blast_radius.locked_out`, emit `anomaly_detected` with `tier: "log"`, `rule: "locked_out_write"`. Does not pause.

Extend the Launch Review skill to display all three trinity pieces meaningfully (replacing M2-1 placeholders) and support inline edits to Pre-Mortem text.

## Acceptance criteria

- [ ] Compiler library exposes a function returning `Diagnostic[]` for a given plan + resolved-handoff pair
- [ ] All 7 rules produce diagnostics with `severity`, `rule`, `message`, optional `work_item`
- [ ] `compiler_diagnostics:` is written to plan frontmatter on each compiler run
- [ ] Planning agent emits `blast_radius` (aggregated + planner-declared) and `pre_mortem` (three strings)
- [ ] Launch Review skill renders compiler diagnostics, Blast Radius, and Pre-Mortem
- [ ] User can edit Pre-Mortem text inline via the skill; `pre_mortem_edits` recorded in frontmatter
- [ ] `locked_out_write` log-only anomaly fires when a run writes to a locked-out path
- [ ] `unaddressed_requirement` error blocks the Launch Gate
- [ ] At least one warning (`empty_claims`) surfaces and is acknowledgeable
- [ ] Acknowledged warnings are recorded in `launch_review.acknowledged_warnings`

## Blocked by

M2-1.
