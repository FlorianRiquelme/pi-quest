/**
 * UAT failure loop (ADR 016 §5, M4-3).
 *
 * When all UAT scenarios are resolved and at least one carries `verdict: fail`,
 * the UAT skill offers the user two paths:
 *
 *   - Iterate: drafts new work-items addressing each failed scenario, appends
 *     them to `IMPLEMENTATION_PLAN.md`'s frontmatter, and resets the failed
 *     scenarios in `UAT.md` back to `pending` for retesting. The skill then
 *     instructs the user to move the quest back to `planned`, re-engaging the
 *     Launch Review ceremony on the new scope (per ADR 012).
 *
 *   - Accept: skill instructs the user to `/quest set-status <id> uat-failed`
 *     for manual triage. No work-items drafted here.
 *
 * This module owns the Iterate path's data manipulation. The Accept path is
 * pure conversation — no helper needed.
 *
 * Work-item drafting is heuristic per the M4-3 issue spec:
 *   - name        := <scenario name> + " (UAT fix)"
 *   - acceptance  := scenario.verify
 *   - verification := scenario.actions
 *   - claims      := [] (user fills in)
 */

import * as fs from "node:fs";
import {
	readPlanFrontmatter,
	writePlanFrontmatter,
	type FrontmatterValue,
} from "./launch-review.js";
import { updateScenarioVerdict, type UatScenario } from "./uat-scenarios.js";

/* ================================ Types ================================ */

export interface WorkItem {
	id: string;
	name: string;
	acceptance: string[];
	verification: string[];
	claims: string[];
}

export interface FailureLoopInput {
	questId: string;
	failedScenarios: UatScenario[];
	planPath: string;
	uatPath: string;
}

export interface FailureLoopResult {
	newWorkItems: WorkItem[];
	planUpdated: boolean;
}

/* ================================ Public API ================================ */

/**
 * Iterate path of the UAT failure loop.
 *
 * Drafts one work-item per failed scenario, appends them to the plan's
 * `work_items:` frontmatter, and resets each scenario's verdict back to
 * `pending`. The caller is responsible for the status transition itself
 * (`uat-ready → planned` or `uat-failed → planned`).
 */
export function iterateOnFailures(input: FailureLoopInput): FailureLoopResult {
	const { questId: _questId, failedScenarios, planPath, uatPath } = input;
	if (failedScenarios.length === 0) {
		return { newWorkItems: [], planUpdated: false };
	}

	// Read existing IDs so we can mint non-colliding new ones.
	const fm = readPlanFrontmatter(planPath);
	const existingItems = Array.isArray(fm.work_items)
		? (fm.work_items as Array<{ [key: string]: FrontmatterValue }>)
		: [];
	const existingIds = new Set<string>();
	for (const item of existingItems) {
		if (item && typeof item.id === "string") existingIds.add(item.id);
	}

	const newWorkItems: WorkItem[] = [];
	let nextNumber = highestWiNumber(existingIds) + 1;
	for (const sc of failedScenarios) {
		const id = mintWorkItemId(existingIds, () => `WI-${nextNumber++}`);
		existingIds.add(id);
		newWorkItems.push({
			id,
			name: `${sc.name} (UAT fix)`,
			acceptance: [...sc.verify],
			verification: [...sc.actions],
			claims: [],
		});
	}

	// Append serialised work-items.
	const serialisedAppend: FrontmatterValue[] = newWorkItems.map((wi) => ({
		id: wi.id,
		name: wi.name,
		acceptance: wi.acceptance as FrontmatterValue,
		verification: wi.verification as FrontmatterValue,
		claims: wi.claims as FrontmatterValue,
	}));
	const mergedItems: FrontmatterValue[] = [
		...existingItems,
		...serialisedAppend,
	];
	writePlanFrontmatter(planPath, { work_items: mergedItems });

	// Reset failed scenarios in UAT.md back to pending (with cleared notes) so
	// the next pass through the skill walks them again.
	if (fs.existsSync(uatPath)) {
		for (const sc of failedScenarios) {
			updateScenarioVerdict(uatPath, sc.id, "pending");
		}
	}

	return { newWorkItems, planUpdated: true };
}

/* ================================ Internals ================================ */

/**
 * Parse the trailing integer of `WI-<n>` ids; returns 0 if none match.
 * Used to pick the next non-colliding number when minting new work-items.
 */
function highestWiNumber(ids: Iterable<string>): number {
	let max = 0;
	for (const id of ids) {
		const m = id.match(/^WI-(\d+)$/);
		if (m) {
			const n = Number(m[1]);
			if (n > max) max = n;
		}
	}
	return max;
}

function mintWorkItemId(existing: Set<string>, gen: () => string): string {
	for (let i = 0; i < 1000; i++) {
		const candidate = gen();
		if (!existing.has(candidate)) return candidate;
	}
	throw new Error("Could not mint a non-colliding work-item id");
}
