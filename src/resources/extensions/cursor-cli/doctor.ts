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
export function renderDoctor(snapshot: MetricsSnapshot, adapter?: string): string {
	// UPSTREAM_REVIEW:C — the resolved adapter ("sdk" / "cli", with a
	// fallback note when the runtime path differs from the configured
	// `cursor.adapter` setting) renders as a trailing line, mirroring the
	// `last error:` summary. Kept outside the table so it surfaces even in
	// the no-data case and never perturbs the table's fixed column widths.
	const adapterLine = adapter ? `adapter: ${adapter}` : undefined;

	if (snapshot.sampleCount === 0) {
		const sentinel = "no slices recorded yet";
		return adapterLine ? `${sentinel}\n${adapterLine}` : sentinel;
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

	// UPSTREAM_REVIEW:C — adapter line last, after the optional error line.
	if (adapterLine) lines.push(adapterLine);

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
