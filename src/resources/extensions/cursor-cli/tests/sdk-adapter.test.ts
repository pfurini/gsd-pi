/**
 * UPSTREAM_REVIEW:C — sdk-adapter.ts tests.
 *
 * Drives `pumpViaSdk` against a hand-rolled mock SDK that yields a
 * synthesised AsyncIterable of SdkMessage values, asserting on the
 * AssistantMessageEvent shape downstream consumers see. The mock mirrors the
 * `@cursor/sdk` Agent.create / send / Run.stream / Run.wait surface defined
 * in sdk-types.ts.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventStream } from "@gsd/pi-ai";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
} from "@gsd/pi-ai";
import { accumulateSdkAssistantText, pumpViaSdk, translateSdkMessage } from "../sdk-adapter.ts";
import type {
	CursorAssistantEvent,
	SdkAgentCreateOptions,
	SdkMessage,
	SdkModule,
	SdkTurnEndedUpdate,
} from "../sdk-types.ts";

function makeStream(): AssistantMessageEventStream {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("unexpected event type for final result");
		},
	) as AssistantMessageEventStream;
}

function mockModel(): Model<Api> {
	return {
		id: "composer-2.5",
		name: "composer-2.5",
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
	return { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
}

function makeFakeSdk(scenario: {
	messages: SdkMessage[];
	wait?: { status: "finished" | "error" | "cancelled"; result?: string };
	/** Per-turn `turn-ended` usage blocks the fake delivers via `onDelta`. */
	turnEndedUsage?: NonNullable<SdkTurnEndedUpdate["usage"]>[];
}): SdkModule {
	return {
		Agent: {
			create: async () => ({
				agentId: "agent-test",
				close() {},
				async send(_message, options) {
					// Mirror @cursor/sdk: token usage reaches the adapter only
					// through the `onDelta` callback's `turn-ended` updates.
					for (const usage of scenario.turnEndedUsage ?? []) {
						options?.onDelta?.({ update: { type: "turn-ended", usage } });
					}
					return {
						id: "run-test",
						agentId: "agent-test",
						async *stream() {
							for (const m of scenario.messages) yield m;
						},
						async wait() {
							return {
								id: "run-test",
								status: scenario.wait?.status ?? "finished",
								result: scenario.wait?.result ?? "ok",
								durationMs: 5,
							};
						},
						async cancel() {},
					};
				},
			}),
		},
	};
}

