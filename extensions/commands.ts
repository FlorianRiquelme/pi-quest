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
import { questDirPath } from "./paths.js";
import { resolveReferences } from "./references.js";
import { getAllQuestIds, loadCurrentState, loadQuestWorkflow, saveCurrentState, saveQuestWorkflow } from "./state.js";
import type { CommandContext } from "./types.js";

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
	workflow.status = newStatus as QuestStatus;
	workflow.updatedAt = new Date().toISOString();
	saveQuestWorkflow(questDir, workflow);
	ctx.ui.notify(`Quest '${id}' status → ${newStatus}`, "info");
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
