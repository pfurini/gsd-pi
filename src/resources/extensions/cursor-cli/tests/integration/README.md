# cursor-cli integration tests

End-to-end tests for `streamViaCursorCli` that exercise the spawn/pump loop
without depending on a real `cursor-agent` install.

## How it works

`stream-end-to-end.test.ts` sets `CURSOR_AGENT_BIN` to the absolute path of
`fake-cursor-agent.mjs`. The extension's `findWorkingCommand()` picks up the
override, so `streamViaCursorCli` spawns the fake the same way it would the
real CLI.

The fake replays one of the NDJSON fixtures from `../fixtures/` and supports
parametric failure modes via env vars. Each test sets `CURSOR_FAKE_*` to
shape the replay before invoking the stream.

## Fake binary env matrix

| Variable | Purpose | Default |
|---|---|---|
| `CURSOR_FAKE_FIXTURE` | Absolute path to the `.ndjson` to replay | required |
| `CURSOR_FAKE_CHUNK_BYTES` | Stdout chunk size in bytes | `4096` |
| `CURSOR_FAKE_CHUNK_DELAY_MS` | Sleep between chunks | `0` |
| `CURSOR_FAKE_EXIT_CODE` | Process exit code after replay | `0` |
| `CURSOR_FAKE_STDERR` | String to emit on stderr just before exit | `""` |
| `CURSOR_FAKE_TRUNCATE_AT_BYTE` | Stop streaming at this byte offset | full payload |
| `CURSOR_FAKE_HANG_AFTER_BYTE` | Pause indefinitely after this offset (released by SIGTERM) | never |
| `CURSOR_FAKE_ECHO_ARGV` | When `"1"`, write argv to `CURSOR_FAKE_ECHO_FILE` before streaming | off |
| `CURSOR_FAKE_ECHO_FILE` | Target path for the argv echo (must be writable) | n/a |

The fake also short-circuits a few non-streaming subcommands so the readiness
and catalogue probes work:

- `--version` → prints `fake-cursor-agent 0.0.0-test`, exits 0
- `status` / `status --json` → reports authenticated
- `--list-models` → prints a small static catalogue
- `login` / `logout` → no-op exit 0

## Test scenarios covered

1. **happy text replay** — `01-hello-text.ndjson` → final `done` message
2. **happy tool-call replay** — `02-single-tool-call.ndjson` → `externalResult`
   attached to the tool-call block
3. **abort** — small chunks + `HANG_AFTER_BYTE` + `AbortController.abort()` →
   final `aborted`
4. **non-zero exit + redacted stderr** — `TRUNCATE_AT_BYTE` + `EXIT_CODE=2` +
   leaked-secret stderr → final `error` with `[REDACTED]` and no raw token
5. **stream exhausted** — `TRUNCATE_AT_BYTE` with clean exit → final `error`
   with `stream_exhausted_without_result`
6. **argv contract** — `ECHO_ARGV` writes argv JSON to a temp file; the test
   asserts on the documented invocation shape
7. **`--force` opt-in** — `CursorStreamOptions.allowsWrites = true` adds
   `--force` to the spawned argv

## Build pipeline

`scripts/compile-tests.mjs` skips `integration/` subdirectories everywhere
except this one — `COMPILE_INTEGRATION_ALLOWLIST` opts the cursor-cli folder
in so the test compiles under `dist-test/` and runs via `test:unit:compiled`.

## Adding new scenarios

Drop a new fixture in `../fixtures/`, add a test case that sets the
appropriate `CURSOR_FAKE_*` vars, and re-run `npm run test:unit`. Tests run
under `--experimental-test-isolation=process` so env vars don't leak across
cases, but the `beforeEach` block still clears them defensively.
