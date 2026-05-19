# Cursor — Executor Provider via Cursor CLI / SDK

## Status: DRAFT — Awaiting approval

## Problem

GSD users with a paid Cursor subscription (Pro / Pro+ / Ultra / Teams) cannot currently use Cursor as a code-execution backend inside GSD. The only "delegate the full agent loop to a vendor CLI" provider available today is `claude-code-cli`, which targets Anysphere-adjacent users only.

Adding Cursor as a first-class executor unlocks:
1. Multi-model routing on a single paid plan (Claude, GPT-5.x, Gemini, Composer 2, Grok) without per-provider API keys
2. The full Cursor agent harness (codebase indexing, semantic search, MCP, Skills, Hooks, subagents) inside GSD slices
3. Cost-optimised routing via Composer 2 for routine slices

The codebase already anticipates Cursor at a config-discovery level (`ToolId` in `src/resources/extensions/universal-config/types.ts` includes `"cursor"`), but no execution provider exists.

## Goal

A self-contained extension under `src/resources/extensions/cursor-cli/` that:
- Detects a working `cursor-agent` binary and a valid auth state
- Registers a `cursor-agent` provider via `pi.registerProvider()` exposing the models Cursor currently advertises
- Delegates streaming to the Cursor CLI in headless mode (`agent -p --output-format stream-json`) and translates the NDJSON event stream into GSD's `AssistantMessageEvent` shape — same contract `claude-code-cli` honours today
- Surfaces readiness/auth/model status in the TUI exactly like the Claude Code provider does

Zero core changes outside the extension and the minimal type/registry plumbing already used by `claude-code-cli`.

## Architecture

Mirror of `src/resources/extensions/claude-code-cli/`, with two execution paths:
- **CLI path (Phase 1, GA)** — `execFile`/`spawn` the `cursor-agent` binary with `-p --output-format stream-json`, parse NDJSON line by line, map events
- **SDK path (Phase 2, behind a feature flag)** — dynamic `import("@cursor/sdk")`, drive `Agent.create()` + `run.stream()`, map the discriminated `SDKMessage` union

The CLI path is the primary surface. The SDK path is added later because `@cursor/sdk` is still labelled public beta (April 2026). Both routes feed the same internal `mapCursorEvent()` translator so the rest of the extension is path-agnostic.

Authentication is delegated entirely to the user's existing Cursor install. The extension never handles credentials — it only checks `agent status` (or `CURSOR_API_KEY` env var) the same way `claude-code-cli/readiness.ts` checks `claude auth status`.

## File Structure

```
src/resources/extensions/cursor-cli/
├── index.ts                  # Extension entry — registerProvider("cursor-agent", {...})
├── readiness.ts              # Probe `agent --version` + `agent status` / CURSOR_API_KEY (cached)
├── models.ts                 # Static + dynamic model catalogue (composer-2.5, claude-*, gpt-5.*, gemini-*, grok-*)
├── sdk-types.ts              # Type mirrors for @cursor/sdk + CLI stream-json event shapes (no hard dep)
├── stream-adapter.ts         # streamSimple → spawn CLI → NDJSON parser → AssistantMessageEvent stream
├── partial-builder.ts        # Mirrors claude-code-cli/partial-builder.ts for incremental message assembly
├── ndjson-parser.ts          # Line-buffered NDJSON parser (handles CRLF, partial chunks, oversize lines)
├── auth-cli-helper.ts        # Optional: `/cursor login` / `/cursor status` slash command wiring
├── tests/
│   ├── readiness.test.ts
│   ├── stream-adapter.test.ts
│   ├── ndjson-parser.test.ts
│   └── models.test.ts
├── extension-manifest.json   # Manifest (id, capabilities, dependencies)
└── package.json              # Workspace package declaration
```

Layout deliberately matches `claude-code-cli/` 1:1 (`index.ts`, `readiness.ts`, `models.ts`, `sdk-types.ts`, `stream-adapter.ts`, `partial-builder.ts`, `tests/`) plus an explicit `ndjson-parser.ts` because the CLI is the primary path (vs claude-code-cli, which leans on the SDK). Add one extra file `redact.ts` for the secret-masking helper used by every log and error-surface call site.

