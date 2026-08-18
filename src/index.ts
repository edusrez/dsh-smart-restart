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
  buildNotice,
  detectRestart,
  parsePendingNotice,
  parseShutdownNotice,
  selectsAgent,
  shutdownTarget,
  type BootMarker,
  type ShutdownNotice,
  type SmartRestartParams,
  type SmartRestartResult,
} from './boot.js'

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
}

/** Fallback poll interval while waiting for a pinned session to resume. */
const PENDING_POLL_MS = 750
/** Hard cap on how long the fallback keeps waiting for a pinned session. */
const PENDING_POLL_MAX_MS = 15000

/** A single systemd unit token — rejects spaces/slashes to avoid shell injection. */
const UNIT_TOKEN_RE = /^[A-Za-z0-9_.@-]+$/

export const name = 'smart-restart'
export const inject = ['agents', 'tools']

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

export function apply(ctx: Context, cfg: Partial<Config> = {}) {
  const config: Config = { ...DEFAULTS, ...cfg }
  if (!config.enabled) return

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

  // --- 2c. Smart shutdown auto-detection (second-priority pin). -----------
  // If NO pending notice exists (the restart was NOT triggered via the
  // smart_restart tool — e.g. a plain `systemctl restart` executed by the
  // agent, or while an agent was active), the SIGTERM/SIGINT handler persisted
  // a shutdown-notice.json recording the last active session. Pin delivery to
  // that session ONLY if it was active within `shutdownGraceMs` of shutdown
  // (recent activity ⇒ the user restarted while the agent was mid-task, so
  // auto-notify). If the session was idle well before shutdown, `shutdownTarget`
  // returns null and we fall back to the existing `target`. The file is consumed
  // (unlinked) so it cannot linger and pin a future boot; the marker still
  // proves the restart.
  const shutdownPath = join(markerDir, 'shutdown-notice.json')
  if (!pinnedTarget) {
    try {
      const notice = parseShutdownNotice(readFileSync(shutdownPath, 'utf8'))
      const target = shutdownTarget(notice, Date.now(), config.shutdownGraceMs)
      if (target) {
        pinnedTarget = target
        pinnedReason = 'the process was stopped while this session was active'
        console.log('[smart-restart] pinned restart notice to last-active session', pinnedTarget)
      }
    } catch {
      // no readable shutdown notice -> nothing to pin
    }
    try {
      unlinkSync(shutdownPath)
    } catch {
      // file absent or already removed; fine
    }
  } else {
    // A pending notice won priority; still consume any stale shutdown-notice
    // so it cannot pin a later boot.
    try {
      unlinkSync(shutdownPath)
    } catch {
      // file absent or already removed; fine
    }
  }

  // --- 3. Delivery plumbing (all state is apply-scoped; nothing global). ---
  const deliveredIds = new Set<string>()
  let deliveredPrimary = false
  let deliveredAny = false

  // --- 3b. Smart shutdown activity tracking (apply-scoped). ---------------
  // Track the last active session so that, if this process is stopped by a
  // plain SIGTERM/SIGINT (a restart NOT triggered through the smart_restart
  // tool, or a restart while an agent was active), the shutdown hook below can
  // record which session to auto-notify on the next boot.
  let lastActiveId: string | undefined
  let lastActiveAt = 0
  const recordActivity = (agent: Agent) => {
    lastActiveId = String(agent.id)
    lastActiveAt = Date.now()
  }

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

  const agentIsRoot = (agent: Agent): boolean =>
    ctx.agents.roots().some((r) => r.id === agent.id)

  // --- 4. Primary hook: wake on the startup session-start publication. ----
  ctx.on('agent/session-start', ({ agent, source }) => {
    // Track last activity for the smart shutdown auto-notification (any agent,
    // any source, regardless of restart state).
    recordActivity(agent)
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
  // behavior stays one-shot on the first tick, then the loop stops.
  const pollStartedAt = Date.now()
  let nonPinnedFired = false
  const pollInterval = setInterval(() => {
    if (!wasRestart || deliveredAny) {
      clearInterval(pollInterval)
      return
    }
    try {
      const windowExpired = Date.now() - pollStartedAt >= PENDING_POLL_MAX_MS
      if (pinnedTarget) {
        // Reliable mechanism for a tool-caller session that resumes late:
        // poll until it is live (bounded), then deliver to it.
        const pinned = ctx.agents.get(SessionId(pinnedTarget))
        if (pinned) {
          deliver(pinned)
          clearInterval(pollInterval)
          return
        }
        if (!windowExpired) return // keep waiting for the late-resuming session
        // Pinned session never came live within the window: do the existing
        // `target` fallback once so the notice still lands somewhere.
      } else {
        // Non-pinned stays one-shot: the fallback runs once, then stop.
        if (nonPinnedFired) {
          clearInterval(pollInterval)
          return
        }
        nonPinnedFired = true
      }
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
      clearInterval(pollInterval)
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
      if (!lastActiveId) return // nothing was active; do not write a notice
      mkdirSync(markerDir, { recursive: true })
      const doc: ShutdownNotice = {
        lastSessionId: lastActiveId,
        lastActiveAt: new Date(lastActiveAt || Date.now()).toISOString(),
        when: new Date().toISOString(),
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
  // this very service. So after writing the notice we remove ourselves and
  // re-raise the signal, letting Node's default action terminate cleanly with
  // exit code 143 (SIGTERM) / 130 (SIGINT) — discovered via an isolated smoke.
  const onSigterm = () => {
    writeShutdownNotice()
    process.removeListener('SIGTERM', onSigterm)
    process.kill(process.pid, 'SIGTERM')
  }
  const onSigint = () => {
    writeShutdownNotice()
    process.removeListener('SIGINT', onSigint)
    process.kill(process.pid, 'SIGINT')
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
          'Restart the DSH service via systemd and, after it comes back up, deliver the smart-restart notice to THIS session so the interrupted task resumes automatically.',
        parameters: {
          reason: {
            type: 'string',
            description:
              'Optional human-readable note, e.g. "installed dshmarket in stable+dev". Included in the post-restart notice.',
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
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text:
                value.error
                  ? `smart_restart failed: ${value.error}`
                  : `Restarting the DSH service (session ${value.sessionId ?? '?'}) in ~1s; the notice will return to this session after it is back up.`,
            } as const,
          ],
        },
        async execute(args, exec): Promise<SmartRestartResult> {
          return performRestart(args, exec, markerDir, config)
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

/** Restart the DSH systemd unit and pin the notice to the calling session. */
function performRestart(
  args: SmartRestartParams,
  exec: { agent?: { id: unknown } },
  markerDir: string,
  config: Config,
): SmartRestartResult {
  try {
    if (!config.restartUnit) {
      console.warn('[smart-restart] smart_restart: restartUnit not configured')
      return { ok: false, restarting: false, error: 'restartUnit not configured' }
    }
    // Fail safe: accept a single systemd unit token (no spaces/slashes) to
    // avoid shell injection through restartUnit into the detached command.
    const unit = config.restartUnit.split(' ')[0]
    if (!UNIT_TOKEN_RE.test(unit)) {
      console.warn('[smart-restart] smart_restart: invalid restartUnit token:', unit)
      return { ok: false, restarting: false, error: `invalid restartUnit: ${unit}` }
    }
    const sessionId = String(exec.agent?.id ?? '')
    if (!sessionId) {
      return { ok: false, restarting: false, error: 'no calling session' }
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

    return { ok: true, restarting: true, sessionId, reason: pending.reason }
  } catch (err) {
    console.warn('[smart-restart] smart_restart failed:', err)
    return { ok: false, restarting: false, error: String(err) }
  }
}
