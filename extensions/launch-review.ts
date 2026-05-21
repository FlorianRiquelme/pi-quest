/**
 * Launch Review (ADR 012) — sign-off helpers and Launch Gate validator.
 *
 * The Launch Review is the interactive `launch-review` stage between `planned`
 * and `executing`. The skill (`skills/launch-review/SKILL.md`) walks the user
 * through the Trust Trinity (Compiler diagnostics, Blast Radius, Pre-Mortem)
 * and records sign-off via `recordLaunchReviewSignOff` below.
 *
 * The Launch Gate is the automated check at `launch-review → executing`.
 * `evaluateLaunchGate` returns the outcome and reasons; callers emit the
 * `launch_gate` event and persist (or refuse) the status transition.
 *
 * For M2-1 we only need a minimal YAML reader/writer: read the frontmatter
 * block at the head of `IMPLEMENTATION_PLAN.md`, merge in a partial update,
 * write it back. The shape evolves in M2-2.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadCurrentState, loadQuestWorkflow } from "./state.js";
import { questDirPath } from "./paths.js";

/* ================================ Active quest discovery ================================ */

/**
 * Resolve the IMPLEMENTATION_PLAN.md path for the currently active quest.
 *
 * Reads `state.json` (under the project's `.pi/`) and uses `currentQuestId` to
 * locate the quest workspace. If the workflow declares a custom `artifacts.plan`
 * filename it is honoured; otherwise the default `IMPLEMENTATION_PLAN.md` is
 * used.
 *
 * Throws an `Error` whose message starts with `No active quest` when no quest
 * is active (state file missing, empty, or `currentQuestId` null/undefined).
 * The Launch Review skill catches this and exits with a clear message — it
 * must never prompt the user for a quest ID (issue #2 / ADR 015).
 */
export function resolveActiveQuestPlanPath(cwd: string): string {
	const state = loadCurrentState(cwd);
	const questId = state.currentQuestId;
	if (!questId) {
		throw new Error(
			"No active quest. Run `/quest select <id>` or `/quest intake <handoff.md>` first.",
		);
	}
	const questDir = questDirPath(cwd, questId);
	const workflow = loadQuestWorkflow(questDir);
	const planFilename = workflow?.artifacts?.plan ?? "IMPLEMENTATION_PLAN.md";
	return path.join(questDir, planFilename);
}

/* ================================ Frontmatter ================================ */

export type FrontmatterValue =
	| null
	| string
	| number
	| boolean
	| FrontmatterValue[]
	| { [key: string]: FrontmatterValue };

export type PlanFrontmatter = { [key: string]: FrontmatterValue };

const FRONTMATTER_FENCE = "---";

/**
 * Split a document into its YAML frontmatter block and the rest of the body.
 * If no frontmatter is present, frontmatter is `{}` and body is the original.
 */
export function parseFrontmatter(input: string): {
	frontmatter: PlanFrontmatter;
	body: string;
} {
	if (!input.startsWith(FRONTMATTER_FENCE + "\n") && !input.startsWith(FRONTMATTER_FENCE + "\r\n")) {
		return { frontmatter: {}, body: input };
	}
	// Find the closing fence.
	const rest = input.slice(FRONTMATTER_FENCE.length + 1);
	const closeIdx = rest.indexOf("\n" + FRONTMATTER_FENCE);
	if (closeIdx < 0) {
		return { frontmatter: {}, body: input };
	}
	const yamlBlock = rest.slice(0, closeIdx);
	let after = rest.slice(closeIdx + 1 + FRONTMATTER_FENCE.length);
	// Strip a single trailing newline after the close fence.
	if (after.startsWith("\n")) after = after.slice(1);
	else if (after.startsWith("\r\n")) after = after.slice(2);
	return { frontmatter: parseYaml(yamlBlock), body: after };
}

/**
 * Serialize frontmatter + body back into a single document.
 */
export function serializeFrontmatter(fm: PlanFrontmatter, body: string): string {
	const yaml = serializeYaml(fm, 0);
	return `${FRONTMATTER_FENCE}\n${yaml}${FRONTMATTER_FENCE}\n\n${body}`;
}

/**
 * Read the YAML frontmatter from an IMPLEMENTATION_PLAN.md (or any markdown).
 * Missing file or no frontmatter returns `{}`.
 */
export function readPlanFrontmatter(planPath: string): PlanFrontmatter {
	if (!fs.existsSync(planPath)) return {};
	const text = fs.readFileSync(planPath, "utf-8");
	return parseFrontmatter(text).frontmatter;
}

