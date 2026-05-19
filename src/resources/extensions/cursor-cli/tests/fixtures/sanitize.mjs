#!/usr/bin/env node
/**
 * Project/App: GSD-2 — cursor-cli extension
 * File Purpose: Strip developer-specific tokens from a raw cursor-agent
 *               NDJSON capture before committing it as a fixture.
 *
 * Usage:
 *   node sanitize.mjs <raw.ndjson>          # writes sanitised NDJSON to stdout
 *   node sanitize.mjs < raw.ndjson > out.ndjson
 *
 * Contract:
 *   - One NDJSON event per input line.
 *   - Each line is JSON-parsed; known leaky fields (session_id, cwd,
 *     timestamps, durations) are replaced with stable placeholders.
 *   - Free-text fields are walked recursively and run through a set of
 *     string redactions (home paths, emails, JWT/Bearer/sk-/cursor-key
 *     tokens).
 *   - The sanitiser is idempotent: sanitize(sanitize(x)) === sanitize(x).
 *
 * The committed fixture MUST remain valid NDJSON. Lines that don't parse
 * as JSON are passed through with string-level redaction only.
 */

import { readFileSync } from "node:fs";

const STABLE_SESSION = "sess-XXXXXXXX";
const STABLE_CWD = "/tmp/fixture-workspace";
const STABLE_TIMESTAMP = "1970-01-01T00:00:00Z";
const REDACTED_EMAIL = "[REDACTED_EMAIL]";
const REDACTED = "[REDACTED]";
const HOME_PLACEHOLDER = "<HOME>";

// Match secret-bearing patterns. Order matters: longer/more specific first.
const STRING_REDACTIONS = [
	{ pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{6,}\b/gi, replacement: REDACTED },
	{ pattern: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, replacement: REDACTED },
	{ pattern: /\bcursor-key-[A-Za-z0-9._\-]{6,}\b/gi, replacement: REDACTED },
	{ pattern: /\bsk-[A-Za-z0-9._\-]{6,}\b/g, replacement: REDACTED },
];

// Email — matched before home-path so emails inside paths still get masked.
const EMAIL_PATTERN = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

// Home-path forms (`/Users/<u>` on macOS, `/home/<u>` on Linux).
// Capture the user segment up to the next path separator or end.
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[A-Za-z0-9._\-]+/g;

// macOS per-user temp directory: /var/folders/<2chars>/<volatile-uuid>/[CT]/
// The UUID-bearing middle segment is identifier-ish; collapse the whole
// prefix to /tmp/.
const MACOS_TEMP_PATTERN = /\/var\/folders\/[A-Za-z0-9_+\-]+\/[A-Za-z0-9_+\-]+\/[A-Z]\b/g;

// `mktemp -d` produces `cursor-fixture.XXXXXX` directories used by capture.sh.
// Collapse the suffix to a stable placeholder so fixtures don't carry the
// per-capture random component.
const FIXTURE_TMPDIR_PATTERN = /cursor-fixture\.[A-Za-z0-9]+/g;

// ISO 8601 timestamp shapes seen in cursor-agent output. Stable timestamp
// is itself ISO 8601 so the pattern must not re-match the placeholder.
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g;

// Fields whose entire value is replaced verbatim regardless of content.
// Map field-name -> static replacement.
const STATIC_FIELD_REPLACEMENTS = {
	session_id: STABLE_SESSION,
	sessionId: STABLE_SESSION,
	chat_id: STABLE_SESSION,
	chatId: STABLE_SESSION,
	request_id: STABLE_SESSION,
	requestId: STABLE_SESSION,
	cwd: STABLE_CWD,
	workspace: STABLE_CWD,
	workspace_path: STABLE_CWD,
	workspacePath: STABLE_CWD,
};

// Numeric fields zeroed out.
const ZEROED_NUMERIC_FIELDS = new Set([
	"duration_ms",
	"durationMs",
	"duration_api_ms",
	"durationApiMs",
	"latency_ms",
	"latencyMs",
	"started_at",
	"startedAt",
	"completed_at",
	"completedAt",
	"timestamp_ms",
	"timestampMs",
]);

