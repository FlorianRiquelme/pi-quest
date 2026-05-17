/**
 * Path resolution for quest workspaces.
 */

import * as path from "node:path";
import { DEFAULT_QUEST_CONFIG } from "../lib.js";

export const EXTENSION_DIR = __dirname;
export const AGENTS_DIR = path.join(EXTENSION_DIR, "..", "agents");

export function getQuestsDir(cwd: string) {
	return path.join(cwd, DEFAULT_QUEST_CONFIG.workspace.root);
}

export function getStatePath(cwd: string) {
	return path.join(cwd, DEFAULT_QUEST_CONFIG.workspace.statePath);
}

export function questDirPath(cwd: string, questId: string) {
	return path.join(getQuestsDir(cwd), questId);
}
