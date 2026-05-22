# ADR 018: Batch Closeout Protocol

## Status
Accepted

## Context

The Execution Orchestrator (skill: `quest-execution-orchestrator`) launches Runs in Batches and then expects to advance on its own when the Batch finishes. In practice the conversation goes silent after `quest_run_work_item` returns: the Orchestrator has no signal that "all Runs in this Batch terminated", so the user has to manually type "check status" to make progress. Issue #13.

In parallel, the supervisor's `lockfile_drift` pause-tier rule (ADR 014 §3) was SIGTERM'ing legitimate monorepo Runs at the 4-minute mark because `bun install` correctly rewrote `bun.lock` to add a new workspace package. Three out of four Runs ended `cancelled`/`failed`; the fourth completed only by racing the 30-second poll. Issue #14.

Both bugs make the AFK promise of pi-quest hollow. The user babysits or comes back to a partially-killed Batch.

A third issue is a subtle race uncovered while designing this fix: the supervisor's `pauseRun` writes `paused` to disk, then the runner's `close` handler fires (the SIGTERM closed the child) and writes `cancelled`, clobbering the `paused` state. Paused Runs show as cancelled in the dashboard.

## Decisions

### 1. Batch Closeout: auto-advance via synthetic message

When **all** Runs in a Batch reach a terminal status (`completed | failed | cancelled | paused | orphaned`) **in the same pi session that launched them**, an in-process watcher delivers a hidden synthetic message:

```ts
pi.sendMessage(
  { customType: "quest-batch-closeout", display: false, content: ..., details: payload },
  { triggerTurn: true },
);
```

`display: false` keeps the chat history quiet — the Hearth Widget remains the user's primary peripheral signal. `triggerTurn: true` re-engages the Orchestrator without user input.

Payload, per Run in the Batch:
```ts
{ workItemId, runId, status, reportPath, anomalyTier?, anomalyRule?, lastBeatPhase? }
```

The Orchestrator is instructed by its skill prompt to treat the message as authoritative — read each `reportPath` and decide retry / rescue / advance from a complete Batch picture.

### 2. Tool surface: required `batchId` + `batchSize`

`quest_run_work_item` gains two required parameters:

- `batchId: string` — Orchestrator-assigned grouping ID. Same on every call in the Batch (e.g. `batch-<questId>-<timestamp>`).
- `batchSize: number` (≥ 1) — total Run count the Orchestrator commits to launching for the Batch.

A pure `validateBatchSizeConsistency` at the tool boundary rejects mismatched declarations and emits a `batch_size_drift` halt-tier anomaly (registered in ADR 014's 2026-05-22 amendment).

### 3. In-session-only Closeout; Homecoming Brief owns the rest

A Batch is eligible for in-session Closeout iff `min(run.completedAt for run in batch) >= extensionStartTime`. Otherwise the Closeout is suppressed and the Homecoming Brief (ADR 015) integrates the Batch's outcomes through pi-quest's canonical cross-session narrative artifact.

Dedupe is two-layered:
- **Durable**: a `batch_closeout` event in `events.jsonl` for the `batchId` short-circuits any future fire.
- **In-process**: a `Set<batchId>` short-circuits within-process redeliveries (e.g., `fs.watch` double-fires).

### 4. Kill `lockfile_drift`

The pause-tier rule and its supporting code (`LOCKFILE_NAMES`, `checkLockfileDrift`, the literal in the `PauseRule` union) are removed. Monorepo `bun install` rewriting a lockfile is correct behavior; the supervisor was punishing it. Real dependency tampering surfaces at merge time (Worktree Isolation, ADR 011) and in the Homecoming Brief.

### 5. `STATUS_RANK` precedence lattice

A small precedence map disambiguates concurrent terminal-status writes:

```
paused > cancelled > failed > completed > running
```

Every terminal-status writer consults `shouldOverwriteStatus(current, proposed)` after re-reading the on-disk summary. `orphaned` is sealed (outside the lattice): once the orphan reaper at `session_start` writes it, no later write may overwrite. The lattice fixes the paused-vs-cancelled race so Paused Runs consistently surface as `paused` everywhere.

### 6. Resume reuses the Closeout pipeline

Resume (ADR 017) synthesizes its own `batchId = "resume-<originalRunId>"` and `batchSize = 1` on the new Run's summary. The standard watcher + decider fires a Batch-of-1 Closeout when the resumed Run terminates — no special-casing in the runner.

## Consequences

### Positive
- Fire-and-forget Batches: the Orchestrator advances automatically when the Batch finishes (story 1).
- Monorepo `bun install` no longer SIGTERMs legitimate Runs (story 6).
- Paused Runs reliably surface as `paused` (story 7, story 12).
- One protocol handles both Orchestrator Batches and Resume; no parallel mechanism for single Runs.
- Audit trail: `batch_closeout` events with `delivered: true | false` answer "why didn't the Orchestrator advance?" from logs alone (story 14).

### Negative
- The Orchestrator must generate a `batchId` per Batch and declare an accurate `batchSize` — drift surfaces as a `batch_size_drift` halt anomaly.
- `fs.watch` over runs directories adds modest IO load; the polling fallback (5s) is the safety net on `EMFILE`/`ENOSPC`.
- Cross-session work surfaces only through the Homecoming Brief, not through a delayed Closeout — explicit choice to keep the Closeout protocol simple and to keep the Brief as the canonical narrative.

## Followups

- **Issue #15 PR** implements all six decisions atomically (the user chose full refactor over phased hotfix).
- **CONTEXT.md** gains `Batch` and `Batch Closeout` glossary entries; the `Paused Run` entry references `STATUS_RANK`.
- **ADR 010** Amendments section registers `batch_closeout` as a typed event variant.
- **ADR 014** 2026-05-22 amendment removes `lockfile_drift` and registers `batch_size_drift` as a halt-tier rule.

## References
- Issue #13 — orchestrator stalls after launching a Batch.
- Issue #14 — supervisor SIGTERMs legitimate Runs on lockfile mutation.
- ADR 010 — event log; this protocol adds `batch_closeout`.
- ADR 011 — Worktree Isolation; dependency tampering surfaces at merge time.
- ADR 014 — Anomaly classification; amended here.
- ADR 015 — Homecoming Brief; canonical cross-session narrative.
- ADR 017 — Resume mechanic; reuses the Closeout pipeline as a Batch-of-1.
- pi-subagents `src/runs/background/{notify,result-watcher,completion-dedupe}.ts` — inspiration for the triggerTurn-driven pattern.
