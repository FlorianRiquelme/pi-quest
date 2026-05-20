/**
 * Opens the quest dashboard overlay.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuestDashboard } from "./dashboard.js";
import { clearQuestWidget, setQuestWidget } from "./widget.js";

const REFRESH_INTERVAL_MS = 2000;

export async function openDashboard(ctx: ExtensionContext) {
	// Hide the active-quest widget so the dashboard feels like a true full-screen context switch
	clearQuestWidget(ctx);

	await ctx.ui.custom<undefined>((tui, theme, _kb, done) => {
		let timer: NodeJS.Timeout | undefined;

		const dashboard = new QuestDashboard(
			ctx,
			{
				fg: theme.fg.bind(theme),
				bg: theme.bg.bind(theme),
				bold: theme.bold.bind(theme),
				dim: (text: string) => theme.fg("dim", text),
			},
			() => {
				if (timer) clearInterval(timer);
				done(undefined);
			},
		);

		// Use the full terminal height for the dashboard rows
		dashboard.setVisibleRows(Math.max(1, tui.terminal.rows));

		// Auto-refresh every 2 seconds while dashboard is open
		timer = setInterval(() => {
			dashboard.refreshData();
			tui.requestRender();
		}, REFRESH_INTERVAL_MS);

		const component = {
			render: (width: number) => {
				const lines = dashboard.render(width);
				// Pad to full terminal height so the overlay covers the entire screen
				const targetRows = tui.terminal.rows;
				if (lines.length >= targetRows) return lines;
				const padded = [...lines];
				const emptyLine = " ".repeat(width);
				while (padded.length < targetRows) {
					padded.push(emptyLine);
				}
				return padded;
			},
			invalidate: () => dashboard.invalidate(),
			handleInput: (data: string) => {
				dashboard.handleInput(data);
				tui.requestRender();
			},
			dispose: () => {
				if (timer) clearInterval(timer);
				// Restore the active-quest widget when the dashboard closes
				setQuestWidget(ctx);
			},
		};

		// Force a full screen clear so the overlay truly covers everything
		tui.requestRender(true);

		return component;
	}, {
		overlay: true,
		overlayOptions: {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			row: 0,
			col: 0,
			margin: 0,
		},
	});
}
