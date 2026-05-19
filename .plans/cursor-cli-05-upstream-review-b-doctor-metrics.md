# Cursor CLI #05 — `/cursor doctor` local metrics

## Status: DRAFT — Awaiting implementation

## Sequence

Step 5 of 6 in the cursor-cli roadmap. Depends on plans #01 (fixtures),
#02 (fake CLI shim), #03 (`/cursor` subcommand pattern), and #04
(`classifyCursorError` for `errorCode` field).

## Goal

A `/cursor doctor` slash command that prints a local-only ASCII table
of recent cursor-cli slice performance: p50/p95 latency, success rate,
total tokens, last-error reason. Metrics recording is on by default
with `GSD_CURSOR_METRICS_DISABLE=1` as the only opt-out. No persistent
boolean settings, no upstream-PR gating.

## Architecture

```
src/resources/extensions/cursor-cli/
├── metrics.ts                            # NEW: ring buffer + summariser
├── doctor.ts                             # NEW: snapshot → ASCII table
├── stream-adapter.ts                     # MODIFIED: record on final
├── auth-cli-helper.ts                    # MODIFIED: /cursor doctor case
└── tests/
    ├── metrics.test.ts                   # NEW
    ├── doctor-render.test.ts             # NEW
    ├── telemetry-leak-guard.test.ts      # NEW
    ├── upstream-review-markers.test.ts   # EXTEND for :B markers
    └── integration/
        └── stream-end-to-end.test.ts     # EXTEND: assert record landed
```

## Components

### `metrics.ts`

Exports:

```ts
export interface MetricEntry {
  startedAt: number;          // epoch ms
  finishedAt: number;         // epoch ms
  model: string;
  outcome: "success" | "error" | "aborted";
  errorCode?: string;         // from classifyCursorError (plan #04)
  inputTokens: number;
  outputTokens: number;
}

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

export function record(entry: MetricEntry): void;
export function snapshot(): MetricsSnapshot;
export function reset(): void;
export function isMetricsEnabled(env?: NodeJS.ProcessEnv): boolean;
```

Behaviour:

- Ring buffer of `RING_SIZE = 50` entries; oldest evicted on overflow.
- Hard cap at `RING_HARD_MAX = 1024` (asserted in `record()` against a
  mis-edit of `RING_SIZE`).
- `record()` is a no-op when `isMetricsEnabled()` returns false.
- `isMetricsEnabled()` returns `false` iff
  `process.env.GSD_CURSOR_METRICS_DISABLE === "1"`.
- `snapshot()` returns nulls for latency/success when `sampleCount === 0`.
- Branded `MetricsSnapshot` so accidental `JSON.stringify` in a
  telemetry path is a TypeScript error. The brand is type-only;
  construction returns the object via a single internal cast inside
  `metrics.ts` itself.

### `doctor.ts`

Exports:

```ts
export function renderDoctor(snapshot: MetricsSnapshot): string;
```

Behaviour:

