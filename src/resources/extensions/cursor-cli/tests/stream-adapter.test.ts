import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model } from "@gsd/pi-ai";
import {
	buildCursorArgs,
	buildPromptFromContext,
} from "../stream-adapter.ts";
import {
	buildFinalAssistantContent,
	mapCursorEvent,
	mergePendingToolCalls,
	normalizeToolResultOutput,
	type ExternalToolResultPayload,
} from "../stream-translation.ts";
import type { CursorStreamEvent } from "../sdk-types.ts";

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

interface MapState {
	model: string;
	builder: null;
	sessionId: string | null;
	lastTextContent: string;
	intermediateToolBlocks: AssistantMessage["content"];
	toolResultsById: Map<string, ExternalToolResultPayload>;
}

function emptyState(): MapState {
	return {
		model: "composer-2.5",
		builder: null,
		sessionId: null,
		lastTextContent: "",
		intermediateToolBlocks: [],
		toolResultsById: new Map(),
	};
}

describe("buildCursorArgs", () => {
	test("emits the documented Phase 1 invocation", () => {
		const args = buildCursorArgs(mockModel(), "/tmp/work", undefined);
		assert.deepEqual(args, [
			"-p",
			"--output-format",
			"stream-json",
			"--model",
			"composer-2.5",
			"--workspace",
			"/tmp/work",
			"--trust",
		]);
	});

	test("opts into --force only when the slice declares write intent", () => {
		const args = buildCursorArgs(mockModel(), "/tmp/work", { allowsWrites: true });
		assert.ok(args.includes("--force"));
	});

	test("propagates --resume <sessionId> when supplied", () => {
		const args = buildCursorArgs(mockModel(), "/tmp/work", { resumeSessionId: "sess-123" });
		const resumeIdx = args.indexOf("--resume");
		assert.notEqual(resumeIdx, -1);
		assert.equal(args[resumeIdx + 1], "sess-123");
	});

	test("appends --sandbox when explicitly requested", () => {
		const args = buildCursorArgs(mockModel(), "/tmp/work", { sandbox: "enabled" });
		const sandboxIdx = args.indexOf("--sandbox");
		assert.notEqual(sandboxIdx, -1);
		assert.equal(args[sandboxIdx + 1], "enabled");
	});
});

describe("buildPromptFromContext", () => {
	test("returns empty string for an empty context", () => {
		assert.equal(buildPromptFromContext({ messages: [] }), "");
	});

	test("wraps history in XML tags and includes the system prompt", () => {
		const prompt = buildPromptFromContext({
			systemPrompt: "be helpful",
			messages: [
				{ role: "user", content: "hi", timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "cursor-stream-json" as Api,
					provider: "cursor-agent",
					model: "composer-2.5",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 0,
				},
			],
		});
		assert.match(prompt, /<prior_system_context>/);
		assert.match(prompt, /<user_message>\nhi\n<\/user_message>/);
		assert.match(prompt, /<assistant_message>\nhello\n<\/assistant_message>/);
	});
});

