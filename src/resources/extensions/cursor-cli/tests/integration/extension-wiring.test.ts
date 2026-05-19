/**
 * End-to-end wiring tests for the cursor-cli extension default export.
 *
 * These tests register the extension against a fake `ExtensionAPI`, capture
 * the registered `streamSimple` callback, and assert that the spawned argv
 * reflects the {@link resolveAllowsWrites} precedence ladder
 * (env > cli-flag > slice > default).
 *
 * The fake `pi` is intentionally minimal — only the methods the cursor-cli
 * extension actually calls are implemented; anything else throws so that
 * accidental surface drift surfaces as a test failure rather than a
 * runtime crash in the live host.
 */
import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@gsd/pi-ai";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import cursorCli from "../../index.ts";
import { FORCE_ENV_VAR, FORCE_FLAG_NAME } from "../../allows-writes.ts";
import type { CursorStreamOptions } from "../../stream-adapter.ts";
import { resetForceWarningLatch } from "../../stream-adapter.ts";
import { clearReadinessCache } from "../../readiness.ts";
// UPSTREAM_REVIEW:C — the dispatcher (plan #06) routes to SDK by default
// when @cursor/sdk resolves on disk. These wiring tests target the CLI
// argv shape, so force the CLI path via the SDK test hook regardless of
// whether the SDK is installed in the dev environment.
import { __setSdkForTests } from "../../sdk-runtime.ts";
import { __resetPathCacheForTests } from "../../path-selector.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fake-cursor-agent.mjs");
const FIXTURES = join(HERE, "..", "fixtures");

const ORIGINAL_BIN = process.env.CURSOR_AGENT_BIN;
const ORIGINAL_KEY = process.env.CURSOR_API_KEY;
const ORIGINAL_DISABLE = process.env.GSD_CURSOR_DISABLE;
const ORIGINAL_FORCE_ENV = process.env[FORCE_ENV_VAR];
const ORIGINAL_HEADLESS = process.env.GSD_HEADLESS;
const TEMP_DIRS: string[] = [];

