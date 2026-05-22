/**
 * UPSTREAM_REVIEW:C — `@cursor/sdk` driven streamSimple pump.
 *
 * Wraps the SDK's `Agent.create` → `agent.send` → `run.stream()` path and
 * translates each `SDKMessage` into a `CursorStreamEvent` so the shared
 * `mapCursorEvent` (from `stream-translation.ts`) can reuse the same
 * mapping table the CLI pump uses. Token usage is not on the SDK `Run`
 * interface — `run.wait()`'s `RunResult` carries no usage block, nor does
 * any `SDKMessage` in the run stream. It arrives only via the `turn-ended`
 * interaction update on `send`'s `onDelta` callback, which this pump
 * captures and threads into the synthesised terminal `result` event so the
 * context meter and compaction see real numbers (parity with the CLI path).
 *
 * Compliance posture (§"Compliance & Data Handling"): `@cursor/sdk` v1.0.13
 * does NOT auto-read `process.env.CURSOR_API_KEY` — verified 2026-05-20 via
 * live smoke: omitting `apiKey` lets `Agent.create` resolve, but the run
 * then fails with an `unauthenticated` Connect-RPC rejection thrown from a
 * detached background task. The key is therefore passed to `Agent.create`
 * as the inline `process.env.CURSOR_API_KEY` argument expression — never
 * assigned to a named variable, never logged, never persisted — so it is
 * not retained in our address space beyond the call, and `redactSecrets`
 * still covers every error string we emit.
 *
 * Cursor harness passthrough: GSD does not *programmatically* register MCP
 * servers, Skills, Hooks, or Subagents via the SDK's `Agent.create` options.
 * It passes `settingSources: ["project"]` so the slice picks up the
 * workspace's on-disk rules (`.cursor/rules`, `AGENTS.md`). The `"user"`
 * layer is intentionally NOT requested — it triggers a cross-tool
 * agent-skill scan that loads hundreds of unrelated plugin-cache files.
 * The slice runs *inside* the Cursor harness — GSD is a passthrough, not a
 * re-implementation.
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
	CursorAssistantEvent,
	CursorContentBlock,
	CursorResultEvent,
	CursorStreamEvent,
	CursorToolCallEvent,
	CursorUsage,
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
import { installSdkRejectionGuard } from "./sdk-runtime.js";
// UPSTREAM_REVIEW:C — fences @cursor/sdk's in-process `console.*` output so
// its settings-loader INFO lines don't overprint the interactive TUI.
import { enterSdkConsoleScope, exitSdkConsoleScope } from "./sdk-console-guard.js";
import { buildPromptFromContext } from "./stream-adapter.js";
import { makeErrorMessage, makeInitialState, mapCursorEvent } from "./stream-translation.js";
// UPSTREAM_REVIEW:C — opt-in usage tracer (`GSD_CURSOR_USAGE_LOG`) for the
// CLI-vs-SDK token-accounting investigation.
import { traceUsage } from "./usage-trace.js";

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
	// UPSTREAM_REVIEW:C — install once: absorb @cursor/sdk's detached
	// background rejections (e.g. an `unauthenticated` ConnectError from a
	// present-but-invalid CURSOR_API_KEY) before they reach the host's
	// process-exiting crash guard. See `installSdkRejectionGuard`.
	installSdkRejectionGuard();
	// UPSTREAM_REVIEW:C — fence @cursor/sdk's in-process `console.*` output
	// for the duration of this pump so its settings-loader INFO lines don't
	// overprint the TUI. Balanced by `exitSdkConsoleScope()` in the `finally`.
	enterSdkConsoleScope();
	const state = makeInitialState(model.id);
	// UPSTREAM_REVIEW:C — running total for the SDK's incremental assistant
	// text deltas (see `accumulateSdkAssistantText`).
	const assistantAcc = { text: "" };
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
		// UPSTREAM_REVIEW:C — `settingSources` MUST be passed. With it unset,
		// the SDK's setting resolver (`NV`/`DV`, verified against
		// @cursor/sdk@1.0.13) turns every Cursor settings layer OFF, so the
		// slice silently ignores the project's `.cursor/rules` + `AGENTS.md`.
		// Only `"project"` is requested: it loads the workspace rules the
		// slice actually needs. `"user"` is deliberately excluded — it makes
		// the SDK's `AgentSkillsCursorRulesService` scan cross-tool agent-skill
		// dirs (`~/.claude`, `~/.codex`, `~/.cursor`), which on a developer
		// machine pulls in hundreds of plugin-cache `SKILL.md` files (~857
		// observed) and balloons the prompt. `team` / `mdm` / `plugins` are
		// excluded for the same reason.
		const settingSources: string[] = ["project"];
		// UPSTREAM_REVIEW:C — `apiKey` MUST be passed explicitly: @cursor/sdk
		// v1.0.13 does not fall back to process.env.CURSOR_API_KEY on its own.
		// Passed inline (never bound to a named variable) so the credential is
		// not retained in our address space beyond this call.
		agent = await sdk.Agent.create({
			apiKey: process.env.CURSOR_API_KEY,
			model: { id: model.id },
			local: { cwd, settingSources },
		});
		// UPSTREAM_REVIEW:C — usage trace: record the configured setting
		// sources so a trace shows exactly how the SDK agent was set up.
		traceUsage({ path: "sdk", event: "start", model: model.id, cwd, settingSources });

		// UPSTREAM_REVIEW:C — holds the most recent `turn-ended` usage block.
		// The SDK fires `onDelta` once per turn as the run streams; keeping the
		// LAST block means `inputTokens` reflects the final, largest context
		// size — the closest analogue to the CLI `result` event's single
		// aggregate usage block, and the value `calculateContextTokens` needs
		// so the context meter and compaction work on the SDK path.
		let capturedUsage: CursorUsage | undefined;
		// UPSTREAM_REVIEW:C — turn counter: distinguishes a genuine one-turn
		// run from a multi-turn one, and feeds the opt-in usage trace.
		let turnCount = 0;

		const prompt = buildPromptFromContext(context);
		run = await agent.send(prompt, {
			onDelta: ({ update }) => {
				if (update.type !== "turn-ended") return;
				turnCount += 1;
				const turnUsage = "usage" in update ? update.usage : undefined;
				if (turnUsage) capturedUsage = turnUsage;
				// UPSTREAM_REVIEW:C — usage trace: one line per turn so a
				// multi-turn run is visible field-by-field (input vs cache).
				traceUsage({
					path: "sdk",
					event: "turn-ended",
					index: turnCount,
					usage: turnUsage ?? null,
				});
			},
		});

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
			for (const rawEvent of translateSdkMessage(msg)) {
				const cursorEvent = accumulateSdkAssistantText(rawEvent, assistantAcc);
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
			// UPSTREAM_REVIEW:C — usage trace: the final captured block plus
			// the turn count, so a low reading caused by "no turn-ended ever
			// fired" is distinguishable from a genuine low-context turn.
			traceUsage({
				path: "sdk",
				event: "final",
				usage: capturedUsage ?? null,
				turns: turnCount,
				runStatus: result.status,
			});
			const synthesised = synthesiseResultEvent(
				result,
				state.sessionId ?? agent.agentId,
				capturedUsage,
			);
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
		// UPSTREAM_REVIEW:C — balances `enterSdkConsoleScope()`. Placed after
		// `agent.close()` so any console output from teardown is fenced too.
		exitSdkConsoleScope();
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

// UPSTREAM_REVIEW:C
/**
 * Rewrite a translated `assistant` event so its text block holds the running
 * cumulative total rather than just the latest delta.
 *
 * `@cursor/sdk` emits `assistant` messages as incremental text deltas (e.g.
 * `"P"` then `"ONG"`), but the shared `mapCursorEvent` / `ingestAssistantBlock`
 * expects cumulative snapshots — that is the CLI wire shape, where every
 * `assistant` event carries the full text so far. `ingestAssistantBlock` does
 * a snapshot *replace*, so without this a multi-delta reply keeps only the
 * last delta and silently drops every earlier chunk.
 *
 * `acc` is the per-pump accumulator. Non-`assistant` events pass through
 * untouched. Non-text content blocks (none observed in SDK `assistant`
 * messages today — tool calls arrive as separate `tool_call` messages) are
 * preserved ahead of the accumulated text.
 */
export function accumulateSdkAssistantText(
	event: CursorStreamEvent,
	acc: { text: string },
): CursorStreamEvent {
	if (event.type !== "assistant") return event;
	const asst = event as CursorAssistantEvent;

	let delta = "";
	const passthrough: CursorContentBlock[] = [];
	for (const block of asst.message.content) {
		if (block.type === "text") delta += block.text;
		else passthrough.push(block);
	}
	if (delta === "") return event;

	acc.text += delta;
	const content: CursorContentBlock[] = [...passthrough, { type: "text", text: acc.text }];
	return { ...asst, message: { ...asst.message, content } };
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
	usage?: CursorUsage,
): CursorResultEvent {
	const isError = result.status !== "finished";
	const subtype: "success" | "error" = isError ? "error" : "success";
	return {
		type: "result",
		subtype,
		session_id: sessionId,
		result: result.result ?? "",
		// UPSTREAM_REVIEW:C — real per-turn usage when the SDK delivered a
		// `turn-ended` block; `{}` (→ ZERO_USAGE via mapUsage) only when it
		// never did, which keeps behaviour graceful on older SDK builds.
		usage: usage ?? {},
		duration_ms: result.durationMs ?? 0,
		is_error: isError,
	};
}
