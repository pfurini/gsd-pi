/**
 * UPSTREAM_REVIEW:C — `@cursor/sdk` dynamic loader.
 *
 * Mirrors the `claude-code-cli/stream-adapter.ts` precedent: resolve and
 * `import()` the SDK at runtime via `createRequire(import.meta.url)`. The
 * package is NOT a hard dependency in `package.json` — users running through
 * the CLI path never need it installed; users on the SDK path install it
 * explicitly (`npm install --save-dev @cursor/sdk`) or rely on
 * `npm install --no-save @cursor/sdk` in their local environment.
 *
 * Two layers of indirection keep `tsc --noEmit --project tsconfig.extensions.json`
 * green when the package is absent:
 *   1. The module specifier is held in a `let` variable, so TypeScript can't
 *      statically resolve `@cursor/sdk` types from a `dynamic import("…")`
 *      literal.
 *   2. The returned shape is typed as `SdkModule` from `sdk-types.ts` — a
 *      local structural mirror of the SDK's public API, never `import type`'d
 *      from `@cursor/sdk` itself.
 *
 * On any failure (package not installed, runtime error during resolve, bad
 * shape) the loader logs a single redacted stderr warning and returns
 * `null`, signalling the path-selector to fall back to the CLI path.
 *
 * Verified @cursor/sdk shape (v1.0.13, observed 2026-05-19):
 *   - `Agent.create({ model: { id }, local?: { cwd, settingSources? }, … })`
 *     → `Promise<SDKAgent>`
 *   - `agent.send(text)` → `Promise<Run>`
 *   - `run.stream()` → `AsyncGenerator<SDKMessage, void>`
 *   - `run.wait()` → `Promise<RunResult>`  (status / result / durationMs)
 *   - `run.cancel()` → `Promise<void>`
 *   - `apiKey` MUST be passed explicitly to `Agent.create` — v1.0.13 does
 *     NOT auto-read `process.env.CURSOR_API_KEY` (verified 2026-05-20; see
 *     the compliance note in `sdk-adapter.ts`).
 */

import { createRequire } from "node:module";
import { redactSecrets } from "./redact.js";
import type { SdkModule } from "./sdk-types.js";

// UPSTREAM_REVIEW:C — resolve from this file's location so the SDK is found
// alongside the GSD install (matches claude-code-cli precedent).
const requireFromHere = createRequire(import.meta.url);

const SDK_MODULE_NAME = "@cursor/sdk";

type LoadState = SdkModule | null | undefined;
let cachedSdk: LoadState = undefined;
let warnedThisProcess = false;

// UPSTREAM_REVIEW:C
/**
 * Load `@cursor/sdk` lazily.
 *
 *   - Returns the cached module on subsequent calls.
 *   - Returns `null` on resolve failure (logs once per process).
 *   - Override via {@link __setSdkForTests} — see test hook below.
 */
export async function loadSdk(): Promise<SdkModule | null> {
	if (cachedSdk !== undefined) return cachedSdk;

	// First resolve the package on disk via createRequire — this fails fast
	// with a clear error if the package isn't installed, and avoids the
	// dynamic import touching anything weird before we know it's there.
	try {
		requireFromHere.resolve(SDK_MODULE_NAME);
	} catch (err) {
		warnOnce(err);
		cachedSdk = null;
		return null;
	}

	// Indirect specifier so TypeScript can't resolve `@cursor/sdk` types at
	// build time. The package may not be installed when typechecking; the
	// runtime load is what matters.
	const moduleName: string = SDK_MODULE_NAME;
	try {
		const mod = (await import(/* webpackIgnore: true */ moduleName)) as unknown;
		if (!isSdkModule(mod)) {
			warnOnce(new Error(`@cursor/sdk import resolved but missing Agent.create()`));
			cachedSdk = null;
			return null;
		}
		cachedSdk = mod;
		return mod;
	} catch (err) {
		warnOnce(err);
		cachedSdk = null;
		return null;
	}
}

// UPSTREAM_REVIEW:C — duck-type check so an SDK upgrade with surprising
// surface still produces a single clear warning, not a runtime crash inside
// the pump loop. `Agent` is exported as a class — i.e. `typeof === "function"`
// in JS — so accept either "function" or "object" forms.
function isSdkModule(value: unknown): value is SdkModule {
	if (!value || typeof value !== "object") return false;
	const v = value as { Agent?: unknown };
	if (!v.Agent || (typeof v.Agent !== "object" && typeof v.Agent !== "function")) return false;
	const agent = v.Agent as { create?: unknown };
	return typeof agent.create === "function";
}

function warnOnce(err: unknown): void {
	if (warnedThisProcess) return;
	warnedThisProcess = true;
	const detail = err instanceof Error ? err.message : String(err);
	process.stderr.write(
		`[cursor-cli] @cursor/sdk load failed (${redactSecrets(detail)}); falling back to CLI path.\n`,
	);
}

// ─── Background-rejection guard ───────────────────────────────────────────

