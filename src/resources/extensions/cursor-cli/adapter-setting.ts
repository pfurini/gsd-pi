/**
 * UPSTREAM_REVIEW:C — persistent `cursor.adapter` setting for the SDK / CLI
 * adapter selector.
 *
 * The setting is stored under `~/.gsd/agent/settings.json` (resolved via
 * `@gsd/pi-coding-agent#getAgentDir`) — the same global settings file used by
 * the rest of GSD's user preferences. We deliberately do NOT use
 * `getSettingsPath()` from `pi-coding-agent`'s internal `config.ts` because
 * that helper isn't exported from the package's root barrel, and depending on
 * an unexported deep path breaks `tsc --noEmit --project tsconfig.extensions.json`
 * the moment `dist/` is rebuilt.
 *
 * Two values are recognised: `"sdk"` (default) and `"cli"`. Any other value
 * resets to the default after one redacted stderr warning. Writes are atomic
 * (tmp + rename) so a `/cursor adapter` invocation racing a manual file edit
 * never leaves half-written JSON on disk.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@gsd/pi-coding-agent";
import { redactSecrets } from "./redact.js";

// UPSTREAM_REVIEW:C
export type CursorAdapter = "sdk" | "cli";

// UPSTREAM_REVIEW:C — Default stays `"sdk"` per plan #06: SDK is the
// primary path; CLI is the user-flippable fallback for diagnostic reasons.
export const DEFAULT_CURSOR_ADAPTER: CursorAdapter = "sdk";

const SETTING_KEY = "cursor.adapter";

let warnedAboutInvalidValue = false;

// UPSTREAM_REVIEW:C — exported for tests that need to override the file path.
export function getCursorAdapterSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function isValidAdapter(value: unknown): value is CursorAdapter {
	return value === "sdk" || value === "cli";
}

// UPSTREAM_REVIEW:C
/**
 * Read the persisted `cursor.adapter` value, falling back to the default on
 * missing file, unreadable file, malformed JSON, or invalid value.
 *
 * @param overridePath — test-only; production callers pass nothing.
 */
export function readCursorAdapterSetting(overridePath?: string): CursorAdapter {
	const path = overridePath ?? getCursorAdapterSettingsPath();
	if (!existsSync(path)) return DEFAULT_CURSOR_ADAPTER;

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		warnInvalid(`unable to read ${path}: ${(err as Error).message}`);
		return DEFAULT_CURSOR_ADAPTER;
	}
	if (raw.trim() === "") return DEFAULT_CURSOR_ADAPTER;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		warnInvalid(`malformed settings JSON: ${(err as Error).message}`);
		return DEFAULT_CURSOR_ADAPTER;
	}

	if (!parsed || typeof parsed !== "object") return DEFAULT_CURSOR_ADAPTER;
	const value = (parsed as Record<string, unknown>)[SETTING_KEY];
	if (value === undefined) return DEFAULT_CURSOR_ADAPTER;
	if (!isValidAdapter(value)) {
		warnInvalid(`invalid ${SETTING_KEY} value "${String(value)}"; using "${DEFAULT_CURSOR_ADAPTER}"`);
		return DEFAULT_CURSOR_ADAPTER;
	}
	return value;
}

// UPSTREAM_REVIEW:C
/**
 * Write the `cursor.adapter` value. Merges into the existing settings.json
 * (preserving unrelated keys) and replaces the file atomically.
 *
 * @param overridePath — test-only.
 */
export function writeCursorAdapterSetting(value: CursorAdapter, overridePath?: string): void {
	if (!isValidAdapter(value)) {
		throw new Error(`invalid cursor adapter value: "${String(value)}"`);
	}
	const path = overridePath ?? getCursorAdapterSettingsPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	let existing: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const raw = readFileSync(path, "utf8");
			if (raw.trim() !== "") {
				const parsed = JSON.parse(raw) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					existing = parsed as Record<string, unknown>;
				}
			}
		} catch {
			// Existing file is unreadable / invalid — clobber it with a fresh
			// object containing just the new value. Better than leaving the
			// user with a broken settings file forever.
		}
	}

	existing[SETTING_KEY] = value;
	const serialised = `${JSON.stringify(existing, null, 2)}\n`;
	// Atomic rename to avoid half-written JSON if /cursor adapter races a
	// concurrent settings edit.
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, serialised, "utf8");
	renameSync(tmp, path);
}

function warnInvalid(detail: string): void {
	if (warnedAboutInvalidValue) return;
	warnedAboutInvalidValue = true;
	process.stderr.write(`[cursor-cli] ${redactSecrets(detail)}\n`);
}

// UPSTREAM_REVIEW:C — test hook so suites that exercise invalid-value paths
// in isolation don't have to deal with cross-test state.
export function __resetInvalidValueWarningForTests(): void {
	warnedAboutInvalidValue = false;
}
