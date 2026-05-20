/**
 * Quest dashboard — split-pane overlay for browsing quests.
 */

import {
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { QuestStatus } from "../../lib.js";
import {
	getQuestSummaries,
	getQuestDetail,
	getPausedRuns,
	formatPausedRunLabel,
	readArtifactFile,
	type QuestSummary,
} from "./data.js";
import { discardRun, forceCompleteRun } from "./dashboard-actions.js";
import { renderStagePipeline } from "./stage-pipeline.js";

type ViewMode = "detail" | "markdown";

interface DashboardTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}

export function formatRelative(isoDate: string): string {
	const then = new Date(isoDate).getTime();
	const now = Date.now();
	const diffSec = Math.floor((now - then) / 1000);
	if (diffSec < 60) return "just now";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 7) return `${diffDay}d ago`;
	return new Date(isoDate).toLocaleDateString();
}

export class QuestDashboard implements Component {
	private quests: QuestSummary[] = [];
	private selectedIndex = 0;
	private leftScrollOffset = 0;
	private rightScrollOffset = 0;
	private markdownScrollOffset = 0;
	private visibleRows = 30;
	private viewMode: ViewMode = "detail";
	private markdownContent = "";
	private markdownTitle = "";
	private cachedMarkdown?: Markdown;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private ctx: ExtensionContext;
	private onClose: () => void;
	private theme: DashboardTheme;

	constructor(ctx: ExtensionContext, theme: DashboardTheme, onClose: () => void) {
		this.ctx = ctx;
		this.theme = theme;
		this.onClose = onClose;
		this.refreshData();
	}

	setVisibleRows(rows: number) {
		this.visibleRows = rows;
		this.invalidate();
	}

