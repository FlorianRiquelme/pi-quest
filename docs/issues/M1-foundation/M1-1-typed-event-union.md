# M1-1 — Typed 9-event union

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Establish a typed discriminated union for events written to the quest event log, replacing today's free-form `event: string` field. Nine kinds per ADR 010: `stage_entered`, `run_started`, `run_finished`, `run_orphaned`, `progress_beat`, `concession`, `anomaly_detected`, `launch_gate`, `rescue_invoked`.

Every event carries `timestamp` (ISO 8601), `questId`, and an open `details: Record<string, unknown>` slot for forward compatibility. The discriminator stays named `event` (preserves the existing field name) with snake_case values.

Refactor the telemetry tool to validate against the union. Rename existing emissions: `agent_run_completed` → `run_finished`; `rescue_invoked` stays. No back-compat — pi-quest is solo-developer pre-release, existing telemetry can be wiped.

## Acceptance criteria

- [ ] Discriminated union defined with runtime validator (Typebox or Zod)
- [ ] All existing emission sites in the extension produce the new shape
- [ ] The telemetry tool rejects payloads with an unknown `event` value
- [ ] Every event has `timestamp`, `questId`, and an extensible `details` field
- [ ] Unit tests assert each event variant round-trips through the audit log
- [ ] The schema matches ADR 010 exactly

## Blocked by

None — can start immediately.
