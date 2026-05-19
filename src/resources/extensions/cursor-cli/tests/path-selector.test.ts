/**
 * UPSTREAM_REVIEW:C — path-selector.ts tests.
 *
 * Drives `pickStreamPath` against the public test hooks for the SDK loader
 * and the persisted setting. Settings are isolated per test via
 * `CURSOR_ADAPTER_TEST_*` env overrides — see beforeEach for the override
 * pattern.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickStreamPath, __resetPathCacheForTests } from "../path-selector.ts";
import { __setSdkForTests, __clearSdkCacheForTests } from "../sdk-runtime.ts";
import { writeCursorAdapterSetting } from "../adapter-setting.ts";

// Test isolation: redirect the agent settings dir to a tmp location via
// `PI_CODING_AGENT_DIR` (the env override honoured by `getAgentDir`).
let tmpRoot: string;
let originalAgentDir: string | undefined;
let originalApiKey: string | undefined;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "cursor-path-selector-"));
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	originalApiKey = process.env.CURSOR_API_KEY;
	process.env.PI_CODING_AGENT_DIR = tmpRoot;
	// SDK path requires CURSOR_API_KEY (see path-selector.ts for the
	// rationale — the SDK can't fall back to cursor-agent's credential
	// store). Set a placeholder so the "should pick SDK" tests do.
	process.env.CURSOR_API_KEY = "test-key-for-path-selector";
	__resetPathCacheForTests();
	__clearSdkCacheForTests();
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalApiKey === undefined) delete process.env.CURSOR_API_KEY;
	else process.env.CURSOR_API_KEY = originalApiKey;
	rmSync(tmpRoot, { recursive: true, force: true });
	__resetPathCacheForTests();
	__clearSdkCacheForTests();
});

describe("pickStreamPath", () => {
	const fakeSdk = {
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

	test("default (unset) selects SDK when @cursor/sdk loads", async () => {
		__setSdkForTests(fakeSdk);
		const path = await pickStreamPath();
		assert.equal(path.kind, "sdk");
	});

	test("default (unset) falls back to CLI when SDK load fails", async () => {
		__setSdkForTests(null);
		const path = await pickStreamPath();
		assert.equal(path.kind, "cli");
	});

	test("setting=sdk with SDK present routes through SDK", async () => {
		writeCursorAdapterSetting("sdk", join(tmpRoot, "settings.json"));
		__setSdkForTests(fakeSdk);
		const path = await pickStreamPath();
		assert.equal(path.kind, "sdk");
	});

	test("setting=cli skips the SDK probe entirely", async () => {
		writeCursorAdapterSetting("cli", join(tmpRoot, "settings.json"));
		// Even if the SDK is available, the CLI setting takes precedence.
		__setSdkForTests(fakeSdk);
		const path = await pickStreamPath();
		assert.equal(path.kind, "cli");
	});

	test("invalid setting value falls back to the default (sdk)", async () => {
		writeFileSync(
			join(tmpRoot, "settings.json"),
			JSON.stringify({ "cursor.adapter": "garbage" }),
		);
		__setSdkForTests(fakeSdk);
		const path = await pickStreamPath();
		assert.equal(path.kind, "sdk", "invalid value should default to sdk");
	});

	test("missing CURSOR_API_KEY falls back to CLI (SDK has no fallback credential store)", async () => {
		delete process.env.CURSOR_API_KEY;
		__setSdkForTests(fakeSdk);
		const path = await pickStreamPath();
		assert.equal(path.kind, "cli", "missing API key should route to CLI");
	});

	test("cached path survives multiple calls without re-probing", async () => {
		let probeCount = 0;
		const trackingSdk = {
			Agent: {
				create: async () => {
					probeCount += 1;
					return { agentId: "test", close() {}, async send() { throw new Error(); } };
				},
			},
		};
		__setSdkForTests(trackingSdk);
		await pickStreamPath();
		await pickStreamPath();
		await pickStreamPath();
		// Cache hits don't invoke create() — they just return the cached path.
		assert.equal(probeCount, 0, "Agent.create should not be called during selection");
	});
});
