import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseNdjson } from "../ndjson-parser.ts";
import type { CursorStreamEvent } from "../sdk-types.ts";

/** Build a Readable stream from a list of chunk strings to exercise partial-chunk handling. */
function streamFromChunks(chunks: string[]): Readable {
	return Readable.from(chunks);
}

async function collect(stream: Readable): Promise<CursorStreamEvent[]> {
	const events: CursorStreamEvent[] = [];
	for await (const event of parseNdjson(stream)) {
		events.push(event);
	}
	return events;
}

describe("parseNdjson", () => {
	test("parses well-formed NDJSON delivered in a single chunk", async () => {
		const stream = streamFromChunks([
			JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "x", cwd: "/" }) + "\n",
			JSON.stringify({
				type: "result",
				subtype: "success",
				session_id: "s1",
				result: "ok",
				usage: { input_tokens: 1, output_tokens: 2 },
				duration_ms: 5,
				is_error: false,
			}) + "\n",
		]);
		const events = await collect(stream);
		assert.equal(events.length, 2);
		assert.equal(events[0].type, "system");
		assert.equal(events[1].type, "result");
	});

	test("handles partial chunks split mid-line", async () => {
		const payload = JSON.stringify({ type: "assistant", uuid: "u1", session_id: "s1", message: { role: "assistant", content: [] } });
		const stream = streamFromChunks([payload.slice(0, 20), payload.slice(20), "\n"]);
		const events = await collect(stream);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "assistant");
	});

	test("handles CRLF line endings", async () => {
		const a = JSON.stringify({ type: "error", message: "boom" });
		const b = JSON.stringify({ type: "result", subtype: "error", session_id: "s1", result: "", usage: { input_tokens: 0, output_tokens: 0 }, duration_ms: 0, is_error: true });
		const stream = streamFromChunks([`${a}\r\n${b}\r\n`]);
		const events = await collect(stream);
		assert.equal(events.length, 2);
		assert.equal(events[0].type, "error");
		assert.equal(events[1].type, "result");
	});

	test("skips malformed JSON lines without throwing", async () => {
		const good = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "x", cwd: "/" });
		const stream = streamFromChunks([`{this is not json\n${good}\n`]);
		const events = await collect(stream);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "system");
	});

	test("flushes a trailing line without a terminator", async () => {
		const payload = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "x", cwd: "/" });
		const stream = streamFromChunks([payload]);
		const events = await collect(stream);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "system");
	});

	test("rejects non-object NDJSON entries", async () => {
		const stream = streamFromChunks(['"a bare string"\n', 'null\n', '42\n']);
		const events = await collect(stream);
		assert.equal(events.length, 0);
	});
});
