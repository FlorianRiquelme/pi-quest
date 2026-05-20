/**
 * Typed Quest event union — see ADR 010, extended by ADR 013 (M3-2) and
 * ADR 017 (M4-4).
 *
 * Every event written to `.pi/quests/<id>/telemetry/events.jsonl` matches one of
 * the twelve variants below. The `event` field is the discriminator
 * (snake_case on the wire). Every variant carries `timestamp` (ISO 8601),
 * `questId`, and an optional open `details` slot for forward-compatible extras.
 *
 * ADR 010 originally defined 9 typed kinds and left the `details` slot as the
 * primary forward-compat vector. ADR 013 (Hearth Widget) introduced two
 * additional audit events — `freeze_engaged` and `freeze_released` — that
 * deserve top-level treatment because they carry structural fields (mode,
 * in_flight_runs, triggered_by) consumed by the widget and homecoming brief.
 * ADR 017 (Resume mechanic) adds `run_resumed`, whose `new_run_id`,
 * `continues_from`, and `acknowledgment` are the audit signal for "user
 * acknowledged the paused anomaly and asked the agent to continue".
 *
 * The event log is an audit record — readers consult it for postmortem,
 * anomaly detection, and narrative composition, never for current state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/* ================================ Shared shape ================================ */

const TimestampField = Type.String({
	description: "ISO 8601 timestamp when the event was recorded.",
});

const QuestIdField = Type.String({
	description: "Quest workspace ID (`.pi/quests/<questId>/`).",
});

const DetailsField = Type.Optional(
	Type.Record(Type.String(), Type.Unknown(), {
		description: "Forward-compatible slot for rule- or variant-specific extras.",
	}),
);

/* ================================ Variants ================================ */

const StageEnteredEvent = Type.Object({
	event: Type.Literal("stage_entered"),
	timestamp: TimestampField,
	questId: QuestIdField,
	to: Type.String({ description: "Status the router moved the quest to." }),
	from: Type.Optional(Type.String({ description: "Previous status, if known." })),
	details: DetailsField,
});

const RunStartedEvent = Type.Object({
	event: Type.Literal("run_started"),
	timestamp: TimestampField,
	questId: QuestIdField,
	runId: Type.String(),
	workItemId: Type.String(),
	details: DetailsField,
});

const RunFinishedEvent = Type.Object({
	event: Type.Literal("run_finished"),
	timestamp: TimestampField,
	questId: QuestIdField,
	runId: Type.String(),
	workItemId: Type.String(),
	details: DetailsField,
});

const RunOrphanedEvent = Type.Object({
	event: Type.Literal("run_orphaned"),
	timestamp: TimestampField,
	questId: QuestIdField,
	runId: Type.String(),
	workItemId: Type.String(),
	details: DetailsField,
});

const ProgressBeatEvent = Type.Object({
	event: Type.Literal("progress_beat"),
	timestamp: TimestampField,
	questId: QuestIdField,
	runId: Type.String(),
	phase: Type.String({
		description: 'Phase string (e.g. "alive", "implementing", "verifying").',
	}),
	confidence: Type.Optional(Type.Number()),
	note: Type.Optional(Type.String()),
	details: DetailsField,
});

const ConcessionEvent = Type.Object({
	event: Type.Literal("concession"),
	timestamp: TimestampField,
	questId: QuestIdField,
	runId: Type.String(),
	decision: Type.String(),
	rationale: Type.String(),
	details: DetailsField,
});

const AnomalyDetectedEvent = Type.Object({
	event: Type.Literal("anomaly_detected"),
	timestamp: TimestampField,
	questId: QuestIdField,
	runId: Type.Optional(Type.String({ description: "Quest-scoped anomalies omit runId." })),
	tier: Type.Union([Type.Literal("pause"), Type.Literal("halt"), Type.Literal("log")]),
	rule: Type.String(),
	should_pause: Type.Boolean(),
	details: DetailsField,
});

const LaunchGateEvent = Type.Object({
	event: Type.Literal("launch_gate"),
	timestamp: TimestampField,
	questId: QuestIdField,
	outcome: Type.Union([
		Type.Literal("passed"),
		Type.Literal("blocked"),
		Type.Literal("force_passed"),
	]),
	reasons: Type.Array(Type.String()),
	details: DetailsField,
});

const RescueInvokedEvent = Type.Object({
	event: Type.Literal("rescue_invoked"),
	timestamp: TimestampField,
	questId: QuestIdField,
	workItemId: Type.Optional(Type.String()),
	agentRole: Type.Optional(Type.String()),
	status: Type.Optional(Type.String()),
	details: DetailsField,
});

