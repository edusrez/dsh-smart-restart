/**
 * dsh-smart-restart — wake the main agent when the DSH service restarts.
 *
 * On every boot the plugin persists a marker (lastBootAt + pid) under its
 * state dir in the DSH home. If a prior marker exists with a DIFFERENT pid,
 * this process is a restart, and the plugin wakes the target agent with a
 * "notice" so it can resume interrupted work without waiting for the user.
 *
 * Delivery happens once per boot:
 *  - primarily from the `agent/session-start` event (registered early in
 *    apply). A pinned session is source-agnostic: a session that RESUMES from a
 *    previous process publishes with `source 'resume'`, not `'startup'`, so the
 *    pinned path matches regardless of source; the `source === 'startup'` gate
 *    applies only to the non-pinned `config.target` path.
 *  - via a bounded retry interval (750ms, capped ~15s) that polls for a pinned
 *    session which resumes lazily late, and does a one-shot `target` fallback
 *    for the ordering edge where the startup event never surfaces.
 *
 * The marker is intentionally durable (it must survive the restart it
 * documents) — a deliberate, documented exception to the "reversible effects"
 * rule. Every listener and timer is reversible via ctx.effect / ctx.on.
 */
import type { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
// Loads the cordis event-module augmentation (agent/* events) from dsh-agent.
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  activeAgentGuard,
  buildNotice,
  detectRestart,
  ignoredByPrefix,
  interruptedHeads,
  parseCgroupUnit,
  parsePendingNotice,
  parseShutdownNotice,
  selectsAgent,
  shutdownTarget,
  type BootMarker,
  type ShutdownNotice,
  type ShutdownSession,
  type SmartRestartParams,
  type SmartRestartResult,
} from './boot.js'
import { DEFAULT_RUNTIME_STATE_DIR, runCanary, type CanaryResult } from './canary.js'
// FB-234 — the INTENTIONAL-RESTART MARKER WRITER (see src/restart-reason.ts):
// the GRACE-route selector, the boot-crash bootId anchor read and the atomic
// tmp+rename write/clear the smart_restart tool performs BEFORE every kill.
import {
  clearRestartReasonMarker,
  readCurrentBootId,
  resolveRestartCause,
  writeRestartReasonMarker,
} from './restart-reason.js'

/**
 * smart_restart call extended with the optional per-call canary gate.
 * The canary fields live here (not in boot.ts) because they are tool-only;
 * boot.ts stays the pure, IO-free module.
 */
export interface SmartRestartCall extends SmartRestartParams {
  /** Run the canary pre-restart validation for THIS call; overrides config.canary. */
  canary?: boolean
  /** FB-234 — the INTENTIONAL restart family for THIS call, a token from the
   * sanctioned GRACE set ['canary','deploy','dshmarket']: the tool then writes
   * `<runtimeStateDir>/restart-reason.json` ATOMICALLY BEFORE the kill, so the
   * next boot's boot-crash sidecar treats the previous boot as intentionally
   * restarted (the crash streak never rises over it) and records the cause
   * verbatim. ABSENT → the cause derives from the canary gate ('canary' when
   * the gate ran), else NO marker (current crash semantics); a cause OUTSIDE
   * the set is treated the same (no marker). */
  cause?: string
  /** Explicit override of the read-before-edit guard (fb-168): restart even
   *  when OTHER sessions are mid-turn. Without it the tool refuses and returns
   *  the in-flight session list; the override is ALWAYS visible in the log. */
  force?: boolean
}

/** smart_restart result extended with the canary outcome. */
export interface SmartRestartOutcome extends SmartRestartResult {
  /** Canary gate outcome: 'skipped' | 'passed' | 'failed' (absent when no canary ran). */
  canary?: 'skipped' | 'passed' | 'failed'
  /** Human detail for a skipped/failed canary outcome. */
  canaryDetail?: string
  /** Other sessions that were mid-turn when a guard-blocked restart was
   *  refused (absent when the restart proceeded / nothing was in flight). */
  inFlight?: string[]
}

export interface Config {
  enabled: boolean
  stateDir: string
  target: string
  wakeup: boolean
  notice: string
  restartUnit: string
  toolEnabled: boolean
  /** Grace window (ms) before shutdown within which last agent activity counts
   *  as "agent-involved" for the smart shutdown auto-notification. */
  shutdownGraceMs: number
  /** Session id prefixes that must NEVER be selected as the single-session
   *  "last active" PIN for the smart-shutdown auto-notification. Deepartments
   *  department heads are first-class root agents with ids `head-<postId>`,
   *  and a head must never receive a spurious pinned notice (the 0.3.1
   *  regression), so `head-` is ignored by default. Since fb-168 the SAME
   *  prefixes identify the interrupted-HEAD resume recipients: a head whose
   *  turn was genuinely cut by the restart still receives its own resume
   *  notice at boot (never a pin). Configure this to add/remove patterns. */
  ignoredSessionPrefixes: string[]
  /** Opt-in canary pre-restart validation: boot an ephemeral DSH instance and
   *  abort the restart when it fails (see src/canary.ts). The per-call
   *  `canary` tool parameter overrides this for one call. */
  canary: boolean
  /** Hard cap (ms) for the canary boot liveness probe (default 45s); a timeout
   *  is a canary failure and aborts the restart. */
  canaryTimeoutMs: number
  /** HTTP port for the ephemeral canary instance; 0 = auto-pick a free port. */
  canaryPort: number
  /** Explicit dsh profile for the canary launch; '' = derive from the unit's
   *  ExecStart (`--profile`). */
  canaryProfile: string
  /** Explicit dsh binary for the canary launch; '' = derive from the unit's
   *  ExecStart, else `dsh` on PATH. */
  canaryBinary: string
  /** Plugin-row id → temp dir: those rows get their stateDir redirected in
   *  the canary patch, so the ephemeral never writes live board/marker state.
   *  Relative or empty values resolve under the canary temp dir; absolute
   *  values are used verbatim. */
  canaryStateDirOverrides: Record<string, string>
  /** Post-boot client-graph validation for the canary (default true): after
   *  the HTTP liveness probe, the canary parses `__DSH_BOOT__` from the
   *  served page and verifies every client-graph row's
   *  `/plugins/<id>/client.js` bundle registers that row's id — the loader
   *  invariant a "loaded without registering" GUI break violates. A boot
   *  that serves no `__DSH_BOOT__` (non-web surface) passes trivially. */
  canaryClientCheck: boolean
  /** Whole-phase budget (ms) for the canary's client-graph validation
   *  (default 15000). */
  canaryClientTimeoutMs: number
  /** Post-boot AGENT-LIVENESS check (default true): every non-retired member
   *  of the deepartments catalog (posts.json) must appear alive in the
   *  runtime's live agent registry (the R8 liveness family) before the
   *  restart proceeds. */
  canaryAgentCheck: boolean
  /** Catalog path the agent-liveness check reads (default
   *  '/.deepartments/posts.json' — the deepartments runtime's durable
   *  registry). */
  canaryCatalogPath: string
  /** Runtime stateDir whose R8/R9 marker files the markers check reads
   *  (default '/.deepartments'). */
  canaryRuntimeStateDir: string
  /** Post-boot POOLER-HEALTH check (default true): probes /v1/models,
   *  /usage and /__keypool/status on the ephemeral web port. A missing
   *  endpoint (HTTP 404/405 — e.g. the fb-75 pooler-capacity lane deploy
   *  PENDING) is a graceful skip, never a failure. */
  canaryPoolerCheck: boolean
  /** Whole-phase budget (ms) for the pooler-health probes (default 5000). */
  canaryPoolerTimeoutMs: number
  /** Post-boot RUNTIME-MARKERS check (default true): the R8 presence cache
   *  (presence.json) and the R9 toolset-audit sidecar (toolset-audit.jsonl)
   *  must exist and be well-formed. */
  canaryMarkersCheck: boolean
}

