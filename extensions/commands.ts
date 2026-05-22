/**
 * /quest command handlers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	collisionSuffixed,
	DEFAULT_QUEST_CONFIG,
	deriveQuestId,
	generateTimestampId,
	QuestStatus,
	type QuestWorkflow,
} from "../lib.js";
import { ensureDir } from "./fs-utils.js";
import { getCurrentBranch, getCurrentCommit } from "./git.js";
import { ensureQuestBranch, getHeadSha } from "./worktree.js";
import {
	evaluateLaunchGate,
	readPlanFrontmatter,
	recordLaunchReviewSignOff,
	type LaunchGateResult,
} from "./launch-review.js";
import { questDirPath } from "./paths.js";
import { resolveReferences } from "./references.js";
import { getAllQuestIds, loadCurrentState, loadQuestWorkflow, saveCurrentState, saveQuestWorkflow } from "./state.js";
import type { CommandContext } from "./types.js";
import { emitStageEntered, validateEvent } from "./events.js";
import {
	generateHomecomingBrief,
	type NarrativeSpawnInput,
} from "./homecoming-brief.js";
import { runSubagent } from "./agents.js";
import { transitionStage, type StageTransitionResult } from "./stage-transition.js";
import type { EngageSkill } from "./skill-engagement.js";

/* ================================ Homecoming Brief (M4-1 / ADR 015) ================================ */

/**
 * Default narrative spawner — invokes the `quest-homecoming` subagent
 * (`agents/homecoming.md`) via the lightweight `runSubagent` helper. Tests can
 * override this via the {@link __setNarrativeSpawnerForTests} hook so they
 * don't shell out.
 */
let narrativeSpawner: (input: NarrativeSpawnInput, cwd: string) => Promise<string> = async (
	input,
	cwd,
) => {
	const task = [
		"Compose the Narrative section of the Homecoming Brief.",
		"Read the event log at:",
		`  ${input.eventLogPath}`,
		"Read run reports under:",
		`  ${input.reportsDir}`,
		"Quest ID: " + input.questId,
		"Output prose only — no headings, no bullets. 3–5 sentences, first person.",
	].join("\n");
	try {
		const result = await runSubagent({ cwd, agentName: "quest-homecoming", task });
		if (result.exitCode === 0 && result.stdout.trim().length > 0) {
			return result.stdout.trim();
		}
	} catch {
		/* fall through to template */
	}
	// Fallback when the agent didn't run (e.g. in environments without claude
	// available). Keep this neutral and short — the rest of the Brief still
	// carries the structural signal.
	return "_Narrative pending — the Homecoming Agent did not produce prose for this quest._";
};

/**
 * Test-only hook: override the narrative spawn to a stub that returns canned
 * prose. Production code never calls this.
 */
export function __setNarrativeSpawnerForTests(
	fn: (input: NarrativeSpawnInput, cwd: string) => Promise<string>,
): void {
	narrativeSpawner = fn;
}

/**
 * Regenerate the Homecoming Brief for `questId` and surface it via the UI.
 *
 * Best-effort: failures (missing quest, missing workflow, spawn error) are
 * swallowed so the caller's main path is never blocked by a Brief problem.
 * Returns the generated content (empty string if nothing was written).
 */
export async function regenerateHomecomingBrief(
	ctx: { cwd: string; ui: { notify: (msg: string, level?: "error" | "info" | "warning") => void } },
	questId: string,
	opts: { display?: boolean } = {},
): Promise<string> {
	try {
		const result = await generateHomecomingBrief({
			repoRoot: ctx.cwd,
			questId,
			spawnNarrativeAgent: (input) => narrativeSpawner(input, ctx.cwd),
		});
		if (opts.display && result.content) {
			ctx.ui.notify(result.content, "info");
		}
		return result.content;
	} catch {
		return "";
	}
}

/**
 * Update the per-quest `lastSeenEventTimestamp` pointer to `iso`. Creates the
 * map if missing.
 */
