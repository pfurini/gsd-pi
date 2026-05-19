/**
 * Streaming partial-message state tracker for the Cursor CLI provider.
 *
 * Coalesces text deltas emitted by `cursor-agent --stream-partial-output`
 * into a single growing `AssistantMessage.content[]` array, while emitting
 * GSD `AssistantMessageEvent` deltas for incremental TUI rendering.
 *
 * Mirrors `claude-code-cli/partial-builder.ts` but for the Cursor NDJSON
 * event shape — Cursor emits `stream_event` wrappers whose inner
 * `event.type` resembles Anthropic's `text_delta` / `input_json_delta`,
 * but the contract is intentionally narrower because we do not surface
 * thinking blocks in `-p` mode.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	StopReason,
	TextContent,
	ToolCall,
	Usage,
} from "@gsd/pi-ai";
import { hasXmlParameterTags, repairToolJson } from "@gsd/pi-ai";
import type { CursorContentBlock, CursorUsage } from "./sdk-types.js";

/** Zero-cost usage constant — Cursor bills against the user's subscription. */
export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Convert Cursor's `result.usage` into GSD's `Usage` shape (no dollar cost).
 *
 * Accepts both the documented snake_case shape and the live binary's
 * camelCase shape — see {@link CursorUsage}. Cache token counts are
 * preserved when present so the TUI footer can reflect them once GSD's
 * `Usage.cacheRead` / `cacheWrite` are surfaced.
 */
export function mapUsage(usage: CursorUsage): Usage {
	const input = usage.inputTokens ?? usage.input_tokens ?? 0;
	const output = usage.outputTokens ?? usage.output_tokens ?? 0;
	const cacheRead = usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? usage.cache_write_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Map Cursor's result subtype + is_error into a GSD `StopReason`. */
export function mapStopReason(subtype: string, isError: boolean): StopReason {
	if (isError) return "error";
	switch (subtype) {
		case "success":
			return "stop";
		default:
			return "stop";
	}
}

/** Build a `ToolCall` block from a Cursor `tool_use` content entry. */
export function toolCallFromCursorBlock(
	id: string,
	name: string,
	input: unknown,
): ToolCall {
	const args =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {};
	return {
		type: "toolCall",
		id,
		name,
		arguments: args,
	};
}

/** Convert a single Cursor content block into a GSD content block. */
export function mapContentBlock(block: CursorContentBlock): TextContent | ToolCall {
	if (block.type === "text") {
		return { type: "text", text: block.text } satisfies TextContent;
	}
	return toolCallFromCursorBlock(block.id, block.name, block.input);
}

/**
 * Mutable accumulator that tracks the partial `AssistantMessage` being built
 * from a sequence of `stream_event` wrappers. Produces
 * `AssistantMessageEvent` deltas the TUI can render in real time.
 */
export class PartialMessageBuilder {
	private partial: AssistantMessage;
	/** Map from stream-event index to our `content[]` index. */
	private indexMap = new Map<number, number>();
	/** Accumulated JSON input string per tool_use block (keyed by stream index). */
	private toolJsonAccum = new Map<number, string>();

	constructor(model: string) {
		this.partial = {
			role: "assistant",
			content: [],
			api: "cursor-stream-json",
			provider: "cursor-agent",
			model,
			usage: { ...ZERO_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	get message(): AssistantMessage {
		return this.partial;
	}

	/**
	 * Feed a Cursor inner `stream_event.event` payload (Anthropic-style
	 * `content_block_start` / `content_block_delta` / `content_block_stop`)
	 * and return the corresponding GSD event (or null if the event is
	 * unmapped). Cursor mirrors the Anthropic Messages stream wire format
	 * inside its `--stream-partial-output` events.
	 */
	handleStreamEvent(event: {
		type: string;
		index?: number;
		content_block?: { type: string; id?: string; name?: string; text?: string };
		delta?: {
			type?: string;
			text?: string;
			partial_json?: string;
		};
	}): AssistantMessageEvent | null {
		const streamIndex = event.index ?? 0;

		switch (event.type) {
			case "content_block_start": {
				const block = event.content_block;
				if (!block) return null;
				const contentIndex = this.partial.content.length;
				this.indexMap.set(streamIndex, contentIndex);

				if (block.type === "text") {
					this.partial.content.push({ type: "text", text: "" });
					return { type: "text_start", contentIndex, partial: this.partial };
				}
				if (block.type === "tool_use") {
					this.toolJsonAccum.set(streamIndex, "");
					this.partial.content.push(
						toolCallFromCursorBlock(block.id ?? "", block.name ?? "", {}),
					);
					return { type: "toolcall_start", contentIndex, partial: this.partial };
				}
				return null;
			}

			case "content_block_delta": {
				const contentIndex = this.indexMap.get(streamIndex);
				if (contentIndex === undefined) return null;
				const delta = event.delta;
				if (!delta) return null;

				if (delta.type === "text_delta" && typeof delta.text === "string") {
					const existing = this.partial.content[contentIndex] as TextContent;
					existing.text += delta.text;
					return {
						type: "text_delta",
						contentIndex,
						delta: delta.text,
						partial: this.partial,
					};
				}
				if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
					const accum =
						(this.toolJsonAccum.get(streamIndex) ?? "") + delta.partial_json;
					this.toolJsonAccum.set(streamIndex, accum);
					return {
						type: "toolcall_delta",
						contentIndex,
						delta: delta.partial_json,
						partial: this.partial,
					};
				}
				return null;
			}

			case "content_block_stop": {
				const contentIndex = this.indexMap.get(streamIndex);
				if (contentIndex === undefined) return null;
				const block = this.partial.content[contentIndex];

				if (block.type === "text") {
					return {
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: this.partial,
					};
				}
				if (block.type === "toolCall") {
					const jsonStr = this.toolJsonAccum.get(streamIndex) ?? "{}";
					const jsonForParse = hasXmlParameterTags(jsonStr)
						? repairToolJson(jsonStr)
						: jsonStr;
					try {
						block.arguments = JSON.parse(jsonForParse);
					} catch {
						try {
							block.arguments = JSON.parse(repairToolJson(jsonForParse));
						} catch {
							// Stream was truncated or garbage — preserve the raw
							// string for diagnostics and flag the malformation.
							block.arguments = { _raw: jsonStr };
							return {
								type: "toolcall_end",
								contentIndex,
								toolCall: block,
								partial: this.partial,
								malformedArguments: true,
							};
						}
					}
					return {
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: this.partial,
					};
				}
				return null;
			}

			default:
				return null;
		}
	}
}