// Fields whose value (string) is replaced with the stable timestamp.
const TIMESTAMP_STRING_FIELDS = new Set([
	"timestamp",
	"started_at",
	"startedAt",
	"completed_at",
	"completedAt",
	"created_at",
	"createdAt",
	"updated_at",
	"updatedAt",
]);

/** Apply string-level redactions to any free-text field. */
function redactString(input) {
	if (typeof input !== "string" || input.length === 0) return input;
	let out = input;
	// Emails first so we don't match them inside path-form tokens.
	out = out.replace(EMAIL_PATTERN, REDACTED_EMAIL);
	out = out.replace(HOME_PATH_PATTERN, HOME_PLACEHOLDER);
	// macOS per-user temp prefix collapses to /tmp before the fixture-dir
	// suffix pattern runs so paths normalise to `/tmp/cursor-fixture.XXXXXX`.
	out = out.replace(MACOS_TEMP_PATTERN, "/tmp");
	out = out.replace(FIXTURE_TMPDIR_PATTERN, "cursor-fixture.XXXXXX");
	out = out.replace(ISO_TIMESTAMP_PATTERN, STABLE_TIMESTAMP);
	for (const { pattern, replacement } of STRING_REDACTIONS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** Recursively sanitise a parsed JSON value. */
function sanitizeValue(value, parentKey) {
	if (value === null || value === undefined) return value;

	if (typeof value === "string") {
		// If the parent key flags this as a timestamp string, hard-replace
		// the value rather than relying on the pattern match (some shapes
		// use epoch-style numbers in strings).
		if (parentKey && TIMESTAMP_STRING_FIELDS.has(parentKey)) {
			return STABLE_TIMESTAMP;
		}
		return redactString(value);
	}

	if (typeof value === "number") {
		if (parentKey && ZEROED_NUMERIC_FIELDS.has(parentKey)) return 0;
		return value;
	}

	if (typeof value === "boolean") return value;

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item, undefined));
	}

	if (typeof value === "object") {
		const out = {};
		for (const [key, val] of Object.entries(value)) {
			if (Object.prototype.hasOwnProperty.call(STATIC_FIELD_REPLACEMENTS, key)) {
				out[key] = STATIC_FIELD_REPLACEMENTS[key];
				continue;
			}
			if (ZEROED_NUMERIC_FIELDS.has(key) && typeof val === "number") {
				out[key] = 0;
				continue;
			}
			if (TIMESTAMP_STRING_FIELDS.has(key) && typeof val === "string") {
				out[key] = STABLE_TIMESTAMP;
				continue;
			}
			out[key] = sanitizeValue(val, key);
		}
		return out;
	}

	return value;
}

/** Sanitise a single NDJSON line. Returns the sanitised line WITHOUT a newline. */
export function sanitizeLine(line) {
	const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (trimmed.trim().length === 0) return trimmed;
	try {
		const parsed = JSON.parse(trimmed);
		const sanitised = sanitizeValue(parsed, undefined);
		return JSON.stringify(sanitised);
	} catch {
		// Not JSON — fall back to string-level redaction only.
		return redactString(trimmed);
	}
}

/** Sanitise a whole NDJSON document. Preserves line terminators. */
export function sanitizeNdjson(input) {
	const lines = input.split("\n");
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Preserve a final blank line (file with trailing newline) without
		// emitting it as "sanitised content".
		if (i === lines.length - 1 && line === "") {
			out.push("");
			continue;
		}
		out.push(sanitizeLine(line));
	}
	return out.join("\n");
}

// CLI entrypoint — invoked when run as a script, not when imported.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	const args = process.argv.slice(2);
	let input;
	if (args.length === 0) {
		input = readFileSync(0, "utf8");
	} else {
		input = readFileSync(args[0], "utf8");
	}
	process.stdout.write(sanitizeNdjson(input));
}
