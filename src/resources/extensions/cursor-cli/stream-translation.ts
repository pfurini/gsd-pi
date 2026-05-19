/**
 * Shared event translation primitives for the Cursor CLI and (Phase 2) SDK
 * paths.
 *
 * Extracted from `stream-adapter.ts` so the CLI subprocess pump and the
 * `@cursor/sdk` adapter can converge on a single mapping function. The
 * adapters differ in how they obtain the wire-level event stream — child
 * process NDJSON vs an in-process async generator — but the translation from
 * `CursorStreamEvent` to `AssistantMessageEvent` is the same.
 *
 * Per the compliance posture (§"Compliance & Data Handling"): every log line
 * and error string emitted here is wrapped in `redactSecrets()`.
 */

// UPSTREAM_REVIEW:C — shared translation pulled out of stream-adapter.ts so
// the SDK adapter can reuse it without forking. CLI behaviour is unchanged.
import type {
	AssistantMessage,
	AssistantMessageEvent,
	ToolCall,
} from "@gsd/pi-ai";
import { PartialMessageBuilder, ZERO_USAGE, mapUsage, mapStopReason, toolCallFromCursorBlock } from "./partial-builder.js";
// UPSTREAM_REVIEW:A — error classifier used to promote cursor quota errors
// into a structured marker the GSD retry handler can consume.
import { classifyCursorError, formatCursorErrorMessage } from "./quota-detect.js";
import { redactSecrets } from "./redact.js";
import type {
	CursorAssistantEvent,
	CursorContentBlock,
	CursorResultEvent,
	CursorStreamEvent,
	CursorToolCallEvent,
	CursorToolResultEvent,
} from "./sdk-types.js";

// ─── Shared types ────────────────────────────────────────────────────────

// UPSTREAM_REVIEW:C
/** Content block returned by an external (Cursor-executed) tool call. */
export interface ExternalToolResultContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

// UPSTREAM_REVIEW:C
/** Full result payload from an external tool, plus error status. */
export interface ExternalToolResultPayload {
	content: ExternalToolResultContentBlock[];
	details?: Record<string, unknown>;
	isError: boolean;
}

// UPSTREAM_REVIEW:C
/** A `ToolCall` augmented with the result attached by Cursor's `tool_result` event. */
export type ToolCallWithExternalResult = ToolCall & {
	externalResult?: ExternalToolResultPayload;
};

// UPSTREAM_REVIEW:C
export interface StreamState {
	model: string;
	builder: PartialMessageBuilder | null;
	sessionId: string | null;
	lastTextContent: string;
	intermediateToolBlocks: AssistantMessage["content"];
	toolResultsById: Map<string, ExternalToolResultPayload>;
}

// UPSTREAM_REVIEW:C
export function makeInitialState(model: string): StreamState {
	return {
		model,
		builder: null,
		sessionId: null,
		lastTextContent: "",
		intermediateToolBlocks: [],
		toolResultsById: new Map(),
	};
}

// UPSTREAM_REVIEW:C — minimal debug helper local to the translation module so
// stream-translation doesn't depend on stream-adapter's CLI debug log.
function debugLog(...parts: unknown[]): void {
	if (process.env.GSD_CURSOR_DEBUG) {
		const message = parts
			.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
			.join(" ");
		process.stderr.write(`[cursor-stream] ${redactSecrets(message)}\n`);
	}
}

// ─── Error message factory ────────────────────────────────────────────────

// UPSTREAM_REVIEW:C — moved here so `mapCursorEvent`'s "error" branch can
// construct an AssistantMessage without depending on stream-adapter.
export function makeErrorMessage(model: string, errorMsg: string): AssistantMessage {
	const redacted = redactSecrets(errorMsg);
	return {
		role: "assistant",
		content: [{ type: "text", text: `Cursor error: ${redacted}` }],
		api: "cursor-stream-json",
		provider: "cursor-agent",
		model,
		usage: { ...ZERO_USAGE },
		stopReason: "error",
		errorMessage: redacted,
		timestamp: Date.now(),
	};
}

