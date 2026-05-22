/**
 * Stream adapter (CLI path): bridges the `cursor-agent` CLI into GSD's
 * `streamSimple` contract.
 *
 * The CLI runs the full agentic loop (multi-turn, tool execution) in one
 * spawn. This adapter:
 *   1. Builds the invocation argv (`-p --output-format stream-json …`).
 *   2. Spawns the child via `node:child_process.spawn`.
 *   3. Streams stdout through the NDJSON parser.
 *   4. Translates each `CursorStreamEvent` into one or more
 *      `AssistantMessageEvent`s via {@link mapCursorEvent} from
 *      `stream-translation.ts` (shared with the Phase 2 SDK adapter).
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
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@gsd/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { ZERO_USAGE } from "./partial-builder.js";
import { parseNdjson } from "./ndjson-parser.js";
import { redactSecrets } from "./redact.js";
import { findWorkingCommand, getCursorCommandCandidates } from "./readiness.js";
// UPSTREAM_REVIEW:C — shared translation module covers both CLI and SDK paths.
import {
	makeErrorMessage,
	makeInitialState,
	mapCursorEvent,
} from "./stream-translation.js";
// UPSTREAM_REVIEW:C — local-only metrics recording moved to the dispatcher.
// streamViaCursorCli is now a thin wrapper kept for tests that exercise the
// CLI pump in isolation; the public `streamSimple` entry point is
// `streamViaCursor` in `stream-dispatch.ts`, which owns the metrics hook.
import { createAssistantStream } from "./stream-dispatch.js";
// UPSTREAM_REVIEW:C — opt-in usage tracer (`GSD_CURSOR_USAGE_LOG`) for the
// CLI-vs-SDK token-accounting investigation.
import { traceUsage } from "./usage-trace.js";

// Re-export shared types for back-compat with downstream callers and tests
// that still import them from this module.
// UPSTREAM_REVIEW:C
export type {
	ExternalToolResultContentBlock,
	ExternalToolResultPayload,
} from "./stream-translation.js";

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

/**
 * Module-level latch so the destructive-write banner fires at most once per
 * process. Headless runs stay silent so verification pipelines don't pollute
 * stderr; interactive runs get a single warning the first time a slice
 * actually escalates to `--force`. Mirrors the
 * `[claude-code-cli] Headless mode detected…` banner pattern.
 */
let hasWarnedAboutForce = false;

/** Reset the warning latch — test-only helper. */
export function resetForceWarningLatch(): void {
	hasWarnedAboutForce = false;
}

/** Read the warning latch — test-only helper. */
export function hasWarnedAboutForceForTests(): boolean {
	return hasWarnedAboutForce;
}

function maybeWarnAboutForce(): void {
	if (hasWarnedAboutForce) return;
	if (process.env.GSD_HEADLESS === "1") return;
	hasWarnedAboutForce = true;
	process.stderr.write(
		"[cursor-cli] --force enabled: cursor-agent may now edit files autonomously this session. " +
			"Set GSD_CURSOR_FORCE_ALL_SLICES=0 or restart without --cursor-force to revert.\n",
	);
}

// ─── Error helpers ────────────────────────────────────────────────────────

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

// UPSTREAM_REVIEW:C — exported so `stream-dispatch.ts` can call the pump
// directly without going through `streamViaCursorCli`'s stream-creation
// wrapper (the dispatcher creates its own stream so a single
// `stream.result()` boundary owns the metrics hook).
export async function pumpCursorMessages(
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
		const cursorOptions = options as CursorStreamOptions | undefined;
		const args = buildCursorArgs(model, cwd, cursorOptions);
		const prompt = buildPromptFromContext(context);

		// UPSTREAM_REVIEW:C — usage trace: record the exact CLI invocation so a
		// CLI run can be compared against an SDK run of the same prompt.
		traceUsage({ path: "cli", event: "start", model: model.id, cwd, args });

		if (cursorOptions?.allowsWrites === true) {
			maybeWarnAboutForce();
		}

		debugLog("spawning", command, args.join(" "));

		const spawned = spawn(command, [...args, prompt], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
			windowsHide: true,
		});
		child = spawned;
		const childStdout = spawned.stdout as Readable;
		const childStderr = spawned.stderr as Readable;

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

		childStderr.setEncoding("utf8");
		childStderr.on("data", (chunk: string) => {
			stderrBuffer += chunk;
			if (stderrBuffer.length > 8 * 1024) {
				stderrBuffer = stderrBuffer.slice(-8 * 1024);
			}
		});

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

		let resolvedFinal = false;
		// UPSTREAM_REVIEW:C — usage trace: tally event types so the CLI run's
		// agentic depth (tool_call / assistant counts) is visible alongside
		// the terminal `result` usage block.
		const eventTally: Record<string, number> = {};
		for await (const event of parseNdjson(childStdout)) {
			if (options?.signal?.aborted) {
				stream.push({
					type: "error",
					reason: "aborted",
					error: makeAbortedMessage(model.id, state.lastTextContent),
				});
				return;
			}
			// UPSTREAM_REVIEW:C — usage trace hook.
			eventTally[event.type] = (eventTally[event.type] ?? 0) + 1;
			if (event.type === "result") {
				traceUsage({
					path: "cli",
					event: "result",
					usage: event.usage ?? {},
					events: { ...eventTally },
				});
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
