/**
 * Optional canary pre-restart validation for the smart_restart tool.
 *
 * When enabled, before the tool persists a pending notice or spawns the real
 * `systemctl restart`, the canary boots an EPHEMERAL DSH instance from the
 * same binary as the systemd unit (derived from `systemctl show -p
 * ExecStart`), on an auto-picked free port, under a temp state overlay
 * (`dsh --patch` applied after the profile layer: this plugin disabled and
 * the listed rows' stateDir redirected into the temp dir), booted with
 * `cwd = <the temp overlay dir>` so a RELATIVE stateDir row also lands in the
 * temp store (fb-234 acceptance-1 — the ephemeral never touches the LIVE
 * stateDir), then probes HTTP
 * liveness on that port and — default ON — validates the CLIENT boot graph:
 * it parses `__DSH_BOOT__` from the served page and proves every graph row's
 * `/plugins/<id>/client.js` bundle registers that row's id (the loader
 * invariant a "loaded without registering" GUI break violates). `passed`
 * lets the restart proceed; `failed` aborts it (the caller alerts the
 * calling session from the execute closure); `skipped` (cannot derive
 * binary/profile) NEVER blocks a restart, so generic installs stay safe.
 *
 * The module is intentionally IO-thin: the pure helpers below are exported
 * for unit tests, and every spawn/fetch/systemctl call is routed through the
 * injectable `CanaryHooks` table (default `defaultCanaryHooks`), so tests run
 * without a dsh service, /opt/dsh, or systemctl.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

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
  /** false → skip the post-boot client-graph validation (default true). */
  canaryClientCheck?: boolean
  /** Whole-phase budget (ms) for the client-graph validation (default 15000). */
  canaryClientTimeoutMs?: number
  /** false → skip the post-boot AGENT-LIVENESS check (default true): every
   *  NON-RETIRED member of the deepartments catalog must appear alive in the
   *  runtime's live agent registry (the R8 liveness family, fb-143/144/145) —
   *  a restart that lands with registered heads/workers missing from the
   *  registry hangs the org. */
  canaryAgentCheck?: boolean
  /** Catalog path the liveness check reads (default '/.deepartments/posts.json'
   *  — the deepartments runtime's durable registry; '' uses the default). */
  canaryCatalogPath?: string
  /** Runtime stateDir whose durable marker files the markers check reads
   *  (default '/.deepartments'); '' uses the default. */
  canaryRuntimeStateDir?: string
  /** false → skip the post-boot POOLER-HEALTH check (default true): probes
   *  /v1/models, /usage and /__keypool/status on the ephemeral web port. A
   *  missing endpoint (HTTP 404/405) is a graceful SKIP — e.g. the fb-75
   *  pooler-capacity lane deploy was PENDING at the time of writing — never a
   *  failure; a 5xx or unreachable endpoint FAILS. */
  canaryPoolerCheck?: boolean
  /** Whole-phase budget (ms) for the pooler-health probes (default 5000). */
  canaryPoolerTimeoutMs?: number
  /** false → skip the post-boot RUNTIME-MARKERS check (default true): verifies
   *  the R8 presence cache (presence.json) and the R9 toolset-audit sidecar
   *  (toolset-audit.jsonl, fb-29/fb-35) exist and are well-formed. */
  canaryMarkersCheck?: boolean
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
  /** Pre-flight `--dump-config`; ok=false carries bounded stderr. The stdout
 *  is carried alongside (the config-integrity check reads it). */
  dumpConfig?: (binary: string, profile: string, patchPath: string) => { ok: boolean; stderr: string; stdout?: string }
  /** Boot the ephemeral instance detached; returns the child or null when spawn failed. The
   *  default MUST boot with `cwd = <the patch's dir>` (the isolated per-canary tmp overlay) so
   *  a RELATIVE stateDir row resolves inside the temp store, never the LIVE one (fb-234
   *  acceptance-1); a replacement hook must preserve that isolation. */
  spawnBoot?: (binary: string, profile: string, patchPath: string, port: number) => ChildProcess | null
  /** Poll HTTP liveness on the port until healthy or the timeout elapses. */
  probeLiveness?: (port: number, timeoutMs: number) => Promise<boolean>
  /** Fetch one HTTP resource (boot page + each client bundle); null on a network-layer failure. */
  fetchUrl?: (url: string, timeoutMs: number) => Promise<{ status: number; body: string } | null>
  /** Kill the ephemeral's process group (negative pid). */
  killProcessGroup?: (pid: number) => void
  /** Read the deepartments CATALOG (posts.json) for the agent-liveness check;
   *  null when absent/unreadable (the check then skips). Bound by runCanary to
   *  `canaryCatalogPath` (default '/.deepartments/posts.json'). */
  readCatalog?: () => string | null
  /** List the LIVE session ids of the runtime's agent registry for the
   *  agent-liveness check (the R8 live-handle signal); empty when unavailable
   *  — a registered catalog with zero live sessions then FAILS the check. */
  listLiveAgents?: () => string[]
  /** Read ONE durable runtime marker file (presence.json / toolset-audit.jsonl)
   *  for the R8/R9 markers check; null when absent/unreadable (skip). Bound by
   *  runCanary to `canaryRuntimeStateDir` (default '/.deepartments'). */
  readStateFile?: (relPath: string) => string | null
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

