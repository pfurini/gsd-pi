/**
 * UPSTREAM_REVIEW:C — opt-in usage tracer for diagnosing CLI-vs-SDK token
 * accounting discrepancies.
 *
 * Disabled unless `GSD_CURSOR_USAGE_LOG` is set to a writable file path. When
 * set, each adapter appends one JSON line per usage-bearing event so a CLI
 * run and an SDK run of the same prompt can be compared field-by-field
 * (input vs cacheRead, per-turn vs aggregate, turn count).
 *
 * Why a file and not stderr: a raw stderr write corrupts the interactive
 * TUI's layout (the same class of bug fixed in `auth-cli-helper.ts`'s
 * `logToContext`). A user-named file is the only sink that is safe
 * regardless of how GSD was launched.
 *
 * Append-only and best-effort: any write failure is swallowed so a
 * diagnostic can never break a slice. No network, no telemetry.
 */

import { appendFileSync } from "node:fs";

// UPSTREAM_REVIEW:C
export interface UsageTraceEntry {
	/** Which adapter produced the entry. */
	path: "cli" | "sdk";
	/** Event kind — e.g. "start", "result", "turn-ended", "final". */
	event: string;
	/** Raw usage block, logged verbatim (no remapping). `null` when absent. */
	usage?: unknown;
	/** Free-form extra context (args, cwd, turn index, tallies, …). */
	[extra: string]: unknown;
}

// UPSTREAM_REVIEW:C
export function isUsageTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.GSD_CURSOR_USAGE_LOG && env.GSD_CURSOR_USAGE_LOG.trim());
}

// UPSTREAM_REVIEW:C
/**
 * Append one JSON line to the trace file named by `GSD_CURSOR_USAGE_LOG`.
 * No-op when the variable is unset. Never throws.
 */
export function traceUsage(
	entry: UsageTraceEntry,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const target = env.GSD_CURSOR_USAGE_LOG?.trim();
	if (!target) return;
	try {
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		appendFileSync(target, `${line}\n`, "utf8");
	} catch {
		// Best-effort — a diagnostic write must never surface to the caller.
	}
}