// ─── Tool result normalisation ────────────────────────────────────────────

// UPSTREAM_REVIEW:C
/**
 * Normalise the `output` field of a Cursor `tool_result` event into the
 * `ExternalToolResultContentBlock[]` shape GSD expects.
 */
export function normalizeToolResultOutput(output: unknown): ExternalToolResultContentBlock[] {
	if (output == null) return [];

	if (typeof output === "string") {
		return [{ type: "text", text: output }];
	}

	if (Array.isArray(output)) {
		const blocks: ExternalToolResultContentBlock[] = [];
		for (const item of output) {
			if (!item || typeof item !== "object") continue;
			const obj = item as Record<string, unknown>;
			const type = typeof obj.type === "string" ? obj.type : "text";
			if (type === "text" && typeof obj.text === "string") {
				blocks.push({ type: "text", text: obj.text });
				continue;
			}
			if (type === "image" && typeof obj.data === "string") {
				blocks.push({
					type: "image",
					data: obj.data,
					mimeType: typeof obj.mimeType === "string" ? obj.mimeType : undefined,
				});
				continue;
			}
			// Unknown sub-block — fall through to stringified text.
			blocks.push({ type: "text", text: safeStringify(item) });
		}
		return blocks;
	}

	if (typeof output === "object") {
		return [{ type: "text", text: safeStringify(output) }];
	}

	return [{ type: "text", text: String(output) }];
}

// UPSTREAM_REVIEW:C
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

// ─── Event mapping ────────────────────────────────────────────────────────

// UPSTREAM_REVIEW:C
/**
 * Translate a single `CursorStreamEvent` into a sequence of
 * `AssistantMessageEvent`s, mutating `state` as side effects.
 *
 * Returns the events the caller should push onto the GSD stream and, for
 * the terminal `result` event, the final `AssistantMessage` to emit.
 *
 * Exported for unit-testing the mapping table against captured fixtures.
 */
