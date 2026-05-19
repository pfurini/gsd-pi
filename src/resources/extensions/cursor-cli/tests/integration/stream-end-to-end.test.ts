/**
 * End-to-end integration tests for `streamViaCursorCli`.
 *
 * Each test sets `CURSOR_AGENT_BIN` to the fake binary shim in this directory,
 * drives the full spawn → NDJSON → AssistantMessageEvent pump, and asserts on
 * the resolved final `AssistantMessage`. The fake binary is parametrised via
 * `CURSOR_FAKE_*` env vars (see fake-cursor-agent.mjs for the matrix) so a
 * single shim covers happy / abort / non-zero-exit / exhausted / argv-echo
 * paths.
 *
 * Why a sub-process — the `mapCursorEvent` unit tests verify the mapping
 * table; only an actual spawn exercises stderr buffering, secret redaction
 * inside `makeErrorMessage`, abort propagation, and the exit-vs-stdout race.
 */
import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Api, AssistantMessage, Context, Model, ToolCall } from "@gsd/pi-ai";
import {
	streamViaCursorCli,
	type CursorStreamOptions,
	type ExternalToolResultPayload,
} from "../../stream-adapter.ts";
// UPSTREAM_REVIEW:C — the metrics recording hook moved to the public
// dispatcher (`streamViaCursor`). The metrics regression test below drives
// the dispatcher with `__setSdkForTests(null)` so the SDK probe short-circuits
// to the CLI pump deterministically without touching the on-disk setting.
import { streamViaCursor } from "../../stream-dispatch.ts";
import { __setSdkForTests } from "../../sdk-runtime.ts";
import { __resetPathCacheForTests } from "../../path-selector.ts";
import { clearReadinessCache } from "../../readiness.ts";
// UPSTREAM_REVIEW:A — pull the live retryable-error regex into the test so the
// assertion fails loudly if a future refactor drops the `quota_exhausted`
// token without updating the cursor classifier (and vice versa).
import { RETRYABLE_ERROR_RE } from "@gsd/pi-coding-agent";
// UPSTREAM_REVIEW:B — drive the recording hook end-to-end. The test asserts
// that one full fixture run produces exactly one entry in the metrics ring,
// proving the hook actually fires off the live `EventStream.result()`
// resolution path.
import { snapshot as metricsSnapshot, reset as resetMetrics } from "../../metrics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fake-cursor-agent.mjs");
const FIXTURES = join(HERE, "..", "fixtures");

const ORIGINAL_BIN = process.env.CURSOR_AGENT_BIN;
const ORIGINAL_KEY = process.env.CURSOR_API_KEY;
const ORIGINAL_DISABLE = process.env.GSD_CURSOR_DISABLE;
const TEMP_DIRS: string[] = [];

