/**
 * Low-level filesystem utilities and pi invocation helpers.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function ensureDir(p: string) {
	if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function readJsonIfExists<T>(p: string): T | undefined {
	if (!fs.existsSync(p)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

export function writeJson(p: string, data: unknown) {
	ensureDir(path.dirname(p));
	fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export const MAX_SUBAGENT_CAPTURE_CHARS = 1_000_000;

export function appendCappedTail(current: string, chunk: unknown, maxChars = MAX_SUBAGENT_CAPTURE_CHARS) {
	const text = String(chunk);
	if (text.length >= maxChars) return { value: text.slice(-maxChars), truncated: true };
	const combinedLength = current.length + text.length;
	if (combinedLength <= maxChars) return { value: current + text, truncated: false };
	return { value: current.slice(combinedLength - maxChars) + text, truncated: true };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}
