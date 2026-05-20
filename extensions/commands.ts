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
	isValidTransition,
	QuestStatus,
	type QuestWorkflow,
} from "../lib.js";
import { ensureDir } from "./fs-utils.js";
import { getCurrentBranch, getCurrentCommit } from "./git.js";
import {
	evaluateLaunchGate,
	readPlanFrontmatter,
	type LaunchGateResult,
} from "./launch-review.js";
import { questDirPath } from "./paths.js";
import { resolveReferences } from "./references.js";
import { getAllQuestIds, loadCurrentState, loadQuestWorkflow, saveCurrentState, saveQuestWorkflow } from "./state.js";
import type { CommandContext } from "./types.js";
import { validateEvent } from "./events.js";

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

export async function cmdSetStatus(ctx: CommandContext, args: string[]) {
	const [id, newStatus] = args;
	if (!id || !newStatus) {
		ctx.ui.notify("Usage: /quest set-status <id> <status> [--force]", "warning");
		return;
	}
	const questDir = questDirPath(ctx.cwd, id);
	const workflow = loadQuestWorkflow(questDir);
	if (!workflow) {
		ctx.ui.notify(`Quest '${id}' not found.`, "error");
		return;
	}
	const force = args.includes("--force");
	if (!force && !isValidTransition(workflow.status, newStatus as QuestStatus)) {
		ctx.ui.notify(
			`Invalid status transition: ${workflow.status} → ${newStatus}. Use --force to override.`,
			"error",
		);
		return;
	}
	if (!force && newStatus === "verification-ready") {
		const verificationPath = path.join(questDir, workflow.artifacts.verification ?? "VERIFICATION.md");
		if (!fs.existsSync(verificationPath)) {
			ctx.ui.notify(
				`Gate check failed: ${workflow.artifacts.verification ?? "VERIFICATION.md"} not found. Run the Verification Agent before marking verification-ready, or use --force to override.`,
				"error",
			);
			return;
		}
	}
	// Launch Gate (ADR 012): launch-review → executing.
	if (workflow.status === "launch-review" && newStatus === "executing") {
		const gateResult = runLaunchGate(ctx, id, questDir, workflow, force);
		if (gateResult.outcome === "blocked") return;
	}
	const previousStatus = workflow.status;
	workflow.status = newStatus as QuestStatus;
	workflow.updatedAt = new Date().toISOString();
	saveQuestWorkflow(questDir, workflow);
	// M4-2: UAT doorbell at the verification-ready → uat-ready boundary (ADR 016).
	// Widget mood shift is handled by M3-1 (Hearth Widget Needs-you mood) — no
	// wiring required here.
	fireUatDoorbell(ctx, workflow, questDir, previousStatus);
	ctx.ui.notify(`Quest '${id}' status → ${newStatus}`, "info");
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
) {
	if (previousStatus !== "verification-ready") return;
	if (workflow.status !== "uat-ready") return;
	if (workflow.uat_doorbell_fired_at) return;

	// Channel 1: terminal bell. Use \x07 (BEL). Silent on terminals with the
	// bell disabled — that's an OS/terminal setting, nothing for us to do.
	process.stdout.write("\x07");

	// Channel 2: OS notification via pi's existing facility.
	const label = workflow.title && workflow.title.trim().length > 0 ? workflow.title : workflow.id;
	ctx.ui.notify(`UAT pending for ${label}`, "info");

	// Persist the idempotency marker.
	workflow.uat_doorbell_fired_at = new Date().toISOString();
	saveQuestWorkflow(questDir, workflow);
}

/**
 * Auto-router branch (ADR 008 + ADR 012): advance from `planned` to
 * `launch-review` and load the Launch Review skill inline.
 *
 * Returns true if it advanced a stage (so the outer router can decide whether
 * to keep going or stop for interactive input). For M2-1 we only handle the
 * `planned → launch-review` transition; other stages remain on `showStatus`.
 */
export async function tryAutoRoute(ctx: CommandContext): Promise<boolean> {
	const state = loadCurrentState(ctx.cwd);
	if (!state.currentQuestId) return false;
	const questDir = questDirPath(ctx.cwd, state.currentQuestId);
	const workflow = loadQuestWorkflow(questDir);
	if (!workflow) return false;

	if (workflow.status === "planned") {
		workflow.status = "launch-review";
		workflow.updatedAt = new Date().toISOString();
		saveQuestWorkflow(questDir, workflow);
		ctx.ui.notify(
			`Quest '${workflow.id}' entering Launch Review.\n` +
				`The Launch Review skill is loaded inline. Walk through Compiler diagnostics, Blast Radius, and Pre-Mortem, then sign off via the skill's helper. Use \`/quest set-status ${workflow.id} executing\` (or \`--force\`) when ready.`,
			"info",
		);
		return true;
	}

	return false;
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
