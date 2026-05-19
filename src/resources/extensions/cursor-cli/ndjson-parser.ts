/**
 * Line-buffered NDJSON parser over a Node `Readable`.
 *
 * Handles:
 * - `\n` and `\r\n` line terminators
 * - Partial chunks across `data` events
 * - Oversize lines (4 MB cap — anything larger is dropped with a warning)
 * - Malformed JSON (logged via `debugLog`, then skipped — never thrown)
 *
 * Returns an async iterable of parsed `CursorStreamEvent` objects so the
 * caller can `for await … of` over the stream without managing buffer state.
 */

import type { Readable } from "node:stream";
import type { CursorStreamEvent } from "./sdk-types.js";
import { redactSecrets } from "./redact.js";

/** Defensive cap: drop any single NDJSON line larger than 4 MB. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function debugLog(...parts: unknown[]): void {
	if (process.env.GSD_CURSOR_DEBUG) {
		const message = parts
			.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
			.join(" ");
		process.stderr.write(`[cursor-ndjson] ${redactSecrets(message)}\n`);
	}
}

/**
 * Iterate parsed NDJSON events from a readable byte stream.
 *
 * The returned iterable is single-pass and consumes the stream as it runs.
 * Callers should propagate `AbortSignal` cancellation by destroying the
 * underlying readable — the iterator exits cleanly on `end`.
 */
export async function* parseNdjson(
	stream: Readable,
): AsyncIterable<CursorStreamEvent> {
	let buffer = "";

	stream.setEncoding("utf8");

	for await (const chunk of stream as AsyncIterable<string>) {
		buffer += chunk;

		// Guard against runaway buffers when a single NDJSON line is larger
		// than `MAX_LINE_BYTES` and no terminator has arrived yet.
		if (buffer.length > MAX_LINE_BYTES) {
			debugLog("dropping oversize buffer", "bytes=", buffer.length);
			// Drop everything up to the last newline; partial trailing line stays.
			const lastNewline = buffer.lastIndexOf("\n");
			buffer = lastNewline >= 0 ? buffer.slice(lastNewline + 1) : "";
		}

		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);

			// Strip trailing CR for CRLF inputs.
			if (line.endsWith("\r")) line = line.slice(0, -1);

			const trimmed = line.trim();
			if (trimmed.length > 0) {
				const event = tryParseLine(trimmed);
				if (event) yield event;
			}

			newlineIndex = buffer.indexOf("\n");
		}
	}

	// Flush a final trailing line that arrived without a terminator.
	const tail = buffer.trim();
	if (tail.length > 0) {
		const event = tryParseLine(tail);
		if (event) yield event;
	}
}

/** Best-effort JSON parse with debug logging on failure. */
function tryParseLine(line: string): CursorStreamEvent | null {
	try {
		const parsed = JSON.parse(line) as CursorStreamEvent;
		if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
			debugLog("skipping non-object NDJSON line");
			return null;
		}
		return parsed;
	} catch (err) {
		debugLog(
			"JSON parse failed:",
			(err as Error).message?.slice(0, 200),
			"line.length=",
			line.length,
		);
		return null;
	}
}
