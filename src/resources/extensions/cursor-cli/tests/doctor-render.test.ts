/**
 * UPSTREAM_REVIEW:B — `doctor.ts` snapshot-style tests.
 *
 * The renderer is intentionally byte-stable: no colour codes, no timestamps
 * inside the table, fixed column widths. The tests pin the exact output so
 * accidental drift (rewording a label, adding a column) trips immediately.
 */
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { record, reset, snapshot } from "../metrics.ts";
import { renderDoctor } from "../doctor.ts";

beforeEach(() => {
	reset();
});

describe("renderDoctor", () => {
	test("empty snapshot renders the no-data sentinel", () => {
		const out = renderDoctor(snapshot());
		assert.equal(out, "no slices recorded yet");
	});

	test("snapshot with 10 entries renders a stable ASCII table", () => {
		// 10 successful entries with latencies 10, 20, ..., 100 ms.
		// p50 (nearest-rank): ceil(0.5*10) = 5 → sorted[4] = 50.
		// p95 (nearest-rank): ceil(0.95*10) = 10 → sorted[9] = 100.
		for (let i = 1; i <= 10; i++) {
			record({
				startedAt: 0,
				finishedAt: i * 10,
				model: "composer-2.5",
				outcome: "success",
				inputTokens: 100,
				outputTokens: 5,
			});
		}
		const out = renderDoctor(snapshot());
		// Label column width = 19 (from "total output tokens").
		// Value column width = 6 (from "100.0%").
		// Border: "+-" + 19 dashes + "-+-" + 6 dashes + "-+" → "+" + 21 + "+" + 8 + "+".
		// Row format: "| " + label.padEnd(19) + " | " + value.padEnd(6) + " |".
		const expected = [
			"+---------------------+--------+",
			"| samples             | 10     |",
			"| p50 latency (ms)    | 50     |",
			"| p95 latency (ms)    | 100    |",
			"| success rate        | 100.0% |",
			"| total input tokens  | 1000   |",
			"| total output tokens | 50     |",
			"+---------------------+--------+",
		].join("\n");
		assert.equal(out, expected);
	});

	test("rendered output contains all six metric labels", () => {
		record({
			startedAt: 0,
			finishedAt: 1,
			model: "composer-2.5",
			outcome: "success",
			inputTokens: 1,
			outputTokens: 1,
		});
		const out = renderDoctor(snapshot());
		assert.match(out, /samples/);
		assert.match(out, /p50 latency \(ms\)/);
		assert.match(out, /p95 latency \(ms\)/);
		assert.match(out, /success rate/);
		assert.match(out, /total input tokens/);
		assert.match(out, /total output tokens/);
	});

	test("lastError summary appears below the table when present", () => {
		record({
			startedAt: 0,
			finishedAt: 250,
			model: "composer-2.5",
			outcome: "error",
			errorCode: "quota_exhausted",
			inputTokens: 0,
			outputTokens: 0,
		});
		const out = renderDoctor(snapshot());
		const lines = out.split("\n");
		const lastLine = lines[lines.length - 1];
		assert.equal(lastLine, "last error: quota_exhausted @ 250");
	});

	test("latency dashes when only error entries are recorded (no successful samples)", () => {
		record({
			startedAt: 0,
			finishedAt: 250,
			model: "composer-2.5",
			outcome: "error",
			errorCode: "rate_limited",
			inputTokens: 0,
			outputTokens: 0,
		});
		const out = renderDoctor(snapshot());
		assert.match(out, /p50 latency \(ms\)\s+\|\s+—/);
		assert.match(out, /p95 latency \(ms\)\s+\|\s+—/);
	});
});

// UPSTREAM_REVIEW:C — adapter line tests (plan #06 `/cursor doctor` row).
describe("renderDoctor adapter line", () => {
	test("no adapter line when the adapter argument is omitted", () => {
		const out = renderDoctor(snapshot());
		assert.equal(out, "no slices recorded yet");
		assert.doesNotMatch(out, /adapter:/);
	});

	test("adapter line appears below the no-data sentinel", () => {
		const out = renderDoctor(snapshot(), "sdk (default)");
		assert.equal(out, "no slices recorded yet\nadapter: sdk (default)");
	});

	test("adapter line is the last line below a populated table", () => {
		record({
			startedAt: 0,
			finishedAt: 30,
			model: "composer-2.5",
			outcome: "success",
			inputTokens: 10,
			outputTokens: 2,
		});
		const out = renderDoctor(snapshot(), "cli");
		const lines = out.split("\n");
		assert.equal(lines[lines.length - 1], "adapter: cli");
	});

	test("adapter line follows the last-error summary when both are present", () => {
		record({
			startedAt: 0,
			finishedAt: 250,
			model: "composer-2.5",
			outcome: "error",
			errorCode: "quota_exhausted",
			inputTokens: 0,
			outputTokens: 0,
		});
		const out = renderDoctor(snapshot(), "cli (fell back from sdk)");
		const lines = out.split("\n");
		assert.equal(lines[lines.length - 2], "last error: quota_exhausted @ 250");
		assert.equal(lines[lines.length - 1], "adapter: cli (fell back from sdk)");
	});
});
