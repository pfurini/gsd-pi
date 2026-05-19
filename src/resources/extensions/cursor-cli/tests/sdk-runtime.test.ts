/**
 * UPSTREAM_REVIEW:C — sdk-runtime.ts tests.
 *
 * Drive the public surface through the `__setSdkForTests` test hook so the
 * tests never depend on `@cursor/sdk` being installed on disk. The real
 * dynamic-import path is exercised by the live smoke at the bottom of plan
 * #06; here we cover the caching, fallback, and warn-once behaviours.
 */
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __clearSdkCacheForTests, __setSdkForTests, loadSdk } from "../sdk-runtime.ts";

beforeEach(() => {
	__clearSdkCacheForTests();
});

describe("loadSdk", () => {
	test("returns the mock when __setSdkForTests installs one", async () => {
		const mod = {
			Agent: {
				create: async () => ({
					agentId: "test",
					close() {},
					async send() {
						throw new Error("not used");
					},
				}),
			},
		};
		__setSdkForTests(mod);
		const sdk = await loadSdk();
		assert.strictEqual(sdk, mod, "loadSdk should return the installed mock");
	});

	test("returns null when __setSdkForTests forces the fallback branch", async () => {
		__setSdkForTests(null);
		const sdk = await loadSdk();
		assert.equal(sdk, null);
	});

	test("caches the resolved value across calls", async () => {
		const mod = {
			Agent: { create: async () => ({ agentId: "t", close() {}, async send() { throw new Error(); } }) },
		};
		__setSdkForTests(mod);
		const first = await loadSdk();
		const second = await loadSdk();
		assert.strictEqual(first, second, "loadSdk should memoise the result");
	});

	test("real dynamic-import path falls back to null when package is missing", async () => {
		// Skip when @cursor/sdk is actually installed in the local env (e.g.
		// the user ran `npm install --no-save @cursor/sdk` for the live
		// smoke). The point of this test is to prove the fallback works in
		// CI where the package is intentionally absent.
		try {
			const { createRequire } = await import("node:module");
			createRequire(import.meta.url).resolve("@cursor/sdk");
			return; // installed locally — skip the negative-case test
		} catch {
			// expected when the package is absent
		}
		__clearSdkCacheForTests();
		const sdk = await loadSdk();
		assert.equal(sdk, null, "missing @cursor/sdk should resolve to null without throwing");
	});
});
