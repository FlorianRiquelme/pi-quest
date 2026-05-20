/**
 * Homecoming Brief generator (ADR 015, M4-1).
 *
 * Produces `.pi/quests/<questId>/BRIEF.md` — a six-section postcard the user
 * receives when they return to an active **Quest** after autonomous work has
 * progressed.
 *
 * Five sections are template-driven (event log + reports + git stats); the
 * Narrative section is composed by a small autonomous subagent
 * (`agents/homecoming.md`). The agent spawn is injected via
 * `spawnNarrativeAgent` so tests can stub it without invoking the real CLI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	computeWall,
	computeCompute,
	formatTwoClocks,
	formatDuration,
} from "./ui/two-clocks.js";
import type { QuestEvent } from "./events.js";
import type { QuestStatus, QuestWorkflow } from "../lib.js";

/* ================================ Public API ================================ */

export interface GitStats {
	filesChanged: number;
	linesAdded: number;
	linesRemoved: number;
	commits: number;
}

export interface NarrativeSpawnInput {
	eventLogPath: string;
	reportsDir: string;
	questId: string;
	questDir: string;
}

export interface GenerateBriefOptions {
	repoRoot: string;
	questId: string;
	/**
	 * Inject the narrative composer. Production wires this to a real subagent
	 * spawn; tests inject a canned callback. Returns the narrative prose only
	 * (no heading).
	 */
	spawnNarrativeAgent: (input: NarrativeSpawnInput) => Promise<string>;
	/**
	 * Inject git statistics. Production runs `git diff --shortstat` and `git
	 * rev-list` between baseSha and questBranch; tests inject fixed numbers.
	 */
	gitStats?: (opts: {
		repoRoot: string;
		baseSha?: string;
		questBranch?: string;
	}) => Promise<GitStats>;
	/** Inject `Date.now()` for deterministic tests. */
	now?: () => number;
}

export interface GenerateBriefResult {
	briefPath?: string;
	content: string;
}

/**
 * Generate the Homecoming Brief for a quest. Writes the markdown to
 * `<questDir>/BRIEF.md` and returns the path + content. If the quest does not
 * exist, returns an empty result without touching disk.
 */
export async function generateHomecomingBrief(
	options: GenerateBriefOptions,
): Promise<GenerateBriefResult> {
	const questDir = path.join(options.repoRoot, ".pi", "quests", options.questId);
	const workflowPath = path.join(questDir, "workflow.json");
	if (!fs.existsSync(workflowPath)) {
		return { content: "" };
	}

	const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8")) as QuestWorkflow;
	const events = readEventsJsonl(path.join(questDir, "telemetry", "events.jsonl"));
	const runs = listRunSummaries(path.join(questDir, "runs"));
	const now = options.now ? options.now() : Date.now();

	// Title bar.
	const wallMs = computeWall({ status: workflow.status, events, now });
	const computeMs = computeCompute(events);

	const titleBar = renderTitleBar({
		questId: workflow.id,
		title: workflow.title,
		status: workflow.status,
		runsCompleted: runs.filter((r) => r.status === "completed").length,
		runsTotal: runs.length,
		wallMs,
		computeMs,
		baseSha: workflow.baseSha,
		questBranch: workflow.questBranch,
	});

	// Narrative — injected callback.
	const narrativeBody = await options.spawnNarrativeAgent({
		eventLogPath: path.join(questDir, "telemetry", "events.jsonl"),
		reportsDir: path.join(questDir, "reports"),
		questId: workflow.id,
		questDir,
	});
	const narrative = `## Narrative\n\n${narrativeBody.trim()}\n`;

	// Concessions & anomalies from the event log.
	const concessions = renderConcessions(events);
	const anomalies = renderAnomalies(events);

	// Receipt: aggregate tokens + git stats.
	const gitStatsFn = options.gitStats ?? defaultGitStats;
	const gitStats = await gitStatsFn({
		repoRoot: options.repoRoot,
		baseSha: workflow.baseSha,
		questBranch: workflow.questBranch,
	}).catch(() => ({ filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 }));

	const receipt = computeReceipt({
		events,
		gitStats,
		testBaseline: undefined,
		testCurrent: undefined,
		model: "sonnet",
	});
	const receiptSection = renderReceipt(receipt);

	// Next.
	const next = renderNext(workflow.status, workflow.id);

	const content =
		[titleBar, narrative, concessions, anomalies, receiptSection, next]
			.map((s) => s.trim())
			.join("\n\n") + "\n";

	const briefPath = path.join(questDir, "BRIEF.md");
	fs.writeFileSync(briefPath, content, "utf-8");
	return { briefPath, content };
}

