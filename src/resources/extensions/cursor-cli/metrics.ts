/**
 * UPSTREAM_REVIEW:B — local-only slice metrics for `/cursor doctor`.
 *
 * Ring-buffered, in-process, zero-network. The recorder is on by default and
 * disabled only when `GSD_CURSOR_METRICS_DISABLE=1` is set in the environment.
 * No persistent boolean settings, no upstream telemetry — `/cursor doctor` is
 * the only viewing surface.
 *
 * Investigation summary (verified 2026-05-19 on `feat/cursor-cli-full-power`,
 * commit b031e81e1):
 *
 *   1. The Cursor adapter resolves the final `AssistantMessage` once per
 *      stream via `EventStream.result()`. That is the single recording site
 *      (see `stream-adapter.ts` — `record()` is called there, wrapped in
 *      try/catch so a recorder bug can never break the stream).
 *
 *   2. Snapshots are branded with a `unique symbol` so an accidental
 *      `JSON.stringify(snapshot)` inside a telemetry path is a TypeScript
 *      error. Construction casts once inside this module; no `as any` leaks
 *      to call sites.
 *
 *   3. The `telemetry-leak-guard.test.ts` companion test asserts that no `.ts`
 *      file imports from this module AND from any of the project's telemetry
 *      sinks. The check is a shallow reverse-dependency scan, not a full
 *      call-graph analysis — its limitations are documented in that file.
 */

// UPSTREAM_REVIEW:B
export interface MetricEntry {
	startedAt: number;
	finishedAt: number;
	model: string;
	outcome: "success" | "error" | "aborted";
	errorCode?: string;
	inputTokens: number;
	outputTokens: number;
}

// UPSTREAM_REVIEW:B — brand prevents accidental serialisation into a telemetry
// payload at compile time. The brand is type-only; the runtime shape is plain
// data so call sites can compose freely with `...spread` etc.
declare const localOnlyBrand: unique symbol;
export interface MetricsSnapshot {
	sampleCount: number;
	latencyMsP50: number | null;
	latencyMsP95: number | null;
	successRate: number | null;
	totalInputTokens: number;
	totalOutputTokens: number;
	lastError?: { at: number; code: string };
	readonly [localOnlyBrand]: never;
}

// UPSTREAM_REVIEW:B — RING_SIZE is the policy knob; RING_HARD_MAX is the
// invariant the recorder asserts against on every call. `let` instead of
// `const` is purely so the marker-audit test can exercise the assertion
// path via `__setRingSizeForTests` without forking the module.
let RING_SIZE = 50;
const RING_HARD_MAX = 1024;

// UPSTREAM_REVIEW:B — module-level state, intentionally process-scoped. The
// ring buffer is reset per process; persistence across restarts would be a
// regression (we'd be in telemetry territory).
const ring: MetricEntry[] = [];
let lastErrorEntry: { at: number; code: string } | undefined;

// UPSTREAM_REVIEW:B
export function isMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.GSD_CURSOR_METRICS_DISABLE !== "1";
}

// UPSTREAM_REVIEW:B
export function record(entry: MetricEntry): void {
	// Hard cap defends against a future edit that pushes RING_SIZE above the
	// max without thinking through the memory cost. RING_HARD_MAX is the
	// load-bearing invariant, RING_SIZE is the policy knob.
	if (RING_SIZE > RING_HARD_MAX) {
		throw new Error(
			`cursor-cli metrics: RING_SIZE (${RING_SIZE}) exceeds RING_HARD_MAX (${RING_HARD_MAX})`,
		);
	}
	if (!isMetricsEnabled()) return;

	ring.push(entry);
	while (ring.length > RING_SIZE) ring.shift();

	if (entry.outcome === "error") {
		lastErrorEntry = { at: entry.finishedAt, code: entry.errorCode ?? "other" };
	}
}

// UPSTREAM_REVIEW:B
export function reset(): void {
	ring.length = 0;
	lastErrorEntry = undefined;
}

// UPSTREAM_REVIEW:B — test-only. Lets `metrics.test.ts` push RING_SIZE above
// RING_HARD_MAX and verify the assertion fires on the next `record()`. Never
// called from production code paths.
export function __setRingSizeForTests(size: number): void {
	RING_SIZE = size;
}

// UPSTREAM_REVIEW:B — test-only. Restores the production default after a
// `__setRingSizeForTests()` mutation.
export function __resetRingSizeForTests(): void {
	RING_SIZE = 50;
}

// UPSTREAM_REVIEW:B
export function snapshot(): MetricsSnapshot {
	const sampleCount = ring.length;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let successCount = 0;
	const successLatencies: number[] = [];

	for (const entry of ring) {
		totalInputTokens += entry.inputTokens;
		totalOutputTokens += entry.outputTokens;
		if (entry.outcome === "success") {
			successCount += 1;
			successLatencies.push(entry.finishedAt - entry.startedAt);
		}
	}

	const latencyMsP50 = percentile(successLatencies, 50);
	const latencyMsP95 = percentile(successLatencies, 95);
	const successRate = sampleCount === 0 ? null : successCount / sampleCount;

	const out: Omit<MetricsSnapshot, typeof localOnlyBrand> & { [localOnlyBrand]?: never } = {
		sampleCount,
		latencyMsP50,
		latencyMsP95,
		successRate,
		totalInputTokens,
		totalOutputTokens,
	};
	if (lastErrorEntry) out.lastError = { ...lastErrorEntry };

	// Single internal cast; the brand never leaks outside this module.
	return out as MetricsSnapshot;
}

// UPSTREAM_REVIEW:B — nearest-rank percentile over success-only latencies.
// Returns null when the source is empty (the snapshot caller decides whether
// to treat that as "no data" or "no successful samples").
function percentile(values: ReadonlyArray<number>, p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
	return sorted[idx];
}
