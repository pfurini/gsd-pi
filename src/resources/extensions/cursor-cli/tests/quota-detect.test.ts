/**
 * Unit tests for the `classifyCursorError` pattern matcher.
 *
 * Pin the public phrasings → code mapping. Drift here changes what enters the
 * retry/failover handler, so each known phrasing gets a named test.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	type CursorErrorClassification,
	classifyCursorError,
	formatCursorErrorMessage,
} from "../quota-detect.ts";

function expectCode(
	resultText: string,
	subtype: string,
	expected: CursorErrorClassification["code"],
): void {
	const c = classifyCursorError(resultText, subtype);
	assert.equal(
		c.code,
		expected,
		`expected ${JSON.stringify(resultText)} → ${expected}, got ${c.code}`,
	);
}

describe("classifyCursorError → quota_exhausted", () => {
	test("bare 'quota exhausted'", () => {
		expectCode("quota exhausted", "error", "quota_exhausted");
	});
	test("'quota exhausted — plan limit reached' (em-dash compound)", () => {
		expectCode("quota exhausted — plan limit reached", "error", "quota_exhausted");
	});
	test("'plan limit reached' alone", () => {
		expectCode("Your plan limit reached for this billing cycle.", "error", "quota_exhausted");
	});
	test("'plan quota reached'", () => {
		expectCode("plan quota reached", "error", "quota_exhausted");
	});
	test("'usage limit reached'", () => {
		expectCode("Daily usage limit reached.", "error", "quota_exhausted");
	});
	test("'usage limit exceeded'", () => {
		expectCode("monthly usage limits exceeded", "error", "quota_exhausted");
	});
	test("'insufficient credits'", () => {
		expectCode("insufficient credits for this request", "error", "quota_exhausted");
	});
	test("HTTP 402 + billing", () => {
		expectCode("HTTP 402 — billing required", "error", "quota_exhausted");
	});
	test("HTTP 402 + payment", () => {
		expectCode("402 payment required to continue", "error", "quota_exhausted");
	});
});

describe("classifyCursorError → rate_limited", () => {
	test("'rate limit'", () => {
		expectCode("rate limit reached, try again later", "error", "rate_limited");
	});
	test("'rate-limited'", () => {
		expectCode("you are being rate-limited", "error", "rate_limited");
	});
	test("'too many requests'", () => {
		expectCode("too many requests — slow down", "error", "rate_limited");
	});
	test("HTTP 429", () => {
		expectCode("HTTP 429 received from upstream", "error", "rate_limited");
	});
});

describe("classifyCursorError → auth_failed", () => {
	test("'unauthorized'", () => {
		expectCode("Unauthorized — please log in", "error", "auth_failed");
	});
	test("'unauthenticated'", () => {
		expectCode("unauthenticated request", "error", "auth_failed");
	});
	test("HTTP 401 + auth context", () => {
		expectCode("401 auth failure", "error", "auth_failed");
	});
	test("'invalid api key'", () => {
		expectCode("invalid api key", "error", "auth_failed");
	});
	test("'invalid token'", () => {
		expectCode("invalid token", "error", "auth_failed");
	});
	test("'not logged in'", () => {
		expectCode("not logged in", "error", "auth_failed");
	});
});

describe("classifyCursorError → other", () => {
	test("generic 500-style error stays 'other'", () => {
		expectCode("model returned 500 internal server error", "error", "other");
	});
	test("benign network blip stays 'other'", () => {
		expectCode("connection reset by peer", "error", "other");
	});
	test("empty result text → 'other' regardless of subtype", () => {
		expectCode("", "error", "other");
	});
	test("'quota' as a substring of a non-quota word does NOT match", () => {
		// `\bquota\s+exhausted\b` requires the literal compound, not just `quota`.
		expectCode("quotation not found", "error", "other");
	});
	test("'limit' alone is not enough", () => {
		// Patterns require the qualifying word (plan/usage), not bare 'limit'.
		expectCode("character limit", "error", "other");
	});
});

describe("classifyCursorError edge cases", () => {
	test("preserves the raw detail string verbatim", () => {
		const r = classifyCursorError("  quota exhausted — plan limit reached  ", "error");
		assert.equal(r.code, "quota_exhausted");
		assert.equal(r.detail, "quota exhausted — plan limit reached");
	});
	test("falls back to subtype when result text is empty", () => {
		const r = classifyCursorError("", "error");
		assert.equal(r.code, "other");
		assert.equal(r.detail, "error");
	});
	test("undefined inputs are treated as empty", () => {
		const r = classifyCursorError(undefined, undefined);
		assert.equal(r.code, "other");
		assert.equal(r.detail, "");
	});
});

describe("formatCursorErrorMessage", () => {
	test("prepends the structured marker for classified codes", () => {
		const formatted = formatCursorErrorMessage(
			{ code: "quota_exhausted", detail: "plan limit reached" },
			"plan limit reached",
		);
		assert.equal(formatted, "quota_exhausted: plan limit reached");
	});
	test("uses the redacted detail, not the raw one", () => {
		// The classifier sees the raw detail; the formatter uses whatever the
		// caller redacted. This split keeps the classifier free of redaction
		// policy coupling.
		const formatted = formatCursorErrorMessage(
			{ code: "auth_failed", detail: "invalid api key sk-live-XYZ" },
			"invalid api key [REDACTED]",
		);
		assert.equal(formatted, "auth_failed: invalid api key [REDACTED]");
	});
	test("returns redacted detail unchanged for 'other'", () => {
		const formatted = formatCursorErrorMessage(
			{ code: "other", detail: "model returned 500" },
			"model returned 500",
		);
		assert.equal(formatted, "model returned 500");
	});
});
