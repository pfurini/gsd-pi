# Cursor CLI #01 — Live-binary NDJSON fixtures + replay validation

## Status: IMPLEMENTED — fixtures captured, drift patched

Implemented on `feat/cursor-cli-full-power`. Live fixtures captured against
`cursor-agent 2026.05.16-0338208` (`composer-2`). Drift detected and
patched:
- Usage block uses camelCase (`inputTokens`, etc.), not the documented
  snake_case. `mapUsage` accepts both.
- `tool_call` events are polymorphic containers (`tool_call.<name>ToolCall`),
  not the documented flat shape. `extractToolCallFields` normalises both.
- Tool results are folded into `tool_call:completed` rather than a
  separate `tool_result` event. The legacy handler is preserved for
  forward compat.
- `thinking` events are emitted in `-p` mode despite the docs; consumed
  silently.
- `user` events echo the prompt; consumed silently.

Known follow-ups (out of scope here): the live binary emits assistant
text as a sequence of partial `assistant` events followed by a "full
text" assistant event — the mapper currently only tracks
`lastTextContent` for the final message and emits no TUI streaming
events. Plan #02 (fake-CLI shim) should pick this up.

## Sequence
This is **step 1 of 6** in the cursor-cli roadmap that lives on
`feat/cursor-cli-full-power`. Each step has its own plan file under
`.plans/cursor-cli-NN-*.md`. See the parent plan `.plans/cursor-cli-provider.md`
for architecture, compliance posture, and the `Upstream PR Posture` rules.

Prerequisites:
- `feat/cursor-cli-provider` is already implemented (Phase 1 baseline) and
  passing tests — commit `699861b86` or later.
- `cursor-agent` is installed and authenticated on the developer's machine
  (`cursor-agent --version`, `cursor-agent status` reports logged in).

## Problem

The `CursorStreamEvent` union in
`src/resources/extensions/cursor-cli/sdk-types.ts` and the per-event mapping
in `mapCursorEvent()` (inside `stream-adapter.ts`) were built **entirely from
Cursor's published `--output-format stream-json` docs**, never validated
against the actual binary output. The first risk register in the parent plan
listed this explicitly:

> "Cursor changes the NDJSON event shape between versions" — mitigation:
> "integration tests against captured fixtures from `cursor-agent --version`."

That mitigation was deferred in Phase 1. As a result, the most likely failure
modes shipped on the current branch are **silent mapping drift**:

- Tool calls render but never show results → `tool_call_id` vs
  `tool_call.id` vs `tool_use_id` field-name mismatch.
- Final assistant text is empty → `assistant.message.content[].text` shape
  drift (e.g., delivered through `stream_event` deltas only, never as a
  fully-formed `assistant` event).
- GSD reports `stream_exhausted_without_result` → Cursor emits a terminal
  event whose `type` or `subtype` GSD doesn't recognise (e.g., `"complete"`
  instead of `"result"`).
- Usage block is zero in the TUI → `usage.input_tokens` named differently
  (`prompt_tokens`?).

Without fixtures, every one of those is invisible until a real user hits it.

## Goal

A small captured fixture set checked into the repo that:
1. Documents the real wire format of the developer's currently installed
   `cursor-agent` (with version stamped in the fixture metadata).
2. Drives a `tests/fixtures/*.test.ts` replay suite that feeds each fixture
   through `parseNdjson` → `mapCursorEvent` → an `AssistantMessage` builder
   and asserts against a snapshot of the expected GSD event sequence.
3. Surfaces and resolves any mapping drift between the doc-derived types and
   the real binary.

The fixtures become the regression net for every future change to the
mapping table.

## Scope

### In scope (this plan)

- Capture infrastructure: a script that runs `cursor-agent -p
  --output-format stream-json --workspace <tmp> --trust <prompt>` and
  redirects to a fixture file.
- A sanitiser that strips developer-specific data (session ids, absolute
  paths under `$HOME`, dates, the user's email if it appears in the
  authentication footer) — described in detail below.
- At minimum 3 fixtures committed to the repo:
  - `01-hello-text.ndjson` — pure text response, no tool calls
  - `02-single-tool-call.ndjson` — one tool call with success result
    (e.g., a `read_file` against a fixture file in the tmp workspace)
  - `03-multi-tool-call.ndjson` — two or three sequential tool calls
- A replay test `fixture-replay.test.ts` that:
  - parses each fixture through `parseNdjson`
  - drives it through `mapCursorEvent` with a fresh `StreamState`
  - asserts emitted `AssistantMessageEvent`s against a JSON snapshot
  - asserts the final `AssistantMessage` (content, usage, stopReason)
- Any mapping fixes needed in `sdk-types.ts` / `stream-adapter.ts` /
  `partial-builder.ts` to make the replay tests pass against the **real**
  fixtures.
