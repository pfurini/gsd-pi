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

/**
 * Usage block emitted on the terminal `result` event.
 *
 * Field-name drift: the published docs describe `input_tokens` /
 * `output_tokens`, but the binary as of 2026.05 emits camelCase
 * `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`.
 * Both shapes are accepted at read time (see `partial-builder#mapUsage`)
 * so older fixtures and the documented schema keep working — fixture
 * `01-hello-text` is the live witness for the camelCase shape.
 */
export interface CursorUsage {
	// Documented (snake_case) shape — kept for forward compat.
	input_tokens?: number;
	output_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	// Live wire (camelCase) shape — observed in real captures.
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
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

/**
 * Tool call event emitted by the CLI.
 *
 * Wire-format drift (fixture-derived; see plan
 * `.plans/cursor-cli-01-ndjson-fixtures.md`): the documented schema named a
 * flat shape with `tool_call_id`, `name`, `input`, but the binary emits a
 * polymorphic container where the tool name is the object key inside
 * `tool_call.<X>ToolCall` and args/result hang underneath:
 *
 *   {
 *     type: "tool_call",
 *     subtype: "started" | "completed",
 *     call_id: "tool_<uuid>",
 *     tool_call: {
 *       readToolCall: {            // ← key is the tool name (camelCase)
 *         args: { path: "…" },
 *         result?: {               // present only on subtype:"completed"
 *           success?: { content: "…", … }
 *           error?:   { … }
 *         }
 *       }
 *     },
 *     model_call_id: "…"
 *   }
 *
 * The CLI does NOT emit a separate `tool_result` event; the result is
 * folded into the `subtype:"completed"` payload. We retain
 * `CursorToolResultEvent` for forward compatibility with the documented
 * schema but the live mapping prefers the embedded result.
 */
export interface CursorToolCallEvent {
	type: "tool_call";
	subtype?: "started" | "completed";
	call_id?: string;
	/** Documented (pre-2026.05) alias for `call_id` — kept for back-compat. */
	tool_call_id?: string;
	tool_call?: Record<string, {
		args?: unknown;
		result?: {
			success?: Record<string, unknown>;
			error?: Record<string, unknown>;
		};
	}>;
	/** Documented (pre-2026.05) flat fields — kept for back-compat. */
	name?: string;
	input?: unknown;
	model_call_id?: string;
	session_id?: string;
	uuid?: CursorUUID;
}

/**
 * Result of a tool call executed inside the Cursor harness.
 *
 * **Note:** as of `cursor-agent 2026.05`, this event is NOT emitted in
 * `-p --output-format stream-json` mode — results are folded into the
 * `tool_call` `subtype:"completed"` payload. This interface remains
 * defined so the union is forward-compatible with older binaries and
 * any future re-introduction of standalone result events.
 */
export interface CursorToolResultEvent {
	type: "tool_result";
	uuid: CursorUUID;
	session_id: string;
	tool_call_id: string;
	output: unknown;
	is_error: boolean;
}

/**
 * Thinking event emitted by the CLI even in `-p` mode.
 *
 * Wire-format drift (fixture-derived): the docs claim thinking is
 * suppressed in print mode; in practice the binary emits a stream of
 * `subtype:"delta"` events followed by a single `subtype:"completed"`.
 * GSD's `-p` rendering does not surface assistant thinking, so the
 * mapper consumes these silently.
 */
export interface CursorThinkingEvent {
	type: "thinking";
	subtype: "delta" | "completed";
	text?: string;
	session_id?: string;
}

/**
 * Echo of the user prompt emitted at turn start.
 *
 * Wire-format drift (fixture-derived): not documented; the CLI mirrors
 * the prompt as a `type:"user"` event. The mapper consumes it silently —
 * GSD already has the prompt in its own context.
 */
export interface CursorUserEvent {
	type: "user";
	message?: {
		role: "user";
		content?: unknown;
	};
	session_id?: string;
}

/** Terminal event — emits usage block and either a `success` result or error subtype. */
export interface CursorResultEvent {
	type: "result";
	subtype: "success" | "error";
	session_id: string;
	result: string;
	usage: CursorUsage;
	duration_ms: number;
	/** Live wire (fixture-derived): present alongside `duration_ms`. */
	duration_api_ms?: number;
	/** Live wire (fixture-derived): per-request id, separate from session_id. */
	request_id?: string;
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
	| CursorThinkingEvent
	| CursorUserEvent
	| CursorErrorEvent
	| CursorUnknownEvent;

// ─── @cursor/sdk local type mirrors ──────────────────────────────────────

// UPSTREAM_REVIEW:C — local structural mirrors of the @cursor/sdk public
// types. Hard-importing `@cursor/sdk` at typecheck time would force the
// package to be installed in `node_modules` (it isn't, by design — see
// path-selector.ts for the dynamic-import pattern). Verified against
// @cursor/sdk@1.0.13 (verified 2026-05-19 — see sdk-runtime.ts header for
// the live API shape).

/** Structural mirror of `@cursor/sdk#TextBlock`. */
export interface SdkTextBlock {
	type: "text";
	text: string;
}

/** Structural mirror of `@cursor/sdk#ToolUseBlock`. */
export interface SdkToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

/** Structural mirror of `@cursor/sdk#SDKSystemMessage`. */
export interface SdkSystemMessage {
	type: "system";
	subtype?: "init";
	agent_id: string;
	run_id: string;
	model?: { id: string };
	tools?: string[];
}

/** Structural mirror of `@cursor/sdk#SDKAssistantMessage`. */
export interface SdkAssistantMessage {
	type: "assistant";
	agent_id: string;
	run_id: string;
	message: {
		role: "assistant";
		content: Array<SdkTextBlock | SdkToolUseBlock>;
	};
}

/** Structural mirror of `@cursor/sdk#SDKUserMessageEvent`. */
export interface SdkUserMessage {
	type: "user";
	agent_id: string;
	run_id: string;
	message: {
		role: "user";
		content: SdkTextBlock[];
	};
}

/** Structural mirror of `@cursor/sdk#SDKToolUseMessage`. */
export interface SdkToolUseMessage {
	type: "tool_call";
	agent_id: string;
	run_id: string;
	call_id: string;
	name: string;
	status: "running" | "completed" | "error";
	args?: unknown;
	result?: unknown;
	truncated?: { args?: boolean; result?: boolean };
}

/** Structural mirror of `@cursor/sdk#SDKThinkingMessage`. */
export interface SdkThinkingMessage {
	type: "thinking";
	agent_id: string;
	run_id: string;
	text: string;
	thinking_duration_ms?: number;
}

/** Structural mirror of `@cursor/sdk#SDKStatusMessage`. */
export interface SdkStatusMessage {
	type: "status";
	agent_id: string;
	run_id: string;
	status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";
	message?: string;
}

/** Structural mirror of `@cursor/sdk#SDKTaskMessage` (consumed silently). */
export interface SdkTaskMessage {
	type: "task";
	agent_id: string;
	run_id: string;
	status?: string;
	text?: string;
}

/** Catch-all for SDK message shapes the adapter does not yet recognise. */
export interface SdkUnknownMessage {
	type: string;
	[key: string]: unknown;
}

export type SdkMessage =
	| SdkSystemMessage
	| SdkAssistantMessage
	| SdkUserMessage
	| SdkToolUseMessage
	| SdkThinkingMessage
	| SdkStatusMessage
	| SdkTaskMessage
	| SdkUnknownMessage;

// UPSTREAM_REVIEW:C — `@cursor/sdk` exposes per-turn token usage ONLY through
// the `turn-ended` interaction update delivered to `send`'s `onDelta`
// callback. `RunResult` (from `run.wait()`) has no usage block, and neither
// does any `SDKMessage` in the run stream — verified against @cursor/sdk@1.0.13
// (`run.d.ts` / `messages.d.ts`). This is the SDK path's sole usage surface.

/**
 * Structural mirror of `@cursor/sdk#TurnEndedUpdate`.
 *
 * The `usage` field names match `CursorUsage`'s camelCase shape exactly, so a
 * captured block flows straight through `mapUsage` with no remapping. `usage`
 * is optional because the SDK schema marks it so — the adapter falls back to
 * zero usage when a turn ends without one.
 */
export interface SdkTurnEndedUpdate {
	type: "turn-ended";
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
}

/**
 * Structural mirror of `@cursor/sdk#InteractionUpdate`. Only `turn-ended` is
 * modelled by name — the adapter ignores every other variant — so the union
 * is that one shape widened with a `{ type }` catch-all.
 */
export type SdkInteractionUpdate = SdkTurnEndedUpdate | { type: string };

/**
 * Minimal mirror of `@cursor/sdk#SendOptions` — only `onDelta`, the surface
 * the adapter uses to capture per-turn token usage.
 */
export interface SdkSendOptions {
	onDelta?: (args: { update: SdkInteractionUpdate }) => void;
}

/** Structural mirror of the `RunResult` shape from `@cursor/sdk#Run.wait()`. */
export interface SdkRunResult {
	id: string;
	status: "finished" | "error" | "cancelled";
	result?: string;
	model?: { id: string };
	durationMs?: number;
}

/** Minimal mirror of `@cursor/sdk#Run` — only the surface the adapter uses. */
export interface SdkRun {
	readonly id: string;
	readonly agentId: string;
	stream(): AsyncGenerator<SdkMessage, void>;
	wait(): Promise<SdkRunResult>;
	cancel(): Promise<void>;
}

/** Minimal mirror of `@cursor/sdk#SDKAgent`. */
export interface SdkAgent {
	readonly agentId: string;
	// UPSTREAM_REVIEW:C — `options` typed as `SdkSendOptions` so the adapter
	// can pass `onDelta` and capture `turn-ended` usage (see SdkTurnEndedUpdate).
	send(message: string | { text: string }, options?: SdkSendOptions): Promise<SdkRun>;
	close(): void;
}

/** Minimal mirror of `@cursor/sdk#AgentOptions`. */
export interface SdkAgentCreateOptions {
	model?: { id: string };
	apiKey?: string;
	local?: { cwd?: string | string[]; settingSources?: string[] };
	mcpServers?: Record<string, unknown>;
	idempotencyKey?: string;
}

/** Minimal mirror of the `Agent` namespace from the SDK. */
export interface SdkAgentNamespace {
	create(options: SdkAgentCreateOptions): Promise<SdkAgent>;
}

/** The exported shape of `@cursor/sdk` that the path selector hands the adapter. */
export interface SdkModule {
	Agent: SdkAgentNamespace;
	[key: string]: unknown;
}
