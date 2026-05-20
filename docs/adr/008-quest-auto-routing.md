# ADR 008: Quest Auto-Routing

The `/quest` command auto-advances the active quest through its stage pipeline without requiring the user to manually invoke skills. Autonomous stages (recon, planning, executing, verification) run as subagents with fresh context. Interactive stages (review-discussion, uat) load their skill instructions inline in the main session. The router never prompts for confirmation; it only stops when a stage fails or when human interaction is structurally required.

## Context

Skill invocations via `/skill:quest-*` are slow, cause context loss, and impose cognitive overhead: after each skill finishes, the user must remember what the next step is and which skill to invoke. This was documented in `docs/meta/skill-invocations-feedback.md`.

## Decision

Replace manual skill-by-skill invocation with a single `/quest` router command that:

1. Reads the active quest's `workflow.json` status.
2. Maps status → stage handler (recon, review-discussion, planning, executing, verification, uat).
3. Runs the stage.
4. Advances `workflow.json` status on success.
5. Continues to the next stage immediately.
6. Stops only on failure or when the stage is interactive.

## Considered Options

| Option | Rejected Because |
|--------|------------------|
| Keep skills, make them lighter | Doesn't solve the sequencing problem; user still has to remember what's next |
| Meta-skill that chains other skills | Subagents can't be interactive; review-discussion and uat need main-session chat |
| Fully automated including interactive stages | Would kill the Socratic back-and-forth that makes review-discussion valuable |
| `/quest advance` (one step at a time) | Still too much friction; the complaint is "I have to remember what to do next" |

## Consequences

### Positive
- One command drives the entire quest lifecycle.
- Autonomous stages get fresh context windows (no accumulation).
- Interactive stages preserve the back-and-forth UX where it matters.
- No cognitive overhead: the user never needs to remember the stage pipeline.

### Negative
- Interactive stages still accumulate context in the main session.
- The router reads only `workflow.json`; stage failures can be opaque if the subagent doesn't write a good report.
- `/quest` now has two modes: auto-router (when quest active) and status display (when explicit `/quest status`).

## Failure Policy

| Stage | Failure Behavior |
|-------|-----------------|
| recon, planning, verification | Halt immediately. Status unchanged. User investigates. |
| executing | Advance to `blocked`. Log telemetry. User investigates via dashboard. |
| review-discussion, uat | N/A — these don't "fail" in the subagent sense; they stop for human input. |

## No Active Quest

If `state.json` has no `currentQuestId`, `/quest` errors:

> No active quest. Create one with `/quest intake <handoff.md>` or select with `/quest select <id>`.

No auto-selection. No prompting.
