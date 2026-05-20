# Issue: Quest workflow allows execution orchestrator to skip verification gate

## Summary

`quest-execution-orchestrator` can transition a quest from `executing` directly to `verification-ready` before the `quest-verification` agent runs. This allowed a quest to appear verification-ready without a `VERIFICATION.md` artifact and without GPT-5.5 verification.

## Observed Behavior

In `agenttournaments` quest `handoff-xxxxxx-md-coafpkirma`:

- Work item reports existed.
- `workflow.json` status was `verification-ready`.
- `.pi/quests/handoff-xxxxxx-md-coafpkirma/VERIFICATION.md` did not exist.
- Later manual review found material issues:
  - New packages and files were untracked in git.
  - Event-log Zod schemas did not match engine-emitted events.
  - Some emitted event types were absent from `LogEventSchema`.
  - Wolf debate ordering did not enforce alpha-first order.

## Expected Behavior

The quest should not reach `verification-ready` until the `quest-verification` agent has:

1. Read `RESOLVED_HANDOFF.md`, `IMPLEMENTATION_PLAN.md`, work items, and reports.
2. Sampled the actual repository diff.
3. Run relevant tests/typechecks/lint.
4. Compared implementation against acceptance criteria.
5. Written `VERIFICATION.md`.
6. Rendered a verdict.

Only then should a passing quest transition to `verification-ready`.

## Root Cause

There is a state-model / skill-instruction mismatch.

`lib.ts` currently allows:

```ts
executing: ["blocked", "verification-ready"],
"verification-ready": ["uat-ready"],
```

`skills/execution-orchestrator/SKILL.md` instructs:

```md
4. After all batches complete, update the quest workflow status to `verification-ready`.
```

But `skills/verification/SKILL.md` also says verification writes `VERIFICATION.md` and on pass updates status to `verification-ready`.

This means the execution orchestrator can set the same state that verification is supposed to set, effectively bypassing the verification gate.

## Proposed Fix

Add an intermediate state between implementation and verification, for example `implemented` or `awaiting-verification`.

Suggested lifecycle:

```text
planned → executing → implemented → verification-ready → uat-ready → completed
```

Suggested transition changes:

```ts
executing: ["blocked", "implemented"],
implemented: ["executing", "blocked", "verification-ready"],
"verification-ready": ["uat-ready"],
```

Then update skills:

### `skills/execution-orchestrator/SKILL.md`

```diff
- 4. After all batches complete, update the quest workflow status to `verification-ready`.
+ 4. After all batches complete, update the quest workflow status to `implemented`.
+ 5. Hand off to the Verification Agent (`quest-verification`).
```

### `skills/verification/SKILL.md`

Clarify that verification runs from `implemented`, writes `VERIFICATION.md`, and only on `pass` transitions to `verification-ready`.

## Additional Guardrail

`quest_write_workflow` could enforce artifact preconditions:

- Transition to `verification-ready` requires `VERIFICATION.md` to exist.
- Transition to `uat-ready` requires `UAT.md` to exist.
- Transition to `completed` may require explicit user confirmation or UAT verdict.

This would prevent future agent prompt bugs from bypassing lifecycle gates.

## Acceptance Criteria

- Execution orchestrator can no longer set `verification-ready` directly after work-item execution.
- A quest cannot become `verification-ready` unless `VERIFICATION.md` exists.
- `quest-verification` is the only standard path that transitions implementation work to `verification-ready`.
- README status model, `lib.ts` transitions, and skill docs agree on the lifecycle.
- Existing tests are updated or added for valid/invalid status transitions.
