/**
 * Handoff Compiler (ADR 012, M2-2).
 *
 * Cross-references `RESOLVED_HANDOFF.md` against `IMPLEMENTATION_PLAN.md` (and
 * optionally `UAT.md`) and produces a list of {@link CompilerDiagnostic}s.
 * The Launch Review skill calls this library, displays the diagnostics, and
 * writes them to plan frontmatter via {@link writeDiagnosticsToPlanFrontmatter}.
 *
 * The Launch Gate then reads `compiler_diagnostics:` from the plan and blocks
 * if any `severity: error` entries are present.
 *
 * Seven starter rules (ADR 012):
 *   - unaddressed_requirement   (error)   handoff `[Rn]` not addressed by any work-item
 *   - unknown_dependency        (error)   depends_on references an unknown work-item ID
 *   - cyclic_dependencies       (error)   depends_on graph has a cycle
 *   - missing_acceptance_criteria (error) work-item lacks acceptance
 *   - missing_verification      (warning) work-item lacks verification
 *   - empty_claims              (warning) work-item has no claims
 *   - untraced_uat_scenario     (warning) UAT scenario traces_to unknown work-item
 *
 * Also exports `checkLockedOutWrites`, the pure function backing the
 * `locked_out_write` log-only anomaly (ADR 010 / 012). Wiring into the post-run
 * supervisor lives elsewhere (or arrives with M1-3 worktree work).
 */

import { parseFrontmatter, writePlanFrontmatter, type FrontmatterValue } from "./launch-review.js";

/* ================================ Types ================================ */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface CompilerDiagnostic {
	severity: DiagnosticSeverity;
	rule: string;
	message: string;
	/** Optional work-item ID when the diagnostic is scoped to one item. */
	work_item?: string;
}

export interface CompileHandoffInput {
	planMarkdown: string;
	resolvedHandoffMarkdown: string;
	/** Optional UAT markdown for the `untraced_uat_scenario` rule. */
	uatMarkdown?: string;
}

/** Internal: shape we extract from a plan work-item entry. */
interface PlanWorkItem {
	id: string;
	acceptance?: FrontmatterValue;
	verification?: FrontmatterValue;
	claims?: FrontmatterValue;
	depends_on?: FrontmatterValue;
	addresses?: FrontmatterValue;
}

/* ================================ Public API ================================ */

/**
 * Run the Handoff Compiler over a plan + resolved-handoff pair.
 *
 * Returns diagnostics in a stable order — rule by rule, work-item by work-item.
 * Empty array means no findings; the Launch Gate then has nothing to block on.
 */
export function compileHandoff(input: CompileHandoffInput): CompilerDiagnostic[] {
	const { planMarkdown, resolvedHandoffMarkdown, uatMarkdown } = input;
	const diagnostics: CompilerDiagnostic[] = [];

	const { frontmatter } = parseFrontmatter(planMarkdown);
	const workItems = extractWorkItems(frontmatter.work_items);
	const knownIds = new Set(workItems.map((wi) => wi.id));
	const requirements = parseAcceptanceCriteria(resolvedHandoffMarkdown);
	const addressedRequirements = collectAddressedRequirements(workItems);

	// Rule: unaddressed_requirement
	for (const req of requirements) {
		if (!addressedRequirements.has(req.label)) {
			diagnostics.push({
				severity: "error",
				rule: "unaddressed_requirement",
				message: `Requirement ${req.label} ("${req.text}") is not addressed by any work-item.`,
			});
		}
	}

	// Per-work-item rules.
	for (const wi of workItems) {
		// Rule: missing_acceptance_criteria
		if (!hasValue(wi.acceptance)) {
			diagnostics.push({
				severity: "error",
				rule: "missing_acceptance_criteria",
				message: `Work item ${wi.id} has no acceptance criteria.`,
				work_item: wi.id,
			});
		}

		// Rule: missing_verification
		if (!hasValue(wi.verification)) {
			diagnostics.push({
				severity: "warning",
				rule: "missing_verification",
				message: `Work item ${wi.id} has no verification command/path.`,
				work_item: wi.id,
			});
		}

		// Rule: empty_claims
		const claims = toStringArray(wi.claims);
		if (claims.length === 0) {
			diagnostics.push({
				severity: "warning",
				rule: "empty_claims",
				message: `Work item ${wi.id} has no claims (no files declared as in-scope).`,
				work_item: wi.id,
			});
		}

		// Rule: unknown_dependency
		const dependsOn = toStringArray(wi.depends_on);
		for (const dep of dependsOn) {
			if (!knownIds.has(dep)) {
				diagnostics.push({
					severity: "error",
					rule: "unknown_dependency",
					message: `Work item ${wi.id} depends on unknown work-item '${dep}'.`,
					work_item: wi.id,
				});
			}
		}
	}

	// Rule: cyclic_dependencies
	const cycle = findCycle(workItems);
	if (cycle) {
		diagnostics.push({
			severity: "error",
			rule: "cyclic_dependencies",
			message: `Cyclic dependency detected: ${cycle.join(" → ")} → ${cycle[0]}.`,
		});
	}

	// Rule: untraced_uat_scenario
	if (uatMarkdown) {
		const scenarios = parseUatScenarios(uatMarkdown);
		for (const sc of scenarios) {
			if (!knownIds.has(sc.tracesTo)) {
				diagnostics.push({
					severity: "warning",
					rule: "untraced_uat_scenario",
					message: `UAT scenario "${sc.name}" traces_to unknown work-item '${sc.tracesTo}'.`,
				});
			}
		}
	}

	return diagnostics;
}

