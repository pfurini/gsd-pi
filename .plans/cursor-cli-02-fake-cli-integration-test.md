# Cursor CLI #02 — Fake-CLI shim integration test

## Status: DRAFT — Awaiting implementation

## Sequence
This is **step 2 of 6** in the cursor-cli roadmap on
`feat/cursor-cli-full-power`. Depends on **plan #01** (NDJSON fixtures) being
landed first — this plan replays those fixtures through a fake CLI.

## Problem

The Phase 1 unit tests exercise `mapCursorEvent`, `parseNdjson`, and the
mapping primitives in isolation. They never spawn a child process, never
exercise the abort path, never test what happens when the child exits
non-zero, and never validate that `streamViaCursorCli` correctly assembles
the full `AssistantMessageEventStream` end-to-end.

The parent plan called this out in its testing strategy:

> **Integration tests:** Fake `cursor-agent` shim (a small Node script) that
> emits a pre-recorded NDJSON sequence to stdout; the extension spawns it
> like the real CLI; assert end-to-end `streamSimple` produces the expected
> `AssistantMessage` with correct `ToolCall` blocks and `externalResult`
> payloads.

This is the missing piece. Without it:
- Regressions in `pumpCursorMessages` (the spawn/pump loop) aren't caught.
- `abortSignal` handling is unverified.
- Stderr capture + error-message redaction isn't tested.
- Non-zero child exit handling is unverified.
- `CURSOR_AGENT_BIN` override (which the test relies on) isn't exercised.

## Goal

