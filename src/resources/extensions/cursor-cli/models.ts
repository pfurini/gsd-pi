/**
 * Static model catalogue for the Cursor CLI provider.
 *
 * Cost is structurally non-zero (input/output > 0 placeholder) only when we
 * have real $/M-token rates from Cursor's quota model; today Cursor bills
 * against the user's subscription and never against per-token rates we
 * control, so all entries use `ZERO_COST`. GSD still records the `usage`
 * block from the terminal `result` event for display in the TUI footer.
 *
 * The catalogue is seed-only; `parseListModelsOutput()` lets the extension
 * refresh the list from `cursor-agent --list-models` at runtime without a
 * GSD restart (see Phase 1 §"Implementation Order").
 */

import type { ProviderModelConfig } from "@gsd/pi-coding-agent";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const TEXT_AND_IMAGE: ("text" | "image")[] = ["text", "image"];
const TEXT_ONLY: ("text" | "image")[] = ["text"];

export const CURSOR_MODELS: ProviderModelConfig[] = [
	{
		id: "composer-2.5",
		name: "Composer 2.5 (Cursor)",
		reasoning: false,
		input: TEXT_AND_IMAGE,
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (via Cursor)",
		reasoning: true,
		input: TEXT_AND_IMAGE,
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7 (via Cursor)",
		reasoning: true,
		input: TEXT_AND_IMAGE,
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5 (via Cursor)",
		reasoning: true,
		input: TEXT_AND_IMAGE,
		cost: ZERO_COST,
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro (via Cursor)",
		reasoning: true,
		input: TEXT_AND_IMAGE,
		cost: ZERO_COST,
		contextWindow: 2_000_000,
		maxTokens: 64_000,
	},
	{
		id: "grok-4",
		name: "Grok 4 (via Cursor)",
		reasoning: true,
		input: TEXT_ONLY,
		cost: ZERO_COST,
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
];

/**
 * Get the current model catalogue. Returns a defensive copy so callers
 * cannot mutate the static seed in place.
 */
export function getCursorModels(): ProviderModelConfig[] {
	return CURSOR_MODELS.map((model) => ({ ...model }));
}

/**
 * Parse the output of `cursor-agent --list-models` into a list of model ids.
 *
 * The CLI prints one model per line; non-id noise (headers, blank lines,
 * trailing decorations) is filtered out. The parser is permissive — the
 * caller decides how to merge the dynamic list against the static seed.
 */
export function parseListModelsOutput(output: string): string[] {
	if (!output) return [];
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		// `cursor-agent` model ids never contain whitespace; skip header lines.
		.filter((line) => !/\s/.test(line))
		// Skip obvious decoration tokens.
		.filter((line) => !/^[-=*]+$/.test(line));
}