- A README in `tests/fixtures/` documenting how to recapture and re-sanitise.

### Out of scope (deferred to later plans)

- Spawning the CLI via `child_process.spawn` in tests — that's plan #02
  (fake-CLI shim integration test).
- Capturing error fixtures that require a quota-exhausted account — plan #04.
- Capturing fixtures via the SDK path — plan #06.

## Architecture

```
src/resources/extensions/cursor-cli/tests/fixtures/
├── README.md                          # how to recapture, what's sanitised
├── capture.sh                         # invoke cursor-agent, write raw NDJSON
├── sanitize.mjs                       # strip developer-specific tokens
├── prompts/
│   ├── 01-hello.txt                   # prompt for fixture #01
│   ├── 02-read-fixture.txt            # prompt that elicits one tool_call
│   └── 03-multi-step.txt              # prompt that elicits 2-3 tool_calls
├── raw/                               # gitignored; intermediate captures
│   └── .gitignore                     # `*` so nothing here is committed
├── 01-hello-text.ndjson               # sanitised, committed
├── 01-hello-text.meta.json            # cursor-agent version, model, sanitised at
├── 01-hello-text.expected.json        # expected GSD event sequence
├── 02-single-tool-call.ndjson
├── 02-single-tool-call.meta.json
├── 02-single-tool-call.expected.json
├── 03-multi-tool-call.ndjson
├── 03-multi-tool-call.meta.json
└── 03-multi-tool-call.expected.json
```

The replay test lives one level up, alongside the existing tests:

```
src/resources/extensions/cursor-cli/tests/
├── fixture-replay.test.ts             # NEW — drives every fixture
└── ... (existing tests untouched)
```

## Sanitisation rules

The committed fixture is the post-sanitisation file. Patterns to mask:

| Pattern | Replacement | Why |
|---|---|---|
| `session_id` field value | `"sess-XXXXXXXX"` (stable per fixture) | Avoid leaking developer session ids |
| `cwd` field value (absolute) | `"/tmp/fixture-workspace"` | Strip `$HOME` paths |
| `<userhome>` substring (`/Users/<name>` or `/home/<name>`) | `<HOME>` | Defence in depth across any free-text field |
| User email (anywhere) | `[REDACTED_EMAIL]` | The CLI auth footer can leak `fornitori@datagenia.it` |
| ISO 8601 timestamps | `1970-01-01T00:00:00Z` | Make fixtures byte-stable across reruns |
| `duration_ms` field | `0` | Same |
| Bearer / JWT / sk- / cursor-key- tokens | `[REDACTED]` | Re-use the redaction patterns from `redact.ts` |

The sanitiser MUST be idempotent: running it twice on the same file produces
identical output. The committed fixture must still parse as valid NDJSON and
must still trigger the same GSD events as the raw capture.

### Sanitiser contract

`sanitize.mjs` is invoked as:

```bash
node tests/fixtures/sanitize.mjs <raw.ndjson>  >  <sanitised.ndjson>
```

It reads stdin or a file argument, applies the patterns above line by line
(parsing each line as JSON, mutating known fields, falling back to
string-replace for free-text fields), and writes the sanitised stream to
stdout. It must call `redactSecrets()` from the existing
`src/resources/extensions/cursor-cli/redact.ts` on every line as a final
defence-in-depth pass.

## Capture script contract

`capture.sh` accepts:

```bash
./capture.sh <fixture-name> <prompt-file> [<model>]
```

Behaviour:
1. Creates a clean temporary workspace (`mktemp -d`) and copies any helper
   files referenced by the prompt into it.
2. Spawns `cursor-agent -p --output-format stream-json --workspace <tmp>
   --trust --model ${3:-composer-2.5} "$(cat $2)"` and redirects stdout to
   `raw/<fixture-name>.ndjson`.
3. Runs `sanitize.mjs raw/<fixture-name>.ndjson > <fixture-name>.ndjson`.
4. Writes `<fixture-name>.meta.json` with the cursor-agent version (from
   `cursor-agent --version`), the model used, and the sanitisation
   timestamp.
5. Cleans up the temporary workspace.
6. Prints a diff summary: how many bytes raw vs sanitised, how many lines.

The script must NEVER commit the raw capture (use `raw/.gitignore`).

## Replay test contract

`fixture-replay.test.ts` is structured as a single `describe` with one
`test()` per fixture, discovered dynamically by globbing for
`tests/fixtures/*.ndjson`:

```ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { parseNdjson } from "../ndjson-parser.ts";
import { mapCursorEvent } from "../stream-adapter.ts";
// ... import types

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("fixture replay", () => {
    const fixtures = readdirSync(FIXTURES_DIR)
        .filter(f => f.endsWith(".ndjson"));

    for (const fixture of fixtures) {
        test(`replay ${fixture}`, async () => {
            const raw = readFileSync(join(FIXTURES_DIR, fixture), "utf8");
            const expected = JSON.parse(readFileSync(
                join(FIXTURES_DIR, fixture.replace(".ndjson", ".expected.json")),
                "utf8",
            ));

            const stream = Readable.from([raw]);
            const events = [];
            const state = makeFreshState(expected.model);
            let final = null;

            for await (const event of parseNdjson(stream)) {
                const { events: mapped, final: maybeFinal } =
                    mapCursorEvent(event, state);
                events.push(...mapped.map(scrubAssistantMessage));
                if (maybeFinal) { final = maybeFinal; break; }
            }

            assert.deepEqual(events, expected.events);
            assert.deepEqual(scrubAssistantMessage(final?.message), expected.final);
        });
    }
});
```

`scrubAssistantMessage` strips timestamps and other non-deterministic fields
before comparison so the `.expected.json` files don't need re-generation on
every capture.

The `.expected.json` files are **regenerated** by running the test once with
`UPDATE_FIXTURE_SNAPSHOTS=1`:

```ts
if (process.env.UPDATE_FIXTURE_SNAPSHOTS) {
    writeFileSync(expectedPath, JSON.stringify({ events, final }, null, 2));
    return;
}
```

This pattern matches the project's existing snapshot-test style.

## Implementation steps (in order)

1. **Create the fixture directory structure** with `prompts/`, `raw/.gitignore`,
   and `README.md`. Commit empty.
2. **Write the sanitiser** (`sanitize.mjs`) with line-by-line JSON parsing
   and the patterns above. Test it with a hand-crafted dirty fixture in a
   `tests/sanitize.test.ts`.
3. **Write `capture.sh`** and verify locally — captures fixture 01 to raw/,
   sanitises it. Verify by reading both files that all patterns are masked
   in the committed version.
4. **Write `fixture-replay.test.ts`** with snapshot bootstrap behind
   `UPDATE_FIXTURE_SNAPSHOTS=1`.
5. **Capture fixture 01** (hello-text), run the test with
   `UPDATE_FIXTURE_SNAPSHOTS=1` to seed the expected file, commit
   `.ndjson`, `.meta.json`, `.expected.json`.
6. **Run the test without the env var** — it should pass byte-for-byte.
7. **Capture fixtures 02 and 03** the same way.
8. **Detect any mapping drift** that surfaces while seeding expecteds —
   typical symptoms:
   - Test fails with "unknown event type" debug log → add new variant to
     `CursorStreamEvent` union and a case to `mapCursorEvent`.
   - Tool call has no `externalResult` after replay → mismatch between the
     `tool_call_id` field name in the fixture and the lookup in
     `attachExternalResultsToToolBlocks`.
   - Final message has empty content → text never arrives via the
     `assistant` event path; only via `stream_event` deltas. May require
     promoting the `stream_event` builder to be the authoritative
     content-source even when an `assistant` event arrives.

   Each fix lands as a separate atomic commit so the change is auditable.

## Files to create / modify

### Create

- `src/resources/extensions/cursor-cli/tests/fixtures/README.md`
- `src/resources/extensions/cursor-cli/tests/fixtures/.gitignore` (excludes `raw/`)
- `src/resources/extensions/cursor-cli/tests/fixtures/raw/.gitignore`
- `src/resources/extensions/cursor-cli/tests/fixtures/capture.sh` (executable)
- `src/resources/extensions/cursor-cli/tests/fixtures/sanitize.mjs`
- `src/resources/extensions/cursor-cli/tests/fixtures/prompts/01-hello.txt`
- `src/resources/extensions/cursor-cli/tests/fixtures/prompts/02-read-fixture.txt`
- `src/resources/extensions/cursor-cli/tests/fixtures/prompts/03-multi-step.txt`
- `src/resources/extensions/cursor-cli/tests/fixtures/01-hello-text.{ndjson,meta.json,expected.json}`
- `src/resources/extensions/cursor-cli/tests/fixtures/02-single-tool-call.{ndjson,meta.json,expected.json}`
- `src/resources/extensions/cursor-cli/tests/fixtures/03-multi-tool-call.{ndjson,meta.json,expected.json}`
- `src/resources/extensions/cursor-cli/tests/fixture-replay.test.ts`
- `src/resources/extensions/cursor-cli/tests/sanitize.test.ts`

### Modify (only if drift is detected)

- `src/resources/extensions/cursor-cli/sdk-types.ts` — add / rename fields
  to match real wire format
- `src/resources/extensions/cursor-cli/stream-adapter.ts` — adjust
  `mapCursorEvent` cases, `normalizeToolResultOutput`, etc.
