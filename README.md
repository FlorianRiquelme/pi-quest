# pi-quest

A pi package that turns shaped planning handoffs into implemented, verified, and user-tested repository changes.

**Design principle**: Planning happens outside pi (e.g., in Claude Code). `pi-quest` is the execution engine inside the repo.

## Install

From the repository root:

```bash
pi install ./pi-quest
```

Or try without installing:

```bash
pi -e ./pi-quest
```

## Quick Start

1. **Shape work outside pi** — produce a Markdown handoff in your repo.
2. **Run `/quest intake docs/plans/my-handoff.md`** — pi-quest copies it into a quest workspace, derives a quest ID, and sets up `.gitignore`.
3. **Run `/skill:quest-recon`** — cheap reconnaissance agent gathers repo evidence.
4. **Run `/skill:quest-review-discussion`** — GPT-5.5-class agent reviews the handoff, resolves blockers, and produces a `RESOLVED_HANDOFF.md`.
5. **Run `/skill:quest-planning`** — decomposes the resolved handoff into work items and an `IMPLEMENTATION_PLAN.md`.
6. **Run `/skill:quest-execution-orchestrator`** — reads the plan, runs implementation agents, calls rescue if needed.
7. **Run `/skill:quest-verification`** — verifies completed work against the plan.
8. **Run `/skill:quest-uat`** — writes a human acceptance test guide.

## Commands

| Command | Description |
|---------|-------------|
| `/quest` | Show active quest status |
| `/quest list` | List all quests |
| `/quest intake <handoff.md> [--id <id>]` | Create a new quest from a handoff |
| `/quest select <id>` | Switch active quest |
| `/quest set-status <id> <status> [--force]` | Update quest status |
| `/quest config` | Show merged quest configuration |

## Quest Workspace

Each quest gets a transient workspace under `.pi/quests/<quest-id>/`:

```
.pi/quests/<id>/
  workflow.json
  HANDOFF.md
  REFERENCES.md
  RECON.md
  REVIEW.md
  RESOLVED_HANDOFF.md
  IMPLEMENTATION_PLAN.md
  VERIFICATION.md
  UAT.md
  work-items/
  reports/
  fixes/
  telemetry/
    events.jsonl
    summary.json
  runs/
```

All operational state is `.gitignore`-d.

## Tools

These tools are available to the agent during quest execution:

| Tool | Purpose |
|------|---------|
| `quest_run_work_item` | Start an implementation subagent for one work item in the background; returns a run ID immediately |
| `quest_work_item_status` | Check background run status, report path, and report tail |
| `quest_rescue` | Spawn a rescue subagent for a blocked work item |
| `quest_write_workflow` | Read or update `workflow.json` with transition safety |
| `quest_telemetry_event` | Record a telemetry event |

## Status Model

```
intake → recon-ready → reviewing → resolved → planned → executing → verification-ready → uat-ready → completed
              ↓            ↓            ↓           ↓           ↓                ↓               ↓
         needs-resolution ← ← ← ← ← ← ← ← ← ← ← ← ← ← blocked ← uat-failed ← ← ← ← ← ← ← ←
```

## Configuration

Project config: `.pi/quest/config.json`  
Global config: `~/.pi/agent/quest/config.json`

Example:

```json
{
  "models": {
    "reviewDiscussion": "gpt-5.5",
    "executionOrchestrator": "openrouter/moonshotai/kimi-k2.6"
  }
}
```

## Package Structure

```
pi-quest/
  package.json          # pi package manifest
  lib.ts               # Shared types, defaults, ID derivation
  extensions/
    index.ts           # Main extension: commands + tools + subagent spawning
  skills/
    recon/SKILL.md
    review-discussion/SKILL.md
    planning/SKILL.md
    execution-orchestrator/SKILL.md
    implementation/SKILL.md
    rescue/SKILL.md
    verification/SKILL.md
    uat/SKILL.md
  agents/
    recon.md
    review-discussion.md
    planning.md
    execution-orchestrator.md
    implementation.md
    rescue.md
    verification.md
    uat.md
```

## License

MIT
