#!/usr/bin/env node
/**
 * Fake `cursor-agent` binary used by stream-end-to-end.test.ts.
 *
 * Drives `streamViaCursorCli` end-to-end without depending on a real Cursor
 * install: the test sets `CURSOR_AGENT_BIN` to this file's absolute path and
 * the extension's `findWorkingCommand()` picks it up like any other CLI.
 *
 * Environment overrides (all optional unless noted):
 *   CURSOR_FAKE_FIXTURE          absolute path to .ndjson to replay (REQUIRED
 *                                for the streaming invocation)
 *   CURSOR_FAKE_CHUNK_BYTES      stdout chunk size in bytes (default 4096)
 *   CURSOR_FAKE_CHUNK_DELAY_MS   ms between chunks (default 0)
 *   CURSOR_FAKE_EXIT_CODE        exit code after replay (default 0)
 *   CURSOR_FAKE_STDERR           string written to stderr before exit
 *   CURSOR_FAKE_TRUNCATE_AT_BYTE stop streaming at this byte offset
 *   CURSOR_FAKE_HANG_AFTER_BYTE  pause indefinitely after this offset
 *   CURSOR_FAKE_ECHO_ARGV        when "1", write argv JSON to ECHO_FILE
 *   CURSOR_FAKE_ECHO_FILE        target path for argv echo
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);

// ─── Readiness / catalogue probes ─────────────────────────────────────────
if (argv.includes("--version")) {
	process.stdout.write("fake-cursor-agent 0.0.0-test\n");
	process.exit(0);
}
if (argv[0] === "status") {
	if (argv.includes("--json")) {
		process.stdout.write(JSON.stringify({ authenticated: true }) + "\n");
	} else {
		process.stdout.write("Logged in as fake@example.com\n");
	}
	process.exit(0);
}
if (argv[0] === "--list-models") {
	process.stdout.write("composer-2.5\nclaude-sonnet-4-6\nclaude-opus-4-7\n");
	process.exit(0);
}
if (argv[0] === "login" || argv[0] === "logout") {
	process.exit(0);
}

// ─── Streaming invocation ─────────────────────────────────────────────────
if (process.env.CURSOR_FAKE_ECHO_ARGV === "1" && process.env.CURSOR_FAKE_ECHO_FILE) {
	writeFileSync(process.env.CURSOR_FAKE_ECHO_FILE, JSON.stringify(argv));
}

const fixturePath = process.env.CURSOR_FAKE_FIXTURE;
if (!fixturePath || !existsSync(fixturePath)) {
	process.stderr.write("fake-cursor-agent: CURSOR_FAKE_FIXTURE missing or unreadable\n");
	process.exit(2);
}

const payload = readFileSync(fixturePath, "utf8");
const chunkSize = Number(process.env.CURSOR_FAKE_CHUNK_BYTES || 4096);
const chunkDelay = Number(process.env.CURSOR_FAKE_CHUNK_DELAY_MS || 0);
const truncateAt = process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE
	? Number(process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE)
	: payload.length;
const hangAfter = process.env.CURSOR_FAKE_HANG_AFTER_BYTE
	? Number(process.env.CURSOR_FAKE_HANG_AFTER_BYTE)
	: Number.POSITIVE_INFINITY;

let terminated = false;
const sigtermWaiters = [];
process.on("SIGTERM", () => {
	terminated = true;
	while (sigtermWaiters.length > 0) {
		const w = sigtermWaiters.shift();
		w();
	}
});

(async () => {
	const limit = Math.min(truncateAt, payload.length);
	let cursor = 0;
	while (cursor < limit) {
		if (terminated) break;
		const end = Math.min(cursor + chunkSize, limit);
		process.stdout.write(payload.slice(cursor, end));
		cursor = end;
		if (cursor >= hangAfter) {
			// Block forever until SIGTERM. A setInterval keeps the event loop
			// alive — signal listeners alone do not ref the loop, so without
			// it the process would exit immediately after stdout flushes.
			await new Promise((resolve) => {
				if (terminated) return resolve();
				const keepAlive = setInterval(() => {}, 60_000);
				sigtermWaiters.push(() => {
					clearInterval(keepAlive);
					resolve();
				});
			});
			break;
		}
		if (chunkDelay > 0) await new Promise((r) => setTimeout(r, chunkDelay));
	}

	if (process.env.CURSOR_FAKE_STDERR) {
		process.stderr.write(process.env.CURSOR_FAKE_STDERR);
	}

	process.exit(Number(process.env.CURSOR_FAKE_EXIT_CODE || 0));
})();