- `src/resources/extensions/cursor-cli/partial-builder.ts` — adjust
  `handleStreamEvent` if the inner delta shape differs from Anthropic's

### Modify (always)

- `package.json` — the `test:unit:compiled` glob already includes
  `cursor-cli/tests/*.test.js`, so the new tests are picked up automatically.
  Verify by running `npm run test:unit` after capture and confirming the
  new tests appear in the count.

## Testing strategy

- The replay tests are themselves the validation.
- `sanitize.test.ts` proves the sanitiser is idempotent and doesn't strip
  semantically important fields.
- After capture, run `npm run test:unit:compiled` (the project preflight) and
  confirm `9551 + N` passed where `N` is the fixture count.

## Acceptance criteria

- ✅ At least 3 fixtures captured from the developer's installed
  `cursor-agent` (version stamped in `.meta.json`).
- ✅ `tests/fixture-replay.test.ts` discovers fixtures dynamically and
  passes for each.
- ✅ `tests/sanitize.test.ts` proves the sanitiser is idempotent.
- ✅ Committed `.ndjson` files contain no `$HOME` paths, no real session
  ids, no email, no bearer tokens (`grep` audit).
- ✅ Any mapping drift discovered is patched with `// fixture-derived` or
  similar marker comments referencing this plan.
- ✅ `npm run verify:pr` passes.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Capture is non-deterministic — the same prompt produces different token sequences across runs | Pin temperature where possible (`--temperature 0` if supported); pick prompts whose deterministic-enough that snapshots are stable; use `mapCursorEvent`'s structural shape (`type` + key fields) not raw byte-equality |
| Cursor CLI updates change the wire format and existing fixtures break | Stamp version in `.meta.json`; test failures point at the wire-format change; capture new fixtures and update expected files explicitly |
| Sanitisation accidentally strips a real test signal | The replay test compares against post-sanitise expected files, so accidents are caught at test-write time |
| Tool-call fixture requires arbitrary tool execution | Use `read_file` against a small text file copied into the temporary workspace before capture — deterministic, no network |
| Multi-step fixture is too brittle | Keep the prompt narrow (e.g., "read these three small files and summarise") and snapshot the structural sequence, not exact text |

## Branch & upstream posture

- **Upstream-safe.** This entire plan is fixture infrastructure + bug fixes.
  No `UPSTREAM_REVIEW:` markers needed.
- Recommended branch: work directly on a topic branch off
  `feat/cursor-cli-provider` (e.g., `feat/cursor-cli-fixtures`). When done,
  this becomes a follow-up PR to upstream OR is folded into the
  `feat/cursor-cli-provider` PR before merge.
- If working on `feat/cursor-cli-full-power` (the personal full-power
  branch), commits should remain cherry-pickable to
  `feat/cursor-cli-provider`. Avoid touching anything personal-only
  (scripts/personal, .gitignore tooling entries) in the same commit.

## Open questions

1. **Where do fixture files live in dist-test?** The compile-tests script
   copies non-TS assets; verify `.ndjson` and `.json` are picked up.
   If not, add their extension to the asset-copy list in
   `scripts/compile-tests.mjs`.
2. **Temperature control?** Verify `cursor-agent` accepts `--temperature 0`.
   If not, accept some structural-only snapshot tolerance.
3. **Should we capture the `--stream-partial-output` variant?** The
   parent plan shows the `stream_event` wrapper. If that flag isn't on
   by default in `-p` mode, we may need to add it to `buildCursorArgs`
   for fidelity — or capture both variants and snapshot both.
4. **Fixture sharing with plan #02?** The fake-CLI shim test will replay
   the same fixtures. Decide upfront that #02 reads from this directory
   directly rather than duplicating fixtures.

## Acceptance test command sequence (for a new agent)

```bash
# pre-conditions
git checkout feat/cursor-cli-provider
git checkout -b feat/cursor-cli-fixtures
cursor-agent --version          # must print a version

# build infrastructure
# ... (create files per "Implementation steps")

# capture fixtures
cd src/resources/extensions/cursor-cli/tests/fixtures
./capture.sh 01-hello-text prompts/01-hello.txt
./capture.sh 02-single-tool-call prompts/02-read-fixture.txt
./capture.sh 03-multi-tool-call prompts/03-multi-step.txt

# seed expecteds
cd /Users/paolof/Developer/ai/gsd-2  # repo root
UPDATE_FIXTURE_SNAPSHOTS=1 node --experimental-strip-types \
  --test src/resources/extensions/cursor-cli/tests/fixture-replay.test.ts

# verify deterministic
node --experimental-strip-types \
  --test src/resources/extensions/cursor-cli/tests/fixture-replay.test.ts

# full suite
npm run verify:pr
```

If `npm run verify:pr` passes, this plan is done.