function updateLastSeenEventTimestamp(cwd: string, questId: string, iso: string): void {
	const state = loadCurrentState(cwd);
	const next = { ...state };
	const map = { ...(next.lastSeenEventTimestamp ?? {}) };
	map[questId] = iso;
	next.lastSeenEventTimestamp = map;
	saveCurrentState(cwd, next);
}

/**
 * Read the most recent event timestamp from a quest's events.jsonl. Returns
 * `undefined` if no events exist.
 */
function latestEventTimestamp(cwd: string, questId: string): string | undefined {
	const eventsPath = path.join(questDirPath(cwd, questId), "telemetry", "events.jsonl");
	if (!fs.existsSync(eventsPath)) return undefined;
	const raw = fs.readFileSync(eventsPath, "utf-8");
	let latest: string | undefined;
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const e = JSON.parse(t) as { timestamp?: string };
			if (typeof e.timestamp === "string") {
				if (latest === undefined || e.timestamp > latest) latest = e.timestamp;
			}
		} catch {
			/* skip */
		}
	}
	return latest;
}

export async function ensureGitignore(cwd: string) {
	const gitignorePath = path.join(cwd, ".gitignore");
	const lines: string[] = [
		"",
		"# pi-quest operational state",
		".pi/quests/",
		".pi/quest/state.json",
		".pi/quest/approvals.json",
	];
	let content = "";
	if (fs.existsSync(gitignorePath)) content = fs.readFileSync(gitignorePath, "utf-8");
	const missing = lines.filter((l) => !content.includes(l));
	if (missing.length > 0) {
		fs.writeFileSync(gitignorePath, content + missing.join("\n") + "\n", "utf-8");
	}
}

export async function showStatus(ctx: CommandContext) {
	const state = loadCurrentState(ctx.cwd);
	if (!state.currentQuestId) {
		ctx.ui.notify("No active quest. Create one with /quest intake <handoff.md>", "info");
		return;
	}
	const questDir = questDirPath(ctx.cwd, state.currentQuestId);
	const workflow = loadQuestWorkflow(questDir);
	if (!workflow) {
		ctx.ui.notify(`Quest '${state.currentQuestId}' data is missing.`, "error");
		return;
	}
	ctx.ui.notify(
		`${workflow.id}: ${workflow.status} | ${workflow.title} | Updated: ${workflow.updatedAt}`,
		"info",
	);
}

export async function listQuests(ctx: CommandContext) {
	const ids = getAllQuestIds(ctx.cwd);
	if (ids.length === 0) {
		ctx.ui.notify("No quests found.", "info");
		return;
	}
	const state = loadCurrentState(ctx.cwd);
	const items: string[] = [];
	for (const id of ids) {
		const wf = loadQuestWorkflow(questDirPath(ctx.cwd, id));
		const marker = state.currentQuestId === id ? "* " : "  ";
		const status = wf?.status ?? "?";
		const title = wf?.title ?? id;
		items.push(`${marker}${id} [${status}] ${title}`);
	}
	ctx.ui.notify("Quests:\n" + items.join("\n"), "info");
}

export async function cmdSelect(ctx: CommandContext, args: string[]) {
	const id = args[0];
	if (!id) {
		ctx.ui.notify("Usage: /quest select <id>", "warning");
		return;
	}
	const ids = getAllQuestIds(ctx.cwd);
	if (!ids.includes(id)) {
		ctx.ui.notify(`Quest '${id}' not found.`, "error");
		return;
	}
	saveCurrentState(ctx.cwd, { currentQuestId: id });
	ctx.ui.notify(`Active quest set to '${id}'`, "info");
}

export async function cmdSetStatus(
	ctx: CommandContext,
	args: string[],
	engageSkill?: EngageSkill,
) {
	const [id, newStatus] = args;
	if (!id || !newStatus) {
		ctx.ui.notify("Usage: /quest set-status <id> <status> [--force]", "warning");
		return;
	}
	const force = args.includes("--force");
	const result = await transitionStage(ctx, id, newStatus as QuestStatus, { force }, engageSkill);
	notifyTransitionOutcome(ctx, id, newStatus as QuestStatus, result);
}

