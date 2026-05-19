/**
 * Readiness check for the Cursor CLI provider.
 *
 * Verifies the `cursor-agent` binary is installed, responsive, AND
 * authenticated (either via `cursor-agent login` or `CURSOR_API_KEY`).
 * Results are cached for 30 seconds to avoid shelling out on every
 * model-availability check.
 *
 * Auth verification runs `cursor-agent status --json` and inspects the
 * `authenticated` field, falling back to plain `cursor-agent status` and
 * a text heuristic when the JSON shape is unavailable.
 *
 * Per the compliance posture in `.plans/cursor-cli-provider.md` §"Compliance
 * & Data Handling": raw stdout is never logged, persisted, or surfaced in
 * errors; only the parsed boolean leaves this module. The `CURSOR_API_KEY`
 * value is checked for presence only — its value is never read into a JS
 * variable.
 *
 * Set GSD_CURSOR_DEBUG=1 to print probe selection and parsed outcomes to
 * stderr — useful when diagnosing platform-specific detection failures.
 */

import { execFileSync } from "node:child_process";
import { redactSecrets } from "./redact.js";

/**
 * Spawn the Cursor CLI without triggering Node's DEP0190.
 *
 * Mirrors the claude-code-cli pattern: on Windows we use `cmd /c <command>
 * <args...>` to resolve `.cmd` shims; on POSIX we exec the command directly.
 */
export function buildCursorSpawnInvocation(
	command: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
	if (platform === "win32") {
		return { command: "cmd", args: ["/c", command, ...args] };
	}
	return { command, args };
}

function spawnCursor(
	command: string,
	args: string[],
	opts: { timeout: number; stdio: "pipe" },
): Buffer {
	const invocation = buildCursorSpawnInvocation(command, args);
	return execFileSync(invocation.command, invocation.args, opts);
}

/**
 * Ordered list of candidate executable names for the Cursor CLI.
 *
 * The install script ships both `cursor-agent` and `agent` aliases on
 * POSIX; on Windows both `.cmd` shims and `.exe` direct binaries may be
 * present. Try every candidate before declaring the binary missing.
 *
 * Users can override the resolution entirely by setting
 * `CURSOR_AGENT_BIN=/abs/path/to/binary`.
 */
export function getCursorCommandCandidates(
	platform: NodeJS.Platform = process.platform,
): string[] {
	const override = process.env.CURSOR_AGENT_BIN?.trim();
	if (override) return [override];
	if (platform === "win32") {
		return ["cursor-agent.cmd", "agent.cmd", "cursor-agent.exe", "agent.exe"];
	}
	return ["cursor-agent", "agent"];
}

// Snappy version probe — `cursor-agent --version` should return immediately.
const VERSION_TIMEOUT_MS = 5_000;
// Auth status can be slow on Windows because spawn goes through cmd.exe
// → cursor-agent.cmd → node → CLI. 15s leaves headroom on cold spawns.
const AUTH_TIMEOUT_MS = 15_000;
const CHECK_INTERVAL_MS = 30_000;

function debugLog(...parts: unknown[]): void {
	if (process.env.GSD_CURSOR_DEBUG) {
		const message = parts
			.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
			.join(" ");
		process.stderr.write(`[cursor-readiness] ${redactSecrets(message)}\n`);
	}
}

/**
 * Find the first candidate that responds to `--version`. Returns the
 * candidate name on success, null if none worked.
 *
 * Mirrors `claude-code-cli/readiness.ts`: treat any failure as "try next"
 * because `cmd /c` on Windows surfaces missing binaries as non-zero exit
 * rather than ENOENT.
 */
export function findWorkingCommand(): string | null {
	for (const command of getCursorCommandCandidates()) {
		try {
			spawnCursor(command, ["--version"], {
				timeout: VERSION_TIMEOUT_MS,
				stdio: "pipe",
			});
			debugLog("version probe ok via", command);
			return command;
		} catch (error) {
			debugLog(
				"version probe failed for",
				command,
				"code=",
				(error as NodeJS.ErrnoException | undefined)?.code,
			);
			continue;
		}
	}
	return null;
}

/**
 * Decide auth state from `cursor-agent status` output.
 *
 * The structured signal is `{ "authenticated": true|false }`. Older CLI
 * builds may emit free-form text; the heuristic only covers English phrasing
 * and is the fallback path. Raw stdout is never logged or surfaced — only
 * the parsed boolean leaves this function.
 */
