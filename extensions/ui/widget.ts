/**
 * Active quest widget — persistent 2-line display above the editor.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	countCompletedWorkItems,
	countRunningWorkItems,
	getActiveQuestSummary,
	getTotalWorkItems,
} from "./data.js";

export function setQuestWidget(ctx: ExtensionContext) {
	ctx.ui.setWidget(
		"quest",
		(_tui, theme) => {
			return {
				render: (width: number) => {
					const summary = getActiveQuestSummary(ctx.cwd);
					if (!summary) {
						return [truncateToWidth(theme.fg("dim", "No active quest — /quest intake <handoff.md>"), width)];
					}

					const running = countRunningWorkItems(ctx.cwd, summary.id);
					const completed = countCompletedWorkItems(ctx.cwd, summary.id);
					const total = getTotalWorkItems(ctx.cwd, summary.id);

					const statusColor =
						summary.status === "completed"
							? "success"
							: summary.status === "blocked" || summary.status === "uat-failed"
								? "error"
								: summary.status === "executing"
									? "warning"
									: "accent";

					const prefix = theme.fg("dim", "Active: ");
					const suffix = theme.fg("dim", " — ") + theme.fg(statusColor, summary.status);
					const prefixWidth = visibleWidth(prefix);
					const suffixWidth = visibleWidth(suffix);
					const maxTitleWidth = Math.max(0, width - prefixWidth - suffixWidth);
					const title = truncateToWidth(theme.fg("text", summary.title), maxTitleWidth);
					const line1 = prefix + title + suffix;

					const parts: string[] = [];
					if (running > 0) {
						parts.push(theme.fg("warning", `${running} running`));
					}
					if (total > 0) {
						parts.push(theme.fg("dim", `${completed}/${total} done`));
					} else {
						parts.push(theme.fg("dim", "no work items"));
					}
					const line2 = truncateToWidth(theme.fg("dim", "  ") + parts.join(theme.fg("dim", "  •  ")), width);

					return [line1, line2];
				},
				invalidate: () => {},
			};
		},
		{ placement: "aboveEditor" },
	);
}

export function clearQuestWidget(ctx: ExtensionContext) {
	ctx.ui.setWidget("quest", undefined);
}
