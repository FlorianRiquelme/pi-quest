/**
 * Tests for the STATUS_RANK precedence lattice (issue #15, ADR 018).
 *
 * The lattice: `paused > cancelled > failed > completed > running`.
 * `orphaned` sits outside the lattice — once reaped, it is sealed.
 */

import { describe, it, expect } from "vitest";
import { STATUS_RANK, shouldOverwriteStatus, type RunStatus } from "./types.js";

describe("STATUS_RANK", () => {
	it("encodes the documented precedence", () => {
		expect(STATUS_RANK.paused).toBeGreaterThan(STATUS_RANK.cancelled);
		expect(STATUS_RANK.cancelled).toBeGreaterThan(STATUS_RANK.failed);
		expect(STATUS_RANK.failed).toBeGreaterThan(STATUS_RANK.completed);
		expect(STATUS_RANK.completed).toBeGreaterThan(STATUS_RANK.running);
	});
});

describe("shouldOverwriteStatus", () => {
	const LATTICE: RunStatus[] = ["running", "completed", "failed", "cancelled", "paused"];

	it("paused wins over cancelled (issue #13 race fix)", () => {
		expect(shouldOverwriteStatus("paused", "cancelled")).toBe(false);
		expect(shouldOverwriteStatus("cancelled", "paused")).toBe(true);
	});

	it("nothing overwrites paused (highest in lattice)", () => {
		for (const proposed of LATTICE) {
			expect(shouldOverwriteStatus("paused", proposed)).toBe(false);
		}
	});

	it("equal statuses are no-ops (idempotency)", () => {
		for (const status of LATTICE) {
			expect(shouldOverwriteStatus(status, status)).toBe(false);
		}
	});

	it("running is overwritten by any terminal status", () => {
		expect(shouldOverwriteStatus("running", "completed")).toBe(true);
		expect(shouldOverwriteStatus("running", "failed")).toBe(true);
		expect(shouldOverwriteStatus("running", "cancelled")).toBe(true);
		expect(shouldOverwriteStatus("running", "paused")).toBe(true);
	});

	it("completed → failed allowed (failure surfaces later, e.g. merge_conflict)", () => {
		expect(shouldOverwriteStatus("completed", "failed")).toBe(true);
		expect(shouldOverwriteStatus("failed", "completed")).toBe(false);
	});

	it("orphaned is sealed — no later write overwrites", () => {
		for (const proposed of LATTICE) {
			expect(shouldOverwriteStatus("orphaned", proposed)).toBe(false);
		}
		expect(shouldOverwriteStatus("orphaned", "orphaned")).toBe(false);
	});

	it("orphaned promotion is only legal from running (reaper contract)", () => {
		expect(shouldOverwriteStatus("running", "orphaned")).toBe(true);
		expect(shouldOverwriteStatus("completed", "orphaned")).toBe(false);
		expect(shouldOverwriteStatus("failed", "orphaned")).toBe(false);
		expect(shouldOverwriteStatus("cancelled", "orphaned")).toBe(false);
		expect(shouldOverwriteStatus("paused", "orphaned")).toBe(false);
	});

	it("full lattice cross-product respects STATUS_RANK ordering", () => {
		// Every (current, proposed) pair where both are in LATTICE and proposed
		// has strictly higher rank should be a yes; everything else no.
		for (const current of LATTICE) {
			for (const proposed of LATTICE) {
				const expected = STATUS_RANK[proposed] > STATUS_RANK[current];
				expect(shouldOverwriteStatus(current, proposed)).toBe(expected);
			}
		}
	});
});
