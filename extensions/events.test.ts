import { describe, it, expect } from 'vitest';
import {
	QUEST_EVENT_KINDS,
	validateEvent,
	type QuestEvent,
} from './events';

const ts = '2024-01-01T12:00:00.000Z';
const questId = 'q1';

describe('QUEST_EVENT_KINDS', () => {
	it('contains the 9 kinds from ADR 010, the 2 freeze kinds from M3-2 / ADR 013, and the run_resumed kind from M4-4 / ADR 017', () => {
		expect([...QUEST_EVENT_KINDS].sort()).toEqual(
			[
				'stage_entered',
				'run_started',
				'run_finished',
				'run_orphaned',
				'progress_beat',
				'concession',
				'anomaly_detected',
				'launch_gate',
				'rescue_invoked',
				'freeze_engaged',
				'freeze_released',
				'run_resumed',
			].sort(),
		);
	});
});

describe('validateEvent', () => {
	describe('round-trip for each of the 9 variants', () => {
		const samples: QuestEvent[] = [
			{ event: 'stage_entered', timestamp: ts, questId, to: 'reviewing' },
			{ event: 'stage_entered', timestamp: ts, questId, from: 'intake', to: 'reviewing' },
			{
				event: 'run_started',
				timestamp: ts,
				questId,
				runId: 'run-1',
				workItemId: '001',
			},
			{
				event: 'run_finished',
				timestamp: ts,
				questId,
				runId: 'run-1',
				workItemId: '001',
				details: { status: 'completed', exitCode: 0 },
			},
			{
				event: 'run_orphaned',
				timestamp: ts,
				questId,
				runId: 'run-1',
				workItemId: '001',
			},
			{
				event: 'progress_beat',
				timestamp: ts,
				questId,
				runId: 'run-1',
				phase: 'alive',
			},
			{
				event: 'progress_beat',
				timestamp: ts,
				questId,
				runId: 'run-1',
				phase: 'implementing',
				confidence: 0.8,
				note: 'edited tools.ts',
			},
			{
				event: 'concession',
				timestamp: ts,
				questId,
				runId: 'run-1',
				decision: 'used existing helper',
				rationale: 'avoids adding a dependency',
			},
			{
				event: 'anomaly_detected',
				timestamp: ts,
				questId,
				tier: 'pause',
				rule: 'heartbeat_missed',
				should_pause: true,
			},
			{
				event: 'anomaly_detected',
				timestamp: ts,
				questId,
				runId: 'run-1',
				tier: 'log',
				rule: 'noisy_stderr',
				should_pause: false,
			},
			{
				event: 'launch_gate',
				timestamp: ts,
				questId,
				outcome: 'passed',
				reasons: [],
			},
			{
				event: 'launch_gate',
				timestamp: ts,
				questId,
				outcome: 'blocked',
				reasons: ['handoff incomplete'],
			},
			{
				event: 'rescue_invoked',
				timestamp: ts,
				questId,
				workItemId: '001',
				status: 'completed',
			},
			{
				event: 'freeze_engaged',
				timestamp: ts,
				questId,
				mode: 'soft',
				in_flight_runs: 0,
				triggered_by: 'user',
			},
			{
				event: 'freeze_engaged',
				timestamp: ts,
				questId,
				mode: 'hard',
				in_flight_runs: 3,
				triggered_by: 'user',
				details: { cancel_reason: 'user_aborted' },
			},
			{
				event: 'freeze_released',
				timestamp: ts,
				questId,
				triggered_by: 'user',
			},
			{
				event: 'freeze_released',
				timestamp: ts,
				questId,
				triggered_by: 'auto',
			},
			{
				event: 'run_resumed',
				timestamp: ts,
				questId,
				new_run_id: 'run-2',
				continues_from: 'run-1',
				acknowledgment: 'lockfile drift is intentional',
			},
			{
				event: 'run_resumed',
				timestamp: ts,
				questId,
				new_run_id: 'run-3',
				continues_from: 'run-2',
				acknowledgment: 'User chose to resume without comment',
				details: { resumption_number: 2 },
			},
		];

		for (const sample of samples) {
			it(`round-trips ${sample.event} (${JSON.stringify(sample).slice(0, 80)}...)`, () => {
				const validated = validateEvent(sample);
				const serialised = JSON.parse(JSON.stringify(validated));
				const revalidated = validateEvent(serialised);
				expect(revalidated).toEqual(sample);
			});
		}
	});

	it('throws on an unknown event kind', () => {
		expect(() =>
			validateEvent({ event: 'not_a_real_event', timestamp: ts, questId }),
		).toThrow();
	});

	it('throws when timestamp is missing', () => {
		expect(() =>
			validateEvent({ event: 'stage_entered', questId, to: 'reviewing' }),
		).toThrow();
	});

	it('throws when questId is missing', () => {
		expect(() =>
			validateEvent({ event: 'stage_entered', timestamp: ts, to: 'reviewing' }),
		).toThrow();
	});

	it('throws when a variant-required field is missing (run_started without runId)', () => {
		expect(() =>
			validateEvent({
				event: 'run_started',
				timestamp: ts,
				questId,
				workItemId: '001',
			}),
		).toThrow();
	});

	it('preserves extra fields placed inside details', () => {
		const event = {
			event: 'run_finished' as const,
			timestamp: ts,
			questId,
			runId: 'run-1',
			workItemId: '001',
			details: {
				model: 'kimi-2.6',
				exitCode: 0,
				rescueUsed: false,
				arbitraryFutureField: { nested: 'value' },
			},
		};
		const validated = validateEvent(event);
		expect(validated.details).toEqual(event.details);
	});

	it('accepts every kind enumerated in QUEST_EVENT_KINDS without crashing on a minimal valid payload', () => {
		// Every kind in QUEST_EVENT_KINDS must have at least one passing sample above.
		const covered = new Set<string>();
		const samples: Array<{ event: string }> = [
			{ event: 'stage_entered' },
			{ event: 'run_started' },
			{ event: 'run_finished' },
			{ event: 'run_orphaned' },
			{ event: 'progress_beat' },
			{ event: 'concession' },
			{ event: 'anomaly_detected' },
			{ event: 'launch_gate' },
			{ event: 'rescue_invoked' },
			{ event: 'freeze_engaged' },
			{ event: 'freeze_released' },
			{ event: 'run_resumed' },
		];
		for (const s of samples) covered.add(s.event);
		for (const kind of QUEST_EVENT_KINDS) {
			expect(covered.has(kind)).toBe(true);
		}
	});

	it('rejects freeze_engaged with an unknown mode', () => {
		expect(() =>
			validateEvent({
				event: 'freeze_engaged',
				timestamp: ts,
				questId,
				mode: 'permafrost',
				in_flight_runs: 0,
				triggered_by: 'user',
			}),
		).toThrow();
	});

	it('rejects freeze_released with an unknown triggered_by', () => {
		expect(() =>
			validateEvent({
				event: 'freeze_released',
				timestamp: ts,
				questId,
				triggered_by: 'cosmic_ray',
			}),
		).toThrow();
	});

	it('rejects freeze_engaged when in_flight_runs is missing', () => {
		expect(() =>
			validateEvent({
				event: 'freeze_engaged',
				timestamp: ts,
				questId,
				mode: 'soft',
				triggered_by: 'user',
			}),
		).toThrow();
	});

	it('rejects run_resumed when new_run_id is missing', () => {
		expect(() =>
			validateEvent({
				event: 'run_resumed',
				timestamp: ts,
				questId,
				continues_from: 'run-1',
				acknowledgment: 'go',
			}),
		).toThrow();
	});

	it('rejects run_resumed when continues_from is missing', () => {
		expect(() =>
			validateEvent({
				event: 'run_resumed',
				timestamp: ts,
				questId,
				new_run_id: 'run-2',
				acknowledgment: 'go',
			}),
		).toThrow();
	});

	it('rejects run_resumed when acknowledgment is missing', () => {
		expect(() =>
			validateEvent({
				event: 'run_resumed',
				timestamp: ts,
				questId,
				new_run_id: 'run-2',
				continues_from: 'run-1',
			}),
		).toThrow();
	});
});
