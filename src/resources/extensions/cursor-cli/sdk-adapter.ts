/**
 * UPSTREAM_REVIEW:C — `@cursor/sdk` driven streamSimple pump.
 *
 * Wraps the SDK's `Agent.create` → `agent.send` → `run.stream()` path and
 * translates each `SDKMessage` into a `CursorStreamEvent` so the shared
 * `mapCursorEvent` (from `stream-translation.ts`) can reuse the same
 * mapping table the CLI pump uses. Token usage is not surfaced by the SDK
 * Run interface today, so the SDK path reports `ZERO_USAGE` on terminal
 * events; the metrics hook in `stream-dispatch.ts` records the call
 * regardless.
 *
 * Compliance posture (§"Compliance & Data Handling"): we never read
 * `CURSOR_API_KEY` into a JS variable. `Agent.create` falls back to
 * `process.env.CURSOR_API_KEY` automatically when `apiKey` is omitted, so
 * the credential never crosses our address space.
 *
 * Cursor harness passthrough: GSD does NOT register MCP servers, Skills,
 * Hooks, or Subagents through the SDK on the user's behalf. Whatever the
 * user has configured locally (`~/.cursor/...`) is what the slice picks
 * up. The slice runs *inside* the Cursor harness — GSD is a passthrough,
 * not a re-implementation.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@gsd/pi-ai";
import { ZERO_USAGE } from "./partial-builder.js";
import { redactSecrets } from "./redact.js";
import type {
	CursorResultEvent,
	CursorStreamEvent,
	CursorToolCallEvent,
	SdkAgent,
	SdkAssistantMessage,
	SdkMessage,
	SdkModule,
	SdkRun,
	SdkStatusMessage,
	SdkSystemMessage,
	SdkThinkingMessage,
	SdkToolUseMessage,
} from "./sdk-types.js";
import { buildPromptFromContext } from "./stream-adapter.js";
import { makeErrorMessage, makeInitialState, mapCursorEvent } from "./stream-translation.js";

// ─── Public pump ──────────────────────────────────────────────────────────

// UPSTREAM_REVIEW:C
export interface SdkPumpOptions extends SimpleStreamOptions {
	allowsWrites?: boolean;
	resumeSessionId?: string;
}

// UPSTREAM_REVIEW:C — internal pump invoked by `stream-dispatch.ts` after
// `pickStreamPath` has resolved an SDK module. Pushes events to the supplied
// stream; never creates its own stream and never records metrics (the
// dispatcher owns both responsibilities).
export async function pumpViaSdk(
	sdk: SdkModule,
	model: Model<Api>,
	context: Context,
	options: SdkPumpOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const state = makeInitialState(model.id);
	let agent: SdkAgent | undefined;
	let run: SdkRun | undefined;

	try {
		// Initial start event so the TUI can wire up renderers symmetrically
		// with the CLI path's behaviour.
		const initialPartial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "cursor-stream-json",
			provider: "cursor-agent",
			model: model.id,
			usage: { ...ZERO_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: initialPartial });

		const cwd = resolveCwd(options);
		// `apiKey` deliberately omitted — Agent.create falls back to
		// process.env.CURSOR_API_KEY without us ever holding the value.
		agent = await sdk.Agent.create({
			model: { id: model.id },
			local: { cwd },
		});

		const prompt = buildPromptFromContext(context);
		run = await agent.send(prompt);

		const onAbort = (): void => {
			if (!run) return;
			try {
				void run.cancel();
			} catch {
				// best effort
			}
		};
		if (options?.signal) {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let resolvedFinal = false;
		for await (const msg of run.stream()) {
			if (options?.signal?.aborted) {
				stream.push({
					type: "error",
					reason: "aborted",
					error: makeAbortedMessage(model.id, state.lastTextContent),
				});
				return;
			}
			for (const cursorEvent of translateSdkMessage(msg)) {
				const { events, final } = mapCursorEvent(cursorEvent, state);
				for (const e of events) stream.push(e);
				if (final) {
					if (final.kind === "done") {
						stream.push({ type: "done", reason: "stop", message: final.message });
					} else {
						stream.push({ type: "error", reason: "error", error: final.message });
					}
					resolvedFinal = true;
					break;
				}
			}
			if (resolvedFinal) break;
		}

		if (!resolvedFinal) {
			if (options?.signal?.aborted) {
				stream.push({
					type: "error",
					reason: "aborted",
					error: makeAbortedMessage(model.id, state.lastTextContent),
				});
				return;
			}
			// SDK stream ended without a synthesised terminal — drain via
			// run.wait() and forge a CursorResultEvent so the shared
			// finalisation path constructs the AssistantMessage.
			const result = await run.wait();
			const synthesised = synthesiseResultEvent(result, state.sessionId ?? agent.agentId);
			const { events, final } = mapCursorEvent(synthesised, state);
			for (const e of events) stream.push(e);
			if (final) {
				if (final.kind === "done") {
					stream.push({ type: "done", reason: "stop", message: final.message });
				} else {
					stream.push({ type: "error", reason: "error", error: final.message });
				}
			} else {
				stream.push({
					type: "error",
					reason: "error",
					error: makeErrorMessage(model.id, "sdk_stream_exhausted_without_result"),
				});
			}
		}
	} catch (err) {
		if (options?.signal?.aborted) {
			stream.push({
				type: "error",
				reason: "aborted",
				error: makeAbortedMessage(model.id, state.lastTextContent),
			});
			return;
		}
		const errorMsg = err instanceof Error ? err.message : String(err);
		stream.push({
			type: "error",
			reason: "error",
			error: makeErrorMessage(model.id, redactSecrets(errorMsg)),
		});
	} finally {
		try {
			agent?.close();
		} catch {
			// best effort cleanup
		}
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// UPSTREAM_REVIEW:C
function resolveCwd(options?: SimpleStreamOptions): string {
	return options?.cwd && options.cwd.trim().length > 0 ? options.cwd : process.cwd();
}

// UPSTREAM_REVIEW:C
function makeAbortedMessage(model: string, lastTextContent: string): AssistantMessage {
	return {
		role: "assistant",
		content: lastTextContent
			? [{ type: "text", text: lastTextContent }]
			: [{ type: "text", text: "Cursor stream aborted by caller" }],
		api: "cursor-stream-json",
		provider: "cursor-agent",
		model,
		usage: { ...ZERO_USAGE },
		stopReason: "aborted",
		timestamp: Date.now(),
	};
}

// UPSTREAM_REVIEW:C
/**
 * Translate a single SDK message into one or more `CursorStreamEvent`s so
 * the shared `mapCursorEvent` table can handle the wire-level fan-out.
 *
 * The SDK and the CLI's `stream-json` output overlap heavily — both inherit
 * from the same internal type union — but the SDK uses flat `args`/`result`
 * fields where the CLI uses a nested `tool_call.<name>ToolCall` container.
 * The most pragmatic translation: synthesise a CLI-shaped event with
 * `input: msg.args`, then emit a separate `tool_result` event when the SDK
 * tool call has resolved with a result payload.
 */