/**
 * Merge an update into the plan's frontmatter and write it back.
 *
 * Top-level keys in `update` replace the corresponding keys in the existing
 * frontmatter (shallow merge — sufficient for M2-1's recording needs). The
 * markdown body below the frontmatter is preserved unchanged. If the plan
 * file does not exist it is created with empty body.
 */
export function writePlanFrontmatter(planPath: string, update: PlanFrontmatter): void {
	let frontmatter: PlanFrontmatter = {};
	let body = "";
	if (fs.existsSync(planPath)) {
		const parsed = parseFrontmatter(fs.readFileSync(planPath, "utf-8"));
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	}
	const merged: PlanFrontmatter = { ...frontmatter };
	for (const [key, value] of Object.entries(update)) merged[key] = value;
	const out = serializeFrontmatter(merged, body);
	const dir = path.dirname(planPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(planPath, out, "utf-8");
}

/**
 * Record the user's Launch Review sign-off into the plan frontmatter.
 *
 * Writes:
 *   launch_review:
 *     signed_off_at: <iso8601>
 *     signed_off_by: user
 *
 * Returns the timestamp written so callers can log / display it.
 */
export function recordLaunchReviewSignOff(planPath: string): string {
	const signedOffAt = new Date().toISOString();
	writePlanFrontmatter(planPath, {
		launch_review: {
			signed_off_at: signedOffAt,
			signed_off_by: "user",
		},
	});
	return signedOffAt;
}

/* ================================ Pre-Mortem edits ================================ */

export type PreMortemField = "most_likely_failure" | "detection_signal" | "recovery_plan";

export interface PreMortemEditInput {
	field: PreMortemField;
	after: string;
	/** Defaults to "user". */
	who?: string;
}

/**
 * Record an inline edit to one of the three Pre-Mortem fields.
 *
 * - Updates `pre_mortem.<field>` to the new text.
 * - Appends `{ at, who, field, before, after }` to `pre_mortem_edits` (array).
 *
 * The `before` value is read from the existing frontmatter; an empty string is
 * recorded if the field was absent. Returns the ISO timestamp written so the
 * caller can echo it back to the user.
 */
export function recordPreMortemEdit(planPath: string, edit: PreMortemEditInput): string {
	const at = new Date().toISOString();
	const fm = readPlanFrontmatter(planPath);

	const preMortemRaw = fm.pre_mortem;
	const pm: { [key: string]: FrontmatterValue } =
		preMortemRaw && typeof preMortemRaw === "object" && !Array.isArray(preMortemRaw)
			? { ...(preMortemRaw as { [key: string]: FrontmatterValue }) }
			: {};
	const before = typeof pm[edit.field] === "string" ? (pm[edit.field] as string) : "";
	pm[edit.field] = edit.after;

	const editsRaw = fm.pre_mortem_edits;
	const edits: FrontmatterValue[] = Array.isArray(editsRaw) ? [...editsRaw] : [];
	edits.push({
		at,
		who: edit.who ?? "user",
		field: edit.field,
		before,
		after: edit.after,
	});

	writePlanFrontmatter(planPath, {
		pre_mortem: pm,
		pre_mortem_edits: edits,
	});
	return at;
}

/* ================================ Acknowledged warnings ================================ */

export interface AcknowledgedWarningInput {
	rule: string;
	work_item?: string;
}

/**
 * Record that the user acknowledged a compiler warning during Launch Review.
 *
 * Writes the acknowledgement to `launch_review.acknowledged_warnings` (array)
 * while preserving any other existing keys under `launch_review`. The Launch
 * Gate does not consult this list — warnings already pass — but the record is
 * required by the audit trail (ADR 012 / M2-2 acceptance #10).
 */
export function recordAcknowledgedWarning(
	planPath: string,
	ack: AcknowledgedWarningInput,
): string {
	const acknowledgedAt = new Date().toISOString();
	const fm = readPlanFrontmatter(planPath);

	const lrRaw = fm.launch_review;
	const lr: { [key: string]: FrontmatterValue } =
		lrRaw && typeof lrRaw === "object" && !Array.isArray(lrRaw)
			? { ...(lrRaw as { [key: string]: FrontmatterValue }) }
			: {};

	const prevRaw = lr.acknowledged_warnings;
	const acks: FrontmatterValue[] = Array.isArray(prevRaw) ? [...prevRaw] : [];
	const entry: { [key: string]: FrontmatterValue } = {
		rule: ack.rule,
		acknowledged_at: acknowledgedAt,
	};
	if (ack.work_item !== undefined) entry.work_item = ack.work_item;
	acks.push(entry);
	lr.acknowledged_warnings = acks;

	writePlanFrontmatter(planPath, { launch_review: lr });
	return acknowledgedAt;
}

/* ================================ Launch Gate ================================ */

export type LaunchGateOutcome = "passed" | "blocked" | "force_passed";

export interface LaunchGateResult {
	outcome: LaunchGateOutcome;
	reasons: string[];
}

interface CompilerDiagnostic {
	severity?: unknown;
	rule?: unknown;
}

/**
 * Evaluate the Launch Gate against the plan's frontmatter.
 *
 * Passes when ALL of:
 *   - `blast_radius` exists (any non-empty value)
 *   - `pre_mortem` exists (any non-empty value)
 *   - `compiler_diagnostics` (if present) has zero `severity: error` entries
 *   - `launch_review.signed_off_at` exists
 *
 * Each failing condition adds a stable reason string to `reasons[]`.
 */
export function evaluateLaunchGate(fm: PlanFrontmatter): LaunchGateResult {
	const reasons: string[] = [];
	if (!hasMeaningfulValue(fm.blast_radius)) reasons.push("missing_blast_radius");
	if (!hasMeaningfulValue(fm.pre_mortem)) reasons.push("missing_pre_mortem");

	const diagnostics = fm.compiler_diagnostics;
	if (Array.isArray(diagnostics)) {
		for (const diag of diagnostics as CompilerDiagnostic[]) {
			if (diag && typeof diag === "object" && diag.severity === "error") {
				const rule = typeof diag.rule === "string" ? diag.rule : "unknown";
				reasons.push(`compiler_error: ${rule}`);
			}
		}
	}

	const lr = fm.launch_review;
	if (
		!lr ||
		typeof lr !== "object" ||
		Array.isArray(lr) ||
		typeof (lr as Record<string, unknown>).signed_off_at !== "string" ||
		((lr as Record<string, unknown>).signed_off_at as string).length === 0
	) {
		reasons.push("missing_sign_off");
	}

	return {
		outcome: reasons.length === 0 ? "passed" : "blocked",
		reasons,
	};
}

function hasMeaningfulValue(v: FrontmatterValue | undefined): boolean {
	if (v === undefined || v === null) return false;
	if (typeof v === "string") return v.length > 0;
	if (Array.isArray(v)) return v.length > 0;
	if (typeof v === "object") return Object.keys(v).length > 0;
	return true;
}

/* ================================ Tiny YAML ================================ */
/*
 * Minimal YAML parser/serializer covering only the shapes we read and write
 * for `IMPLEMENTATION_PLAN.md` frontmatter:
 *   - mappings (nested by 2-space indent)
 *   - block sequences (`- value`)
 *   - inline empty lists `[]`
 *   - scalars: strings (quoted or bare), numbers, booleans, null
 *
 * Anything more exotic should never appear in plan frontmatter at this
 * milestone; M2-2 may swap this for a real YAML lib if/when shapes grow.
 */

function parseYaml(input: string): PlanFrontmatter {
	const lines = input.split(/\r?\n/);
	// Strip trailing empty lines.
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	const { value } = parseYamlBlock(lines, 0, 0);
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as PlanFrontmatter;
	}
	return {};
}

