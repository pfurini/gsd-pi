/**
 * UPSTREAM_REVIEW:B — `metrics.ts` unit tests.
 *
 * Verifies the ring buffer, percentile math, env opt-out, and the hard-cap
 * assertion. All tests reset state in `beforeEach` so ordering is irrelevant.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	record,
	reset,
	snapshot,
	isMetricsEnabled,
	__setRingSizeForTests,
	__resetRingSizeForTests,
	type MetricEntry,
} from "../metrics.ts";

function makeEntry(overrides: Partial<MetricEntry> = {}): MetricEntry {
	const base: MetricEntry = {
		startedAt: 0,
		finishedAt: 100,
		model: "composer-2.5",
		outcome: "success",
		inputTokens: 10,
		outputTokens: 5,
	};
	return { ...base, ...overrides };
}

const ORIGINAL_DISABLE = process.env.GSD_CURSOR_METRICS_DISABLE;

beforeEach(() => {
	delete process.env.GSD_CURSOR_METRICS_DISABLE;
	reset();
	__resetRingSizeForTests();
});

afterEach(() => {
	if (ORIGINAL_DISABLE === undefined) delete process.env.GSD_CURSOR_METRICS_DISABLE;
	else process.env.GSD_CURSOR_METRICS_DISABLE = ORIGINAL_DISABLE;
});

describe("metrics", () => {
	describe("snapshot()", () => {
		test("returns nulls and zeros when the ring is empty", () => {
			const snap = snapshot();
			assert.equal(snap.sampleCount, 0);
			assert.equal(snap.latencyMsP50, null);
			assert.equal(snap.latencyMsP95, null);
			assert.equal(snap.successRate, null);
			assert.equal(snap.totalInputTokens, 0);
			assert.equal(snap.totalOutputTokens, 0);
			assert.equal(snap.lastError, undefined);
		});

		test("single success entry: p50 === p95 === entry latency", () => {
			record(makeEntry({ startedAt: 1000, finishedAt: 1250 }));
			const snap = snapshot();
			assert.equal(snap.sampleCount, 1);
			assert.equal(snap.latencyMsP50, 250);
			assert.equal(snap.latencyMsP95, 250);
			assert.equal(snap.successRate, 1);
			assert.equal(snap.totalInputTokens, 10);
			assert.equal(snap.totalOutputTokens, 5);
		});

		test("50 successful entries with sorted latencies: p50/p95 match nearest-rank math", () => {
			// Latencies 1..50ms. Nearest-rank with p=50 over 50 samples picks
			// ceil(0.50*50)=25, i.e. the 25th value (1-indexed) → 25. p=95 picks
			// ceil(0.95*50)=48 → 48.
			for (let i = 1; i <= 50; i++) {
				record(makeEntry({ startedAt: 0, finishedAt: i }));
			}
			const snap = snapshot();
			assert.equal(snap.sampleCount, 50);
			assert.equal(snap.latencyMsP50, 25);
			assert.equal(snap.latencyMsP95, 48);
			assert.equal(snap.successRate, 1);
		});

		test("ring evicts oldest past RING_SIZE (50), keeping the most-recent 50", () => {
			for (let i = 1; i <= 60; i++) {
				record(makeEntry({ startedAt: 0, finishedAt: i }));
			}
			const snap = snapshot();
			assert.equal(snap.sampleCount, 50);
			// Latencies 11..60 → nearest-rank p50 picks the 25th sorted value = 35;
			// p95 picks ceil(0.95*50)=48 → 58.
			assert.equal(snap.latencyMsP50, 35);
			assert.equal(snap.latencyMsP95, 58);
		});

		test("error and aborted contribute to successRate denominator but not to latency percentiles", () => {
			record(makeEntry({ startedAt: 0, finishedAt: 100 })); // success, 100ms
			record(makeEntry({ outcome: "error", startedAt: 0, finishedAt: 9000 }));
			record(makeEntry({ outcome: "aborted", startedAt: 0, finishedAt: 9000 }));
			const snap = snapshot();
			assert.equal(snap.sampleCount, 3);
			// Only the success latency contributes to the percentiles.
			assert.equal(snap.latencyMsP50, 100);
			assert.equal(snap.latencyMsP95, 100);
			// 1 success out of 3 = 1/3.
			assert.ok(snap.successRate !== null);
			assert.ok(
				Math.abs((snap.successRate ?? 0) - 1 / 3) < 1e-9,
				`expected successRate ≈ 1/3, got ${snap.successRate}`,
			);
		});

		test("lastError reflects the most recent error entry", () => {
			record(makeEntry({ outcome: "error", finishedAt: 100, errorCode: "rate_limited" }));
			record(makeEntry({ outcome: "success", finishedAt: 200 }));
			record(makeEntry({ outcome: "error", finishedAt: 300, errorCode: "quota_exhausted" }));
			const snap = snapshot();
			assert.deepEqual(snap.lastError, { at: 300, code: "quota_exhausted" });
		});

		test("lastError defaults to 'other' when an error entry has no errorCode", () => {
			record(makeEntry({ outcome: "error", finishedAt: 42 }));
			const snap = snapshot();
			assert.deepEqual(snap.lastError, { at: 42, code: "other" });
		});

		test("totalInputTokens / totalOutputTokens sum across all outcomes", () => {
			record(makeEntry({ outcome: "success", inputTokens: 10, outputTokens: 1 }));
			record(makeEntry({ outcome: "error", inputTokens: 20, outputTokens: 2 }));
			record(makeEntry({ outcome: "aborted", inputTokens: 30, outputTokens: 3 }));
			const snap = snapshot();
			assert.equal(snap.totalInputTokens, 60);
			assert.equal(snap.totalOutputTokens, 6);
		});
	});

	describe("isMetricsEnabled / record() env opt-out", () => {
		test("isMetricsEnabled returns true by default", () => {
			assert.equal(isMetricsEnabled(), true);
		});

		test("isMetricsEnabled returns false when GSD_CURSOR_METRICS_DISABLE=1", () => {
			assert.equal(isMetricsEnabled({ GSD_CURSOR_METRICS_DISABLE: "1" }), false);
		});

		test("isMetricsEnabled is unaffected by GSD_CURSOR_METRICS_DISABLE=0 or other values", () => {
			assert.equal(isMetricsEnabled({ GSD_CURSOR_METRICS_DISABLE: "0" }), true);
			assert.equal(isMetricsEnabled({ GSD_CURSOR_METRICS_DISABLE: "true" }), true);
			assert.equal(isMetricsEnabled({}), true);
		});

		test("record() is a no-op when GSD_CURSOR_METRICS_DISABLE=1", () => {
			process.env.GSD_CURSOR_METRICS_DISABLE = "1";
			record(makeEntry());
			record(makeEntry({ outcome: "error" }));
			const snap = snapshot();
			assert.equal(snap.sampleCount, 0);
			assert.equal(snap.lastError, undefined);
		});
	});

	describe("hard cap", () => {
		test("record() throws when RING_SIZE has been mis-edited above RING_HARD_MAX", () => {
			__setRingSizeForTests(2048); // RING_HARD_MAX is 1024.
			assert.throws(
				() => record(makeEntry()),
				/RING_SIZE \(2048\) exceeds RING_HARD_MAX \(1024\)/,
			);
		});

		test("RING_HARD_MAX itself is acceptable (boundary)", () => {
			__setRingSizeForTests(1024);
			assert.doesNotThrow(() => record(makeEntry()));
		});
	});

	describe("recording never throws on plausible inputs (recorder robustness)", () => {
		test("error entry without errorCode does not throw", () => {
			assert.doesNotThrow(() =>
				record(makeEntry({ outcome: "error", errorCode: undefined })),
			);
		});

		test("zero-length latency does not throw and is included as 0ms", () => {
			record(makeEntry({ startedAt: 500, finishedAt: 500 }));
			const snap = snapshot();
			assert.equal(snap.latencyMsP50, 0);
		});
	});
});
