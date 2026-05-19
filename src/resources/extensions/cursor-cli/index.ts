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
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { getCursorModels } from "./models.js";
import { isCursorReady } from "./readiness.js";
import { streamViaCursorCli } from "./stream-adapter.js";
import { registerCursorCommands } from "./auth-cli-helper.js";

export default function cursorCli(pi: ExtensionAPI): void {
	if (process.env.GSD_CURSOR_DISABLE === "1") {
		// Kill-switch: register nothing, leave the extension dormant.
		return;
	}

	pi.registerProvider("cursor-agent", {
		authMode: "externalCli",
		api: "cursor-stream-json",
		baseUrl: "local://cursor-agent",
		isReady: isCursorReady,
		streamSimple: streamViaCursorCli,
		models: getCursorModels(),
	});

	registerCursorCommands(pi);
}
