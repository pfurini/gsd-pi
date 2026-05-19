/**
 * Resolve whether the next `cursor-agent` invocation may pass `--force`.
 *
 * Cursor's `-p` mode prompts interactively when the model wants to edit a
 * file unless `--force` is set, which makes the provider read-only by
 * default and silently hangs on autonomous-edit slices. This module is the
 * single source of truth for the opt-in decision, so the policy stays
 * auditable in one spot (mirrors the precedent in
 * `claude-code-cli/stream-adapter.ts` `resolveClaudePermissionMode`).
 *
 * Precedence (highest first):
 *   1. `process.env.GSD_CURSOR_FORCE_ALL_SLICES === "1"` — session-wide env
 *      override; matches the Claude-Code env-var pattern.
 *   2. `--cursor-force` flag at startup — read via `pi.getFlag("cursor-force")`.
 *   3. Slice descriptor `allowsWrites` bit — passed in by the streamSimple
 *      wrapper from `(options as CursorStreamOptions).allowsWrites`.
 *   4. Default — read-only (no `--force`).
 *
 * NOTE on the "slice" channel: GSD does not currently thread phase / slice
 * metadata through `SimpleStreamOptions`. Today the slice signal is whatever
 * a caller pre-set on `CursorStreamOptions.allowsWrites`. When GSD grows a
 * proper slice descriptor (parent plan §"Future: per-slice phase taxonomy"),
 * the wrapper in `index.ts` is the only place that needs to learn about it
 * — this resolver's contract stays the same.
 */

export type AllowsWritesSource =
	| { source: "env" }
	| { source: "cli-flag" }
	| { source: "slice" }
	| { source: "none" };

export interface AllowsWritesResolution {
	allowsWrites: boolean;
	via: AllowsWritesSource;
}

/** Env var name surfaced to users for a session-wide opt-in. */
export const FORCE_ENV_VAR = "GSD_CURSOR_FORCE_ALL_SLICES";

/** Flag name registered with `pi.registerFlag`. */
export const FORCE_FLAG_NAME = "cursor-force";

type FlagReader = (name: string) => boolean | string | undefined;

/**
 * Decide whether `--force` should appear in the next invocation.
 *
 * `getFlag` is optional so callers outside the extension runtime (tests,
 * `/cursor status` when invoked before the flag is registered) can pass
 * `undefined` and still get a deterministic answer.
 */
export function resolveAllowsWrites(
	getFlag: FlagReader | undefined,
	sliceAllowsWrites: boolean | undefined,
	env: NodeJS.ProcessEnv = process.env,
): AllowsWritesResolution {
	if (env[FORCE_ENV_VAR] === "1") {
		return { allowsWrites: true, via: { source: "env" } };
	}

	if (getFlag) {
		const flagValue = getFlag(FORCE_FLAG_NAME);
		if (flagValue === true) {
			return { allowsWrites: true, via: { source: "cli-flag" } };
		}
	}

	if (sliceAllowsWrites === true) {
		return { allowsWrites: true, via: { source: "slice" } };
	}

	return { allowsWrites: false, via: { source: "none" } };
}

/**
 * Render the resolution for the `/cursor status` slash-command. Returned
 * strings are part of the public UX contract — keep them short and stable.
 */
export function describeAllowsWrites(resolution: AllowsWritesResolution): string {
	switch (resolution.via.source) {
		case "env":
			return `force-enabled via ${FORCE_ENV_VAR}=1`;
		case "cli-flag":
			return `force-enabled via --${FORCE_FLAG_NAME}`;
		case "slice":
			return "force-enabled via slice metadata";
		case "none":
			return "write-protected (default)";
	}
}
