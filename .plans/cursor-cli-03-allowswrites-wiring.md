# Cursor CLI #03 — `allowsWrites` end-to-end + `--cursor-force` CLI flag

## Status: SHIPPED — Implementation landed on `feat/cursor-cli-full-power`

Follow-up parked at `.todos/cursor-cli-slice-descriptor-allowswrites.md`
(per-phase taxonomy wiring; see "Implementation notes (post-landing)"
below).

## Sequence
This is **step 3 of 6** in the cursor-cli roadmap. Depends on plans #01 and
#02 only loosely (no code dependency — but the integration test from #02
gains a new `allowsWrites=true` assertion when this plan lands).

## Problem

The current `feat/cursor-cli-provider` baseline ships with `--force` **always
off** — `buildCursorArgs()` only appends it when
`CursorStreamOptions.allowsWrites === true`, and no caller in GSD ever sets
that flag. The result is that a slice routed to `cursor-agent` works fine
for chat / analysis but **silently fails on autonomous edits** because
Cursor's CLI prompts interactively (and `-p` mode has no TTY).

The parent plan called this out:

> **`--force` allows unsupervised file writes.** Default to NO `--force`;
> only enable when GSD slice declares write intent (existing
> `slice.allowsWrites` style flag). Mirrors `claude-code-cli` permission
> gating.

Today there is no wiring at all between GSD's slice descriptor and the
Cursor adapter's option object. Until that wiring lands, the provider is
read-only — half-feature.

## Goal

Make `--force` opt-in but **reachable**:

1. Add a `CursorStreamOptions.allowsWrites` derivation path that flows from
   GSD's slice / phase metadata into `streamViaCursorCli`.
2. Add a `--cursor-force` CLI flag (and `GSD_CURSOR_FORCE_ALL_SLICES=1` env
   override) so the user can opt in globally for a session without changing
   slice metadata.
3. Document the security implication prominently in onboarding + in the
   slash command output.
4. Surface the resolved value in the TUI status line / `/cursor status` so
   the user always knows whether Cursor is allowed to write.

## Scope

### In scope

- Identify the source-of-truth for "this slice may make autonomous file
  changes" in the GSD codebase. Candidates listed under "Investigation"
  below — the implementer must pick whichever exists.
- Propagate that bool through `SimpleStreamOptions` (or via a `CursorStreamOptions`-shaped
  extension hook) into `streamViaCursorCli`.
- Add CLI flag `--cursor-force` (parsed by the extension system; uses
  `pi.registerFlag()`).
- Add env override `GSD_CURSOR_FORCE_ALL_SLICES=1`.
- Update `/cursor status` (from `auth-cli-helper.ts`) to print the resolved
  write policy ("write-protected" / "force-enabled for this session" /
  "force-enabled by slice").
- Add a one-line warning banner the first time a slice executes with
  `allowsWrites=true`, in the same place the Claude Code provider warns
  about its bypass mode (see `claude-code-cli/stream-adapter.ts` lines
  1269-1274 for the precedent).