// --- client boot-graph validation (the P1 GUI lesson, 2026-08-29) ------------
//
// The web runtime keys every client-graph row by the LOADER ENTRY name (the
// row id == package name) and a bundle must register EXACTLY that id via
// `window.__ModuleLoader__.load({ id, factory })` — a loaded bundle that does
// not register the row id fails the client boot with "loaded without
// registering" → the "Failed to load plugins" GUI. The HTTP 200 liveness probe
// alone never saw this (the P1 regression passed the canary), so after a
// healthy boot the canary now parses `__DSH_BOOT__` out of the served page
// and proves every row satisfiable: `/plugins/<id>/client.js` must be served
// AND register the row id.

/** One row of the composed client boot graph served as `window.__DSH_BOOT__`. */
export interface ClientGraphRow {
  /** Entry name == package name; the id every client bundle must register. */
  id: string
  /** Bundle endpoint, '/plugins/<id>/client.js?rev=<rev>' (graph-relative). */
  url: string
  /** Bundle content hash (informational here). */
  rev?: string
}

export interface ClientGraphCheckResult {
  ok: boolean
  detail: string
  /** Number of rows whose bundle registered their graph id (when ok). */
  checked?: number
}

/** Default whole-phase budget for the client-graph validation. */
export const DEFAULT_CLIENT_CHECK_TIMEOUT_MS = 15_000
/** Cap on failure notes embedded in one check detail (keep alert text tight). */
const MAX_FAILURE_NOTES = 3

/**
 * Parse the `__DSH_BOOT__` client graph out of a served boot HTML document.
 *
 * The web server injects the composed graph as one head global row
 * (`<script>globalThis["__DSH_BOOT__"] = {...}</script>`), with `<` escaped
 * as `\u003c` inside the JSON so the payload can never contain a literal
 * `</script>`. Returns null when the document carries NO boot graph (a
 * non-web boot — nothing to validate). A PRESENT payload that is not a valid
 * `{rev, entries[]}` graph THROWS: a page the browser could not boot is a
 * canary failure, not a skip.
 */
export function extractBootGraph(html: string): { rev: string; entries: ClientGraphRow[] } | null {
  const m = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})<\/script>/)
  if (!m) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(m[1])
  } catch (err) {
    throw new Error(`client-graph: __DSH_BOOT__ payload is not valid JSON: ${String(err)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    throw new Error('client-graph: __DSH_BOOT__ payload has no entries array')
  }
  const entries = (parsed as { entries: unknown[] }).entries.map((row, i) => {
    if (row === null || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string' || typeof (row as { url?: unknown }).url !== 'string') {
      throw new Error(`client-graph: __DSH_BOOT__ entry ${i} is malformed (string id and url expected)`)
    }
    const r = row as { id: string; url: string; rev?: unknown }
    return { id: r.id, url: r.url, rev: typeof r.rev === 'string' ? r.rev : undefined }
  })
  const rev = (parsed as { rev?: unknown }).rev
  return { rev: typeof rev === 'string' ? rev : '', entries }
}

/**
 * Read the id a client bundle REGISTERS: the id of the first
 * `__ModuleLoader__.load({ id: "<id>", factory: ... })` envelope.
 *
 * The server-side canary can only see the served SOURCE, so it decodes the
 * envelope. Every real DSH envelope (tsdown bundles and the
 * normalize-client-banner wrapper) declares `id` as the FIRST member of the
 * load() argument, so the check parses ONLY that leading `id: "..."`
 * property — it never scans the factory body, which legitimately contains
 * braces, regex literals and template expressions a balanced scan could not
 * skip cheaply. A bundle whose envelope does not open with `id` (or has no
 * envelope at all) yields undefined → the row fails as unsatisfiable, the
 * safe direction for a restart gate.
 */
export function registeredBundleId(source: string): string | undefined {
  const marker = '__ModuleLoader__.load('
  const callIdx = source.indexOf(marker)
  if (callIdx === -1) return undefined
  const open = source.indexOf('{', callIdx + marker.length)
  if (open === -1) return undefined
  const rest = source.slice(open + 1)
  const m = rest.match(/^\s*id\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/)
  if (!m) return undefined
  return unquoteJsString(m[1])
}

function unquoteJsString(raw: string): string {
  const quote = raw.charAt(0)
  const inner = raw.slice(1, -1)
  // Registered ids are npm package names — they never contain escapes. Still
  // collapse an escaped quote/backslash as a courtesy; anything else keeps its
  // backslash so a mis-decode fails the later equality check loudly.
  return quote === '`' ? inner.replace(/\\([`\\])/g, '$1') : inner.replace(/\\(["'\\])/g, '$1')
}

/**
 * True when a served bundle REGISTERS the graph row's id — the loader
 * invariant every `/plugins/<id>/client.js` must satisfy.
 */
export function clientBundleRegistersId(bundleSource: string, rowId: string): boolean {
  return registeredBundleId(bundleSource) === rowId
}

/**
 * Post-boot client-graph validation: parse `__DSH_BOOT__` from the served
 * page and prove EVERY row satisfiable — the row's `/plugins/<id>/client.js`
 * must be served (HTTP 200) AND register the row id. A missing page, a
 * malformed graph, an unavailable (404) bundle, or a bundle registering
 * NO/another id fails the check: a boot whose GUI would hit "loaded without
 * registering" (or a 404 on fetch) must never restart past the canary.
 *
 * A boot that serves NO boot graph (non-web surface) passes — there are no
 * client rows to validate. Bounded by `timeoutMs` (whole phase; each fetch is
 * capped at 3s of the remaining budget). Runs with an injectable `fetchUrl`
 * so tests serve fixture HTML/bundles without a real dsh instance.
 */
