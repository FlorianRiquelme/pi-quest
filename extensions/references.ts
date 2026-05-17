/**
 * Resolve markdown reference links inside a handoff into inlined content.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export async function resolveReferences(
	handoffPath: string,
	handoffContent: string,
): Promise<string> {
	const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
	const resolved: string[] = [];
	const baseDir = path.dirname(handoffPath);

	let match;
	while ((match = linkRegex.exec(handoffContent)) !== null) {
		const rawLink = match[2];
		if (!rawLink.endsWith(".md")) continue;
		if (rawLink.startsWith("http://") || rawLink.startsWith("https://")) {
			resolved.push(`## ${match[1]} (${rawLink})\n\n[external link — fetch manually if needed]\n`);
			continue;
		}
		const candidate = path.resolve(baseDir, rawLink);
		if (fs.existsSync(candidate)) {
			const content = fs.readFileSync(candidate, "utf-8");
			resolved.push(`## ${match[1]} (${rawLink})\n\n${content}\n`);
		}
	}

	if (resolved.length === 0) return "";
	return "# Resolved Reference Documents\n\n" + resolved.join("\n---\n\n");
}
