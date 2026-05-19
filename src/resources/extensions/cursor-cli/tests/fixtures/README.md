# Cursor CLI live-binary fixtures

These NDJSON fixtures capture the real wire output of `cursor-agent -p
--output-format stream-json …` and act as the regression net for
`mapCursorEvent()` (see `../../stream-adapter.ts`).

Tracked by plan `.plans/cursor-cli-01-ndjson-fixtures.md`.

## Layout

```
fixtures/
├── README.md                  # this file
├── capture.sh                 # invoke cursor-agent, sanitise into a fixture
├── sanitize.mjs               # idempotent sanitiser
├── prompts/                   # input prompts used by capture.sh
├── raw/                       # gitignored — pre-sanitisation captures
├── NN-<name>.ndjson           # sanitised, committed
├── NN-<name>.meta.json        # cursor-agent version, model, timestamp
└── NN-<name>.expected.json    # expected GSD event sequence (snapshot)
```

## Sanitisation

`sanitize.mjs` masks developer-specific tokens before a fixture is
committed. The list of redactions is intentionally over-eager:

| Pattern                              | Replacement                              |
| ------------------------------------ | ---------------------------------------- |
| `session_id` field                   | `sess-XXXXXXXX`                          |
| `cwd` field                          | `/tmp/fixture-workspace`                 |
| absolute home paths (`/Users/<u>`, `/home/<u>`) | `<HOME>`                       |
| email addresses                      | `[REDACTED_EMAIL]`                       |
| ISO-8601 timestamps                  | `1970-01-01T00:00:00Z`                   |
| `duration_ms`, `started_at`          | `0`                                      |
| Bearer / JWT / sk- / cursor-key-     | `[REDACTED]` (via `../redact.ts`)        |

The sanitiser is **idempotent** — applying it twice produces an identical
output. The committed fixture must remain valid NDJSON and must still
drive `mapCursorEvent` to the same `AssistantMessage`.

## Recapturing a fixture

```bash
# from this directory
./capture.sh 01-hello-text prompts/01-hello.txt
./capture.sh 02-single-tool-call prompts/02-read-fixture.txt
./capture.sh 03-multi-tool-call prompts/03-multi-step.txt
```

Then re-seed the `.expected.json` snapshots from repo root:

```bash
UPDATE_FIXTURE_SNAPSHOTS=1 npm run test:unit -- \
  --test-only-grep="fixture replay"
# or, faster:
UPDATE_FIXTURE_SNAPSHOTS=1 node --experimental-strip-types \
  --test src/resources/extensions/cursor-cli/tests/fixture-replay.test.ts
```

After updating, run the test once more **without** the env var to confirm
the snapshot is deterministic, then commit `.ndjson`, `.meta.json`, and
`.expected.json` together.

## Adding a new fixture

1. Add a prompt file under `prompts/`.
2. Run `./capture.sh <name> prompts/<prompt-file>`.
3. Re-seed `.expected.json` as shown above.
4. `grep` the committed `.ndjson` to confirm no `/Users/`, no email, no
   bearer tokens leaked through.
