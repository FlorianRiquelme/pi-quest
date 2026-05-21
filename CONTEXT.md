# pi-quest

Execution engine that turns shaped planning handoffs into implemented, verified, and user-tested repository changes.

## Language

**Quest**:
A scoped body of work derived from a single handoff, tracked through a lifecycle from intake to completion.
_Avoid_: Project, task, job

**Handoff**:
A markdown document produced outside pi that describes planned work, constraints, and acceptance criteria.
_Avoid_: Spec, brief, ticket

**Work Item**:
A single deliverable unit within an implementation plan, assigned to an implementation agent for execution.
_Avoid_: Subtask, ticket, issue

**Workflow Status**:
The current lifecycle stage of a quest (e.g., intake, executing, verification-ready, completed).
_Avoid_: State, phase

**Stage Pipeline**:
The ordered sequence of workflow statuses a quest traverses, from intake through completion.
_Avoid_: Funnel, pipeline (unqualified)

**Stage Transition**:
A controlled advance of a **Quest** from one **Workflow Status** to the next along the **Stage Pipeline**. Owns the structural checks (validity of the transition, the verification-artifact gate, the **Launch Gate**), the **Quest Branch** capture on first entry to `executing`, the workflow write, the `stage_entered` audit event, and downstream side effects (UAT doorbell, **Homecoming Brief** regeneration on autonomous-to-interactive boundaries). Triggered from the `/quest set-status` command and the `quest_write_workflow` tool. Emergency stops (hard freeze) write a terminal status directly and do not go through a Stage Transition.
_Avoid_: Status change, status update, FSM transition, set-status

**Artifact**:
A file produced during a quest lifecycle that captures domain knowledge or decisions (e.g., HANDOFF, RECON, PLAN, VERIFICATION, UAT).
_Avoid_: Document, output, deliverable

**Widget**:
The persistent two-line display above the editor that surfaces the active **Quest**'s state at a glance. Designed as a "Hearth": dim by default, colored and rhythmic when active, with a small mood vocabulary (Resting, Cruising, Working hard, Stuck, Needs you) so the user can read it peripherally without reading text. Line 1 carries the mood; line 2 carries detail including the Two Clocks (`wall / compute`).
_Avoid_: Status bar, panel, cockpit, mission control

**Dashboard**:
The interactive split-pane overlay for browsing all quests and inspecting their details, artifacts, and work-item runs.
_Avoid_: Overview, summary view

**Autonomous Stage**:
A quest stage that runs as a non-interactive subagent with a fresh context window. The router spawns it, captures output, and advances status automatically.
_Avoid_: Background stage, headless stage

**Interactive Stage**:
A quest stage that requires back-and-forth conversation with the user in the main session. The router loads its skill instructions inline.
_Avoid_: Manual stage, user stage

**Run**:
A single background execution of an implementation or rescue agent against a work item.
_Avoid_: Attempt, iteration, execution

**Orphaned Run**:
A **Run** whose process is no longer reachable, but whose final status was never recorded (e.g. pi crashed or quit mid-execution). On extension startup a reconciliation pass detects orphaned runs and promotes them out of `running`.
_Avoid_: Stale run, dead run, zombie

**Paused Run**:
A **Run** that was SIGTERM'd by the supervisor in response to a pause-tier **Anomaly** (e.g. lockfile drift, unbounded diff, missed semantic beats). Its **Run Worktree** is preserved; the user resolves it via Discard, Force-Complete, or Resume.
_Avoid_: Halted run, suspended run, stopped run

**Progress Beat**:
A periodic event emitted from a **Run** that describes its current phase. Two flavours: a **semantic** beat (rich `phase`/`confidence`/`note`, emitted by the agent via the `quest_progress_beat` tool) and a **synthetic** beat (`phase: "alive"`, emitted by the parent supervisor when explicit beats have been silent for ~60s and the process is still reachable). The **Widget** reads beats to render liveness; the supervisor watches gaps between beats to detect anomalies.
_Avoid_: Heartbeat (overloaded), pulse, tick

**Concession**:
A judgment call made silently by an autonomous **Run** without asking the user — for example, choosing one of two reasonable interpretations of a **Handoff**. Each concession is emitted as an event with `decision` and `rationale` fields; the collected concessions surface in the Homecoming summary so the user can review and overrule.
_Avoid_: Assumption, decision (unqualified), shortcut