describe("pumpViaSdk", () => {
	test("emits a done AssistantMessage for a happy-path SDK stream", async () => {
		const sdk = makeFakeSdk({
			messages: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-test",
					run_id: "run-test",
					model: { id: "composer-2.5" },
				},
				{
					type: "assistant",
					agent_id: "agent-test",
					run_id: "run-test",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "sdk-adapter-ok" }],
					},
				},
			],
			wait: { status: "finished", result: "sdk-adapter-ok" },
		});

		const stream = makeStream();
		await pumpViaSdk(sdk, mockModel(), mockContext(), undefined, stream);
		const final = await stream.result();

		assert.equal(final.stopReason, "stop");
		const text = final.content.find((b) => b.type === "text") as
			| { type: "text"; text: string }
			| undefined;
		assert.ok(text);
		assert.match(text.text, /sdk-adapter-ok/);
	});

	test("accumulates @cursor/sdk assistant text deltas into the final message", async () => {
		// @cursor/sdk emits assistant messages as incremental deltas ("P",
		// then "ONG"); the final message must read "PONG", not the last delta.
		// `wait.result` is a distinct value so the assertion proves the text
		// came from the accumulated deltas, not the fallback result string.
		const sdk = makeFakeSdk({
			messages: [
				{
					type: "assistant",
					agent_id: "agent-test",
					run_id: "run-test",
					message: { role: "assistant", content: [{ type: "text", text: "P" }] },
				},
				{
					type: "assistant",
					agent_id: "agent-test",
					run_id: "run-test",
					message: { role: "assistant", content: [{ type: "text", text: "ONG" }] },
				},
			],
			wait: { status: "finished", result: "fallback-not-used" },
		});

		const stream = makeStream();
		await pumpViaSdk(sdk, mockModel(), mockContext(), undefined, stream);
		const final = await stream.result();

		const text = final.content.find((b) => b.type === "text") as
			| { type: "text"; text: string }
			| undefined;
		assert.ok(text);
		assert.equal(
			text.text,
			"PONG",
			"multi-delta assistant text must accumulate, not snapshot-replace",
		);
	});

	// UPSTREAM_REVIEW:C — SDK usage parity with the CLI path. @cursor/sdk
	// surfaces token usage only via `turn-ended` interaction updates on the
	// onDelta callback; the pump must thread that into the final message so
	// the context meter and compaction work on the SDK path.
	test("captures the last turn-ended usage block into the final message", async () => {
		// Two turns fire; the adapter keeps the last so inputTokens reflects
		// the final, largest context size (parity with the CLI result event).
		const sdk = makeFakeSdk({
			messages: [
				{
					type: "assistant",
					agent_id: "agent-test",
					run_id: "run-test",
					message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
				},
			],
			wait: { status: "finished", result: "answer" },
			turnEndedUsage: [
				{ inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
				{ inputTokens: 171_000, outputTokens: 240, cacheReadTokens: 50, cacheWriteTokens: 30 },
			],
		});

		const stream = makeStream();
		await pumpViaSdk(sdk, mockModel(), mockContext(), undefined, stream);
		const final = await stream.result();

		assert.equal(final.usage.input, 171_000, "last turn-ended block must win");
		assert.equal(final.usage.output, 240);
		assert.equal(final.usage.cacheRead, 50);
		assert.equal(final.usage.cacheWrite, 30);
		assert.equal(final.usage.totalTokens, 171_240);
	});

	test("usage stays zero when the SDK emits no turn-ended update", async () => {
		// Graceful fallback: older SDK builds may not deliver a turn-ended
		// usage block — the path must not crash and reports ZERO_USAGE.
		const sdk = makeFakeSdk({
			messages: [
				{
					type: "assistant",
					agent_id: "agent-test",
					run_id: "run-test",
					message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
				},
			],
			wait: { status: "finished", result: "hi" },
		});

		const stream = makeStream();
		await pumpViaSdk(sdk, mockModel(), mockContext(), undefined, stream);
		const final = await stream.result();

		assert.equal(final.usage.input, 0);
		assert.equal(final.usage.totalTokens, 0);
	});

	// UPSTREAM_REVIEW:C — the adapter requests ONLY the `project` settings
	// layer: it loads `.cursor/rules` + `AGENTS.md` without triggering the
	// SDK's cross-tool agent-skill scan that the `user` layer would.
	test("creates the SDK agent with the project setting source only", async () => {
		let createOptions: SdkAgentCreateOptions | undefined;
		const sdk: SdkModule = {
			Agent: {
				create: async (options) => {
					createOptions = options;
					return {
						agentId: "agent-test",
						close() {},
						async send() {
							return {
								id: "run-test",
								agentId: "agent-test",
								// eslint-disable-next-line require-yield
								async *stream() {
									return;
								},
								async wait() {
									return {
										id: "run-test",
										status: "finished" as const,
										result: "ok",
										durationMs: 1,
									};
								},
								async cancel() {},
							};
						},
					};
				},
			},
		};

		const stream = makeStream();
		await pumpViaSdk(sdk, mockModel(), mockContext(), undefined, stream);
		await stream.result();

		assert.deepEqual(
			createOptions?.local?.settingSources,
			["project"],
			"slice must load only the project Cursor settings layer",
		);
	});

	test("synthesises an error final when run.wait reports status=error", async () => {
		const sdk = makeFakeSdk({
			messages: [],
			wait: { status: "error", result: "internal_failure" },
		});

		const stream = makeStream();
		await pumpViaSdk(sdk, mockModel(), mockContext(), undefined, stream);
		const final = await stream.result();

		assert.equal(final.stopReason, "error");
		assert.match(final.errorMessage ?? "", /internal_failure/);
	});

	test("translates tool_call + result into intermediate toolCall blocks with externalResult", async () => {
		const sdk = makeFakeSdk({
			messages: [
				{
					type: "tool_call",
					agent_id: "agent-test",
					run_id: "run-test",
					call_id: "tool-1",
					name: "shell",
					status: "completed",
					args: { command: "ls" },
					result: { content: "file.txt" },
				} satisfies SdkMessage,
				{
					type: "assistant",
					agent_id: "agent-test",
					run_id: "run-test",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ran the command" }],
					},
				},
			],
			wait: { status: "finished", result: "ran the command" },
		});

		const stream = makeStream();
		await pumpViaSdk(sdk, mockModel(), mockContext(), undefined, stream);
		const final = await stream.result();

		const tool = final.content.find((b) => b.type === "toolCall") as
			| { type: "toolCall"; id: string; externalResult?: { content: { type: string; text?: string }[]; isError: boolean } }
			| undefined;
		assert.ok(tool, "tool_call event should produce a toolCall content block");
		assert.equal(tool.id, "tool-1");
		assert.ok(tool.externalResult, "completed tool_call with result should attach externalResult");
		assert.equal(tool.externalResult.isError, false);
	});

	test("propagates abort signals via run.cancel and emits aborted final", async () => {
		let cancelled = false;
		const sdk: SdkModule = {
			Agent: {
				create: async () => ({
					agentId: "agent-test",
					close() {},
					async send() {
						return {
							id: "run-test",
							agentId: "agent-test",
							async *stream() {
								// Yield slowly so the abort beats completion.
								for (let i = 0; i < 50; i += 1) {
									await new Promise((r) => setTimeout(r, 10));
									yield {
										type: "assistant",
										agent_id: "agent-test",
										run_id: "run-test",
										message: {
											role: "assistant",
											content: [{ type: "text", text: `chunk-${i}` }],
										},
									} satisfies SdkMessage;
								}
							},
							async wait() {
								return { id: "run-test", status: "cancelled" as const, durationMs: 0 };
							},
							async cancel() {
								cancelled = true;
							},
						};
					},
				}),
			},
		};

		const controller = new AbortController();
		const stream = makeStream();
		const pumpPromise = pumpViaSdk(sdk, mockModel(), mockContext(), { signal: controller.signal }, stream);
		setTimeout(() => controller.abort(), 30);
		await pumpPromise;
		const final = await stream.result();

		assert.equal(final.stopReason, "aborted");
		assert.ok(cancelled, "run.cancel should be called on abort");
	});

	test("surfaces Agent.create errors as a redacted error final", async () => {
		const sdk: SdkModule = {
			Agent: {
				create: async () => {
					throw new Error("auth token sk-leak-1234567 invalid");
				},
			},
		};

		const stream = makeStream();
		await pumpViaSdk(sdk, mockModel(), mockContext(), undefined, stream);
		const final = await stream.result();

		assert.equal(final.stopReason, "error");
		assert.doesNotMatch(final.errorMessage ?? "", /sk-leak-1234567/, "raw secret must not leak");
		assert.match(final.errorMessage ?? "", /\[REDACTED\]/);
	});
});