export function translateSdkMessage(msg: SdkMessage): CursorStreamEvent[] {
	switch (msg.type) {
		case "system":
			return [translateSystem(msg as SdkSystemMessage)];
		case "assistant":
			return [translateAssistant(msg as SdkAssistantMessage)];
		case "tool_call":
			return translateToolCall(msg as SdkToolUseMessage);
		case "thinking":
			return [translateThinking(msg as SdkThinkingMessage)];
		case "user":
			return [{ type: "user" }];
		case "status":
			return translateStatus(msg as SdkStatusMessage);
		case "task":
		case "request":
			// Consumed silently — no GSD-visible analogue.
			return [];
		default:
			return [{ type: (msg as { type: string }).type } as CursorStreamEvent];
	}
}

function translateSystem(msg: SdkSystemMessage): CursorStreamEvent {
	const modelId = typeof msg.model === "object" && msg.model ? msg.model.id : "";
	return {
		type: "system",
		subtype: "init",
		session_id: msg.run_id,
		model: modelId,
		cwd: "",
		tools: msg.tools,
	};
}

function translateAssistant(msg: SdkAssistantMessage): CursorStreamEvent {
	return {
		type: "assistant",
		uuid: msg.run_id,
		session_id: msg.run_id,
		message: msg.message,
	};
}

function translateThinking(msg: SdkThinkingMessage): CursorStreamEvent {
	return {
		type: "thinking",
		subtype: "delta",
		text: msg.text,
		session_id: msg.run_id,
	};
}

// UPSTREAM_REVIEW:C
function translateToolCall(msg: SdkToolUseMessage): CursorStreamEvent[] {
	const isCompleted = msg.status === "completed" || msg.status === "error";
	const isError = msg.status === "error";
	const input =
		msg.args && typeof msg.args === "object" && !Array.isArray(msg.args)
			? (msg.args as Record<string, unknown>)
			: {};

	const events: CursorStreamEvent[] = [];
	const call: CursorToolCallEvent = {
		type: "tool_call",
		subtype: isCompleted ? "completed" : "started",
		call_id: msg.call_id,
		name: msg.name,
		input,
		session_id: msg.run_id,
	};
	events.push(call);

	if (isCompleted && msg.result !== undefined && msg.result !== null) {
		events.push({
			type: "tool_result",
			uuid: msg.run_id,
			session_id: msg.run_id,
			tool_call_id: msg.call_id,
			output: msg.result,
			is_error: isError,
		});
	}

	return events;
}

function translateStatus(msg: SdkStatusMessage): CursorStreamEvent[] {
	// Status changes are not directly mapped to a GSD event today — the
	// terminal `run.wait()` synth path is what surfaces FINISHED / ERROR
	// state. Keep the entry point for future extension (e.g. surfacing a
	// "queued" lifecycle event to the TUI).
	if (msg.status === "CANCELLED" || msg.status === "EXPIRED") {
		// Surface as a non-terminal error event; the run.wait() drain will
		// still produce the final AssistantMessage.
		return [{ type: "error", message: msg.message ?? `run ${msg.status.toLowerCase()}`, session_id: msg.run_id }];
	}
	return [];
}

// UPSTREAM_REVIEW:C
function synthesiseResultEvent(
	result: { status: string; result?: string; durationMs?: number },
	sessionId: string,
): CursorResultEvent {
	const isError = result.status !== "finished";
	const subtype: "success" | "error" = isError ? "error" : "success";
	return {
		type: "result",
		subtype,
		session_id: sessionId,
		result: result.result ?? "",
		usage: {},
		duration_ms: result.durationMs ?? 0,
		is_error: isError,
	};
}