export function parseAuthStatus(output: string): boolean | null {
	const trimmed = output.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as {
				authenticated?: unknown;
				logged_in?: unknown;
				loggedIn?: unknown;
			};
			if (typeof parsed.authenticated === "boolean") return parsed.authenticated;
			if (typeof parsed.logged_in === "boolean") return parsed.logged_in;
			if (typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
		} catch {
			// Fall through to text heuristic.
		}
	}

	const lower = trimmed.toLowerCase();
	if (/not logged in|no credentials|unauthenticated|not authenticated/.test(lower)) {
		return false;
	}
	if (/logged in|authenticated|signed in|subscription/.test(lower)) {
		return true;
	}
	return null;
}

function probeAuth(command: string): boolean | null {
	// 1. Short-circuit on CURSOR_API_KEY — presence-only check, never the value.
	if (typeof process.env.CURSOR_API_KEY === "string" && process.env.CURSOR_API_KEY.length > 0) {
		debugLog("CURSOR_API_KEY present — short-circuit authed");
		return true;
	}

	// 2. Try `status --json` first (newer CLIs).
	try {
		const out = spawnCursor(command, ["status", "--json"], {
			timeout: AUTH_TIMEOUT_MS,
			stdio: "pipe",
		}).toString();
		const parsed = parseAuthStatus(out);
		debugLog("status --json parsed:", parsed);
		if (parsed !== null) return parsed;
	} catch (error) {
		debugLog("status --json threw:", (error as Error).message?.slice(0, 200));
	}

	// 3. Fallback: plain `status` text — heuristic only.
	try {
		const out = spawnCursor(command, ["status"], {
			timeout: AUTH_TIMEOUT_MS,
			stdio: "pipe",
		}).toString();
		const parsed = parseAuthStatus(out);
		debugLog("status parsed:", parsed);
		return parsed;
	} catch (error) {
		debugLog("status threw:", (error as Error).message?.slice(0, 200));
		return null;
	}
}

let cachedBinaryPresent: boolean | null = null;
let cachedAuthed: boolean | null = null;
let lastCheckMs = 0;

/**
 * Refresh the cached binary/auth state when the cache window has expired.
 * Preserves a known auth state across soft-fail auth probes.
 */
function refreshCache(): void {
	if (process.env.GSD_CURSOR_DISABLE === "1") {
		cachedBinaryPresent = false;
		cachedAuthed = false;
		lastCheckMs = Date.now();
		return;
	}

	const now = Date.now();
	if (cachedBinaryPresent !== null && now - lastCheckMs < CHECK_INTERVAL_MS) {
		return;
	}

	// Set timestamp first to prevent re-entrant checks during the same window.
	lastCheckMs = now;

	const command = findWorkingCommand();
	if (!command) {
		cachedBinaryPresent = false;
		cachedAuthed = false;
		return;
	}
	cachedBinaryPresent = true;

	const authed = probeAuth(command);
	if (authed === null) {
		// Couldn't determine auth state. Don't clobber a previously known-good
		// cache; default to false so we never silently route to an
		// unauthenticated CLI.
		if (cachedAuthed === null) cachedAuthed = false;
		return;
	}
	cachedAuthed = authed;
}

/** Whether the `cursor-agent` binary is installed (regardless of auth state). */
export function isCursorBinaryPresent(): boolean {
	refreshCache();
	return cachedBinaryPresent ?? false;
}

/** Whether the `cursor-agent` CLI is authenticated. False when the binary is missing. */
export function isCursorAuthed(): boolean {
	refreshCache();
	return (cachedBinaryPresent ?? false) && (cachedAuthed ?? false);
}

/** Full readiness check: binary installed AND authenticated. */
export function isCursorReady(): boolean {
	refreshCache();
	return (cachedBinaryPresent ?? false) && (cachedAuthed ?? false);
}

/**
 * Force-clear the cached readiness state. Useful after the user completes
 * `cursor-agent login`, sets `CURSOR_API_KEY`, or toggles `GSD_CURSOR_DISABLE`.
 */
export function clearReadinessCache(): void {
	cachedBinaryPresent = null;
	cachedAuthed = null;
	lastCheckMs = 0;
}
