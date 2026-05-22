/**
 * UI data layer for quest workspaces.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { QuestWorkflow, QuestStatus } from "../../lib.js";
import { listRunSummaries } from "../runs/runner.js";
import type { QuestEvent } from "../events.js";
import { questDirPath } from "../paths.js";
import { getAllQuestIds, loadCurrentState, loadQuestWorkflow } from "../state.js";

export interface QuestSummary {
	id: string;
	title: string;
	status: QuestStatus;
	updatedAt: string;
	isActive: boolean;
}

export interface WorkItemInfo {
	id: string;
	fileName: string;
	filePath: string;
	hasReport: boolean;
	latestRunStatus?: "running" | "completed" | "failed" | "cancelled" | "orphaned" | "paused";
}

export interface ArtifactInfo {
	key: string;
	label: string;
	fileName?: string;
	exists: boolean;
	filePath?: string;
}

export interface QuestDetail {
	workflow: QuestWorkflow;
	workItems: WorkItemInfo[];
	artifacts: ArtifactInfo[];
	recentRuns: ReturnType<typeof listRunSummaries>;
}

export function getQuestSummaries(cwd: string): QuestSummary[] {
	const state = loadCurrentState(cwd);
	const ids = getAllQuestIds(cwd);
	const summaries: QuestSummary[] = [];
	for (const id of ids) {
		const wf = loadQuestWorkflow(questDirPath(cwd, id));
		if (!wf) continue;
		summaries.push({
			id: wf.id,
			title: wf.title,
			status: wf.status,
			updatedAt: wf.updatedAt,
			isActive: state.currentQuestId === id,
		});
	}
	return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getActiveQuestSummary(cwd: string): QuestSummary | undefined {
	const state = loadCurrentState(cwd);
	if (!state.currentQuestId) return undefined;
	const wf = loadQuestWorkflow(questDirPath(cwd, state.currentQuestId));
	if (!wf) return undefined;
	return {
		id: wf.id,
		title: wf.title,
		status: wf.status,
		updatedAt: wf.updatedAt,
		isActive: true,
	};
}

export function getQuestDetail(cwd: string, questId: string): QuestDetail | undefined {
	const qDir = questDirPath(cwd, questId);
	const workflow = loadQuestWorkflow(qDir);
	if (!workflow) return undefined;

	// Work items
	const workItemsDir = path.join(qDir, "work-items");
	const reportsDir = path.join(qDir, "reports");
	const workItems: WorkItemInfo[] = [];

	if (fs.existsSync(workItemsDir)) {
		const files = fs.readdirSync(workItemsDir).filter((f) => f.endsWith(".md"));
		for (const file of files) {
			const itemId = file.replace(/\.md$/, "");
			const reportPath = path.join(reportsDir, file);
			const runs = listRunSummaries(qDir).filter((r) => r.workItemId === itemId);
			const latestRun = runs.at(-1);
			workItems.push({
				id: itemId,
				fileName: file,
				filePath: path.join(workItemsDir, file),
				hasReport: fs.existsSync(reportPath),
				latestRunStatus: latestRun?.status,
			});
		}
	}

	// Artifacts. The Homecoming Brief (M4-1) joins the existing artifact list.
	// `brief` field on workflow.artifacts is optional; older quests on disk
	// without it still surface BRIEF.md if the file exists.
	const briefName = workflow.artifacts.brief ?? "BRIEF.md";
	const artifactDefs: Array<{ key: string; label: string; fileName?: string }> = [
		{ key: "handoff", label: "Handoff", fileName: workflow.artifacts.handoff },
		{ key: "recon", label: "Recon", fileName: workflow.artifacts.recon },
		{ key: "review", label: "Review", fileName: workflow.artifacts.review },
		{ key: "resolvedHandoff", label: "Resolved Handoff", fileName: workflow.artifacts.resolvedHandoff },
		{ key: "plan", label: "Plan", fileName: workflow.artifacts.plan },
		{ key: "verification", label: "Verification", fileName: workflow.artifacts.verification },
		{ key: "uat", label: "UAT", fileName: workflow.artifacts.uat },
		{ key: "brief", label: "Homecoming Brief", fileName: briefName },
	];

	const artifacts: ArtifactInfo[] = artifactDefs.map((def) => {
		const exists = def.fileName ? fs.existsSync(path.join(qDir, def.fileName)) : false;
		return {
			key: def.key,
			label: def.label,
			fileName: def.fileName,
			exists,
			filePath: def.fileName && exists ? path.join(qDir, def.fileName) : undefined,
		};
	});

	// Recent runs
	const recentRuns = listRunSummaries(qDir).slice(-3).reverse();

	return { workflow, workItems, artifacts, recentRuns };
}

/**
 * Return all paused runs (ADR 014) for a quest, oldest-first by `paused_at`.
 *
 * A paused run carries `status: "paused"` along with `paused_at` and
 * `paused_reason`. The dashboard surfaces these as a separate row variant with
 * three equal-weight actions: Resume / Discard / Force-Complete (M4-4 / ADR 017
 * landed Resume; M3-3 wired the other two).
 */
