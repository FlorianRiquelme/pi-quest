# ADR 014: Run Anomaly Classification — Pause, Halt, Log-Only

## Status
Accepted

## Context

ADR 010 introduced `anomaly_detected` events with a free-form `rule` field. ADR 011 established that `out_of_scope_write` and `locked_out_write` (claims violations) log but do not pause runs — claims are advisory.

M3 grilling explored which other anomalies should pause execution. The space turned out to be three-tiered, not binary. This ADR locks the classification and the M3 baseline rule set.

## Decisions

### 1. Three-tier anomaly classification

Anomalies carry an explicit tier in their event payload.

| Tier | Fields on event | Action |
|---|---|---|
| **Pause** | `tier: "pause"`, `should_pause: true` | SIGTERM the run; mark `paused`; preserve worktree |
| **Halt** | `tier: "halt"` | Stop the specific quest-level operation (e.g., the failing merge); other runs continue |
| **Log-only** | `tier: "log"` | Append event; no action; surface in Homecoming Brief |

Every new anomaly rule must choose a tier.

### 2. New Run state: `paused`

The `Run.status` enum gains `paused`, joining `running | completed | failed | cancelled | orphaned`. A **Paused Run**:
- Was SIGTERM'd by the supervisor in response to a pause-tier anomaly.
- Preserves its worktree (not reaped) for inspection or future Resume.
- Emits `run_finished` with `status: "paused"` and `paused_reason: <rule>` for the audit log.

### 3. M3 baseline rules

#### Pause-tier (3 rules)

| Rule | Trigger | Detection | Default threshold |
|---|---|---|---|
| `lockfile_drift` | A lockfile is modified in the run's worktree | Supervisor polls `git diff --name-only` every ~30s | Any change to `pnpm-lock.yaml`, `bun.lock`, `yarn.lock`, `package-lock.json` |
| `unbounded_diff` | Cumulative diff exceeds size threshold | Supervisor polls `git diff --shortstat` every ~30s | 50 files OR 2000 lines |
| `heartbeat_missed` | No semantic `progress_beat` for X minutes; PID alive | Track timestamp of last non-`alive`-phase beat | 5 minutes |

#### Halt-tier (1 rule)

| Rule | Trigger | Action |
|---|---|---|
| `merge_conflict` | Run branch fails to auto-merge into the Quest Branch | Halt this one merge; other run merges continue; user resolves via dashboard or shell |

#### Log-only-tier (2 rules, existing from ADR 011)

| Rule | Trigger |
|---|---|
| `out_of_scope_write` | Write to a path not in any work-item's `claims:` |
| `locked_out_write` | Write to a path in `blast_radius.locked_out` |

### 4. User actions on a Paused Run

| Action | Behavior | M3? |
|---|---|---|
| **Discard** | Reap worktree; mark run `cancelled`; don't merge to Quest Branch | ✓ |
| **Force-Complete** | Keep worktree; merge to Quest Branch; mark run `completed` | ✓ |
| **Resume** | Re-spawn fresh subagent with continuation context (worktree state + anomaly + previous run's report) | M4 |

Resume requires carrying narrative across run boundaries — the same problem the Homecoming Brief (M4) solves. Designing them together avoids two parallel context-handoff systems.

### 5. Rule deferred to M4+

`repeated_test_failure` was considered but deferred. Detecting "same test failed 3+ times" requires deeper tool-call tracking inside subagent stdout (fragile parsing). M4 may revisit, possibly through agent self-reporting via `quest_concession` ("I've tried this test 3 times and it keeps failing").

## Consequences

### Positive
- Pause/Halt/Log split is explicit and extensible; new rules slot into a clear tier.
- Pause preserves work via worktree retention; no destructive auto-action.
- ADR 011's advisory-claims position is preserved — claims violations surface at homecoming, not as run interruptions.
- All 3 M3 baseline pause rules are implementable from existing primitives (git diff + event log + PID liveness).

### Negative
- Periodic git polling (~30s per active run) adds modest IO load.
- The `paused` state requires dashboard UI for Discard / Force-Complete flows.
- Tier classification adds documentation discipline for every new rule.

## Followups

- **M3 code**: implement per-run supervisor polling loop (lockfile + diff size); add `paused` to `BackgroundRunSummary.status` (`extensions/types.ts`); wire Discard / Force-Complete actions in the Dashboard.
- **M3 schema**: extend `anomaly_detected` event payload with `tier` and `should_pause` fields.
- **M4**: design Resume mechanic with continuation context (shared design with Homecoming Brief); consider promoting `repeated_test_failure`.

## References
- M3 grilling session.
- ADR 010 — Event Log (`anomaly_detected` event extended here).
- ADR 011 — Worktree Isolation (defines log-only rules; this ADR places them in the tier model).
- ADR 013 — Hearth Widget (paused runs trigger Needs-you mood).