/* ================================ Section renderers ================================ */

export interface TitleBarInput {
	questId: string;
	title: string | undefined;
	status: string;
	runsCompleted: number;
	runsTotal: number;
	wallMs: number;
	computeMs: number;
	baseSha: string | undefined;
	questBranch: string | undefined;
}

export function renderTitleBar(input: TitleBarInput): string {
	// Auto-name slot is reserved by ADR 015 §5 — fall back to quest ID when
	// `title` is missing or matches the ID directly.
	const displayName =
		input.title && input.title.trim().length > 0 && input.title.trim() !== input.questId
			? input.title.trim()
			: input.questId;

	const clocks = formatTwoClocks(input.wallMs, input.computeMs);
	const header = `# ${displayName} · ${input.status} · ${input.runsCompleted}/${input.runsTotal} · ${clocks}`;

	const lines: string[] = [header];
	if (input.baseSha || input.questBranch) {
		const shaShort = input.baseSha ? input.baseSha.slice(0, 7) : "(no Base SHA)";
		const branch = input.questBranch ?? "(no Quest Branch)";
		lines.push(`Base ${shaShort} · ${branch}`);
	}
	return lines.join("\n");
}

export function renderConcessions(events: QuestEvent[]): string {
	const concessions = events.filter((e) => e.event === "concession");
	if (concessions.length === 0) {
		return `## Concessions\n\n_No concessions recorded._`;
	}
	const lines = concessions.map((e) => {
		// Event union — `decision` and `rationale` exist on the concession variant.
		const c = e as Extract<QuestEvent, { event: "concession" }>;
		return `- ${c.decision} — ${c.rationale}`;
	});
	return `## Concessions\n\n${lines.join("\n")}`;
}

export function renderAnomalies(events: QuestEvent[]): string {
	const anomalies = events.filter((e) => e.event === "anomaly_detected");
	if (anomalies.length === 0) {
		return `## Anomalies\n\n_No anomalies detected._`;
	}
	const lines = anomalies.map((e) => {
		const a = e as Extract<QuestEvent, { event: "anomaly_detected" }>;
		// Best-effort short detail: pick the first string-like value from details, if any.
		let detail = "";
		if (a.details && typeof a.details === "object") {
			const d = a.details as Record<string, unknown>;
			const firstString = Object.values(d).find((v) => typeof v === "string");
			if (firstString) detail = ` — ${String(firstString)}`;
		}
		return `- [${a.tier}] ${a.rule}${detail}`;
	});
	return `## Anomalies\n\n${lines.join("\n")}`;
}

/* ================================ Receipt ================================ */

export interface ReceiptInput {
	events: QuestEvent[];
	gitStats: GitStats;
	testBaseline: number | undefined;
	testCurrent: number | undefined;
	/** Defaults to `"sonnet"` (default pricing). Pass `"haiku"` or `"opus"` to swap. */
	model: "sonnet" | "haiku" | "opus";
}

export interface ReceiptOutput {
	filesChanged: number;
	linesAdded: number;
	linesRemoved: number;
	commits: number;
	testBaseline: number | undefined;
	testCurrent: number | undefined;
	testDelta: number | undefined;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	humanTimeSavedMinutes: number;
}