function mockModel(id = "composer-2.5"): Model<Api> {
	return {
		id,
		name: id,
		api: "cursor-stream-json" as Api,
		provider: "cursor-agent",
		baseUrl: "local://cursor-agent",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function mockContext(): Context {
	return {
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

function mktempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-cli-wiring-"));
	TEMP_DIRS.push(dir);
	return dir;
}

type StreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface FakeRegistration {
	streamSimple: StreamSimple;
	flagDefaults: Map<string, boolean | string | undefined>;
	flagValues: Map<string, boolean | string | undefined>;
}

function makeFakePi(): { pi: ExtensionAPI; reg: FakeRegistration } {
	const reg: FakeRegistration = {
		streamSimple: () => {
			throw new Error("streamSimple captured before registerProvider was called");
		},
		flagDefaults: new Map(),
		flagValues: new Map(),
	};

	const pi = {
		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			reg.flagDefaults.set(name, options.default);
		},
		getFlag(name: string): boolean | string | undefined {
			if (reg.flagValues.has(name)) return reg.flagValues.get(name);
			return reg.flagDefaults.get(name);
		},
		registerProvider(_name: string, config: { streamSimple?: StreamSimple }): void {
			if (!config.streamSimple) {
				throw new Error("expected cursor-cli to set streamSimple");
			}
			reg.streamSimple = config.streamSimple;
		},
		registerCommand(): void {
			// no-op for these tests
		},
	} as unknown as ExtensionAPI;

	return { pi, reg };
}

function readArgv(echoFile: string): string[] {
	return JSON.parse(readFileSync(echoFile, "utf8")) as string[];
}

before(() => {
	process.env.CURSOR_AGENT_BIN = FAKE;
	process.env.CURSOR_API_KEY = "fake-key-for-tests";
	delete process.env.GSD_CURSOR_DISABLE;
	// Suppress the first-time --force banner so the spawn pipeline stays
	// quiet during test runs — the dedicated banner test toggles this off.
	process.env.GSD_HEADLESS = "1";
});

after(() => {
	if (ORIGINAL_BIN === undefined) delete process.env.CURSOR_AGENT_BIN;
	else process.env.CURSOR_AGENT_BIN = ORIGINAL_BIN;
	if (ORIGINAL_KEY === undefined) delete process.env.CURSOR_API_KEY;
	else process.env.CURSOR_API_KEY = ORIGINAL_KEY;
	if (ORIGINAL_DISABLE === undefined) delete process.env.GSD_CURSOR_DISABLE;
	else process.env.GSD_CURSOR_DISABLE = ORIGINAL_DISABLE;
	if (ORIGINAL_FORCE_ENV === undefined) delete process.env[FORCE_ENV_VAR];
	else process.env[FORCE_ENV_VAR] = ORIGINAL_FORCE_ENV;
	if (ORIGINAL_HEADLESS === undefined) delete process.env.GSD_HEADLESS;
	else process.env.GSD_HEADLESS = ORIGINAL_HEADLESS;
	for (const dir of TEMP_DIRS) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
	TEMP_DIRS.length = 0;
});

beforeEach(() => {
	clearReadinessCache();
	resetForceWarningLatch();
	// UPSTREAM_REVIEW:C — pin the dispatcher to the CLI path for every wiring
	// case so the argv assertions remain stable regardless of @cursor/sdk
	// presence on the dev machine.
	__setSdkForTests(null);
	__resetPathCacheForTests();
	delete process.env[FORCE_ENV_VAR];
	delete process.env.CURSOR_FAKE_EXIT_CODE;
	delete process.env.CURSOR_FAKE_STDERR;
	delete process.env.CURSOR_FAKE_TRUNCATE_AT_BYTE;
	delete process.env.CURSOR_FAKE_HANG_AFTER_BYTE;
	delete process.env.CURSOR_FAKE_CHUNK_BYTES;
	delete process.env.CURSOR_FAKE_CHUNK_DELAY_MS;
});

async function spawnViaExtension(
	pi: ReturnType<typeof makeFakePi>,
	options?: CursorStreamOptions,
): Promise<string[]> {
	const echoFile = join(mktempDir(), "argv.json");
	process.env.CURSOR_FAKE_ECHO_ARGV = "1";
	process.env.CURSOR_FAKE_ECHO_FILE = echoFile;
	process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");

	try {
		const stream = pi.reg.streamSimple(mockModel(), mockContext(), options);
		await stream.result();
	} finally {
		delete process.env.CURSOR_FAKE_ECHO_ARGV;
		delete process.env.CURSOR_FAKE_ECHO_FILE;
		delete process.env.CURSOR_FAKE_FIXTURE;
	}
	return readArgv(echoFile);
}

describe("cursor-cli extension wiring", () => {
	test("default registration leaves the provider write-protected", async () => {
		const fake = makeFakePi();
		cursorCli(fake.pi);
		const argv = await spawnViaExtension(fake);
		assert.ok(!argv.includes("--force"), "--force must not appear by default");
	});

	test("env GSD_CURSOR_FORCE_ALL_SLICES=1 escalates to --force", async () => {
		const fake = makeFakePi();
		cursorCli(fake.pi);
		process.env[FORCE_ENV_VAR] = "1";
		const argv = await spawnViaExtension(fake);
		assert.ok(argv.includes("--force"), "env override should propagate");
	});

	test("--cursor-force flag escalates to --force", async () => {
		const fake = makeFakePi();
		cursorCli(fake.pi);
		fake.reg.flagValues.set(FORCE_FLAG_NAME, true);
		const argv = await spawnViaExtension(fake);
		assert.ok(argv.includes("--force"), "cli-flag override should propagate");
	});

	test("caller-provided slice allowsWrites=true escalates to --force", async () => {
		const fake = makeFakePi();
		cursorCli(fake.pi);
		const argv = await spawnViaExtension(fake, { allowsWrites: true });
		assert.ok(argv.includes("--force"), "slice signal should propagate");
	});

	test("caller-provided slice allowsWrites=false stays read-only", async () => {
		const fake = makeFakePi();
		cursorCli(fake.pi);
		const argv = await spawnViaExtension(fake, { allowsWrites: false });
		assert.ok(!argv.includes("--force"), "--force must not appear when slice opts out");
	});

	test("env wins over slice opt-out", async () => {
		const fake = makeFakePi();
		cursorCli(fake.pi);
		process.env[FORCE_ENV_VAR] = "1";
		const argv = await spawnViaExtension(fake, { allowsWrites: false });
		assert.ok(argv.includes("--force"), "env should override slice");
	});

	test("GSD_CURSOR_DISABLE=1 leaves the registration dormant", () => {
		const fake = makeFakePi();
		process.env.GSD_CURSOR_DISABLE = "1";
		try {
			cursorCli(fake.pi);
		} finally {
			delete process.env.GSD_CURSOR_DISABLE;
		}
		assert.equal(fake.reg.flagDefaults.size, 0, "no flag registered when disabled");
		assert.throws(() => fake.reg.streamSimple(mockModel(), mockContext()));
	});

	test("non-CursorStreamOptions fields survive the wrapper", async () => {
		const fake = makeFakePi();
		cursorCli(fake.pi);
		const echoFile = join(mktempDir(), "argv.json");
		process.env.CURSOR_FAKE_ECHO_ARGV = "1";
		process.env.CURSOR_FAKE_ECHO_FILE = echoFile;
		process.env.CURSOR_FAKE_FIXTURE = join(FIXTURES, "01-hello-text.ndjson");
		try {
			const stream = fake.reg.streamSimple(mockModel(), mockContext(), {
				// resumeSessionId is part of CursorStreamOptions; if the wrapper
				// drops fields it doesn't recognise, --resume won't appear.
				resumeSessionId: "sess-abc",
			} as CursorStreamOptions);
			await stream.result();
		} finally {
			delete process.env.CURSOR_FAKE_ECHO_ARGV;
			delete process.env.CURSOR_FAKE_ECHO_FILE;
			delete process.env.CURSOR_FAKE_FIXTURE;
		}
		const argv = readArgv(echoFile);
		const idx = argv.indexOf("--resume");
		assert.notEqual(idx, -1, "wrapper must preserve --resume");
		assert.equal(argv[idx + 1], "sess-abc");
	});
});
