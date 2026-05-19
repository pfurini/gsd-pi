/**
 * UPSTREAM_REVIEW:C — adapter path selector for the Cursor provider.
 *
 * Reads the `cursor.adapter` setting (default `"sdk"`) and, when SDK is
 * requested, attempts to dynamically resolve `@cursor/sdk`. On any failure
 * to load the SDK, falls back to the CLI path for the current process and
 * emits a single redacted stderr warning (handled inside `sdk-runtime`).
 *
 * Cached per process so the resolve cost is paid once. `/cursor adapter`
 * invalidates the cache via {@link invalidatePathCache}.
 */

import { readCursorAdapterSetting } from "./adapter-setting.js";
import { loadSdk } from "./sdk-runtime.js";
import type { SdkModule } from "./sdk-types.js";

// UPSTREAM_REVIEW:C
export type StreamPath =
	| { kind: "sdk"; sdk: SdkModule }
	| { kind: "cli" };

type CachedPath = StreamPath | undefined;

let cached: CachedPath = undefined;
let warnedAboutMissingApiKey = false;

// UPSTREAM_REVIEW:C
export async function pickStreamPath(): Promise<StreamPath> {
	if (cached !== undefined) return cached;

	const selected = readCursorAdapterSetting();
	if (selected === "cli") {
		cached = { kind: "cli" };
		return cached;
	}

	// UPSTREAM_REVIEW:C — the SDK has no fallback to `cursor-agent`'s
	// credential store; it reads `process.env.CURSOR_API_KEY` and throws
	// unhandled rejections from its Connect-RPC layer when the key is
	// missing. Detect that proactively and route to the CLI (which reads
	// its own credential file) so users authenticated only via
	// `cursor-agent login` keep working.
	if (!process.env.CURSOR_API_KEY) {
		if (!warnedAboutMissingApiKey) {
			warnedAboutMissingApiKey = true;
			process.stderr.write(
				"[cursor-cli] CURSOR_API_KEY not set; SDK path requires an API key. Falling back to CLI path. " +
					"Set CURSOR_API_KEY=… to use the SDK adapter, or set cursor.adapter=cli in settings.json to silence this warning.\n",
			);
		}
		cached = { kind: "cli" };
		return cached;
	}

	const sdk = await loadSdk();
	if (sdk) {
		cached = { kind: "sdk", sdk };
		return cached;
	}

	cached = { kind: "cli" };
	return cached;
}

// UPSTREAM_REVIEW:C — invalidate the per-process cache after the user flips
// `cursor.adapter` so the next slice picks up the change without a restart.
export function invalidatePathCache(): void {
	cached = undefined;
	warnedAboutMissingApiKey = false;
}

// UPSTREAM_REVIEW:C — test hook to reset cache state for individual cases.
export function __resetPathCacheForTests(): void {
	cached = undefined;
	warnedAboutMissingApiKey = false;
}
