/**
 * UPSTREAM_REVIEW:C — sdk-console-guard.ts tests.
 *
 * The guard fences `@cursor/sdk`'s in-process `console.*` output so it can't
 * overprint the interactive TUI. These tests pin the depth-counter logic,
 * the `GSD_CURSOR_SDK_CONSOLE` opt-out, and the actual swallow behaviour.
 */
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	enterSdkConsoleScope,
	exitSdkConsoleScope,
	isSdkConsoleSuppressed,
	__resetSdkConsoleGuardForTests,
} from "../sdk-console-guard.ts";

afterEach(() => {
	__resetSdkConsoleGuardForTests();
});

describe("sdk-console-guard", () => {
	test("not suppressed before entering a scope", () => {
		assert.equal(isSdkConsoleSuppressed({}), false);
	});

	test("suppressed inside a scope, restored on exit", () => {
		enterSdkConsoleScope();
		assert.equal(isSdkConsoleSuppressed({}), true);
		exitSdkConsoleScope();
		assert.equal(isSdkConsoleSuppressed({}), false);
	});

	test("nested scopes are balanced via the depth counter", () => {
		enterSdkConsoleScope();
		enterSdkConsoleScope();
		exitSdkConsoleScope();
		assert.equal(isSdkConsoleSuppressed({}), true, "still suppressed — one scope open");
		exitSdkConsoleScope();
		assert.equal(isSdkConsoleSuppressed({}), false);
	});

	test("exit never drives the depth counter negative", () => {
		exitSdkConsoleScope();
		exitSdkConsoleScope();
		enterSdkConsoleScope();
		assert.equal(isSdkConsoleSuppressed({}), true, "a single enter still suppresses");
		exitSdkConsoleScope();
		assert.equal(isSdkConsoleSuppressed({}), false);
	});

	test("GSD_CURSOR_SDK_CONSOLE opts out of suppression", () => {
		enterSdkConsoleScope();
		assert.equal(isSdkConsoleSuppressed({ GSD_CURSOR_SDK_CONSOLE: "1" }), false);
		assert.equal(isSdkConsoleSuppressed({}), true, "still suppressed without the opt-out");
		exitSdkConsoleScope();
	});

	test("console output is dropped inside a scope, passes through outside", () => {
		const seen: unknown[] = [];
		const real = console.info;
		console.info = ((...args: unknown[]): void => {
			seen.push(args[0]);
		}) as typeof console.info;
		try {
			// install() captures the spy as the original; wrappers route to it.
			enterSdkConsoleScope();
			console.info("inside-scope");
			assert.deepEqual(seen, [], "console.info must be swallowed inside an SDK scope");
			exitSdkConsoleScope();
			console.info("outside-scope");
			assert.deepEqual(seen, ["outside-scope"], "console.info must pass through outside");
		} finally {
			__resetSdkConsoleGuardForTests();
			// Hard-restore the native method last — __reset would otherwise
			// reinstate the captured spy.
			console.info = real;
		}
	});
});
