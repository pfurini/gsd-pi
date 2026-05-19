/**
 * Cursor CLI Provider Extension
 *
 * Registers a model provider that delegates inference to the user's
 * locally-installed `cursor-agent` CLI via `--output-format stream-json`.
 *
 * Users with a Cursor subscription (Pro / Pro+ / Ultra / Teams) get access
 * to multi-vendor models — Claude, GPT-5.x, Gemini, Composer 2.5, Grok —
 * routed through their own Cursor plan, with zero per-provider API keys.
 *
 * Compliance posture (see `.plans/cursor-cli-provider.md` §"Compliance &
 * Data Handling"):
 *   - Auth probe output is opaque (only the parsed boolean leaves the module).
 *   - `CURSOR_API_KEY` is never copied into a JS variable.
 *   - Every log / error string passes through `redactSecrets()`.
 *   - `/cursor login` is a pure shell-out; no OAuth interception.
 *   - Session ids are user-and-machine-scoped, never exported.
 *
 * Write policy: `--force` (autonomous edits) is gated by `resolveAllowsWrites`
 * — env > `--cursor-force` flag > slice metadata > read-only default. The
 * resolver runs inside the streamSimple wrapper so `pi.getFlag` is read
 * lazily per invocation, not at module load.
 */

import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@gsd/pi-ai";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { FORCE_FLAG_NAME, resolveAllowsWrites } from "./allows-writes.js";
import { getCursorModels } from "./models.js";
import { isCursorReady } from "./readiness.js";
import type { CursorStreamOptions } from "./stream-adapter.js";
// UPSTREAM_REVIEW:C — `streamViaCursor` dispatches between the CLI pump and
// the SDK pump per the persisted `cursor.adapter` setting. The metrics
// recording hook lives in the dispatcher so it fires exactly once per slice.
import { streamViaCursor } from "./stream-dispatch.js";
import { registerCursorCommands } from "./auth-cli-helper.js";

export default function cursorCli(pi: ExtensionAPI): void {
	if (process.env.GSD_CURSOR_DISABLE === "1") {
		// Kill-switch: register nothing, leave the extension dormant.
		return;
	}

	pi.registerFlag(FORCE_FLAG_NAME, {
		description:
			"Allow cursor-agent to autonomously edit files for this session (sets --force on every invocation).",
		type: "boolean",
		default: false,
	});

	pi.registerProvider("cursor-agent", {
		authMode: "externalCli",
		api: "cursor-stream-json",
		baseUrl: "local://cursor-agent",
		isReady: isCursorReady,
		streamSimple: makeStreamSimple(pi),
		models: getCursorModels(),
	});

	registerCursorCommands(pi);
}

/**
 * Wrap `streamViaCursorCli` so every invocation runs the precedence
 * resolver before the child process is spawned. The slice channel reads
 * any `allowsWrites` that the caller has pre-set on the options bag
 * (`CursorStreamOptions` extends `SimpleStreamOptions`).
 */
function makeStreamSimple(
	pi: ExtensionAPI,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return (model, context, options) => {
		const sliceAllowsWrites = (options as CursorStreamOptions | undefined)?.allowsWrites;
		const resolution = resolveAllowsWrites(
			(name) => pi.getFlag(name),
			sliceAllowsWrites,
		);
		const merged: CursorStreamOptions = {
			...(options as CursorStreamOptions | undefined),
			allowsWrites: resolution.allowsWrites,
		};
		// UPSTREAM_REVIEW:C
		return streamViaCursor(model, context, merged);
	};
}
