/**
 * Unit tests for the `resolveAllowsWrites` precedence helper.
 *
 * The resolver is the single source of truth for whether `cursor-agent`
 * runs with `--force`. The matrix below pins the public ordering: env >
 * cli-flag > slice > default. Drift here is a security-sensitive change.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	FORCE_ENV_VAR,
	FORCE_FLAG_NAME,
	describeAllowsWrites,
	resolveAllowsWrites,
} from "../allows-writes.ts";

function envWith(value: string | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	if (value !== undefined) env[FORCE_ENV_VAR] = value;
	return env;
}

describe("resolveAllowsWrites", () => {
	test("default is read-only when no input is set", () => {
		const r = resolveAllowsWrites(undefined, undefined, envWith(undefined));
		assert.equal(r.allowsWrites, false);
		assert.equal(r.via.source, "none");
	});

	test("env wins over flag and slice", () => {
		const r = resolveAllowsWrites(
			(name) => (name === FORCE_FLAG_NAME ? true : undefined),
			true,
			envWith("1"),
		);
		assert.equal(r.allowsWrites, true);
		assert.equal(r.via.source, "env");
	});

	test("flag wins over slice when env is unset", () => {
		const r = resolveAllowsWrites(
			(name) => (name === FORCE_FLAG_NAME ? true : undefined),
			true,
			envWith(undefined),
		);
		assert.equal(r.allowsWrites, true);
		assert.equal(r.via.source, "cli-flag");
	});

	test("slice takes effect when neither env nor flag is set", () => {
		const r = resolveAllowsWrites(
			() => undefined,
			true,
			envWith(undefined),
		);
		assert.equal(r.allowsWrites, true);
		assert.equal(r.via.source, "slice");
	});

	test("env value other than '1' is ignored", () => {
		const r = resolveAllowsWrites(undefined, undefined, envWith("true"));
		assert.equal(r.allowsWrites, false);
		assert.equal(r.via.source, "none");
	});

	test("non-boolean slice value is treated as false", () => {
		const r = resolveAllowsWrites(
			undefined,
			// @ts-expect-error — explicitly probing the runtime guard
			"yes",
			envWith(undefined),
		);
		assert.equal(r.allowsWrites, false);
		assert.equal(r.via.source, "none");
	});

	test("missing getFlag returns default when no other input is set", () => {
		const r = resolveAllowsWrites(undefined, undefined, envWith(undefined));
		assert.equal(r.allowsWrites, false);
		assert.equal(r.via.source, "none");
	});

	test("getFlag returning a string is not treated as truthy", () => {
		const r = resolveAllowsWrites(
			(name) => (name === FORCE_FLAG_NAME ? "true" : undefined),
			undefined,
			envWith(undefined),
		);
		assert.equal(r.allowsWrites, false);
		assert.equal(r.via.source, "none");
	});

	test("flag set to false does not override slice", () => {
		const r = resolveAllowsWrites(
			(name) => (name === FORCE_FLAG_NAME ? false : undefined),
			true,
			envWith(undefined),
		);
		assert.equal(r.allowsWrites, true);
		assert.equal(r.via.source, "slice");
	});
});

describe("describeAllowsWrites", () => {
	test("renders each source as a stable UX string", () => {
		assert.equal(
			describeAllowsWrites({ allowsWrites: true, via: { source: "env" } }),
			`force-enabled via ${FORCE_ENV_VAR}=1`,
		);
		assert.equal(
			describeAllowsWrites({ allowsWrites: true, via: { source: "cli-flag" } }),
			`force-enabled via --${FORCE_FLAG_NAME}`,
		);
		assert.equal(
			describeAllowsWrites({ allowsWrites: true, via: { source: "slice" } }),
			"force-enabled via slice metadata",
		);
		assert.equal(
			describeAllowsWrites({ allowsWrites: false, via: { source: "none" } }),
			"write-protected (default)",
		);
	});
});