export function mapCursorEvent(
	event: CursorStreamEvent,
	state: StreamState,
): {
	events: AssistantMessageEvent[];
	final?:
		| { kind: "done"; message: AssistantMessage }
		| { kind: "error"; message: AssistantMessage };
} {
	const events: AssistantMessageEvent[] = [];

	switch (event.type) {
		case "system": {
			const init = event as { subtype?: string; session_id?: string };
			if (init.subtype === "init" && typeof init.session_id === "string") {
				state.sessionId = init.session_id;
			}
			return { events };
		}

		case "assistant": {
			const asst = event as CursorAssistantEvent;
			for (const block of asst.message.content) {
				ingestAssistantBlock(block, state);
			}
			return { events };
		}

		case "tool_call": {
			const call = event as CursorToolCallEvent;
			const extracted = extractToolCallFields(call);
			if (!extracted.id) return { events };

			if (call.subtype === "completed") {
				upsertToolCallBlock(state.intermediateToolBlocks, extracted);
				if (extracted.result) {
					state.toolResultsById.set(extracted.id, extracted.result);
					attachExternalResultsToToolBlocks(
						state.intermediateToolBlocks,
						state.toolResultsById,
					);
				}
				return { events };
			}

			upsertToolCallBlock(state.intermediateToolBlocks, extracted);
			return { events };
		}

		case "tool_result": {
			const result = event as CursorToolResultEvent;
			const payload: ExternalToolResultPayload = {
				content: normalizeToolResultOutput(result.output),
				isError: Boolean(result.is_error),
			};
			state.toolResultsById.set(result.tool_call_id, payload);
			attachExternalResultsToToolBlocks(state.intermediateToolBlocks, state.toolResultsById);
			return { events };
		}

		case "thinking":
		case "user": {
			return { events };
		}

		case "stream_event": {
			if (!state.builder) {
				state.builder = new PartialMessageBuilder(state.model);
				events.push({ type: "start", partial: state.builder.message });
			}
			const inner = (event as { event?: { type: string } }).event;
			if (inner) {
				const emitted = state.builder.handleStreamEvent(inner as Parameters<PartialMessageBuilder["handleStreamEvent"]>[0]);
				if (emitted) events.push(emitted);
			}
			return { events };
		}

		case "result": {
			const result = event as CursorResultEvent;
			const finalContent = buildFinalAssistantContent({
				intermediateToolBlocks: state.intermediateToolBlocks,
				pendingContent: state.builder?.message.content,
				toolResultsById: state.toolResultsById,
				lastTextContent: state.lastTextContent,
				fallbackResultText: result.result || undefined,
			});

			const finalMessage: AssistantMessage = {
				role: "assistant",
				content: finalContent,
				api: "cursor-stream-json",
				provider: "cursor-agent",
				model: state.model,
				usage: mapUsage(result.usage ?? {}),
				stopReason: mapStopReason(result.subtype, result.is_error),
				timestamp: Date.now(),
			};
			if (result.is_error) {
				// UPSTREAM_REVIEW:A — classify Cursor's terminal error string and
				// prepend a stable code so the existing pi-coding-agent retry
				// handler can route quota errors through FallbackResolver.
				const classification = classifyCursorError(result.result, result.subtype);
				const redactedDetail = redactSecrets(result.result || result.subtype);
				finalMessage.errorMessage = formatCursorErrorMessage(classification, redactedDetail);
				return { events, final: { kind: "error", message: finalMessage } };
			}
			return { events, final: { kind: "done", message: finalMessage } };
		}

		case "error": {
			const err = event as { message?: string };
			const errorMessage = makeErrorMessage(state.model, err.message ?? "cursor_unknown_error");
			return { events, final: { kind: "error", message: errorMessage } };
		}

		default: {
			debugLog("unknown event type, skipping:", (event as { type?: string }).type);
			return { events };
		}
	}
}

// UPSTREAM_REVIEW:C
/**
 * Extracted, normalised view of a `tool_call` event regardless of which wire
 * shape (documented flat vs fixture-derived nested) the binary used.
 */
export interface ExtractedToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: ExternalToolResultPayload;
}

// UPSTREAM_REVIEW:C
/**
 * Normalise a Cursor `tool_call` event into `{id, name, args, result?}`.
 */
export function extractToolCallFields(event: CursorToolCallEvent): ExtractedToolCall {
	const id = event.call_id ?? event.tool_call_id ?? "";
	let name = typeof event.name === "string" ? event.name : "";
	let args: Record<string, unknown> = {};
	let result: ExternalToolResultPayload | undefined;

	if (event.input && typeof event.input === "object" && !Array.isArray(event.input)) {
		args = event.input as Record<string, unknown>;
	}

	if (event.tool_call && typeof event.tool_call === "object") {
		for (const [key, payload] of Object.entries(event.tool_call)) {
			if (!payload || typeof payload !== "object") continue;
			if (!name) name = toolNameFromContainerKey(key);
			const inner = payload as { args?: unknown; result?: { success?: Record<string, unknown>; error?: Record<string, unknown> } };
			if (inner.args && typeof inner.args === "object" && !Array.isArray(inner.args)) {
				args = inner.args as Record<string, unknown>;
			}
			if (inner.result) {
				result = normaliseEmbeddedToolResult(inner.result);
			}
			break;
		}
	}

	return { id, name, args, result };
}

// UPSTREAM_REVIEW:C
function toolNameFromContainerKey(key: string): string {
	const stripped = key.endsWith("ToolCall") ? key.slice(0, -"ToolCall".length) : key;
	if (stripped.length === 0) return key;
	return stripped;
}

