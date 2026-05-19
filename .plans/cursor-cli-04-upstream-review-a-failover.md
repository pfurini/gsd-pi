# Cursor CLI #04 — `UPSTREAM_REVIEW:A` Cross-vendor failover on Cursor quota exhaustion

## Status: DRAFT — Awaiting implementation

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