/**
 * Surface a `transitionStage` result via `ctx.ui.notify`. Single outcome notify
 * per call: an "error" with the rejection reasons, or an "info" confirming the
 * new status (suppressed when the UAT doorbell already notified this tick).
 */
function notifyTransitionOutcome(
	ctx: CommandContext,
	questId: string,
	newStatus: QuestStatus,
	result: StageTransitionResult,
): void {
	if (result.outcome === "rejected") {
		const suffix = result.reason === "quest_not_found" ? "" : " Use --force to override.";
		ctx.ui.notify(result.message + suffix, "error");
		return;
	}
	// pi's notify queue collapses back-to-back same-level messages within a tick,
	// so the doorbell notify gets eaten by a generic status notify. When the
	// doorbell owned the notification this turn, stay quiet.
	if (!result.doorbellFired) {
		ctx.ui.notify(formatTransitionNotify(questId, newStatus, result.workflow), "info");
	}
}

/**
 * Compose the success notify for a stage transition. The Quest Branch and
 * Base SHA are captured on entry to `executing` (ADRs 011 §2 + 012) and then
 * persisted on the workflow forever. We surface them only on the transition
 * that lands in `executing` — otherwise the same audit anchors would leak
 * into every later notify (e.g. `executing → blocked`) even though that
 * transition didn't capture them. Outside `executing`, stay terse.
 */
function formatTransitionNotify(
	id: string,
	newStatus: QuestStatus,
	workflow: QuestWorkflow,
): string {
	const base = `Quest '${id}' status → ${newStatus}`;
	if (newStatus !== "executing") return base;
	const { questBranch, baseSha } = workflow;
	if (!questBranch || !baseSha) return base;
	return `${base}\nQuest Branch: ${questBranch} · Base SHA: ${baseSha.slice(0, 8)}`;
}

/**
 * Launch Review Accept (issue #3). Combines sign-off and the
 * `launch-review → executing` transition into one atomic skill action.
 *
 * Writes `launch_review.signed_off_at` to the plan frontmatter and then runs
 * the same `transitionStage` path the user would invoke via
 * `/quest set-status <id> executing`. The Launch Gate evaluates in
 * `transitionStage`, so a missing/incorrect Trinity surfaces inline (quest
 * stays at `launch-review`, reasons in the error notify). On gate-pass the
 * user sees a single info notify confirming the transition.
 *
 * The `--force` bypass (`/quest set-status <id> executing --force`) stays
 * unchanged — it does not call this function.
 */
export async function acceptLaunchReview(
	ctx: CommandContext,
	questId: string,
	planPath: string,
): Promise<StageTransitionResult> {
	recordLaunchReviewSignOff(planPath);
	const result = await transitionStage(ctx, questId, "executing", {});
	notifyTransitionOutcome(ctx, questId, "executing", result);
	return result;
}

/**
 * UAT Doorbell (ADR 016): single, one-shot multi-channel summons at the
 * `verification-ready → uat-ready` transition. Idempotent — once fired for a
 * quest, never fires again (even after uat-ready ↔ uat-failed loops).
 *
 * Channels:
 *  - Terminal bell (BEL = \x07) — silent on terminals with the bell disabled
 *  - OS notification via `ctx.ui.notify`
 *  - Widget mood shift — handled by M3-1, not wired here.
 *
 * The `ctx` parameter is intentionally structural so that this helper can be
 * called from both `CommandContext` (slash-command path) and `ToolContext`
 * (auto-router via `quest_write_workflow`).
 */