// UPSTREAM_REVIEW:C
function normaliseEmbeddedToolResult(result: {
	success?: Record<string, unknown>;
	error?: Record<string, unknown>;
}): ExternalToolResultPayload {
	if (result.error) {
		return {
			content: normalizeToolResultOutput(result.error),
			isError: true,
		};
	}
	const success = result.success ?? {};
	if (typeof success.content === "string") {
		return {
			content: [{ type: "text", text: success.content }],
			isError: false,
			details: success,
		};
	}
	return {
		content: normalizeToolResultOutput(success),
		isError: false,
		details: success,
	};
}

// UPSTREAM_REVIEW:C
function upsertToolCallBlock(
	intermediate: AssistantMessage["content"],
	extracted: ExtractedToolCall,
): void {
	for (const block of intermediate) {
		if (block.type === "toolCall" && block.id === extracted.id) {
			if (extracted.name) block.name = extracted.name;
			if (extracted.args && Object.keys(extracted.args).length > 0) {
				block.arguments = extracted.args;
			}
			return;
		}
	}
	intermediate.push(toolCallFromCursorBlock(extracted.id, extracted.name, extracted.args));
}

// UPSTREAM_REVIEW:C
function ingestAssistantBlock(block: CursorContentBlock, state: StreamState): void {
	if (block.type === "text") {
		if (block.text) state.lastTextContent = block.text;
		return;
	}
	const toolCall = toolCallFromCursorBlock(block.id, block.name, block.input);
	state.intermediateToolBlocks.push(toolCall);
}

// UPSTREAM_REVIEW:C
export function attachExternalResultsToToolBlocks(
	toolBlocks: AssistantMessage["content"],
	toolResultsById: ReadonlyMap<string, ExternalToolResultPayload>,
): void {
	for (const block of toolBlocks) {
		if (block.type !== "toolCall") continue;
		const externalResult = toolResultsById.get(block.id);
		if (!externalResult) continue;
		(block as ToolCallWithExternalResult).externalResult = externalResult;
	}
}

// UPSTREAM_REVIEW:C
/**
 * Build the final assistant content that Agent Core consumes in
 * `externalToolExecution` mode. Preserves tool-call blocks, attaches their
 * external results, and appends final text from the completed turn.
 */
export function buildFinalAssistantContent(params: {
	intermediateToolBlocks: AssistantMessage["content"];
	pendingContent?: AssistantMessage["content"];
	toolResultsById: ReadonlyMap<string, ExternalToolResultPayload>;
	lastTextContent?: string;
	fallbackResultText?: string;
}): AssistantMessage["content"] {
	const mergedToolBlocks: AssistantMessage["content"] = [...params.intermediateToolBlocks];
	if (params.pendingContent) {
		mergePendingToolCalls(mergedToolBlocks, params.pendingContent);
	}
	attachExternalResultsToToolBlocks(mergedToolBlocks, params.toolResultsById);

	const finalContent: AssistantMessage["content"] = [...mergedToolBlocks];
	if (params.pendingContent && params.pendingContent.length > 0) {
		for (const block of params.pendingContent) {
			if (block.type === "text") finalContent.push(block);
		}
	} else if (params.lastTextContent) {
		finalContent.push({ type: "text", text: params.lastTextContent });
	}

	if (finalContent.length === 0 && params.fallbackResultText) {
		finalContent.push({ type: "text", text: params.fallbackResultText });
	}

	return finalContent;
}

// UPSTREAM_REVIEW:C
/** Merge unique tool-call blocks from `pending` into `intermediate` by id. */
export function mergePendingToolCalls(
	intermediate: AssistantMessage["content"],
	pending: AssistantMessage["content"],
): AssistantMessage["content"] {
	const alreadyIncluded = new Set<string>();
	for (const block of intermediate) {
		if (block.type === "toolCall") alreadyIncluded.add(block.id);
	}
	for (const block of pending) {
		if (block.type !== "toolCall") continue;
		if (alreadyIncluded.has(block.id)) continue;
		alreadyIncluded.add(block.id);
		intermediate.push(block);
	}
	return intermediate;
}
