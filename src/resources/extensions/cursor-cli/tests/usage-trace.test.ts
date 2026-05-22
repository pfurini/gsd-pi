/**
 * UPSTREAM_REVIEW:C — usage-trace.ts tests.
 *
 * The tracer is an opt-in diagnostic: a no-op unless `GSD_CURSOR_USAGE_LOG`
 * names a file. These tests pin the enable gate, the append-one-JSON-line
 * contract, and the never-throw guarantee (a diagnostic must never break a
 * slice).
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUsageTraceEnabled, traceUsage } from "../usage-trace.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cursor-usage-trace-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("isUsageTraceEnabled", () => {
	test("false when GSD_CURSOR_USAGE_LOG is unset or blank", () => {
		assert.equal(isUsageTraceEnabled({}), false);
		assert.equal(isUsageTraceEnabled({ GSD_CURSOR_USAGE_LOG: "" }), false);
		assert.equal(isUsageTraceEnabled({ GSD_CURSOR_USAGE_LOG: "   " }), false);
	});

	test("true when GSD_CURSOR_USAGE_LOG names a path", () => {
		assert.equal(isUsageTraceEnabled({ GSD_CURSOR_USAGE_LOG: "/tmp/cursor-usage.log" }), true);
	});
});

describe("traceUsage", () => {
	test("is a no-op when GSD_CURSOR_USAGE_LOG is unset", () => {
		const file = join(dir, "trace.log");
		traceUsage({ path: "sdk", event: "final", usage: null }, {});
		assert.equal(existsSync(file), false);
	});

	test("appends one JSON line per call, with a timestamp", () => {
		const file = join(dir, "trace.log");
		const env = { GSD_CURSOR_USAGE_LOG: file };

		traceUsage({ path: "cli", event: "result", usage: { inputTokens: 100 } }, env);
		traceUsage({ path: "sdk", event: "turn-ended", index: 1, usage: { inputTokens: 200 } }, env);

		const lines = readFileSync(file, "utf8").trim().split("\n");
		assert.equal(lines.length, 2);

		const first = JSON.parse(lines[0]);
		assert.equal(first.path, "cli");
		assert.equal(first.event, "result");
		assert.equal((first.usage as { inputTokens: number }).inputTokens, 100);
		assert.ok(typeof first.ts === "string" && first.ts.length > 0, "entry carries a timestamp");

		const second = JSON.parse(lines[1]);
		assert.equal(second.path, "sdk");
		assert.equal(second.index, 1);
		assert.equal((second.usage as { inputTokens: number }).inputTokens, 200);
	});

	test("swallows write failures (unwritable path) without throwing", () => {
		const env = { GSD_CURSOR_USAGE_LOG: join(dir, "no-such-dir", "trace.log") };
		assert.doesNotThrow(() => traceUsage({ path: "cli", event: "result" }, env));
	});
});
