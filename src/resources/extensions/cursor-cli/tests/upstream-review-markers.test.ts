/**
 * UPSTREAM_REVIEW:A audit test.
 *
 * Pins every source file that carries the `UPSTREAM_REVIEW:A` marker introduced
 * by plan #04. The marker is the only thing preventing silent drift if a future
 * refactor moves or removes the cursor cross-vendor failover code paths.
 *
 * If you intentionally add or remove a tagged site, update the expected list
 * below and re-run the test. If the audit fails unexpectedly, the diff has
 * silently dropped a marker — investigate before suppressing.
 *
 * The audit walks the repo from `process.cwd()` (which `npm test` sets to the
 * repo root) rather than shelling out to `rg`, so the test is portable across
 * environments that don't ship ripgrep.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

const MARKER = `UPSTREAM_${"REVIEW"}:A`; // Split so this string isn't itself a marker hit.

/** Repo-relative file paths expected to contain at least one marker. */
const EXPECTED_FILES: ReadonlyArray<string> = [
	"src/resources/extensions/cursor-cli/quota-detect.ts",
	"src/resources/extensions/cursor-cli/stream-adapter.ts",
	"src/resources/extensions/cursor-cli/tests/integration/stream-end-to-end.test.ts",
	"src/resources/extensions/cursor-cli/tests/upstream-review-markers.test.ts",
	"packages/pi-coding-agent/src/core/retryable-error-regex.ts",
];

/** Minimum total marker count across the repo. Drift below this fails the audit. */
const EXPECTED_MIN_TOTAL = 9;

/** Roots scanned for markers. */
const SCAN_ROOTS: ReadonlyArray<string> = [
	"src",
	"packages/pi-coding-agent/src",
];

/** Directory names skipped during the walk (compiled outputs, transient caches). */
const SKIP_DIRS = new Set<string>([
	"node_modules",
	"dist",
	"dist-test",
	".git",
	".planning",
	".plans",
	".todos",
]);

function walk(dir: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return; // missing root (e.g. partial checkout) — treat as empty
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name)) continue;
		const full = join(dir, name);
		let st: Stats;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walk(full, out);
		} else if (st.isFile() && /\.(ts|js|mjs|cjs|tsx|jsx)$/.test(name)) {
			out.push(full);
		}
	}
}

function countMarkers(file: string): number {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return 0;
	}
	const re = new RegExp(MARKER, "g");
	const matches = text.match(re);
	return matches ? matches.length : 0;
}

// UPSTREAM_REVIEW:A — self-reference so the audit always finds this file too.
// (Counted in EXPECTED_MIN_TOTAL.)

describe(`${MARKER} marker audit`, () => {
	test("every expected file contains at least one marker", () => {
		const cwd = process.cwd();
		const failures: string[] = [];
		for (const rel of EXPECTED_FILES) {
			const abs = join(cwd, rel);
			const count = countMarkers(abs);
			if (count === 0) {
				failures.push(`missing marker in ${rel}`);
			}
		}
		assert.deepEqual(failures, [], failures.join("\n"));
	});

	test("total marker count meets the floor (drift detector)", () => {
		const cwd = process.cwd();
		const files: string[] = [];
		for (const root of SCAN_ROOTS) {
			walk(join(cwd, root), files);
		}
		let total = 0;
		for (const f of files) total += countMarkers(f);
		assert.ok(
			total >= EXPECTED_MIN_TOTAL,
			`expected at least ${EXPECTED_MIN_TOTAL} ${MARKER} markers across the repo, found ${total}. ` +
				"A marker was likely deleted during refactor — investigate before lowering the floor.",
		);
	});

	test("non-empty marker set exists (sanity)", () => {
		const cwd = process.cwd();
		const hits: string[] = [];
		for (const root of SCAN_ROOTS) {
			const files: string[] = [];
			walk(join(cwd, root), files);
			for (const f of files) {
				if (countMarkers(f) > 0) hits.push(relative(cwd, f).split(sep).join("/"));
			}
		}
		assert.ok(hits.length > 0, "expected at least one file to carry the marker");
	});
});
