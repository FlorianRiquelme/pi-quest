# ADR 011: Worktree-Based Run Isolation

## Status
Accepted

## Context

M1 grilling considered two approaches to parallel **Run** safety: declared file claims with enforcement, vs. process-level isolation. Claims-based enforcement creates a chicken-and-egg problem: planning agents produce imperfect claims, which then either block valid execution (if strict) or do nothing (if advisory).

Git worktrees moot the question by giving each run its own working tree. Agents are free to touch any file they need; conflicts surface only at merge time, where git's tooling is well-suited and the user is already fluent.

## Decisions

### 1. Per-run git worktrees

Each background **Run** gets its own working tree under `.pi/quests/<questId>/worktrees/<runId>/`, created via `git worktree add` against the quest's **Base SHA**. The subagent's `cwd` is the worktree path.

### 2. Quest Branch as integration target

Each **Quest** has a dedicated **Quest Branch** named `quest/<questId>`, created from the **Base SHA** when the quest enters `executing`. All completed runs' work is merged into this branch. The Quest Branch is "all work for this quest" — `git checkout quest/<other-id>` switches user context between quests cleanly.

The user's working branch is **not** touched until they explicitly merge the Quest Branch after UAT.

### 3. Branch naming convention

| Branch | Pattern | Purpose |
|---|---|---|
| Quest Branch | `quest/<questId>` | Integration target per quest |
| Run Branch | `quest-run/<questId>/<runId>` | Per-run isolated work |

Two distinct prefixes because git's ref-store cannot host both `refs/heads/quest/<id>` (a file) and `refs/heads/quest/<id>/<run>` (which would require it to be a directory). Using `quest-run/` for run branches avoids the collision and keeps `git branch --list 'quest-run/<questId>/*'` discoverable.

### 4. Merge model

Per-run merge commits onto the Quest Branch: `git merge --no-ff quest-run/<id>/<runId>`. The merge graph itself is the audit trail of which run contributed what.

Merge conflicts surface as `anomaly_detected` events with `rule: "merge_conflict"` and halt that one merge. Other runs continue to merge independently. The user resolves via dashboard or shell.

### 5. `.pi/` location independence

Subagents run in worktree directories where `.pi/` does not exist. Tools resolve quest paths via the `PI_QUEST_HOME` env var (absolute path to the main checkout's `.pi/`), injected by `startSubagentRun` alongside the other `PI_QUEST_*` vars from ADR 010. The fallback for non-subagent calls walks up from `cwd` until it finds `.pi/quests/`.

### 6. Package-manager handling

pi-quest detects the project's package manager from lockfiles in this priority order: `pnpm-lock.yaml`, `bun.lock`, `yarn.lock`, `package-lock.json`. The matching install command runs in each new worktree before the subagent starts.

Disk economics:
- **pnpm and bun**: content-addressable global store → worktrees share underlying files. Cheap.
- **npm and classic yarn**: full `node_modules/` copy per worktree. Expensive.

pi-quest does not force a package manager. Projects with npm/yarn pay the disk cost; pnpm or bun is recommended for projects that will run pi-quest with parallelism.

### 7. Claims become advisory

The `claims:` field on `work-items/<id>.md` frontmatter survives but is **purely informational**:
- M2 renders it as the Blast Radius ("what does this work item intend to touch?").
- Runtime out-of-scope writes log `anomaly_detected` with `rule: "out_of_scope_write"` but do **not** pause the run. The user reviews them via the Concession Ledger at homecoming.
- Launch-time overlap detection is removed entirely; worktrees handle parallel safety.

### 8. Worktree-always policy

Even single-run quests get a worktree. Consistency wins; one code path instead of two; ~1s overhead per quest is invisible.

## Consequences

### Positive
- Parallel runs are inherently safe — no shared filesystem.
- Merge conflicts surface in git, where users already know how to resolve them.
- Each quest's work is contained in a single branch; quest switching is `git checkout`.
- User's working branch is untouched until they explicitly accept the Quest Branch.
- The Reaper extends naturally: orphaned runs → orphaned worktrees → `git worktree remove --force`.

### Negative
- Cost of `git worktree add` and `<pkg-mgr> install` per run (~5–30s, project-size dependent).
- Disk usage scales with concurrent runs × project size (heavily mitigated by pnpm/bun).
- Requires `PI_QUEST_HOME` discipline in every tool that touches `.pi/`.
- Conflicts in the merge step are a new failure surface.

## Followups

- **M1 code**: `extensions/worktree.ts` (create/remove/list/merge + Quest Branch lifecycle); `extensions/paths.ts` updated to honor `PI_QUEST_HOME` with walk-up fallback; `startSubagentRun` creates worktree, runs install, injects env, uses worktree as `cwd`.
- **M1 reaper**: extend to prune orphan worktrees alongside orphan runs.
- **M1 package-manager detection**: lockfile scan helper + dispatcher (`pnpm install` / `bun install` / `yarn install` / `npm install`).
- **M2**: render claims as Blast Radius in the pre-execution Trust Trinity; reinforce that claims are now advisory.

## References
- M1 grilling session.
- `extensions/git.ts` — currently `getCurrentBranch` / `getCurrentCommit` only; worktree helpers to be added.
- ADR 010 — Event log; `anomaly_detected` rules now include `merge_conflict` and `out_of_scope_write`.
- ADR 009 — In-process supervision (still holds; worktrees do not require a daemon).
