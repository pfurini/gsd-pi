/**
 * UPSTREAM_REVIEW:C — console fence for the in-process `@cursor/sdk`.
 *
 * `@cursor/sdk` runs inside the GSD process and writes INFO/WARN/ERROR lines
 * straight to `console.*` — its `LocalCursorRulesService` /
 * `AgentSkillsCursorRulesService` settings loaders log on every run, and the
 * SDK exposes no public logger-config API (`setLogger` / `LogLevel` are not
 * on its export surface; verified against @cursor/sdk@1.0.13). Those writes
 * land on the shared process stdout/stderr and overprint the interactive
 * TUI's layout — the same class of bug as the `logToContext` stderr write
 * fixed earlier in `auth-cli-helper.ts`.
 *
 * The CLI path is immune: `cursor-agent` is a child process whose stdout /
 * stderr are pipes the adapter reads. The SDK is in-process, so GSD has to
 * fence the console itself.
 *
 * Mechanism (mirrors `installSdkRejectionGuard`): the five console methods
 * are wrapped ONCE, permanently. Each wrapper consults a depth counter —
 * while an SDK pump is active (`depth > 0`) the call is dropped; otherwise
 * it passes through to the original method untouched. A counter, not a
 * boolean, keeps GSD's wave-parallel slices (overlapping SDK pumps) balanced.
 *
 * Dropped, not redirected: the SDK's genuine failures still surface through
 * the run API (`run.wait()` status, thrown errors) and the rejection guard —
 * the console channel is pure noise layered on top. Set
 * `GSD_CURSOR_SDK_CONSOLE=1` to opt out of the fence (e.g. when debugging the
 * SDK itself).
 */

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const GUARDED_METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

// `console` retyped so the guarded methods can be reassigned without fighting
// the `(...data: any[])` overloads on the platform console typings.
const consoleRef = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;

// UPSTREAM_REVIEW:C — module-level guard state. `depth` is the count of
// currently-open SDK console scopes; `installed` latches the one-time wrap.
let depth = 0;
let installed = false;
const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

// UPSTREAM_REVIEW:C — true while an SDK pump is active AND the user has not
// opted out via `GSD_CURSOR_SDK_CONSOLE`. The console wrappers consult this.
export function isSdkConsoleSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
	return depth > 0 && !env.GSD_CURSOR_SDK_CONSOLE;
}

// UPSTREAM_REVIEW:C — wrap the console methods exactly once for the process.
function install(): void {
	if (installed) return;
	installed = true;
	for (const method of GUARDED_METHODS) {
		const original = consoleRef[method].bind(console);
		originals.set(method, original);
		consoleRef[method] = (...args: unknown[]): void => {
			if (isSdkConsoleSuppressed()) return;
			original(...args);
		};
	}
}

// UPSTREAM_REVIEW:C — enter an SDK console scope: install-once, then depth++.
export function enterSdkConsoleScope(): void {
	install();
	depth += 1;
}

// UPSTREAM_REVIEW:C — leave an SDK console scope. Clamped at zero so an
// unbalanced call can never wedge the guard into permanent suppression.
export function exitSdkConsoleScope(): void {
	depth = Math.max(0, depth - 1);
}

// UPSTREAM_REVIEW:C — test hook: restore the original console methods and
// reset guard state so each suite case starts from a known baseline.
export function __resetSdkConsoleGuardForTests(): void {
	for (const [method, original] of originals) {
		consoleRef[method] = original;
	}
	originals.clear();
	installed = false;
	depth = 0;
}
