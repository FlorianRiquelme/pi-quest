/**
 * UAT scenarios (ADR 016, M4-3).
 *
 * Parses and updates the `uat_scenarios:` block in `UAT.md`'s YAML frontmatter
 * — the Reverse Prompting contract. The UAT skill walks one pending scenario at
 * a time, asks the user for a verdict, and writes it back via
 * {@link updateScenarioVerdict}.
 *
 * Scenario shape:
 *
 *   uat_scenarios:
 *     - id: S1
 *       name: "<scenario name>"
 *       setup:    [<copy-pasteable command strings>]
 *       actions:  [<what the user does>]
 *       verify:   [<what the user checks>]
 *       verdict: pending | pass | fail | n/a
 *       notes: "<one-line note on fail / n/a>"
 *
 * Setup commands are intentionally NOT auto-executed — the skill displays them
 * as copy-pasteable code blocks per ADR 016 §2.
 */

import {
	parseFrontmatter,
	serializeFrontmatter,
	type FrontmatterValue,
	type PlanFrontmatter,
} from "./launch-review.js";
import * as fs from "node:fs";

/* ================================ Types ================================ */

export type UatVerdict = "pending" | "pass" | "fail" | "n/a";

const VALID_VERDICTS: ReadonlySet<UatVerdict> = new Set<UatVerdict>([
	"pending",
	"pass",
	"fail",
	"n/a",
]);

export interface UatScenario {
	id: string;
	name: string;
	setup: string[];
	actions: string[];
	verify: string[];
	verdict: UatVerdict;
	notes: string;
}

/* ================================ Public API ================================ */

/**
 * Parse `uat_scenarios:` out of a UAT.md document's YAML frontmatter.
 *
 * Entries without an `id` are skipped (the skill can't address a verdict to
 * them, so they're noise). Unknown verdict values fall back to `pending` so
 * the skill always has something to walk.
 */
export function parseUatScenarios(uatMarkdown: string): UatScenario[] {
	const { frontmatter } = parseFrontmatter(uatMarkdown);
	const raw = frontmatter.uat_scenarios;
	if (!Array.isArray(raw)) return [];
	const scenarios: UatScenario[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const obj = entry as { [key: string]: FrontmatterValue };
		const id = typeof obj.id === "string" ? obj.id : "";
		if (id.length === 0) continue;
		scenarios.push({
			id,
			name: typeof obj.name === "string" ? obj.name : "",
			setup: toStringArray(obj.setup),
			actions: toStringArray(obj.actions),
			verify: toStringArray(obj.verify),
			verdict: coerceVerdict(obj.verdict),
			notes: typeof obj.notes === "string" ? obj.notes : "",
		});
	}
	return scenarios;
}

/**
 * Update one scenario's verdict (and optional notes) in-place inside UAT.md.
 *
 * - Other scenarios are preserved.
 * - The markdown body below the frontmatter is preserved.
 * - When `notes` is omitted, notes is reset to "" so re-passes after a prior
 *   fail don't carry stale failure context.
 * - If the scenario id is absent, the file is left untouched (no-op).
 */
export function updateScenarioVerdict(
	uatPath: string,
	scenarioId: string,
	verdict: UatVerdict,
	notes?: string,
): void {
	if (!fs.existsSync(uatPath)) return;
	const text = fs.readFileSync(uatPath, "utf-8");
	const { frontmatter, body } = parseFrontmatter(text);
	const raw = frontmatter.uat_scenarios;
	if (!Array.isArray(raw)) return;

	let touched = false;
	const updated: FrontmatterValue[] = raw.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
		const obj = entry as { [key: string]: FrontmatterValue };
		if (obj.id !== scenarioId) return entry;
		touched = true;
		const next: { [key: string]: FrontmatterValue } = { ...obj };
		next.verdict = verdict;
		next.notes = notes ?? "";
		return next;
	});

	if (!touched) return;

	const merged: PlanFrontmatter = { ...frontmatter, uat_scenarios: updated };
	fs.writeFileSync(uatPath, serializeFrontmatter(merged, body), "utf-8");
}

/* ================================ Internals ================================ */

function toStringArray(value: FrontmatterValue | undefined): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

function coerceVerdict(value: FrontmatterValue | undefined): UatVerdict {
	if (typeof value === "string" && VALID_VERDICTS.has(value as UatVerdict)) {
		return value as UatVerdict;
	}
	return "pending";
}
