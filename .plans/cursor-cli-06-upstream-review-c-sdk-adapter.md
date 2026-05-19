# Cursor CLI #06 — `UPSTREAM_REVIEW:C` Native `@cursor/sdk` adapter (Phase 2)

## Status: DRAFT — Awaiting implementation

## Sequence
This is **step 6 of 6** in the cursor-cli roadmap and the third
fork-only-flagged plan ("Upstream PR Posture C" in the parent plan).
Do this **last** — biggest surface, most external dependency churn.

Depends on plans #01 (fixtures — used in dual-path validation), #02 (fake
CLI shim — proves CLI path still works after SDK lands), and #03
(`allowsWrites` — must propagate via the SDK path too).

## Problem

The parent plan's "Upstream PR Posture C" item:

> The SDK path (`@cursor/sdk`) surfaces Cursor's MCP servers, Skills,
> Hooks, and subagents into GSD slices — letting a slice driven by
> `cursor-agent` use Cursor's harness end-to-end.

Today only the CLI path exists. That gives the user multi-model routing
but no access to:
- Cursor's MCP server registry (Cursor surfaces a richer MCP set than
  GSD's own integrations).
- Cursor Skills (Cursor's analogue of Claude Code Skills — extra
  domain-specific behaviour the user has configured in Cursor's UI).
- Cursor Hooks (pre / post-tool hooks the user has set up).
- Cursor Subagents (multi-agent decomposition the user has configured).
- Lower-latency event handoff (no subprocess boundary, no NDJSON parsing).
- `Agent.create({ cloud: {...} })` for sandboxed cloud VMs.

The parent plan defers this to Phase 2 explicitly because `@cursor/sdk`
was labelled public beta at the time of writing.

The tension that makes this fork-only candidate: surfacing Cursor's full
harness under GSD's UI looks more like "GSD is a wrapper around Cursor"
than "GSD orchestrates work that's executed by Cursor." ADR §2.4 cares
about that distinction.

The parent plan's defence framing:

> Position as a passthrough, not a re-implementation. The slice runs
> *inside* the Cursor harness; GSD doesn't proxy or rebrand. Mirrors what
> `claude-code-cli` already does for Claude Code's MCP / skills.

## Goal

A second streaming path inside `cursor-cli/` that:

1. Is selected via a persistent setting `cursor.adapter` (string,
   `"sdk" | "cli"`, default `"sdk"`). Users switch to the CLI path by
   setting `cursor.adapter = "cli"` in settings.json or by running
   `/cursor adapter cli`. No environment variable, no hidden flag.
2. Dynamically imports `@cursor/sdk` (no hard dependency in package.json
   if avoidable — match `claude-code-cli`'s pattern with
   `createRequire(import.meta.url).resolve(...)`). On resolve failure
   while `cursor.adapter === "sdk"`, logs a one-line warning and falls
   back to the CLI path for the current process.
3. Drives `Agent.create({ apiKey: <env>, model, local: { cwd } })` and
   consumes `run.stream()`, mapping the discriminated `SDKMessage` union
   into the same `AssistantMessageEvent`s the CLI path emits.
4. Honours all of the parent plan's contracts: redaction, abort, usage
   reporting, `allowsWrites` (from plan #03), quota classification
   (from plan #04), metrics recording (from plan #05).
5. Surfaces Cursor MCP / Skills / Hooks / Subagents as passthrough
   (slice runs inside Cursor's harness; GSD does not proxy individual
   tool calls).

Every change tagged `// UPSTREAM_REVIEW:C`.

## Scope

### In scope

- `sdk-adapter.ts` — the SDK-driven stream path. Same public function
  signature as `streamViaCursorCli` (returns `AssistantMessageEventStream`).
- `sdk-types.ts` extension — additional type mirrors for the SDK message
  union (NOT a hard dependency on `@cursor/sdk`).
- A path-selector wrapper that the extension entry point uses:
  reads `cursor.adapter` from settings.json; if `"sdk"` (default),
  tries dynamic import and on success uses the SDK adapter; on import
  failure logs + falls back to CLI for the current process. If
  `"cli"`, skips the SDK probe entirely and uses the CLI path.
- Shared event-translation primitives between CLI and SDK paths: the
  partial-builder, `mapCursorEvent` shape, and the
  `AssistantMessageEvent` emitter should be re-usable.
- Tests:
  - SDK message → GSD event mapping (unit tests using mock SDK)
  - setting-driven path-selector tests (`cursor.adapter` = `"sdk"` /
    `"cli"` / unset / invalid value)
  - dynamic-import fallback test (when SDK is missing and the setting
    is `"sdk"`)
  - `/cursor adapter <sdk|cli>` subcommand writes the setting
- `// UPSTREAM_REVIEW:C` markers.
- Document the passthrough story in the file header — what GSD does NOT
  proxy.

### Out of scope (for this plan)

- Cloud-VM execution (`Agent.create({ cloud: ... })`). Mentioned in
  parent plan as a *future* surface. Punt to a follow-up.
- Per-tool-call rendering customisation. The CLI path treats Cursor's
  tool calls as opaque external execution; the SDK path should do the
  same. (Slice still gets the ToolCall block in its AssistantMessage
  history, but the execution lives inside Cursor.)
- Removing the CLI path. SDK is the default; CLI remains a fully
  supported selection users can switch to via `cursor.adapter = "cli"`
  (e.g., for environments where the SDK can't initialise, or when
  diagnosing a suspected SDK regression).

## Investigation (must be done first)

1. **Verify SDK availability.** Confirm `@cursor/sdk` exists in npm at
   the time of implementation. Check current version and beta status.
2. **Read the SDK's public API.** Specifically:
   - `Agent.create({ apiKey, model, local: { cwd } })` signature
   - `run.stream()` return type — discriminated union of message types
   - Tool / hook / skill registration paths — confirm passthrough is
     possible (i.e., GSD doesn't have to register tools individually;
     the agent picks up the user's existing Cursor configuration)
   - Abort semantics — does the SDK accept an `AbortSignal`?
3. **Compare SDK message types to CLI NDJSON types.** The CLI's
   `--output-format stream-json` was modelled after the SDK's
   discriminated union; the shapes should be very similar, but verify.
   Document the deltas.
4. **Auth flow.** The SDK takes an `apiKey`. Confirm `CURSOR_API_KEY`
   is the right value, OR confirm whether the SDK can use a
   credential file that `cursor-agent login` wrote.

If `@cursor/sdk` is not yet on npm or its API has diverged from the
parent-plan description, this plan becomes a **placeholder**: ship just
the path-selector + dynamic-import fallback + feature-flag guard, with
the SDK call sites stubbed to throw `"sdk_unavailable"` and the test
matrix updated. Document the gap.

## Architecture

```
src/resources/extensions/cursor-cli/
├── sdk-adapter.ts                     # NEW: SDK-driven streamSimple
├── sdk-types.ts                       # MODIFIED: add SDK message union mirrors
├── sdk-runtime.ts                     # NEW: dynamic-import resolver
├── path-selector.ts                   # NEW: chooses SDK vs CLI per call
├── stream-adapter.ts                  # MODIFIED: extract shared event-translation
│                                      # primitives into a separate module
├── stream-translation.ts              # NEW (refactor): shared mapCursorEvent
└── tests/
    ├── sdk-adapter.test.ts            # NEW: mock SDK, drive translation
    ├── path-selector.test.ts          # NEW: feature-flag selection
    └── sdk-runtime.test.ts            # NEW: dynamic-import fallback
```

The path selector:

```ts
// UPSTREAM_REVIEW:C — Phase 2 SDK passthrough path.

import { redactSecrets } from "./redact.js";
import { readCursorAdapterSetting } from "./adapter-setting.js";

let cachedSdk: unknown | null | undefined = undefined;

async function loadSdk(): Promise<unknown | null> {
    if (cachedSdk !== undefined) return cachedSdk as unknown | null;
    try {
        cachedSdk = await import(/* webpackIgnore: true */ "@cursor/sdk");
        return cachedSdk;
    } catch (err) {
        const msg = redactSecrets((err as Error).message);
        process.stderr.write(`[cursor-cli] @cursor/sdk import failed (${msg}); falling back to CLI path.\n`);
        cachedSdk = null;
        return null;
    }
}

export async function pickStreamPath() {
    const selected = readCursorAdapterSetting();   // "sdk" | "cli"
    if (selected === "cli") return { kind: "cli" as const };
    const sdk = await loadSdk();
    return sdk
        ? { kind: "sdk" as const, sdk }
        : { kind: "cli" as const };
}
```

`adapter-setting.ts` reads `cursor.adapter` from the global
settings.json (path resolved via `getSettingsPath()` from
`@gsd/pi-coding-agent`), defaulting to `"sdk"`. Invalid values fall
back to the default and emit a one-line stderr warning. A companion
`writeCursorAdapterSetting(value)` performs an atomic file lock +
JSON merge so `/cursor adapter` and direct file edits don't race.

The `index.ts` registration changes from:

```ts
streamSimple: streamViaCursorCli,
```

to:

```ts
streamSimple: streamViaCursor,  // dispatches to SDK or CLI per pickStreamPath()
```

with `streamViaCursor` doing:

```ts
export function streamViaCursor(model, context, options): AssistantMessageEventStream {
    const stream = createAssistantStream();
    void (async () => {
        const path = await pickStreamPath();
        if (path.kind === "sdk") {
            await pumpViaSdk(path.sdk, model, context, options, stream);
        } else {
            await pumpCursorMessages(model, context, options, stream);  // existing
        }
    })();
    return stream;
}
```

## Implementation steps

1. **Investigation** — confirm `@cursor/sdk` is published and current.
   Record findings in `sdk-runtime.ts`'s file header.
2. **Refactor — extract shared translation.** Pull `mapCursorEvent`,
   `attachExternalResultsToToolBlocks`, `buildFinalAssistantContent`,
   and the supporting types out of `stream-adapter.ts` into
   `stream-translation.ts`. CLI adapter imports them; SDK adapter will
   too. No behaviour change; tests stay green.
3. **Add path-selector** with dynamic-import + fallback logic.
4. **Write `sdk-adapter.ts`** that:
   - Calls `Agent.create({ apiKey: process.env.CURSOR_API_KEY, model:
     model.id, local: { cwd: resolveCwd(options) } })`.
   - Wraps `run.stream()` in a for-await loop.
   - Translates each SDK message into one or more
     `AssistantMessageEvent`s via the shared translation module.
   - Honours `options.signal` via the SDK's abort surface (if any) OR
     by manual cancellation if not.
   - Records to metrics ring (plan #05) at every terminal event.
   - Records `quota_exhausted` via classifier (plan #04) on SDK error
     messages.
   - Honours `allowsWrites` (plan #03) — pass to SDK via whatever
     option the SDK exposes (TBD by investigation).
5. **Add tests**:
   - `sdk-adapter.test.ts`: mock the SDK as a synthesised AsyncIterable
     of `SDKMessage` values; drive `pumpViaSdk`; assert event emission.
   - `path-selector.test.ts`: setting `"sdk"` + SDK present → sdk path;
     setting `"sdk"` + SDK missing → cli fallback; setting `"cli"` →
     cli path (SDK probe skipped); setting missing → defaults to
     `"sdk"`; invalid setting value → defaults to `"sdk"` with
     stderr warning.
   - `sdk-runtime.test.ts`: importing a missing module returns null
     and warns to stderr (matched against `redactSecrets` output).
   - `adapter-setting.test.ts`: read default, read explicit value,
     write + read round-trip, invalid value handling, concurrent
     write safety.
6. **Update `/cursor status`** (`auth-cli-helper.ts`) to report the
   active path (`"adapter: sdk (beta)"` or `"adapter: cli"`) and add
   a `/cursor adapter [sdk|cli]` subcommand: with no argument, prints
   the current setting; with an argument, writes it and clears any
   path-selector caches so the next slice picks up the change.
7. **Add to integration suite (plan #02)**: extend the fake CLI shim
   strategy with a parallel SDK-shim — a small ESM module that
   exports a fake `Agent` class. Mount it via dynamic-import
   redirection (e.g., `require.cache` rewrite or `moduleResolution`
   override in the test bootstrap).
8. **Mark every site** with `// UPSTREAM_REVIEW:C`.
9. **Tag fixture variants**: if SDK and CLI emit subtly different
   shapes, capture an SDK-path fixture (plan #01 style) and add an
   `--via=sdk` flag to the `capture.sh` script that uses the SDK
   instead of the CLI for capture. Snapshot test the SDK path against
   the SDK fixture.

## Files to create / modify

### Create

- `src/resources/extensions/cursor-cli/sdk-adapter.ts`
- `src/resources/extensions/cursor-cli/sdk-runtime.ts`
- `src/resources/extensions/cursor-cli/path-selector.ts`
- `src/resources/extensions/cursor-cli/adapter-setting.ts`
- `src/resources/extensions/cursor-cli/stream-translation.ts` (refactor)
- `src/resources/extensions/cursor-cli/tests/sdk-adapter.test.ts`
- `src/resources/extensions/cursor-cli/tests/sdk-runtime.test.ts`
- `src/resources/extensions/cursor-cli/tests/path-selector.test.ts`
- `src/resources/extensions/cursor-cli/tests/adapter-setting.test.ts`
- (optional) `src/resources/extensions/cursor-cli/tests/integration/fake-sdk.mjs`

### Modify

- `src/resources/extensions/cursor-cli/sdk-types.ts` — extend with SDK
  message union mirrors
- `src/resources/extensions/cursor-cli/stream-adapter.ts` — slimmed
  (translation primitives moved out); CLI pump now imports from
  `stream-translation.ts`
- `src/resources/extensions/cursor-cli/index.ts` — register
  `streamViaCursor` instead of `streamViaCursorCli`
- `src/resources/extensions/cursor-cli/auth-cli-helper.ts` — `/cursor
  status` reports the active adapter; new `/cursor adapter [sdk|cli]`
  subcommand reads / writes the `cursor.adapter` setting
- (optional) `package.json` — no hard dep on `@cursor/sdk`. If a
  *types* package is available (`@cursor/sdk` may ship types-only as a
  devDep), add to `devDependencies` only.

## Compliance posture (fork-only justification)

The passthrough framing is the defence. Concretely:

- GSD never registers MCP servers, Skills, Hooks, or Subagents
  programmatically through the SDK on the user's behalf. The slice
  runs inside Cursor's harness using the user's existing Cursor
  configuration.
- GSD does not rebrand Cursor capabilities. The TUI status shows
  "via Cursor" wherever the user can see model / harness origin.
- GSD does not present Cursor's product features as its own. The
  `/cursor` command is the only branded surface.

Upstream-PR postures:

**A. Land as the default adapter.** `cursor.adapter` defaults to
`"sdk"`; the CLI path stays fully supported via
`cursor.adapter = "cli"`. The path-selector's graceful-fallback on
SDK import failure means the worst case is "CLI behaviour
unchanged." Users who need CLI semantics flip the setting once.

**B. Keep fork-only.** Most conservative.

**C. Strip the MCP / Skills / Hooks surfacing** and ship only the
SDK-as-faster-transport (lower-latency event handoff). The SDK still
gives a perf benefit even without harness passthrough. Decide with the
maintainer.

## Testing strategy

- Unit-test the SDK adapter against a hand-rolled mock SDK that yields
  a synthesised stream of `SDKMessage` values.
- Path-selector tests with env var on/off + SDK present/missing.
- Snapshot tests against captured SDK fixtures (if plan #01 is
  extended with an SDK-path capture mode).
- The CLI path test suite (from plans #01–#03) MUST still pass after
  the refactor — proves shared translation module didn't regress
  anything.
- The marker-audit test (set up in plan #04) now also asserts at
  least one `// UPSTREAM_REVIEW:C` per modified file.

## Acceptance criteria

- ✅ Default (`cursor.adapter` unset) with `@cursor/sdk` installed
  runs slices via the SDK and produces identical-shape
  `AssistantMessage`s as the CLI path on the equivalent fixture.
- ✅ Default with `@cursor/sdk` missing logs a single redacted
  warning and falls back to CLI without throwing.
- ✅ `cursor.adapter = "cli"` skips the SDK probe entirely and runs
  slices via the CLI path — byte-for-byte unchanged from the Phase 1
  baseline (proven by re-running the plan #01 fixture suite with the
  setting flipped).
- ✅ `/cursor adapter` with no argument prints the current adapter;
  `/cursor adapter sdk` and `/cursor adapter cli` write the setting
  and invalidate the path-selector cache.
- ✅ Refactor verified: every plan #01–#05 test still passes.
- ✅ `/cursor status` reports the active adapter.
- ✅ `// UPSTREAM_REVIEW:C` markers present on every changed line; the
  audit assertion (from plan #04 / #05's marker-audit test) passes.
- ✅ `npm run verify:pr` passes.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `@cursor/sdk` API churns mid-implementation | Pin the major version in the dynamic import; on signature mismatch fall back to CLI and log; investigation step records the version targeted |
| The SDK's discriminated union shape differs significantly from the CLI's NDJSON | Translate at the adapter boundary; the shared `mapCursorEvent` consumes a normalised internal type, both adapters convert to it |
| Dynamic import resolves but the SDK runtime fails on Agent.create() | Wrap Agent.create() in try/catch; on failure, fall back to CLI for the current slice and log once |
| Refactoring `stream-adapter.ts` breaks the CLI path | The refactor commit is separate and stand-alone. All CLI path tests pass on that commit alone. |
| Bundling the SDK into dist accidentally on build | The dynamic import uses the `webpackIgnore` comment per claude-code-cli precedent; verify `npm run build:core` does not include `@cursor/sdk` in dist |
| Cursor's harness passthrough surfaces tools that violate ADR §2.4 framing | Defence stays at "GSD doesn't register tools — they come from the user's Cursor configuration"; document in the SDK adapter file header |

## Branch & upstream posture

- **Fork-only by default.** `feat/cursor-cli-full-power`. Markers on
  every change.
- Split commits so the refactor (shared translation extraction) is
  upstream-safe and PR-able even if the SDK adapter itself is rejected.

## Open questions

1. **`@cursor/sdk` API surface.** Investigation answers this — but
   plan must remain flexible if the API diverges from the parent
   plan's expectations.
2. **Abort semantics.** Does the SDK accept an AbortSignal directly, or
   must we use a custom cancellation primitive?
3. **Auth.** Confirm `CURSOR_API_KEY` is the right value to pass, or if
   the SDK reads from `~/.cursor/credentials` automatically.
4. **MCP passthrough mechanism.** Does the SDK auto-pick up the user's
   `cursor-agent`-configured MCP servers, or must GSD register them
   explicitly? Defence framing depends on this.
5. **Cloud Agents.** Out of scope for this plan but worth noting in
   the SDK adapter file header for future readers.

## Acceptance test command sequence (for a new agent)

```bash
git checkout feat/cursor-cli-full-power
git checkout -b feat/cursor-cli-sdk-adapter

# Investigation — confirm @cursor/sdk available, record findings inline

# Refactor first
# - extract shared translation into stream-translation.ts
# - all existing tests still pass

# Then SDK adapter
npm install --save-dev @cursor/sdk    # devDep only, types
# ... implement per "Implementation steps" ...

# Verify SDK path (default)
node --import ./scripts/dist-test-resolve.mjs \
  --experimental-test-isolation=process \
  --test "dist-test/src/resources/extensions/cursor-cli/tests/sdk-adapter.test.js"

# Verify CLI path by flipping the setting
node dist/loader.js
# inside GSD: /cursor adapter cli
# then re-run the plan #01 fixture suite — CLI path byte-stable

node --import ./scripts/dist-test-resolve.mjs \
  --experimental-test-isolation=process \
  --test "dist-test/src/resources/extensions/cursor-cli/tests/*.test.js"

# Verify fallback when SDK absent (setting still defaults to "sdk")
npm uninstall @cursor/sdk
node dist/loader.js
# expect single stderr warning, CLI path used for this process

# Reinstall + full preflight
npm install --save-dev @cursor/sdk
npm run verify:pr

# Audit
rg "UPSTREAM_REVIEW:C" src/
```

## Closing the loop

When this plan lands, the parent plan's three deferred features (A / B /
C) are all in place. Run the audit grep:

```bash
rg "UPSTREAM_REVIEW:[ABC]" src/resources/extensions/cursor-cli/ packages/pi-ai/src/
```

Decide with the maintainer whether each gets PR'd, kept fork-only, or
refactored to an opt-in form. Plans #04 / #05 / #06 each list
recommended postures in their "Compliance posture" sections.
