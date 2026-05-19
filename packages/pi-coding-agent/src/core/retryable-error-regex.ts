/**
 * Regex matching retryable provider/transport errors — overloaded responses,
 * rate limits, and transient server / connection / stream failures.
 *
 * Extracted into its own zero-import module so the live retry gate
 * (`AgentSessionPromptModule.isRetryableError`) and tests consume the SAME
 * pattern instead of redefining it inline, where the two can silently drift.
 *
 * The base pattern is gsd-pi's existing retry-gate set; the cursor-cli quota
 * classifier appends one structured token (see UPSTREAM_REVIEW:A below).
 */
// UPSTREAM_REVIEW:A — `\bquota_exhausted\b` is the structured marker emitted by
// `src/resources/extensions/cursor-cli/quota-detect.ts`. Matching it here makes
// Cursor quota-exhaustion errors classify as retryable, so they flow through the
// same retry gate as every other provider. NOTE (gsd-pi port): FallbackResolver
// is not wired to error-driven rotation in gsd-pi, so this yields bounded
// same-provider retry, not cross-provider failover. Drop the token if the
// cursor-cli classifier is ever removed.
export const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|\bquota_exhausted\b/i;
