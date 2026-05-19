/**
 * Stream adapter: bridges the `cursor-agent` CLI into GSD's streamSimple
 * contract.
 *
 * The CLI runs the full agentic loop (multi-turn, tool execution) in one
 * spawn. This adapter:
 *   1. Builds the invocation argv (`-p --output-format stream-json …`).
 *   2. Spawns the child via `node:child_process.spawn`.
 *   3. Streams stdout through the NDJSON parser.
 *   4. Translates each `CursorStreamEvent` into one or more
 *      `AssistantMessageEvent`s via {@link mapCursorEvent}.
 *   5. Resolves the final `AssistantMessage` on the terminal `result` event,
 *      preserving externally executed tool-call blocks so Agent Core renders
 *      them without redispatch.
 *
 * Per the compliance posture (§"Compliance & Data Handling"): every log
 * line, error string, and stderr buffer is wrapped in `redactSecrets()`;
 * `CURSOR_API_KEY` is forwarded via the default child env inheritance and
 * never copied into a JS variable.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	ToolCall,
} from "@gsd/pi-ai";
import { EventStream } from "@gsd/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { PartialMessageBuilder, ZERO_USAGE, mapUsage, mapStopReason, toolCallFromCursorBlock } from "./partial-builder.js";
import { parseNdjson } from "./ndjson-parser.js";
import { redactSecrets } from "./redact.js";
import type {
	CursorAssistantEvent,
	CursorContentBlock,
	CursorResultEvent,
	CursorStreamEvent,
	CursorToolCallEvent,
	CursorToolResultEvent,
} from "./sdk-types.js";
import { findWorkingCommand, getCursorCommandCandidates } from "./readiness.js";

// ─── Types ────────────────────────────────────────────────────────────────

/** Content block returned by an external (Cursor-executed) tool call. */
export interface ExternalToolResultContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** Full result payload from an external tool, plus error status. */
export interface ExternalToolResultPayload {
	content: ExternalToolResultContentBlock[];
	details?: Record<string, unknown>;
	isError: boolean;
}

/** A `ToolCall` augmented with the result attached by Cursor's `tool_result` event. */
type ToolCallWithExternalResult = ToolCall & {
	externalResult?: ExternalToolResultPayload;
};

/**
 * Extended SimpleStreamOptions consumed by the Cursor adapter. Additional
 * fields beyond the base type are optional and only honoured when the host
 * application sets them on the slice descriptor.
 */
export interface CursorStreamOptions extends SimpleStreamOptions {
	/** When true, pass `--force` to authorise unsupervised file writes. */
	allowsWrites?: boolean;
	/** Resume an existing Cursor session via `--resume <sessionId>`. */
	resumeSessionId?: string;
	/** Override the sandbox mode. Defaults to leaving Cursor's CLI default. */
	sandbox?: "enabled" | "disabled";
}

// ─── Stream factory ──────────────────────────────────────────────────────

function createAssistantStream(): AssistantMessageEventStream {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type for final result");
		},
	) as AssistantMessageEventStream;
}

// ─── Prompt construction ─────────────────────────────────────────────────

function extractMessageText(msg: { role: string; content: unknown }): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		const parts: string[] = [];
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const obj = part as { type?: string; text?: string; thinking?: string };
			if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return "";
}

/**
 * Build a single concatenated prompt from GSD's `Context.messages`.
 *
 * Cursor's `-p` mode takes a single prompt argument. Wrap historical turns
 * in XML structure (rather than `[User]`/`[Assistant]` bracket headers)
 * so the model does not mirror them in its own output as fake user turns.
 */
export function buildPromptFromContext(context: Context): string {
	const hasContent =
		Boolean(context.systemPrompt) || context.messages.some((m) => extractMessageText(m));
	if (!hasContent) return "";

	const parts: string[] = [
		"Respond only to the final user message below. " +
			"Do not emit <user_message>, <assistant_message>, or <prior_system_context> tags in your response.",
	];

	if (context.systemPrompt) {
		parts.push(`<prior_system_context>\n${context.systemPrompt}\n</prior_system_context>`);
	}

	const turns: string[] = [];
	for (const msg of context.messages) {
		const text = extractMessageText(msg);
		if (!text) continue;
		const tag =
			msg.role === "user"
				? "user_message"
				: msg.role === "assistant"
					? "assistant_message"
					: "system_message";
		turns.push(`<${tag}>\n${text}\n</${tag}>`);
	}
	if (turns.length > 0) {
		parts.push(`<conversation_history>\n${turns.join("\n")}\n</conversation_history>`);
	}

	return parts.join("\n\n");
}

