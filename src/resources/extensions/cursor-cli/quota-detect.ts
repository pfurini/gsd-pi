/**
 * UPSTREAM_REVIEW:A — cross-vendor failover signal classifier.
 *
 * Pattern-matches Cursor `result` event payloads (`subtype`, `result` text)
 * into a small stable code that the existing GSD retry/failover machinery
 * already consumes via string matching on `AssistantMessage.errorMessage`.
 *
 * Investigation summary (verified 2026-05-19 on `feat/cursor-cli-full-power`,
 * commit e42439f95):
 *
 *   1. The retry handler hook is `RetryHandler.handleRetryableError()` in
 *      `packages/pi-coding-agent/src/core/retry-handler.ts:124`. It already:
 *        - classifies via `_classifyErrorType()` (line 409) — `/quota|...|usage.*limit/i`
 *          returns `"quota_exhausted"`;
 *        - routes quota errors through `FallbackResolver.findFallback(...)`
 *          (line 196) for cross-vendor rotation per the user's chain config in
 *          `settingsManager.getFallbackSettings()`.
 *      No rebuild of the rotation handler is needed; PRs #5184 / #4394 are
 *      already merged and in-tree.
 *
 *   2. The gate is `RetryHandler.isRetryableError()` at line 108, which calls
 *      `RETRYABLE_ERROR_RE.test(message.errorMessage)`. Today that regex does
 *      not include "quota exhausted" / "plan limit reached" phrasings — so
 *      a raw Cursor quota error falls through and never enters the handler.
 *
 *   3. Convention: classification lives in `errorMessage` as a substring. The
 *      Claude Code CLI precedent (`claude-code-cli/stream-adapter.ts`
 *      `getResultErrorMessage`, line 177) does the same — no structured field.
 *
 * Design: emit `errorMessage = "<code>: <redacted detail>"`. The leading code
 * is the structured marker the regex matches; the trailing detail keeps the
 * TUI message human-readable. The companion change in
 * `retryable-error-regex.ts` adds `\bquota_exhausted\b` to the retryable set
 * so the marker enters the handler. The user's existing fallback-chain config
 * remains the single opt-in surface for rotation — no extra bool gate, no
 * cursor-specific code in pi-coding-agent beyond the regex addition.
 *
 * See `.plans/cursor-cli-04-upstream-review-a-failover.md` for posture.
 */

/** Stable short codes surfaced via `AssistantMessage.errorMessage`. */
export type CursorErrorCode = "quota_exhausted" | "rate_limited" | "auth_failed" | "other";

export interface CursorErrorClassification {
	code: CursorErrorCode;
	/** The original result text the classification was derived from (NOT redacted). */
	detail: string;
}

// UPSTREAM_REVIEW:A — quota phrasings. Conservative; broad enough to cover the
// known wire shapes (`quota exhausted`, `plan limit reached`, `usage limit
// exceeded`, `insufficient credits`, HTTP 402 with billing/payment context).
const QUOTA_PATTERNS: ReadonlyArray<RegExp> = [
	/\bquota\s+exhausted\b/i,
	/\bplan\s+(?:limit|quota)\s+reached\b/i,
	/\busage\s+limit(?:s)?\s+(?:reached|exceeded)\b/i,
	/\binsufficient\s+credits\b/i,
	/\b402\b[^.]*\b(?:payment|billing)\b/i,
];

// UPSTREAM_REVIEW:A — rate-limit phrasings. The existing pi-coding-agent
// regex already matches `rate.?limit|too many requests|429`, so these mostly
// exist so the classifier can label them distinctly for the TUI.
const RATE_LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
	/\brate[\s-]*limit(?:ed|ing)?\b/i,
	/\btoo\s+many\s+requests\b/i,
	/\b429\b/,
];

// UPSTREAM_REVIEW:A — auth phrasings. Distinct so the handler does NOT
// auto-retry on missing creds (retrying with the same broken token is futile).
const AUTH_PATTERNS: ReadonlyArray<RegExp> = [
	/\b(?:unauthorized|unauthenticated)\b/i,
	/\b401\b[^.]*\bauth/i,
	/\binvalid\s+(?:api\s+key|token|credential)\b/i,
	/\bnot\s+logged\s+in\b/i,
];

/**
 * Classify a Cursor terminal error into a stable code.
 *
 * @param resultText The `result` field from the Cursor `result` event, or "".
 * @param subtype    The `subtype` field — `"error"` for terminal failures.
 *                   Reserved for future tightening; today the classification
 *                   is text-driven and subtype is only consulted as a fallback
 *                   signal (a missing/empty result with `subtype === "error"`
 *                   still classifies as `"other"`).
 * @returns `{code, detail}` where `code` is the stable marker.
 */
export function classifyCursorError(
	resultText: string | undefined,
	subtype: string | undefined,
): CursorErrorClassification {
	const text = (resultText ?? "").trim();
	const detail = text.length > 0 ? text : (subtype ?? "").trim();

	if (text.length === 0) {
		return { code: "other", detail };
	}

	// Order matters: quota signals first (most specific billing-state errors),
	// then rate-limit, then auth, finally "other".
	for (const pattern of QUOTA_PATTERNS) {
		if (pattern.test(text)) return { code: "quota_exhausted", detail };
	}
	for (const pattern of RATE_LIMIT_PATTERNS) {
		if (pattern.test(text)) return { code: "rate_limited", detail };
	}
	for (const pattern of AUTH_PATTERNS) {
		if (pattern.test(text)) return { code: "auth_failed", detail };
	}
	return { code: "other", detail };
}

/**
 * Format a classified error for `AssistantMessage.errorMessage`.
 *
 * For `"other"`, returns the detail unchanged (preserves today's behaviour
 * for unknown errors). For all other codes, prepends `"<code>: "` so the
 * retry-handler regex picks up the structured marker while the TUI still
 * shows the redacted detail to the user.
 *
 * @param classification The output of {@link classifyCursorError}.
 * @param redactedDetail The detail string AFTER `redactSecrets()` has been
 *                       applied. Kept separate so the classifier stays a
 *                       pure function with no redaction-policy coupling.
 */
export function formatCursorErrorMessage(
	classification: CursorErrorClassification,
	redactedDetail: string,
): string {
	if (classification.code === "other") return redactedDetail;
	return `${classification.code}: ${redactedDetail}`;
}
