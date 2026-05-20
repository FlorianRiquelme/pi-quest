# M1-3 — Worktree-per-run end-to-end

> **TDD required**: write tests first (red), then implementation (green), then refactor. Acceptance criteria below are test specs — every checkbox must map to a passing test before this issue is closed.

## What to build

Implement per-run git worktrees per ADR 011. Each Run gets its own working tree under `.pi/quests/<questId>/worktrees/<runId>/`, checked out to a Run Branch named `quest-run/<questId>/<runId>`. The worktree is the subagent's `cwd`.

The Quest Branch `quest/<questId>` is created from the recorded **Base SHA** when the quest first enters `executing`. It is the merge target for all Run Branches. On Run completion, `git merge --no-ff <runBranch>` lands work on the Quest Branch. On merge failure: emit `anomaly_detected` with `tier: "halt"`, `rule: "merge_conflict"`; other runs' merges proceed independently.

Detect the project's package manager from lockfile presence (priority: `pnpm-lock.yaml`, `bun.lock`, `yarn.lock`, `package-lock.json`) and run the matching install in each new worktree before the subagent starts.

Inject `PI_QUEST_HOME` (absolute path to the main checkout's `.pi/`) so subagent tools find quest state from inside their worktree. Path resolution helpers gain a walk-up fallback when the env var isn't set.

Extend the startup reaper (from M1-2) to prune orphan worktrees via `git worktree remove --force` when no matching `runs/<id>.json` exists or the run has been reaped.

Claims (`claims:` field on work-items) remain advisory per ADR 011. No launch-time overlap enforcement; worktrees handle parallel safety.

## Acceptance criteria

- [ ] New worktree helper module exposes create / remove / list / merge operations
- [ ] On Run start: worktree created at the expected path; subagent runs inside it
- [ ] Quest Branch `quest/<questId>` is created from the Base SHA on quest entry to `executing`
- [ ] On Run completion: Run Branch is merged into Quest Branch via `git merge --no-ff`
- [ ] On merge failure: `merge_conflict` halt-tier anomaly is emitted; other runs' merges continue
- [ ] Package manager detected by lockfile; matching install runs in the new worktree
- [ ] `PI_QUEST_HOME` is injected into subagent env; tools consume it; path resolver walks up as fallback
- [ ] Reaper prunes orphan worktrees on extension startup
- [ ] An end-to-end multi-run quest demonstrates parallel runs each in their own worktree, all merging cleanly to the Quest Branch
- [ ] `git checkout quest/<other-id>` cleanly switches the user's context between quests

## Blocked by

M1-2.
