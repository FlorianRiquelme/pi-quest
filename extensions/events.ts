/**
 * Typed Quest event union — see ADR 010.
 *
 * Every event written to `.pi/quests/<id>/telemetry/events.jsonl` matches one of
 * the nine variants below. The `event` field is the discriminator (snake_case
 * on the wire). Every variant carries `timestamp` (ISO 8601), `questId`, and an
 * optional open `details` slot for forward-compatible extras.
 *
 * The event log is an audit record — readers consult it for postmortem,
 * anomaly detection, and narrative composition, never for current state.
 */

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
]);

export type QuestEvent = Static<typeof QuestEventSchema>;

/** The nine event kinds defined by ADR 010, in stable order. */
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
] as const;

export type QuestEventKind = (typeof QUEST_EVENT_KINDS)[number];

/* ================================ Validator ================================ */

const KIND_SET = new Set<string>(QUEST_EVENT_KINDS);

/**
 * Validate an incoming payload against the Quest event union.
 *
 * Throws on:
 *   - missing or non-string `event`
 *   - `event` not in the nine kinds enumerated above
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
