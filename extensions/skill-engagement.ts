/**
 * Skill Engagement — push a loaded skill's body into the conversation as a
 * user-role message so the user lands *in* the skill without typing
 * `/skill:<name>`.
 *
 * Mirrors pi's internal `AgentSession._expandSkillCommand` (pi-coding-agent
 * 0.74.1, `core/agent-session.js:843`). Pi's `sendUserMessage` does NOT expand
 * `/skill:` syntax (it calls `prompt()` with `expandPromptTemplates: false`),
 * so we replicate the wrapper here and ship the pre-expanded block.
 *
 * If pi later exposes an `expandSkill` option on `sendUserMessage` or a
 * first-class `sendSkill` API, swap this implementation; the call sites in
 * `tryAutoRoute` / `transitionStage` don't change.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type EngageSkill = (skillName: string) => Promise<boolean>;

function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return raw;
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return raw;
	// Skip the closing fence and the newline that follows it (LF or CRLF).
	let after = end + 4;
	if (raw[after] === "\r") after++;
	if (raw[after] === "\n") after++;
	return raw.slice(after);
}

/**
 * Build an `engageSkill` callback bound to the given pi instance. Returns
 * `true` when the skill was found, read, and pushed; `false` when the named
 * skill is not loaded.
 */
export function engageSkillFactory(pi: ExtensionAPI): EngageSkill {
	return async (skillName: string): Promise<boolean> => {
		const cmd = pi
			.getCommands()
			.find((c) => c.source === "skill" && c.name === skillName);
		if (!cmd) return false;

		const skillPath = cmd.sourceInfo.path;
		const baseDir = cmd.sourceInfo.baseDir ?? path.dirname(skillPath);
		const raw = fs.readFileSync(skillPath, "utf-8");
		const body = stripFrontmatter(raw).trim();
		const block =
			`<skill name="${skillName}" location="${skillPath}">\n` +
			`References are relative to ${baseDir}.\n\n` +
			`${body}\n` +
			`</skill>`;
		pi.sendUserMessage(block);
		return true;
	};
}