- Tests:
  - unit test for `resolveAllowsWrites()` precedence (env > flag > slice)
  - integration-test assertion (via fake CLI from plan #02) that `--force`
    appears in argv when `allowsWrites=true` is in scope

### Out of scope

- Per-tool granular permissions (`canUseTool`-style callback). Cursor's CLI
  doesn't expose that hook in `-p` mode; if needed later it's a follow-up
  via the SDK path (plan #06).
- Reverting from `--force` mid-session.

## Investigation (must be done first)

Read these files and decide where `allowsWrites` lives in GSD:

1. `packages/pi-coding-agent/src/core/extensions/types.ts` — does
   `SimpleStreamOptions` already carry a write-intent field, or does the
   slice descriptor pass it separately?
2. `src/resources/extensions/gsd/*` — search for `allowsWrites`, `canEdit`,
   `phaseType`, `slice` shape. The Claude Code adapter calls
   `resolveClaudePermissionMode` from env vars and headless mode flags
   (`stream-adapter.ts:1262-1276`); the equivalent for Cursor is what this
   plan adds.
3. `packages/pi-agent-core/*` — does Agent Core differentiate "execute"
   phases (which produce file changes) from "discuss" / "plan" phases
   (which don't)?

If GSD lacks an explicit `allowsWrites` flag on the slice/phase, the
implementer should:
- Map "any GSD phase whose state machine permits commits" → `allowsWrites=true`.
- Use the existing phase taxonomy (e.g., `execute-phase` → writes; `plan-phase`,
  `discuss-phase`, `verify-phase` → read-only).
- Place the mapping in a single helper (see "Helper" below) so the policy
  is auditable in one spot.

Document the chosen source in the commit message.

## Architecture

```
src/resources/extensions/cursor-cli/
├── stream-adapter.ts                  # modified: consumes resolved allowsWrites
├── allows-writes.ts                   # NEW: precedence resolver + helper
├── index.ts                           # modified: register --cursor-force flag,
│                                      # bridge into SimpleStreamOptions per slice
└── auth-cli-helper.ts                 # modified: /cursor status shows write policy
```

`allows-writes.ts` exports:

```ts
export type AllowsWritesSource =
    | { source: "env" }                      // GSD_CURSOR_FORCE_ALL_SLICES=1
    | { source: "cli-flag" }                 // --cursor-force at startup
    | { source: "slice"; sliceId: string }   // slice metadata
    | { source: "none" };                    // default — read-only

export interface AllowsWritesResolution {
    allowsWrites: boolean;
    via: AllowsWritesSource;
}

/**
 * Decide whether the next streamSimple invocation may use --force.
 *
 * Precedence (highest first):
 *   1. process.env.GSD_CURSOR_FORCE_ALL_SLICES === "1"
 *   2. --cursor-force flag set at startup (via pi.getFlag)
 *   3. The slice descriptor's allowsWrites bit
 *   4. Default: false
 */
export function resolveAllowsWrites(
    getFlag: (name: string) => boolean | string | undefined,
    sliceAllowsWrites: boolean | undefined,
): AllowsWritesResolution { ... }
```

## Implementation steps

1. **Read the parent plan's risk register** entries on `--force` and
   `--trust` to refresh the security model.
2. **Investigate the slice / phase descriptor** (see "Investigation").
   Decide and record where `sliceAllowsWrites` comes from.
3. **Create `allows-writes.ts`** with the precedence helper.
4. **Modify `index.ts`** to:
   - `pi.registerFlag("cursor-force", { description: "Allow cursor-agent to
     autonomously edit files for this session.", type: "boolean", default: false })`
   - Replace `streamSimple: streamViaCursorCli` with a wrapper that calls
     `resolveAllowsWrites(pi.getFlag, sliceMetadata?.allowsWrites)` and
     forwards a `CursorStreamOptions` with the resolved `allowsWrites`.
   - The wrapper must NOT swallow other fields of `SimpleStreamOptions`.
5. **Modify `stream-adapter.ts`** — confirm `buildCursorArgs()` still gates
   `--force` on `options.allowsWrites`. Add a one-line stderr warning the
   first time a stream runs with `allowsWrites=true` in the session, gated
   behind `process.env.GSD_HEADLESS !== "1"` so headless mode stays silent
   (mirroring Claude precedent).
6. **Modify `auth-cli-helper.ts` `handleStatus`** to call
   `resolveAllowsWrites` and print the resolution + source.
7. **Add unit tests** for `resolveAllowsWrites` precedence.
8. **Update integration test** (plan #02) to cover the `--force` argv
   assertion when `allowsWrites=true` propagates.
9. **Add a UAT walkthrough** to the parent plan's "Manual test matrix"
   capturing the security pattern.

## Files to create / modify

### Create

- `src/resources/extensions/cursor-cli/allows-writes.ts`
- `src/resources/extensions/cursor-cli/tests/allows-writes.test.ts`

### Modify

- `src/resources/extensions/cursor-cli/index.ts` — register flag, wrap streamSimple
- `src/resources/extensions/cursor-cli/stream-adapter.ts` — first-time warning;
  no contract change to `buildCursorArgs` itself
- `src/resources/extensions/cursor-cli/auth-cli-helper.ts` — print policy
  in `handleStatus`
- `src/resources/extensions/cursor-cli/tests/integration/stream-end-to-end.test.ts` —
  new test "argv contains --force when allowsWrites is true"
- (only if needed) Whatever GSD module supplies the slice descriptor — to
  surface `allowsWrites` as a field on the `SimpleStreamOptions` extension
  hook that the slice runner reads.

## Testing strategy

- **Unit tests** for `resolveAllowsWrites`:
  - env wins over flag wins over slice wins over default
  - missing `getFlag` returns default
  - non-boolean slice value is treated as false
- **Integration test** via the fake CLI: set `allowsWrites=true` in the
  stream options, assert `--force` appears in argv via `CURSOR_FAKE_ECHO_ARGV`.
- **Smoke test** with the real CLI (manual):
  - Run with `--cursor-force` and request a file edit. Verify it succeeds.
  - Run without `--cursor-force` and request a file edit. Verify the slice
    fails cleanly (no hang) and the error surfaces.

## Acceptance criteria

- ✅ `resolveAllowsWrites` precedence matches spec — proven by unit tests.
- ✅ `/cursor status` reports one of:
  `write-protected (default)` / `force-enabled via env` / `force-enabled
  via --cursor-force` / `force-enabled via slice metadata`.
- ✅ Integration test asserts `--force` flows correctly.
- ✅ A slice with write intent that previously hung on permission prompt
  now succeeds end-to-end (manual verification).
- ✅ The first-time-per-session warning fires exactly once (use a module-level
  `hasWarnedAboutForce` boolean).
- ✅ `npm run verify:pr` passes.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Slice-descriptor field doesn't exist in GSD yet | Investigation step decides upfront; if missing, use phase taxonomy with a documented mapping table |
| User sets `--cursor-force` globally and forgets, then a destructive slice runs unexpectedly | Always-on status line in `/cursor status`; warning logged on every fresh session start when the flag is active |
| `pi.getFlag` is called before the extension's flag is registered | Register flag in `index.ts` at module load (before `registerProvider`), and call `pi.getFlag` lazily inside `streamSimple` wrapper |
| `--cursor-force` value persists across sessions because GSD restores flag state | Verify the flag-restore behaviour; if persistent, switch to env-var only (`GSD_CURSOR_FORCE_THIS_SESSION=1`) and document |
| `--force` on Cursor still requires `--trust` | `buildCursorArgs` already includes `--trust`; verify no regression |

## Branch & upstream posture

- **Upstream-safe.** No `UPSTREAM_REVIEW:` markers — this is the missing
  half of Phase 1 from the parent plan.
- Recommended branch: `feat/cursor-cli-allows-writes` off
  `feat/cursor-cli-provider`. Folds into the upstream PR.

## Open questions

1. **Slice descriptor field name.** Investigate first. The parent plan
   used "existing `slice.allowsWrites` style flag" as a placeholder — verify
   whether GSD has this exact name or maps to phase type.
2. **Flag vs env.** Is there a precedent for storing a per-session "I want
   this to be on" choice? Claude Code uses `GSD_CLAUDE_CODE_PERMISSION_MODE`
   env var. Mirror that pattern for consistency, OR introduce
   `--cursor-force` as the discoverable equivalent — both, ideally.
3. **MCP tools.** When `--force` is on, does Cursor's CLI also auto-approve
   MCP tool calls? If yes, the warning text should reflect that.

## Acceptance test command sequence (for a new agent)

```bash
git checkout feat/cursor-cli-provider
git checkout -b feat/cursor-cli-allows-writes

# implement per "Implementation steps"

# unit tests
npm run test:compile
node --import ./scripts/dist-test-resolve.mjs \
  --experimental-strip-types \
  --test "dist-test/src/resources/extensions/cursor-cli/tests/allows-writes.test.js"

# integration test (requires plan #02 landed)
node --import ./scripts/dist-test-resolve.mjs \
  --experimental-strip-types \
  --test "dist-test/src/resources/extensions/cursor-cli/tests/integration/*.test.js"

# full preflight
npm run verify:pr

# manual smoke
node dist/loader.js --cursor-force
# inside GSD: /cursor status      → should report force-enabled via flag
# ask cursor to edit a file       → should succeed without permission prompt
```

## Implementation notes (post-landing)

Recorded after plan #03 shipped on `feat/cursor-cli-full-power`. Captures
the decisions and surprises the original plan didn't pin down.

### Branching

Stayed on `feat/cursor-cli-full-power` rather than branching off
`feat/cursor-cli-provider`. Plans #01 and #02 already lived there as
commits `628b95511` and `1702fdb55`; carving a new branch would have
re-litigated the merge surface. The plan's recommended branch line
(`feat/cursor-cli-allows-writes` off `feat/cursor-cli-provider`) is now
stale.

### Slice descriptor — chosen source

GSD does not currently thread phase/slice metadata through
`SimpleStreamOptions`. A full search returned no hits:

```
grep -rn "allowsWrites\|canEdit\|writeIntent" src packages
# only the cursor-cli extension's own usage shows up
```

Decision recorded in commit: the "slice" tier of the precedence ladder
reads from `(options as CursorStreamOptions).allowsWrites` if a caller
pre-set it. **No GSD caller currently does this**, so in production only
the env and `--cursor-force` tiers fire today. The third tier is
"reachable but dormant" — wiring it up to phase taxonomy is parked at
`.todos/cursor-cli-slice-descriptor-allowswrites.md` because that change
touches the public `SimpleStreamOptions` shape (a cross-provider
concern) and is out of scope for cursor-cli's own plan.

### Files shipped

- **Created**
  - `src/resources/extensions/cursor-cli/allows-writes.ts` — exports
    `resolveAllowsWrites(getFlag, sliceAllowsWrites, env)` and
    `describeAllowsWrites()`. Env var name (`GSD_CURSOR_FORCE_ALL_SLICES`)
    and flag name (`cursor-force`) are exported as constants so tests and
    the status command share the source of truth.
  - `src/resources/extensions/cursor-cli/tests/allows-writes.test.ts` —
    10 tests pinning the precedence ladder + the `describe…` UX strings.
  - `src/resources/extensions/cursor-cli/tests/integration/extension-wiring.test.ts` —
    8 tests that register the extension against a fake `pi: ExtensionAPI`
    and assert argv across env / flag / slice combinations using the fake
    binary from plan #02.

- **Modified**
  - `index.ts` — registers `--cursor-force` via `pi.registerFlag` (before
    `registerProvider`, matching the plan's risk-mitigation guidance) and
    replaces `streamSimple: streamViaCursorCli` with a closure that calls
    the resolver and forwards a merged `CursorStreamOptions`. The wrapper
    spreads the caller's options first, then overwrites only
    `allowsWrites`, so `resumeSessionId` / `sandbox` / future
    `SimpleStreamOptions` fields survive — covered by a wiring test.
  - `stream-adapter.ts` — module-level `hasWarnedAboutForce` latch with
    `resetForceWarningLatch` / `hasWarnedAboutForceForTests` helpers.
    `maybeWarnAboutForce()` fires once per process and is gated by
    `process.env.GSD_HEADLESS !== "1"` so verification pipelines stay
    quiet. `buildCursorArgs` itself was untouched — it already gated
    `--force` on `options.allowsWrites`.
  - `auth-cli-helper.ts` — `/cursor status` calls
    `resolveAllowsWrites(pi.getFlag, undefined)` and prints e.g.
    `write policy: write-protected (default)` /
    `force-enabled via --cursor-force`. `registerCursorCommands` now
    closes over `pi` so handlers can read flags.

### Test result

- Resolver unit tests: 10 passing.
- Wiring integration tests: 8 passing.
- Existing cursor-cli suite: 66 unit + 7 integration still green.
- `npm run verify:pr` total: **9592 passed** (baseline 9573, +19 —
  matches the added tests). The 2 failures are the documented
  `custom-engine-loop-integration.test.ts` flake under concurrent load;
  passes 10/10 in isolation; unrelated to cursor-cli.

### Open questions — answers found in this round

1. **Slice descriptor field name.** Resolved: doesn't exist. See parked
   follow-up in `.todos/`.
2. **Flag vs env.** Resolved: shipped **both**, mirroring Claude Code's
   `GSD_CLAUDE_CODE_PERMISSION_MODE` env pattern *and* the discoverable
   `--cursor-force` flag. Env wins so an operator can override a flag
   the user might forget about.
3. **MCP tools with `--force`.** Still open. Today's warning banner
   talks only about file edits. If a future Cursor CLI release confirms
   `--force` also auto-approves MCP tool calls, the banner text in
   `stream-adapter.ts:maybeWarnAboutForce()` needs to widen.

### Gotchas encountered

- The integration test for `allowsWrites=true` from plan #02 now also
  triggers the first-time `--force` banner on stderr. Harmless (test
  assertions read argv, not stderr) but visible in test output. The new
  wiring test suite suppresses it by setting `GSD_HEADLESS=1` in its
  `before()` block — adopt the same pattern if you add more
  allows-writes integration tests.
- `pi.getFlag(name)` returns `boolean | string | undefined`. The
  resolver explicitly checks `=== true` so a string `"true"` (which can
  arrive when a user sets a flag from a config file) does NOT escalate.
  Pinned by a unit test.
- `ExtensionCommandContext` doesn't carry a `getFlag` shim — only
  `ExtensionAPI` does. `registerCursorCommands` now closes over `pi` and
  threads it into `handleStatus` so the resolver has a `getFlag`
  available. Don't try to read it from `ctx`.