/**
 * Pricing per 1M tokens. Heuristic — kept simple per ADR 015 §3.
 *
 *   sonnet: $3 input / $15 output
 *   haiku:  $0.25 input / $1.25 output
 *   opus:   $15 input / $75 output
 */
const PRICING: Record<"sonnet" | "haiku" | "opus", { input: number; output: number }> = {
	sonnet: { input: 3, output: 15 },
	haiku: { input: 0.25, output: 1.25 },
	opus: { input: 15, output: 75 },
};

export function computeReceipt(input: ReceiptInput): ReceiptOutput {
	let inputTokens = 0;
	let outputTokens = 0;
	for (const e of input.events) {
		if (e.event !== "run_finished") continue;
		const d = (e.details ?? {}) as Record<string, unknown>;
		const i = typeof d.inputTokens === "number" ? d.inputTokens : 0;
		const o = typeof d.outputTokens === "number" ? d.outputTokens : 0;
		inputTokens += i;
		outputTokens += o;
	}

	const pricing = PRICING[input.model];
	const costUsd = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;

	const totalLines = input.gitStats.linesAdded + input.gitStats.linesRemoved;
	// Heuristic: 30 min per 1000 lines changed.
	const humanTimeSavedMinutes = Math.round((totalLines / 1000) * 30);

	const testDelta =
		input.testBaseline !== undefined && input.testCurrent !== undefined
			? input.testCurrent - input.testBaseline
			: undefined;

	return {
		filesChanged: input.gitStats.filesChanged,
		linesAdded: input.gitStats.linesAdded,
		linesRemoved: input.gitStats.linesRemoved,
		commits: input.gitStats.commits,
		testBaseline: input.testBaseline,
		testCurrent: input.testCurrent,
		testDelta,
		inputTokens,
		outputTokens,
		costUsd,
		humanTimeSavedMinutes,
	};
}

export function renderReceipt(r: ReceiptOutput): string {
	let testLine: string;
	if (r.testBaseline !== undefined && r.testCurrent !== undefined && r.testDelta !== undefined) {
		const sign = r.testDelta >= 0 ? "+" : "";
		testLine = `Tests: ${r.testBaseline} → ${r.testCurrent} (delta: ${sign}${r.testDelta})`;
	} else if (r.testCurrent !== undefined) {
		testLine = `Tests: ${r.testCurrent} (baseline not recorded)`;
	} else {
		testLine = `Tests: (not measured)`;
	}

	const lines = [
		`- Files changed: ${r.filesChanged}`,
		`- Lines (+/-): ${r.linesAdded}/${r.linesRemoved}`,
		`- ${testLine}`,
		`- Commits: ${r.commits}`,
		`- Tokens: ${r.inputTokens}/${r.outputTokens}`,
		`- Cost: $${r.costUsd.toFixed(2)}`,
		`- Estimated human time saved: ${formatDuration(r.humanTimeSavedMinutes * 60_000)}`,
	];
	return `## Receipt\n\n${lines.join("\n")}`;
}

/* ================================ Next ================================ */

export function renderNext(status: string, questId: string): string {
	let body: string;
	switch (status) {
		case "executing":
			body = "Next: subagents working. Watch the widget.";
			break;
		case "verification":
			body = "Next: verification in progress. Check back shortly.";
			break;
		case "verification-ready":
			body = `Next: review VERIFICATION.md and run \`/quest set-status ${questId} uat-ready\`.`;
			break;
		case "uat-ready":
			body = "Next: run through UAT scenarios via the uat skill.";
			break;
		case "completed":
			body = `Next: ship it. Quest Branch \`quest/${questId}\` is ready to merge.`;
			break;
		case "blocked":
		case "uat-failed":
			body = "Next: triage the blocking issue, then advance.";
			break;
		default:
			body = `Next: run \`/quest\` to advance the workflow.`;
			break;
	}
	return `## Next\n\n${body}`;
}

