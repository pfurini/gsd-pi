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
import { pumpViaSdk, translateSdkMessage } from "../sdk-adapter.ts";
import type { SdkMessage, SdkModule } from "../sdk-types.ts";

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
}): SdkModule {
	return {
		Agent: {
			create: async () => ({
				agentId: "agent-test",
				close() {},
				async send() {
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
