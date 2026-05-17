/**
 * Quest and workflow state I/O.
 */

import * as fs from "node:fs";
import { readJsonIfExists, writeJson } from "./fs-utils.js";
import * as path from "node:path";
import { getQuestsDir, getStatePath } from "./paths.js";
import type { CurrentQuestState, QuestWorkflow } from "../lib.js";

export function loadCurrentState(cwd: string): CurrentQuestState {
	return readJsonIfExists<CurrentQuestState>(getStatePath(cwd)) ?? {};
}

export function saveCurrentState(cwd: string, state: CurrentQuestState) {
	writeJson(getStatePath(cwd), state);
}

export function loadQuestWorkflow(questDir: string): QuestWorkflow | undefined {
	return readJsonIfExists<QuestWorkflow>(path.join(questDir, "workflow.json"));
}

export function saveQuestWorkflow(questDir: string, workflow: QuestWorkflow) {
	writeJson(path.join(questDir, "workflow.json"), workflow);
}

export function getAllQuestIds(cwd: string): string[] {
	const questsDir = getQuestsDir(cwd);
	if (!fs.existsSync(questsDir)) return [];
	return fs
		.readdirSync(questsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}