// UPSTREAM_REVIEW:C — @cursor/sdk surfaces auth / transport failures from
// detached background Connect-RPC tasks as *unhandled* promise rejections
// that no try/catch inside `pumpViaSdk` can intercept (verified 2026-05-20:
// a present-but-invalid CURSOR_API_KEY produces an `unauthenticated`
// ConnectError this way). The pump's own `run.wait()` drain still yields a
// clean error terminal, so the extra rejection is redundant — but in a GSD
// host it trips `_gsdRejectionGuard` (gsd/bootstrap/register-extension.ts),
// which calls `process.exit(1)` and kills the whole CLI.
//
// We cannot attach `.catch` to a promise we never receive a handle to, and a
// time-scoped listener loses the race (the SDK can reject *after*
// `run.wait()` has already resolved). So the guard is installed once,
// lazily, on the first SDK pump and lives for the process: it takes over the
// `unhandledRejection` channel, swallows Cursor-SDK-identifiable rejections
// (with one redacted stderr line), and faithfully forwards every other
// rejection to the host listeners it replaced — so unrelated bugs still
// crash exactly as before. Ordering assumption: the host installs its crash
// guard at bootstrap, before any slice runs; re-running `installEpipeGuard`
// after this takeover would re-add `_gsdRejectionGuard` and is not expected.

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

let rejectionGuardInstalled = false;
let inheritedRejectionListeners: RejectionListener[] = [];
let installedRejectionGuard: RejectionListener | undefined;
let absorbedRejectionWarned = false;

// UPSTREAM_REVIEW:C — lazy, idempotent. Called at the head of every SDK pump.
export function installSdkRejectionGuard(): void {
	if (rejectionGuardInstalled) return;
	rejectionGuardInstalled = true;

	inheritedRejectionListeners = process.listeners(
		"unhandledRejection",
	) as RejectionListener[];
	for (const listener of inheritedRejectionListeners) {
		process.removeListener("unhandledRejection", listener);
	}

	installedRejectionGuard = (reason: unknown, promise: Promise<unknown>): void => {
		if (looksLikeCursorSdkError(reason)) {
			if (!absorbedRejectionWarned) {
				absorbedRejectionWarned = true;
				const detail = reason instanceof Error ? reason.message : String(reason);
				process.stderr.write(
					"[cursor-cli] absorbed a background @cursor/sdk rejection " +
						`(${redactSecrets(detail)}); the slice fails gracefully — ` +
						"verify CURSOR_API_KEY is valid.\n",
				);
			}
			return;
		}
		// Not a Cursor-SDK rejection — preserve host behaviour exactly.
		if (inheritedRejectionListeners.length === 0) {
			// No host crash guard (bare / test runtime): restore Node's default
			// "throw on unhandled rejection" so genuine bugs still surface.
			queueMicrotask(() => {
				throw reason;
			});
			return;
		}
		for (const listener of inheritedRejectionListeners) {
			listener(reason, promise);
		}
	};
	process.on("unhandledRejection", installedRejectionGuard);
}

// UPSTREAM_REVIEW:C — duck-type a rejection as originating from @cursor/sdk or
// its Connect-RPC transport. Walks the `cause` chain since the SDK wraps the
// underlying AuthenticationError inside a ConnectError.
function looksLikeCursorSdkError(reason: unknown): boolean {
	let current: unknown = reason;
	for (let depth = 0; depth < 6 && current; depth++) {
		if (typeof current !== "object") break;
		const err = current as {
			name?: unknown;
			code?: unknown;
			stack?: unknown;
			cause?: unknown;
			constructor?: { name?: unknown };
		};
		const name = String(err.name ?? err.constructor?.name ?? "");
		if (
			/ConnectError|CursorAgentError|CursorSdkError|AuthenticationError|RateLimitError|NetworkError|ConfigurationError/.test(
				name,
			)
		) {
			return true;
		}
		if (
			typeof err.code === "string" &&
			/^(unauthenticated|unauthorized|permission_denied)$/.test(err.code)
		) {
			return true;
		}
		if (typeof err.stack === "string" && /[/@](cursor[/-]sdk|connectrpc)/.test(err.stack)) {
			return true;
		}
		current = err.cause;
	}
	return false;
}

// UPSTREAM_REVIEW:C — test hook: undo the takeover so a suite can exercise the
// install path in isolation. Restores the inherited listeners verbatim.
export function __resetRejectionGuardForTests(): void {
	if (installedRejectionGuard) {
		process.removeListener("unhandledRejection", installedRejectionGuard);
	}
	for (const listener of inheritedRejectionListeners) {
		process.on("unhandledRejection", listener);
	}
	rejectionGuardInstalled = false;
	inheritedRejectionListeners = [];
	installedRejectionGuard = undefined;
	absorbedRejectionWarned = false;
}

// UPSTREAM_REVIEW:C — test hook. Pass a structural mock to short-circuit the
// dynamic import; pass `null` to force the fallback branch. Pass `undefined`
// to reset the cache and let the next call probe normally.
export function __setSdkForTests(mod: SdkModule | null | undefined): void {
	cachedSdk = mod;
	if (mod !== null) {
		warnedThisProcess = false;
	}
}

// UPSTREAM_REVIEW:C — test hook for the warn-once latch.
export function __resetWarnedForTests(): void {
	warnedThisProcess = false;
}

// UPSTREAM_REVIEW:C — test hook so the path-selector cache can be invalidated
// from a test without invoking the public setter (which would force a value).
export function __clearSdkCacheForTests(): void {
	cachedSdk = undefined;
	warnedThisProcess = false;
}
