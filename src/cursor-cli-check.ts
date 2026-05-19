// GSD2 — Cursor CLI binary detection for onboarding.
// Lightweight probe used at onboarding time (before extensions load). The
// full readiness check with caching lives in
// `src/resources/extensions/cursor-cli/readiness.ts`.
//
// Per the compliance posture in `.plans/cursor-cli-provider.md` §"Compliance
// & Data Handling": raw `cursor-agent status` output is never logged,
// persisted, or surfaced in errors. Only the parsed boolean leaves this
// module; `CURSOR_API_KEY` is checked for presence only.
//
// Set GSD_CURSOR_DEBUG=1 to log probe selection to stderr.

import { execFileSync } from 'node:child_process'

export function buildCursorSpawnInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', command, ...args] }
  }
  return { command, args }
}

function spawnCursor(command: string, args: string[], opts: { timeout: number; stdio: 'pipe' }): Buffer {
  const invocation = buildCursorSpawnInvocation(command, args)
  return execFileSync(invocation.command, invocation.args, opts)
}

/**
 * Ordered list of binary names to probe for the Cursor CLI.
 *
 * Cursor's install script ships both `cursor-agent` and `agent` aliases on
 * POSIX; on Windows both `.cmd` shims and `.exe` direct binaries may be
 * present. Users can override with `CURSOR_AGENT_BIN=/abs/path`.
 */
export function getCursorCommandCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const override = process.env.CURSOR_AGENT_BIN?.trim()
  if (override) return [override]
  if (platform === 'win32') {
    return ['cursor-agent.cmd', 'agent.cmd', 'cursor-agent.exe', 'agent.exe']
  }
  return ['cursor-agent', 'agent']
}

const VERSION_TIMEOUT_MS = 5_000
const AUTH_TIMEOUT_MS = 15_000

function debugLog(...parts: unknown[]): void {
  if (process.env.GSD_CURSOR_DEBUG) {
    process.stderr.write(`[cursor-cli-check] ${parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`)
  }
}

function findWorkingCommand(): string | null {
  for (const command of getCursorCommandCandidates()) {
    try {
      spawnCursor(command, ['--version'], { timeout: VERSION_TIMEOUT_MS, stdio: 'pipe' })
      debugLog('version probe ok via', command)
      return command
    } catch (error) {
      debugLog('version probe failed for', command, 'code=', (error as NodeJS.ErrnoException | undefined)?.code)
      continue
    }
  }
  return null
}

/**
 * Decide auth state from `cursor-agent status` output.
 *
 * Only the parsed boolean leaves this function — raw stdout is never
 * captured into longer-lived state.
 */
export function parseAuthStatus(output: string): boolean | null {
  const trimmed = output.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { authenticated?: unknown; logged_in?: unknown; loggedIn?: unknown }
      if (typeof parsed.authenticated === 'boolean') return parsed.authenticated
      if (typeof parsed.logged_in === 'boolean') return parsed.logged_in
      if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn
    } catch {
      // fall through to heuristic
    }
  }

  const lower = trimmed.toLowerCase()
  if (/not logged in|no credentials|unauthenticated|not authenticated/.test(lower)) return false
  if (/logged in|authenticated|signed in|subscription/.test(lower)) return true
  return null
}

function probeAuth(command: string): boolean | null {
  // Short-circuit on CURSOR_API_KEY presence — value never read.
  if (typeof process.env.CURSOR_API_KEY === 'string' && process.env.CURSOR_API_KEY.length > 0) {
    return true
  }
  try {
    const out = spawnCursor(command, ['status', '--json'], { timeout: AUTH_TIMEOUT_MS, stdio: 'pipe' }).toString()
    const parsed = parseAuthStatus(out)
    if (parsed !== null) return parsed
  } catch (error) {
    debugLog('status --json threw:', (error as Error).message?.slice(0, 200))
  }
  try {
    const out = spawnCursor(command, ['status'], { timeout: AUTH_TIMEOUT_MS, stdio: 'pipe' }).toString()
    return parseAuthStatus(out)
  } catch (error) {
    debugLog('status threw:', (error as Error).message?.slice(0, 200))
    return null
  }
}

export function isCursorBinaryInstalled(): boolean {
  return findWorkingCommand() !== null
}

export function isCursorCliReady(): boolean {
  if (process.env.GSD_CURSOR_DISABLE === '1') return false
  const command = findWorkingCommand()
  if (!command) return false
  return probeAuth(command) === true
}
