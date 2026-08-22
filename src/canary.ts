/**
 * Optional canary pre-restart validation for the smart_restart tool.
 *
 * When enabled, before the tool persists a pending notice or spawns the real
 * `systemctl restart`, the canary boots an EPHEMERAL DSH instance from the
 * same binary as the systemd unit (derived from `systemctl show -p
 * ExecStart`), on an auto-picked free port, under a temp state overlay
 * (`dsh --patch` applied after the profile layer: this plugin disabled and
 * the listed rows' stateDir redirected into the temp dir), then probes HTTP
 * liveness on that port. `passed` lets the restart proceed; `failed` aborts
 * it (the caller alerts the calling session from the execute closure);
 * `skipped` (cannot derive binary/profile) NEVER blocks a restart, so generic
 * installs stay safe.
 *
 * The module is intentionally IO-thin: the pure helpers below are exported
 * for unit tests, and every spawn/fetch/systemctl call is routed through the
 * injectable `CanaryHooks` table (default `defaultCanaryHooks`), so tests run
 * without a dsh service, /opt/dsh, or systemctl.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type CanaryStatus = 'passed' | 'failed' | 'skipped'

export interface CanaryResult {
  status: CanaryStatus
  detail: string
}

/** Config surface the canary reads (a subset of the plugin Config). */
export interface CanaryConfig {
  restartUnit: string
  canary: boolean
  canaryTimeoutMs: number
  canaryPort: number
  canaryProfile: string
  canaryBinary: string
  canaryStateDirOverrides: Record<string, string>
}

/** smart_restart call fields the canary honors. */
export interface CanaryCall {
  /** true → validate even when config.canary is false (per-call override). */
  canary?: boolean
  reason?: string
}

/**
 * Injectable IO hooks. Every field is optional and falls back to a real
 * implementation from `defaultCanaryHooks`; tests replace them with fakes to
 * exercise runCanary without a dsh service, /opt/dsh, or systemctl.
 */
export interface CanaryHooks {
  /** Raw first line of `systemctl show -p ExecStart <unit>`, or null when unavailable. */
  execStartOfUnit?: (unit: string) => string | null
  /** Auto-pick a free local TCP port. */
  pickFreePort?: () => Promise<number>
  /** Pre-flight `--dump-config`; ok=false carries bounded stderr. */
  dumpConfig?: (binary: string, profile: string, patchPath: string) => { ok: boolean; stderr: string }
  /** Boot the ephemeral instance detached; returns the child or null when spawn failed. */
  spawnBoot?: (binary: string, profile: string, patchPath: string, port: number) => ChildProcess | null
  /** Poll HTTP liveness on the port until healthy or the timeout elapses. */
  probeLiveness?: (port: number, timeoutMs: number) => Promise<boolean>
  /** Kill the ephemeral's process group (negative pid). */
  killProcessGroup?: (pid: number) => void
}

/**
 * Parse a systemd ExecStart line into the dsh binary and `--profile` value.
 *
 * Handles both the raw form (`/usr/bin/dsh --profile deepartments-dev ...`)
 * and the `systemctl show` record (`ExecStart={ path=... ; argv[]=... ; }`),
 * whose `argv[]=` payload is the reconstructed command line. Leading
 * environment assignments (`FOO=bar`) and an `env`/`/usr/bin/env` wrapper are
 * skipped before the first executable token. Returns null when the line has
 * no executable.
 */
export function deriveExecStartParams(execStartLine: string): { binary?: string; profile?: string } | null {
  if (typeof execStartLine !== 'string' || !execStartLine.trim()) return null
  const argvMatch = execStartLine.match(/argv\[\]=([^;]+)/)
  let cmdline = (argvMatch ? argvMatch[1] : execStartLine).trim()
  // Tolerate a leading `ExecStart=` property prefix on the raw form.
  cmdline = cmdline.replace(/^ExecStart=\s*/, '')
  const tokens = cmdline.split(/\s+/)
  const args: string[] = []
  for (const token of tokens) {
    if (!token) continue
    if (args.length === 0) {
      // Skip leading environment assignments (FOO=bar) and env wrappers.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
      if (token === 'env' || token === '/usr/bin/env') continue
    }
    args.push(token)
  }
  if (args.length === 0) return null
  const out: { binary?: string; profile?: string } = {}
  const binary = stripQuotes(args[0])
  if (binary) out.binary = binary
  const profileIdx = args.indexOf('--profile')
  if (profileIdx !== -1 && args[profileIdx + 1] !== undefined && !args[profileIdx + 1].startsWith('--')) {
    const profile = stripQuotes(args[profileIdx + 1])
    if (profile) out.profile = profile
  }
  return out
}

/**
 * Resolve the canary launch binary/profile.
 *
 * Explicit config wins; otherwise the ExecStart derivation; otherwise `dsh`
 * on PATH for the binary. Returns null when derivation is impossible — no
 * systemctl/unit lookup result AND no explicit binary/profile — so a generic
 * install never gets a guessed launch (the caller then SKIPS, never blocks).
 */