interface ParseResult {
	value: FrontmatterValue;
	nextIdx: number;
}

function parseYamlBlock(lines: string[], startIdx: number, indent: number): ParseResult {
	let idx = startIdx;
	let kind: "map" | "seq" | undefined;
	const map: { [key: string]: FrontmatterValue } = {};
	const seq: FrontmatterValue[] = [];

	while (idx < lines.length) {
		const raw = lines[idx];
		if (raw.trim() === "") {
			idx++;
			continue;
		}
		const currentIndent = leadingSpaces(raw);
		if (currentIndent < indent) break;
		if (currentIndent > indent) {
			// Outer caller's responsibility; bail to avoid infinite loops.
			break;
		}
		const stripped = raw.slice(indent);
		if (stripped.startsWith("- ") || stripped === "-") {
			kind ??= "seq";
			if (kind !== "seq") break;
			const after = stripped.slice(1).trimStart();
			if (after === "") {
				// Nested block under the dash.
				const child = parseYamlBlock(lines, idx + 1, indent + 2);
				seq.push(child.value);
				idx = child.nextIdx;
			} else if (
				after.includes(":") &&
				!after.startsWith('"') &&
				!after.startsWith("'") &&
				!after.startsWith("[")
			) {
				// `- key: value` opens a mapping in this list item. Subsequent lines
				// at indent+2 belong to the same mapping. Parse this item by
				// recursing on a virtual lines view that prepends the inline pair.
				const colonAfter = after.indexOf(":");
				const k = after.slice(0, colonAfter).trim();
				const v = after.slice(colonAfter + 1).trim();
				const itemMap: { [key: string]: FrontmatterValue } = {};
				if (v === "") {
					const nested = parseYamlBlock(lines, idx + 1, indent + 4);
					itemMap[k] = nested.value;
					idx = nested.nextIdx;
				} else if (v === "[]") {
					itemMap[k] = [];
					idx++;
				} else if (v === "{}") {
					itemMap[k] = {};
					idx++;
				} else {
					itemMap[k] = parseScalar(v);
					idx++;
				}
				// Continuation lines at indent+2 are extra keys of the same item.
				const continuation = parseYamlBlock(lines, idx, indent + 2);
				if (
					continuation.value &&
					typeof continuation.value === "object" &&
					!Array.isArray(continuation.value)
				) {
					for (const [ck, cv] of Object.entries(continuation.value)) {
						itemMap[ck] = cv;
					}
					idx = continuation.nextIdx;
				}
				seq.push(itemMap);
			} else {
				seq.push(parseScalar(after));
				idx++;
			}
			continue;
		}
		const colonIdx = stripped.indexOf(":");
		if (colonIdx < 0) break;
		kind ??= "map";
		if (kind !== "map") break;
		const key = stripped.slice(0, colonIdx).trim();
		const after = stripped.slice(colonIdx + 1).trim();
		if (after === "") {
			// Nested block.
			const child = parseYamlBlock(lines, idx + 1, indent + 2);
			map[key] = child.value;
			idx = child.nextIdx;
		} else if (after === "[]") {
			map[key] = [];
			idx++;
		} else if (after === "{}") {
			map[key] = {};
			idx++;
		} else {
			map[key] = parseScalar(after);
			idx++;
		}
	}

	const value: FrontmatterValue = kind === "seq" ? seq : map;
	return { value, nextIdx: idx };
}

