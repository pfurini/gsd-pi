import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCursorSpawnInvocation, getCursorCommandCandidates, parseAuthStatus } from "../readiness.ts";

describe("buildCursorSpawnInvocation", () => {
	test("POSIX: passes the command and args through unchanged", () => {
		const invocation = buildCursorSpawnInvocation("cursor-agent", ["--version"], "linux");
		assert.equal(invocation.command, "cursor-agent");
		assert.deepEqual(invocation.args, ["--version"]);
	});

	test("Windows: wraps the command in cmd /c so .cmd shims resolve", () => {
		const invocation = buildCursorSpawnInvocation("cursor-agent.cmd", ["status"], "win32");
		assert.equal(invocation.command, "cmd");
		assert.deepEqual(invocation.args, ["/c", "cursor-agent.cmd", "status"]);
	});
});

describe("getCursorCommandCandidates", () => {
	test("POSIX: returns both cursor-agent and the agent alias", () => {
		// Clear any override so the platform default is exercised.
		const previous = process.env.CURSOR_AGENT_BIN;
		delete process.env.CURSOR_AGENT_BIN;
		try {
			assert.deepEqual(getCursorCommandCandidates("linux"), ["cursor-agent", "agent"]);
		} finally {
			if (previous !== undefined) process.env.CURSOR_AGENT_BIN = previous;
		}
	});

	test("Windows: includes both .cmd and .exe shims for both binary names", () => {
		const previous = process.env.CURSOR_AGENT_BIN;
		delete process.env.CURSOR_AGENT_BIN;
		try {
			assert.deepEqual(
				getCursorCommandCandidates("win32"),
				["cursor-agent.cmd", "agent.cmd", "cursor-agent.exe", "agent.exe"],
			);
		} finally {
			if (previous !== undefined) process.env.CURSOR_AGENT_BIN = previous;
		}
	});

	test("CURSOR_AGENT_BIN override short-circuits the candidate list", () => {
		const previous = process.env.CURSOR_AGENT_BIN;
		process.env.CURSOR_AGENT_BIN = "/opt/cursor/bin/cursor-agent";
		try {
			assert.deepEqual(getCursorCommandCandidates("linux"), ["/opt/cursor/bin/cursor-agent"]);
			assert.deepEqual(getCursorCommandCandidates("win32"), ["/opt/cursor/bin/cursor-agent"]);
		} finally {
			if (previous === undefined) {
				delete process.env.CURSOR_AGENT_BIN;
			} else {
				process.env.CURSOR_AGENT_BIN = previous;
			}
		}
	});
});

describe("parseAuthStatus", () => {
	test("returns true when JSON authenticated=true", () => {
		assert.equal(parseAuthStatus('{"authenticated": true}'), true);
	});

	test("returns false when JSON authenticated=false", () => {
		assert.equal(parseAuthStatus('{"authenticated": false}'), false);
	});

	test("accepts loggedIn alias used by older builds", () => {
		assert.equal(parseAuthStatus('{"loggedIn": true}'), true);
		assert.equal(parseAuthStatus('{"logged_in": false}'), false);
	});

	test("falls back to text heuristic for non-JSON output", () => {
		assert.equal(parseAuthStatus("Logged in as alice"), true);
		assert.equal(parseAuthStatus("Not logged in"), false);
	});

	test("returns null when neither JSON nor heuristic matches", () => {
		assert.equal(parseAuthStatus("nothing useful here"), null);
		assert.equal(parseAuthStatus(""), null);
	});
});