export function resolveExecTarget(
  cfg: Pick<CanaryConfig, 'canaryBinary' | 'canaryProfile'>,
  derived: { binary?: string; profile?: string } | null,
): { binary: string; profile: string } | null {
  if (!derived && !cfg.canaryBinary && !cfg.canaryProfile) return null
  return {
    binary: cfg.canaryBinary || derived?.binary || 'dsh',
    profile: cfg.canaryProfile || derived?.profile || '',
  }
}

/**
 * Compose the canary `--patch` overlay YAML (a top-level list of id-targeted
 * rows, the same shape the dev profile uses; a patch row replaces the row's
 * WHOLE config, and unmatched rows warn + skip harmlessly).
 *
 * Always emits a row disabling THIS plugin in the ephemeral canary
 * (`config.enabled: false` — apply() returns immediately, so the canary never
 * writes a marker or notice into the live state dir), emitted FIRST as one
 * complete block; when `canaryStateDirOverrides` lists `smart-restart`, that
 * same block also carries the redirected `stateDir` (the merge lives INSIDE
 * the row, so it can never leak into another row's config). Then emits one
 * row per remaining `canaryStateDirOverrides` entry, replacing that row's
 * stateDir with its temp path: an absolute value is used verbatim, a relative
 * or empty value resolves under `tmpDir` (e.g. `deepartments: ''` →
 * `stateDir: "<tmpDir>/deepartments"`), so the canary never writes live board
 * state from other plugins either.
 */
export function buildPatchContent(tmpDir: string, overrides: Record<string, string> = {}): string {
  // The smart-restart row is emitted FIRST as one complete self-contained
  // block: always `enabled: false` (the canary must never write a marker or
  // notice into the live state dir), plus its own optional redirected stateDir
  // when the caller lists `smart-restart` in canaryStateDirOverrides. The
  // merged stateDir is part of THIS block, so it can never land inside another
  // row's config even when other override rows follow.
  const lines = [
    "# dsh-smart-restart canary overlay (generated at runtime).",
    "# Applied via `dsh --patch` AFTER the profile layer for --dump-config and",
    "# the ephemeral boot. A patch row replaces the targeted row's WHOLE config",
    "# (no merge), so the canary boots with this plugin disabled and any listed",
    "# rows' stateDir redirected into the temp dir - it never writes live",
    "# marker/notice or board state.",
    '- id: smart-restart',
    '  config:',
    '    enabled: false',
  ]
  if ('smart-restart' in overrides) {
    // Quote the path (YAML-safe for spaces, e.g. /tmp paths with spaces).
    lines.push(`    stateDir: "${resolveOverrideDir(overrides['smart-restart'], 'smart-restart', tmpDir)}"`)
  }
  for (const [key, dir] of Object.entries(overrides)) {
    if (key === 'smart-restart') continue
    lines.push(`- id: ${key}`)
    lines.push('  config:')
    // Quote the path (YAML-safe for spaces, e.g. /tmp paths with spaces).
    lines.push(`    stateDir: "${resolveOverrideDir(dir, key, tmpDir)}"`)
  }
  return `${lines.join('\n')}\n`
}

function resolveOverrideDir(dir: string, key: string, tmpDir: string): string {
  if (!dir) return join(tmpDir, key)
  return isAbsolute(dir) ? dir : join(tmpDir, dir)
}

function stripQuotes(tok: string): string {
  if (tok.length >= 2) {
    const first = tok.charAt(0)
    const last = tok.charAt(tok.length - 1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return tok.slice(1, -1)
  }
  return tok
}

/** Auto-pick a free local TCP port (listen 0 → port → close). */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * Map ONE liveness attempt to healthy: only an HTTP 200 counts. A refused
 * connection (server not yet up) or any other status is NOT healthy.
 */
export function probeStatusHealthy(status: number | undefined): boolean {
  return status === 200
}

// --- default IO implementations (swapped by tests via CanaryHooks) ---------

function execStartOfUnitDefault(unit: string): string | null {
  try {
    const r = spawnSync('systemctl', ['show', '-p', 'ExecStart', unit], { encoding: 'utf8', timeout: 10000 })
    if (r.status !== 0 || !r.stdout) return null
    const line = String(r.stdout).split('\n')[0]?.trim() ?? ''
    return line || null
  } catch {
    return null
  }
}

function dumpConfigDefault(binary: string, profile: string, patchPath: string): { ok: boolean; stderr: string } {
  const argv = [binary]
  if (profile) argv.push('--profile', profile)
  argv.push('--patch', patchPath, '--dump-config')
  try {
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 20000 })
    if (r.error) return { ok: false, stderr: String(r.error).slice(0, 500) }
    if (r.status !== 0) {
      const stderr = String(r.stderr ?? '').trim().slice(0, 500)
      return {
        ok: false,
        stderr: stderr || `exit code ${r.status} (no stderr captured)`,
      }
    }
    return { ok: true, stderr: '' }
  } catch (err) {
    return { ok: false, stderr: String(err).slice(0, 500) }
  }
}