/**
 * Write the diagnostics array into the plan's frontmatter as `compiler_diagnostics:`.
 * Replaces any previous value. Other frontmatter keys are preserved.
 */
export function writeDiagnosticsToPlanFrontmatter(
	planPath: string,
	diagnostics: CompilerDiagnostic[],
): void {
	// Serialize diagnostics as plain frontmatter values (drop undefined keys).
	const serialised: FrontmatterValue = diagnostics.map((d) => {
		const entry: { [key: string]: FrontmatterValue } = {
			severity: d.severity,
			rule: d.rule,
			message: d.message,
		};
		if (d.work_item !== undefined) entry.work_item = d.work_item;
		return entry;
	});
	writePlanFrontmatter(planPath, { compiler_diagnostics: serialised });
}

/* ================================ locked_out_write check ================================ */

/*
 * WIRING GAP (M2-2): `checkLockedOutWrites` is the pure function. The
 * supervisor-side observation point (per-run touched-files diff) belongs in
 * `extensions/agents.ts` next to `recordRunFinished`, but that file is owned by
 * M1-3 (worktree-per-run). When M1-3 lands, call this from `finalize` with the
 * worktree's `git diff --name-only` against the base ref, the run's quest plan
 * frontmatter (`blast_radius.locked_out`), and `validateEvent` + appending to
 * `telemetry/events.jsonl`. Until then this is unit-tested but unwired.
 */

/**
 * Anomaly payload shape returned by {@link checkLockedOutWrites}. Matches the
 * `anomaly_detected` event variant in ADR 010 (`event`, `tier`, `rule`,
 * `should_pause`, `details`). The caller is responsible for the timestamp and
 * for appending the validated event to telemetry/events.jsonl.
 */
export interface LockedOutWriteAnomaly {
	event: "anomaly_detected";
	questId: string;
	runId?: string;
	tier: "log";
	rule: "locked_out_write";
	should_pause: false;
	details: {
		path: string;
		lockedOutPattern: string;
	};
}

export interface CheckLockedOutWritesInput {
	questId: string;
	runId?: string;
	lockedOutPatterns: string[];
	touchedFiles: string[];
}

/**
 * Pure function: emit one log-only anomaly per (path, pattern) match.
 *
 * Patterns are matched with a minimal glob:
 *   - `**`  matches any sub-path (including empty)
 *   - `*`   matches anything within a path segment (no `/`)
 *   - other characters match literally
 *
 * This is intentionally small: plan frontmatter is the source of truth, and
 * the patterns the planner writes there are explicit project paths.
 */
export function checkLockedOutWrites(
	input: CheckLockedOutWritesInput,
): LockedOutWriteAnomaly[] {
	const { questId, runId, lockedOutPatterns, touchedFiles } = input;
	const out: LockedOutWriteAnomaly[] = [];
	for (const pattern of lockedOutPatterns) {
		const re = compileGlob(pattern);
		for (const path of touchedFiles) {
			if (re.test(path)) {
				const anomaly: LockedOutWriteAnomaly = {
					event: "anomaly_detected",
					questId,
					tier: "log",
					rule: "locked_out_write",
					should_pause: false,
					details: { path, lockedOutPattern: pattern },
				};
				if (runId !== undefined) anomaly.runId = runId;
				out.push(anomaly);
			}
		}
	}
	return out;
}