A Node-based fake `cursor-agent` binary that the test sets as
`CURSOR_AGENT_BIN`, then drives `streamViaCursorCli` through. The fake
replays a captured NDJSON fixture (from plan #01) at a controllable cadence,
honours signals, and can be parametrised to exit non-zero or hang for abort
testing.

## Scope

### In scope

- A small Node script `fake-cursor-agent.mjs` that:
  - Accepts the same argv shape as real `cursor-agent -p --output-format
    stream-json --model <id> --workspace <cwd> --trust [--resume <id>]
    [--force] [--sandbox <mode>] "<prompt>"`.
  - Reads a fixture path from `CURSOR_FAKE_FIXTURE` env var.
  - Streams the fixture to stdout, optionally chunked / paced via
    `CURSOR_FAKE_CHUNK_BYTES` and `CURSOR_FAKE_CHUNK_DELAY_MS`.
  - Honours `SIGTERM` by terminating cleanly mid-stream.
  - Can simulate failure modes via `CURSOR_FAKE_EXIT_CODE` and
    `CURSOR_FAKE_STDERR`.
- An integration test `tests/integration/stream-end-to-end.test.ts` that
  exercises every documented streamSimple path:
  - happy path — fixture replays, final AssistantMessage matches
  - tool-call path — externalResult attached, externalToolExecution honoured
  - abort path — caller fires `AbortSignal`, final event is
    `error/aborted`, child gets SIGTERM
  - non-zero exit path — child exits 2 with stderr; final event is
    `error/error` with redacted stderr in `errorMessage`
  - stream-exhausted path — child closes stdout cleanly without ever
    emitting a `result`; final event is
    `error.errorMessage === "stream_exhausted_without_result"`
- A simple readiness-cache bust between tests so each test runs from a
  clean state.

### Out of scope

- Live network testing (real CLI) — that's the manual matrix from the
  parent plan.
- SDK-path testing — plan #06.
- Quota-error fixtures — plan #04.

## Architecture

```
src/resources/extensions/cursor-cli/tests/
├── integration/
│   ├── fake-cursor-agent.mjs           # Node fake binary
│   └── stream-end-to-end.test.ts       # the test
├── fixtures/                           # from plan #01
│   ├── 01-hello-text.ndjson
│   ├── 02-single-tool-call.ndjson
│   └── 03-multi-tool-call.ndjson
└── ... existing
```

The test sets `CURSOR_AGENT_BIN` to the absolute path of
`fake-cursor-agent.mjs` so the production `findWorkingCommand()` (in
`readiness.ts`) picks it up. The fake is a Node script with a `#!/usr/bin/env
node` shebang and execute bit, so it can be invoked the same way the real
CLI is.

## Fake binary contract

```js
#!/usr/bin/env node
// tests/integration/fake-cursor-agent.mjs

// Environment overrides:
//   CURSOR_FAKE_FIXTURE         — absolute path to .ndjson to replay (required)
//   CURSOR_FAKE_CHUNK_BYTES     — chunk size when writing to stdout (default: 4096)
//   CURSOR_FAKE_CHUNK_DELAY_MS  — ms between chunks (default: 0)
//   CURSOR_FAKE_EXIT_CODE       — exit with this code after replay (default: 0)
//   CURSOR_FAKE_STDERR          — string written to stderr before exit (default: "")
//   CURSOR_FAKE_TRUNCATE_AT_BYTE — stop streaming at this byte offset (default: full)
//   CURSOR_FAKE_HANG_AFTER_BYTE — pause indefinitely after this offset (default: never)
//   CURSOR_FAKE_ECHO_ARGV       — when "1", write argv to a file at $CURSOR_FAKE_ECHO_FILE
//                                  before streaming (used to assert invocation correctness)

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);

// 1. Special early exits — version probe, list-models, status, login/logout
if (argv.includes("--version")) {
    process.stdout.write("fake-cursor-agent 0.0.0-test\n");
    process.exit(0);
}
if (argv[0] === "status") {
    if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify({ authenticated: true }) + "\n");
    } else {
        process.stdout.write("Logged in as fake@example.com\n");
    }
    process.exit(0);
}
if (argv[0] === "--list-models") {
    process.stdout.write("composer-2.5\nclaude-sonnet-4-6\nclaude-opus-4-7\n");
    process.exit(0);
}
if (argv[0] === "login" || argv[0] === "logout") {
    process.exit(0);
}

// 2. Stream-json invocation — argv echo for assertion
if (process.env.CURSOR_FAKE_ECHO_ARGV === "1" && process.env.CURSOR_FAKE_ECHO_FILE) {
    writeFileSync(process.env.CURSOR_FAKE_ECHO_FILE, JSON.stringify(argv));
}

const fixturePath = process.env.CURSOR_FAKE_FIXTURE;
if (!fixturePath || !existsSync(fixturePath)) {
    process.stderr.write("fake-cursor-agent: CURSOR_FAKE_FIXTURE missing or unreadable\n");
    process.exit(2);
}

const payload = readFileSync(fixturePath, "utf8");
const chunkSize = Number(process.env.CURSOR_FAKE_CHUNK_BYTES || 4096);
const chunkDelay = Number(process.env.CURSOR_FAKE_CHUNK_DELAY_MS || 0);
const truncateAt = process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE
    ? Number(process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE)
    : payload.length;
const hangAfter = process.env.CURSOR_FAKE_HANG_AFTER_BYTE
    ? Number(process.env.CURSOR_FAKE_HANG_AFTER_BYTE)
    : Infinity;

// 3. Honour SIGTERM
let terminated = false;
process.on("SIGTERM", () => { terminated = true; });

(async () => {
    let cursor = 0;
    while (cursor < Math.min(truncateAt, payload.length)) {
        if (terminated) break;
        const end = Math.min(cursor + chunkSize, truncateAt, payload.length);
        process.stdout.write(payload.slice(cursor, end));
        cursor = end;
        if (cursor >= hangAfter) {
            // Hang until SIGTERM
            await new Promise(resolve => process.once("SIGTERM", resolve));
            break;
        }
        if (chunkDelay > 0) await new Promise(r => setTimeout(r, chunkDelay));
    }

    if (process.env.CURSOR_FAKE_STDERR) {
        process.stderr.write(process.env.CURSOR_FAKE_STDERR);
    }

    process.exit(Number(process.env.CURSOR_FAKE_EXIT_CODE || 0));
})();
```

The fake covers:
- happy replay (default behaviour)
- staged failure via `CURSOR_FAKE_EXIT_CODE` + `CURSOR_FAKE_STDERR`
- mid-stream abort via `CURSOR_FAKE_HANG_AFTER_BYTE` (test fires SIGTERM)
- truncation via `CURSOR_FAKE_TRUNCATE_AT_BYTE` (simulates stream exhaustion)
- argv assertion via `CURSOR_FAKE_ECHO_ARGV=1`

## Test contract

`stream-end-to-end.test.ts` structure:

```ts
import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { streamViaCursorCli } from "../../stream-adapter.ts";
import { clearReadinessCache } from "../../readiness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fake-cursor-agent.mjs");
const FIXTURES = join(HERE, "..", "fixtures");

const ORIGINAL_BIN = process.env.CURSOR_AGENT_BIN;

before(() => {
    process.env.CURSOR_AGENT_BIN = FAKE;
});
after(() => {
    if (ORIGINAL_BIN === undefined) delete process.env.CURSOR_AGENT_BIN;
    else process.env.CURSOR_AGENT_BIN = ORIGINAL_BIN;
});
beforeEach(() => {
    clearReadinessCache();
    delete process.env.CURSOR_FAKE_EXIT_CODE;
    delete process.env.CURSOR_FAKE_STDERR;
    delete process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE;
    delete process.env.CURSOR_FAKE_HANG_AFTER_BYTE;
    delete process.env.CURSOR_FAKE_ECHO_ARGV;
});

describe("streamViaCursorCli end-to-end", () => {
    test("hello-text fixture produces a complete done message", async () => {
        process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");
        const stream = streamViaCursorCli(mockModel(), {
            messages: [{ role: "user", content: "hi", timestamp: 0 }],
        });
        const finalMessage = await stream.result;
        // assertions on content, usage, stopReason
        assert.equal(finalMessage.stopReason, "stop");
        assert.ok(finalMessage.usage.input > 0 || finalMessage.usage.output > 0);
        // ...
    });

    test("tool_call fixture attaches externalResult to the tool block", async () => { /* ... */ });

    test("abort signal terminates the child and emits aborted final", async () => {
        process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");
        process.env.CURSOR_FAKE_HANG_AFTER_BYTE = "100";
        const controller = new AbortController();
        const stream = streamViaCursorCli(mockModel(), {
            messages: [{ role: "user", content: "hi", timestamp: 0 }],
        }, { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        const final = await stream.result;
        assert.equal(final.stopReason, "aborted");
    });

    test("non-zero exit before result emits error final with redacted stderr", async () => {
        process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");
        process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE = "50";  // cut before terminal `result`
        process.env.CURSOR_FAKE_EXIT_CODE = "2";
        process.env.CURSOR_FAKE_STDERR = "auth token sk-leak-this-1234567 expired";
        const stream = streamViaCursorCli(mockModel(), {
            messages: [{ role: "user", content: "hi", timestamp: 0 }],
        });
        const final = await stream.result;
        assert.equal(final.stopReason, "error");
        // The leaked token must NOT appear in the surfaced error
        assert.doesNotMatch(final.errorMessage ?? "", /sk-leak-this/);
        assert.match(final.errorMessage ?? "", /\[REDACTED\]/);
    });

    test("clean exit before result emits stream_exhausted", async () => {
        process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");
        process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE = "50";
        process.env.CURSOR_FAKE_EXIT_CODE = "0";   // clean exit, no result
        const stream = streamViaCursorCli(mockModel(), {
            messages: [{ role: "user", content: "hi", timestamp: 0 }],
        });
        const final = await stream.result;
        assert.equal(final.stopReason, "error");
        assert.match(final.errorMessage ?? "", /stream_exhausted/);
    });

    test("buildCursorArgs invocation is correct", async () => {
        const echoFile = join(mkdtempSync(join(tmpdir(), "cursor-argv-")), "argv.json");
        process.env.CURSOR_FAKE_ECHO_ARGV = "1";
        process.env.CURSOR_FAKE_ECHO_FILE = echoFile;
        process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");

        const stream = streamViaCursorCli(mockModel(), {
            messages: [{ role: "user", content: "hi", timestamp: 0 }],
        });
        await stream.result;

        const argv = JSON.parse(readFileSync(echoFile, "utf8"));
        assert.deepEqual(argv.slice(0, 6), [
            "-p", "--output-format", "stream-json",
            "--model", "composer-2.5", "--workspace",
        ]);
        assert.ok(argv.includes("--trust"));
        assert.ok(!argv.includes("--force"));  // allowsWrites was not set
    });
});
```

## Implementation steps

1. **Create the fake binary** (`tests/integration/fake-cursor-agent.mjs`),
   make it executable (`chmod +x`), commit.
2. **Write a single happy-path test** that just replays
   `01-hello-text.ndjson` and asserts the final message has stopReason
   `stop`. Verify the project's compile-tests pipeline picks up
   `tests/integration/*.test.ts` — if not, extend
   `scripts/compile-tests.mjs` asset list or update the `test:unit:compiled`
   glob to include `dist-test/src/resources/extensions/cursor-cli/tests/integration/*.test.js`.
3. **Add tool-call test** using fixture `02-single-tool-call.ndjson`.
4. **Add abort test** with `HANG_AFTER_BYTE`.
5. **Add non-zero-exit test with stderr redaction** — assertion for
   `redactSecrets()` integration.
6. **Add stream-exhausted test** with `TRUNCATE_AT_BYTE`.
7. **Add argv-correctness test** using `ECHO_ARGV`.
8. **Add a `buildCursorArgs` variant test** that sets
   `CursorStreamOptions.allowsWrites = true` and asserts `--force` appears
   in echoed argv. (This pre-validates plan #03's wiring.)

## Files to create / modify

### Create

- `src/resources/extensions/cursor-cli/tests/integration/fake-cursor-agent.mjs` (executable)
- `src/resources/extensions/cursor-cli/tests/integration/stream-end-to-end.test.ts`
- `src/resources/extensions/cursor-cli/tests/integration/README.md` — explains
  the fake-binary contract and the env-var matrix for future authors.

### Modify

- `package.json` — extend `test:unit:compiled` glob to include
  `"dist-test/src/resources/extensions/cursor-cli/tests/integration/*.test.js"`.
- `scripts/compile-tests.mjs` — verify `.mjs` files in test directories are
  copied as-is (executable bit preserved). If not, fix the copy logic.

## Testing strategy

- Each test uses a deterministic fixture, so test runs are reproducible.
- Tests run under `node:test` with `--experimental-test-isolation=process`
  (the project's existing mode) — process isolation means env-var pollution
  is contained per-test.
- `clearReadinessCache()` in `beforeEach` so each test rediscovers the fake.
- Total expected runtime: under 5 s for the whole integration suite.

## Acceptance criteria

- ✅ `fake-cursor-agent.mjs` honours `--version` (for readiness probe),
  `status` (for auth probe), `--list-models` (for catalogue refresh), and
  the streaming invocation contract.
- ✅ Six integration tests pass (happy / tool-call / abort / non-zero exit /
  exhausted / argv-echo) under `npm run test:unit`.
- ✅ Stderr redaction asserted: a fake stderr containing `sk-leak-this-1234567`
  results in an error message containing `[REDACTED]` and not the raw token.
- ✅ Abort path verified: `CURSOR_FAKE_HANG_AFTER_BYTE` plus an
  `AbortController` produces a final `AssistantMessage` with stopReason
  `aborted`, and the fake's exit status confirms SIGTERM was received.
- ✅ `npm run verify:pr` passes; test count increases by exactly N (= test
  count in the new file).
- ✅ No new files leak under `src/resources/extensions/cursor-cli/tests/` —
  argv-echo writes only to `mktemp`'d paths.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| The dist-test pipeline doesn't copy `.mjs` files into `dist-test/` — fake binary unreachable from compiled tests | Verify before writing tests; if needed, patch `scripts/compile-tests.mjs` asset list and document |
| `process.env.CURSOR_AGENT_BIN` doesn't get picked up because `findWorkingCommand` short-circuits on cached results | `clearReadinessCache()` in `beforeEach` — already in test plan |
| SIGTERM doesn't fire on Windows the same way | Mark abort test as Linux/macOS only via `test.skipIf(process.platform === 'win32')`. Windows uses `child.kill()` which sends SIGTERM-equivalent, but the fake's `process.on('SIGTERM')` is not portable |
| Timing flakiness on abort test (race between abort and child finish) | Use `CURSOR_FAKE_HANG_AFTER_BYTE` set early enough that the child is guaranteed not to finish; assert child exited via `signal` not `code` |
| Argv-echo writes to a path that doesn't exist | Test creates a `mktemp` dir and passes the file path; clean up in `after()` |

## Branch & upstream posture

- **Upstream-safe.** No `UPSTREAM_REVIEW:` markers. This is pure test
  infrastructure.
- Recommended branch: same topic branch as plan #01, or a child branch
  `feat/cursor-cli-integration-tests` off `feat/cursor-cli-provider`.
- Folds into the upstream PR cleanly when plan #01 + #02 land together —
  the parent plan explicitly listed both as Phase 1 testing.

## Open questions

1. **Glob update strategy.** The current `test:unit:compiled` glob enumerates
   directories explicitly. Adding an `integration/` subdirectory means
   either extending the glob or moving the integration test up one level.
   Recommend extending the glob — keeps "integration" semantically separated.
2. **Should the fake also surface a `--help`?** Real `cursor-agent --help`
   may be invoked by future doctor commands. Not needed for this plan but
   trivial to add.
3. **Test isolation and env-var leaks.** Process-isolation `--test-isolation=process`
   means env vars set in one test do not leak. Confirm before relying on
   `delete process.env.CURSOR_FAKE_*` in `beforeEach` — it may be redundant
   but is safer.

## Acceptance test command sequence (for a new agent)

```bash
# pre-conditions
git checkout feat/cursor-cli-fixtures   # branch from plan #01
git checkout -b feat/cursor-cli-integration-tests

# implementation per "Implementation steps"

# verify locally
npm run test:compile
node --import ./scripts/dist-test-resolve.mjs \
  --experimental-strip-types \
  --test "dist-test/src/resources/extensions/cursor-cli/tests/integration/*.test.js"

# full preflight
npm run verify:pr
```

If the integration test count is non-zero and `verify:pr` passes, this plan
is done.