// ─── Invocation builder ───────────────────────────────────────────────────

/**
 * Build the argv array for a single `cursor-agent` invocation.
 *
 * Exported for testability — callers can verify that `--force` only appears
 * when the slice declares write intent and that `--resume` is forwarded.
 */
export function buildCursorArgs(
	model: Model<Api>,
	cwd: string,
	options: CursorStreamOptions | undefined,
): string[] {
	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--model",
		model.id,
		"--workspace",
		cwd,
		"--trust",
	];
	if (options?.allowsWrites) args.push("--force");
	if (options?.resumeSessionId) {
		args.push("--resume", options.resumeSessionId);
	}
	const sandbox = options?.sandbox ?? envSandboxMode();
	if (sandbox === "enabled" || sandbox === "disabled") {
		args.push("--sandbox", sandbox);
	}
	return args;
}

function envSandboxMode(): "enabled" | "disabled" | undefined {
	const value = process.env.CURSOR_SANDBOX?.trim();
	if (value === "enabled" || value === "disabled") return value;
	return undefined;
}

function resolveCwd(options?: SimpleStreamOptions): string {
	return options?.cwd && options.cwd.trim().length > 0 ? options.cwd : process.cwd();
}

function debugLog(...parts: unknown[]): void {
	if (process.env.GSD_CURSOR_DEBUG) {
		const message = parts
			.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
			.join(" ");
		process.stderr.write(`[cursor-stream] ${redactSecrets(message)}\n`);
	}
}

// ─── Error helpers ────────────────────────────────────────────────────────

