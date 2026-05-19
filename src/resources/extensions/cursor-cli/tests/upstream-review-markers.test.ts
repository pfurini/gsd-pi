/**
 * UPSTREAM_REVIEW:A and UPSTREAM_REVIEW:B audit tests.
 *
 * Pins every source file that carries an `UPSTREAM_REVIEW:<letter>` marker.
 * Each letter corresponds to one upstream-review concern surfaced by a plan in
 * the cursor-cli roadmap:
 *
 *   :A — plan #04 (cross-vendor failover / quota classification)
 *   :B — plan #05 (local-only doctor metrics)
 *
 * The marker is the only thing preventing silent drift if a future refactor
 * moves or removes the cursor cross-vendor code paths or the doctor metrics
 * recorder. If you intentionally add or remove a tagged site, update the
 * expected list and floor below and re-run. If the audit fails unexpectedly,
 * the diff has silently dropped a marker — investigate before suppressing.
 *
 * The audit walks the repo from `process.cwd()` (which `npm test` sets to the
 * repo root) rather than shelling out to `rg`, so the test is portable across
 * environments that don't ship ripgrep.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

// Split each marker string so this file isn't itself a marker hit for the
// "literal" forms used by the audit.
const MARKER_A = `UPSTREAM_${"REVIEW"}:A`;
const MARKER_B = `UPSTREAM_${"REVIEW"}:B`;

/** Repo-relative file paths expected to contain at least one :A marker.
 *
 * NOTE (plan #06 refactor): the `result.is_error` classifier moved from
 * `stream-adapter.ts` into the shared `stream-translation.ts` module so the
 * SDK path inherits it. The marker list follows the code. */
const EXPECTED_FILES_A: ReadonlyArray<string> = [
	"src/resources/extensions/cursor-cli/quota-detect.ts",
	"src/resources/extensions/cursor-cli/stream-translation.ts",
	"src/resources/extensions/cursor-cli/tests/integration/stream-end-to-end.test.ts",
	"src/resources/extensions/cursor-cli/tests/upstream-review-markers.test.ts",
	"packages/pi-coding-agent/src/core/retryable-error-regex.ts",
];

/** Minimum total :A marker count across the repo. Drift below this fails. */
const EXPECTED_MIN_TOTAL_A = 9;

/** Repo-relative file paths expected to contain at least one :B marker. */
const EXPECTED_FILES_B: ReadonlyArray<string> = [
	"src/resources/extensions/cursor-cli/metrics.ts",
	"src/resources/extensions/cursor-cli/doctor.ts",
	"src/resources/extensions/cursor-cli/stream-adapter.ts",
	"src/resources/extensions/cursor-cli/auth-cli-helper.ts",
	"src/resources/extensions/cursor-cli/tests/metrics.test.ts",
	"src/resources/extensions/cursor-cli/tests/doctor-render.test.ts",
	"src/resources/extensions/cursor-cli/tests/telemetry-leak-guard.test.ts",
	"src/resources/extensions/cursor-cli/tests/upstream-review-markers.test.ts",
	"src/resources/extensions/cursor-cli/tests/integration/stream-end-to-end.test.ts",
];

/** Minimum total :B marker count across the repo. Drift below this fails. */
const EXPECTED_MIN_TOTAL_B = 30;

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
		return;
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

function countMarkers(file: string, marker: string): number {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return 0;
	}
	const re = new RegExp(marker, "g");
	const matches = text.match(re);
	return matches ? matches.length : 0;
}

// UPSTREAM_REVIEW:A — self-reference so the :A audit always finds this file.
// UPSTREAM_REVIEW:B — self-reference so the :B audit always finds this file.

interface MarkerConfig {
	letter: "A" | "B";
	marker: string;
	expectedFiles: ReadonlyArray<string>;
	expectedMinTotal: number;
}

const CONFIGS: ReadonlyArray<MarkerConfig> = [
	{ letter: "A", marker: MARKER_A, expectedFiles: EXPECTED_FILES_A, expectedMinTotal: EXPECTED_MIN_TOTAL_A },
	{ letter: "B", marker: MARKER_B, expectedFiles: EXPECTED_FILES_B, expectedMinTotal: EXPECTED_MIN_TOTAL_B },
];

for (const cfg of CONFIGS) {
	describe(`${cfg.marker} marker audit`, () => {
		test(`every expected :${cfg.letter} file contains at least one marker`, () => {
			const cwd = process.cwd();
			const failures: string[] = [];
			for (const rel of cfg.expectedFiles) {
				const abs = join(cwd, rel);
				const count = countMarkers(abs, cfg.marker);
				if (count === 0) {
					failures.push(`missing marker in ${rel}`);
				}
			}
			assert.deepEqual(failures, [], failures.join("\n"));
		});

		test(`total :${cfg.letter} marker count meets the floor (drift detector)`, () => {
			const cwd = process.cwd();
			const files: string[] = [];
			for (const root of SCAN_ROOTS) {
				walk(join(cwd, root), files);
			}
			let total = 0;
			for (const f of files) total += countMarkers(f, cfg.marker);
			assert.ok(
				total >= cfg.expectedMinTotal,
				`expected at least ${cfg.expectedMinTotal} ${cfg.marker} markers across the repo, found ${total}. ` +
					"A marker was likely deleted during refactor — investigate before lowering the floor.",
			);
		});

		test(`non-empty :${cfg.letter} marker set exists (sanity)`, () => {
			const cwd = process.cwd();
			const hits: string[] = [];
			for (const root of SCAN_ROOTS) {
				const files: string[] = [];
				walk(join(cwd, root), files);
				for (const f of files) {
					if (countMarkers(f, cfg.marker) > 0) {
						hits.push(relative(cwd, f).split(sep).join("/"));
					}
				}
			}
			assert.ok(hits.length > 0, `expected at least one file to carry the ${cfg.marker} marker`);
		});
	});
}