## Compliance & Data Handling

These rules apply on every branch, including any upstream PR. They harden the §2 compliance posture from the [ADR](https://github.com/gsd-build/gsd-2/issues/6393) against side-channel leaks. They are independent from the "fork-only features" listed in the *Upstream PR Posture* section near the end of this plan.

- **Auth probe output is opaque.** `probeAuth()` parses only the `authenticated` boolean (plus an optional model count) from `agent status --json`. Raw stdout is never logged, persisted, or surfaced in errors. The text-mode fallback checks a single substring without recording the full output.
- **`CURSOR_API_KEY` is never read into GSD memory.** The readiness probe only checks `process.env.CURSOR_API_KEY !== undefined`. The value is forwarded to the child process via Node's default env inheritance — never copied into a JS variable, written to disk, included in telemetry, or printed in error messages or stack traces.
- **All extension logging passes through `redactSecrets()`.** New file `cursor-cli/redact.ts` masks `Bearer …`, `sk-…`, `cursor-key-…`, and JWT-shaped strings (`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`). Every `GSD_CURSOR_DEBUG=1` log call and every error string surfaced from the child (stderr + `error` event payload + non-zero exit reason) is wrapped.
- **`/cursor login` is a pure shell-out.** No interception of the browser OAuth flow, no callback handling, no token capture. GSD only invokes `cursor-agent login` as a child process; the user's browser talks to Cursor's OAuth endpoint directly.
- **Session ids are user-and-machine-scoped.** The `session_id` from `system/init` is stored on the slice record for `--resume` reuse only and purged when the slice is deleted. Not a credential, but not exportable either.
- **Branding stays descriptive.** Onboarding label is "Cursor (via your subscription)". No "Powered by Cursor" / "Official integration" / endorsement-implying phrasing in any user-visible string.

## Scope

### Phase 1: CLI-backed provider (GA path)

**What:** A provider registered as `cursor-agent` that spawns `cursor-agent -p --output-format stream-json`, parses NDJSON events, and exposes the same `streamSimple` contract `claude-code-cli` already implements. Ships behind a `GSD_CURSOR_DISABLE=1` kill-switch but enabled by default once readiness probe passes.

**Extension files:**

- `cursor-cli/index.ts` — Entry. Registers the provider via `pi.registerProvider("cursor-agent", { authMode: "externalCli", api: "cursor-stream-json", baseUrl: "local://cursor-agent", isReady: isCursorReady, streamSimple: streamViaCursorCli, models: getCursorModels() })`. Re-runs readiness on `session_start`; unregisters on shutdown.

- `cursor-cli/readiness.ts` — Direct port of `claude-code-cli/readiness.ts`:
  - `getCursorCommandCandidates()` — `["cursor-agent", "agent"]` on POSIX; `["cursor-agent.cmd", "agent.cmd", "cursor-agent.exe", "agent.exe"]` on Windows (the install script ships both names; some shells alias one to the other)
  - `findWorkingCommand()` — first candidate that answers `--version` within `VERSION_TIMEOUT_MS = 5_000`
  - `probeAuth()` — runs `<cmd> status --json` first, falls back to plain `<cmd> status` text heuristic if `--json` is not supported; ALSO checks `process.env.CURSOR_API_KEY` as a short-circuit "authed" signal
  - Cache: `cachedBinaryPresent`, `cachedAuthed`, 30 s TTL, `clearReadinessCache()` for post-login refresh
  - `GSD_CURSOR_DEBUG=1` mirrors `GSD_CLAUDE_DEBUG=1` debug logging

- `cursor-cli/models.ts` — Static catalogue keyed off `agent --list-models` output (captured at build time + refreshed at runtime). Initial seed:
  ```ts
  export const CURSOR_MODELS = [
    { id: "composer-2.5",     name: "Composer 2.5 (Cursor)",         reasoning: false, input: ["text","image"], cost: TOKEN_BASED, contextWindow: 200_000, maxTokens: 64_000 },
    { id: "claude-sonnet-4-6",name: "Claude Sonnet 4.6 (via Cursor)", reasoning: true,  input: ["text","image"], cost: TOKEN_BASED, contextWindow: 1_000_000, maxTokens: 64_000 },
    { id: "claude-opus-4-7",  name: "Claude Opus 4.7 (via Cursor)",   reasoning: true,  input: ["text","image"], cost: TOKEN_BASED, contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: "gpt-5.5",          name: "GPT-5.5 (via Cursor)",          reasoning: true,  input: ["text","image"], cost: TOKEN_BASED, contextWindow: 256_000, maxTokens: 64_000 },
    { id: "gemini-2.5-pro",   name: "Gemini 2.5 Pro (via Cursor)",   reasoning: true,  input: ["text","image"], cost: TOKEN_BASED, contextWindow: 2_000_000, maxTokens: 64_000 },
    { id: "grok-4",           name: "Grok 4 (via Cursor)",           reasoning: true,  input: ["text"],        cost: TOKEN_BASED, contextWindow: 256_000, maxTokens: 64_000 },
  ];
  ```
  `cost: TOKEN_BASED` is the structural placeholder — actual billing happens against the user's Cursor quota; GSD records the `usage` block emitted by Cursor's `result` event for display only, never derives dollar cost (unlike Ollama which is zero, or providers with per-token rates baked in).

- `cursor-cli/sdk-types.ts` — Type mirrors for the NDJSON event union:
  ```ts
  export type CursorStreamEvent =
    | { type: "system"; subtype: "init"; session_id: string; model: string; cwd: string; tools?: string[] }
    | { type: "assistant"; uuid: string; session_id: string; message: { role: "assistant"; content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }> } }
    | { type: "tool_call"; uuid: string; tool_call_id: string; name: string; input: unknown; session_id: string }
    | { type: "tool_result"; uuid: string; tool_call_id: string; output: unknown; is_error: boolean; session_id: string }
    | { type: "result"; subtype: "success" | "error"; session_id: string; result: string; usage: { input_tokens: number; output_tokens: number }; duration_ms: number; is_error: boolean }
    | { type: "stream_event"; event: { type: string; delta?: unknown }; uuid: string; session_id: string } // when --stream-partial-output is on
    | { type: "error"; message: string; session_id?: string };
  ```
  Schema verified against `cursor.com/docs/cli/reference/output-format`. `thinking` is intentionally absent — Cursor suppresses thinking events in `-p` mode.

- `cursor-cli/ndjson-parser.ts` — Line-buffered parser over a Node `Readable`. Handles `\r\n` and `\n` terminators, partial chunks across reads, oversize lines (defensive 4 MB cap), and JSON parse failures (logged + skipped, never thrown). Public surface: `async function* parseNdjson(stream: Readable): AsyncIterable<CursorStreamEvent>`.

- `cursor-cli/stream-adapter.ts` — Heart of the integration. Implements `streamSimple(context, model, options)`:
  1. Build invocation: `cursor-agent -p --output-format stream-json --force --model <model.id> --workspace <cwd> --trust [--resume <sessionId>]` (latch `--force` only when GSD slice declares write intent; default keep prompt-confirm)
  2. Build prompt: concatenate the `Context` messages into the single-prompt form Cursor expects (system + user history). For multi-turn, prefer `--resume <id>` over re-priming.
  3. Spawn via `spawn()` (not `execFile` — we need streaming stdout). Wire `CURSOR_API_KEY` env into the child if present.
  4. Iterate `parseNdjson(child.stdout)`, translate each `CursorStreamEvent` into one or more `AssistantMessageEvent` via `mapCursorEvent()`:
     - `system/init` → `session_start` event with `sessionId` for later `--resume`
     - `assistant.content[].text` → `text_delta` events (chunked through `PartialMessageBuilder` for TUI smoothness)
     - `assistant.content[].tool_use` → `tool_call` block (mark `externalToolExecution: true` so Agent Core does not redispatch)
     - `tool_call` standalone → `tool_call` block (Cursor sometimes emits these out-of-band when streaming partial)
     - `tool_result` → attach `externalResult` to the matching `ToolCall` (mirrors claude-code-cli's `ExternalToolResultPayload` shape)
     - `result` → `message_stop` with `usage` (input/output tokens) and `stop_reason`
     - `error` → surface as `AssistantMessage.error` (no retry; let Agent Core decide)
  5. Resolve the final `AssistantMessage` on `result`. Reject if child exits non-zero before `result` fires, surfacing stderr in the error.
  6. Honour `options.abortSignal` — kill the child with `SIGTERM` and let stdout drain; emit a synthetic `message_stop { stop_reason: "abort" }`.

- `cursor-cli/partial-builder.ts` — Direct port of `claude-code-cli/partial-builder.ts` with the same delta accumulation discipline (used by `mapCursorEvent` to coalesce text deltas across `stream_event` chunks).

- `cursor-cli/extension-manifest.json` — `{ "id": "cursor-cli", "displayName": "Cursor CLI", "capabilities": ["provider"], "dependencies": [] }`.

**Core changes (minimal — match `claude-code-cli` precedent):**

- `packages/pi-ai/src/types.ts` — Add `"cursor-agent"` to `KnownProvider`, `"cursor-stream-json"` to `KnownApi`.
- `packages/pi-ai/src/env-api-keys.ts` — Add `"cursor-agent"` → returns `process.env.CURSOR_API_KEY ?? "cursor-agent"` placeholder (analogous to the `"claude-code"` placeholder; resolver never blocks on missing key when `authMode: "externalCli"`).
- `src/onboarding.ts` — Add `"cursor-agent"` to the provider picker, label "Cursor (via your subscription)".
- `src/wizard.ts` — Add `cursor-agent` entry (no key required — relies on `agent login` or `CURSOR_API_KEY`).
- `src/resources/extensions/<bootstrap>/extension-list.ts` (or equivalent loader manifest — verify exact location during plan refinement) — register the new extension so it is loaded on startup.

**Behaviour:**

- On startup, if `cursor-agent --version` and auth probe pass within 30 s, models appear in `/model` under provider `cursor-agent`.
- `/model cursor-agent/claude-opus-4-7` switches the slice to Cursor-backed Opus 4.7 with zero further config.
- If `cursor-agent` is missing or unauthenticated, the extension stays silent (no models registered, no error toast — same UX contract as the Claude Code provider on a non-Anthropic-subscribed machine).
- `GSD_CURSOR_DISABLE=1` short-circuits the readiness probe to keep the extension dormant.

### Phase 2: Native `@cursor/sdk` adapter (behind a feature flag)

**What:** Add an alternative streaming path that dynamically imports `@cursor/sdk`, calls `Agent.create({ apiKey, model, local: { cwd } })`, and consumes `run.stream()` directly. Selected via `GSD_CURSOR_USE_SDK=1` while the SDK is in public beta; promoted to default once Cursor declares GA.

**Extension files (additive):**

- `cursor-cli/sdk-adapter.ts` — New module exporting `streamViaCursorSdk()`. Uses `createRequire(import.meta.url).resolve("@cursor/sdk")` to dynamic-import; on resolution failure, falls back to the CLI path with a single-line warning.
- `cursor-cli/sdk-types.ts` — Extend with `SDKMessage` union mirrors (`assistant`, `tool_call`, `tool_progress`, `result`, `status`), aligned with `@cursor/sdk` types.

**Why bother with the SDK path:**
- Lower-latency event handoff (no subprocess boundary, no NDJSON parsing).
- `Agent.create({ cloud: {...} })` opens the path to sandboxed cloud VMs — useful for long-running slices, parallel execution, PR auto-creation.
- Native Hooks / Skills / Subagents access matches what Cursor advertises.

**Cost:** the SDK adds a hard runtime dependency surface (`@cursor/sdk`) we have to track for breaking changes. While the SDK is beta, gate behind the env flag and document it as opt-in.

### Phase 3: `/cursor` slash commands + management UX

**What:** Optional quality-of-life commands (matches the `/ollama` precedent for visibility and discoverability):

- `/cursor` — Status overview: binary path, version, auth state, current model, last 5 sessions (from `cursor-agent --list-sessions` if available).
- `/cursor login` — Shell out to `cursor-agent login` (foregrounds the browser OAuth flow; no GSD-side credential handling).
- `/cursor logout` — Shell out to `cursor-agent logout`.
- `/cursor models` — Re-run `cursor-agent --list-models` and refresh the model catalogue (handles new model rollouts without a GSD restart).
- `/cursor resume <session>` — Set the next slice to resume an earlier Cursor session via `--resume`.

Implemented in `cursor-cli/auth-cli-helper.ts` via `pi.registerCommand()`. Pure shell-outs to `cursor-agent` — no networking or credential paths owned by GSD.

## Implementation Order

1. **Phase 1** — CLI provider with NDJSON adapter. Highest user value, smallest surface, ships on stable Cursor GA bits.
2. **Phase 3** — `/cursor` slash commands. Pure quality-of-life on top of Phase 1.
3. **Phase 2** — `@cursor/sdk` adapter behind feature flag. Defer until SDK GA + a real driver use case (cloud sessions, hooks, parallel runs).

## Core Changes Summary (minimal)

| File | Change |
|------|--------|
| `packages/pi-ai/src/types.ts` | Add `"cursor-agent"` to `KnownProvider`; `"cursor-stream-json"` (Phase 1) and `"cursor-sdk"` (Phase 2) to `KnownApi`. |
| `packages/pi-ai/src/env-api-keys.ts` | Add `"cursor-agent"` → `process.env.CURSOR_API_KEY ?? "cursor-agent"` placeholder. |
| `src/onboarding.ts` | Add `"cursor-agent"` to provider picker. |
| `src/wizard.ts` | Add `cursor-agent` entry (no key required). |
| `<extension loader manifest>` | Register `cursor-cli` extension for startup load. Exact path to confirm during plan refinement. |

Everything else lives in `src/resources/extensions/cursor-cli/`.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `cursor-agent` binary name varies by install path (`agent` vs `cursor-agent`) and is unstable across releases | Try both candidates in `findWorkingCommand()` like `claude-code-cli` does on Windows; document `CURSOR_AGENT_BIN` override. |
| Cursor changes the NDJSON event shape between versions | Treat unknown event types as warnings, not errors; pin to the documented event vocabulary; integration tests against captured fixtures from `cursor-agent --version`. |
| `thinking` events are suppressed in `-p` mode → no reasoning visibility in TUI | Accept the limitation in Phase 1; revisit in Phase 2 (SDK exposes `tool_progress` and may surface thinking). Document the gap. |
| SDK beta API churn breaks Phase 2 | Gate behind `GSD_CURSOR_USE_SDK=1` flag until SDK GA; dynamic import so missing/incompatible SDK degrades gracefully to CLI path. |
| Cursor ToS §1.5(v) "competitive with the Service" / §1.5(vii) "benchmark publication" | Document GSD as a workflow orchestrator that delegates to Cursor (not a competitor). Avoid publishing performance comparisons across Cursor/Claude Code/Codex without "necessary information to replicate" per §1.5(vii). Legal review before GA if any commercial positioning. |
| Cursor Pro/Pro+ quota exhaustion during long slices | Surface the `usage` block from `result` events in the TUI footer (mirrors how Claude Code shows token counts). Document on-demand pricing in onboarding. |
| Workspace `--trust` prompts block headless runs | Always pass `--trust` in `streamSimple` (we already trust the slice cwd); document the flag and its security implication. |
| `--force` allows unsupervised file writes | Default to NO `--force`; only enable when GSD slice declares write intent (existing `slice.allowsWrites` style flag). Mirrors `claude-code-cli` permission gating. |
| Auth state caching staleness post-login | `clearReadinessCache()` on `/cursor login` completion and on `CURSOR_API_KEY` change at the start of each session. |
| Debug-log credential leak | Readiness output never logged raw; `redactSecrets()` wraps every `GSD_CURSOR_DEBUG=1` log call. |
| Error-surfacing credential leak | `redactSecrets()` wraps all child stderr, `error` event payload strings, and non-zero exit reasons before they reach TUI / logs / telemetry. |
| Extension disabled — no impact on core | Extension is additive; disabling removes models cleanly via `unregisterProvider("cursor-agent")`. |

## Testing Strategy

- **Unit tests:**
  - `readiness.test.ts` — Mock `execFileSync` to cover: binary missing, binary present + unauthenticated, binary present + authenticated (JSON), JSON missing + text heuristic, `CURSOR_API_KEY` short-circuit, Windows `cmd /c` path.
  - `ndjson-parser.test.ts` — Partial chunks across read boundaries, CRLF mix, oversize line truncation, malformed JSON lines (warned not thrown), large file replay.
  - `stream-adapter.test.ts` — Drive `mapCursorEvent` with captured fixture NDJSON files (one per `system`/`assistant`/`tool_call`/`tool_result`/`result`/`error` event); assert emitted `AssistantMessageEvent` sequence.
  - `models.test.ts` — Static catalogue shape + `parseListModelsOutput()` for dynamic refresh.
- **Integration tests:**
  - Fake `cursor-agent` shim (a small Node script) that emits a pre-recorded NDJSON sequence to stdout; the extension spawns it like the real CLI; assert end-to-end `streamSimple` produces the expected `AssistantMessage` with correct `ToolCall` blocks and `externalResult` payloads.
  - Auth-mode test mirroring `ollama-auth-mode.test.ts` to confirm `registerProvider` is called with `authMode: "externalCli"`.
- **Manual test matrix:**
  - macOS + real `cursor-agent` logged in via OAuth → run a slice end-to-end across each registered model.
  - macOS + `CURSOR_API_KEY` only (no `agent login`) → same matrix.
  - Linux + `cursor-agent` install via curl script → readiness + one slice.
  - Windows + `cursor-agent.cmd` shim → readiness + one slice.
  - `GSD_CURSOR_DISABLE=1` → extension stays dormant.

## Open Questions

1. **Default `--force` policy?** Claude Code defers tool approval to its own permissioning. Cursor CLI requires `--force`/`--yolo` for autonomous edits. **Recommendation:** opt-in per slice — only pass `--force` when GSD's slice flags declare write intent; surface a "Cursor will edit files unattended" badge in the TUI for visibility.
2. **Session resumption strategy?** GSD slices are nominally single-turn for the executor. Should we persist `session_id` from `system/init` across slices so `--resume` can stitch a slice chain? **Recommendation:** store `session_id` on the slice record; allow `--resume` opt-in via `/cursor resume`; default to fresh session per slice for predictability.
3. **Model catalogue refresh cadence?** `agent --list-models` may add new models between GSD releases. **Recommendation:** refresh on startup, on `/cursor models`, and every 24 h via a background timer; merge under static seed (seed wins for capabilities, dynamic adds new ids).
4. **Sandbox flag default?** `--sandbox enabled` adds an extra security layer but may break tooling that needs network or file-system writes. **Recommendation:** leave `--sandbox` unset (CLI default); document `CURSOR_SANDBOX=enabled` env override for users who want stricter isolation.
5. **Cost display semantics?** Cursor bills against the user's Cursor quota in their own currency. Should the TUI show "tokens consumed" only, or estimate the quota draw? **Recommendation:** show token counts (we get them from `result.usage`) + a "billed against Cursor plan" footer; do not attempt to estimate dollar cost.
6. **Cloud Agents path?** Phase 2 SDK can call `Agent.create({ cloud: {...} })` for sandboxed VMs. Worth exposing through GSD or out of scope for the first integration? **Recommendation:** out of scope for Phase 1/2; revisit once we have a use case (parallel slice execution, long-running background tasks).

## Acceptance Criteria

- ✅ User with `cursor-agent` installed and authenticated sees Cursor models in `/model` within 30 s of GSD startup.
- ✅ `/model cursor-agent/composer-2.5` switches the active model; the next slice runs against Cursor and streams text/tool events into the TUI.
- ✅ Tool calls emitted by Cursor are rendered in the TUI with their results, marked as `externalToolExecution` so Agent Core does not redispatch them.
- ✅ `result.usage` is captured and displayed in the slice footer.
- ✅ `GSD_CURSOR_DISABLE=1` prevents all Cursor activity at startup.
- ✅ Tests above pass in CI.
- ✅ No regression in `claude-code-cli` provider behaviour (the two coexist via `KnownProvider` discrimination).
- ✅ No Cursor credentials (OAuth bearer, `CURSOR_API_KEY` value, JWT) appear in any GSD log, persisted state file, or telemetry payload — verified by replaying a recorded debug session and grepping the output.

## Upstream PR Posture — Items Requiring Maintainer Sign-Off

The plan intentionally includes three features that sit in tension with the §2 compliance posture in [ADR #6393](https://github.com/gsd-build/gsd-2/issues/6393). They are implemented on this fork's branch as planned — but **must be re-discussed with upstream maintainers before being included in any PR to `gsd-build/gsd-2`** — either to keep them as-is, drop them from the PR, or refactor them into an opt-in form acceptable to the maintainers.

These are not gaps in the plan; they are deliberate features whose upstream acceptability is uncertain.

### A. Cross-vendor failover driven by Cursor quota signals (Phase 1)
- **What we build:** `result.usage` quota-exhaustion errors from `cursor-agent` enter the existing retry-handler (#5184 / #4394 precedent) and trigger automatic rotation to the next configured provider (e.g. `claude-code-cli`, `openai-codex`).
- **Tension with ADR §2.3:** "No GSD-side metering or routing across vendors." Using one vendor's reported quota to drive a switch into a competing vendor could read as competitive routing.
- **Defence framing for upstream review:** the trigger is a discrete error event reported by the vendor's own CLI, not a continuous cost-optimization function — it mirrors what `claude-code-cli` already does today. Worth proposing as an opt-in `allow_cross_vendor_failover` toggle defaulting to **off** in the upstream PR.

### B. Comparative doctor telemetry (Phase 3 — local-only)
- **What we build:** `/cursor` status overview and `gsd doctor` output for `cursor-agent` include latency, success rate, and token-cost columns side-by-side with other providers.
- **Tension with Cursor ToS §1.5(vii):** the clause restricts *publishing* benchmarks. Local diagnostic display is plausibly outside that scope, but the line is fuzzy.
- **Defence framing for upstream review:** data stays strictly local — never collected as GSD telemetry, never aggregated cross-user, never exported. Upstream PR ships with an explicit "no comparative cursor metrics in any telemetry sink" assertion plus a test that fails if any metric flows into a telemetry path.

### C. MCP / Hooks / Skills / Subagents passthrough (Phase 2)
- **What we build:** the SDK path (`@cursor/sdk`) surfaces Cursor's MCP servers, Skills, Hooks, and subagents into GSD slices — letting a slice driven by `cursor-agent` use Cursor's harness end-to-end.
- **Tension with ADR §2.4:** the more of Cursor's harness GSD surfaces under its own UI, the more GSD looks like a thin wrapper that re-presents Cursor's full product, which is the "competitive service" framing §1.5(v) is wary of.
- **Defence framing for upstream review:** position as a **passthrough**, not a re-implementation. The slice runs *inside* the Cursor harness; GSD doesn't proxy or rebrand. Mirrors what `claude-code-cli` already does for Claude Code's MCP/skills. Document which Cursor capabilities are passthrough vs. observed-only.

### Tracking
Each of these gets a grep-able comment marker — `UPSTREAM_REVIEW:A`, `UPSTREAM_REVIEW:B`, `UPSTREAM_REVIEW:C` — in the relevant source files so they're trivially auditable before crafting the PR description. Pre-PR checklist:

```
rg "UPSTREAM_REVIEW:[ABC]" src/resources/extensions/cursor-cli/ packages/pi-ai/src/
```

Every hit must be either (a) explicitly preserved with maintainer approval, (b) gated behind an opt-in toggle defaulting to off, or (c) stripped from the PR and kept fork-only.
