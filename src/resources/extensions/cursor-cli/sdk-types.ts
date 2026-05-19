/**
 * Type mirrors for the Cursor CLI `--output-format stream-json` event union
 * and (Phase 2) a forward-compatible sketch of the `@cursor/sdk` message
 * shapes. These stubs let the extension compile without taking a hard
 * dependency on `@cursor/sdk` — the SDK is imported dynamically in Phase 2.
 *
 * Schema verified against Cursor's CLI documentation
 * (https://cursor.com/docs/cli/reference/output-format). `thinking` is
 * intentionally absent from the assistant content union because Cursor
 * suppresses thinking events in `-p` (print) mode.
 */

// ─── Common ──────────────────────────────────────────────────────────────

/** Branded UUID returned by the CLI for every event with an identity. */
export type CursorUUID = string;

/** Usage block emitted on the terminal `result` event. */
export interface CursorUsage {
	input_tokens: number;
	output_tokens: number;
}

// ─── Assistant content blocks ────────────────────────────────────────────

export interface CursorTextBlock {
	type: "text";
	text: string;
}

export interface CursorToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

export type CursorContentBlock = CursorTextBlock | CursorToolUseBlock;

// ─── Stream events ───────────────────────────────────────────────────────

/** First event emitted on every run — session, model, and cwd metadata. */
export interface CursorSystemInitEvent {
	type: "system";
	subtype: "init";
	session_id: string;
	model: string;
	cwd: string;
	tools?: string[];
}

/** Complete assistant turn (non-streaming or end-of-turn flush). */
export interface CursorAssistantEvent {
	type: "assistant";
	uuid: CursorUUID;
	session_id: string;
	message: {
		role: "assistant";
		content: CursorContentBlock[];
	};
}

/** Standalone tool call emitted when the CLI streams partial output. */
export interface CursorToolCallEvent {
	type: "tool_call";
	uuid: CursorUUID;
	session_id: string;
	tool_call_id: string;
	name: string;
	input: unknown;
}

/** Result of a tool call executed inside the Cursor harness. */
export interface CursorToolResultEvent {
	type: "tool_result";
	uuid: CursorUUID;
	session_id: string;
	tool_call_id: string;
	output: unknown;
	is_error: boolean;
}

/** Terminal event — emits usage block and either a `success` result or error subtype. */
export interface CursorResultEvent {
	type: "result";
	subtype: "success" | "error";
	session_id: string;
	result: string;
	usage: CursorUsage;
	duration_ms: number;
	is_error: boolean;
}

/** Incremental stream event when `--stream-partial-output` is on. */
export interface CursorStreamPartialEvent {
	type: "stream_event";
	uuid: CursorUUID;
	session_id: string;
	event: {
		type: string;
		delta?: unknown;
	};
}

/** Non-terminal error notification from the CLI. */
export interface CursorErrorEvent {
	type: "error";
	message: string;
	session_id?: string;
}

/** Catch-all for unknown event types so the parser can warn-and-skip. */
export interface CursorUnknownEvent {
	type: string;
	[key: string]: unknown;
}

export type CursorStreamEvent =
	| CursorSystemInitEvent
	| CursorAssistantEvent
	| CursorToolCallEvent
	| CursorToolResultEvent
	| CursorResultEvent
	| CursorStreamPartialEvent
	| CursorErrorEvent
	| CursorUnknownEvent;