/* ================================ Internals ================================ */

interface Requirement {
	label: string;
	text: string;
}

const REQUIREMENT_BULLET = /^\s*-\s*\[\s*(R\d+)\s*\]\s*(.+)$/;

function parseAcceptanceCriteria(handoffMarkdown: string): Requirement[] {
	const lines = handoffMarkdown.split(/\r?\n/);
	const requirements: Requirement[] = [];
	let inSection = false;
	for (const line of lines) {
		// Match a level-1+ heading containing "Acceptance Criteria".
		const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			inSection = /acceptance\s+criteria/i.test(headingMatch[2]);
			continue;
		}
		if (!inSection) continue;
		const m = line.match(REQUIREMENT_BULLET);
		if (m) {
			requirements.push({ label: m[1], text: m[2].trim() });
		}
	}
	return requirements;
}

function collectAddressedRequirements(workItems: PlanWorkItem[]): Set<string> {
	const labels = new Set<string>();
	for (const wi of workItems) {
		for (const a of toStringArray(wi.addresses)) {
			labels.add(a);
		}
	}
	return labels;
}

function extractWorkItems(value: FrontmatterValue | undefined): PlanWorkItem[] {
	if (!Array.isArray(value)) return [];
	const out: PlanWorkItem[] = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const obj = entry as { [key: string]: FrontmatterValue };
		const id = obj.id;
		if (typeof id !== "string" || id.length === 0) continue;
		out.push({
			id,
			acceptance: obj.acceptance,
			verification: obj.verification,
			claims: obj.claims,
			depends_on: obj.depends_on,
			addresses: obj.addresses,
		});
	}
	return out;
}

function toStringArray(value: FrontmatterValue | undefined): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

function hasValue(value: FrontmatterValue | undefined): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return value.length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}

/**
 * Find one cycle in the depends_on graph. Returns the cycle as an array of
 * work-item IDs (one node per visit; the cycle closes back to the first).
 * Returns null if no cycle exists.
 */
function findCycle(workItems: PlanWorkItem[]): string[] | null {
	const graph = new Map<string, string[]>();
	for (const wi of workItems) graph.set(wi.id, toStringArray(wi.depends_on));

	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const colour = new Map<string, number>();
	for (const id of graph.keys()) colour.set(id, WHITE);

	const stack: string[] = [];
	function visit(node: string): string[] | null {
		colour.set(node, GRAY);
		stack.push(node);
		const deps = graph.get(node) ?? [];
		for (const dep of deps) {
			if (!graph.has(dep)) continue; // unknown_dependency handled separately
			const c = colour.get(dep) ?? WHITE;
			if (c === GRAY) {
				// Cycle: slice the stack from `dep` onwards.
				const idx = stack.indexOf(dep);
				return stack.slice(idx).concat();
			}
			if (c === WHITE) {
				const cyc = visit(dep);
				if (cyc) return cyc;
			}
		}
		stack.pop();
		colour.set(node, BLACK);
		return null;
	}

	for (const id of graph.keys()) {
		if ((colour.get(id) ?? WHITE) === WHITE) {
			const cyc = visit(id);
			if (cyc) return cyc;
		}
	}
	return null;
}

interface UatScenario {
	name: string;
	tracesTo: string;
}

function parseUatScenarios(uatMarkdown: string): UatScenario[] {
	const lines = uatMarkdown.split(/\r?\n/);
	const scenarios: UatScenario[] = [];
	let currentName: string | null = null;
	for (const line of lines) {
		const headingMatch = line.match(/^##\s+Scenario:\s*(.+)$/i);
		if (headingMatch) {
			currentName = headingMatch[1].trim();
			continue;
		}
		const tracesMatch = line.match(/^\s*traces_to\s*:\s*(\S+)\s*$/);
		if (tracesMatch && currentName) {
			scenarios.push({ name: currentName, tracesTo: tracesMatch[1] });
			currentName = null;
		}
	}
	return scenarios;
}

/**
 * Compile a minimal glob into a regex.
 *   `**` → `.*`
 *   `*`  → `[^/]*`
 *   everything else is regex-escaped literally.
 */
function compileGlob(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
		} else if (c === "*") {
			re += "[^/]*";
		} else if (/[.+?^${}()|[\]\\]/.test(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	return new RegExp("^" + re + "$");
}