**Anomaly**:
A supervisor-detected condition during a **Run** that warrants attention. Classified into three tiers: **pause** (SIGTERM the run, creating a **Paused Run**; user resolves), **halt** (stop a specific quest-level operation such as a merge; other runs continue), and **log-only** (append event; no action; surface at homecoming). Each `anomaly_detected` event carries its tier and the rule that triggered it.
_Avoid_: Error, exception, alert (unqualified)

**Base SHA**:
The git commit a **Quest** forked from, recorded when the quest enters `executing`. The **Quest Branch** and all **Run Worktrees** are created from this SHA. The Base SHA is the audit anchor for "what did this quest start from?"
_Avoid_: Origin commit, parent SHA

**Quest Branch**:
The git branch (`quest/<questId>`) that integrates all completed **Runs** for a single **Quest**. Created from the **Base SHA** when the quest enters `executing`. Switching context between quests is `git checkout quest/<other-id>`. The user's own working branch is not touched until the Quest Branch is explicitly merged after UAT passes.
_Avoid_: Staging branch, integration branch (unqualified), feature branch

**Run Worktree**:
The isolated git worktree (`.pi/quests/<questId>/worktrees/<runId>/`) where a single **Run** executes. Created from the **Base SHA**, checked out to `quest-run/<questId>/<runId>`. Reaped on **Run** completion or by the orphan-reaper on startup.
_Avoid_: Sandbox, working copy

**Trust Trinity**:
The three pre-execution declarations a **Quest** must produce before agents run: (1) the Handoff Compiler's diagnostics, (2) the Blast Radius (`in_scope` and `locked_out`), (3) the Pre-Mortem (most-likely failure, detection signal, recovery plan). All three live in `IMPLEMENTATION_PLAN.md` frontmatter. The **Launch Review** is the ceremony where the user engages with them; the **Launch Gate** is the structural check that follows.
_Avoid_: Pre-flight, sign-off package, gate checks (unqualified)

**Launch Review**:
The **Interactive Stage** between `planned` and `executing` where the user walks through the **Trust Trinity**, addresses any errors, edits the Pre-Mortem if needed, and signs off before any **Run** is spawned. Sign-off is recorded in `IMPLEMENTATION_PLAN.md` frontmatter under `launch_review:`; without it the **Launch Gate** stays closed.
_Avoid_: Approval, gating, review (unqualified)

**Launch Gate**:
The automated structural check that runs at the `launch-review → executing` transition. Verifies that all **Trust Trinity** pieces exist in plan frontmatter, the Handoff Compiler reported no errors, and the **Launch Review** sign-off is present. Emits a `launch_gate` event with `outcome: "passed"` or `"blocked"` plus reasons. A `--force` override emits `outcome: "force_passed"`.
_Avoid_: Validation, check, guard (unqualified)

**Homecoming Brief**:
The workspace **Artifact** (`.pi/quests/<questId>/BRIEF.md`) that greets the user when they return to a **Quest** after autonomous work has progressed. Six sections: title bar (with Two Clocks), narrative paragraph composed by a homecoming agent, **Concession** ledger, **Anomaly** list, quantified-relief receipt, next-action pointer. Generated automatically at autonomous-to-interactive transitions and when `/quest` is invoked with new state since the last view.
_Avoid_: Summary, report, postmortem

**Reverse Prompting**:
The structured walkthrough by which the UAT skill drives the user through acceptance scenarios — one scenario at a time, with explicit `setup` commands (displayed as copy-pasteable), `actions`, and `verify` steps. Each scenario asks a four-way prompt (pass / fail / n/a / skip). Minimizes cognitive load at the user's most fatigued moment.
_Avoid_: Walkthrough (unqualified), interview, checklist

## Relationships

- A **Quest** is created from one **Handoff**
- A **Quest** has one **Workflow Status** at any time, progressing through the **Stage Pipeline** via **Stage Transitions**
- A **Quest** produces multiple **Artifacts** across its lifecycle
- An **Implementation Plan** breaks a **Quest** into multiple **Work Items**
- Each **Work Item** may have zero or more **Runs**
- The **Widget** displays exactly one **Quest** (the active one)
- The **Dashboard** displays all **Quests** and lets the user inspect any of them

## Example dialogue

> **Dev:** "When a **Quest** moves to `executing`, should the **Widget** show every **Run** or just the count?"
> **Domain expert:** "Just the count. The **Dashboard** is where you drill into individual **Runs** and read their reports. The **Widget** is glance-only."
>
> **Dev:** "If a **Work Item** fails and gets rescued, does that create a new **Run**?"
> **Domain expert:** "Yes — each invocation of the implementation or rescue agent is a distinct **Run**, logged separately."
