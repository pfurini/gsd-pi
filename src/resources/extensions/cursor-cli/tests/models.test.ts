import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MODELS, getCursorModels, parseListModelsOutput } from "../models.ts";

describe("CURSOR_MODELS catalogue", () => {
	test("seeds the documented Phase 1 models", () => {
		const ids = CURSOR_MODELS.map((m) => m.id);
		assert.ok(ids.includes("composer-2.5"));
		assert.ok(ids.includes("claude-sonnet-4-6"));
		assert.ok(ids.includes("claude-opus-4-7"));
		assert.ok(ids.includes("gpt-5.5"));
		assert.ok(ids.includes("gemini-2.5-pro"));
		assert.ok(ids.includes("grok-4"));
	});

	test("each entry declares zero-cost (Cursor bills the subscription)", () => {
		for (const model of CURSOR_MODELS) {
			assert.equal(model.cost.input, 0);
			assert.equal(model.cost.output, 0);
			assert.equal(model.cost.cacheRead, 0);
			assert.equal(model.cost.cacheWrite, 0);
		}
	});

	test("getCursorModels returns a defensive copy", () => {
		const a = getCursorModels();
		const b = getCursorModels();
		assert.notEqual(a, b);
		a[0].name = "MUTATED";
		assert.notEqual(b[0].name, "MUTATED");
	});
});

describe("parseListModelsOutput", () => {
	test("strips blank lines and decoration", () => {
		const out = parseListModelsOutput("composer-2.5\n\nclaude-sonnet-4-6\n---\ngpt-5.5");
		assert.deepEqual(out, ["composer-2.5", "claude-sonnet-4-6", "gpt-5.5"]);
	});

	test("drops header lines with whitespace", () => {
		const out = parseListModelsOutput("Available models:\ncomposer-2.5\nclaude-opus-4-7");
		assert.deepEqual(out, ["composer-2.5", "claude-opus-4-7"]);
	});

	test("handles empty output gracefully", () => {
		assert.deepEqual(parseListModelsOutput(""), []);
	});
});