/* ================================ Triggers ================================ */

/**
 * Canonical list of autonomous-to-interactive transitions that pre-compose the
 * Brief during the transition. Per ADR 015 §1 and the M4-1 issue spec.
 *
 * Conceptually: any transition leaving an autonomous stage (intake, executing,
 * verification) and landing on an interactive stage where the user needs to
 * re-engage. The special case `verification-ready → uat-ready` is included
 * because UAT is a fresh interactive moment even though both stages are
 * interactive.
 */
export const AUTONOMOUS_TO_INTERACTIVE_TRIGGERS: ReadonlyArray<[QuestStatus, QuestStatus]> = [
	["executing", "verification-ready"],
	["executing", "blocked"],
	["executing", "verification"],
	["verification", "verification-ready"],
	["verification", "blocked"],
	["verification-ready", "uat-ready"],
];

export function isAutonomousToInteractiveTransition(from: string, to: string): boolean {
	return AUTONOMOUS_TO_INTERACTIVE_TRIGGERS.some(([f, t]) => f === from && t === to);
}

/* ================================ Helpers ================================ */

function readEventsJsonl(filePath: string): QuestEvent[] {
	if (!fs.existsSync(filePath)) return [];
	const raw = fs.readFileSync(filePath, "utf-8");
	const out: QuestEvent[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as QuestEvent);
		} catch {
			/* skip malformed */
		}
	}
	return out;
}

function listRunSummaries(runsDir: string): Array<{ status: string }> {
	if (!fs.existsSync(runsDir)) return [];
	const out: Array<{ status: string }> = [];
	for (const entry of fs.readdirSync(runsDir)) {
		if (!entry.endsWith(".json")) continue;
		try {
			const data = JSON.parse(fs.readFileSync(path.join(runsDir, entry), "utf-8"));
			if (data && typeof data.status === "string") out.push({ status: data.status });
		} catch {
			/* skip */
		}
	}
	return out;
}

/**
 * Default git-stats implementation: runs `git diff --shortstat <baseSha>..<questBranch>`
 * and `git rev-list --count` to count commits. When either side is missing,
 * returns zeros. Errors return zeros.
 */
async function defaultGitStats(opts: {
	repoRoot: string;
	baseSha?: string;
	questBranch?: string;
}): Promise<GitStats> {
	if (!opts.baseSha || !opts.questBranch) {
		return { filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 };
	}
	const { spawn } = await import("node:child_process");
	const runGit = (args: string[]): Promise<{ exitCode: number; stdout: string }> =>
		new Promise((resolve) => {
			const proc = spawn("git", args, { cwd: opts.repoRoot, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			proc.stdout?.on("data", (d) => {
				stdout += d.toString();
			});
			proc.on("close", (code) => resolve({ exitCode: code ?? 0, stdout }));
			proc.on("error", () => resolve({ exitCode: 1, stdout }));
		});

	const range = `${opts.baseSha}..${opts.questBranch}`;
	const shortstat = await runGit(["diff", "--shortstat", range]);
	const revlist = await runGit(["rev-list", "--count", range]);

	const stats: GitStats = { filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 };
	if (shortstat.exitCode === 0) {
		// e.g. "  3 files changed, 47 insertions(+), 10 deletions(-)"
		const filesM = shortstat.stdout.match(/(\d+) files? changed/);
		if (filesM) stats.filesChanged = parseInt(filesM[1], 10);
		const insM = shortstat.stdout.match(/(\d+) insertions?\(\+\)/);
		if (insM) stats.linesAdded = parseInt(insM[1], 10);
		const delM = shortstat.stdout.match(/(\d+) deletions?\(-\)/);
		if (delM) stats.linesRemoved = parseInt(delM[1], 10);
	}
	if (revlist.exitCode === 0) {
		const n = parseInt(revlist.stdout.trim(), 10);
		if (!Number.isNaN(n)) stats.commits = n;
	}
	return stats;
}
