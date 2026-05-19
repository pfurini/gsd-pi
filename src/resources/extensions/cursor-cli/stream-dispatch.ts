/**
 * UPSTREAM_REVIEW:C — public `streamSimple` entry point for the Cursor
 * provider. Picks the CLI or SDK pump per the `cursor.adapter` setting,
 * dispatches events through the chosen pump into a single event stream,
 * and attaches the local-only `/cursor doctor` metrics recording hook
 * exactly once per call.
 *
 * The CLI and SDK pumps are intentionally side-effect free regarding
 * metrics; both routes through this dispatcher record the same way. That
 * keeps the "do NOT double-record from both layers" invariant the plan
 * called out — the inner pumps push events to the stream, and the
 * dispatcher is the single owner of stream.result() telemetry.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@gsd/pi-ai";
import { EventStream } from "@gsd/pi-ai";
// UPSTREAM_REVIEW:B — single recording site per stream. Moved here from
// stream-adapter.ts so both adapters share one telemetry boundary.
import { record as recordMetric, type MetricEntry } from "./metrics.js";
import { pumpCursorMessages, type CursorStreamOptions } from "./stream-adapter.js";
import { pumpViaSdk } from "./sdk-adapter.js";
import { pickStreamPath } from "./path-selector.js";

// UPSTREAM_REVIEW:C
export function streamViaCursor(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantStream();
	const startedAt = Date.now();

	void (async () => {
		try {
			const path = await pickStreamPath();
			const cursorOptions = options as CursorStreamOptions | undefined;
			if (path.kind === "sdk") {
				await pumpViaSdk(path.sdk, model, context, cursorOptions, stream);
			} else {
				await pumpCursorMessages(model, context, cursorOptions, stream);
			}
		} catch (err) {
			// Defence in depth — the inner pumps already catch their own
			// errors, but a path-selector or import failure could throw at
			// this layer. Surface as an error final so the caller still
			// resolves.
			const errorMsg = err instanceof Error ? err.message : String(err);
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [{ type: "text", text: `Cursor dispatcher error: ${errorMsg}` }],
					api: "cursor-stream-json",
					provider: "cursor-agent",
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: errorMsg,
					timestamp: Date.now(),
				},
			});
		}
	})();

	void stream.result().then(
		(message) => {
			try {
				recordMetric(deriveMetricEntry(message, startedAt, model.id));
			} catch {
				// Swallow — never let a recorder bug surface to the consumer.
			}
		},
		() => {
			try {
				recordMetric({
					startedAt,
					finishedAt: Date.now(),
					model: model.id,
					outcome: "error",
					inputTokens: 0,
					outputTokens: 0,
				});
			} catch {
				// Swallow.
			}
		},
	);

	return stream;
}

// UPSTREAM_REVIEW:C — shared with stream-adapter's CLI entry; moved here so
// the dispatcher can construct the stream without depending on private
// helpers in stream-adapter.ts.
export function createAssistantStream(): AssistantMessageEventStream {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type for final result");
		},
	) as AssistantMessageEventStream;
}

// UPSTREAM_REVIEW:B — moved from stream-adapter.ts to centralise metrics
// derivation. The "<code>:" prefix written by formatCursorErrorMessage is
// the source of `errorCode` (see quota-detect.ts).
function deriveMetricEntry(
	message: AssistantMessage,
	startedAt: number,
	modelId: string,
): MetricEntry {
	const outcome: MetricEntry["outcome"] =
		message.stopReason === "stop"
			? "success"
			: message.stopReason === "aborted"
				? "aborted"
				: "error";
	const entry: MetricEntry = {
		startedAt,
		finishedAt: Date.now(),
		model: modelId,
		outcome,
		inputTokens: message.usage?.input ?? 0,
		outputTokens: message.usage?.output ?? 0,
	};
	if (outcome === "error") {
		const code = extractErrorCode(message.errorMessage);
		if (code) entry.errorCode = code;
	}
	return entry;
}

// UPSTREAM_REVIEW:B
function extractErrorCode(errorMessage: string | undefined): string | undefined {
	if (!errorMessage) return undefined;
	const match = /^([a-z][a-z0-9_]*):\s/.exec(errorMessage);
	return match ? match[1] : undefined;
}