function makeErrorMessage(model: string, errorMsg: string): AssistantMessage {
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

function makeStreamExhaustedErrorMessage(model: string, lastTextContent: string): AssistantMessage {
	const message = makeErrorMessage(model, "stream_exhausted_without_result");
	if (lastTextContent) {
		message.content = [{ type: "text", text: lastTextContent }];
	}
	return message;
}

// ─── Tool result normalisation ────────────────────────────────────────────

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

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

// ─── Event mapping ────────────────────────────────────────────────────────

interface StreamState {
	model: string;
	builder: PartialMessageBuilder | null;
	sessionId: string | null;
	lastTextContent: string;
	intermediateToolBlocks: AssistantMessage["content"];
	toolResultsById: Map<string, ExternalToolResultPayload>;
}

function makeInitialState(model: string): StreamState {
	return {
		model,
		builder: null,
		sessionId: null,
		lastTextContent: "",
		intermediateToolBlocks: [],
		toolResultsById: new Map(),
	};
}

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
			const toolCall = toolCallFromCursorBlock(call.tool_call_id, call.name, call.input);
			state.intermediateToolBlocks.push(toolCall);
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
				usage: mapUsage(result.usage ?? { input_tokens: 0, output_tokens: 0 }),
				stopReason: mapStopReason(result.subtype, result.is_error),
				timestamp: Date.now(),
			};
			if (result.is_error) {
				finalMessage.errorMessage = redactSecrets(result.result || result.subtype);
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

function ingestAssistantBlock(block: CursorContentBlock, state: StreamState): void {
	if (block.type === "text") {
		if (block.text) state.lastTextContent = block.text;
		return;
	}
	const toolCall = toolCallFromCursorBlock(block.id, block.name, block.input);
	state.intermediateToolBlocks.push(toolCall);
}

function attachExternalResultsToToolBlocks(
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

// ─── Spawn + pump ─────────────────────────────────────────────────────────

/**
 * GSD `streamSimple` implementation that delegates to `cursor-agent`.
 *
 * Emits `AssistantMessageEvent` deltas for real-time TUI rendering; the
 * final `AssistantMessage` preserves Cursor-executed tool calls so Agent
 * Core renders them under `externalToolExecution` without redispatch.
 */
export function streamViaCursorCli(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantStream();
	void pumpCursorMessages(model, context, options, stream);
	return stream;
}

async function pumpCursorMessages(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const state = makeInitialState(model.id);
	let child: ChildProcess | null = null;
	let stderrBuffer = "";

	try {
		const command = findWorkingCommand();
		if (!command) {
			stream.push({
				type: "error",
				reason: "error",
				error: makeErrorMessage(
					model.id,
					`cursor-agent binary not found (tried: ${getCursorCommandCandidates().join(", ")})`,
				),
			});
			return;
		}

		const cwd = resolveCwd(options);
		const args = buildCursorArgs(model, cwd, options as CursorStreamOptions | undefined);
		const prompt = buildPromptFromContext(context);

		debugLog("spawning", command, args.join(" "));

		const spawned = spawn(command, [...args, prompt], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// Default env inheritance forwards CURSOR_API_KEY without ever
			// reading it into a JS variable in this process.
			env: process.env,
			windowsHide: true,
		});
		child = spawned;
		const childStdout = spawned.stdout as Readable;
		const childStderr = spawned.stderr as Readable;

		// Always emit an initial `start` event so the TUI can wire up
		// renderers even when the CLI takes a moment before its first
		// `stream_event` arrives.
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

		// Capture (and redact) stderr for inclusion in error messages.
		childStderr.setEncoding("utf8");
		childStderr.on("data", (chunk: string) => {
			stderrBuffer += chunk;
			if (stderrBuffer.length > 8 * 1024) {
				stderrBuffer = stderrBuffer.slice(-8 * 1024);
			}
		});

		// Honour caller abort — SIGTERM the child and let stdout drain.
		const onAbort = () => {
			if (child && !child.killed) {
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore — best effort
				}
			}
		};
		if (options?.signal) {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const exitPromise = new Promise<{ code: number | null; error?: Error }>((resolve) => {
			spawned.on("error", (error) => {
				resolve({ code: null, error });
			});
			spawned.on("close", (code) => {
				resolve({ code });
			});
		});

		// Iterate parsed NDJSON events from stdout.
		let resolvedFinal = false;
		for await (const event of parseNdjson(childStdout)) {
			if (options?.signal?.aborted) {
				stream.push({
					type: "error",
					reason: "aborted",
					error: makeAbortedMessage(model.id, state.lastTextContent),
				});
				return;
			}
			const { events, final } = mapCursorEvent(event, state);
			for (const e of events) stream.push(e);
			if (final) {
				if (final.kind === "done") {
					stream.push({ type: "done", reason: "stop", message: final.message });
				} else {
					stream.push({ type: "error", reason: "error", error: final.message });
				}
				resolvedFinal = true;
				// Drain any remaining stdout but stop emitting GSD events.
				break;
			}
		}

		const exit = await exitPromise;

		if (options?.signal?.aborted) {
			if (!resolvedFinal) {
				stream.push({
					type: "error",
					reason: "aborted",
					error: makeAbortedMessage(model.id, state.lastTextContent),
				});
			}
			return;
		}

		if (!resolvedFinal) {
			const reason =
				exit.error?.message
					? `cursor-agent spawn error: ${exit.error.message}`
					: exit.code && exit.code !== 0
						? `cursor-agent exited ${exit.code}: ${stderrBuffer.trim()}`
						: undefined;
			if (reason) {
				stream.push({
					type: "error",
					reason: "error",
					error: makeErrorMessage(model.id, reason),
				});
			} else {
				stream.push({
					type: "error",
					reason: "error",
					error: makeStreamExhaustedErrorMessage(model.id, state.lastTextContent),
				});
			}
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (options?.signal?.aborted) {
			stream.push({
				type: "error",
				reason: "aborted",
				error: makeAbortedMessage(model.id, state.lastTextContent),
			});
			return;
		}
		stream.push({
			type: "error",
			reason: "error",
			error: makeErrorMessage(model.id, errorMsg),
		});
	}
}