const DEFAULTS: Config = {
  enabled: true,
  stateDir: '.smart-restart',
  target: 'primary',
  wakeup: true,
  notice: '',
  restartUnit: '',
  toolEnabled: true,
  shutdownGraceMs: 600_000, // 10 minutes
  // Deepartments convention: heads are root agents with session id `head-<postId>`.
  ignoredSessionPrefixes: ['head-'],
  // Optional canary gate: off by default; opt in per profile and/or per call.
  canary: false,
  canaryTimeoutMs: 45_000,
  canaryPort: 0,
  canaryProfile: '',
  canaryBinary: '',
  canaryStateDirOverrides: {},
  // Client-graph post-boot validation is ON by default once the canary runs.
  canaryClientCheck: true,
  canaryClientTimeoutMs: 15_000,
  // The post-boot runtime hardening (agent liveness / pooler health / R8-R9
  // markers) is ON by default once the canary runs.
  canaryAgentCheck: true,
  canaryCatalogPath: '/.deepartments/posts.json',
  canaryRuntimeStateDir: '/.deepartments',
  canaryPoolerCheck: true,
  canaryPoolerTimeoutMs: 5_000,
  canaryMarkersCheck: true,
}

/** Fallback poll interval while waiting for a pinned session to resume. */
const PENDING_POLL_MS = 750
/** Hard cap on how long the fallback keeps waiting for a pinned session. */
const PENDING_POLL_MAX_MS = 15000

/** A single systemd unit token — rejects spaces/slashes to avoid shell injection. */
const UNIT_TOKEN_RE = /^[A-Za-z0-9_.@-]+$/

export const name = 'smart-restart'
export const inject = ['agents', 'sessions', 'tools']

/**
 * Whether a signal handler may re-raise its signal after running: true only
 * when THIS handler is the last one registered for that signal (bare Node:
 * dev/CLI runs), so the re-raise triggers Node's default termination action
 * (exit 143 SIGTERM / 130 SIGINT). With ANY other listener present (real
 * host: the core bootstrap's SIGTERM/SIGINT handler), the plugin steps aside
 * and lets the other listener complete the graceful shutdown
 * (fiber.dispose() → write-behind flush-all, 5s budget) — re-raising there
 * would hit the bootstrap's interrupt() with a dispose already pending and
 * force-exit mid-flush (RD #483). The count is taken BEFORE this handler
 * removes itself, so `<= 1` means "no other listener". Exported so the
 * signal regression tests (test/signal.test.js) exercise the real decision
 * against the live process listener table.
 */
export function shouldReRaiseSignal(signal: NodeJS.Signals): boolean {
  return process.listenerCount(signal) <= 1
}

const moduleRequire = createRequire(import.meta.url)

/** Best-effort DSH version; never lets a resolution failure crash the host. */
function discoverDshVersion(): string | undefined {
  try {
    const pkg = moduleRequire('@deepseek-ai/dsh/package.json') as { version?: string }
    return pkg?.version
  } catch {
    return undefined
  }
}

/**
 * Resolve the systemd unit the smart_restart tool should restart.
 *
 * An explicit `restartUnit` always wins. When it is empty, auto-detect this
 * process's OWN systemd unit from `/proc/self/cgroup` (v0.5.0), so the tool
 * (and the canary's ExecStart derivation via the effective restartUnit) work
 * with ZERO config on a systemd-managed DSH install. A process with no
 * readable/detectable unit (e.g. a bare non-systemd process) keeps the
 * existing fail-safe: an empty unit → the tool guard rejects with
 * 'restartUnit not configured'.
 */
function resolveRestartUnit(restartUnit: string): string {
  if (restartUnit) return restartUnit
  try {
    const text = readFileSync('/proc/self/cgroup', 'utf8')
    const unit = parseCgroupUnit(text)
    if (unit) {
      console.log(`[smart-restart] restartUnit auto-detected: ${unit}`)
      return unit
    }
  } catch {
    // /proc/self/cgroup unreadable — not running under a detectable systemd
    // unit; the empty unit falls through to the existing fail-safe.
  }
  return ''
}