export async function checkClientGraph(
  port: number,
  timeoutMs: number,
  fetchUrl: (url: string, timeoutMs: number) => Promise<{ status: number; body: string } | null>,
): Promise<ClientGraphCheckResult> {
  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  const remaining = (): number => deadline - Date.now()
  if (remaining() <= 0) {
    return { ok: false, detail: 'client-graph: phase timeout exceeded before the first fetch' }
  }
  const page = await fetchUrl(`${origin}/`, Math.min(3000, remaining()))
  if (!page) {
    return { ok: false, detail: 'client-graph: boot HTML unavailable (ephemeral instance unreachable after liveness)' }
  }
  if (page.status !== 200) {
    return { ok: false, detail: `client-graph: boot HTML returned HTTP ${page.status}` }
  }
  let graph: { rev: string; entries: ClientGraphRow[] } | null = null
  try {
    graph = extractBootGraph(page.body)
  } catch (err) {
    return { ok: false, detail: String(err) }
  }
  if (!graph) {
    return { ok: true, detail: 'client-graph: no __DSH_BOOT__ client graph served — nothing to validate' }
  }
  const failures: string[] = []
  let checked = 0
  for (const row of graph.entries) {
    const left = remaining()
    if (left <= 0) {
      return { ok: false, detail: `client-graph: timed out before validating all ${graph.entries.length} row(s)` }
    }
    const url = new URL(row.url, origin).href
    const res = await fetchUrl(url, Math.min(3000, left))
    if (!res) {
      failures.push(`row "${row.id}" bundle fetch failed at ${url}`)
    } else if (res.status !== 200) {
      failures.push(`row "${row.id}" bundle unavailable (HTTP ${res.status} at ${url})`)
    } else if (!clientBundleRegistersId(res.body, row.id)) {
      const got = registeredBundleId(res.body)
      failures.push(`row "${row.id}" bundle served but ${got === undefined ? 'registers no id' : `registers "${got}" instead of "${row.id}"`}`)
    } else {
      checked += 1
    }
  }
  if (failures.length > 0) {
    const notes = failures.slice(0, MAX_FAILURE_NOTES).join('; ')
    const more = failures.length > MAX_FAILURE_NOTES ? ` (and ${failures.length - MAX_FAILURE_NOTES} more)` : ''
    return { ok: false, detail: `client-graph: ${failures.length} of ${graph.entries.length} row(s) unsatisfiable — ${notes}${more}` }
  }
  return { ok: true, detail: `client-graph: ${checked} client row(s) register their graph id`, checked }
}

// --- post-boot runtime checks ("el canary se queda corto" hardening) ---------
//
// Beyond HTTP liveness + the client boot graph, the canary ALSO verifies —
// still IO-thin, still through the injectable hooks — four runtime-health
// classes a boot can silently fail:
//   (a) AGENT LIVENESS (the R8 liveness family, fb-143/144/145): every
//       NON-RETIRED member of the deepartments catalog (posts.json) must
//       appear ALIVE in the runtime's live agent registry (the same live-
//       handle signal dept_who derives `running|idle|sleeping|offline` from).
//       A restart that lands with registered heads/workers missing from the
//       registry hangs the org — exactly the "canary queda corto" class.
//   (b) POOLER HEALTH: /v1/models, /usage and /__keypool/status on the
//       ephemeral web port. A missing endpoint (HTTP 404/405) is a GRACEFUL
//       SKIP — the fb-75 pooler-capacity lane deploy was PENDING at the time
//       of writing — never a failure; a 5xx or unreachable endpoint FAILS.
//   (c) CONFIG INTEGRITY: the dump-config output (the pre-flight the repo
//       already runs) is STRUCTURALLY checked: the composed tree must be a
//       coherent entry list and the smart-restart row must NOT be enabled in
//       the canary (the patch's `enabled: false` applied) — an enabled row
//       would let the ephemeral write markers/notices into the LIVE state dir.
//   (d) RUNTIME MARKERS (R8/R9 as the runtime exposes them on disk): the R8
//       presence cache (presence.json) and the R9 toolset-audit sidecar
//       (toolset-audit.jsonl, fb-29/fb-35 result-vs-declared) must exist and
//       be well-formed. Absent files (generic install) SKIP; malformed files
//       FAIL (a broken marker writer would ship a broken org post-restart).

/** One registered catalog member (a post entry of the deepartments catalog). */
export interface CatalogMember {
  postId: string
  /** Durable session id the runtime materializes at boot; absent = broken. */
  sessionId?: string
  /** retired: true → unregistered, never counted against liveness. */
  retired?: boolean
  kind: 'head' | 'worker'
}

/**
 * Parse the deepartments catalog (posts.json) into member rows.
 *
 * The catalog is `{ [postId]: { sessionId?, retired?, role?, ... } }` — the
 * same document the runtime's registry derives the roster from. A malformed
 * document THROWS: a catalog the runtime could not load is a canary failure,
 * not a skip.
 */