// ADR 013 §8 — freeze chord audit events. The schema grows beyond ADR 010's
// original 9 by exactly two kinds; ADR 010 did not forbid extension.
const FreezeEngagedEvent = Type.Object({
	event: Type.Literal("freeze_engaged"),
	timestamp: TimestampField,
	questId: QuestIdField,
	mode: Type.Union([Type.Literal("soft"), Type.Literal("hard")]),
	in_flight_runs: Type.Integer({
		minimum: 0,
		description: "Number of runs that were running at the moment of freeze.",
	}),
	triggered_by: Type.Literal("user"),
	details: DetailsField,
});

const FreezeReleasedEvent = Type.Object({
	event: Type.Literal("freeze_released"),
	timestamp: TimestampField,
	questId: QuestIdField,
	triggered_by: Type.Union([Type.Literal("user"), Type.Literal("auto")]),
	details: DetailsField,
});

// ADR 017 §5 — Resume mechanic audit event. Emitted at Resume time, paired with
// a standard `run_started` for the new Run immediately after. `new_run_id` is
// the freshly-spawned Run; `continues_from` references the immediate
// predecessor (the just-paused Run, even in a multi-Resume chain);
// `acknowledgment` is the free-form text the user supplied (or the default
// fallback `"User chose to resume without comment"`).
const RunResumedEvent = Type.Object({
	event: Type.Literal("run_resumed"),
	timestamp: TimestampField,
	questId: QuestIdField,
	new_run_id: Type.String({
		description: "Run ID of the newly-spawned Run that continues the paused work.",
	}),
	continues_from: Type.String({
		description: "Run ID of the immediate predecessor (the just-paused Run).",
	}),
	acknowledgment: Type.String({
		description:
			"User-supplied acknowledgment text. Empty input defaults to 'User chose to resume without comment'.",
	}),
	details: DetailsField,
});

/* ================================ Union ================================ */

export const QuestEventSchema = Type.Union([
	StageEnteredEvent,
	RunStartedEvent,
	RunFinishedEvent,
	RunOrphanedEvent,
	ProgressBeatEvent,
	ConcessionEvent,
	AnomalyDetectedEvent,
	LaunchGateEvent,
	RescueInvokedEvent,
	FreezeEngagedEvent,
	FreezeReleasedEvent,
	RunResumedEvent,
]);

export type QuestEvent = Static<typeof QuestEventSchema>;

/**
 * The event kinds in the Quest typed union, in stable order.
 *
 * The first nine were defined by ADR 010. ADR 013 §8 (Hearth Widget freeze
 * chords) added `freeze_engaged` and `freeze_released`. ADR 017 §5 (Resume
 * mechanic) added `run_resumed`.
 */
export const QUEST_EVENT_KINDS = [
	"stage_entered",
	"run_started",
	"run_finished",
	"run_orphaned",
	"progress_beat",
	"concession",
	"anomaly_detected",
	"launch_gate",
	"rescue_invoked",
	"freeze_engaged",
	"freeze_released",
	"run_resumed",
] as const;

export type QuestEventKind = (typeof QUEST_EVENT_KINDS)[number];

/* ================================ Validator ================================ */

const KIND_SET = new Set<string>(QUEST_EVENT_KINDS);

/**
 * Validate an incoming payload against the Quest event union.
 *
 * Throws on:
 *   - missing or non-string `event`
 *   - `event` not in the kinds enumerated by {@link QUEST_EVENT_KINDS}
 *   - missing `timestamp` or `questId`
 *   - a variant-specific required field absent or wrong-typed
 *
 * Returns the value typed as a {@link QuestEvent} on success. Extra fields
 * inside `details` are preserved unchanged.
 */
export function validateEvent(input: unknown): QuestEvent {
	if (typeof input !== "object" || input === null) {
		throw new TypeError("Quest event must be an object.");
	}
	const event = (input as { event?: unknown }).event;
	if (typeof event !== "string") {
		throw new TypeError("Quest event is missing a string 'event' field.");
	}
	if (!KIND_SET.has(event)) {
		throw new TypeError(
			`Unknown Quest event kind: '${event}'. Expected one of: ${QUEST_EVENT_KINDS.join(", ")}.`,
		);
	}
	if (!Check(QuestEventSchema, input)) {
		throw new TypeError(
			`Quest event '${event}' failed schema validation. Required fields are missing or wrong-typed.`,
		);
	}
	return input as QuestEvent;
}

/**
 * Append a `stage_entered` audit event to the quest's event log. Called from
 * every status-transition site so downstream consumers (Two Clocks in the
 * Hearth Widget, Homecoming Brief title bar, anomaly poller correlation) have
 * stage timing without each call site re-implementing the boilerplate.
 *
 * No-op when `to === from` — guards against transition-less workflow writes.
 */
export function emitStageEntered(
	questDir: string,
	questId: string,
	from: string | undefined,
	to: string,
): void {
	if (from === to) return;
	const telemetryPath = path.join(questDir, "telemetry", "events.jsonl");
	fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
	const event = validateEvent({
		event: "stage_entered",
		timestamp: new Date().toISOString(),
		questId,
		from,
		to,
	});
	fs.appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
}
