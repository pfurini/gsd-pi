# Cursor CLI #04 — `UPSTREAM_REVIEW:A` Cross-vendor failover on Cursor quota exhaustion

## Status: SHIPPED — Implementation landed on `feat/cursor-cli-full-power`
(reduced scope — classification + regex extension; the bool gate from the
original draft was dropped after investigation, see "Implementation notes
(post-landing)" below)

## Sequence
This is **step 4 of 6** in the cursor-cli roadmap and the **first
fork-only-flagged** plan. Plans #01–#03 are upstream-safe by design; this
one is explicitly gated as a fork-only candidate per the parent plan's
"Upstream PR Posture" section A. Whether it survives into an upstream PR
depends on maintainer review — see that section.

Depends on plans #01 (fixtures) and #02 (fake CLI shim) — both used to
test the quota-error path without burning real subscription quota.

## Problem

Cursor's CLI signals quota exhaustion via terminal `result` events whose
`subtype === "error"`, `is_error === true`, and `result` string contains
recognisable quota-exhaustion phrases (typical: `"quota exhausted"`,
`"plan limit reached"`, `"usage limit"`, `"rate limit"`, possibly also
HTTP-style mentions like `"402"`).

Today the cursor-cli adapter (`stream-adapter.ts`) treats every
`is_error: true` result identically — the final `AssistantMessage` has
`stopReason: "error"` and `errorMessage` set to the redacted result string.
GSD's outer retry loop sees this as a generic provider error and may retry
the same provider, which is pointless: quota is exhausted, retrying yields
the same error.

The parent plan's "Upstream PR Posture A" section spells out the desired
behaviour:

> Cursor quota-exhaustion errors enter the existing retry-handler (#5184 /
> #4394 precedent) and trigger automatic rotation to the next configured
> provider (e.g., `claude-code-cli`, `openai-codex`).

The tension that makes this fork-only candidate: ADR §2.3 prohibits
"GSD-side metering or routing across vendors." Using one vendor's quota
signal to drive a switch into another can read as competitive routing
unless gated behind an explicit opt-in.

## Goal

A two-part change:

1. **Detection**: classify cursor-agent quota errors at the cursor-cli
   adapter boundary. Promote them from "generic provider error" to a
   structured signal (`AssistantMessage.errorMessage === "quota_exhausted"`)
   that GSD's existing retry / failover machinery (see #5184 + #4394)
   already knows how to consume.

2. **Routing**: opt-in via a new boolean setting
   `cursor.allow_cross_vendor_failover` in GSD's settings.json
   (defaulting to `false`). When set, the GSD retry handler is allowed to
   rotate to the next configured provider on quota exhaustion. When unset
   (default), behaviour is identical to today — the error surfaces, no
   rotation happens, and the user sees a clear "Cursor quota exhausted"
   message in the TUI.

Every source location that participates in this routing is tagged
`// UPSTREAM_REVIEW:A` per the parent plan's tracking convention, so the
pre-PR audit (`rg "UPSTREAM_REVIEW:[ABC]"`) catches them.

## Scope

### In scope

- A quota-detection helper in the cursor-cli extension that pattern-matches
  on the Cursor `result.result` text + `result.subtype`.
- A structured error code (`"quota_exhausted"`) emitted via
  `AssistantMessage.errorMessage`, distinct from generic
  `"cursor_unknown_error"` / arbitrary provider strings.
- Reading the new setting from GSD's settings.json with a clear default
  (`false`).
- A hook into GSD's existing retry / failover handler (#5184) — the
  cursor-cli extension surfaces the structured error; the routing decision
  lives in the retry handler. The cursor-cli extension does NOT call
  `setModel()` or `pickProvider()` itself.
- Settings UI affordance: a `/cursor failover` slash-command subcommand
  to toggle the bool in settings.json without hand-editing.
- Tests covering:
  - quota-text detection (multiple known phrasings)
  - non-quota errors do NOT trigger the structured code
  - settings off → no rotation hint emitted
  - settings on → rotation hint emitted
- `// UPSTREAM_REVIEW:A` markers on every line that participates.

### Out of scope

- Changing GSD's retry handler itself — that's existing
  infrastructure from #5184 / #4394. This plan only adds the signal.
- Selecting *which* fallback provider — that's the existing handler's job.
- Cross-vendor metering or accounting.
- Quota-error fixtures from a real exhausted account (use synthetic
  fixtures crafted from the documented error shape).

## Investigation (must be done first)

1. **Find the retry/failover handler.** Search for the changes from PRs
   #5184 and #4394 (parent plan references them) — likely under
   `src/resources/extensions/gsd/` or `packages/pi-agent-core`. Identify:
   - the function that decides whether to retry vs fail
   - the function that decides which provider to pick on rotation
   - the error-code convention it consumes (string match? structured field?)
2. **Read `claude-code-cli/stream-adapter.ts`** lines around
   `makeErrorMessage` and the retry classifications — Claude Code already
   maps certain failure modes to structured codes (e.g., `aborted` vs
   `stream_exhausted_without_result`). The cursor-cli equivalent should
   follow the same shape.
3. **Settings file layout.** Read `src/resources/extensions/gsd/settings.ts`
   (or wherever GSD's persistent settings live) to learn the convention
   for adding a new boolean toggle.

Document findings in the commit message. If the existing retry handler
does NOT have a clean hook for cross-vendor rotation, this plan becomes a
**preview** — the cursor-cli side ships the signal, and a follow-up PR
adds the actual rotation logic. That's still useful: the signal alone
makes the error far more actionable.

## Architecture

```
src/resources/extensions/cursor-cli/
├── quota-detect.ts                    # NEW: pattern matcher
├── failover-policy.ts                 # NEW: reads settings, exports bool
├── stream-adapter.ts                  # MODIFIED: emit structured code on quota
├── auth-cli-helper.ts                 # MODIFIED: /cursor failover slash
└── tests/
    ├── quota-detect.test.ts           # NEW
    └── integration/
        └── stream-end-to-end.test.ts  # MODIFIED: quota fixture path
```

`quota-detect.ts` exports a single pure function:

```ts
// UPSTREAM_REVIEW:A — cross-vendor failover signal classifier.
// See .plans/cursor-cli-04-upstream-review-a-failover.md for posture.

export interface CursorErrorClassification {
    /** Stable string surfaced via AssistantMessage.errorMessage. */
    code: "quota_exhausted" | "auth_failed" | "rate_limited" | "other";
    /** Human-readable detail, already passed through redactSecrets(). */
    detail: string;
}

const QUOTA_PATTERNS = [
    /\bquota\s+exhausted\b/i,
    /\bplan\s+(limit|quota)\s+reached\b/i,
    /\busage\s+limit(?:s)?\s+(?:reached|exceeded)\b/i,
    /\binsufficient\s+credits\b/i,
    /\b402\b.*\b(payment|billing)\b/i,
];
const RATE_LIMIT_PATTERNS = [
    /\brate\s+limit(?:ed)?\b/i,
    /\btoo\s+many\s+requests\b/i,
    /\b429\b/,
];
const AUTH_PATTERNS = [
    /\b(unauthorized|unauthenticated)\b/i,
    /\b401\b.*\bauth/i,
    /\binvalid\s+(api\s+key|token|credential)\b/i,
];

export function classifyCursorError(
    resultText: string,
    subtype: string,
): CursorErrorClassification { ... }
```

`failover-policy.ts`:

```ts
// UPSTREAM_REVIEW:A — opt-in setting for cross-vendor failover on quota errors.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SETTINGS_KEY = "cursor.allow_cross_vendor_failover";

export function isCrossVendorFailoverAllowed(settingsPath?: string): boolean {
    // 1. Env override for tests / one-off enablement
    if (process.env.GSD_CURSOR_ALLOW_FAILOVER === "1") return true;
    if (process.env.GSD_CURSOR_ALLOW_FAILOVER === "0") return false;

    // 2. Persisted settings.json
    try {
        const path = settingsPath ?? resolveGsdSettingsPath();
        if (!existsSync(path)) return false;
        const settings = JSON.parse(readFileSync(path, "utf8"));
        return settings[SETTINGS_KEY] === true;
    } catch {
        return false;
    }
}

export function setCrossVendorFailover(value: boolean, settingsPath?: string): void { ... }
```

## Implementation steps

1. **Investigation** (commit nothing yet) — see "Investigation". Record
   findings in a `// UPSTREAM_REVIEW:A` block-comment at the top of
   `quota-detect.ts` so future PR reviewers see the rationale inline.
2. **Add `quota-detect.ts`** with `classifyCursorError`.
3. **Add `failover-policy.ts`** with settings read/write.
4. **Modify `stream-adapter.ts`**:
   - In the `result` event mapping, on `is_error: true`, call
     `classifyCursorError(result.result, result.subtype)`.
   - Set `finalMessage.errorMessage = classification.code` (the stable
     short code) when the classification is anything other than `"other"`.
   - Keep the redacted full detail in a new optional field
     `errorDetail` (additive; verify pi-ai types — extend with `& { errorDetail?: string }`
     via the existing extension pattern, or attach via `metadata`).
   - Tag every modified line / block with `// UPSTREAM_REVIEW:A`.
5. **Modify the retry-handler hook** — exact location depends on
   "Investigation". The minimal change: when the handler sees
   `errorMessage === "quota_exhausted"` AND
   `provider === "cursor-agent"` AND
   `isCrossVendorFailoverAllowed()` returns true, allow rotation to
   the next configured provider; otherwise behave as today.
6. **Add `/cursor failover` slash command** in `auth-cli-helper.ts`:
   - `/cursor failover` → print current setting + how to enable
   - `/cursor failover on` → set to true, refresh cache
   - `/cursor failover off` → set to false, refresh cache
7. **Add tests**:
   - `quota-detect.test.ts` — every known quota phrasing maps to
     `quota_exhausted`; rate-limit phrasings map to `rate_limited`; auth
     phrasings map to `auth_failed`; benign error strings map to `"other"`.
   - `failover-policy.test.ts` — env override > settings > default.
   - integration: a quota fixture (synthetic, hand-written based on the
     documented error shape) replayed through the fake CLI yields
     `errorMessage === "quota_exhausted"`.
8. **Documentation**: add a section to the parent plan's "Open Questions"
   that this work landed.

## Files to create / modify

### Create

- `src/resources/extensions/cursor-cli/quota-detect.ts`
- `src/resources/extensions/cursor-cli/failover-policy.ts`
- `src/resources/extensions/cursor-cli/tests/quota-detect.test.ts`
- `src/resources/extensions/cursor-cli/tests/failover-policy.test.ts`
- `src/resources/extensions/cursor-cli/tests/fixtures/04-quota-exhausted.ndjson`
  (synthetic; not from a real run)
- `src/resources/extensions/cursor-cli/tests/fixtures/04-quota-exhausted.expected.json`

### Modify

- `src/resources/extensions/cursor-cli/stream-adapter.ts` — `result` case
- `src/resources/extensions/cursor-cli/auth-cli-helper.ts` — failover subcmd
- `src/resources/extensions/cursor-cli/tests/integration/stream-end-to-end.test.ts` —
  quota integration test
- Retry handler module (location TBD via investigation) — opt-in rotation
  check tagged `// UPSTREAM_REVIEW:A`

### Settings

- New key `cursor.allow_cross_vendor_failover` (boolean, default false) in
  GSD's settings.json. Document in the parent plan.

## Compliance posture (fork-only justification)

The opt-in default-off design is the entire defence. The two upstream-PR
postures the maintainer can accept:

**A. Land as-is, gated off by default.** Cursor-quota detection is a
classification refinement, not routing. The routing trigger is an explicit
user opt-in via settings. ADR §2.3's prohibition is on
"metering and routing across vendors as a product feature"; an
opt-in error-recovery toggle is closer to GSD's existing retry behaviour
than to product-level competitive routing.

**B. Land only the classification (quota detect + structured code), drop
the routing hook.** The classification has clear standalone value (better
TUI error messages, surfaces quota state explicitly) and is unambiguously
within the existing claude-code-cli precedent for error classification.

If the maintainer prefers (B), the fork-only diff is just the retry-handler
hook + the `/cursor failover` command + the settings key. All other code
goes upstream-clean.

## Testing strategy

- Unit tests for the classifier with every phrasing in the pattern set.
- Settings-policy unit tests covering env > settings > default precedence.
- Integration: synthetic quota fixture replayed through fake CLI,
  asserting `errorMessage === "quota_exhausted"`.
- Negative-path test: a generic error message ("model returned 500")
  classifies as `"other"` and does NOT set the quota code.
- Cross-vendor rotation test: stub the retry handler in a test, set
  `GSD_CURSOR_ALLOW_FAILOVER=1`, drive a quota error, assert the handler
  was asked to rotate. With the env unset (default), assert no rotation
  attempt.
- Audit test: `rg "UPSTREAM_REVIEW:A" src/` returns at least one hit per
  changed file. Bake this assertion into a `tests/upstream-review-markers.test.ts`
  to prevent silent drift.

## Acceptance criteria

- ✅ `classifyCursorError` handles all documented phrasings + their
  combinations.
- ✅ Default behaviour unchanged for upstream-equivalence: with the
  setting off and the env unset, a quota error surfaces with the new
  human-readable detail but no rotation occurs.
- ✅ With the setting on (or env on), the retry handler sees the
  structured code and rotates to the next provider.
- ✅ `/cursor failover` shows + toggles the state, prints a clear warning
  about cross-vendor implications when enabling.
- ✅ Every change site has a `// UPSTREAM_REVIEW:A` marker; the audit grep
  returns a non-empty result and the count matches the test's expected
  count.
- ✅ `npm run verify:pr` passes.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Cursor changes quota-error phrasing across CLI releases | Pattern set is broad; integration fixtures are synthetic; add new phrasings as encountered with a follow-up commit |
| Retry handler hook doesn't exist or has a different contract | Investigation step first; if missing, ship classification-only (posture B) and open a follow-up issue for the handler |
| False positives on the quota pattern lead to inappropriate rotation | Patterns are conservative; rotation only when the bool is set; default-off |
| Settings key collision | Use a fully-qualified key `cursor.allow_cross_vendor_failover` |
| The `// UPSTREAM_REVIEW:A` markers are silently deleted in a future refactor | The audit test in `tests/upstream-review-markers.test.ts` fails CI if markers go missing |
| Env override leaks into upstream PR by accident | Marker discipline + the audit test |

## Branch & upstream posture

- **Fork-only by default.** Lives on `feat/cursor-cli-full-power`. Tag
  every change with `// UPSTREAM_REVIEW:A`.
- For upstream PR consideration: split the commits — classification (one
  commit, upstream-safe) and routing (one commit, fork-only). The audit
  test makes that split mechanical.
- Pre-PR check: `rg "UPSTREAM_REVIEW:A" src/` audits all sites. If
  upstream rejects routing, drop those commits from the PR-bound branch
  and keep them on `personal` via the topology established earlier.

## Open questions

1. **Phrasing catalogue.** The pattern set is best-effort. Recommend
   gathering a real quota error in the wild (manual matrix once the user
   exhausts their daily Cursor quota) and adding the captured phrasing
   to the patterns + fixtures.
2. **Cooldown.** Should a quota-rotated slice mark `cursor-agent` as
   "down for X minutes" so subsequent slices skip it without re-trying?
   Probably yes — but punt to a follow-up issue.
3. **Telemetry.** GSD records provider-failure events. Should
   `quota_exhausted` events flow into that pipeline? Yes for local logs,
   no for any external telemetry — see plan #05 for the telemetry-leak
   guardrail.

## Acceptance test command sequence (for a new agent)

```bash
git checkout feat/cursor-cli-full-power
git checkout -b feat/cursor-cli-failover

# Investigation step → commit findings in CODE COMMENT, not a separate doc
# Implementation per "Implementation steps"

# audit markers
rg "UPSTREAM_REVIEW:A" src/

# unit tests
npm run test:compile
node --import ./scripts/dist-test-resolve.mjs --experimental-strip-types \
  --test "dist-test/src/resources/extensions/cursor-cli/tests/quota-detect.test.js" \
         "dist-test/src/resources/extensions/cursor-cli/tests/failover-policy.test.js"

# integration tests
node --import ./scripts/dist-test-resolve.mjs --experimental-strip-types \
  --test "dist-test/src/resources/extensions/cursor-cli/tests/integration/*.test.js"

# preflight
npm run verify:pr

# manual smoke (optional — requires actually exhausting quota; you can simulate
# by editing the synthetic fixture into the live cursor-agent's output stream)
node dist/loader.js
# inside GSD: /cursor failover on
#             ... run a slice that will exhaust quota or replay the fixture
#             expect rotation to next configured provider
```

## Implementation notes (post-landing)

Recorded after plan #04 shipped on `feat/cursor-cli-full-power`. Captures
the decisions, simplifications, and surprises the original plan didn't
pin down.

### Branching

Stayed on `feat/cursor-cli-full-power`. The plan's "Branch & upstream
posture" line ("Lives on `feat/cursor-cli-full-power`") was correct; the
acceptance-test script's `git checkout -b feat/cursor-cli-failover` was
the stale part — re-branching off the same parent would have re-litigated
the merge surface for #01–#03.

### Posture chosen — neither A nor B, a third path

Investigation found the rotation infrastructure (FallbackResolver +
`RetryHandler._classifyErrorType` + user-configured fallback chains) is
already in-tree and provider-agnostic. PRs #5184 / #4394 are merged. The
gate is `RETRYABLE_ERROR_RE` (in `retryable-error-regex.ts`) — a cursor
quota error today doesn't match the regex, so it never enters
`handleRetryableError` at all.

Given that, the plan's bool gate (`cursor.allow_cross_vendor_failover`)
was redundant: the user's *existing* `fallback.chains` configuration is
already the opt-in surface. If a user puts cursor-agent + claude-code
in the same chain, they have authored cross-vendor rotation. Adding a
second toggle just for cursor would create an asymmetric UX (no other
provider has a per-provider gate) for a defensive posture that only
mattered if we tried to upstream the routing change — and the chain
config IS the same opt-in the other providers rely on.

**Shipped design:**

1. cursor-side classifier (`quota-detect.ts`) recognises the documented
   quota / rate-limit / auth phrasings.
2. cursor stream-adapter emits `errorMessage = "<code>: <redacted>"`
   when classified, raw redacted text otherwise.
3. `retryable-error-regex.ts` is extended with one alternation,
   `\bquota_exhausted\b`, so the structured marker enters the existing
   retry pipeline. Tagged `UPSTREAM_REVIEW:A`.
4. No new bool, no `/cursor failover` subcommand, no
   `failover-policy.ts`, no `retry-handler.ts` diff beyond the regex
   extension.

If a future maintainer wants the bool back, the audit markers make the
re-addition mechanical.

### Classifier patterns table

| Code              | Wire-text triggers (regex sample)                                                    |
|-------------------|--------------------------------------------------------------------------------------|
| `quota_exhausted` | `quota exhausted`, `plan limit reached`, `plan quota reached`, `usage limit reached/exceeded`, `insufficient credits`, `402 ... payment\|billing` |
| `rate_limited`    | `rate limit`, `rate-limited`, `too many requests`, `429`                             |
| `auth_failed`     | `unauthorized`, `unauthenticated`, `401 ... auth`, `invalid api key\|token\|credential`, `not logged in` |
| `other`           | anything else (today's raw-redacted shape, preserved unchanged)                       |

Order matters in `classifyCursorError`: quota → rate-limit → auth → other.
`\b` boundaries throughout, so `quotation` won't match `quota`. The HTTP
402 pattern requires a billing/payment context word within the same
sentence — a bare `402` alone is too noisy.

### Files shipped

- **Created**
  - `src/resources/extensions/cursor-cli/quota-detect.ts` — pure
    classifier + `formatCursorErrorMessage()` helper. Holds the full
    investigation block as the file-header comment.
  - `src/resources/extensions/cursor-cli/tests/quota-detect.test.ts` —
    30 tests across the 4 codes, edge cases, and the formatter.
  - `src/resources/extensions/cursor-cli/tests/fixtures/04-quota-exhausted.ndjson`
    (synthetic; sanitised timestamps + `1970-01-01T00:00:00Z` markers).
  - `src/resources/extensions/cursor-cli/tests/fixtures/04-quota-exhausted.meta.json`
    (with `cursor_agent_version: "synthetic"` and `source:` line so a
    reviewer doesn't try to recapture from a real exhausted account).
  - `src/resources/extensions/cursor-cli/tests/fixtures/04-quota-exhausted.expected.json`
    (seeded via `UPDATE_FIXTURE_SNAPSHOTS=1`, byte-stable on replay).
  - `src/resources/extensions/cursor-cli/tests/upstream-review-markers.test.ts` —
    3 tests: per-file presence, total-count floor, sanity. Splits the
    marker literal so the test file isn't itself a false positive on
    string-match audits.

- **Modified**
  - `src/resources/extensions/cursor-cli/stream-adapter.ts` — `result`
    event handler now calls `classifyCursorError()` and
    `formatCursorErrorMessage()`. Two `UPSTREAM_REVIEW:A` markers (the
    import block and the call site). Behaviour for `code === "other"` is
    byte-identical to pre-#04: `redactSecrets(result.result ||
    result.subtype)`.
  - `packages/pi-coding-agent/src/core/retryable-error-regex.ts` — one
    alternation added, `\bquota_exhausted\b`. Single
    `UPSTREAM_REVIEW:A` block-comment above the regex. The regex is
    consumed by `RetryHandler.isRetryableError` (which already routes
    quota errors via `FallbackResolver.findFallback`).
  - `src/resources/extensions/cursor-cli/tests/integration/stream-end-to-end.test.ts` —
    one new test ("04-quota-exhausted fixture emits structured
    quota_exhausted marker") asserts the marker is present, the human
    detail is appended, and the live `RETRYABLE_ERROR_RE` accepts it.
    Imports `RETRYABLE_ERROR_RE` from `@gsd/pi-coding-agent` so the test
    fails if either side drifts.

Not shipped (vs the original draft):
- `failover-policy.ts`
- `/cursor failover` slash subcommand
- retry-handler bool gate
- `tests/failover-policy.test.ts`
- `tests/cross-vendor-rotation.test.ts`

### Test result

- Unit tests: classifier 30 passing, marker audit 3 passing.
- Integration: cursor-cli end-to-end 8 passing (was 7 pre-#04).
- Cursor-cli total: **116 passing**.
- `npm run verify:pr` total: **9634 passed** (baseline post-#03 9592,
  +42 net — includes the 30 classifier + 3 marker-audit + 1 integration
  added here, plus drift in adjacent suites since the previous run).
  The 2 failures are the documented
  `custom-engine-loop-integration.test.ts` flake under concurrent load;
  10/10 in isolation; unrelated to cursor-cli.

### Wire-format facts (confirmed during implementation)

- `CursorResultEvent` carries both `subtype: "success" | "error"` and
  `is_error: boolean`. The synthetic fixture sets both consistently
  (`subtype: "error"`, `is_error: true`).
- Usage block is camelCase in fixtures + live binary
  (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`).
  `partial-builder.ts:mapUsage` accepts the snake_case fallback so older
  binaries don't break.
- For a quota-failure case, no `assistant` events appear in the stream —
  the failure surfaces straight at the `result` event after the
  `system`/`user` echo, which is what the synthetic fixture models.

### Open questions — answers found in this round

1. **Phrasing catalogue.** Pattern set covers the documented phrasings
   plus the live wire shape inferred from `result.is_error` examples.
   Real-world capture remains a follow-up — when a user exhausts a
   Cursor plan in the wild, add the captured `result` string to
   `QUOTA_PATTERNS` (and a fixture/test for it).
2. **Cooldown.** Out of scope here. `AuthStorage.markProviderExhausted`
   (called from `FallbackResolver.findFallback`) already handles
   provider-level cooldown at the existing infrastructure level.
3. **Telemetry.** Out of scope here. The classifier emits no
   side-effects; the structured code rides on the existing
   `AssistantMessage.errorMessage` channel; whatever GSD's local-only
   telemetry policy is for that field applies unchanged.

### Gotchas encountered

- `packages/pi-coding-agent` has its OWN compiled `dist/`. After editing
  `retryable-error-regex.ts` you must rebuild the package
  (`cd packages/pi-coding-agent && npm run build`) before
  `npm run test:compile` produces a `dist-test/` that consumes the new
  regex. `verify:pr` does this for you, but a one-off
  `node --import ./scripts/dist-test-resolve.mjs ...` run will silently
  use the stale regex.
- `RETRYABLE_ERROR_RE` is exported from `@gsd/pi-coding-agent`'s root
  barrel (`packages/pi-coding-agent/src/index.ts:191`). Deep-import
  paths into `dist/core/...` work at runtime but fail TypeScript module
  resolution. The integration test imports from the root barrel; the
  TypeScript diagnostic surfaces immediately if you forget.
- The `\brate\s*limit(?:ed|ing)?\b` form in the rate-limit pattern set
  does NOT match `"rate-limited"` — the hyphen sits between the two `\b`
  boundaries and `\s*` is space-only. Use `[\s-]*` instead. Pinned by a
  unit test.
- The marker-audit test file itself must contain the literal token, but
  must not double-count as a planning artefact. The shipped test
  constructs the marker by concatenation (`UPSTREAM_${"REVIEW"}:A`) so
  the source contains the literal token in every actual code line that
  cares (file-header comment + self-reference), but the variable-bound
  literal used in the assertions cannot accidentally be matched by a
  naive string scan of *this* line. Listed explicitly in
  `EXPECTED_FILES`.