export function apply(ctx: Context, cfg: Partial<Config> = {}) {
  const config: Config = { ...DEFAULTS, ...cfg }
  if (!config.enabled) return

  // The unit the smart_restart tool (and its canary) should restart: explicit
  // config wins; empty → auto-detected from /proc/self/cgroup (v0.5.0).
  const effectiveRestartUnit = resolveRestartUnit(config.restartUnit)

  // --- 1. Read the previous marker (tolerate missing / corrupt). ----------
  const markerDir = join(resolveDshHome(), config.stateDir)
  const markerPath = join(markerDir, 'marker.json')

  let marker: BootMarker | null = null
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<BootMarker>
    if (
      raw &&
      typeof raw.lastBootAt === 'string' &&
      typeof raw.pid === 'number'
    ) {
      marker = raw as BootMarker
    }
  } catch {
    marker = null // missing file or corrupt JSON -> treat as first boot
  }

  const bootAt = new Date().toISOString()
  const { wasRestart, downtimeMs } = detectRestart(marker, Date.now(), process.pid)
  const prevBootAt = marker?.lastBootAt

  // --- 2. Persist the new marker immediately (intentionally durable). -----
  try {
    const nextMarker: BootMarker = {
      lastBootAt: bootAt,
      pid: process.pid,
      dshVersion: discoverDshVersion(),
    }
    mkdirSync(markerDir, { recursive: true })
    writeFileSync(markerPath, JSON.stringify(nextMarker, null, 2))
  } catch (err) {
    console.warn('[smart-restart] could not write marker:', err)
  }

  // --- 2b. Pinned delivery target from a pending notice (tool-caller wins). --
  // If the smart_restart tool left a pending-notice.json before the previous
  // restart, THIS boot must return the notice to that exact session. The file
  // is consumed (deleted) once read: the marker still proves the restart, so
  // the fallback `target` path remains available if the pinned session never
  // resumes.
  let pinnedTarget: string | undefined
  let pinnedReason: string | undefined
  const pendingPath = join(markerDir, 'pending-notice.json')
  try {
    const pending = parsePendingNotice(readFileSync(pendingPath, 'utf8'))
    if (pending) {
      pinnedTarget = pending.sessionId
      pinnedReason = pending.reason
      console.log('[smart-restart] pinned restart notice to session', pinnedTarget)
    }
  } catch {
    // no readable pending notice -> nothing to pin
  }
  try {
    unlinkSync(pendingPath)
  } catch {
    // file absent or already removed; fine
  }

  // --- 2c. Smart shutdown auto-detection (second-priority pin) + ----------
  //          interrupted-session list + interrupted-head resume recipients.
  // If NO pending notice exists (the restart was NOT triggered via the
  // smart_restart tool — e.g. a plain `systemctl restart` executed by the
  // agent, or while an agent was active), the SIGTERM/SIGINT handler persisted
  // a shutdown-notice.json recording the sessions active within the grace
  // window. Pin delivery to the last-active session ONLY if it was active within
  // `shutdownGraceMs` of shutdown (recent activity ⇒ the user restarted while
  // the agent was mid-task, so auto-notify). If it was idle well before
  // shutdown, `shutdownTarget` returns null and we fall back to the existing
  // `target`. The `sessions` list — the FULL interrupted set, heads included
  // (fb-168) — is captured so the post-restart notice can list EVERY session
  // interrupted by the shutdown, and so the interrupted HEADS can each receive
  // an automatic resume notice when they come live (fb-46: the organization
  // must never hang idle post-restart without knowing). The file is consumed
  // (unlinked) so it cannot linger and pin a future boot; the marker still
  // proves the restart.
  const shutdownPath = join(markerDir, 'shutdown-notice.json')
  let interruptedSessions: ShutdownSession[] = []
  let interruptedHeadsList: string[] = []
  let shutdownNotice: ShutdownNotice | null = null
  try {
    shutdownNotice = parseShutdownNotice(readFileSync(shutdownPath, 'utf8'))
  } catch {
    // no readable shutdown notice -> nothing to pin, no interrupted list
  }
  if (shutdownNotice?.sessions?.length) {
    interruptedSessions = shutdownNotice.sessions.filter(
      ({ id }) => !ignoredByPrefix(id, config.ignoredSessionPrefixes),
    )
    // The interrupted HEADS are the automatic resume-notify recipients. Heads
    // are still NEVER pinned (the pin derivation + the boot-side pin guard
    // below both keep ignoring them); only a head whose turn was genuinely cut
    // by the restart gets a resume notice once it comes live.
    interruptedHeadsList = interruptedHeads(
      shutdownNotice.sessions,
      config.ignoredSessionPrefixes,
    )
    console.log(
      '[smart-restart] interrupted sessions at shutdown:',
      interruptedSessions.map((s) => s.id).join(', '),
    )
    if (interruptedHeadsList.length > 0) {
      console.log('[smart-restart] interrupted heads (resume recipients):', interruptedHeadsList.join(', '))
    }
  }
  if (!pinnedTarget && shutdownNotice) {
    const target = shutdownTarget(shutdownNotice, Date.now(), config.shutdownGraceMs)
    // Defense-in-depth: even if a stale (pre-0.3.1) shutdown-notice.json
    // recorded a deepartments head as last-active, never pin a notice to an
    // ignored session.
    if (target && !ignoredByPrefix(target, config.ignoredSessionPrefixes)) {
      pinnedTarget = target
      pinnedReason = 'the process was stopped while this session was active'
      console.log('[smart-restart] pinned restart notice to last-active session', pinnedTarget)
    }
  }
  try {
    unlinkSync(shutdownPath)
  } catch {
    // file absent or already removed; fine
  }

  // --- 3. Delivery plumbing (all state is apply-scoped; nothing global). ---
  const deliveredIds = new Set<string>()
  let deliveredPrimary = false
  let deliveredAny = false
  // Automatic resume notices to interrupted heads (fb-168) are tracked
  // SEPARATELY: delivering to a head must never mark the MAIN once-per-boot
  // notice as delivered (the pin/target delivery stays independent).
  const headResumeDelivered = new Set<string>()

  // --- 3b. Smart shutdown activity tracking (apply-scoped). ---------------
  // Track the SET of sessions active (mid-turn) at any moment so that, if this
  // process is stopped by a plain SIGTERM/SIGINT (a restart NOT triggered
  // through the smart_restart tool, or a restart while agents were active), the
  // shutdown hook below can record WHICH sessions to auto-notify on the next
  // boot — instead of only the single most-recently-active one. EVERY session
  // is tracked — INCLUDING ignored-prefix ones (deepartments `head-*` heads):
  // the shutdown notice must record the heads whose turns were cut so the next
  // boot can auto-notify them (fb-168 resume path). The ignored-prefix filter
  // still applies where it matters: the single-session PIN derivation
  // (writeShutdownNotice) and the boot-side pin guard keep ignoring heads, so
  // a head is never pinned with a spurious notice (0.3.1).
  const activeSessions = new Map<string, number>() // sessionId -> lastStepAt
  const recordActivity = (agent: Agent) => {
    activeSessions.set(String(agent.id), Date.now())
  }
  // A turn closing NORMALLY (inbox drained, nextStep empty ⇒ the turn is about
  // to close cleanly) means the session is no longer mid-turn. Remove it so a
  // later shutdown does NOT list it as interrupted — avoids false positives for
  // just-finished idle sessions. `agent/turn-stopping` fires before `turn/end`.
  ctx.on('agent/turn-stopping', ({ agent }) => {
    activeSessions.delete(String(agent.id))
  })

  function deliver(agent: Agent): boolean {
    const sid = String(agent.id)
    if (deliveredIds.has(sid)) return false
    if (!pinnedTarget && config.target === 'primary') {
      if (deliveredPrimary) return false
      deliveredPrimary = true
    }
    deliveredIds.add(sid)
    deliveredAny = true

    const text = buildNotice({
      bootAt,
      prevBootAt,
      downtimeMs,
      customNotice: config.notice,
      reason: pinnedReason,
      interrupted: interruptedSessions.map(({ id }) => describeInterrupted(id)),
    })
    const msg: UserMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-smart-restart',
        form: 'notice',
        summary: `Smart-restart: the DSH service restarted at ${bootAt}`,
      },
    })

    if (config.wakeup !== false) {
      // Wake the idle agent AND deliver the notice as a user message in one
      // call. Never inject the same message alongside followup: followup()
      // queues it into the inbox, so a parallel inject() of the same id hits
      // "already pending" in Inbox.validate and the wake would fail.
      try {
        agent.followup(msg)
        console.log('[smart-restart] notice delivered to', String(agent.id))
      } catch (err) {
        console.warn('[smart-restart] followup failed:', err)
      }
    } else {
      // No wake: queue model-facing context only.
      try {
        agent.inject(msg)
        console.log('[smart-restart] notice delivered to', String(agent.id))
      } catch (err) {
        console.warn('[smart-restart] inject failed:', err)
      }
    }
    return true
  }

  // --- 3c. Canary abort alert (live-session delivery, no restart follows). --
  // Reuses the notice message shape (createUserMessage + plugin source
  // {kind:'plugin', plugin:'dsh-smart-restart', form:'notice'}) and the same
  // single-channel wakeup/inject selection as deliver(), but addressed to the
  // LIVE calling session via ctx (unlike deliver(), this is not boot-driven
  // and never uses pending-notice.json — no restart follows a failed canary).
  const alertCaller = (sessionId: string, text: string): void => {
    try {
      const msg: UserMessage = createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-smart-restart',
          form: 'notice',
          summary: 'Smart-restart: canary validation failed — restart aborted',
        },
      })
      const agent = ctx.agents.get(SessionId(sessionId))
      if (!agent) {
        console.warn('[smart-restart] canary abort alert: calling session not found:', sessionId)
        return
      }
      if (config.wakeup !== false) {
        // Wake the idle agent AND deliver in one call (never inject alongside).
        try {
          agent.followup(msg)
          console.log('[smart-restart] canary abort alert delivered to', sessionId)
        } catch (err) {
          console.warn('[smart-restart] canary abort alert followup failed:', err)
        }
      } else {
        // No wake: queue model-facing context only.
        try {
          agent.inject(msg)
          console.log('[smart-restart] canary abort alert delivered to', sessionId)
        } catch (err) {
          console.warn('[smart-restart] canary abort alert inject failed:', err)
        }
      }
    } catch (err) {
      console.warn('[smart-restart] canary abort alert failed:', err)
    }
  }

  const agentIsRoot = (agent: Agent): boolean =>
    ctx.agents.roots().some((r) => r.id === agent.id)

  // Human label for one interrupted session in the post-restart notice. Where
  // the session is resumed/live at boot we can tell a root (main) agent from a
  // child (worker); a killed worker not yet resumed is listed by id alone.
  const describeInterrupted = (id: string): string => {
    const agent = ctx.agents.get(SessionId(id))
    if (!agent) return id
    return agentIsRoot(agent) ? `${id} (main)` : `${id} (worker)`
  }

  // The combined human label for every session the shutdown cut (heads +
  // workers), rendered in each interrupted head's resume notice.
  const interruptedLabels = (): string[] => [
    ...interruptedSessions.map(({ id }) => describeInterrupted(id)),
    ...interruptedHeadsList.map((id) => describeInterrupted(id)),
  ]

  // --- 3d. Automatic resume notice for an interrupted head (fb-168). --------
  // A head whose turn was cut by the restart (a shutdown-notice session
  // matching the ignored prefixes) receives its own post-restart notice once it
  // comes live at boot — the organization must never hang idle post-restart
  // without knowing (fb-46). Same plugin-source channel as the main notice
  // (followup/inject, form 'notice'); tracked in `headResumeDelivered`, NEVER in
  // `deliveredIds`/`deliveredAny`, so it cannot suppress the main pin/target
  // delivery (deliverHeadResume still skips a session that already got a notice
  // via a config.target 'all' delivery).
  const deliverHeadResume = (agent: Agent): void => {
    const sid = String(agent.id)
    if (headResumeDelivered.has(sid)) return
    if (deliveredIds.has(sid)) return // already received a notice via target/session
    headResumeDelivered.add(sid)
    const text = buildNotice({
      bootAt,
      prevBootAt,
      downtimeMs,
      customNotice: config.notice,
      reason: 'the process was stopped while this session was active',
      interrupted: interruptedLabels(),
    })
    const msg: UserMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-smart-restart',
        form: 'notice',
        summary: `Smart-restart: the DSH service restarted at ${bootAt}; an interrupted head session was resumed`,
      },
    })
    try {
      if (config.wakeup !== false) {
        // Wake the idle agent AND deliver the notice in one call — never inject
        // the same message alongside followup (inbox "already pending").
        agent.followup(msg)
      } else {
        agent.inject(msg)
      }
      console.log('[smart-restart] resume notice delivered to interrupted head', sid)
    } catch (err) {
      console.warn('[smart-restart] head resume notice failed:', err)
    }
  }

  // --- 4. Primary hook: wake on the startup session-start publication. ----
  ctx.on('agent/session-start', ({ agent, source }) => {
    // Track last activity for the smart shutdown auto-notification (any agent,
    // any source, regardless of restart state).
    recordActivity(agent)
    // Automatic resume notify for interrupted heads (fb-168): an interrupted
    // head that comes live at boot gets its resume notice — source-agnostic
    // like the pinned path, because a head RESUMES with source 'resume', not
    // 'startup'. Independent of the main pin/target delivery (which a head is
    // never part of).
    if (wasRestart && interruptedHeadsList.includes(String(agent.id))) {
      deliverHeadResume(agent)
    }
    if (!wasRestart || !deliveryPending()) return
    // A pinned target (tool-caller wins) is source-agnostic: a session that
    // RESUMES from a previous process publishes with `source: 'resume'` (not
    // 'startup'), so the pinned session must match regardless of source. The
    // `source === 'startup'` gate applies only to the non-pinned target path.
    if (!pinnedTarget && source !== 'startup') return
    const isRoot = agentIsRoot(agent)
    // A pinned target overrides `config.target` for this boot (tool-caller wins).
    if (!selectsAgent(pinnedTarget, config.target, String(agent.id), isRoot)) return
    deliver(agent)
  })

  // Any agent proposing a step is "active" — refresh the last-activity stamp so
  // a shutdown while the agent is mid-task counts as agent-involved.
  // `agent/pre-step` is a waterfall event: we must call `next()` and return its
  // decision, passing the messages through unchanged (observation only).
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    recordActivity(agent)
    return next()
  })

  function deliveryPending(): boolean {
    if (!wasRestart) return false
    if (pinnedTarget) {
      // Pending only while the pinned session is live and undelivered.
      const pinned = ctx.agents.get(SessionId(pinnedTarget))
      return !!pinned && !deliveredIds.has(String(pinned.id))
    }
    if (config.target === 'primary') return !deliveredPrimary
    // 'all' / explicit: pending unless EVERY matching live agent was delivered.
    const roots = ctx.agents.roots()
    if (config.target === 'all') {
      return roots.some((r) => !deliveredIds.has(String(r.id)))
    }
    const target = ctx.agents.get(SessionId(config.target))
    return !!target && !deliveredIds.has(String(target.id))
  }

  // --- 5. Bounded retry fallback for the ordering edge (late / missing event).
  // A pinned session may resume LAZILY, well after apply — and `session-start`
  // with any source may never surface for it. So instead of a single one-shot
  // timer, poll at PENDING_POLL_MS up to a PENDING_POLL_MAX_MS window and
  // deliver the moment the pinned session is live. Non-pinned (config.target)
  // behavior stays one-shot on the first tick. The SAME bounded poll delivers
  // the fb-168 automatic resume notices to the interrupted heads as each one
  // comes live — independent of the main notice bookkeeping.
  const pollStartedAt = Date.now()
  let nonPinnedFired = false
  // One-shot `config.target` fallback shared by the pinned-window-expired path
  // and the non-pinned first tick (unchanged v0.2 semantics).
  const runTargetFallback = (): void => {
    const roots = ctx.agents.roots()
    if (config.target === 'primary') {
      const primary = roots[0] ?? ctx.agents.list()[0]
      if (primary) deliver(primary)
    } else if (config.target === 'all') {
      for (const root of roots) deliver(root)
    } else {
      const target = ctx.agents.get(SessionId(config.target))
      if (target) deliver(target)
    }
  }
  const pollInterval = setInterval(() => {
    if (!wasRestart) {
      clearInterval(pollInterval)
      return
    }
    const windowExpired = Date.now() - pollStartedAt >= PENDING_POLL_MAX_MS
    try {
      // 1) Interrupted-head resume notices — independent of the main notice:
      //    deliver to each interrupted head the moment it comes live, bounded
      //    by the same poll window (heads resume lazily, like a pinned
      //    session). A head that never comes live within the window gets no
      //    notice — the runtime's own resumed-turn flow handles it.
      for (const headId of interruptedHeadsList) {
        if (headResumeDelivered.has(headId)) continue
        const head = ctx.agents.get(SessionId(headId))
        if (head) deliverHeadResume(head)
      }
      const headsPending = interruptedHeadsList.some((h) => !headResumeDelivered.has(h))

      // 2) Main notice (pinned / config.target) — unchanged v0.2 semantics:
      //    pinned waits for the late-resuming session (bounded), then falls
      //    back to `target` once; non-pinned is one-shot on the first tick.
      let mainSettled = false
      if (pinnedTarget) {
        const pinned = ctx.agents.get(SessionId(pinnedTarget))
        if (pinned) {
          deliver(pinned)
          mainSettled = true
        } else if (!windowExpired) {
          if (!headsPending) return // keep waiting for the pinned session
        } else {
          // Pinned session never came live within the window: one-shot target
          // fallback so the notice still lands somewhere.
          if (!nonPinnedFired) {
            nonPinnedFired = true
            runTargetFallback()
          }
          mainSettled = true
        }
      } else {
        // Non-pinned stays one-shot: the target fallback runs on the first
        // tick, after which only interrupted heads may still be pending.
        if (!nonPinnedFired) {
          nonPinnedFired = true
          runTargetFallback()
        }
        mainSettled = true
      }
      if (deliveredAny) mainSettled = true

      // 3) Stop when the main notice is settled AND no interrupted head is
      //    still pending inside the window (or the window expired).
      if (mainSettled && (!headsPending || windowExpired)) {
        clearInterval(pollInterval)
        return
      }
      if (windowExpired) {
        clearInterval(pollInterval)
        return
      }
    } catch (err) {
      console.warn('[smart-restart] fallback delivery failed:', err)
    }
  }, PENDING_POLL_MS)

  // --- 5b. Shutdown hook: persist last-active session for boot auto-notify.
  // Register SYNCHRONOUS, best-effort SIGTERM/SIGINT handlers that write a
  // shutdown-notice.json (last active session + timestamp) into the marker dir
  // before the process dies. This covers restarts NOT initiated via the
  // smart_restart tool — e.g. a plain `systemctl restart` the agent ran, or a
  // restart while an agent was active — so the next boot can pin the notice to
  // that session (only if it was active within shutdownGraceMs). writeFileSync
  // + mkdirSync are synchronous so they complete under the signal; the write is
  // wrapped in try/catch and never throws from the handler. Handlers are stored
  // so they can be removed on unload (reversible).
  const shutdownDocPath = join(markerDir, 'shutdown-notice.json')
  const writeShutdownNotice = () => {
    try {
      // Sessions active within the grace window at shutdown — the FULL set,
      // INCLUDING ignored-prefix (deepartments `head-*`) sessions: the doc's
      // sessions list is the interrupted set the next boot auto-notifies, and
      // an interrupted HEAD must be notified too (fb-168 resume path; the org
      // must never hang post-restart). The ignored-prefix filter still applies
      // to the single-session PIN derivation below (lastSessionId), so the pin
      // — and the boot-side shutdownTarget guard — never target a head (0.3.1).
      const now = Date.now()
      const sessions: ShutdownSession[] = [...activeSessions.entries()]
        .filter(([, at]) => now - at <= config.shutdownGraceMs)
        .map(([id, at]) => ({ id, lastActiveAt: new Date(at).toISOString() }))
      if (sessions.length === 0) return // nothing was active; do not write a notice
      // The pin session: the max-timestamp NON-ignored entry when one exists
      // (unchanged 0.3.1 behavior — heads are never the pin), else the
      // max-timestamp entry (a heads-only shutdown: the boot-side pin guard
      // still refuses to pin an ignored session, so this is only enough to
      // keep the doc valid and let the resume notification flow).
      const pinnable = sessions.filter(({ id }) => !ignoredByPrefix(id, config.ignoredSessionPrefixes))
      const pool = pinnable.length > 0 ? pinnable : sessions
      const primary = pool.reduce((a, b) =>
        Date.parse(a.lastActiveAt) >= Date.parse(b.lastActiveAt) ? a : b,
      )
      mkdirSync(markerDir, { recursive: true })
      const doc: ShutdownNotice = {
        lastSessionId: primary.id,
        lastActiveAt: primary.lastActiveAt,
        when: new Date().toISOString(),
        sessions,
      }
      writeFileSync(shutdownDocPath, JSON.stringify(doc, null, 2))
    } catch (err) {
      // never throw from a signal handler; best-effort only
      console.warn('[smart-restart] shutdown-notice write failed:', err)
    }
  }
  // NOTE: installing a SIGTERM/SIGINT listener OVERRIDES Node's default
  // termination action. If the handler only writes and returns, a `systemctl
  // restart`/`stop` would leave the process alive until systemd's
  // TimeoutStopSec escalates to SIGKILL (default 90s), breaking restarts of
  // this very service. So after writing the notice we re-raise the signal —
  // but ONLY when this handler is the last one registered (bare Node: dev,
  // unit tests), letting Node's default action terminate cleanly with exit
  // code 143 (SIGTERM) / 130 (SIGINT) — discovered via an isolated smoke.
  // When the core bootstrap's own SIGTERM/SIGINT handler is present (real
  // host), we do NOT re-raise: the re-raised signal would hit the
  // bootstrap's interrupt() with a dispose already pending and force-exit
  // immediately (profile-boot forceExitOnce), cutting the graceful
  // fiber.dispose() → write-behind flush-all mid-flight (RD #483).
  const onSigterm = () => {
    writeShutdownNotice()
    // Count BEFORE removing ourselves: `<= 1` then means "no other listener".
    if (shouldReRaiseSignal('SIGTERM')) {
      process.removeListener('SIGTERM', onSigterm)
      process.kill(process.pid, 'SIGTERM')
    }
  }
  const onSigint = () => {
    writeShutdownNotice()
    if (shouldReRaiseSignal('SIGINT')) {
      process.removeListener('SIGINT', onSigint)
      process.kill(process.pid, 'SIGINT')
    }
  }
  process.on('SIGTERM', onSigterm)
  process.on('SIGINT', onSigint)

  // --- 6. smart_restart tool (records the calling session, restarts via
  //        systemd detached, then pins the post-restart notice to its session).
  if (config.toolEnabled !== false) {
    const disposeTool = ctx.tools.register(
      defineTool({
        name: 'smart_restart',
        description:
          'Restart the DSH service via systemd and, after it comes back up, deliver the smart-restart notice to THIS session so the interrupted task resumes automatically. HARD GUARD: the tool reads the LIVE agent registry and REFUSES to restart while OTHER sessions are mid-turn (status running) — it returns the in-flight session list instead; pass force:true only after explicitly confirming that interrupting that work is safe (the override is always visible in the log). WARNING: restarting the service any other way (raw systemctl/reboot) while subagents/workers have active turns kills them mid-flight — their sessions end "Stopped" (turn reason: interrupted) and the tool result is "outcome unknown". Use this tool for any restart with live work; the canary param aborts on an unhealthy boot.',
        parameters: {
          reason: {
            type: 'string',
            description:
              'Optional human-readable note, e.g. "installed dshmarket in stable+dev". Included in the post-restart notice AND (for an intentional GRACE restart, see `cause`) in the sidecar restart-reason marker. NO secrets — the value is persisted to disk.',
          },
          cause: {
            type: 'string',
            description:
              "Optional: the INTENTIONAL restart family — one of canary | deploy | dshmarket (the FB-234 GRACE set). The tool writes <runtimeStateDir>/restart-reason.json ATOMICALLY BEFORE the kill so the next boot treats the previous boot as intentionally restarted (the crash streak never rises over it) and attributes the restart-registry row to this cause verbatim. Use it for an intentional restart of a HEALTHY process (canary re-boot / deploy / dshmarket upgrade); omit it for any other restart (no marker — current crash semantics).",
          },
          canary: {
            type: 'boolean',
            description:
              'Optional: validate the restart with a canary pre-flight first — boots an ephemeral DSH instance (same binary/profile as this unit) on a temp free port with a temp state overlay, probes HTTP health plus the client boot graph (every /plugins/<id>/client.js must register its graph row id) plus the post-boot runtime checks (agent liveness, pooler health, R8/R9 markers), and aborts the restart on failure. Overrides the configured `canary` for this call.',
          },
          force: {
            type: 'boolean',
            description:
              'Optional: override the read-before-edit guard — restart even when OTHER sessions are mid-turn. The tool refuses (returns the in-flight session list) unless this is true; the override and the in-flight list are ALWAYS logged. Use only after explicitly confirming the in-flight work is safe to interrupt.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              restarting: { type: 'boolean', required: true },
              sessionId: { type: 'string' },
              reason: { type: 'string' },
              error: { type: 'string' },
              canary: { type: 'string' },
              canaryDetail: { type: 'string' },
              inFlight: { type: 'array', items: { type: 'string' } },
            },
          },
          render: (_args, value) => {
            const lines: { type: 'text'; text: string }[] = []
            // A failed canary already aborts the restart; render ONLY the
            // canary line so the abort reason is not duplicated by the generic
            // error line below.
            if (value.canary !== 'failed') {
              lines.push({
                type: 'text',
                text: value.error
                  ? `smart_restart failed: ${value.error}`
                  : `Restarting the DSH service (session ${value.sessionId ?? '?'}) in ~1s; the notice will return to this session after it is back up.`,
              })
            }
            if (value.canary) {
              lines.push({
                type: 'text',
                text:
                  value.canary === 'passed'
                    ? 'Canary: passed — restarting…'
                    : value.canary === 'failed'
                      ? `Canary: failed — restart ABORTED: ${value.canaryDetail ?? ''}`
                      : `Canary: skipped — ${value.canaryDetail ?? ''}`,
              })
            }
            return lines
          },
        },
        async execute(args, exec): Promise<SmartRestartOutcome> {
          const guard = guardRestart(effectiveRestartUnit, exec)
          if (!guard.ok) return guard.result
          // FB-234 — the RUNTIME stateDir the boot-crash sidecar reads/writes
          // (`<stateDir>/boot-crash.json` + the `restart-reason.json` marker):
          // the SAME resolution as the canary's runtime-marker check
          // (canary.ts: `canaryRuntimeStateDir` || `/.deepartments`).
          const runtimeStateDir = config.canaryRuntimeStateDir || DEFAULT_RUNTIME_STATE_DIR
          // fb-168 (a) — READ-BEFORE-EDIT guard: the tool consults the LIVE
          // agent registry (ctx.agents, status === 'running') BEFORE anything
          // is persisted or spawned and refuses to restart while OTHER
          // sessions are mid-turn (the calling session is excluded: it
          // restarts itself intentionally and is pinned for resume). Blind
          // interruption becomes structurally impossible; an explicit
          // force:true override is the only way through and is ALWAYS logged.
          const force = args.force === true
          const activeGuard = checkActiveGuard(ctx, guard.sessionId, force)
          if (!activeGuard.ok) return activeGuard.result
          // RD #483 (b): durable checkpoint of the CALLING session before the
          // fire-and-forget spawn. The core's checkpoint policy already flushes
          // the session BEFORE the tool body (dsh-session-checkpoint-policy
          // tools/execute hook — ctx.sessions.flush(exec.agent.session)); this
          // explicit drain additionally settles anything that raced in during
          // the guards/canary window, so the spawn never outruns the calling
          // session's write-behind batch. Best-effort by design: a flush
          // failure must NOT block the restart — the core's graceful SIGTERM
          // dispose (un-sabotaged by fix (a)) remains the durability backstop.
          const callingSession = ctx.sessions.get(SessionId(guard.sessionId))
          if (callingSession !== undefined) {
            try {
              await ctx.sessions.flush(callingSession)
            } catch (err) {
              console.warn('[smart-restart] smart_restart: calling-session flush failed:', err)
            }
          }
          // --- Optional canary gate (runs after the guards, BEFORE the
          //      pending-notice persist and BEFORE any spawn). ---------------
          // A failed canary aborts the restart: no pending notice is written,
          // nothing is spawned, and the calling session is alerted live.
          if (args.canary ?? config.canary) {
            let canary: CanaryResult
            try {
              // The canary receives the EFFECTIVE unit ("already-resolved"):
              // it derives ExecStart from restartUnit, and an auto-detected
              // unit is zero-config here too.
              canary = await runCanary(ctx, { ...config, restartUnit: effectiveRestartUnit }, args as SmartRestartCall)
            } catch (err) {
              canary = { status: 'failed', detail: `canary error: ${String(err)}` }
            }
            if (canary.status === 'failed') {
              console.warn('[smart-restart] smart_restart: canary failed; restart aborted:', canary.detail)
              alertCaller(guard.sessionId, `smart_restart canary FAILED — restart aborted: ${canary.detail}`)
              return {
                ok: false,
                restarting: false,
                canary: 'failed',
                canaryDetail: canary.detail,
                error: 'canary failed; restart aborted',
              }
            }
            // The canary window (up to canaryTimeoutMs) is long: RE-CHECK the
            // live registry right before the spawn — a session may have started
            // a turn while the canary booted, and the final gate must reflect
            // the CURRENT state (never the check at call entry).
            const recheck = checkActiveGuard(ctx, guard.sessionId, force)
            if (!recheck.ok) {
              console.warn('[smart-restart] smart_restart: active-agent guard re-check blocked the restart after the canary:', recheck.inFlight.join(', '))
              return recheck.result
            }
            // passed / skipped → proceed with the normal restart and carry the
            // canary outcome onto the result. The canary gate RAN: without an
            // explicit cause this is a CANARY restart (GRACE family 'canary').
            return performRestart(args, exec, markerDir, effectiveRestartUnit, {
              runtimeStateDir,
              canary: { status: canary.status, detail: canary.detail },
            })
          }
          return performRestart(args, exec, markerDir, effectiveRestartUnit, { runtimeStateDir })
        },
      }),
    )
    // Reversible effect: drop the tool on plugin unload / HMR.
    ctx.effect(() => disposeTool)
  }

  // Reversible effect: drop the listener + interval + signal handlers on unload.
  ctx.effect(() => () => {
    clearInterval(pollInterval)
    process.removeListener('SIGTERM', onSigterm)
    process.removeListener('SIGINT', onSigint)
  })
}

