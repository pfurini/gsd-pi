import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeNdjson, sanitizeLine } from "./fixtures/sanitize.mjs";

const STABLE_SESSION = "sess-XXXXXXXX";
const STABLE_CWD = "/tmp/fixture-workspace";
const STABLE_TIMESTAMP = "1970-01-01T00:00:00Z";
const HOME = "<HOME>";

describe("sanitizeLine", () => {
	test("replaces session_id, cwd, duration_ms and ISO timestamps in a single event", () => {
		const raw = JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: "9f3e1a2c-real-id",
			cwd: "/Users/paolof/Developer/ai/gsd-2",
			model: "composer-2",
			started_at: "2026-05-19T16:00:00Z",
			duration_ms: 1234,
			tools: ["read_file", "shell"],
		});
		const out = JSON.parse(sanitizeLine(raw));
		assert.equal(out.session_id, STABLE_SESSION);
		assert.equal(out.cwd, STABLE_CWD);
		assert.equal(out.started_at, STABLE_TIMESTAMP);
		assert.equal(out.duration_ms, 0);
		// Semantic fields preserved.
		assert.equal(out.type, "system");
		assert.equal(out.subtype, "init");
		assert.equal(out.model, "composer-2");
		assert.deepEqual(out.tools, ["read_file", "shell"]);
	});

	test("masks home paths and emails inside free-text fields", () => {
		const raw = JSON.stringify({
			type: "assistant",
			session_id: "x",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "I read /Users/paolof/secrets.txt and noted fornitori@datagenia.it",
					},
				],
			},
		});
		const out = JSON.parse(sanitizeLine(raw));
		const text = out.message.content[0].text;
		assert.ok(!/\/Users\//.test(text), `home path leaked: ${text}`);
		assert.ok(!/datagenia\.it/.test(text), `email leaked: ${text}`);
		assert.match(text, new RegExp(HOME));
		assert.match(text, /\[REDACTED_EMAIL\]/);
	});

	test("masks bearer / JWT / sk- / cursor-key tokens in any string field", () => {
		const raw = JSON.stringify({
			type: "error",
			message:
				"Failed with Authorization: Bearer abc123xyz789 and sk-deadbeefcafe and cursor-key-foobarbaz12",
		});
		const out = JSON.parse(sanitizeLine(raw));
		assert.ok(!/Bearer\s+abc/i.test(out.message), out.message);
		assert.ok(!/sk-deadbeef/.test(out.message), out.message);
		assert.ok(!/cursor-key-foobar/.test(out.message), out.message);
		assert.match(out.message, /\[REDACTED\]/);
	});

	test("passes through non-JSON lines with string-level redaction only", () => {
		const out = sanitizeLine("not json /Users/paolof but redacted");
		assert.equal(out, `not json ${HOME} but redacted`);
	});

	test("preserves semantically important fields (type, name, input.command)", () => {
		const raw = JSON.stringify({
			type: "tool_call",
			session_id: "real",
			tool_call_id: "call-abc",
			name: "shell",
			input: { command: "echo hello" },
		});
		const out = JSON.parse(sanitizeLine(raw));
		assert.equal(out.type, "tool_call");
		assert.equal(out.tool_call_id, "call-abc");
		assert.equal(out.name, "shell");
		assert.equal(out.input.command, "echo hello");
	});
});

describe("sanitizeNdjson", () => {
	test("is idempotent — running it twice yields the same bytes", () => {
		const raw =
			JSON.stringify({
				type: "system",
				subtype: "init",
				session_id: "abc",
				cwd: "/Users/paolof/dev",
				duration_ms: 42,
				started_at: "2026-05-19T16:00:00Z",
			}) +
			"\n" +
			JSON.stringify({
				type: "assistant",
				session_id: "abc",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "ran /Users/paolof/work and emailed x@y.com" },
					],
				},
			}) +
			"\n";
		const once = sanitizeNdjson(raw);
		const twice = sanitizeNdjson(once);
		assert.equal(twice, once, "sanitiser is not idempotent");
	});

	test("emits the same line count it was given (preserves NDJSON structure)", () => {
		const raw =
			JSON.stringify({ type: "system", subtype: "init", session_id: "a" }) +
			"\n" +
			JSON.stringify({ type: "result", subtype: "success", session_id: "a", result: "", usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1, is_error: false }) +
			"\n";
		const out = sanitizeNdjson(raw);
		assert.equal(out.split("\n").length, raw.split("\n").length);
	});

	test("placeholders themselves survive a second pass without re-redaction", () => {
		const raw = JSON.stringify({
			type: "system",
			session_id: STABLE_SESSION,
			cwd: STABLE_CWD,
			started_at: STABLE_TIMESTAMP,
		});
		const out = JSON.parse(sanitizeLine(raw));
		assert.equal(out.session_id, STABLE_SESSION);
		assert.equal(out.cwd, STABLE_CWD);
		assert.equal(out.started_at, STABLE_TIMESTAMP);
	});
});