export function fireUatDoorbell(
	ctx: { ui: { notify: (msg: string, level?: "error" | "info" | "warning") => void } },
	workflow: QuestWorkflow,
	questDir: string,
	previousStatus: QuestStatus,
): boolean {
	if (previousStatus !== "verification-ready") return false;
	if (workflow.status !== "uat-ready") return false;
	if (workflow.uat_doorbell_fired_at) return false;

	// Channel 1: terminal bell. Use \x07 (BEL). Silent on terminals with the
	// bell disabled — that's an OS/terminal setting, nothing for us to do.
	process.stdout.write("\x07");

	// Channel 2: OS notification via pi's existing facility.
	const label = workflow.title && workflow.title.trim().length > 0 ? workflow.title : workflow.id;
	ctx.ui.notify(`UAT pending for ${label}`, "info");

	// Persist the idempotency marker.
	workflow.uat_doorbell_fired_at = new Date().toISOString();
	saveQuestWorkflow(questDir, workflow);
	return true;
}

/**
 * Auto-router branch (ADR 008 + ADR 012): advance from `planned` to
 * `launch-review` and load the Launch Review skill inline.
 *
 * Returns true if it advanced a stage OR if it displayed the Homecoming Brief
 * for new events (so the outer router can decide whether to keep going or stop
 * for interactive input). For M2-1 we only handle the `planned → launch-review`
 * transition; other stages remain on `showStatus`.
 *
 * M4-1 / ADR 015: also checks whether the active quest has events newer than
 * `lastSeenEventTimestamp[questId]`. If yes, regenerates and displays the
 * Homecoming Brief, then advances the pointer.
 */
export async function tryAutoRoute(
	ctx: CommandContext,
	engageSkill?: EngageSkill,
): Promise<boolean> {
	const state = loadCurrentState(ctx.cwd);
	if (!state.currentQuestId) return false;
	const questId = state.currentQuestId;
	const questDir = questDirPath(ctx.cwd, questId);
	const workflow = loadQuestWorkflow(questDir);
	if (!workflow) return false;

	if (workflow.status === "planned") {
		const previousStatus = workflow.status;
		workflow.status = "launch-review";
		workflow.updatedAt = new Date().toISOString();
		saveQuestWorkflow(questDir, workflow);
		emitStageEntered(questDir, questId, previousStatus, workflow.status);
		const engaged = engageSkill ? await engageSkill("quest-launch-review") : false;
		if (!engaged) {
			ctx.ui.notify(
				`Quest '${workflow.id}' entering Launch Review.\n` +
					`Run \`/skill:quest-launch-review\` to begin the Trust Trinity walkthrough. Accept inside the skill auto-transitions to executing once the Launch Gate passes; \`/quest set-status ${workflow.id} executing --force\` remains as an escape hatch.`,
				"info",
			);
		}
		return true;
	}

	// M4-1: Homecoming Brief auto-display on new state.
	const latest = latestEventTimestamp(ctx.cwd, questId);
	if (latest) {
		const seen = state.lastSeenEventTimestamp?.[questId];
		if (!seen || latest > seen) {
			const content = await regenerateHomecomingBrief(ctx, questId, { display: true });
			updateLastSeenEventTimestamp(ctx.cwd, questId, latest);
			if (content) return true;
		}
	}

	return false;
}

/**
 * `/quest brief` — always regenerate the Homecoming Brief for the active quest
 * and display its content. Advances the `lastSeenEventTimestamp` pointer so the
 * next `/quest` invocation doesn't re-trigger the auto-display path.
 */
export async function cmdBrief(ctx: CommandContext) {
	const state = loadCurrentState(ctx.cwd);
	if (!state.currentQuestId) {
		ctx.ui.notify("No active quest. Use /quest select <id> first.", "warning");
		return;
	}
	const questId = state.currentQuestId;
	const content = await regenerateHomecomingBrief(ctx, questId, { display: true });
	if (!content) {
		ctx.ui.notify(`Could not generate brief for '${questId}'.`, "error");
		return;
	}
	const latest = latestEventTimestamp(ctx.cwd, questId);
	if (latest) updateLastSeenEventTimestamp(ctx.cwd, questId, latest);
}