/**
 * Validate a restart request before anything is persisted or spawned.
 *
 * Shared by the tool execute flow (which additionally runs the optional canary
 * gate BETWEEN the guards and the pending-notice persist) and by
 * performRestart itself (defense in depth). `restartUnit` is the EFFECTIVE
 * unit — explicit config or auto-detected from /proc/self/cgroup (v0.5.0).
 * Returns the resolved unit + calling session id, or a fail-fast tool result
 * to return as-is.
 */
function guardRestart(
  restartUnit: string,
  exec: { agent?: { id: unknown } },
):
  | { ok: true; unit: string; sessionId: string }
  | { ok: false; result: SmartRestartOutcome } {
  if (!restartUnit) {
    console.warn('[smart-restart] smart_restart: restartUnit not configured')
    return { ok: false, result: { ok: false, restarting: false, error: 'restartUnit not configured' } }
  }
  // Fail safe: accept a single systemd unit token (no spaces/slashes) to
  // avoid shell injection through restartUnit into the detached command.
  const unit = restartUnit.split(' ')[0]
  if (!UNIT_TOKEN_RE.test(unit)) {
    console.warn('[smart-restart] smart_restart: invalid restartUnit token:', unit)
    return { ok: false, result: { ok: false, restarting: false, error: `invalid restartUnit: ${unit}` } }
  }
  const sessionId = String(exec.agent?.id ?? '')
  if (!sessionId) {
    return { ok: false, result: { ok: false, restarting: false, error: 'no calling session' } }
  }
  return { ok: true, unit, sessionId }
}

