/**
 * Visual stage pipeline for quest workflow status.
 */

import type { QuestStatus } from "../../lib.js";

const STAGES: QuestStatus[] = [
	"intake",
	"recon-ready",
	"reviewing",
	"resolved",
	"planned",
	"launch-review",
	"executing",
	"verification",
	"verification-ready",
	"uat-ready",
	"completed",
];

function stageIndex(status: QuestStatus): number {
	return STAGES.indexOf(status);
}

function stageLabel(status: QuestStatus): string {
	return status;
}

export function renderStagePipeline(
	currentStatus: QuestStatus,
	width: number,
	fg: (color: string, text: string) => string,
	dim: (text: string) => string,
): string[] {
	const currentIdx = stageIndex(currentStatus);

	// Build compact segments
	const segments: string[] = [];
	for (let i = 0; i < STAGES.length; i++) {
		const stage = STAGES[i];
		const label = stageLabel(stage);
		if (i < currentIdx) {
			// Completed
			segments.push(fg("success", `✓ ${label}`));
		} else if (i === currentIdx) {
			// Current
			segments.push(fg("accent", `➤ ${label}`));
		} else {
			// Future
			segments.push(dim(`○ ${label}`));
		}
	}

	const fullLine = segments.join(dim(" → "));

	// If it fits, return single line
	if (fullLine.length <= width) {
		return [fullLine];
	}

	// Truncate: show current stage with a few neighbors
	const truncated: string[] = [];
	for (let i = 0; i < STAGES.length; i++) {
		const stage = STAGES[i];
		// Skip stages that are far from current
		if (Math.abs(i - currentIdx) > 2 && i !== 0 && i !== STAGES.length - 1) {
			if (truncated[truncated.length - 1] !== "…") {
				truncated.push(dim("…"));
			}
			continue;
		}
		const label = stageLabel(stage);
		if (i < currentIdx) {
			truncated.push(fg("success", `✓ ${label}`));
		} else if (i === currentIdx) {
			truncated.push(fg("accent", `➤ ${label}`));
		} else {
			truncated.push(dim(`○ ${label}`));
		}
	}

	const line = truncated.join(dim(" → "));
	if (line.length <= width) return [line];

	// Still too long — just show current stage
	return [fg("accent", `➤ ${stageLabel(currentStatus)}`)];
}