function leadingSpaces(s: string): number {
	let i = 0;
	while (i < s.length && s[i] === " ") i++;
	return i;
}

function parseScalar(raw: string): FrontmatterValue {
	const s = raw.trim();
	if (s === "" || s === "~" || s.toLowerCase() === "null") return null;
	if (s === "true") return true;
	if (s === "false") return false;
	if (/^-?\d+$/.test(s)) return Number(s);
	if (/^-?\d+\.\d+$/.test(s)) return Number(s);
	if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
		return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
		return s.slice(1, -1).replace(/''/g, "'");
	}
	return s;
}

function serializeYaml(value: FrontmatterValue, indent: number): string {
	const pad = " ".repeat(indent);
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		// Top-level scalar shouldn't happen for frontmatter; fall through.
		return `${pad}${serializeScalar(value)}\n`;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return `${pad}[]\n`;
		let out = "";
		for (const item of value) {
			if (isScalar(item)) {
				out += `${pad}- ${serializeScalar(item as string | number | boolean | null)}\n`;
			} else {
				// Object or array under a list item.
				const child = serializeYaml(item, indent + 2);
				// The child includes its own indent on subsequent lines; we need the
				// `- ` prefix on the first non-empty line.
				const childLines = child.split("\n");
				let first = true;
				for (let i = 0; i < childLines.length; i++) {
					const line = childLines[i];
					if (line === "") continue;
					if (first) {
						out += `${pad}- ${line.trim()}\n`;
						first = false;
					} else {
						out += line + "\n";
					}
				}
			}
		}
		return out;
	}
	// Object/mapping.
	const entries = Object.entries(value);
	if (entries.length === 0) return `${pad}{}\n`;
	let out = "";
	for (const [k, v] of entries) {
		if (v === null) {
			out += `${pad}${k}: null\n`;
			continue;
		}
		if (isScalar(v)) {
			out += `${pad}${k}: ${serializeScalar(v as string | number | boolean)}\n`;
			continue;
		}
		if (Array.isArray(v) && v.length === 0) {
			out += `${pad}${k}: []\n`;
			continue;
		}
		if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
			out += `${pad}${k}: {}\n`;
			continue;
		}
		out += `${pad}${k}:\n`;
		out += serializeYaml(v, indent + 2);
	}
	return out;
}

function isScalar(v: unknown): boolean {
	return (
		v === null ||
		typeof v === "string" ||
		typeof v === "number" ||
		typeof v === "boolean"
	);
}

function serializeScalar(v: string | number | boolean | null): string {
	if (v === null) return "null";
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "number") return String(v);
	// String. Quote if it contains characters that need quoting.
	if (v === "") return '""';
	if (/^[A-Za-z_][A-Za-z0-9_\-./:+]*$/.test(v) && !["null", "true", "false"].includes(v)) {
		return v;
	}
	return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