/**
 * fb-168 (a) — the read-before-edit guard for the smart_restart tool, wired to
 * the LIVE DSH agent registry.
 *
 * Snapshots `ctx.agents` (the same in-process registry the runtime derives
 * "running" from: `agents.get(id).status === 'running'`) and feeds it to the
 * pure `activeAgentGuard` decision: the restart is REFUSED when any session
 * OTHER than the caller is mid-turn, with the in-flight list returned. The
 * registry is synchronously updated by the harness on every `agent/status`
 * transition, so this check can never be stale the way file-based state
 * (posts.json / a prior dept_who) could — the exact failure mode of the
 * 2026-09-05 incident. An explicit `force` override is the only way through and
 * is ALWAYS visible in the log (with the in-flight list).
 */
function checkActiveGuard(
  ctx: Context,
  callingSessionId: string,
  force: boolean,
): { ok: true; inFlight: string[] } | { ok: false; result: SmartRestartOutcome; inFlight: string[] } {
  const live = ctx.agents.list()
  const g = activeAgentGuard(
    live.map((a) => ({ id: a.id, status: a.status })),
    callingSessionId,
    force,
  )
  if (g.inFlight.length > 0) {
    console.warn(
      force
        ? `[smart-restart] smart_restart: FORCE override — restarting with ${g.inFlight.length} other session(s) mid-turn: ${g.inFlight.join(', ')}`
        : `[smart-restart] smart_restart: BLOCKED — ${g.inFlight.length} other session(s) mid-turn: ${g.inFlight.join(', ')}; pass force:true to override`,
    )
  } else if (force) {
    console.warn('[smart-restart] smart_restart: FORCE override requested — 0 other sessions mid-turn')
  } else {
    console.warn('[smart-restart] smart_restart: active-agent guard — 0 other sessions mid-turn')
  }
  if (g.allowed) return { ok: true, inFlight: g.inFlight }
  return {
    ok: false,
    inFlight: g.inFlight,
    result: {
      ok: false,
      restarting: false,
      error: `refusing to restart: ${g.inFlight.length} other session(s) mid-turn (${g.inFlight.join(', ')}) — pass force:true to override`,
      inFlight: g.inFlight,
    },
  }
}

