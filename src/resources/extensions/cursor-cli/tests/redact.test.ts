import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../redact.ts";

describe("redactSecrets", () => {
	test("masks Bearer tokens", () => {
		const out = redactSecrets("Authorization: Bearer abcdef1234567890");
		assert.match(out, /Authorization: \[REDACTED\]/);
	});

	test("masks sk- style keys", () => {
		const out = redactSecrets("key sk-thisIsASecret123 leaked");
		assert.match(out, /\[REDACTED\]/);
		assert.doesNotMatch(out, /sk-thisIsASecret/);
	});

	test("masks cursor-key-* prefixed strings", () => {
		const out = redactSecrets("api token cursor-key-FOOBAR12345 was set");
		assert.doesNotMatch(out, /cursor-key-FOOBAR/);
	});

	test("masks JWT-shaped strings", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE2MDB9.signature_part_AbC123";
		const out = redactSecrets(`token=${jwt} appears`);
		assert.doesNotMatch(out, /eyJhbGc/);
	});

	test("returns input unchanged when no secrets are present", () => {
		const input = "nothing sensitive here";
		assert.equal(redactSecrets(input), input);
	});

	test("handles empty strings without throwing", () => {
		assert.equal(redactSecrets(""), "");
	});
});
