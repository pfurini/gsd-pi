/**
 * Secret-masking helper used by every log / error-surface call site in the
 * cursor-cli extension.
 *
 * Per the compliance posture in `.plans/cursor-cli-provider.md` §"Compliance
 * & Data Handling", any string that may end up in a log, telemetry record, or
 * user-facing error message must first be passed through `redactSecrets()`.
 * The transformation is deterministic, stateless, and does not consult the
 * environment, so it is safe to wrap freely.
 */

/** Mask used in place of any matched secret. */
const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: RegExp[] = [
	// `Authorization: Bearer …` headers
	/\bBearer\s+[A-Za-z0-9._\-+/=]{6,}\b/gi,
	// OpenAI-style and generic "sk-…" keys
	/\bsk-[A-Za-z0-9._\-]{6,}\b/g,
	// Cursor-issued bearer tokens
	/\bcursor-key-[A-Za-z0-9._\-]{6,}\b/gi,
	// JWT three-segment tokens (eyJ… . … . …) — matches header.payload.sig
	/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
];

/**
 * Replace any token that looks like a credential with `[REDACTED]`.
 *
 * The function is intentionally over-eager: it is cheaper to over-mask than
 * to leak. Callers should pass the full string they intend to emit (log line,
 * error message, child stderr buffer) without pre-filtering.
 */
export function redactSecrets(value: string): string {
	if (!value) return value;
	let out = value;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, REDACTED);
	}
	return out;
}
