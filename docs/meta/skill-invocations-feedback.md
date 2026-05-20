# Skill Invocations — User Feedback

> **Living document.** Last updated: 2026-05-19
>
> This doc captures real friction observed when using pi's skill-invocation system. Update it as patterns change or as workarounds are found.

## Core Problem

Skill invocations (e.g. `<skill name="quest-recon" ...>`) are **slow** and **do not work well** in practice.

## Specific Friction Points

| # | Issue | Impact |
|---|-------|--------|
| 1 | **Slow** | Each invocation adds significant latency to the workflow. |
| 2 | **Context loss** | After a skill finishes, the conversation context is effectively reset. |
| 3 | **Manual reset required** | The user must manually reset / re-establish context after every skill invocation. |
| 4 | **Cognitive overhead** | The user then has to remember what they were doing and what the next step should be. |

## Resolution

**ADR 008** introduces a `/quest` auto-router that eliminates manual skill invocation:

- Autonomous stages (recon, planning, executing, verification) run as subagents with fresh context.
- Interactive stages (review-discussion, uat) load their skill instructions inline in the main session.
- The router advances `workflow.json` status automatically and continues to the next stage.
- No confirmation prompts. Stops only on failure or when human interaction is required.

See `docs/adr/008-quest-auto-routing.md` for full decision record.

## Open Questions / Experiments to Try

- [x] Can skill output be streamed inline instead of blocking? → Solved: subagents run with `--no-session`, output captured to `reports/*.md`.
- [x] Can the orchestrator preserve context across skill boundaries? → Solved: router never accumulates context; reads only `workflow.json`.
- [x] Would a lighter-weight "hint" system reduce latency? → Rejected: the real fix is removing the skill invocation entirely.
- [x] Can skills emit a compact handoff doc? → Solved: subagent reports are the handoff docs.

## Related

- This feedback was surfaced while running the `quest-review-discussion` skill for quest `dashboard-followup-handoff-2`.
