# Quest Router Design

> Auto-routing command that drives a quest through its stage pipeline.

## Overview

The `/quest` command (bare, no subcommand) reads the active quest's `workflow.json` status and runs the appropriate stage handler. It replaces the manual sequence of `/skill:quest-recon`, `/skill:quest-review-discussion`, `/skill:quest-planning`, `/skill:quest-execution-orchestrator`, `/skill:quest-verification`, `/skill:quest-uat`.

## Command Mapping

| Workflow Status | Stage Handler | Mode | Next Status on Success |
|-----------------|---------------|------|------------------------|
| `intake` | Recon Agent (subagent) | Autonomous | `recon-ready` |
| `recon-ready` | Review-Discussion (inline skill) | Interactive | `resolved` |
| `resolved` | Planning Agent (subagent) | Autonomous | `planned` |
| `planned` | Execution Router (built-in) | Autonomous | `verification` |
| `verification` | Verification Agent (subagent) | Autonomous | `verification-ready` |
| `verification-ready` | UAT Agent (inline skill) | Interactive | `uat-ready` |
| `uat-ready` | — | — | `completed` (manual or auto?) |

## Autonomous Stage Execution

1. Read `workflow.json` to get current status.
2. Map status → agent name (from `agents/*.md` definitions).
3. Spawn subagent via `pi --mode json -p --no-session` with the agent's system prompt.
4. Capture stdout/stderr to `runs/*.log`.
5. On exit 0: advance status, delete `runs/*.json` temp files, continue.
6. On non-zero: halt. Notify user. Status unchanged.

The router reads **only** `workflow.json`. It does NOT read handoffs, plans, or reports. The subagent reads its own inputs.

## Interactive Stage Execution

1. Read the stage's `SKILL.md` file.
2. Present the skill instructions inline to the user: "The next stage is `<stage>`. Here are your instructions: ..."
3. The main-session agent follows those instructions.
4. When the stage completes (user says "done" or the skill's stop condition is met), the router advances status.
5. The router immediately continues to the next stage (or halts if it's autonomous and fails).

## Execution Stage

The execution stage is special. It is built into the router, not a subagent:

1. Read `IMPLEMENTATION_PLAN.md` and `work-items/*.md`.
2. For each batch:
   a. Launch all work items via `quest_run_work_item`.
   b. Return control to user with run IDs.
   c. On next `/quest` invocation, check `quest_work_item_status` for each run.
   d. If all completed: advance to `verification`.
   e. If any failed: advance to `blocked`.

This preserves the existing execution model (background runs, non-blocking) while removing the manual orchestration step.

## Failure Policy

| Stage | On Failure |
|-------|------------|
| recon | Halt. Status: `intake`. |
| planning | Halt. Status: `resolved`. |
| executing | Advance to `blocked`. |
| verification | Halt. Status: `verification` (or `blocked`). |
| review-discussion | N/A — interactive. User decides when done. |
| uat | N/A — interactive. User decides when done. |

## No Active Quest

```
/quest
> No active quest. Create one with /quest intake <handoff.md>
> or select with /quest select <id>.
```

No auto-selection. No prompting.

## Context Budget

The router itself reads only `workflow.json` and `state.json` (~500 bytes total). All large file reads happen inside subagents (fresh context) or skills (main session, but user is already engaged). This avoids the context accumulation problem that made `/skill:` invocations painful.