	refreshData() {
		const prevId = this.quests[this.selectedIndex]?.id;
		this.quests = getQuestSummaries(this.ctx.cwd);
		if (this.quests.length === 0) {
			this.selectedIndex = 0;
			this.invalidate();
			return;
		}
		// If previously selected quest disappeared, select next available
		if (prevId && !this.quests.some((q) => q.id === prevId)) {
			this.selectedIndex = Math.min(this.selectedIndex, this.quests.length - 1);
		}
		if (this.selectedIndex >= this.quests.length) {
			this.selectedIndex = Math.max(0, this.quests.length - 1);
		}
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.viewMode === "markdown") {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace)) {
				this.viewMode = "detail";
				this.markdownScrollOffset = 0;
				this.invalidate();
			} else if (matchesKey(data, Key.up)) {
				if (this.markdownScrollOffset > 0) {
					this.markdownScrollOffset--;
					this.invalidate();
				}
			} else if (matchesKey(data, Key.down)) {
				this.markdownScrollOffset++;
				this.invalidate();
			} else if (matchesKey(data, Key.pageUp)) {
				this.markdownScrollOffset = Math.max(0, this.markdownScrollOffset - 5);
				this.invalidate();
			} else if (matchesKey(data, Key.pageDown)) {
				this.markdownScrollOffset += 5;
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.ensureSelectionVisible();
				this.invalidate();
			}
		} else if (matchesKey(data, Key.down)) {
			if (this.selectedIndex < this.quests.length - 1) {
				this.selectedIndex++;
				this.ensureSelectionVisible();
				this.invalidate();
			}
		} else if (matchesKey(data, Key.enter)) {
			const quest = this.quests[this.selectedIndex];
			if (quest) {
				// Fire-and-forget async selection
				void this.selectQuest(quest.id);
			}
		} else if (data >= "1" && data <= "8") {
			// Number keys open artifacts 1-8 (Brief is #8 — M4-1).
			const artifactIndex = parseInt(data, 10) - 1;
			this.openArtifact(artifactIndex);
		} else if (data === "d") {
			// ADR 014 Discard action on the first paused run for the selected quest.
			void this.discardSelectedPausedRun().then(() => this.refreshData());
		} else if (data === "f") {
			// ADR 014 Force-Complete action on the first paused run.
			void this.forceCompleteSelectedPausedRun().then(() => this.refreshData());
		} else if (matchesKey(data, Key.pageUp)) {
			this.rightScrollOffset = Math.max(0, this.rightScrollOffset - 5);
			this.invalidate();
		} else if (matchesKey(data, Key.pageDown)) {
			this.rightScrollOffset += 5;
			this.invalidate();
		}
	}

	private ensureSelectionVisible() {
		// Each quest takes 2 lines in the left pane
		const questVisibleCount = Math.floor((this.visibleRows - 2) / 2);
		if (this.selectedIndex < this.leftScrollOffset) {
			this.leftScrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.leftScrollOffset + questVisibleCount) {
			this.leftScrollOffset = this.selectedIndex - questVisibleCount + 1;
		}
	}

	private async selectQuest(questId: string) {
		const { saveCurrentState } = await import("../state.js");
		saveCurrentState(this.ctx.cwd, { currentQuestId: questId });
		this.ctx.ui.notify(`Active quest set to '${questId}'`, "info");
		this.refreshData();
	}

	/**
	 * Discard the oldest paused run on the currently selected quest.
	 *
	 * Exposed as a public method (rather than a private bound action) so the
	 * `d` key binding and tests can drive it without re-deriving the run target.
	 */
	async discardSelectedPausedRun(): Promise<void> {
		const quest = this.quests[this.selectedIndex];
		if (!quest) return;
		const paused = getPausedRuns(this.ctx.cwd, quest.id);
		const target = paused[0];
		if (!target) return;
		try {
			await discardRun({ cwd: this.ctx.cwd, questId: quest.id, runId: target.runId });
			this.ctx.ui.notify(`Discarded run ${target.runId}`, "info");
		} catch (err) {
			this.ctx.ui.notify(
				`Discard failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	}

	/**
	 * Force-Complete the oldest paused run on the currently selected quest.
	 *
	 * On merge conflict the run stays paused and a halt-tier anomaly is logged
	 * (see {@link forceCompleteRun}).
	 */
	async forceCompleteSelectedPausedRun(): Promise<void> {
		const quest = this.quests[this.selectedIndex];
		if (!quest) return;
		const paused = getPausedRuns(this.ctx.cwd, quest.id);
		const target = paused[0];
		if (!target) return;
		try {
			await forceCompleteRun({
				cwd: this.ctx.cwd,
				questId: quest.id,
				runId: target.runId,
			});
			this.ctx.ui.notify(`Force-completed run ${target.runId}`, "info");
		} catch (err) {
			this.ctx.ui.notify(
				`Force-complete failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	}

	private openArtifact(index: number) {
		const quest = this.quests[this.selectedIndex];
		if (!quest) return;
		const detail = getQuestDetail(this.ctx.cwd, quest.id);
		if (!detail) return;
		const art = detail.artifacts[index];
		if (!art?.exists || !art.filePath) return;
		const content = readArtifactFile(art.filePath);
		if (content === undefined) return;
		this.invalidateMarkdownCache();
		this.markdownContent = content;
		this.markdownTitle = art.label;
		this.markdownScrollOffset = 0;
		this.viewMode = "markdown";
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		if (this.viewMode === "markdown") {
			this.cachedLines = this.renderMarkdownView(width);
			this.cachedWidth = width;
			return this.cachedLines;
		}

		this.cachedLines = this.renderDashboard(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	private renderDashboard(width: number): string[] {
		if (this.quests.length === 0) {
			return [
				this.theme.fg("dim", "No quests found. Create one with /quest intake <handoff.md>"),
			];
		}

		const leftWidth = Math.min(Math.max(25, Math.floor(width * 0.3)), 40);
		const dividerWidth = 1;
		const rightWidth = width - leftWidth - dividerWidth;

		const leftLines = this.renderLeftPane(leftWidth);
		const rightLines = this.renderRightPane(rightWidth);

		// Clip to visible rows
		const clippedLeft = leftLines.slice(this.leftScrollOffset, this.leftScrollOffset + this.visibleRows);
		const clippedRight = rightLines.slice(this.rightScrollOffset, this.rightScrollOffset + this.visibleRows);
		const maxLines = Math.max(clippedLeft.length, clippedRight.length);

		const result: string[] = [];
		for (let i = 0; i < maxLines; i++) {
			const left = clippedLeft[i] ?? "";
			const right = clippedRight[i] ?? "";
			const divider = this.theme.fg("border", "│");
			const leftTruncated = truncateToWidth(left, leftWidth);
			const leftPadded = leftTruncated + " ".repeat(Math.max(0, leftWidth - visibleWidth(leftTruncated)));
			result.push(leftPadded + divider + right);
		}

		return result;
	}

	private renderLeftPane(width: number): string[] {
		const lines: string[] = [];
		const t = this.theme;

		lines.push(t.fg("accent", t.bold(" Quests ")));
		lines.push(t.dim("─".repeat(width)));

		for (let i = 0; i < this.quests.length; i++) {
			const q = this.quests[i];
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? t.fg("accent", "▸ ") : t.dim("  ");
			const marker = q.isActive ? t.fg("accent", "● ") : t.dim("  ");

			const statusColor =
				q.status === "completed"
					? "success"
					: q.status === "blocked"
						? "error"
						: q.status === "executing"
							? "warning"
							: "muted";

			const title = truncateToWidth(q.title, width - 8);
			const line = prefix + marker + title;
			const statusTag = t.fg(statusColor, q.status);

			lines.push(truncateToWidth(line, width));
			lines.push(truncateToWidth(t.dim("    ") + statusTag, width));
		}

		return lines;
	}

	private renderRightPane(width: number): string[] {
		const quest = this.quests[this.selectedIndex];
		if (!quest) return [];

		const detail = getQuestDetail(this.ctx.cwd, quest.id);
		if (!detail) return [this.theme.fg("error", "Quest data missing")];

		const lines: string[] = [];
		const t = this.theme;
		const wf = detail.workflow;

		// Header
		lines.push("");
		lines.push(t.fg("accent", t.bold(truncateToWidth(wf.title, width))));
		lines.push(t.dim(`ID: ${wf.id}  •  Updated: ${formatRelative(wf.updatedAt)}`));
		lines.push("");

		// Status badge + stage pipeline
		const statusColor =
			wf.status === "completed"
				? "success"
				: wf.status === "blocked"
					? "error"
					: wf.status === "executing"
						? "warning"
						: "accent";
		lines.push(t.fg(statusColor, t.bold(`Status: ${wf.status}`)));
		lines.push(...renderStagePipeline(wf.status, width, t.fg.bind(t), t.dim.bind(t)));
		lines.push("");

		// Artifacts
		lines.push(t.fg("accent", t.bold("Artifacts")));
		let artIndex = 0;
		for (const art of detail.artifacts) {
			artIndex++;
			const icon = art.exists ? t.fg("success", "✓") : t.dim("○");
			const name = art.exists
				? t.fg("text", `${artIndex}. ${art.label}`)
				: t.dim(`${artIndex}. ${art.label}`);
			lines.push(`  ${icon} ${name}`);
		}
		lines.push("");

		// Work items
		lines.push(t.fg("accent", t.bold("Work Items")));
		if (detail.workItems.length === 0) {
			lines.push(t.dim("  No work items yet."));
		} else {
			for (const wi of detail.workItems) {
				const icon = wi.latestRunStatus === "completed"
					? t.fg("success", "✓")
					: wi.latestRunStatus === "running"
						? t.fg("warning", "⟳")
						: wi.latestRunStatus === "failed"
							? t.fg("error", "✗")
							: t.dim("○");
				const name = truncateToWidth(wi.id, width - 6);
				lines.push(`  ${icon} ${name}`);
			}
		}
		lines.push("");

		// Recent runs
		lines.push(t.fg("accent", t.bold("Recent Runs")));
		if (detail.recentRuns.length === 0) {
			lines.push(t.dim("  No runs yet."));
		} else {
			for (const run of detail.recentRuns) {
				const icon = run.status === "completed"
					? t.fg("success", "✓")
					: run.status === "running"
						? t.fg("warning", "⟳")
						: run.status === "paused"
							? t.fg("warning", "⏸")
							: t.fg("error", "✗");
				const info = `${run.workItemId} • ${run.status}`;
				lines.push(`  ${icon} ${truncateToWidth(info, width - 6)}`);
			}
		}
		lines.push("");

		// Paused Runs (ADR 014) — separate row variant with action hints. Resume
		// (M4-4) deliberately omitted; only Discard / Force-Complete are wired.
		const paused = getPausedRuns(this.ctx.cwd, quest.id);
		if (paused.length > 0) {
			lines.push(t.fg("accent", t.bold("Paused Runs")));
			for (const run of paused) {
				const label = formatPausedRunLabel(run.paused_at, run.paused_reason);
				const head = `  ${t.fg("warning", "⏸")} ${run.workItemId} • ${label}`;
				lines.push(truncateToWidth(head, width));
				lines.push(t.dim(`      [d] Discard  [f] Force-Complete`));
			}
			lines.push("");
		}

		// Footer hint
		lines.push(t.dim("↑↓ navigate • enter select quest • 1-8 view artifact • d/f act on paused • esc close"));

		return lines;
	}

	private renderMarkdownView(width: number): string[] {
		const lines: string[] = [];
		const t = this.theme;

		lines.push(t.fg("accent", t.bold(truncateToWidth(this.markdownTitle, width))));
		lines.push(t.dim("─".repeat(width)));
		lines.push("");

		if (!this.cachedMarkdown) {
			const mdTheme = getMarkdownTheme();
			this.cachedMarkdown = new Markdown(this.markdownContent, 0, 0, mdTheme);
		}
		const mdLines = this.cachedMarkdown.render(width);
		const clipped = mdLines.slice(this.markdownScrollOffset, this.markdownScrollOffset + this.visibleRows);
		lines.push(...clipped);

		lines.push("");
		lines.push(t.dim("─".repeat(width)));
		lines.push(t.dim("esc / backspace to return"));

		return lines;
	}

	private invalidateMarkdownCache() {
		this.cachedMarkdown = undefined;
	}
}