export function getPausedRuns(cwd: string, questId: string) {
	const runs = listRunSummaries(questDirPath(cwd, questId));
	return runs
		.filter((r) => r.status === "paused")
		.sort((a, b) =>
			(a.paused_at ?? a.updatedAt).localeCompare(b.paused_at ?? b.updatedAt),
		);
}

/**
 * Format the "Paused: <rule> (Xm Ys)" label used in the dashboard row.
 *
 * Returns "Paused: <rule>" when no `paused_at` is recorded (defensive).
 */
export function formatPausedRunLabel(
	pausedAt: string | undefined,
	pausedReason: string | undefined,
	now: number = Date.now(),
): string {
	const reason = pausedReason ?? "unknown";
	if (!pausedAt) return `Paused: ${reason}`;
	const elapsed = Math.max(0, Math.floor((now - new Date(pausedAt).getTime()) / 1000));
	const m = Math.floor(elapsed / 60);
	const s = elapsed % 60;
	return `Paused: ${reason} (${m}m${s.toString().padStart(2, "0")}s)`;
}

export function countRunningWorkItems(cwd: string, questId: string): number {
	const qDir = questDirPath(cwd, questId);
	const runs = listRunSummaries(qDir);
	return runs.filter((r) => r.status === "running").length;
}

export function countCompletedWorkItems(cwd: string, questId: string): number {
	const qDir = questDirPath(cwd, questId);
	const workItemsDir = path.join(qDir, "work-items");
	if (!fs.existsSync(workItemsDir)) return 0;
	const files = fs.readdirSync(workItemsDir).filter((f) => f.endsWith(".md"));
	let completed = 0;
	for (const file of files) {
		const itemId = file.replace(/\.md$/, "");
		const runs = listRunSummaries(qDir).filter((r) => r.workItemId === itemId);
		const latest = runs.at(-1);
		if (latest?.status === "completed") completed++;
	}
	return completed;
}

export function getTotalWorkItems(cwd: string, questId: string): number {
	const qDir = questDirPath(cwd, questId);
	const workItemsDir = path.join(qDir, "work-items");
	if (!fs.existsSync(workItemsDir)) return 0;
	return fs.readdirSync(workItemsDir).filter((f) => f.endsWith(".md")).length;
}

export function readArtifactFile(filePath: string): string | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	return fs.readFileSync(filePath, "utf-8");
}

/**
 * Read a quest's typed audit event log (`telemetry/events.jsonl`).
 *
 * Each JSONL line is parsed independently; malformed lines are skipped so
 * that the widget can never throw on a partially-written log. Returns an
 * empty array if the log file does not exist.
 *
 * Consumed by the Hearth Widget for mood selection (synthetic vs semantic
 * progress beats) and Two Clocks (wall and compute durations).
 */
export function readQuestEvents(cwd: string, questId: string): QuestEvent[] {
	const eventsPath = path.join(questDirPath(cwd, questId), "telemetry", "events.jsonl");
	if (!fs.existsSync(eventsPath)) return [];
	const raw = fs.readFileSync(eventsPath, "utf-8");
	const out: QuestEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as QuestEvent);
		} catch {
			// Skip corrupt line — never throw from a widget read path.
		}
	}
	return out;
}