describe("translateSdkMessage", () => {
	test("system init becomes a CursorSystemInitEvent", () => {
		const events = translateSdkMessage({
			type: "system",
			subtype: "init",
			agent_id: "a",
			run_id: "r",
			model: { id: "composer-2.5" },
		});
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "system");
	});

	test("assistant message preserves the content array", () => {
		const events = translateSdkMessage({
			type: "assistant",
			agent_id: "a",
			run_id: "r",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		});
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "assistant");
	});

	test("tool_call without result yields a single started-style event", () => {
		const events = translateSdkMessage({
			type: "tool_call",
			agent_id: "a",
			run_id: "r",
			call_id: "c1",
			name: "shell",
			status: "running",
			args: { cmd: "ls" },
		});
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "tool_call");
	});

	test("tool_call with completed status + result emits a tool_call AND a tool_result", () => {
		const events = translateSdkMessage({
			type: "tool_call",
			agent_id: "a",
			run_id: "r",
			call_id: "c1",
			name: "shell",
			status: "completed",
			args: { cmd: "ls" },
			result: "ok",
		});
		assert.equal(events.length, 2);
		assert.equal(events[0].type, "tool_call");
		assert.equal(events[1].type, "tool_result");
	});

	test("task / request messages are consumed silently", () => {
		assert.equal(translateSdkMessage({ type: "task", agent_id: "a", run_id: "r" }).length, 0);
		assert.equal(translateSdkMessage({ type: "request" } as SdkMessage).length, 0);
	});
});

describe("accumulateSdkAssistantText", () => {
	test("rewrites assistant deltas to a running cumulative total", () => {
		const acc = { text: "" };
		const mkDelta = (text: string): CursorAssistantEvent => ({
			type: "assistant",
			uuid: "run-test",
			session_id: "run-test",
			message: { role: "assistant", content: [{ type: "text", text }] },
		});

		const first = accumulateSdkAssistantText(mkDelta("P"), acc) as CursorAssistantEvent;
		const second = accumulateSdkAssistantText(mkDelta("ONG"), acc) as CursorAssistantEvent;

		const firstBlock = first.message.content[0];
		const secondBlock = second.message.content[0];
		assert.equal(firstBlock.type === "text" ? firstBlock.text : "", "P");
		assert.equal(secondBlock.type === "text" ? secondBlock.text : "", "PONG");
		assert.equal(acc.text, "PONG");
	});

	test("passes non-assistant events through untouched", () => {
		const acc = { text: "seed" };
		const events = translateSdkMessage({
			type: "system",
			subtype: "init",
			agent_id: "a",
			run_id: "r",
			model: { id: "composer-2.5" },
		});
		assert.equal(accumulateSdkAssistantText(events[0], acc), events[0]);
		assert.equal(acc.text, "seed");
	});
});