/**
 * Quest Branch capture (ADR 011 §2).
 *
 * On a quest's **first** transition into `executing`, record the current HEAD
 * of the main checkout as the Base SHA and create the Quest Branch
 * `quest/<questId>` from that SHA. Both pieces are persisted on the workflow
 * (`baseSha`, `questBranch`) so subsequent restarts and re-entries to
 * `executing` (e.g. blocked → executing) are no-ops.
 *
 * Mutates `workflow` in place when capture fires; the caller persists.
 */
export async function captureQuestBranchOnExecuting(
	cwd: string,
	workflow: QuestWorkflow,
	newStatus: QuestStatus,
): Promise<void> {
	if (newStatus !== "executing") return;
	if (workflow.baseSha && workflow.questBranch) return;

	const baseSha = await getHeadSha(cwd);
	const { questBranch } = await ensureQuestBranch({
		repoRoot: cwd,
		questId: workflow.id,
		baseSha,
	});
	workflow.baseSha = baseSha;
	workflow.questBranch = questBranch;
}

/**
 * Launch Gate (ADR 012). Runs at the `launch-review → executing` transition.
 *
 * On `--force`: skips checks, emits `outcome: "force_passed"` with reason
 * `user_forced`. Otherwise reads the plan frontmatter, calls
 * `evaluateLaunchGate`, emits `launch_gate` with the outcome and reasons, and
 * notifies the user when blocked. Either way the `launch_gate` event lands in
 * `telemetry/events.jsonl` so the audit trail records every Gate run.
 */
export function runLaunchGate(
	ctx: { ui: { notify: (msg: string, level?: "error" | "info" | "warning") => void } },
	questId: string,
	questDir: string,
	workflow: QuestWorkflow,
	force: boolean,
): LaunchGateResult {
	let result: LaunchGateResult;
	if (force) {
		result = { outcome: "force_passed", reasons: ["user_forced"] };
	} else {
		const planPath = path.join(questDir, workflow.artifacts.plan ?? "IMPLEMENTATION_PLAN.md");
		const fm = readPlanFrontmatter(planPath);
		result = evaluateLaunchGate(fm);
	}

	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	ensureDir(path.dirname(telemetryPath));
	const event = validateEvent({
		event: "launch_gate",
		timestamp: new Date().toISOString(),
		questId,
		outcome: result.outcome,
		reasons: result.reasons,
	});
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");

	if (result.outcome === "blocked") {
		ctx.ui.notify(
			`Launch Gate blocked: ${result.reasons.join(", ")}. Run the Launch Review skill or use --force to override.`,
			"error",
		);
	}
	return result;
}

