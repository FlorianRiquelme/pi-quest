# M3-3 — Anomaly polling + pause + Dashboard actions

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Implement the M3 baseline anomaly classification per ADR 014. Add a per-run supervisor polling loop that runs every ~30s while a Run is in `running` status. Three pause-tier rules:

| Rule | Trigger | Detection | Default threshold |
|---|---|---|---|
| `lockfile_drift` | A tracked lockfile modified | `git diff --name-only` in worktree | Any change to `pnpm-lock.yaml`, `bun.lock`, `yarn.lock`, `package-lock.json` |
| `unbounded_diff` | Cumulative diff exceeds threshold | `git diff --shortstat` in worktree | 50 files OR 2000 lines |
| `heartbeat_missed` | Semantic beats gone, PID alive | Compare last non-`alive`-phase `progress_beat` to now | 5 minutes |

On any pause trigger: emit `anomaly_detected` with `tier: "pause"`, `should_pause: true`, `rule`, `details`. SIGTERM the run (5s grace → SIGKILL); update its `runs/<runId>.json` to `status: "paused"`; preserve the worktree. Emit `run_finished` with `status: "paused"` and `paused_reason: <rule>`. Extend the Run status enum and `BackgroundRunSummary.status` with `paused`.

Update the dashboard: a Paused Run row shows its anomaly reason. Wire two actions (Resume is deferred to M4-4):
- **Discard** — reap the worktree, mark run `cancelled`, don't merge to Quest Branch
- **Force-Complete** — merge the Run Branch to Quest Branch as-is, mark run `completed`

`out_of_scope_write` and `locked_out_write` rules (already defined per ADR 011 / M1-3 / M2-2) remain log-only — they do not pause.

## Acceptance criteria

- [ ] Supervisor polls each active run every ~30s
- [ ] `lockfile_drift` triggers on any tracked lockfile change in the worktree
- [ ] `unbounded_diff` triggers when diff exceeds 50 files OR 2000 lines
- [ ] `heartbeat_missed` triggers after 5 min of no non-`alive` `progress_beat` while PID alive
- [ ] Triggered runs receive SIGTERM, transition to `paused`, preserve their worktree
- [ ] `anomaly_detected` event has correct `tier`, `should_pause`, `rule`, and rule-specific `details`
- [ ] `BackgroundRunSummary.status` includes `paused`
- [ ] Dashboard renders Paused Runs with reason; Discard and Force-Complete actions work end-to-end
- [ ] `out_of_scope_write` and `locked_out_write` continue to log-only (no pause)

## Blocked by

M1-2, M1-3.