/** Restart the DSH systemd unit and pin the notice to the calling session.
 * FB-234: BEFORE the kill, the INTENTIONAL-RESTART MARKER (`<runtimeStateDir>/
 * restart-reason.json`) is written ATOMICALLY for a GRACE-family restart, or a
 * stale marker is REMOVED for any other restart — the sidecar at the next boot
 * then never raises the crash streak over an intentional restart. */
function performRestart(
  args: SmartRestartCall,
  exec: { agent?: { id: unknown } },
  markerDir: string,
  restartUnit: string,
  opts: {
    /** FB-234 — the RUNTIME stateDir whose boot-crash sidecar + restart-reason
     * marker this restart drives (resolved in the tool execute: the same dir
     * the sidecar stamps boot-crash.json in). */
    runtimeStateDir: string
    /** The canary gate outcome when it RAN for this call (passed/skipped → the
     * restart is canary-gated and, absent an explicit cause, gets the GRACE
     * cause 'canary'); ABSENT → the gate did not run for this call. */
    canary?: { status: 'passed' | 'skipped'; detail: string }
  },
): SmartRestartOutcome {
  try {
    const guard = guardRestart(restartUnit, exec)
    if (!guard.ok) return guard.result
    const { unit, sessionId } = guard

    // FB-234 — write the INTENTIONAL-RESTART MARKER BEFORE the kill (the
    // marker must exist on disk before the process dies; the next apply start
    // reads + consumes it). Only an explicit GRACE cause — or a canary gate
    // that ran → 'canary' — yields a marker; a non-grace restart REMOVES any
    // stale marker so it can never excuse this kill (current semantics = no
    // marker). bootId is the CURRENT boot's id (the boot BEING KILLED), read
    // from the boot-crash sidecar immediately before the write; a missing /
    // unreadable sidecar → the marker is written WITHOUT the optional anchor
    // (SPEC: a no-bootId marker excuses whatever previous boot the next apply
    // start finds — the excusal is never lost to an absent sidecar file).
    const cause = resolveRestartCause(args.cause, opts.canary !== undefined)
    if (cause !== undefined) {
      const bootId = readCurrentBootId(opts.runtimeStateDir)
      const reason = typeof args.reason === 'string' && args.reason !== '' ? args.reason : undefined
      writeRestartReasonMarker(opts.runtimeStateDir, {
        cause,
        ...(reason !== undefined ? { reason } : {}),
        ts: Date.now(),
        ...(bootId !== undefined ? { bootId } : {}),
      })
    } else {
      clearRestartReasonMarker(opts.runtimeStateDir)
    }

    // Persist the pending notice FIRST (synchronously, before any spawn) so it
    // survives the imminent service kill and targets the restarting session.
    const pending = {
      sessionId,
      reason: args.reason ?? '',
      when: new Date().toISOString(),
    }
    mkdirSync(markerDir, { recursive: true })
    writeFileSync(join(markerDir, 'pending-notice.json'), JSON.stringify(pending, null, 2))

    // Spawn the restart in a DETACHED background process that survives this
    // process being killed by systemd. ~1s delay lets this response be written.
    const child = spawn(
      'setsid',
      ['bash', '-c', `sleep 1 && systemctl restart ${unit} >/dev/null 2>&1`],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()

    const result: SmartRestartOutcome = { ok: true, restarting: true, sessionId, reason: pending.reason }
    if (opts.canary) {
      result.canary = opts.canary.status
      // A skip carries its human detail; a pass is self-explanatory.
      if (opts.canary.status === 'skipped') result.canaryDetail = opts.canary.detail
    }
    return result
  } catch (err) {
    console.warn('[smart-restart] smart_restart failed:', err)
    return { ok: false, restarting: false, error: String(err) }
  }
}