describe("mapCursorEvent — terminal result", () => {
	test("system init captures the session id without emitting events", () => {
		const state = emptyState();
		const { events, final } = mapCursorEvent(
			{ type: "system", subtype: "init", session_id: "sess-1", model: "composer-2.5", cwd: "/" } as CursorStreamEvent,
			state as unknown as Parameters<typeof mapCursorEvent>[1],
		);
		assert.equal(events.length, 0);
		assert.equal(final, undefined);
		assert.equal(state.sessionId, "sess-1");
	});

	test("assistant event records the latest text without emitting events", () => {
		const state = emptyState();
		mapCursorEvent(
			{
				type: "assistant",
				uuid: "u1",
				session_id: "s1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hi from cursor" }],
				},
			} as CursorStreamEvent,
			state as unknown as Parameters<typeof mapCursorEvent>[1],
		);
		assert.equal(state.lastTextContent, "hi from cursor");
	});

	test("tool_call + tool_result attach an external result by id", () => {
		const state = emptyState();
		mapCursorEvent(
			{
				type: "tool_call",
				uuid: "u1",
				session_id: "s1",
				tool_call_id: "call-1",
				name: "shell",
				input: { command: "ls" },
			} as CursorStreamEvent,
			state as unknown as Parameters<typeof mapCursorEvent>[1],
		);
		mapCursorEvent(
			{
				type: "tool_result",
				uuid: "u2",
				session_id: "s1",
				tool_call_id: "call-1",
				output: "file.txt",
				is_error: false,
			} as CursorStreamEvent,
			state as unknown as Parameters<typeof mapCursorEvent>[1],
		);
		assert.equal(state.intermediateToolBlocks.length, 1);
		const block = state.intermediateToolBlocks[0] as unknown as Record<string, unknown>;
		assert.equal((block as { type: string }).type, "toolCall");
		const ext = (block as { externalResult?: ExternalToolResultPayload }).externalResult;
		assert.ok(ext);
		assert.equal(ext.isError, false);
		assert.deepEqual(ext.content, [{ type: "text", text: "file.txt" }]);
	});

	test("result.subtype=success emits a done final message with usage", () => {
		const state = emptyState();
		state.lastTextContent = "all good";
		const { final } = mapCursorEvent(
			{
				type: "result",
				subtype: "success",
				session_id: "s1",
				result: "all good",
				usage: { input_tokens: 7, output_tokens: 3 },
				duration_ms: 100,
				is_error: false,
			} as CursorStreamEvent,
			state as unknown as Parameters<typeof mapCursorEvent>[1],
		);
		assert.ok(final);
		assert.equal(final.kind, "done");
		assert.equal(final.message.stopReason, "stop");
		assert.equal(final.message.usage.input, 7);
		assert.equal(final.message.usage.output, 3);
	});

	test("result.is_error=true emits an error final message", () => {
		const state = emptyState();
		const { final } = mapCursorEvent(
			{
				type: "result",
				subtype: "error",
				session_id: "s1",
				result: "quota_exhausted",
				usage: { input_tokens: 0, output_tokens: 0 },
				duration_ms: 1,
				is_error: true,
			} as CursorStreamEvent,
			state as unknown as Parameters<typeof mapCursorEvent>[1],
		);
		assert.ok(final);
		assert.equal(final.kind, "error");
		assert.equal(final.message.stopReason, "error");
		assert.match(final.message.errorMessage ?? "", /quota_exhausted/);
	});
});

describe("normalizeToolResultOutput", () => {
	test("wraps a string into a single text block", () => {
		assert.deepEqual(normalizeToolResultOutput("hello"), [{ type: "text", text: "hello" }]);
	});

	test("preserves text + image blocks from array output", () => {
		const out = normalizeToolResultOutput([
			{ type: "text", text: "alpha" },
			{ type: "image", data: "abc", mimeType: "image/png" },
		]);
		assert.equal(out.length, 2);
		assert.equal(out[0].type, "text");
		assert.equal(out[1].type, "image");
	});

	test("stringifies object output as text", () => {
		const out = normalizeToolResultOutput({ status: "ok" });
		assert.equal(out.length, 1);
		assert.equal(out[0].type, "text");
		assert.match(out[0].text ?? "", /status/);
	});
});

describe("mergePendingToolCalls + buildFinalAssistantContent", () => {
	test("deduplicates pending tool calls by id", () => {
		const intermediate: AssistantMessage["content"] = [
			{ type: "toolCall", id: "x", name: "foo", arguments: {} },
		];
		const pending: AssistantMessage["content"] = [
			{ type: "toolCall", id: "x", name: "foo", arguments: {} },
			{ type: "toolCall", id: "y", name: "bar", arguments: {} },
		];
		const merged = mergePendingToolCalls(intermediate, pending);
		assert.equal(merged.length, 2);
		assert.equal((merged[0] as { id: string }).id, "x");
		assert.equal((merged[1] as { id: string }).id, "y");
	});

	test("appends lastTextContent when there is no pending content", () => {
		const final = buildFinalAssistantContent({
			intermediateToolBlocks: [],
			toolResultsById: new Map(),
			lastTextContent: "done",
		});
		assert.equal(final.length, 1);
		assert.equal(final[0].type, "text");
	});

	test("falls back to result.text when the turn is otherwise empty", () => {
		const final = buildFinalAssistantContent({
			intermediateToolBlocks: [],
			toolResultsById: new Map(),
			fallbackResultText: "from result",
		});
		assert.equal(final.length, 1);
		assert.equal(final[0].type, "text");
		assert.equal((final[0] as { text: string }).text, "from result");
	});
});