function spawnBootDefault(binary: string, profile: string, patchPath: string, port: number): ChildProcess | null {
  const argv = [binary]
  if (profile) argv.push('--profile', profile)
  argv.push('--patch', patchPath, '--port', String(port))
  try {
    const child = spawn('setsid', argv, { detached: true, stdio: 'ignore' })
    child.unref()
    return child
  } catch {
    return null
  }
}

async function probeLivenessDefault(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/`
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    let status: number | undefined
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(800, remaining)) })
      status = res.status
    } catch {
      status = undefined // ECONNREFUSED (not yet up) or per-attempt timeout
    }
    if (probeStatusHealthy(status)) return true
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)))
  }
}

function killProcessGroupDefault(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // process group already gone; ignore
  }
}

export const defaultCanaryHooks: CanaryHooks = {
  execStartOfUnit: execStartOfUnitDefault,
  pickFreePort,
  dumpConfig: dumpConfigDefault,
  spawnBoot: spawnBootDefault,
  probeLiveness: probeLivenessDefault,
  killProcessGroup: killProcessGroupDefault,
}

/**
 * Run the canary pre-restart validation.
 *
 * `ctx` (the cordis Context) is currently unused — kept in the signature for
 * interface stability, e.g. future live-context needs such as excluding the
 * live webServer port from auto-pick. The calling session is never touched
 * here: a failed canary is alerted by the caller (execute closure), which
 * owns ctx access.
 *
 * Returns `passed` (boot healthy → restart may proceed), `failed` (abort the
 * restart), or `skipped` (canary not enabled, or binary/profile cannot be
 * derived — never blocks a restart). The temp dir is always removed and the
 * ephemeral process group always killed before returning.
 */
export async function runCanary(
  ctx: unknown,
  cfg: CanaryConfig,
  args: CanaryCall,
  hooks: CanaryHooks = defaultCanaryHooks,
): Promise<CanaryResult> {
  // Per-call `canary` param overrides the configured default for this call.
  if (!(args.canary ?? cfg.canary)) {
    return { status: 'skipped', detail: 'canary not enabled' }
  }

  // Prepare the temp state overlay FIRST so every path below can rely on the
  // finally-cleanup guarantee.
  let tmpDir: string
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'dsh-canary-'))
  } catch (err) {
    return { status: 'failed', detail: `canary tmpdir failed: ${String(err)}` }
  }
  let spawned: ChildProcess | null = null
  const stop = hooks.killProcessGroup ?? killProcessGroupDefault
  try {
    // Resolve the dsh binary/profile: explicit config wins, else the systemd
    // unit's ExecStart, else 'dsh' on PATH for the binary.
    const execStartOfUnit = hooks.execStartOfUnit ?? execStartOfUnitDefault
    const execLine = execStartOfUnit(cfg.restartUnit)
    const derived = execLine ? deriveExecStartParams(execLine) : null
    const target = resolveExecTarget(cfg, derived)
    if (!target) {
      // Derivation impossible (no systemctl lookup AND no explicit
      // binary/profile): never guess — a skip never blocks a restart.
      return { status: 'skipped', detail: 'cannot derive dsh binary/profile for canary' }
    }

    const port = cfg.canaryPort > 0 ? cfg.canaryPort : await (hooks.pickFreePort ?? pickFreePort)()
    const patchPath = join(tmpDir, 'canary.patch.yml')
    writeFileSync(patchPath, buildPatchContent(tmpDir, cfg.canaryStateDirOverrides), 'utf8')

    const preflight = (hooks.dumpConfig ?? dumpConfigDefault)(target.binary, target.profile, patchPath)
    if (!preflight.ok) {
      return { status: 'failed', detail: `dump-config failed: ${preflight.stderr}` }
    }

    spawned = (hooks.spawnBoot ?? spawnBootDefault)(target.binary, target.profile, patchPath, port)
    if (!spawned) {
      return { status: 'failed', detail: 'canary boot could not be spawned' }
    }

    const healthy = await (hooks.probeLiveness ?? probeLivenessDefault)(port, cfg.canaryTimeoutMs)
    // Always stop the ephemeral instance before returning.
    if (spawned.pid !== undefined) {
      try {
        stop(spawned.pid)
      } catch {
        // process group already gone; ignore
      }
    }
    spawned = null

    if (!healthy) {
      return {
        status: 'failed',
        detail: `canary boot did not become healthy within ${cfg.canaryTimeoutMs}ms`,
      }
    }
    return { status: 'passed', detail: `canary boot healthy on 127.0.0.1:${port}` }
  } catch (err) {
    return { status: 'failed', detail: `canary error: ${String(err)}` }
  } finally {
    if (spawned && spawned.pid !== undefined) {
      try {
        stop(spawned.pid)
      } catch {
        // process group already gone; ignore
      }
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }
}