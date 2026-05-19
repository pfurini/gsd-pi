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
import { redactSecrets } from "./redact.js";
import { clearReadinessCache, findWorkingCommand } from "./readiness.js";
import { parseListModelsOutput } from "./models.js";

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
	const log = (ctx as unknown as { log?: (m: string) => void }).log;
	if (typeof log === "function") {
		log(redacted);
		return;
	}
	process.stdout.write(`${redacted}\n`);
}

function resolveCwd(ctx: ExtensionCommandContext): string {
	const candidate = (ctx as unknown as { cwd?: string }).cwd;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : process.cwd();
}

async function handleStatus(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const command = findWorkingCommand();
	if (!command) {
		logToContext(ctx, "cursor-agent not detected on PATH");
		return;
	}
	const cwd = resolveCwd(ctx);
	const versionResult = await shellOut(command, ["--version"], cwd);
	const statusResult = await shellOut(command, ["status"], cwd);
	logToContext(
		ctx,
		[
			`binary: ${command}`,
			`version: ${versionResult.stdout.trim() || "unknown"}`,
			`status: ${statusResult.stdout.trim() || statusResult.stderr.trim() || "unknown"}`,
			`CURSOR_API_KEY: ${process.env.CURSOR_API_KEY ? "present" : "not set"}`,
		].join("\n"),
	);
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

async function handleRoot(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const sub = args.split(/\s+/).filter(Boolean)[0];
	if (!sub) {
		await handleStatus("", ctx);
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
			await handleStatus(rest, ctx);
			return;
		default:
			logToContext(ctx, `unknown subcommand: ${sub}. Try: status | login | logout | models | resume <id>`);
	}
}

export function registerCursorCommands(pi: ExtensionAPI): void {
	pi.registerCommand("cursor", {
		description: "Manage the Cursor CLI provider (status / login / logout / models / resume)",
		handler: handleRoot,
	});
}