function mockModel(id = "composer-2.5"): Model<Api> {
	return {
		id,
		name: id,
		api: "cursor-stream-json" as Api,
		provider: "cursor-agent",
		baseUrl: "local://cursor-agent",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function mockContext(): Context {
	return {
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

function mktempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-cli-it-"));
	TEMP_DIRS.push(dir);
	return dir;
}

function getToolCallBlocks(message: AssistantMessage): (ToolCall & { externalResult?: ExternalToolResultPayload })[] {
	const out: (ToolCall & { externalResult?: ExternalToolResultPayload })[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall") {
			out.push(block as ToolCall & { externalResult?: ExternalToolResultPayload });
		}
	}
	return out;
}

before(() => {
	process.env.CURSOR_AGENT_BIN = FAKE;
	// Short-circuit the auth probe in readiness — the fake handles `status
	// --json` too, but setting CURSOR_API_KEY skips the spawn entirely.
	process.env.CURSOR_API_KEY = "fake-key-for-tests";
	delete process.env.GSD_CURSOR_DISABLE;
});

after(() => {
	if (ORIGINAL_BIN === undefined) delete process.env.CURSOR_AGENT_BIN;
	else process.env.CURSOR_AGENT_BIN = ORIGINAL_BIN;
	if (ORIGINAL_KEY === undefined) delete process.env.CURSOR_API_KEY;
	else process.env.CURSOR_API_KEY = ORIGINAL_KEY;
	if (ORIGINAL_DISABLE === undefined) delete process.env.GSD_CURSOR_DISABLE;
	else process.env.GSD_CURSOR_DISABLE = ORIGINAL_DISABLE;
	for (const dir of TEMP_DIRS) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
	TEMP_DIRS.length = 0;
});

beforeEach(() => {
	clearReadinessCache();
	// UPSTREAM_REVIEW:B — reset the local-metrics ring per test so the
	// `record()` hook's effects don't bleed across cases.
	resetMetrics();
	delete process.env.CURSOR_FAKE_FIXTURE;
	delete process.env.CURSOR_FAKE_EXIT_CODE;
	delete process.env.CURSOR_FAKE_STDERR;
	delete process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE;
	delete process.env.CURSOR_FAKE_HANG_AFTER_BYTE;
	delete process.env.CURSOR_FAKE_ECHO_ARGV;
	delete process.env.CURSOR_FAKE_ECHO_FILE;
	delete process.env.CURSOR_FAKE_CHUNK_BYTES;
	delete process.env.CURSOR_FAKE_CHUNK_DELAY_MS;
});

describe("streamViaCursorCli end-to-end", () => {
	test("01-hello-text fixture produces a complete done message", async () => {
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");

		const stream = streamViaCursorCli(mockModel(), mockContext());
		const final = await stream.result();

		assert.equal(final.stopReason, "stop", "final stopReason should be stop");
		assert.equal(final.provider, "cursor-agent");
		assert.equal(final.api, "cursor-stream-json");
		assert.equal(final.model, "composer-2.5");
		assert.ok(
			final.usage.input + final.usage.output > 0,
			"usage should reflect the captured fixture",
		);
		const textBlock = final.content.find((b) => b.type === "text") as
			| { type: "text"; text: string }
			| undefined;
		assert.ok(textBlock, "final content should include the captured text");
		assert.match(textBlock.text, /hello fixture/);
	});

	test("02-single-tool-call fixture attaches externalResult to the tool block", async () => {
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "02-single-tool-call.ndjson");

		const stream = streamViaCursorCli(mockModel(), mockContext());
		const final = await stream.result();

		assert.equal(final.stopReason, "stop");
		const tools = getToolCallBlocks(final);
		assert.ok(tools.length >= 1, "expected at least one tool-call block");
		const readTool = tools[0];
		assert.ok(readTool.externalResult, "tool block should carry externalResult");
		assert.equal(readTool.externalResult.isError, false);
		const firstContent = readTool.externalResult.content[0];
		assert.ok(firstContent, "externalResult.content[0] should be present");
		assert.equal(firstContent.type, "text");
	});

	test("abort signal terminates the child and emits aborted final", async () => {
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");
		// Small chunks force the hang to trigger well before the terminal
		// `result` event so the abort beats natural completion.
		process.env.CURSOR_FAKE_CHUNK_BYTES = "80";
		process.env.CURSOR_FAKE_CHUNK_DELAY_MS = "10";
		process.env.CURSOR_FAKE_HANG_AFTER_BYTE = "160";

		const controller = new AbortController();
		const stream = streamViaCursorCli(mockModel(), mockContext(), {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 150);

		const final = await stream.result();
		assert.equal(final.stopReason, "aborted", "abort should propagate to final");
	});

	test("non-zero exit before result emits error final with redacted stderr", async () => {
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");
		// Truncate well before the terminal `result` event.
		process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE = "100";
		process.env.CURSOR_FAKE_EXIT_CODE = "2";
		process.env.CURSOR_FAKE_STDERR = "auth token sk-leak-this-1234567 expired";

		const stream = streamViaCursorCli(mockModel(), mockContext());
		const final = await stream.result();

		assert.equal(final.stopReason, "error");
		const errorMessage = final.errorMessage ?? "";
		assert.doesNotMatch(errorMessage, /sk-leak-this/, "raw secret must not leak");
		assert.match(errorMessage, /\[REDACTED\]/, "redaction marker should be present");
		assert.match(errorMessage, /exited 2/, "should surface the non-zero exit");
	});

	test("clean exit before result emits stream_exhausted_without_result", async () => {
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");
		process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE = "100";
		process.env.CURSOR_FAKE_EXIT_CODE = "0";

		const stream = streamViaCursorCli(mockModel(), mockContext());
		const final = await stream.result();

		assert.equal(final.stopReason, "error");
		assert.match(final.errorMessage ?? "", /stream_exhausted_without_result/);
	});

	test("buildCursorArgs invocation matches the documented contract", async () => {
		const echoFile = join(mktempDir(), "argv.json");
		process.env.CURSOR_FAKE_ECHO_ARGV = "1";
		process.env.CURSOR_FAKE_ECHO_FILE = echoFile;
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");

		const stream = streamViaCursorCli(mockModel(), mockContext());
		await stream.result();

		const argv = JSON.parse(readFileSync(echoFile, "utf8")) as string[];
		assert.deepEqual(argv.slice(0, 5), [
			"-p",
			"--output-format",
			"stream-json",
			"--model",
			"composer-2.5",
		]);
		assert.equal(argv[5], "--workspace", "workspace flag at slot 5");
		assert.ok(argv.includes("--trust"));
		assert.ok(!argv.includes("--force"), "--force only when allowsWrites=true");
		// The prompt is the last positional arg.
		const last = argv[argv.length - 1];
		assert.ok(typeof last === "string" && last.length > 0, "prompt should be last arg");
	});

	test("allowsWrites=true adds --force to the spawned argv", async () => {
		const echoFile = join(mktempDir(), "argv.json");
		process.env.CURSOR_FAKE_ECHO_ARGV = "1";
		process.env.CURSOR_FAKE_ECHO_FILE = echoFile;
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");

		const options: CursorStreamOptions = { allowsWrites: true };
		const stream = streamViaCursorCli(mockModel(), mockContext(), options);
		await stream.result();

		const argv = JSON.parse(readFileSync(echoFile, "utf8")) as string[];
		assert.ok(argv.includes("--force"), "--force must be present when allowsWrites=true");
	});

	// UPSTREAM_REVIEW:A — exercises the cursor-side classifier end-to-end and
	// proves the structured marker enters the existing retry pipeline.
	test("04-quota-exhausted fixture emits structured quota_exhausted marker", async () => {
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "04-quota-exhausted.ndjson");

		const stream = streamViaCursorCli(mockModel(), mockContext());
		const final = await stream.result();

		assert.equal(final.stopReason, "error", "stopReason should be error");
		const errorMessage = final.errorMessage ?? "";
		assert.match(
			errorMessage,
			/^quota_exhausted: /,
			"errorMessage should start with the structured quota marker",
		);
		assert.match(
			errorMessage,
			/plan limit reached/,
			"redacted detail should be appended after the marker",
		);
		assert.ok(
			RETRYABLE_ERROR_RE.test(errorMessage),
			"errorMessage must match RETRYABLE_ERROR_RE so the GSD retry handler accepts it",
		);
	});

	// UPSTREAM_REVIEW:B — end-to-end proof that the recording hook fires off
	// the live EventStream.result() resolution path. If the hook is removed or
	// silently broken, this test catches it.
	// UPSTREAM_REVIEW:C — drives the dispatcher (which now owns the metrics
	// hook) with `__setSdkForTests(null)` so the SDK probe short-circuits to
	// the CLI pump without reading any on-disk setting.
	test("metrics ring records one success entry after a happy-path fixture run", async () => {
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");
		__setSdkForTests(null);
		__resetPathCacheForTests();

		const stream = streamViaCursor(mockModel(), mockContext());
		await stream.result();
		// The recording hook is `.then`'d off the same `stream.result()`
		// promise the test awaited. Yield once to let the second microtask
		// run before snapshotting.
		await new Promise((r) => setImmediate(r));

		const snap = metricsSnapshot();
		assert.equal(snap.sampleCount, 1, "expected exactly one recorded entry");
		assert.equal(snap.successRate, 1, "happy-path fixture should record as success");
		assert.ok(
			snap.totalInputTokens > 0,
			"token totals should reflect the fixture's usage block",
		);
	});

	// UPSTREAM_REVIEW:C — SDK-path smoke through the dispatcher. Drives a
	// hand-rolled SdkModule mock end-to-end and asserts the same shape of
	// `done` AssistantMessage the CLI fixture produces (minus token usage —
	// the SDK Run interface doesn't surface it).
	test("dispatcher routes through SDK path when __setSdkForTests provides a mock SDK", async () => {
		__setSdkForTests(makeFakeSdkModule());
		__resetPathCacheForTests();

		const stream = streamViaCursor(mockModel(), mockContext());
		const final = await stream.result();

		assert.equal(final.stopReason, "stop", "SDK path should resolve done");
		assert.equal(final.provider, "cursor-agent");
		const text = final.content.find((b) => b.type === "text") as
			| { type: "text"; text: string }
			| undefined;
		assert.ok(text, "SDK path should emit a final text block");
		assert.match(text.text, /sdk-mock-ok/);
		// Metrics hook on the dispatcher fires for the SDK path too.
		await new Promise((r) => setImmediate(r));
		const snap = metricsSnapshot();
		assert.equal(snap.sampleCount, 1, "dispatcher should record exactly once for SDK path");
	});
});

// UPSTREAM_REVIEW:C — minimal SdkModule mock used by the dispatcher test.
// Yields one assistant text message and a finished RunResult. Mirrors the
// `Agent.create → agent.send → run.stream → run.wait` shape sdk-adapter.ts
// drives.
function makeFakeSdkModule() {
	return {
		Agent: {
			create: async () => ({
				agentId: "agent-mock",
				close() {},
				async send() {
					return {
						id: "run-mock",
						agentId: "agent-mock",
						async *stream() {
							yield {
								type: "assistant",
								agent_id: "agent-mock",
								run_id: "run-mock",
								message: {
									role: "assistant",
									content: [{ type: "text", text: "sdk-mock-ok" }],
								},
							};
						},
						async wait() {
							return {
								id: "run-mock",
								status: "finished" as const,
								result: "sdk-mock-ok",
								durationMs: 10,
							};
						},
						async cancel() {},
					};
				},
			}),
		},
	};
}