export async function cmdIntake(ctx: CommandContext, args: string[]) {
	const handoffPath = args[0];
	if (!handoffPath) {
		ctx.ui.notify("Usage: /quest intake <path/to/handoff.md> [--id <id>]", "warning");
		return;
	}

	const resolvedHandoff = path.resolve(ctx.cwd, handoffPath);
	if (!fs.existsSync(resolvedHandoff)) {
		ctx.ui.notify(`Handoff not found: ${resolvedHandoff}`, "error");
		return;
	}

	const handoffContent = fs.readFileSync(resolvedHandoff, "utf-8");
	const firstLine = handoffContent.split("\n")[0]?.trim() ?? "";
	const titleMatch = firstLine.match(/^#+\s*(.+)/);
	const handoffTitle = titleMatch ? titleMatch[1] : undefined;

	const branch = await getCurrentBranch(ctx.cwd).catch(() => undefined);
	const optId = args.find((_a, i) => args[i - 1] === "--id");

	let candidateId = deriveQuestId({
		explicitId: optId,
		branch,
		handoffPath,
		handoffTitle,
	});
	if (!candidateId) candidateId = generateTimestampId();

	const existing = new Set(getAllQuestIds(ctx.cwd));
	const questId = collisionSuffixed(candidateId, existing);

	const questDir = questDirPath(ctx.cwd, questId);
	ensureDir(questDir);
	ensureDir(path.join(questDir, "work-items"));
	ensureDir(path.join(questDir, "reports"));
	ensureDir(path.join(questDir, "fixes"));
	ensureDir(path.join(questDir, "telemetry"));
	ensureDir(path.join(questDir, "runs"));

	fs.copyFileSync(resolvedHandoff, path.join(questDir, "HANDOFF.md"));

	const referencesMd = await resolveReferences(resolvedHandoff, handoffContent);
	if (referencesMd) {
		fs.writeFileSync(path.join(questDir, "REFERENCES.md"), referencesMd, "utf-8");
	}

	const now = new Date().toISOString();
	const workflow: QuestWorkflow = {
		id: questId,
		title: handoffTitle ?? questId,
		status: "intake",
		createdAt: now,
		updatedAt: now,
		source: {
			handoffPath,
			branch,
			commitAtIntake: await getCurrentCommit(ctx.cwd).catch(() => undefined),
		},
		artifacts: {
			handoff: "HANDOFF.md",
			recon: "RECON.md",
			review: "REVIEW.md",
			resolvedHandoff: "RESOLVED_HANDOFF.md",
			plan: "IMPLEMENTATION_PLAN.md",
			verification: "VERIFICATION.md",
			uat: "UAT.md",
			brief: "BRIEF.md",
		},
	};
	saveQuestWorkflow(questDir, workflow);
	saveCurrentState(ctx.cwd, { currentQuestId: questId });
	await ensureGitignore(ctx.cwd);

	ctx.ui.notify(
		`Quest '${questId}' intake complete. Status: intake.\n` +
			`Next: use /skill:quest-recon to run reconnaissance, or /skill:quest-review-discussion to begin review.`,
		"info",
	);
}

/**
 * `/quest resume <runId> [--note "..."]` — spawn a new Run that continues a
 * Paused Run (ADR 017 / M4-4).
 *
 * The active quest in `state.json` is used to resolve which quest owns the
 * paused run. Empty `--note` (or its absence) is forwarded as the empty string;
 * `resumeRun` applies the default fallback acknowledgment text.
 */
export async function cmdResume(ctx: CommandContext, args: string[]) {
	const runId = args[0];
	if (!runId) {
		ctx.ui.notify(
			'Usage: /quest resume <runId> [--note "acknowledgment text"]',
			"warning",
		);
		return;
	}
	const state = loadCurrentState(ctx.cwd);
	if (!state.currentQuestId) {
		ctx.ui.notify("No active quest. Use /quest select <id> first.", "warning");
		return;
	}
	const noteIdx = args.indexOf("--note");
	const note = noteIdx >= 0 && args[noteIdx + 1] !== undefined ? args[noteIdx + 1] : "";
	try {
		// Dynamic import avoids pulling resume.ts into the bundle when the
		// command isn't used; it also matches the pattern other modules
		// (e.g. dashboard-opener) use for lazy wiring.
		const { resumeRun } = await import("./resume.js");
		const result = await resumeRun({
			cwd: ctx.cwd,
			questId: state.currentQuestId,
			pausedRunId: runId,
			acknowledgment: note,
		});
		ctx.ui.notify(
			`Resumed: new run ${result.newRunId} continues ${runId} on ${result.runBranch}.`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(
			`Resume failed: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

export async function cmdDashboard(ctx: CommandContext) {
	const { openDashboard } = await import("./ui/dashboard-opener.js");
	await openDashboard(ctx);
}

export async function cmdConfig(ctx: CommandContext) {
	const projectConfigPath = path.join(ctx.cwd, ".pi", "quest", "config.json");
	const globalConfigPath = path.join(os.homedir(), ".pi", "agent", "quest", "config.json");
	let text = "Global config:\n";
	if (fs.existsSync(globalConfigPath)) text += fs.readFileSync(globalConfigPath, "utf-8");
	else text += "(not set)\n";
	text += "\nProject config:\n";
	if (fs.existsSync(projectConfigPath)) text += fs.readFileSync(projectConfigPath, "utf-8");
	else text += "(not set)\n";
	text += "\nDefaults:\n" + JSON.stringify(DEFAULT_QUEST_CONFIG, null, 2);
	ctx.ui.notify(text, "info");
}
