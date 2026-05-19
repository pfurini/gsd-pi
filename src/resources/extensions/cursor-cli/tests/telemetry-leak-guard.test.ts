/**
 * UPSTREAM_REVIEW:B — telemetry-leak reverse-dependency scan.
 *
 * Limitation (intentional):
 *   This is a SHALLOW grep-based test. For every `.ts` file in the scan
 *   roots, it checks whether the file's source text contains both:
 *     - an import that resolves to `cursor-cli/metrics.ts`, AND
 *     - an import from any path in {@link FORBIDDEN_REACH}.
 *
 *   It does NOT trace transitive imports. A two-hop reach (metrics → helper →
 *   telemetry) will slip through. A reviewer must still inspect any new
 *   importer of `metrics.ts` outside `cursor-cli/`.
 *
 *   The scan is good enough to block the obvious mistake — a contributor
 *   adding `import { snapshot } from "../cursor-cli/metrics"` inside a file
 *   that already imports from `gsd/legacy-telemetry`. That single pattern
 *   covers ~all the realistic "I'll just shove this into the existing
 *   telemetry pipe" PRs we want to catch in CI.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

// UPSTREAM_REVIEW:B — telemetry sinks the local metrics ring must never reach.
// Hard-coded so a contributor adding a new sink also surfaces this list to
// reviewers. If a new sink lands, add the relative path here.
const FORBIDDEN_REACH: ReadonlyArray<string> = [
	"src/resources/extensions/gsd/legacy-telemetry.ts",
	"src/resources/extensions/gsd/skill-telemetry.ts",
	"src/resources/extensions/gsd/worktree-telemetry.ts",
	"src/resources/extensions/gsd/auto-tool-tracking.ts",
];

const SCAN_ROOTS: ReadonlyArray<string> = ["src", "packages"];

const SKIP_DIRS = new Set<string>([
	"node_modules",
	"dist",
	"dist-test",
	".git",
	".planning",
	".plans",
	".todos",
	// Skip the cursor-cli tests directory — fixture/test files may import
	// metrics for legitimate test setup and reaching into telemetry from a
	// test file would be a separate, more obvious code-review red flag.
	"tests",
]);

// UPSTREAM_REVIEW:B
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
		} else if (st.isFile() && /\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
			out.push(full);
		}
	}
}

// UPSTREAM_REVIEW:B — best-effort detection that a file imports the cursor-cli
// metrics module. There are several `metrics.ts` files in the tree (each
// extension has its own); we want to match cursor-cli/metrics.ts specifically.
//
// Strategy:
//   - For files OUTSIDE `cursor-cli/`: the import path must contain the
//     `cursor-cli` segment (e.g. `from "../cursor-cli/metrics.js"`).
//   - For files INSIDE `cursor-cli/`: a bare relative `./metrics.js` or
//     `../metrics.js` resolves to the same module.
//
// This deliberately ignores barrel re-exports — if a transitively reachable
// barrel ever re-exports `metrics`, a reviewer needs to catch it manually.
function importsMetrics(absFilePath: string, source: string): boolean {
	const inCursorCli = absFilePath.split(sep).join("/").includes("/cursor-cli/");
	const lines = source.split("\n");
	for (const line of lines) {
		if (!/\b(?:import|from)\b/.test(line)) continue;
		if (/cursor-cli\/metrics(?:\.js|\.ts)?["']/.test(line)) {
			return true;
		}
		if (inCursorCli && /from\s+["'](?:\.\.?\/)+metrics(?:\.js|\.ts)?["']/.test(line)) {
			return true;
		}
	}
	return false;
}

// UPSTREAM_REVIEW:B
function importsForbidden(source: string): string | null {
	for (const forbidden of FORBIDDEN_REACH) {
		// Match either the full repo-relative path or just the trailing filename
		// (e.g. `./legacy-telemetry`). The trailing-filename match is the
		// tighter check because relative imports almost never include the full
		// `src/...` path.
		const filename = forbidden.split("/").pop() ?? forbidden;
		const stem = filename.replace(/\.ts$/, "");
		if (source.includes(forbidden)) return forbidden;
		// Reject `from "...something/<stem>(.js|.ts)?"` inside import lines.
		const lines = source.split("\n");
		for (const line of lines) {
			if (!/\b(?:import|from)\b/.test(line)) continue;
			const re = new RegExp(`/${stem}(?:\\.js|\\.ts)?["']`);
			if (re.test(line)) return forbidden;
		}
	}
	return null;
}

describe("cursor-cli metrics telemetry-leak guard", () => {
	test("no file in scan roots imports both metrics.ts and a forbidden telemetry sink", () => {
		const cwd = process.cwd();
		const files: string[] = [];
		for (const root of SCAN_ROOTS) {
			walk(join(cwd, root), files);
		}

		const violations: string[] = [];
		for (const file of files) {
			let source: string;
			try {
				source = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			if (!importsMetrics(file, source)) continue;
			const hit = importsForbidden(source);
			if (hit) {
				violations.push(
					`${relative(cwd, file).split(sep).join("/")} imports both cursor-cli/metrics and ${hit}`,
				);
			}
		}

		assert.deepEqual(violations, [], violations.join("\n"));
	});

	test("the scan actually finds the legitimate metrics importers (sanity)", () => {
		// If this assertion fails, the importsMetrics() heuristic has drifted —
		// the leak guard above would then silently pass for the wrong reason.
		const cwd = process.cwd();
		const files: string[] = [];
		for (const root of SCAN_ROOTS) {
			walk(join(cwd, root), files);
		}
		const importers: string[] = [];
		for (const file of files) {
			let source: string;
			try {
				source = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			if (importsMetrics(file, source)) importers.push(relative(cwd, file).split(sep).join("/"));
		}
		assert.ok(
			importers.length >= 2,
			`expected at least 2 metrics importers (stream-adapter, auth-cli-helper), found: ${importers.join(", ")}`,
		);
	});
});