- Pure function. Takes a snapshot, returns a multi-line ASCII string.
- Hand-rolled `padEnd`-based two-column layout (no `cli-table3` or
  similar — those aren't in any package.json).
- Stable output for snapshot tests: no timestamps in the rendering,
  no colour codes, no terminal-width-aware wrapping. If a future
  iteration wants colour, gate it behind a flag the test can
  disable.
- Empty-ring case prints `"no slices recorded yet"`.

### `stream-adapter.ts` changes

- Capture `startedAt = Date.now()` before `spawn()` inside
  `streamViaCursorCli`.
- Subscribe to the EventStream's terminal resolution. On terminal
  message, call `metrics.record({...})` derived from the
  `AssistantMessage`:
  - `outcome`: `stopReason === "stop"` → `"success"`,
    `"aborted"` → `"aborted"`, anything else → `"error"`.
  - `errorCode`: if `errorMessage` starts with `"<code>: "`, take
    the prefix; otherwise undefined. Plan #04's
    `classifyCursorError` may be reused if direct parsing turns out
    fragile.
- Wrap the `metrics.record()` call in `try/catch`. Recording
  failures must never break the stream.
- Tag every new line with `// UPSTREAM_REVIEW:B`.

### `auth-cli-helper.ts` changes

Add a `handleDoctor(args, ctx, pi)` function and a `case "doctor"`
in `handleRoot`'s switch. The handler calls
`renderDoctor(snapshot())` and `logToContext(ctx, rendered)`. Update
the unknown-subcommand error string to list `doctor`. Tag changes
with `// UPSTREAM_REVIEW:B`.

### `tests/metrics.test.ts`

- Empty ring → snapshot returns nulls for p50/p95/successRate.
- Single entry → p50 === p95 === entry latency.
- 50 entries with known sorted latencies → spot-check p50, p95
  against hand-computed values.
- Eviction past RING_SIZE keeps the most-recent 50.
- `outcome: "error"` and `outcome: "aborted"` contribute to
  `successRate` denominator but not to latency percentiles.
- `lastError` reflects the most recent `"error"` entry.
- `GSD_CURSOR_METRICS_DISABLE=1` → `record()` is a no-op.
- Hard cap: setting `RING_SIZE` above `RING_HARD_MAX` throws on
  next `record()` call.

### `tests/doctor-render.test.ts`

- Empty snapshot → `"no slices recorded yet"`.
- Snapshot with N=10 entries → stable formatted output (string
  literal in the test, byte-identical).
- Output contains all six columns (sampleCount, p50, p95,
  successRate, totalInput, totalOutput) plus the lastError line if
  present.

### `tests/telemetry-leak-guard.test.ts`

A grep-based reverse-dependency scan:

- `FORBIDDEN_REACH` set, hard-coded in the test file:
  ```ts
  const FORBIDDEN_REACH = [
    "src/resources/extensions/gsd/legacy-telemetry.ts",
    "src/resources/extensions/gsd/skill-telemetry.ts",
    "src/resources/extensions/gsd/worktree-telemetry.ts",
    "src/resources/extensions/gsd/auto-tool-tracking.ts",
  ];
  ```
- Walk `src/` and `packages/`. For every `.ts` file that imports any
  symbol from `cursor-cli/metrics.ts`, fail the test if that same
  file also imports from any path in `FORBIDDEN_REACH`.
- Skip `dist/`, `dist-test/`, `node_modules/`, `.git/`, the cursor-cli
  `tests/` directory.
- The test file's header comment documents the limitation: this is a
  shallow reverse-dependency scan, not a transitive call-graph
  analysis. A reviewer must still inspect any new importer of
  `metrics.ts` outside cursor-cli.

### `tests/upstream-review-markers.test.ts` extension

The file already exists from plan #04, with hard-coded
`EXPECTED_FILES_A` (currently named `EXPECTED_FILES`) and
`EXPECTED_MIN_TOTAL = 9` for `UPSTREAM_REVIEW:A`. Refactor:

- Rename to `EXPECTED_FILES_A` / `EXPECTED_MIN_TOTAL_A`.
- Add `EXPECTED_FILES_B` listing every cursor-cli file modified by
  this plan plus the marker-audit test itself.
- Add `EXPECTED_MIN_TOTAL_B` set to the count after this plan lands.
- The three existing tests now run for both letters. The sanity test
  asserts at least one hit per letter.

### Integration test extension

In `tests/integration/stream-end-to-end.test.ts`, add a test that:

- Calls `metrics.reset()` in `beforeEach`.
- Drives the `01-hello-text.ndjson` fixture through the fake CLI.
- After `await stream.result()`, asserts
  `snapshot().sampleCount === 1` and the recorded outcome is
  `"success"`.

## Files to create / modify

### Create

- `src/resources/extensions/cursor-cli/metrics.ts`
- `src/resources/extensions/cursor-cli/doctor.ts`
- `src/resources/extensions/cursor-cli/tests/metrics.test.ts`
- `src/resources/extensions/cursor-cli/tests/doctor-render.test.ts`
- `src/resources/extensions/cursor-cli/tests/telemetry-leak-guard.test.ts`

### Modify

- `src/resources/extensions/cursor-cli/stream-adapter.ts` — capture
  `startedAt`, record on terminal, wrapped in try/catch
- `src/resources/extensions/cursor-cli/auth-cli-helper.ts` —
  `/cursor doctor` subcommand
- `src/resources/extensions/cursor-cli/tests/upstream-review-markers.test.ts`
  — extend for :B markers
- `src/resources/extensions/cursor-cli/tests/integration/stream-end-to-end.test.ts`
  — assert one record per fixture run

## Acceptance criteria

- ✅ `metrics.test.ts` — p50/p95 math verified against hand-computed
  values; eviction, brand, and env opt-out covered.
- ✅ `doctor-render.test.ts` — stable formatted output.
- ✅ `telemetry-leak-guard.test.ts` — no `.ts` file importing from
  `metrics.ts` also imports from `FORBIDDEN_REACH`.
- ✅ Marker audit — every file modified by this plan carries at least
  one `// UPSTREAM_REVIEW:B`; `EXPECTED_MIN_TOTAL_B` floor matches the
  actual count.
- ✅ Recording never throws (try/catch verified by an explicit unit
  test that injects a faulty `record()` and confirms the stream still
  resolves).
- ✅ `npm run verify:pr` passes (modulo the known
  `custom-engine-loop-integration.test.ts` flake).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| The telemetry-leak guard's shallow scan misses transitive imports | Header-comment limitation; new importers of `metrics.ts` outside cursor-cli need code review |
| `RING_SIZE` mis-edited above `RING_HARD_MAX` | `record()` asserts the cap |
| `metrics.record()` throws and breaks the stream | try/catch around the call; unit test |
| Branded `MetricsSnapshot` requires `as any` casts at construction | Single internal cast inside `metrics.ts`; no `as any` anywhere else |

## Acceptance test command sequence

```bash
# Stay on feat/cursor-cli-full-power. Do not branch.

npm run test:compile

node --import ./scripts/dist-test-resolve.mjs \
  --experimental-test-isolation=process --test \
  "dist-test/src/resources/extensions/cursor-cli/tests/metrics.test.js" \
  "dist-test/src/resources/extensions/cursor-cli/tests/doctor-render.test.js" \
  "dist-test/src/resources/extensions/cursor-cli/tests/telemetry-leak-guard.test.js" \
  "dist-test/src/resources/extensions/cursor-cli/tests/upstream-review-markers.test.js"

# Full cursor-cli sweep
node --import ./scripts/dist-test-resolve.mjs \
  --experimental-test-isolation=process --test \
  "dist-test/src/resources/extensions/cursor-cli/tests/"*.test.js \
  "dist-test/src/resources/extensions/cursor-cli/tests/integration/"*.test.js

npm run verify:pr

# Manual smoke
node dist/loader.js
# Run a few slices through cursor-agent
# inside GSD: /cursor doctor
# Expect a populated table.
```