export function parseCatalogMembers(raw: string): CatalogMember[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`agent-liveness: posts.json is not valid JSON: ${String(err)}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('agent-liveness: posts.json must be a JSON object keyed by postId')
  }
  const out: CatalogMember[] = []
  for (const [postId, entry] of Object.entries(data as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`agent-liveness: catalog entry "${postId}" is malformed (object expected)`)
    }
    const e = entry as { sessionId?: unknown; retired?: unknown; role?: unknown }
    const kind: CatalogMember['kind'] = typeof e.role === 'string' && e.role.length > 0 ? 'worker' : 'head'
    out.push({
      postId,
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : undefined,
      retired: e.retired === true,
      kind,
    })
  }
  return out
}

export interface AgentLivenessResult {
  ok: boolean
  detail: string
  /** Non-retired members the check accounted for (when the catalog was read). */
  checked?: number
  /** Non-retired members WITHOUT a live session id (absent when ok). */
  missing?: string[]
}

/**
 * (a) Agent-liveness check — every NON-RETIRED catalog member must appear
 * alive in the runtime's live session registry.
 *
 * `catalogRaw` null/empty (no catalog — a generic, non-deepartments install)
 * → ok with a skip note: nothing is registered, nothing to verify. A present
 * but malformed catalog FAILS. A member without a `sessionId` can never be
 * alive → it is reported missing. `liveSessionIds` is the runtime's live
 * handle signal (R8); an EMPTY registry with a NON-EMPTY catalog fails —
 * registered org members with zero live sessions is exactly the post-restart
 * hang this check exists to block.
 */
export function checkAgentLiveness(catalogRaw: string | null, liveSessionIds: readonly string[]): AgentLivenessResult {
  if (catalogRaw === null || catalogRaw.trim() === '') {
    return { ok: true, detail: 'agent-liveness: no catalog (posts.json absent) — nothing registered to verify' }
  }
  let members: CatalogMember[]
  try {
    members = parseCatalogMembers(catalogRaw)
  } catch (err) {
    return { ok: false, detail: String(err) }
  }
  const registered = members.filter((m) => !m.retired)
  if (registered.length === 0) {
    return { ok: true, detail: 'agent-liveness: catalog has no non-retired members — nothing to verify' }
  }
  const live = new Set(liveSessionIds.map(String))
  const missing = registered.filter((m) => !m.sessionId || !live.has(m.sessionId))
  if (missing.length > 0) {
    const notes = missing
      .map((m) => `${m.postId} (${m.kind}${m.sessionId ? '' : ', no sessionId'})`)
      .join(', ')
    return {
      ok: false,
      detail: `agent-liveness: ${missing.length} of ${registered.length} non-retired member(s) not alive — ${notes}`,
      checked: registered.length,
      missing: missing.map((m) => m.postId),
    }
  }
  return {
    ok: true,
    detail: `agent-liveness: all ${registered.length} non-retired member(s) alive`,
    checked: registered.length,
  }
}

/** The pooler endpoints the canary probes (the dsh-key-pooler contract). */
export const POOLER_ENDPOINTS = [
  { name: '/v1/models', path: '/v1/models' },
  { name: '/usage', path: '/usage' },
  // fb-75 — the runtime-readable status route (GET /__keypool/status, no chat
  // involved). The lane deploy was PENDING at the time of writing: a missing
  // endpoint must SKIP gracefully, never fail the canary.
  { name: '/__keypool/status', path: '/__keypool/status' },
] as const

export interface PoolerHealthResult {
  ok: boolean
  detail: string
  /** Endpoints probed and healthy (HTTP 200 + parseable JSON). */
  checked: string[]
  /** Endpoints NOT deployed (HTTP 404/405 — graceful skip, never a failure). */
  skipped: string[]
}

/**
 * (b) Pooler-health check — probe /v1/models, /usage and /__keypool/status on
 * the ephemeral web port.
 *
 * HTTP 200 + parseable JSON with the endpoint's expected shape = healthy; a
 * missing endpoint (404/405) = graceful SKIP (fb-75 deploy pending / pooler
 * not in this boot's tree); any other status, a network-layer failure, or a
 * 200 with a non-JSON body = FAIL (a broken pooler post-restart is a real
 * outage, not an absence). Bounded by `timeoutMs` (whole phase).
 */
export async function checkPoolerHealth(
  port: number,
  timeoutMs: number,
  fetchUrl: (url: string, timeoutMs: number) => Promise<{ status: number; body: string } | null>,
): Promise<PoolerHealthResult> {
  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  const checked: string[] = []
  const skipped: string[] = []
  for (const ep of POOLER_ENDPOINTS) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { ok: false, detail: `pooler: phase timeout before probing ${ep.name}`, checked, skipped }
    }
    const res = await fetchUrl(`${origin}${ep.path}`, Math.min(3000, remaining))
    if (!res) {
      return { ok: false, detail: `pooler: ${ep.name} unreachable (network error)`, checked, skipped }
    }
    if (res.status === 404 || res.status === 405) {
      skipped.push(ep.name)
      continue
    }
    if (res.status !== 200) {
      return { ok: false, detail: `pooler: ${ep.name} returned HTTP ${res.status}`, checked, skipped }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(res.body)
    } catch {
      return { ok: false, detail: `pooler: ${ep.name} returned HTTP 200 with a non-JSON body`, checked, skipped }
    }
    const obj = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    if (!obj) {
      return { ok: false, detail: `pooler: ${ep.name} JSON is not an object`, checked, skipped }
    }
    if (ep.path === '/v1/models' && !Array.isArray((parsed as { data?: unknown }).data)) {
      return { ok: false, detail: `pooler: ${ep.name} JSON has no data array`, checked, skipped }
    }
    if (ep.path === '/usage' && (parsed as { usage?: unknown }).usage === undefined) {
      return { ok: false, detail: `pooler: ${ep.name} JSON has no usage object`, checked, skipped }
    }
    checked.push(ep.name)
  }
  const parts = [
    `pooler: ${checked.length} endpoint(s) healthy${checked.length > 0 ? ` (${checked.join(', ')})` : ''}`,
  ]
  if (skipped.length > 0) {
    parts.push(`${skipped.length} endpoint(s) not deployed — graceful skip (${skipped.join(', ')})`)
  }
  if (checked.length === 0 && skipped.length === POOLER_ENDPOINTS.length) {
    return {
      ok: true,
      detail: `${parts.join('; ')} — pooler not deployed in this boot; nothing to fail`,
      checked,
      skipped,
    }
  }
  return { ok: true, detail: parts.join('; '), checked, skipped }
}

export interface DumpConfigCheckResult {
  ok: boolean
  detail: string
  /** Number of top-level rows the dump carries (when structurally parsed). */
  rows?: number
  /** The smart-restart row is present AND disabled (patch applied). */
  smartRestartDisabled?: boolean
}

/**
 * (c) Config-integrity check — verify the dump-config output is a coherent
 * composed entry list AND the smart-restart row is NOT enabled in the canary.
 *
 * The dump is the entry-list YAML the repo's dump-config produces (`- id:`
 * rows at column 0 with 2-space fields — `name:`/`config:`/`disabled:` — and
 * 4-space config keys + deeper nesting). No YAML parser ships with this repo,
 * so validity is asserted structurally (same philosophy as the
 * buildPatchContent test). `unavailable` (null/undefined — the hook did not
 * capture stdout) → ok with a skip note; a PRESENT but empty output → fail
 * (a dump that printed nothing is unusable). When the composed tree does NOT
 * contain a smart-restart row, the canary simply has nothing to disable → ok
 * with a note. A PRESENT row that is ENABLED (the patch did not apply) FAILS:
 * the ephemeral would run smart-restart against the LIVE state dir and write
 * markers/notices into it — the exact leak the patch exists to prevent.
 */
export function checkDumpConfigCoherent(dumpYaml: string | null | undefined): DumpConfigCheckResult {
  if (dumpYaml === null || dumpYaml === undefined) {
    return { ok: true, detail: 'dump-config: stdout not captured — coherence check skipped' }
  }
  if (dumpYaml.trim() === '') {
    return { ok: false, detail: 'dump-config: empty output — the composed tree is unusable' }
  }
  const lines = dumpYaml.trimEnd().split('\n')
  const body: { line: string; row?: string; depth?: number }[] = []
  let currentRow: string | undefined
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') continue // blank lines are noise (incl. inside block scalars)
    if (line.trimStart().startsWith('#')) continue
    if (/^- id: \S+/.test(line)) {
      currentRow = line.replace(/^- id: /, '').trim()
      body.push({ line, row: currentRow })
      continue
    }
    const depth = line.match(/^( *)\S/)?.[1].length ?? -1
    body.push({ line, row: currentRow, depth })
  }
  const rows = body.filter((b) => b.row !== undefined && /^- id: /.test(b.line))
  if (rows.length === 0) {
    return { ok: false, detail: 'dump-config: output has no top-level `- id:` rows — not an entry list' }
  }
  // Structural sanity: every non-row, non-comment line inside a row must be
  // INDENTED (>= 2 spaces) — the entry-list family allows arbitrary deep
  // config nesting (e.g. `org.departments[].workspacePath`), so only a
  // column-0 line inside a block is structurally broken.
  for (const b of body) {
    if (b.row === undefined) continue
    if (/^- id: /.test(b.line)) continue
    if (b.depth !== undefined && b.depth < 2) {
      return {
        ok: false,
        detail: `dump-config: unexpected column-0 line inside row "${b.row}": ${b.line.slice(0, 60)}`,
      }
    }
  }
  const srRow = rows.find((b) => b.row === 'smart-restart')
  if (!srRow) {
    return {
      ok: true,
      detail: `dump-config: ${rows.length} row(s) coherent; no smart-restart row in the canary tree (nothing to disable)`,
      rows: rows.length,
      smartRestartDisabled: false,
    }
  }
  // The smart-restart row block: collect its body until the next `- id:` row.
  const start = body.indexOf(srRow)
  const block: string[] = []
  for (let i = start + 1; i < body.length; i++) {
    if (/^- id: /.test(body[i].line)) break
    block.push(body[i].line)
  }
  const disabled = block.includes('  disabled: true') || block.some((l) => /^    enabled:\s*false/.test(l))
  if (!disabled) {
    return {
      ok: false,
      detail: `dump-config: ${rows.length} row(s) parsed but the smart-restart row is NOT disabled in the canary (patch not applied) — the ephemeral would write live state`,
      rows: rows.length,
      smartRestartDisabled: false,
    }
  }
  return {
    ok: true,
    detail: `dump-config: ${rows.length} row(s) coherent; smart-restart row disabled in the canary (patch applied)`,
    rows: rows.length,
    smartRestartDisabled: true,
  }
}

/** R8/R9 runtime marker files the markers check reads from the stateDir. */
export const RUNTIME_MARKER_FILES = ['presence.json', 'toolset-audit.jsonl'] as const

export interface RuntimeMarkersResult {
  ok: boolean
  detail: string
  /** Per-file verdict: 'ok' (present + well-formed), 'skipped' (absent). */
  presence?: 'ok' | 'skipped'
  audit?: 'ok' | 'skipped'
}

/**
 * (d) R8/R9 runtime-marker check — the markers the deepartments runtime
 * exposes on disk must exist and be well-formed.
 *
 * - R8 (fb-143/144/145 liveness family): `presence.json` — the presence
 *   cache (`{ present, updatedAt }`). Absent → skip (generic install);
 *   present but unparseable → FAIL (a broken presence cache would mislead the
 *   org's presence signal post-restart).
 * - R9 (fb-29/fb-35 toolset-audit): `toolset-audit.jsonl` — the append-only
 *   result-vs-declared sidecar. Absent → skip; present → every row must be
 *   JSON-parseable (a single truncated TRAILING row — the file is appended
 *   concurrently — is tolerated; a malformed FIRST row or any non-tail
 *   malformed row FAILS).
 * Freshness is reported but NOT enforced (a long-idle org legitimately has an
 * old tail); only malformation or absence-of-data-when-present is fatal.
 */
export function checkRuntimeMarkers(
  presenceRaw: string | null,
  auditRaw: string | null,
  now = Date.now(),
): RuntimeMarkersResult {
  const parts: string[] = []
  const out: RuntimeMarkersResult = { ok: true, detail: '' }
  if (presenceRaw === null) {
    out.presence = 'skipped'
    parts.push('presence.json absent (skip)')
  } else {
    try {
      const p = JSON.parse(presenceRaw) as { present?: unknown; updatedAt?: unknown }
      if (p === null || typeof p !== 'object' || typeof p.present !== 'boolean' || typeof p.updatedAt !== 'number') {
        return { ok: false, detail: 'markers: presence.json is present but malformed (present:boolean + updatedAt:number expected)', presence: 'ok' }
      }
      const ageMs = now - p.updatedAt
      out.presence = 'ok'
      parts.push(`presence.json ok (${ageMs >= 0 ? `${Math.round(ageMs / 1000)}s` : 'future'} old)`)
    } catch {
      return { ok: false, detail: 'markers: presence.json is present but not valid JSON', presence: 'ok' }
    }
  }
  if (auditRaw === null) {
    out.audit = 'skipped'
    parts.push('toolset-audit.jsonl absent (skip)')
  } else {
    const rows = auditRaw.split('\n').filter((l) => l.trim() !== '')
    if (rows.length === 0) {
      out.audit = 'ok'
      parts.push('toolset-audit.jsonl present and empty (no spawns yet — benign)')
    } else {
      const parsedRows: unknown[] = []
      let malformedIndex = -1
      for (let i = 0; i < rows.length; i++) {
        try {
          parsedRows.push(JSON.parse(rows[i]))
        } catch {
          if (malformedIndex === -1) malformedIndex = i
        }
      }
      if (malformedIndex !== -1 && malformedIndex !== rows.length - 1) {
        return {
          ok: false,
          detail: `markers: toolset-audit.jsonl has malformed row ${malformedIndex + 1} of ${rows.length} (only a truncated trailing row is tolerated)`,
          audit: 'ok',
        }
      }
      out.audit = 'ok'
      const last = rows[rows.length - 1]
      let lastTs: number | undefined
      try {
        lastTs = (JSON.parse(last) as { ts?: unknown }).ts as number | undefined
      } catch {
        // tolerated truncated trailing row — no timestamp to report
      }
      const age = typeof lastTs === 'number' ? `${Math.max(0, Math.round((now - lastTs) / 1000))}s` : 'n/a'
      parts.push(`toolset-audit.jsonl ok (${rows.length} row(s), last ts ${age} old)`)
    }
  }
  out.detail = parts.join('; ')
  return out
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

function dumpConfigDefault(binary: string, profile: string, patchPath: string): { ok: boolean; stderr: string; stdout?: string } {
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
    // The stdout (the composed entry-list YAML) is carried for the
    // config-integrity check (checkDumpConfigCoherent).
    return { ok: true, stderr: '', stdout: String(r.stdout ?? '') }
  } catch (err) {
    return { ok: false, stderr: String(err).slice(0, 500) }
  }
}

function spawnBootDefault(binary: string, profile: string, patchPath: string, port: number): ChildProcess | null {
  const argv = [binary]
  if (profile) argv.push('--profile', profile)
  argv.push('--patch', patchPath, '--port', String(port))
  try {
    // FB-234 acceptance-1: boot the ephemeral with ITS OWN cwd = the isolated
    // per-canary temp overlay dir (the dir that also holds the patch file —
    // runCanary always writes the patch at `<tmpDir>/canary.patch.yml`, and
    // removes the whole tmpDir in its finally). Without a cwd the child
    // inherits the daemon's cwd (/ under systemd) and a RELATIVE stateDir row
    // (the dev profile's `.deepartments` from dshd-core) resolves against the
    // LIVE `/.deepartments` — the phantom-boot defect: the ephemeral apply
    // stamped LIVE boot-crash.json with its own bootId and consumed the LIVE
    // restart-reason marker, so the real boot lost its 'canary' excusal.
    // With cwd = tmpDir the relative `.deepartments` resolves inside the temp
    // store: 0 consume of the LIVE marker, 0 stamp of LIVE boot-crash.json, 0
    // LIVE heartbeat from the canary (the ephemeral dies with its tmpDir).
    const child = spawn('setsid', argv, { detached: true, stdio: 'ignore', cwd: dirname(patchPath) })
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

async function fetchUrlDefault(url: string, timeoutMs: number): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await res.text()
    return { status: res.status, body }
  } catch {
    return null // refused / aborted / body read failed
  }
}

function killProcessGroupDefault(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // process group already gone; ignore
  }
}

/** The deepartments catalog the agent-liveness check reads (R8 liveness). */
export const DEFAULT_CATALOG_PATH = '/.deepartments/posts.json'
/** The runtime stateDir whose R8/R9 marker files the markers check reads. */
export const DEFAULT_RUNTIME_STATE_DIR = '/.deepartments'

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null // ENOENT / unreadable — the caller skips
  }
}

/** Default catalog reader: `canaryCatalogPath` (or the deepartments default). */
export function readCatalogDefault(cfg: Pick<CanaryConfig, 'canaryCatalogPath'>): string | null {
  return readFileSafe(cfg.canaryCatalogPath || DEFAULT_CATALOG_PATH)
}

/**
 * Default live-session reader: the runtime's OWN agent registry (ctx.agents —
 * the same in-process registry the R8/driver live-handle signal derives
 * from). Unavailable (no agents service) → [] — a non-empty catalog then
 * FAILS the agent-liveness check, which is the safe direction for a restart
 * gate when the runtime cannot show its members alive.
 */
export function listLiveAgentsDefault(ctx: unknown): string[] {
  try {
    const c = ctx as { agents?: { list?: () => Array<{ id: unknown }> } }
    const list = c?.agents?.list
    if (typeof list !== 'function') return []
    const agents = list.call(c.agents)
    if (!Array.isArray(agents)) return []
    return agents.map((a) => String(a.id))
  } catch {
    return []
  }
}

/** Default runtime-marker reader: `<canaryRuntimeStateDir>/<relPath>`. */
export function readStateFileDefault(relPath: string, stateDir: string): string | null {
  return readFileSafe(join(stateDir || DEFAULT_RUNTIME_STATE_DIR, relPath))
}

export const defaultCanaryHooks: CanaryHooks = {
  execStartOfUnit: execStartOfUnitDefault,
  pickFreePort,
  dumpConfig: dumpConfigDefault,
  spawnBoot: spawnBootDefault,
  probeLiveness: probeLivenessDefault,
  fetchUrl: fetchUrlDefault,
  killProcessGroup: killProcessGroupDefault,
  // The post-boot runtime checks read through these; runCanary BINDS them to
  // the effective config (paths) and ctx (the live registry) per call.
  readCatalog: () => readFileSafe(DEFAULT_CATALOG_PATH),
  listLiveAgents: () => listLiveAgentsDefault(undefined),
  readStateFile: (relPath) => readFileSafe(join(DEFAULT_RUNTIME_STATE_DIR, relPath)),
}

/**
 * Post-boot runtime checks (the "canary se queda corto" hardening) — run
 * AFTER liveness + client-graph with the ephemeral still up:
 *
 *   1. AGENT LIVENESS (a) — every NON-RETIRED member of the deepartments
 *      catalog (posts.json) must appear alive in the runtime's live agent
 *      registry (the R8 live-handle family). The catalog is read through the
 *      injectable hook (default: the LIVE '/.deepartments/posts.json' the
 *      real boot will consume); the live ids through the injectable
 *      registry listing (default: ctx.agents). Absent catalog → skip.
 *   2. POOLER HEALTH (b) — /v1/models, /usage and /__keypool/status on the
 *      ephemeral web port. A missing endpoint (HTTP 404/405 — e.g. the fb-75
 *      pooler-capacity lane deploy PENDING) skips gracefully; a 5xx or an
 *      unreachable endpoint fails.
 *   3. RUNTIME MARKERS (d) — the R8 presence cache (presence.json) and the
 *      R9 toolset-audit sidecar (toolset-audit.jsonl) must exist and be
 *      well-formed. Absent files (generic install) skip; malformed files fail.
 *
 * Each check is individually opt-out-able via its config flag (default ON).
 * The first failing check returns {ok:false, detail} (the caller stops the
 * ephemeral); otherwise the individual details aggregate into one line.
 */
export async function runPostBootRuntimeChecks(
  cfg: CanaryConfig,
  ctx: unknown,
  port: number,
  hooks: CanaryHooks = defaultCanaryHooks,
): Promise<{ ok: boolean; detail: string }> {
  const parts: string[] = []
  // (a) Agent liveness — R8 liveness family.
  if (cfg.canaryAgentCheck !== false) {
    const readCatalog = hooks.readCatalog ?? (() => readFileSafe(cfg.canaryCatalogPath || DEFAULT_CATALOG_PATH))
    const listLiveAgents = hooks.listLiveAgents ?? (() => listLiveAgentsDefault(ctx))
    const liveness = checkAgentLiveness(readCatalog(), listLiveAgents())
    if (!liveness.ok) return { ok: false, detail: liveness.detail }
    parts.push(liveness.detail)
  } else {
    parts.push('agent-liveness check disabled (config)')
  }
  // (b) Pooler health — on the ephemeral web port, exactly where the
  //     post-restart process would serve these routes.
  if (cfg.canaryPoolerCheck !== false) {
    const pooler = await checkPoolerHealth(port, cfg.canaryPoolerTimeoutMs ?? 5000, hooks.fetchUrl ?? fetchUrlDefault)
    if (!pooler.ok) return { ok: false, detail: pooler.detail }
    parts.push(pooler.detail)
  } else {
    parts.push('pooler-health check disabled (config)')
  }
  // (d) R8/R9 runtime markers.
  if (cfg.canaryMarkersCheck !== false) {
    const stateDir = cfg.canaryRuntimeStateDir || DEFAULT_RUNTIME_STATE_DIR
    const readStateFile = hooks.readStateFile ?? ((rel: string) => readFileSafe(join(stateDir, rel)))
    const markers = checkRuntimeMarkers(readStateFile('presence.json'), readStateFile('toolset-audit.jsonl'))
    if (!markers.ok) return { ok: false, detail: markers.detail }
    parts.push(markers.detail)
  } else {
    parts.push('runtime-markers check disabled (config)')
  }
  return { ok: true, detail: parts.join('; ') }
}

/**
 * Run the canary pre-restart validation.
 *
 * `ctx` (the cordis Context) feeds the agent-liveness check's live-registry
 * listing (default hook: ctx.agents — the same in-process registry the R8
 * live-handle signal derives from). The calling session is never touched
 * here: a failed canary is alerted by the caller (execute closure), which
 * owns ctx access.
 *
 * Returns `passed` (boot healthy AND, when enabled, every client-graph row
 * satisfiable AND every runtime check green → restart may proceed), `failed`
 * (abort the restart), or `skipped` (canary not enabled, or binary/profile
 * cannot be derived — never blocks a restart). The temp dir is always removed
 * and the ephemeral process group always killed before returning.
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
  // Stop the ephemeral instance and return a failed result — the shared
  // abort path for every post-boot failure (liveness, graph, runtime checks).
  const abort = (detail: string): CanaryResult => {
    if (spawned && spawned.pid !== undefined) {
      try {
        stop(spawned.pid)
      } catch {
        // process group already gone; ignore
      }
    }
    spawned = null
    return { status: 'failed', detail }
  }
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
    // ── Config integrity (c): the dump the pre-flight already produced must
    //    be a coherent composed entry list AND the smart-restart row must be
    //    DISABLED in the canary (the patch's `enabled: false` applied) — an
    //    enabled row would let the ephemeral write markers/notices into the
    //    LIVE state dir. A hook that did not capture stdout skips this check.
    const coherent = checkDumpConfigCoherent(preflight.stdout)
    if (!coherent.ok) {
      return { status: 'failed', detail: `dump-config integrity failed: ${coherent.detail}` }
    }

    spawned = (hooks.spawnBoot ?? spawnBootDefault)(target.binary, target.profile, patchPath, port)
    if (!spawned) {
      return { status: 'failed', detail: 'canary boot could not be spawned' }
    }

    const healthy = await (hooks.probeLiveness ?? probeLivenessDefault)(port, cfg.canaryTimeoutMs)
    if (!healthy) {
      // Always stop the ephemeral instance before returning.
      if (spawned.pid !== undefined) {
        try {
          stop(spawned.pid)
        } catch {
          // process group already gone; ignore
        }
      }
      spawned = null
      return {
        status: 'failed',
        detail: `canary boot did not become healthy within ${cfg.canaryTimeoutMs}ms`,
      }
    }

    // ── Post-boot client-graph validation (default ON, keeps the ephemeral
    //    alive until it finishes). The HTTP 200 probe alone let the P1 GUI
    //    regression — a client row whose served bundle never registers its
    //    graph id — pass the canary; re-validate the client boot graph now
    //    that the instance is up, exactly as the browser would consume it.
    let detail = `canary boot healthy on 127.0.0.1:${port}`
    if (cfg.canaryClientCheck === undefined || cfg.canaryClientCheck) {
      const graphCheck = await checkClientGraph(
        port,
        cfg.canaryClientTimeoutMs ?? DEFAULT_CLIENT_CHECK_TIMEOUT_MS,
        hooks.fetchUrl ?? fetchUrlDefault,
      )
      if (!graphCheck.ok) {
        // Always stop the ephemeral instance before returning.
        if (spawned.pid !== undefined) {
          try {
            stop(spawned.pid)
          } catch {
            // process group already gone; ignore
          }
        }
        spawned = null
        return { status: 'failed', detail: graphCheck.detail }
      }
      detail = `${detail}; ${graphCheck.detail}`
    }

    // ── Post-boot runtime checks (the "canary se queda corto" hardening):
    //    agent liveness (R8), pooler health (graceful when an endpoint is not
    //    deployed) and the R8/R9 runtime markers — each individually
    //    opt-out-able via its config flag (default ON). A failure in ANY of
    //    them aborts the restart, stopping the ephemeral first.
    const runtimeChecks = await runPostBootRuntimeChecks(cfg, ctx, port, hooks)
    if (!runtimeChecks.ok) return abort(runtimeChecks.detail)
    detail = `${detail}; ${runtimeChecks.detail}`

    // Always stop the ephemeral instance before returning.
    if (spawned.pid !== undefined) {
      try {
        stop(spawned.pid)
      } catch {
        // process group already gone; ignore
      }
    }
    spawned = null
    return { status: 'passed', detail }
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