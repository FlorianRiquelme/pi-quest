/**
 * Git helpers for the pi-quest extension.
 */

import { spawn } from "node:child_process";

export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		const proc = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		proc.stdout.on("data", (d) => (out += d.toString()));
		proc.on("close", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error("git rev-parse failed"));
		});
	});
}

export async function getCurrentCommit(cwd: string): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		const proc = spawn("git", ["rev-parse", "--short", "HEAD"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		proc.stdout.on("data", (d) => (out += d.toString()));
		proc.on("close", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error("git rev-parse failed"));
		});
	});
}
