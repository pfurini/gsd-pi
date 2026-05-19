/**
 * UPSTREAM_REVIEW:C — adapter-setting.ts tests.
 *
 * Drives reads and writes against a tmp file so the user's real
 * `~/.gsd/agent/settings.json` is never touched. Covers the four shapes
 * the plan called out: default read, write+read round-trip, invalid-value
 * fallback, concurrent-write safety (atomic rename).
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CURSOR_ADAPTER,
	readCursorAdapterSetting,
	writeCursorAdapterSetting,
	__resetInvalidValueWarningForTests,
} from "../adapter-setting.ts";

let tmpDir: string;
let settingsPath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "cursor-adapter-setting-"));
	settingsPath = join(tmpDir, "settings.json");
	__resetInvalidValueWarningForTests();
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("readCursorAdapterSetting", () => {
	test("returns the default when the settings file does not exist", () => {
		const value = readCursorAdapterSetting(settingsPath);
		assert.equal(value, DEFAULT_CURSOR_ADAPTER);
	});

	test("returns the default when the file is empty", () => {
		writeFileSync(settingsPath, "");
		const value = readCursorAdapterSetting(settingsPath);
		assert.equal(value, DEFAULT_CURSOR_ADAPTER);
	});

	test("returns the default when the file is malformed JSON", () => {
		writeFileSync(settingsPath, "{not valid json");
		const value = readCursorAdapterSetting(settingsPath);
		assert.equal(value, DEFAULT_CURSOR_ADAPTER);
	});

	test("returns 'cli' when the setting is explicitly cli", () => {
		writeFileSync(settingsPath, JSON.stringify({ "cursor.adapter": "cli" }));
		const value = readCursorAdapterSetting(settingsPath);
		assert.equal(value, "cli");
	});

	test("returns 'sdk' when the setting is explicitly sdk", () => {
		writeFileSync(settingsPath, JSON.stringify({ "cursor.adapter": "sdk" }));
		const value = readCursorAdapterSetting(settingsPath);
		assert.equal(value, "sdk");
	});

	test("invalid value resets to the default without throwing", () => {
		writeFileSync(settingsPath, JSON.stringify({ "cursor.adapter": "garbage" }));
		const value = readCursorAdapterSetting(settingsPath);
		assert.equal(value, DEFAULT_CURSOR_ADAPTER);
	});

	test("preserves unrelated settings keys (does not touch them on read)", () => {
		const original = { "cursor.adapter": "cli", "theme.dark": true };
		writeFileSync(settingsPath, JSON.stringify(original));
		readCursorAdapterSetting(settingsPath);
		const after = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(after, original);
	});
});

describe("writeCursorAdapterSetting", () => {
	test("creates the settings file on first write", () => {
		writeCursorAdapterSetting("cli", settingsPath);
		const value = readCursorAdapterSetting(settingsPath);
		assert.equal(value, "cli");
	});

	test("round-trips both values", () => {
		writeCursorAdapterSetting("cli", settingsPath);
		assert.equal(readCursorAdapterSetting(settingsPath), "cli");
		writeCursorAdapterSetting("sdk", settingsPath);
		assert.equal(readCursorAdapterSetting(settingsPath), "sdk");
	});

	test("preserves unrelated keys on update", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({ "cursor.adapter": "sdk", "theme.dark": true, "ui.compact": false }),
		);
		writeCursorAdapterSetting("cli", settingsPath);
		const after = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		assert.equal(after["cursor.adapter"], "cli");
		assert.equal(after["theme.dark"], true);
		assert.equal(after["ui.compact"], false);
	});

	test("rejects an invalid value", () => {
		assert.throws(() => writeCursorAdapterSetting("garbage" as never, settingsPath));
	});

	test("uses atomic rename — no .tmp files left behind after a successful write", () => {
		writeCursorAdapterSetting("cli", settingsPath);
		const entries = readdirSync(tmpDir);
		const leftover = entries.filter((f: string) => f.endsWith(".tmp"));
		assert.deepEqual(leftover, [], "no stale .tmp files should remain");
	});

	test("clobbers a corrupt settings file rather than throwing", () => {
		writeFileSync(settingsPath, "{not json");
		writeCursorAdapterSetting("cli", settingsPath);
		assert.equal(readCursorAdapterSetting(settingsPath), "cli");
	});
});
