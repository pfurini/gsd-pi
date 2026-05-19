# Cursor CLI #05 — `UPSTREAM_REVIEW:B` Comparative doctor metrics (local-only)

## Status: DRAFT — Awaiting implementation

## Sequence
This is **step 5 of 6** in the cursor-cli roadmap. Second of three
fork-only-flagged plans (the parent plan's "Upstream PR Posture B").

Depends on plans #01 (fixtures), #02 (fake CLI shim), and ideally #03
(`/cursor` status command already exists). Does not require plan #04.

## Problem

The parent plan's "Upstream PR Posture B" item:

> `/cursor` status overview and `gsd doctor` output for `cursor-agent`
> include latency, success rate, and token-cost columns side-by-side with
> other providers.

This is the "make Cursor's value as a backend visible" feature: when the
user has both `claude-code-cli` and `cursor-agent` (and possibly Ollama,
OpenAI Codex, etc.) configured, they want a single screen showing recent
performance per provider — p50/p95 latency, success rate, total tokens
consumed, last-N session breakdown — so they can pick the best provider
for their next slice.

The tension that makes this fork-only candidate: Cursor's ToS §1.5(vii)
restricts *publishing* benchmarks of the service. Local diagnostic display
isn't publishing, but the line is fuzzy enough that maintainers may
prefer this stay opt-in or fork-only.

The defence framing per the parent plan:

> Data stays strictly local — never collected as GSD telemetry, never
> aggregated cross-user, never exported. Upstream PR ships with an
> explicit "no comparative cursor metrics in any telemetry sink"
> assertion plus a test that fails if any metric flows into a
> telemetry path.

## Goal

Two surfaces, one telemetry guardrail:

1. **`/cursor doctor`** — slash command that prints a local-only
   comparison table of recent slice performance across all configured
   providers, with Cursor's column populated from the cursor-cli
   adapter's in-memory metrics ring buffer.

2. **`gsd doctor` extension hook** — if GSD's existing `gsd doctor`
   command supports per-provider sections, register cursor-cli's metrics
   contributor to extend that output. (If `gsd doctor` doesn't exist or
   doesn't have an extension hook, ship only the slash command — the
   investigation step decides.)

3. **Telemetry guardrail** — an enforced assertion (compile-time AND
   runtime test) that none of these metrics ever flow into a telemetry
   sink. The audit test fails CI if any metric symbol is reachable from
   a known telemetry export.

Every source location is tagged `// UPSTREAM_REVIEW:B`.

## Scope

### In scope

- An in-memory ring buffer in the cursor-cli extension that records the
  last N (default 50) slice attempts: start time, end time, model id,
  outcome (success / error / aborted), error code, input + output tokens.
- A pure-function summariser that turns the ring into p50 / p95 latency,
  success rate, total tokens, last-seen error.
- `/cursor doctor` (a new subcommand of the existing `/cursor` slash
  command) that prints the local Cursor section.
- A "comparative" view in `/cursor doctor` that calls each registered
  provider's metrics contributor (if registered) and renders a single
  table. The cursor-cli extension is the *first* contributor; the
  comparative view is empty / Cursor-only until other providers register
  their own contributors. (This means cursor-cli does not depend on
  any other provider for the comparative view to render — it just
  iterates whatever's registered.)
- The metrics contributor is a Layer 2 ExtensionEvent or
  `pi.registerCommand` callback contract — investigation decides.
- Telemetry guardrail:
  - The metrics module exports a `MetricsSnapshot` type that is opaque
    (e.g., `Symbol`-tagged or `Brand`-tagged) so type-checking forbids
    accidentally serialising it.
  - A new test `tests/telemetry-leak-guard.test.ts` that searches the
    codebase for any export from `cursor-cli/metrics.ts` reaching
    `telemetry`, `analytics`, `posthog`, `mixpanel`, or any send-to-network
    surface. Fails CI on any hit.
- `// UPSTREAM_REVIEW:B` markers on every changed line.

### Out of scope

- Persisting metrics across sessions. Ring buffer is RAM only; sliced
  history vanishes on restart.
- Cross-provider correlation (e.g., "the same task took X on Cursor vs
  Y on Claude"). The view just shows independent provider stats.
- Dollar-cost estimation. Cursor's quota is invisible to GSD; show token
  counts only.

## Investigation (must be done first)

1. **Does `gsd doctor` exist?** Search the codebase for a `doctor` command
   under `src/resources/extensions/gsd/` or as a CLI subcommand of
   `gsd`. If yes, read its source to find the extension hook point. If
   no, the plan shrinks to just `/cursor doctor`.
2. **Is there an existing metrics / telemetry pipeline?** Search for
   imports of telemetry libraries (`posthog`, `mixpanel`, `@anthropic-ai/...`-
   internal-telemetry, custom `report` helpers). Catalogue every export
   point that crosses the network or persists outside the user's machine.
   These are the **forbidden reach** set for the guardrail test.
3. **Where do provider metrics currently live?** If GSD already tracks
   per-slice latency / tokens centrally (e.g., from `result.usage` mapping
   in each provider adapter), reuse that source rather than duplicating
   collection in the cursor-cli extension. The investigation report should
   say which is the case.

## Architecture

```
src/resources/extensions/cursor-cli/
├── metrics.ts                         # NEW: ring buffer + summariser
├── doctor.ts                          # NEW: /cursor doctor renderer
├── stream-adapter.ts                  # MODIFIED: emit metrics on stream finish
├── auth-cli-helper.ts                 # MODIFIED: /cursor doctor subcommand
└── tests/
    ├── metrics.test.ts                # ring buffer + summariser
    ├── telemetry-leak-guard.test.ts   # forbidden-reach assertion
    └── doctor-render.test.ts          # table rendering snapshots
```

`metrics.ts`:

```ts
// UPSTREAM_REVIEW:B — local-only metrics ring buffer.
// See .plans/cursor-cli-05-upstream-review-b-doctor-metrics.md
// CRITICAL: nothing exported from this module may flow into any
// telemetry / analytics / network egress surface. See the audit test
// in tests/telemetry-leak-guard.test.ts.

const RING_SIZE = 50;

export interface MetricEntry {
    startedAt: number;        // epoch ms
    finishedAt: number;       // epoch ms
    model: string;
    outcome: "success" | "error" | "aborted";
    errorCode?: string;       // "quota_exhausted", etc.
    inputTokens: number;
    outputTokens: number;
}

const ring: MetricEntry[] = [];

export function record(entry: MetricEntry): void {
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();
}

export interface MetricsSnapshot {
    sampleCount: number;
    latencyMsP50: number | null;
    latencyMsP95: number | null;
    successRate: number | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    lastError?: { at: number; code: string };
    // Branded so accidental JSON.stringify in a telemetry call fails type-check.
    readonly __local_only: unique symbol;
}

export function snapshot(): MetricsSnapshot { ... }
export function reset(): void { ring.length = 0; }
```

`doctor.ts` renders the snapshot as ASCII via the project's existing
table helper if any (search for `boxen` / `cli-table3` / hand-rolled).

`stream-adapter.ts` change: at every terminal event (`done`, `error`,
`aborted`), call `metrics.record({...})`. Tag with `// UPSTREAM_REVIEW:B`.

## Implementation steps

1. **Investigation** — record findings as code-comments in `metrics.ts`.
2. **Write `metrics.ts`** with the ring + summariser. Brand the snapshot
   type. Unit-test ring eviction, p50/p95 math, empty-ring case.
3. **Modify `stream-adapter.ts`** to record at every terminal event.
   Wrap the call in a try/catch so metrics never break the stream.
4. **Write `doctor.ts`** with the rendering function. Snapshot-test the
   output for stable formatting.
5. **Modify `auth-cli-helper.ts`**:
   - Add `/cursor doctor` subcommand that calls
     `renderDoctor(snapshot())`.
   - If GSD has a multi-provider doctor hook (investigation), register
     the contributor.
6. **Add the telemetry-leak guard test**:
   - Read every `.ts` file under `src/` and `packages/`.
   - For any import of `cursor-cli/metrics.ts` symbols, walk the function
     calls within the same file. If any of those calls reaches a function
     whose name matches the forbidden set (`/telemetry|analytics|track|posthog|mixpanel|sendEvent/i`),
     fail the test with a precise file:line:symbol report.
   - This is a static analysis. Imperfect, but practical. Document
     limitations.
7. **Add the marker-audit assertion** to the same test file (or its
   sibling): every file modified for this plan contains at least one
   `// UPSTREAM_REVIEW:B` line.
8. **Manual smoke test**: drive a few slices through cursor-cli, run
   `/cursor doctor`, confirm the table renders sensibly.

## Files to create / modify

### Create

- `src/resources/extensions/cursor-cli/metrics.ts`
- `src/resources/extensions/cursor-cli/doctor.ts`
- `src/resources/extensions/cursor-cli/tests/metrics.test.ts`
- `src/resources/extensions/cursor-cli/tests/doctor-render.test.ts`
- `src/resources/extensions/cursor-cli/tests/telemetry-leak-guard.test.ts`
- `src/resources/extensions/cursor-cli/tests/upstream-review-markers.test.ts`
  (if not yet created by plan #04 — share the audit assertion)

### Modify

- `src/resources/extensions/cursor-cli/stream-adapter.ts` — record at
  every terminal event
- `src/resources/extensions/cursor-cli/auth-cli-helper.ts` — add
  `/cursor doctor` subcommand

## Compliance posture (fork-only justification)

The parent plan offers this defence framing:

> Data stays strictly local — never collected as GSD telemetry, never
> aggregated cross-user, never exported.

The technical guarantees:

- **Branded type** for `MetricsSnapshot` — TypeScript prevents
  accidental JSON-serialisation into network paths.
- **Telemetry-leak guard test** — fails CI on any call graph reaching
  a forbidden-reach symbol.
- **No persistence** — ring buffer is RAM only; restarting GSD loses
  history.
- **Per-process scope** — multiple GSD instances on the same machine
  don't share state.

Three upstream-PR postures the maintainer can accept:

**A. Land as-is, gated off by default.** A new boolean
`cursor.comparative_doctor` defaulting to false; `/cursor doctor`
exists but prints "disabled in upstream build" unless set.

**B. Land only the metrics ring, no UI.** Other extensions (claude-code-cli,
ollama) can later consume the snapshot type for their own diagnostics.
Drop `/cursor doctor` and `doctor.ts`.

**C. Land nothing — keep fork-only.** The whole plan stays on
`feat/cursor-cli-full-power` and `personal`; no upstream PR.

Option (A) is the most useful and least risky if the maintainer wants
to ship. Default-off + the audit test = a real defence.

## Testing strategy

- Unit tests for `metrics.ts`:
  - empty ring → snapshot returns nulls
  - 1 entry → p50 == p95 == entry latency
  - 50 entries, sorted latencies → spot-check p50 / p95
  - eviction past RING_SIZE
  - error / aborted entries contribute to successRate calculation but
    not latency
- Snapshot test for `doctor.ts` rendering (stable output for a known
  input).
- The telemetry-leak guard test is itself the security control.
- The marker audit asserts at least one `// UPSTREAM_REVIEW:B` per
  changed file.
- Integration: drive a fixture through the fake CLI (plan #02), assert
  one new entry lands in the ring.

## Acceptance criteria

- ✅ Ring buffer math correct (p50/p95 verified against hand-computed
  expected values).
- ✅ Snapshot type is branded so TS forbids JSON.stringify into telemetry
  sinks.
- ✅ `/cursor doctor` prints a readable table.
- ✅ `gsd doctor` (if it exists with a hook) includes the Cursor section.
- ✅ telemetry-leak guard test passes (no reach into forbidden symbols).
- ✅ Marker audit returns at least one hit per changed file.
- ✅ Recording never throws — even if the snapshot logic regresses, the
  stream is unaffected (try/catch around the record call).
- ✅ `npm run verify:pr` passes.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| The telemetry-leak guard is too coarse (static analysis can't catch indirection) | Document the limitation; require code review for any change that imports `metrics.ts` symbols outside cursor-cli; mark with `// UPSTREAM_REVIEW:B no-telemetry-confirmed` at the call site |
| Ring buffer grows unbounded if RING_SIZE constant is misedited | Guard with an assertion in `record()`; cap to a hard MAX of 1024 |
| Recording on every terminal event introduces latency | Push to ring is O(1); the gating concern is the wall-clock measurement, which we already have from existing timestamps. Negligible. |
| `gsd doctor` extension hook doesn't exist | Ship only `/cursor doctor`; document the gap |
| The audit test's regex catches false positives in unrelated files | Scope the static analysis to "modules that import from cursor-cli/metrics.ts" — narrow blast radius |

## Branch & upstream posture

- **Fork-only by default.** Lives on `feat/cursor-cli-full-power`.
- Every change tagged `// UPSTREAM_REVIEW:B`.
- The telemetry-leak guard test is the cornerstone of any upstream-PR
  defence — keep it intact even if other commits are stripped.

## Open questions

1. **Cross-provider hook contract.** If GSD's doctor command has an
   extension hook, what's its signature? Investigation answers this.
   Most likely path: a `pi.registerDoctorContributor(name, fn)` API.
   If that doesn't exist yet, this plan should NOT add it — open a
   follow-up upstream issue for the API.
2. **Table-rendering library.** Inspect dependencies — if `cli-table3`
   or similar is already a dev/prod dep, use it. Otherwise hand-roll a
   minimal `padEnd`-based formatter (no new dependency).
3. **Should metrics be on by default?** Recommend yes — the data is
   local-only and the UI is opt-in (`/cursor doctor` must be typed).
   But a `GSD_CURSOR_METRICS_DISABLE=1` opt-out should exist for users
   who don't want any in-memory recording.

## Acceptance test command sequence (for a new agent)

```bash
git checkout feat/cursor-cli-full-power
git checkout -b feat/cursor-cli-doctor-metrics

# Investigation step → record findings inline in metrics.ts top comment
# Implementation per "Implementation steps"

# audit markers + telemetry guard
rg "UPSTREAM_REVIEW:B" src/
npm run test:compile
node --import ./scripts/dist-test-resolve.mjs --experimental-strip-types \
  --test "dist-test/src/resources/extensions/cursor-cli/tests/telemetry-leak-guard.test.js" \
         "dist-test/src/resources/extensions/cursor-cli/tests/metrics.test.js" \
         "dist-test/src/resources/extensions/cursor-cli/tests/doctor-render.test.js"

# preflight
npm run verify:pr

# manual smoke
node dist/loader.js
# run a few slices through cursor-cli
# inside GSD: /cursor doctor    → table renders, populated entries
#             /cursor doctor    → run twice; latency stats stable
```
