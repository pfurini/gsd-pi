/**
 * UPSTREAM_REVIEW:B — pure renderer for `/cursor doctor`.
 *
 * Takes a `MetricsSnapshot` (the branded local-only type from `metrics.ts`)
 * and produces a stable, byte-deterministic ASCII table. No colour codes, no
 * timestamps, no terminal-width-aware wrapping — those would all break the
 * snapshot tests and make future iteration noisy.
 *
 * Why hand-rolled instead of a table library: nothing in the GSD tree pulls
 * in `cli-table3` / `table` / similar, and the table is two columns. A 30-line
 * `padEnd` helper is less surface area than a new dep.
 */

import type { MetricsSnapshot } from "./metrics.js";

// UPSTREAM_REVIEW:B
export function renderDoctor(snapshot: MetricsSnapshot): string {
	if (snapshot.sampleCount === 0) {
		return "no slices recorded yet";
	}

	const rows: Array<[string, string]> = [
		["samples", String(snapshot.sampleCount)],
		["p50 latency (ms)", formatNumber(snapshot.latencyMsP50)],
		["p95 latency (ms)", formatNumber(snapshot.latencyMsP95)],
		["success rate", formatRate(snapshot.successRate)],
		["total input tokens", String(snapshot.totalInputTokens)],
		["total output tokens", String(snapshot.totalOutputTokens)],
	];

	const labelWidth = Math.max(...rows.map(([k]) => k.length));
	const valueWidth = Math.max(...rows.map(([, v]) => v.length));

	const lines: string[] = [];
	lines.push(border(labelWidth, valueWidth));
	for (const [label, value] of rows) {
		lines.push(
			`| ${label.padEnd(labelWidth, " ")} | ${value.padEnd(valueWidth, " ")} |`,
		);
	}
	lines.push(border(labelWidth, valueWidth));

	if (snapshot.lastError) {
		// One-line trailing summary. Kept outside the table because table rows
		// have a fixed two-column shape and last-error wants three fields
		// (code + when) plus humans want it visually distinct from the table.
		lines.push(
			`last error: ${snapshot.lastError.code} @ ${snapshot.lastError.at}`,
		);
	}

	return lines.join("\n");
}

// UPSTREAM_REVIEW:B
function border(labelWidth: number, valueWidth: number): string {
	return `+-${"-".repeat(labelWidth)}-+-${"-".repeat(valueWidth)}-+`;
}

// UPSTREAM_REVIEW:B
function formatNumber(value: number | null): string {
	if (value === null) return "—";
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(1);
}

// UPSTREAM_REVIEW:B
function formatRate(value: number | null): string {
	if (value === null) return "—";
	return `${(value * 100).toFixed(1)}%`;
}
