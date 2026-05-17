/**
 * pi-quest extension
 *
 * Provides:
 * - /quest command for quest lifecycle management
 * - quest_run_work_item tool — start a background implementation subagent for a work item
 * - quest_work_item_status tool — inspect background work-item run status
 * - quest_rescue tool — spawn a rescue subagent for blocked work
 * - quest_write_workflow tool — update quest workflow status with transition safety
 * - quest_telemetry_event tool — record telemetry events
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
	collisionSuffixed,
	DEFAULT_QUEST_CONFIG,
	deriveQuestId,
	generateTimestampId,
	isValidTransition,
	QuestStatus,
	QuestWorkflow,
	type CurrentQuestState,
} from "../lib.js";

/* ================================ Utilities ================================ */

function ensureDir(p: string) {
	if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJsonIfExists<T>(p: string): T | undefined {
	if (!fs.existsSync(p)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(p: string, data: unknown) {
	ensureDir(path.dirname(p));
	fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function getCurrentBranch(cwd: string): Promise<string | undefined> {
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

async function getCurrentCommit(cwd: string): Promise<string | undefined> {
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

function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

const MAX_SUBAGENT_CAPTURE_CHARS = 1_000_000;

function appendCappedTail(current: string, chunk: unknown, maxChars = MAX_SUBAGENT_CAPTURE_CHARS) {
	const text = String(chunk);
	if (text.length >= maxChars) return { value: text.slice(-maxChars), truncated: true };
	const combinedLength = current.length + text.length;
	if (combinedLength <= maxChars) return { value: current + text, truncated: false };
	return { value: current.slice(combinedLength - maxChars) + text, truncated: true };
}

/* ================================ Paths ================================ */

const EXTENSION_DIR = __dirname; // jiti resolves this to the file's dir
const AGENTS_DIR = path.join(EXTENSION_DIR, "..", "agents");

function getQuestsDir(cwd: string) {
	return path.join(cwd, DEFAULT_QUEST_CONFIG.workspace.root);
}
function getStatePath(cwd: string) {
	return path.join(cwd, DEFAULT_QUEST_CONFIG.workspace.statePath);
}
function questDirPath(cwd: string, questId: string) {
	return path.join(getQuestsDir(cwd), questId);
}

/* ================================ State Access ================================ */

function loadCurrentState(cwd: string): CurrentQuestState {
	return readJsonIfExists<CurrentQuestState>(getStatePath(cwd)) ?? {};
}
function saveCurrentState(cwd: string, state: CurrentQuestState) {
	writeJson(getStatePath(cwd), state);
}
function loadQuestWorkflow(questDir: string): QuestWorkflow | undefined {
	return readJsonIfExists<QuestWorkflow>(path.join(questDir, "workflow.json"));
}
function saveQuestWorkflow(questDir: string, workflow: QuestWorkflow) {
	writeJson(path.join(questDir, "workflow.json"), workflow);
}
function getAllQuestIds(cwd: string): string[] {
	const questsDir = getQuestsDir(cwd);
	if (!fs.existsSync(questsDir)) return [];
	return fs
		.readdirSync(questsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}

/* ================================ Agent / Subagent ================================ */

interface AgentDef {
	name: string;
	description: string;
	tools?: string;
	model?: string;
	systemPrompt: string;
}

const MODEL_ALIASES: Record<string, string> = {
	"kimi-2.6": "openrouter/moonshotai/kimi-k2.6",
	"kimi-k2.6": "openrouter/moonshotai/kimi-k2.6",
	"moonshotai/kimi-k2.6": "openrouter/moonshotai/kimi-k2.6",
};

function normalizeModel(model: string | undefined): string | undefined {
	const trimmed = model?.trim();
	if (!trimmed) return undefined;
	return MODEL_ALIASES[trimmed] ?? trimmed;
}

function parseAgentDef(filePath: string): AgentDef | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const content = fs.readFileSync(filePath, "utf-8");
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!fmMatch) return undefined;
	const fm: Record<string, string> = {};
	for (const line of fmMatch[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	if (!fm.name || !fm.description) return undefined;
	return {
		name: fm.name,
		description: fm.description,
		tools: fm.tools,
		model: fm.model,
		systemPrompt: fmMatch[2].trim(),
	};
}

function getAgentDef(name: string): AgentDef | undefined {
	const direct = parseAgentDef(path.join(AGENTS_DIR, `${name}.md`));
	if (direct) return direct;

	if (!fs.existsSync(AGENTS_DIR)) return undefined;
	for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const agent = parseAgentDef(path.join(AGENTS_DIR, entry.name));
		if (agent?.name === name) return agent;
	}

	return undefined;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-quest-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

async function runSubagent(options: {
	cwd: string;
	agentName: string;
	task: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	signal?: AbortSignal;
}): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}> {
	const agentDef = getAgentDef(options.agentName);
	const basePrompt = options.systemPrompt ?? agentDef?.systemPrompt ?? "";
	const model = normalizeModel(options.model ?? agentDef?.model);
	const tools = options.tools ?? (agentDef?.tools ? agentDef.tools.split(/,\s*/) : undefined);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	try {
		if (basePrompt.trim()) {
			const tmp = await writePromptToTempFile(options.agentName, basePrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${options.task}`);

		const invocation = getPiInvocation(args);
		return new Promise((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let stdoutTruncated = false;
			let stderrTruncated = false;

			proc.stdout.on("data", (d) => {
				const next = appendCappedTail(stdout, d);
				stdout = next.value;
				stdoutTruncated ||= next.truncated;
			});
			proc.stderr.on("data", (d) => {
				const next = appendCappedTail(stderr, d);
				stderr = next.value;
				stderrTruncated ||= next.truncated;
			});

			proc.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr, stdoutTruncated, stderrTruncated }));
			proc.on("error", () => resolve({ exitCode: 1, stdout, stderr, stdoutTruncated, stderrTruncated }));

			if (options.signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}
		});
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}

interface BackgroundRunSummary {
	runId: string;
	questId: string;
	workItemId: string;
	agentName: string;
	status: "running" | "completed" | "failed" | "cancelled";
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	exitCode?: number;
	pid?: number;
	model?: string;
	stdoutPath: string;
	stderrPath: string;
	reportPath: string;
	statusPath: string;
}

const activeRuns = new Map<string, BackgroundRunSummary>();

function writeRunSummary(summary: BackgroundRunSummary) {
	writeJson(summary.statusPath, summary);
}

function readRunSummary(questDir: string, runId: string): BackgroundRunSummary | undefined {
	return readJsonIfExists<BackgroundRunSummary>(path.join(questDir, "runs", `${runId}.json`));
}

function listRunSummaries(questDir: string): BackgroundRunSummary[] {
	const runsDir = path.join(questDir, "runs");
	if (!fs.existsSync(runsDir)) return [];
	return fs
		.readdirSync(runsDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readJsonIfExists<BackgroundRunSummary>(path.join(runsDir, name)))
		.filter((summary): summary is BackgroundRunSummary => Boolean(summary))
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function startSubagentRun(options: {
	cwd: string;
	questId: string;
	questDir: string;
	workItemId: string;
	agentName: string;
	task: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	onStatus?: (summary: BackgroundRunSummary) => void;
}): Promise<BackgroundRunSummary> {
	const agentDef = getAgentDef(options.agentName);
	const basePrompt = options.systemPrompt ?? agentDef?.systemPrompt ?? "";
	const model = normalizeModel(options.model ?? agentDef?.model);
	const tools = options.tools ?? (agentDef?.tools ? agentDef.tools.split(/,\s*/) : undefined);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	if (basePrompt.trim()) {
		const tmp = await writePromptToTempFile(options.agentName, basePrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
	}
	args.push(`Task: ${options.task}`);

	ensureDir(path.join(options.questDir, "runs"));
	ensureDir(path.join(options.questDir, "reports"));
	const safeWorkItemId = options.workItemId.replace(/[^a-zA-Z0-9_.-]+/g, "-");
	const runId = `${safeWorkItemId}-${generateTimestampId()}`;
	const stdoutPath = path.join(options.questDir, "runs", `${runId}.stdout.log`);
	const stderrPath = path.join(options.questDir, "runs", `${runId}.stderr.log`);
	const statusPath = path.join(options.questDir, "runs", `${runId}.json`);
	const reportPath = path.join(options.questDir, "reports", `${options.workItemId}.md`);
	const startedAt = new Date().toISOString();
	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: options.cwd,
		shell: false,
		detached: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const summary: BackgroundRunSummary = {
		runId,
		questId: options.questId,
		workItemId: options.workItemId,
		agentName: options.agentName,
		status: "running",
		startedAt,
		updatedAt: startedAt,
		pid: proc.pid,
		model: model ?? "default",
		stdoutPath,
		stderrPath,
		reportPath,
		statusPath,
	};
	activeRuns.set(runId, summary);
	writeRunSummary(summary);
	options.onStatus?.(summary);

	proc.stdout.on("data", (d) => fs.appendFileSync(stdoutPath, d));
	proc.stderr.on("data", (d) => fs.appendFileSync(stderrPath, d));

	let finalized = false;
	const finalize = (status: BackgroundRunSummary["status"], exitCode?: number) => {
		if (finalized) return;
		finalized = true;
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
		const completedAt = new Date().toISOString();
		summary.status = status;
		summary.exitCode = exitCode;
		summary.completedAt = completedAt;
		summary.updatedAt = completedAt;
		activeRuns.delete(runId);
		writeRunSummary(summary);
		const telemetryPath = path.join(options.questDir, "telemetry", "events.jsonl");
		ensureDir(path.dirname(telemetryPath));
		fs.appendFileSync(
			telemetryPath,
			JSON.stringify({
				timestamp: completedAt,
				questId: options.questId,
				event: "agent_run_completed",
				agentRole: "implementation",
				workItemId: options.workItemId,
				runId,
				model: model ?? "default",
				status,
				exitCode,
				rescueUsed: false,
			}) + "\n",
			"utf-8",
		);
		options.onStatus?.(summary);
	};

	proc.on("close", (code, signal) => {
		if (signal) finalize("cancelled", code ?? undefined);
		else finalize(code === 0 ? "completed" : "failed", code ?? 1);
	});
	proc.on("error", () => finalize("failed", 1));

	return summary;
}

function compactRunLine(summary: BackgroundRunSummary): string {
	const code = summary.exitCode === undefined ? "" : ` exit=${summary.exitCode}`;
	return `${summary.runId} ${summary.status}${code} • work-item ${summary.workItemId} • report ${summary.reportPath}`;
}

/* ================================ References resolution ================================ */

async function resolveReferences(
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

/* ================================ Extension ================================ */

export default function piQuestExtension(pi: ExtensionAPI) {
	const loadedQuestIds = new Set<string>();

	async function ensureGitignore(cwd: string) {
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

	/* ================================ Commands ================================ */

	pi.registerCommand("quest", {
		description:
			"Quest execution engine. /quest [status|list|intake <handoff.md>|select <id>|set-status <id> <status>|config]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";

			switch (subcommand) {
				case "":
				case "status":
					await showStatus(ctx);
					break;
				case "list":
					await listQuests(ctx);
					break;
				case "intake":
					await cmdIntake(ctx, parts.slice(1));
					break;
				case "select":
					await cmdSelect(ctx, parts.slice(1));
					break;
				case "config":
					await cmdConfig(ctx);
					break;
				case "set-status":
					await cmdSetStatus(ctx, parts.slice(1));
					break;
				default:
					ctx.ui.notify(`Unknown quest subcommand: ${subcommand}`, "error");
					ctx.ui.notify(
						"Usage: /quest [status|list|intake <handoff.md>|select <id>|set-status <id> <status>|config]",
						"info",
					);
			}
		},
	});

	async function showStatus(ctx: Parameters<NonNullable<Parameters<typeof pi.registerCommand>[1]["handler"]>>[1]) {
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

	async function listQuests(ctx: Parameters<NonNullable<Parameters<typeof pi.registerCommand>[1]["handler"]>>[1]) {
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

	async function cmdSelect(
		ctx: Parameters<NonNullable<Parameters<typeof pi.registerCommand>[1]["handler"]>>[1],
		args: string[],
	) {
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
		loadedQuestIds.add(id);
		ctx.ui.notify(`Active quest set to '${id}'`, "info");
	}

	async function cmdSetStatus(
		ctx: Parameters<NonNullable<Parameters<typeof pi.registerCommand>[1]["handler"]>>[1],
		args: string[],
	) {
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
		workflow.status = newStatus as QuestStatus;
		workflow.updatedAt = new Date().toISOString();
		saveQuestWorkflow(questDir, workflow);
		ctx.ui.notify(`Quest '${id}' status → ${newStatus}`, "info");
	}

	async function cmdIntake(
		ctx: Parameters<NonNullable<Parameters<typeof pi.registerCommand>[1]["handler"]>>[1],
		args: string[],
	) {
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
		loadedQuestIds.add(questId);
		await ensureGitignore(ctx.cwd);

		ctx.ui.notify(
			`Quest '${questId}' intake complete. Status: intake.\n` +
				`Next: use /skill:quest-recon to run reconnaissance, or /skill:quest-review-discussion to begin review.`,
			"info",
		);
	}

	async function cmdConfig(
		ctx: Parameters<NonNullable<Parameters<typeof pi.registerCommand>[1]["handler"]>>[1],
	) {
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

	/* ================================ Tools ================================ */

	pi.registerTool({
		name: "quest_run_work_item",
		label: "Run Quest Work Item",
		description: "Start an implementation subagent for a single Quest work item in the background.",
		promptSnippet: "Start a quest work item implementation subagent without blocking the orchestrator",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			workItemId: Type.String({ description: "Work item ID, e.g. 001" }),
			optionalModel: Type.Optional(Type.String({ description: "Override subagent model" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questDir = questDirPath(ctx.cwd, params.questId);
			if (!fs.existsSync(questDir)) {
				return {
					content: [{ type: "text", text: `Quest '${params.questId}' not found.` }],
					isError: true,
					details: {},
				};
			}

			const workItemPath = path.join(questDir, "work-items", `${params.workItemId}.md`);
			if (!fs.existsSync(workItemPath)) {
				return {
					content: [{ type: "text", text: `Work item '${params.workItemId}' not found at ${workItemPath}.` }],
					isError: true,
					details: {},
				};
			}

			const task = [
				`Execute the work item: ${workItemPath}`,
				`The quest workspace is: ${questDir}`,
				`Read the work-item file, then read RESOLVED_HANDOFF.md and RECON.md as needed.`,
				`Implement the changes described. Run any verification commands.`,
				`Write your compact report to: ${path.join(questDir, "reports", `${params.workItemId}.md`)}`,
			].join("\n");

			const summary = await startSubagentRun({
				cwd: ctx.cwd,
				questId: params.questId,
				questDir,
				workItemId: params.workItemId,
				agentName: "quest-implementation",
				task,
				model: params.optionalModel,
				onStatus: (run) => {
					const active = activeRuns.size;
					ctx.ui.setStatus("quest", active > 0 ? `quest: ${active} work item(s) running` : undefined);
					if (run.status !== "running") {
						ctx.ui.notify(`Quest work item ${run.workItemId} ${run.status} (${run.runId})`, run.status === "completed" ? "info" : "warning");
					}
				},
			});

			return {
				content: [
					{
						type: "text",
						text:
							`Started work item ${params.workItemId} in the background.\n` +
							`Run: ${summary.runId}\n` +
							`Status: ${summary.statusPath}\n` +
							`Report: ${summary.reportPath}\n` +
							`Stdout: ${summary.stdoutPath}\n` +
							`Stderr: ${summary.stderrPath}\n\n` +
							`This run is asynchronous. Return the run ID to the user for later follow-up; do not block the conversation by polling unless explicitly asked.`,
					},
				],
				details: summary,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("quest_run_work_item ")) +
					theme.fg("accent", args.workItemId ?? "?") +
					theme.fg("dim", ` in ${args.questId ?? "?"}`) +
					(args.optionalModel ? theme.fg("muted", ` via ${args.optionalModel}`) : ""),
			);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as BackgroundRunSummary | undefined;
			if (!details?.runId) {
				text.setText(theme.fg(result.isError ? "error" : "toolOutput", result.content?.[0]?.text ?? ""));
				return text;
			}
			text.setText(
				theme.fg("success", "↗ started background implementation agent") +
					"\n" +
					theme.fg("accent", `run ${details.runId}`) +
					theme.fg("muted", ` • status ${details.status}`) +
					"\n" +
					theme.fg("dim", `status file: ${details.statusPath}`) +
					"\n" +
					theme.fg("dim", `report: ${details.reportPath}`),
			);
			return text;
		},
	});

	pi.registerTool({
		name: "quest_work_item_status",
		label: "Quest Work Item Status",
		description: "Read background Quest work-item run status and report locations. For running items, do not poll repeatedly; return run IDs for later follow-up unless the user explicitly asks you to wait.",
		promptSnippet: "Check background quest work item implementation run status (avoid tight polling; return control unless explicitly asked to wait)",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			runId: Type.Optional(Type.String({ description: "Run ID returned by quest_run_work_item" })),
			workItemId: Type.Optional(Type.String({ description: "Work item ID; returns the latest run for that item" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questDir = questDirPath(ctx.cwd, params.questId);
			if (!fs.existsSync(questDir)) {
				return {
					content: [{ type: "text", text: `Quest '${params.questId}' not found.` }],
					isError: true,
					details: {},
				};
			}

			let summaries = listRunSummaries(questDir);
			if (params.runId) summaries = summaries.filter((summary) => summary.runId === params.runId);
			if (params.workItemId) summaries = summaries.filter((summary) => summary.workItemId === params.workItemId);
			const selected = summaries.at(-1);
			if (!selected) {
				return {
					content: [{ type: "text", text: "No matching Quest work-item run found." }],
					isError: true,
					details: { runs: [] },
				};
			}

			const reportExists = fs.existsSync(selected.reportPath);
			const reportTail = reportExists ? fs.readFileSync(selected.reportPath, "utf-8").slice(-4000) : "";
			return {
				content: [
					{
						type: "text",
						text:
							compactRunLine(selected) +
							(reportExists ? `\n\nReport tail:\n${reportTail}` : "\n\nReport has not been written yet."),
					},
				],
				details: { run: selected, reportExists, reportTail },
				isError: selected.status === "failed" || selected.status === "cancelled",
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("quest_work_item_status ")) +
					theme.fg("accent", args.runId ?? args.workItemId ?? "latest") +
					theme.fg("dim", ` in ${args.questId ?? "?"}`),
			);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const run = (result.details as { run?: BackgroundRunSummary } | undefined)?.run;
			if (!run) {
				text.setText(theme.fg(result.isError ? "error" : "toolOutput", "No matching run."));
				return text;
			}
			const color: "success" | "warning" | "error" = run.status === "completed" ? "success" : run.status === "running" ? "warning" : "error";
			text.setText(
				theme.fg(color, `${run.status} ${run.runId}`) +
					(run.exitCode === undefined ? "" : theme.fg("muted", ` • exit ${run.exitCode}`)) +
					"\n" +
					theme.fg("dim", `report: ${run.reportPath}`),
			);
			return text;
		},
	});

	pi.registerTool({
		name: "quest_rescue",
		label: "Quest Rescue",
		description: "Spawn a rescue subagent to diagnose a blocked quest work item.",
		promptSnippet: "Request a GPT-5.5-class rescue review for a blocked work item",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			workItemId: Type.String({ description: "Blocked work item ID" }),
			blockerDescription: Type.String({ description: "Description of the blocker" }),
			hypothesesTried: Type.Optional(Type.String({ description: "What was already tried" })),
			diffSummary: Type.Optional(Type.String({ description: "Summary of current diff" })),
			errorOutput: Type.Optional(Type.String({ description: "Failing command output" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questDir = questDirPath(ctx.cwd, params.questId);
			if (!fs.existsSync(questDir)) {
				return {
					content: [{ type: "text", text: `Quest '${params.questId}' not found.` }],
					isError: true,
					details: {},
				};
			}

			const task = [
				`You are performing a rescue review for quest '${params.questId}', work item '${params.workItemId}'.`,
				`Quest workspace: ${questDir}`,
				`Blocker: ${params.blockerDescription}`,
				params.hypothesesTried ? `Hypotheses tried:\n${params.hypothesesTried}` : "",
				params.diffSummary ? `Current diff summary:\n${params.diffSummary}` : "",
				params.errorOutput ? `Error output:\n${params.errorOutput}` : "",
				`Read the work-item file (${path.join(questDir, "work-items", `${params.workItemId}.md`)}) and the plan.`,
				`Provide a concise rescue report with: Diagnosis, Recommendation (continue/revert/pause/ask-user), Exact Next Steps, Plan Change Required (yes/no), User Input Required (yes/no).`,
			]
				.filter(Boolean)
				.join("\n");

			const result = await runSubagent({
				cwd: ctx.cwd,
				agentName: "quest-rescue",
				task,
				signal,
			});

			// Mark telemetry that rescue was used
			const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
			ensureDir(path.dirname(telemetryPath));
			const event = {
				timestamp: new Date().toISOString(),
				questId: params.questId,
				event: "rescue_invoked",
				agentRole: "rescue",
				workItemId: params.workItemId,
				status: result.exitCode === 0 ? "completed" : "failed",
			};
			fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");

			return {
				content: [
					{
						type: "text",
						text:
							`Rescue review for ${params.workItemId} finished with exit code ${result.exitCode}.\n` +
							(result.stdoutTruncated || result.stderrTruncated
								? `Output capture was truncated to the last ${MAX_SUBAGENT_CAPTURE_CHARS} chars per stream.\n`
								: "") +
							"\n" +
							(result.stderr ? `Stderr:\n${result.stderr.slice(-2000)}\n\n` : "") +
							`Rescue output:\n${result.stdout.slice(-4000)}`,
					},
				],
				details: {
					exitCode: result.exitCode,
					questId: params.questId,
					workItemId: params.workItemId,
				},
			};
		},
	});

	pi.registerTool({
		name: "quest_write_workflow",
		label: "Write Quest Workflow",
		description: "Read or update a quest's workflow.json with status transition safety.",
		promptSnippet: "Update quest workflow status safely with transition validation",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			action: StringEnum(["read", "set-status"] as const),
			status: Type.Optional(Type.String({ description: "New status (for set-status)" })),
			force: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questDir = questDirPath(ctx.cwd, params.questId);
			const workflow = loadQuestWorkflow(questDir);
			if (!workflow) {
				return {
					content: [{ type: "text", text: `Quest '${params.questId}' not found.` }],
					isError: true,
					details: {},
				};
			}

			if (params.action === "read") {
				return {
					content: [{ type: "text", text: JSON.stringify(workflow, null, 2) }],
					details: { workflow },
				};
			}

			if (params.action === "set-status" && params.status) {
				if (!params.force && !isValidTransition(workflow.status, params.status as QuestStatus)) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid transition: ${workflow.status} → ${params.status}. Use force=true to override.`,
							},
						],
						isError: true,
						details: { currentStatus: workflow.status, requestedStatus: params.status },
					};
				}
				workflow.status = params.status as QuestStatus;
				workflow.updatedAt = new Date().toISOString();
				saveQuestWorkflow(questDir, workflow);
				return {
					content: [{ type: "text", text: `Status updated to '${params.status}' for quest '${params.questId}'.` }],
					details: { workflow },
				};
			}

			return {
				content: [{ type: "text", text: "Invalid action." }],
				isError: true,
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "quest_telemetry_event",
		label: "Quest Telemetry Event",
		description: "Record a telemetry event for a quest.",
		promptSnippet: "Log a structured telemetry event to the quest's telemetry/events.jsonl",
		parameters: Type.Object({
			questId: Type.String({ description: "Quest ID" }),
			event: Type.String({ description: "Event type" }),
			agentRole: Type.Optional(Type.String()),
			workItemId: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
			inputTokens: Type.Optional(Type.Number()),
			outputTokens: Type.Optional(Type.Number()),
			durationMs: Type.Optional(Type.Number()),
			status: Type.Optional(Type.String()),
			filesChanged: Type.Optional(Type.Array(Type.String())),
			commandsRun: Type.Optional(Type.Array(Type.String())),
			rescueUsed: Type.Optional(Type.Boolean()),
			details: Type.Optional(Type.Object({})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questDir = questDirPath(ctx.cwd, params.questId);
			if (!fs.existsSync(questDir)) {
				return {
					content: [{ type: "text", text: `Quest '${params.questId}' not found.` }],
					isError: true,
					details: {},
				};
			}

			const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
			ensureDir(path.dirname(telemetryPath));
			const event = {
				timestamp: new Date().toISOString(),
				questId: params.questId,
				...Object.fromEntries(Object.entries(params).filter(([k]) => k !== "questId")),
			};
			fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");

			return {
				content: [{ type: "text", text: "Telemetry event recorded." }],
				details: { event },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const ids = getAllQuestIds(ctx.cwd);
		for (const id of ids) loadedQuestIds.add(id);
	});
}
