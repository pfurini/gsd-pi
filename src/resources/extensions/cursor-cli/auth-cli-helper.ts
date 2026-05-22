/**
 * Optional `/cursor` slash commands (Phase 3 quality-of-life UX).
 *
 * Per the compliance posture (§"Compliance & Data Handling"): every command
 * is a pure shell-out to `cursor-agent`. GSD never intercepts the OAuth
 * browser flow, captures tokens, or proxies credential traffic. Output is
 * passed through `redactSecrets()` before reaching the TUI in case the CLI
 * itself prints something credential-shaped.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { spawn } from "node:child_process";
import { describeAllowsWrites, resolveAllowsWrites } from "./allows-writes.js";
// UPSTREAM_REVIEW:B — `/cursor doctor` renders a local-only ASCII snapshot of
// recent slice metrics. Imports kept narrow so the telemetry-leak guard test
// can't find a reachable path from `metrics.ts` into any telemetry sink.
import { renderDoctor } from "./doctor.js";
import { snapshot as metricsSnapshot } from "./metrics.js";
import { redactSecrets } from "./redact.js";
import { clearReadinessCache, findWorkingCommand } from "./readiness.js";
import { parseListModelsOutput } from "./models.js";
// UPSTREAM_REVIEW:C — `/cursor adapter [sdk|cli]` reads/writes the persistent
// cursor.adapter setting; `/cursor status` reports the active adapter.
import {
	DEFAULT_CURSOR_ADAPTER,
	readCursorAdapterSetting,
	writeCursorAdapterSetting,
	type CursorAdapter,
} from "./adapter-setting.js";
import { invalidatePathCache, pickStreamPath } from "./path-selector.js";

interface ShellOutResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function shellOut(command: string, args: string[], cwd: string): Promise<ShellOutResult> {
	return await new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["inherit", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			resolve({ code: 1, stdout, stderr: stderr || error.message });
		});
		child.on("close", (code) => {
			resolve({ code: code ?? 0, stdout, stderr });
		});
	});
}

function logToContext(ctx: ExtensionCommandContext, message: string): void {
	const redacted = redactSecrets(message);
	// In the interactive TUI (and the web UI) output MUST go through
	// `ui.notify()`: it renders the text as a layout-tracked chat component
	// so the renderer reflows the editor and footer around it. A raw
	// `process.stdout.write()` bypasses the TUI layout engine entirely — the
	// footer then redraws on top of the text, and multi-line output (e.g.
	// `/cursor doctor`) visibly collides with the input box.
	if (ctx.hasUI) {
		ctx.ui.notify(redacted, "info");
		return;
	}
	// Headless / print / RPC mode: there is no TUI to corrupt, so writing
	// straight to stdout is the correct (and only) channel.
	process.stdout.write(`${redacted}\n`);
}

function resolveCwd(ctx: ExtensionCommandContext): string {
	const candidate = (ctx as unknown as { cwd?: string }).cwd;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : process.cwd();
}

async function handleStatus(
	_args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI | undefined,
): Promise<void> {
	const command = findWorkingCommand();
	if (!command) {
		logToContext(ctx, "cursor-agent not detected on PATH");
		return;
	}
	const cwd = resolveCwd(ctx);
	const versionResult = await shellOut(command, ["--version"], cwd);
	const statusResult = await shellOut(command, ["status"], cwd);
	// `/cursor status` is a session-level check — there is no slice in
	// scope, so the resolver only considers env + flag and reports the
	// remaining default ("write-protected"). This is what the user sees
	// before they run anything.
	const writePolicy = resolveAllowsWrites(pi ? (name) => pi.getFlag(name) : undefined, undefined);
	// UPSTREAM_REVIEW:C — surface the resolved adapter so users can see
	// whether the next slice will go through the SDK or CLI path.
	const adapter = readCursorAdapterSetting();
	logToContext(
		ctx,
		[
			`binary: ${command}`,
			`version: ${versionResult.stdout.trim() || "unknown"}`,
			`status: ${statusResult.stdout.trim() || statusResult.stderr.trim() || "unknown"}`,
			`CURSOR_API_KEY: ${process.env.CURSOR_API_KEY ? "present" : "not set"}`,
			`write policy: ${describeAllowsWrites(writePolicy)}`,
			`adapter: ${adapter}${adapter === DEFAULT_CURSOR_ADAPTER ? " (default)" : ""}`,
		].join("\n"),
	);
}

// UPSTREAM_REVIEW:C
async function handleAdapter(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const sub = args.trim();
	if (!sub) {
		const current = readCursorAdapterSetting();
		logToContext(
			ctx,
			`cursor adapter: ${current}${current === DEFAULT_CURSOR_ADAPTER ? " (default)" : ""}`,
		);
		return;
	}
	if (sub !== "sdk" && sub !== "cli") {
		logToContext(ctx, `usage: /cursor adapter [sdk|cli]`);
		return;
	}
	try {
		writeCursorAdapterSetting(sub as CursorAdapter);
		invalidatePathCache();
		logToContext(ctx, `cursor adapter set to "${sub}" (next slice will use the ${sub} path)`);
	} catch (err) {
		logToContext(
			ctx,
			`failed to write cursor.adapter: ${(err as Error).message}`,
		);
	}
}

async function handleLogin(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const command = findWorkingCommand();
	if (!command) {
		logToContext(ctx, "cursor-agent not detected — install Cursor first");
		return;
	}
	logToContext(ctx, "Running `cursor-agent login` — complete the browser flow if prompted");
	await shellOut(command, ["login"], resolveCwd(ctx));
	clearReadinessCache();
	logToContext(ctx, "readiness cache cleared — re-run `/cursor` to verify");
}

async function handleLogout(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const command = findWorkingCommand();
	if (!command) {
		logToContext(ctx, "cursor-agent not detected");
		return;
	}
	await shellOut(command, ["logout"], resolveCwd(ctx));
	clearReadinessCache();
	logToContext(ctx, "logged out — readiness cache cleared");
}

async function handleModels(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const command = findWorkingCommand();
	if (!command) {
		logToContext(ctx, "cursor-agent not detected");
		return;
	}
	const result = await shellOut(command, ["--list-models"], resolveCwd(ctx));
	const models = parseListModelsOutput(result.stdout);
	if (models.length === 0) {
		logToContext(ctx, result.stderr.trim() || "no models reported by cursor-agent");
		return;
	}
	logToContext(ctx, models.join("\n"));
}

// UPSTREAM_REVIEW:C — describe the adapter the next slice will actually use.
// `pickStreamPath()` is the single source of truth: it folds in the
// `cursor.adapter` setting AND the runtime fallbacks (missing CURSOR_API_KEY,
// `@cursor/sdk` failing to load). When the resolved path differs from the
// configured setting, surfacing that gap is the whole point — `/cursor
// status` only ever reports the configured value, never the fallback.
async function describeResolvedAdapter(): Promise<string> {
	const configured = readCursorAdapterSetting();
	let resolved: CursorAdapter;
	try {
		const path = await pickStreamPath();
		resolved = path.kind === "sdk" ? "sdk" : "cli";
	} catch {
		// pickStreamPath is defensive and shouldn't throw, but a doctor read
		// must never fail — degrade to reporting the configured setting.
		return `${configured} (configured; runtime path unresolved)`;
	}
	if (resolved === configured) {
		return `${resolved}${resolved === DEFAULT_CURSOR_ADAPTER ? " (default)" : ""}`;
	}
	return `${resolved} (fell back from ${configured})`;
}

// UPSTREAM_REVIEW:B — `/cursor doctor` renders the local-only metrics
// snapshot; recording is gated by `GSD_CURSOR_METRICS_DISABLE=1` inside
// `metrics.record()` itself. UPSTREAM_REVIEW:C — the trailing `adapter:`
// line reports the resolved SDK/CLI path; resolving it reads the persisted
// `cursor.adapter` setting and may probe `@cursor/sdk` once per process.
async function handleDoctor(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const adapter = await describeResolvedAdapter();
	const rendered = renderDoctor(metricsSnapshot(), adapter);
	logToContext(ctx, rendered);
}

async function handleResume(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const sessionId = args.trim();
	if (!sessionId) {
		logToContext(ctx, "usage: /cursor resume <session-id>");
		return;
	}
	logToContext(
		ctx,
		`next slice will resume cursor session ${sessionId} via --resume — set CursorStreamOptions.resumeSessionId to apply`,
	);
}

async function handleRoot(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const sub = args.split(/\s+/).filter(Boolean)[0];
	if (!sub) {
		await handleStatus("", ctx, pi);
		return;
	}
	const rest = args.slice(sub.length).trim();
	switch (sub) {
		case "login":
			await handleLogin(rest, ctx);
			return;
		case "logout":
			await handleLogout(rest, ctx);
			return;
		case "models":
			await handleModels(rest, ctx);
			return;
		case "resume":
			await handleResume(rest, ctx);
			return;
		case "status":
			await handleStatus(rest, ctx, pi);
			return;
		// UPSTREAM_REVIEW:B — `doctor` prints the local-only metrics snapshot.
		case "doctor":
			await handleDoctor(rest, ctx);
			return;
		// UPSTREAM_REVIEW:C
		case "adapter":
			await handleAdapter(rest, ctx);
			return;
		default:
			logToContext(
				ctx,
				`unknown subcommand: ${sub}. Try: status | login | logout | models | resume <id> | doctor | adapter [sdk|cli]`,
			);
	}
}

export function registerCursorCommands(pi: ExtensionAPI): void {
	// UPSTREAM_REVIEW:C — `adapter` joins the subcommand list.
	pi.registerCommand("cursor", {
		description:
			"Manage the Cursor CLI provider (status / login / logout / models / resume / doctor / adapter)",
		handler: (args, ctx) => handleRoot(args, ctx, pi),
	});
}
