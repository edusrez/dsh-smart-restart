// Child-process harness for the smart_restart `wait` lane (test/wait.test.js
// drives it, the restart-reason-topology.js pattern): boots the REAL plugin
// (lib/index.js `apply`) with a minimal stub cordis ctx, captures the
// registered smart_restart tool and drives its `execute` the way the host
// would — with the kill path (`setsid ... systemctl restart`) replaced by a
// FAKE `setsid` on PATH that only LOGS the kill and exits (no systemd, no
// service, no /opt/dsh).
//
// The LIVE AGENT REGISTRY is SIMULATED: `ctx.agents.list()` returns a scripted
// snapshot (the pure guard consumes the snapshot, so this is exactly the
// injection the acceptance asks for). Every agent call is recorded, so the
// harness also PROVES the wait is passive: it re-reads `agents.list()` and
// touches nothing else — no `agents.get`, no `agents.roots`, no messaging
// surface, no turn creation, no wake.
//
// Scenarios (one smart_restart execute each):
//  1. `wait` ABSENT + 1 other session mid-turn → IMMEDIATE loud refusal, byte
//     identical to fb-168, NO kill, NO pending notice, NO marker.
//  2. `wait:true` (+cause 'deploy') + the registry RELEASES → the restart
//     proceeds (kill happens), waitedMs reported, marker written.
//  3. `wait:true` + NEVER releases (cap 300ms) → the SAME refusal + explicit
//     expiry, NO kill, NO partial action, nothing persisted.
//  4. `force:true` + `wait:true` + mid-turn → force WINS: no waiting, kill.
//  5. `wait:true` + already idle → no waiting at all, kill.
//  6. `wait:true` + an INVALID waitMaxMs → falls back to the default (logged),
//     never unbounded; already-idle registry so the fallback costs no time.
//  7. TRAMO (B) — `canary:true` + `wait:true`: the CANARY WINDOW consumes part
//     of the SAME wait budget and the post-canary re-check gets ONLY the rest
//     (a session starts a turn during the canary) → the restart still happens
//     and `waitedMs` (guard + re-check, ACCUMULATED) stays ≤ `waitMaxMs`: the
//     ceiling is never doubled.
//  8. TRAMO (B) — the canary window spends the whole budget: with a session
//     mid-turn at the re-check the tool refuses IMMEDIATELY (no zero-length
//     wait), with the same loud expiry refusal + `waitTimedOut`, no kill, no
//     partial action.
//  9. TRAMO (B) — the re-check spends its REMAINDER and the sessions never
//     release → the same loud refusal carrying the ACCUMULATED wait, still
//     ≤ the cap, no kill, no partial action.
// 10. TRAMO (B) — the budget is spent but the registry is IDLE at the
//     re-check → the restart proceeds (no wait, no refusal: the decision is
//     the CURRENT state, never the clock).
// 11. (a1) TWO WAITERS, MUTUAL: TWO `execute` calls CONCURRENTLY on ONE shared
//     `ctx.agents` (distinct `exec.agent.id`: A and B), both `wait:true` with a
//     SHORT cap, A and B BOTH `running` in the snapshot → each waits on the
//     OTHER (its own turn is excluded from its own guard) and BOTH expire with
//     the SAME loud refusal, 0 kills, no partial action: the measured proof of
//     "bounded livelock, never deadlock".
// 12. (a2) ONE WAITS, THE OTHER CLOSES: A defers with a long cap while B (a
//     concurrent caller) expires on a short one and its turn ENDS there (the
//     registry flips B to idle) → the release UNBLOCKS A: kill happens,
//     `waitedMs` reflects the real elapsed time (no symmetric deadlock).
// 13. (a4) DERIVED — the ESCAPE HATCH during a mutual wait: a THIRD caller with
//     `force:true` restarts IMMEDIATELY while A and B are both stuck waiting
//     (and both still expire afterwards): the `force` override is never
//     blocked by other waiters.
//
// The canary of scenarios 7-9 is REAL code (runCanary + its client-graph
// check) against a FAKE `dsh` binary on PATH: `--dump-config` prints a
// coherent entry list (the smart-restart row disabled), `--port N` boots a
// tiny HTTP server after FAKE_DSH_BOOT_DELAY_MS (that delay IS the canary
// window the budget must pay for). The fake `setsid` EXECs that boot (so the
// ephemeral can be killed by runCanary) and only LOGS anything else — the
// real kill is never executed, exactly as in scenarios 1-6.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'smart-restart-wait-harness-'))
// The canary's OWN tmp overlay (mkdtempSync(tmpdir()) inside canary.ts) is
// redirected under this harness root: scratch stays inside the harness tree.
const tmpRoot = join(root, 'tmp')
process.env.TMPDIR = tmpRoot
const dshHome = join(root, 'dsh-home')
const stateName = 'state'
const runtimeStateDir = join(root, 'deepartments')
const fakeBin = join(root, 'fakebin')
const killLog = join(root, 'kill.log')
const bootLog = join(root, 'canary-boot.log')
const markerFile = join(runtimeStateDir, 'restart-reason.json')
const pendingFile = join(dshHome, stateName, 'pending-notice.json')
mkdirSync(dshHome)
mkdirSync(runtimeStateDir, { recursive: true })
mkdirSync(fakeBin)
mkdirSync(tmpRoot, { recursive: true })

// The FAKE `setsid`: `--port` = the canary's ephemeral boot → hand it to the
// REAL /usr/bin/setsid (a new process group, so runCanary's
// killProcessGroup(-pid) really stops it) and EXEC it; anything else = the
// detached kill path → LOG ONLY, never execute (no systemd, no service, no
// /opt/dsh). The kill-log line count IS the "did a restart get spawned"
// signal the refusal paths must NOT produce.
const REAL_SETSID = '/usr/bin/setsid'
writeFileSync(
  join(fakeBin, 'setsid'),
  `#!/bin/bash
if [[ "$*" == *"--port"* ]]; then
  {
    echo "BOOT:$*"
  } >> "${bootLog}"
  exec ${existsSync(REAL_SETSID) ? REAL_SETSID : '/bin/false'} "$@"
fi
{
  echo "ARGS:$*"
} >> "${killLog}"
exit 0
`,
  { mode: 0o755 },
)

// The FAKE canary `dsh`: a bash wrapper into a tiny Node program.
writeFileSync(
  join(fakeBin, 'dsh'),
  `#!/bin/bash
exec "${process.execPath}" "${join(root, 'fake-dsh.mjs')}" "$@"
`,
  { mode: 0o755 },
)

// The FAKE ephemeral instance: `--dump-config` prints a coherent entry list
// (checkDumpConfigCoherent: the smart-restart row IS disabled), `--port N`
// serves HTTP 200 on the auto-picked canary port after the configured delay.
// The served page has no `__DSH_BOOT__` graph → the client-graph check passes
// with "nothing to validate" (the honest shape of a non-web boot).
writeFileSync(
  join(root, 'fake-dsh.mjs'),
  `import { createServer } from 'node:http'

const argv = process.argv.slice(2)
if (argv.includes('--dump-config')) {
  process.stdout.write(
    '- id: smart-restart\\n' +
      '  name: dsh-smart-restart\\n' +
      '  config:\\n' +
      '    enabled: false\\n' +
      '- id: dshd-core\\n' +
      '  name: dshd-core\\n' +
      '  config:\\n' +
      '    stateDir: ".deepartments"\\n',
  )
  process.exit(0)
}
const portIdx = argv.indexOf('--port')
const port = portIdx === -1 ? 0 : Number(argv[portIdx + 1])
const delay = Number(process.env.FAKE_DSH_BOOT_DELAY_MS || '0')
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<html><body>ephemeral canary instance</body></html>')
})
setTimeout(() => server.listen(port, '127.0.0.1'), delay)
// Safety net: a fake instance left unkilled never outlives the harness.
setTimeout(() => process.exit(0), 30_000).unref()
`,
)

// A FAKE `systemctl` (belt and braces): the canary's ExecStart derivation
// finds no unit here (canaryBinary wins) and NOTHING in this harness can ever
// reach a real systemd.
writeFileSync(join(fakeBin, 'systemctl'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })

process.env.DSH_HOME = dshHome
process.env.PATH = `${fakeBin}${process.env.PATH ? `:${process.env.PATH}` : ''}`

// --- SIMULATED live registry --------------------------------------------------

const CALLER = 'head-test-caller'
// Three INDEPENDENT callers for the inverse edge (scenarios 11-13): distinct
// `exec.agent.id`s over ONE SHARED `ctx.agents` snapshot, so each caller's own
// turn is excluded from its OWN guard check while it still counts for the other.
const WAITER_A = 'head-test-waiter-A'
const WAITER_B = 'head-test-waiter-B'
const FORCER_C = 'head-test-forcer-C'

let snapshot = []
let listCalls = 0
let otherAgentCalls = []
// PASSIVITY AT THE EDGE: the messaging handles of every listed agent are SPIES,
// and the session flush surface is instrumented — both are INVOCATION recorders
// (never a source/text scan), so "zero messaging / zero wakes / no flush" is a
// count of things actually CALLED, not of strings in this file.
let messagingCalls = []
let sessionsCalls = []

/** One agent as the live registry exposes it: the guard reads `id`/`status`;
 *  `followup`/`inject` (wake + delivery) are recorded if anything ever calls
 *  them on a LISTED handle. */
const agentHandle = (id, status) => ({
  id,
  status,
  followup: () => {
    messagingCalls.push(`followup:${id}`)
  },
  inject: () => {
    messagingCalls.push(`inject:${id}`)
  },
})
const running = (id) => agentHandle(id, 'running')
const idle = (id) => agentHandle(id, 'idle')

/** Install the script for the NEXT execute: successive `list()` reads return
 *  successive entries and the LAST repeats forever. */
function script(snapshots) {
  let reads = 0
  listCalls = 0
  otherAgentCalls = []
  messagingCalls = []
  sessionsCalls = []
  snapshot = snapshots
  return () => {
    const snap = snapshots[Math.min(reads, snapshots.length - 1)]
    reads += 1
    return snap
  }
}

/** A SHARED MUTABLE live registry for TWO CONCURRENT callers: every `list()`
 *  returns the CURRENT state, so a status flip mid-wait (or a second caller
 *  running its own `execute`) is observed by the OTHER caller's next poll. */
function liveRegistry(entries) {
  const state = new Map(entries)
  return {
    set: (id, status) => {
      state.set(id, status)
    },
    reader: () => [...state].map(([id, status]) => agentHandle(id, status)),
  }
}

let currentReader = script([[]])

// A minimal stub ctx covering the apply() surface the plugin touches. Every
// agent surface is instrumented: the wait may ONLY re-read `list()`.
const ctx = {
  on: () => {},
  effect: () => () => {},
  tools: {
    register: (tool) => {
      capturedTool = tool
      return () => {}
    },
  },
  agents: {
    get: (id) => {
      otherAgentCalls.push(`get:${id}`)
      return undefined
    },
    roots: () => {
      otherAgentCalls.push('roots')
      return []
    },
    list: () => {
      listCalls += 1
      return currentReader()
    },
  },
  sessions: {
    get: (id) => {
      sessionsCalls.push(`get:${String(id)}`)
      return undefined
    },
    flush: async (session) => {
      sessionsCalls.push(`flush:${session === undefined ? 'undefined' : 'session'}`)
    },
  },
}
let capturedTool = null

// --- the REAL plugin's log lines (tee'd: kept for the budget assertions AND
//     printed, so a run's stderr shows the wait/budget decomposition) --------

const warnLines = []
const origWarn = console.warn
console.warn = (...args) => {
  warnLines.push(args.map((a) => String(a)).join(' '))
  return origWarn(...args)
}

const { apply } = await import('../lib/index.js')
apply(ctx, {
  enabled: true,
  toolEnabled: true,
  stateDir: stateName,
  restartUnit: 'dsh-test.service',
  canaryRuntimeStateDir: runtimeStateDir,
  canary: false,
  // Scenarios 7-9 opt into the canary PER CALL (`canary: true`). The fake
  // `dsh` on PATH is the launch target (the fake `systemctl` derives nothing);
  // the post-boot checks that would read LIVE paths or probe unimplemented
  // endpoints are disabled so the harness stays hermetic — the client-graph
  // check (the default) still runs against the fake instance.
  canaryBinary: 'dsh',
  canaryClientCheck: true,
  canaryAgentCheck: false,
  canaryPoolerCheck: false,
  canaryMarkersCheck: false,
  canaryCatalogPath: join(root, 'no-catalog.json'),
})

if (!capturedTool || typeof capturedTool.execute !== 'function') {
  console.error('HARNESS:TOOL-CAPTURE-FAILED')
  process.exit(1)
}

const failures = []
function check(name, cond, detail) {
  if (!cond) failures.push(`${name}: ${detail}`)
  console.log(`SCEN:${name}:${cond ? 'PASS' : `FAIL — ${detail}`}`)
}

const killLines = () => {
  if (!existsSync(killLog)) return []
  return readFileSync(killLog, 'utf8').trim().split('\n').filter(Boolean)
}
const marker = () => (existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, 'utf8')) : null)
const pending = () => (existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')) : null)
const elapsedSince = (t0) => Date.now() - t0

/** Wait until the fake-kill log holds at least `n` lines (the spawn is
 *  fire-and-forget: the kill is spawned synchronously but the FAKE `setsid`
 *  writes its line a moment later). */
async function waitForKillLines(n, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const lines = killLines()
    if (lines.length >= n) return lines
    if (Date.now() > deadline) throw new Error(`fake-kill log did not reach ${n} lines within ${budgetMs}ms`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Grace window for a NO-SPAWN assertion: long enough that a kill the refused
 *  path wrongly spawned would already have logged itself. */
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

/** Canary ephemeral boots spawned through the fake `setsid` (`--port`). */
const bootLineCount = () => {
  if (!existsSync(bootLog)) return 0
  return readFileSync(bootLog, 'utf8').trim().split('\n').filter(Boolean).length
}

/** The tool's (B) budget line, parsed:
 *  `post-canary re-check: wait budget Nms — Ams waited at the guard, Cms
 *   canary window, Sms spent so far → Lms left`. */
function parseRecheckLine(log) {
  const m = /post-canary re-check: wait budget (\d+)ms — (\d+)ms waited at the guard, (\d+)ms canary window, (\d+)ms spent so far → (\d+)ms left/.exec(log)
  if (!m) return null
  return { cap: Number(m[1]), waited: Number(m[2]), canaryWindow: Number(m[3]), spent: Number(m[4]), left: Number(m[5]) }
}

/** The `waiting up to Nms` cap of the LAST wait start line = the post-canary
 *  re-check's cap (the guard stage's is the full budget). */
function lastWaitStartCap(log) {
  const caps = [...log.matchAll(/wait start: \d+ other session\(s\) mid-turn \([^)]*\) — waiting up to (\d+)ms/g)].map((m) => Number(m[1]))
  return caps.length === 0 ? null : caps[caps.length - 1]
}

const FB168_REFUSAL =
  'refusing to restart: 1 other session(s) mid-turn (worker-w1) — pass force:true to override'

// --- 1. `wait` ABSENT + mid-turn → immediate refusal (fb-168 unchanged) --------
{
  currentReader = script([[running(CALLER), running('worker-w1')]])
  const killsBefore = killLines().length
  const t0 = Date.now()
  const res = await capturedTool.execute({}, { agent: { id: CALLER } })
  const elapsed = elapsedSince(t0)
  await settle()
  check('wait-absent-immediate-refusal', res.ok === false && res.restarting === false && res.error === FB168_REFUSAL, JSON.stringify(res))
  check('wait-absent-inflight-list', Array.isArray(res.inFlight) && res.inFlight.length === 1 && res.inFlight[0] === 'worker-w1', JSON.stringify(res.inFlight))
  check('wait-absent-no-wait-fields', !('waitedMs' in res) && !('waitTimedOut' in res), JSON.stringify(res))
  check('wait-absent-immediate', elapsed < 250, `${elapsed}ms`)
  check('wait-absent-no-spawn', killLines().length === killsBefore, `kills ${killLines().length}`)
  check('wait-absent-no-partial-action', pending() === null && marker() === null, `${JSON.stringify(pending())} / ${JSON.stringify(marker())}`)
  check('wait-absent-registry-read-once', listCalls === 1 && otherAgentCalls.length === 0, `${listCalls} list / ${otherAgentCalls.join(',')}`)
}

// --- 2. `wait:true` + the registry RELEASES → restart proceeds -----------------
{
  currentReader = script([
    [running(CALLER), running('worker-w1')], // entry read: mid-turn
    [running(CALLER), idle('worker-w1')], // poll 1: the worker finished
  ])
  const killsBefore = killLines().length
  const t0 = Date.now()
  const res = await capturedTool.execute({ wait: true, waitMaxMs: 5_000, cause: 'deploy', reason: 'waited restart' }, { agent: { id: CALLER } })
  const elapsed = elapsedSince(t0)
  const kills = await waitForKillLines(killsBefore + 1)
  check('wait-releases-restart', res.ok === true && res.restarting === true && res.sessionId === CALLER, JSON.stringify(res))
  check('wait-releases-waited-report', typeof res.waitedMs === 'number' && res.waitedMs >= 1_000 && res.waitedMs < 4_000, `${res.waitedMs}`)
  check('wait-releases-no-timeout-flag', res.waitTimedOut === undefined, JSON.stringify(res))
  check('wait-releases-spawn', kills.length === killsBefore + 1, `kills ${kills.length}`)
  check('wait-releases-cause-marker', marker() !== null && marker().cause === 'deploy' && marker().reason === 'waited restart', JSON.stringify(marker()))
  check('wait-releases-notice-anchored', pending() !== null && pending().sessionId === CALLER, JSON.stringify(pending()))
  check('wait-releases-capped-wait', elapsed >= 1_000 && elapsed < 5_000, `${elapsed}ms`)
  check('wait-releases-passive', listCalls === 2 && otherAgentCalls.length === 0, `${listCalls} list / ${otherAgentCalls.join(',')}`)
}

// --- 3. `wait:true` + NEVER releases → timeout, the SAME refusal ---------------
{
  currentReader = script([[running(CALLER), running('worker-w1')]]) // repeats forever
  const killsBefore = killLines().length
  const pendingBefore = JSON.stringify(pending())
  const markerBefore = JSON.stringify(marker())
  const t0 = Date.now()
  const res = await capturedTool.execute({ wait: true, waitMaxMs: 300 }, { agent: { id: CALLER } })
  const elapsed = elapsedSince(t0)
  const killsAfter = killLines().length
  check('wait-timeout-same-refusal', res.ok === false && res.restarting === false && /^refusing to restart: 1 other session\(s\) mid-turn \(worker-w1\) — the wait expired after \d+ms with those session\(s\) still mid-turn; pass force:true to override$/.test(res.error), String(res.error))
  check('wait-timeout-flag', res.waitTimedOut === true && typeof res.waitedMs === 'number' && res.waitedMs >= 300 && res.waitedMs < 1_500, JSON.stringify(res))
  check('wait-timeout-inflight-list', Array.isArray(res.inFlight) && res.inFlight.length === 1 && res.inFlight[0] === 'worker-w1', JSON.stringify(res.inFlight))
  check('wait-timeout-cap-respected', elapsed >= 300 && elapsed < 1_500, `${elapsed}ms`)
  check('wait-timeout-no-spawn', killsAfter === killsBefore, `kills ${killsAfter} (before ${killsBefore})`)
  check('wait-timeout-no-partial-action', JSON.stringify(pending()) === pendingBefore && JSON.stringify(marker()) === markerBefore, 'a refused wait must persist nothing')
  check('wait-timeout-passive', listCalls === 2 && otherAgentCalls.length === 0, `${listCalls} list / ${otherAgentCalls.join(',')}`)
}

// --- 4. `force:true` WINS over `wait:true` (no waiting) ------------------------
{
  currentReader = script([[running(CALLER), running('worker-w1'), running('worker-w2')]])
  const killsBefore = killLines().length
  const t0 = Date.now()
  const res = await capturedTool.execute({ wait: true, force: true }, { agent: { id: CALLER } })
  const elapsed = elapsedSince(t0)
  const kills = await waitForKillLines(killsBefore + 1)
  check('force-wins-no-wait', res.ok === true && res.restarting === true && !('waitedMs' in res), JSON.stringify(res))
  check('force-wins-immediate', elapsed < 250, `${elapsed}ms`)
  check('force-wins-spawn', kills.length === killsBefore + 1, `kills ${kills.length}`)
  check('force-wins-single-registry-read', listCalls === 1 && otherAgentCalls.length === 0, `${listCalls} list / ${otherAgentCalls.join(',')}`)
}

// --- 5. `wait:true` + already idle → no waiting at all ------------------------
{
  currentReader = script([[running(CALLER), idle('worker-w1')]])
  const killsBefore = killLines().length
  const t0 = Date.now()
  const res = await capturedTool.execute({ wait: true }, { agent: { id: CALLER } })
  const elapsed = elapsedSince(t0)
  const kills = await waitForKillLines(killsBefore + 1)
  check('already-idle-restart', res.ok === true && res.restarting === true && !('waitedMs' in res), JSON.stringify(res))
  check('already-idle-immediate', elapsed < 250, `${elapsed}ms`)
  check('already-idle-spawn', kills.length === killsBefore + 1, `kills ${kills.length}`)
  check('already-idle-single-read', listCalls === 1 && otherAgentCalls.length === 0, `${listCalls} list / ${otherAgentCalls.join(',')}`)
}

// --- 6. an INVALID waitMaxMs falls back to the default (never unbounded) ------
{
  currentReader = script([[running(CALLER), idle('worker-w1')]])
  const killsBefore = killLines().length
  const res = await capturedTool.execute({ wait: true, waitMaxMs: -1 }, { agent: { id: CALLER } })
  const kills = await waitForKillLines(killsBefore + 1)
  check('invalid-cap-falls-back', res.ok === true && !('waitedMs' in res), JSON.stringify(res))
  check('invalid-cap-spawn', kills.length === killsBefore + 1, `kills ${kills.length}`)
  check('invalid-cap-passive', listCalls === 1 && otherAgentCalls.length === 0, `${listCalls} list / ${otherAgentCalls.join(',')}`)
}

// --- 7. TRAMO (B) — the canary window consumes budget, the re-check gets the
//        REST (the ceiling is never doubled: total waitedMs ≤ waitMaxMs) -----
//
// The point-5 proof. The canary REALLY runs (fake `dsh` boot, delayed by
// FAKE_DSH_BOOT_DELAY_MS = the canary window) and a NEW session (worker-w2)
// starts a turn while it boots — exactly the fb-677/fb-694 window. The
// re-check therefore has work to do, but only with the REMAINING budget.
{
  const CAP = 4_000
  process.env.FAKE_DSH_BOOT_DELAY_MS = '1200'
  // reads: 1 guard entry (mid-turn) → 2 guard poll (released) →
  //        3 re-check entry (worker-w2 started a turn during the canary) →
  //        4 re-check poll (released) → the restart proceeds.
  currentReader = script([
    [running(CALLER), running('worker-w1')],
    [running(CALLER), idle('worker-w1')],
    [running(CALLER), idle('worker-w1'), running('worker-w2')],
    [running(CALLER), idle('worker-w1'), idle('worker-w2')],
  ])
  const killsBefore = killLines().length
  const bootsBefore = bootLineCount()
  warnLines.length = 0
  const t0 = Date.now()
  const res = await capturedTool.execute({ wait: true, waitMaxMs: CAP, canary: true }, { agent: { id: CALLER } })
  const windowMs = elapsedSince(t0)
  const kills = await waitForKillLines(killsBefore + 1)
  const log = warnLines.join('\n')

  const recheck = parseRecheckLine(log) // {cap, waited, canaryWindow, spent, left}
  const recheckCap = lastWaitStartCap(log)
  console.log(
    `BUDGET:total cap=${CAP}ms guard=${recheck?.waited}ms canaryWindow=${recheck?.canaryWindow}ms spent=${recheck?.spent}ms ` +
      `recheckCap=${recheckCap}ms recheckLeft=${recheck?.left}ms waitedMs=${res.waitedMs}ms wall=${windowMs}ms ` +
      `=> waitedMs<=cap:${typeof res.waitedMs === 'number' && res.waitedMs <= CAP}`,
  )

  check('canary-budget-restart-proceeds', res.ok === true && res.restarting === true && res.canary === 'passed', JSON.stringify(res))
  check('canary-budget-spawn', kills.length === killsBefore + 1, `kills ${kills.length}`)
  check('canary-budget-one-boot', bootLineCount() === bootsBefore + 1, `boots ${bootLineCount()}`)
  // ⭐ The headline: the whole deferral (guard + canary window + re-check) fits
  // the caller's cap — a doubled ceiling would allow up to 2x.
  check(
    'canary-budget-total-not-doubled',
    typeof res.waitedMs === 'number' && res.waitedMs <= CAP,
    `waitedMs=${res.waitedMs} cap=${CAP} (a doubled ceiling would allow up to ${2 * CAP})`,
  )
  // The budget arithmetic is EXACT (no millisecond guessing): the re-check's
  // cap is `max(0, waitMaxMs - spent)`, and it is never the full cap again.
  check(
    'canary-budget-recheck-gets-remainder',
    recheck !== null && recheck.cap === CAP && recheck.left === Math.max(0, CAP - recheck.spent) && recheck.left < CAP,
    `recheck=${JSON.stringify(recheck)}`,
  )
  // The canary window/flush were REALLY charged (spent = the whole deferral
  // window since the wait opened, never less than the wait itself).
  check(
    'canary-budget-canary-window-charged',
    recheck !== null && recheck.canaryWindow >= 700 && recheck.spent >= recheck.waited,
    `canaryWindow=${recheck?.canaryWindow}ms spent=${recheck?.spent}ms waited=${recheck?.waited}ms`,
  )
  check(
    'canary-budget-recheck-start-line-capped',
    recheckCap === null || recheckCap < CAP,
    `re-check wait start cap: ${recheckCap} (the full cap would be ${CAP})`,
  )
  // ACCUMULATED accounting: the outcome carries guard + re-check, so it grew
  // by (at least) what the re-check could actually sleep.
  check(
    'canary-budget-waited-is-accumulated',
    recheck !== null &&
      typeof res.waitedMs === 'number' &&
      res.waitedMs >= recheck.waited + Math.min(1_000, recheck.left),
    `waitedMs=${res.waitedMs} guard=${recheck?.waited} recheckLeft=${recheck?.left} (the outcome carries guard + re-check)`,
  )
  check('canary-budget-passive', listCalls === 4 && otherAgentCalls.length === 0, `${listCalls} list / ${otherAgentCalls.join(',')}`)
}

// --- 8. TRAMO (B) — the canary window spends the WHOLE budget: the re-check
//        refuses IMMEDIATELY (no zero-length wait), same loud refusal --------
{
  const CAP = 2_000
  process.env.FAKE_DSH_BOOT_DELAY_MS = '1200'
  // The guard stage itself spends the cap (2 polls, released at the 2nd):
  // 1 entry (mid-turn) → 2 poll (still mid-turn) → 3 poll (released) →
  // 4 re-check read (worker-w2 mid-turn, budget GONE).
  currentReader = script([
    [running(CALLER), running('worker-w1')],
    [running(CALLER), running('worker-w1')],
    [running(CALLER), idle('worker-w1')],
    [running(CALLER), idle('worker-w1'), running('worker-w2')],
  ])
  const killsBefore = killLines().length
  const pendingBefore = JSON.stringify(pending())
  const markerBefore = JSON.stringify(marker())
  warnLines.length = 0
  const res = await capturedTool.execute({ wait: true, waitMaxMs: CAP, canary: true }, { agent: { id: CALLER } })
  await settle()
  const log = warnLines.join('\n')
  const recheck = parseRecheckLine(log)
  console.log(
    `BUDGET:exhausted cap=${CAP}ms guard=${recheck?.waited}ms canaryWindow=${recheck?.canaryWindow}ms spent=${recheck?.spent}ms ` +
      `recheckLeft=${recheck?.left}ms waitedMs=${res.waitedMs}ms`,
  )
  check(
    'canary-exhausted-same-refusal',
    res.ok === false &&
      res.restarting === false &&
      /^refusing to restart: 1 other session\(s\) mid-turn \(worker-w2\) — the wait expired after \d+ms with those session\(s\) still mid-turn; pass force:true to override$/.test(res.error),
    String(res.error),
  )
  check('canary-exhausted-flag', res.waitTimedOut === true && typeof res.waitedMs === 'number' && res.waitedMs <= CAP + 50, JSON.stringify(res))
  check('canary-exhausted-inflight', Array.isArray(res.inFlight) && res.inFlight[0] === 'worker-w2', JSON.stringify(res.inFlight))
  check('canary-exhausted-no-zero-length-wait', recheck !== null && recheck.left === 0 && /refusing now \(no zero-length wait\)/.test(log), `left=${recheck?.left}`)
  check('canary-exhausted-no-spawn', killLines().length === killsBefore, `kills ${killLines().length}`)
  check('canary-exhausted-no-partial-action', JSON.stringify(pending()) === pendingBefore && JSON.stringify(marker()) === markerBefore, 'a refused re-check must persist nothing')
  check('canary-exhausted-passive', listCalls === 4 && otherAgentCalls.length === 0, `${listCalls} list / ${otherAgentCalls.join(',')}`)
}

// --- 9. TRAMO (B) — the re-check spends its REMAINDER and the sessions never
//        release → the same refusal, ACCUMULATED wait, still ≤ the cap -------
{
  const CAP = 4_000
  process.env.FAKE_DSH_BOOT_DELAY_MS = '1200'
  currentReader = script([
    [running(CALLER), running('worker-w1')],
    [running(CALLER), idle('worker-w1')],
    [running(CALLER), idle('worker-w1'), running('worker-w2')], // never releases
  ])
  const killsBefore = killLines().length
  const pendingBefore = JSON.stringify(pending())
  const markerBefore = JSON.stringify(marker())
  warnLines.length = 0
  const t0 = Date.now()
  const res = await capturedTool.execute({ wait: true, waitMaxMs: CAP, canary: true }, { agent: { id: CALLER } })
  const windowMs = elapsedSince(t0)
  await settle()
  const log = warnLines.join('\n')
  const recheck = parseRecheckLine(log)
  console.log(
    `BUDGET:recheck-timeout cap=${CAP}ms guard=${recheck?.waited}ms canaryWindow=${recheck?.canaryWindow}ms spent=${recheck?.spent}ms ` +
      `recheckLeft=${recheck?.left}ms waitedMs=${res.waitedMs}ms wall=${windowMs}ms`,
  )
  check(
    'canary-recheck-timeout-same-refusal',
    res.ok === false &&
      res.restarting === false &&
      /^refusing to restart: 1 other session\(s\) mid-turn \(worker-w2\) — the wait expired after \d+ms with those session\(s\) still mid-turn; pass force:true to override$/.test(res.error),
    String(res.error),
  )
  check(
    'canary-recheck-timeout-accumulated',
    recheck !== null &&
      typeof res.waitedMs === 'number' &&
      res.waitedMs >= recheck.waited + Math.min(1_000, recheck.left) &&
      res.waitedMs <= CAP,
    `waitedMs=${res.waitedMs} guard=${recheck?.waited} recheckLeft=${recheck?.left} cap=${CAP}`,
  )
  check('canary-recheck-timeout-flag', res.waitTimedOut === true, JSON.stringify(res))
  check('canary-recheck-timeout-no-spawn', killLines().length === killsBefore, `kills ${killLines().length}`)
  check('canary-recheck-timeout-no-partial-action', JSON.stringify(pending()) === pendingBefore && JSON.stringify(marker()) === markerBefore, 'a refused re-check must persist nothing')
  check(
    'canary-recheck-timeout-passive',
    listCalls >= 3 && listCalls <= 8 && otherAgentCalls.length === 0,
    `${listCalls} list / ${otherAgentCalls.join(',')}`,
  )
}

// --- 10. TRAMO (B) — the budget is spent BUT the registry is idle at the
//         re-check → the restart PROCEEDS (an exhausted budget never refuses
//         work that is no longer there: the decision is the state, not the
//         clock) ------------------------------------------------------------
{
  const CAP = 2_000
  process.env.FAKE_DSH_BOOT_DELAY_MS = '1200'
  currentReader = script([
    [running(CALLER), running('worker-w1')],
    [running(CALLER), running('worker-w1')],
    [running(CALLER), idle('worker-w1')], // guard stage releases at the cap
    [running(CALLER), idle('worker-w1')], // re-check read: nothing mid-turn
  ])
  const killsBefore = killLines().length
  warnLines.length = 0
  const res = await capturedTool.execute({ wait: true, waitMaxMs: CAP, canary: true }, { agent: { id: CALLER } })
  const kills = await waitForKillLines(killsBefore + 1)
  const log = warnLines.join('\n')
  const recheck = parseRecheckLine(log)
  console.log(
    `BUDGET:spent-but-idle cap=${CAP}ms guard=${recheck?.waited}ms canaryWindow=${recheck?.canaryWindow}ms spent=${recheck?.spent}ms ` +
      `recheckLeft=${recheck?.left}ms waitedMs=${res.waitedMs}ms`,
  )
  check('canary-spent-idle-proceeds', res.ok === true && res.restarting === true && res.canary === 'passed', JSON.stringify(res))
  check('canary-spent-idle-spawn', kills.length === killsBefore + 1, `kills ${kills.length}`)
  check(
    'canary-spent-idle-no-extra-wait',
    recheck !== null && recheck.left === 0 && !/BLOCKED at the post-canary re-check/.test(log) && (log.match(/wait start:/g) ?? []).length === 1,
    `left=${recheck?.left} waitStarts=${(log.match(/wait start:/g) ?? []).length}`,
  )
  check(
    'canary-spent-idle-waited-is-guard-only',
    recheck !== null && typeof res.waitedMs === 'number' && res.waitedMs <= CAP + 50,
    `waitedMs=${res.waitedMs} guard=${recheck?.waited} cap=${CAP}`,
  )
  check('canary-spent-idle-passive', listCalls === 4 && otherAgentCalls.length === 0, `${listCalls} list / ${otherAgentCalls.join(',')}`)
}

// --- 11. (a1) TWO WAITERS, MUTUAL — the INVERSE edge: A and B are BOTH mid-turn
//         and BOTH wait: each defers on the other. The guard is per CALLING
//         SESSION (`activeAgentGuard`: `String(a.id) !== callingSessionId`), so
//         a caller's OWN turn never waits for itself — but it IS the other
//         caller's in-flight entry. Prediction: bounded livelock (both expire at
//         the cap with the SAME loud refusal), NEVER a deadlock. Measured here
//         with TWO concurrent executes over ONE shared registry. -------------
{
  const CAP = 400
  const reg = liveRegistry([
    [WAITER_A, 'running'],
    [WAITER_B, 'running'],
  ])
  currentReader = reg.reader
  listCalls = 0
  otherAgentCalls = []
  messagingCalls = []
  sessionsCalls = []
  const killsBefore = killLines().length
  const pendingBefore = JSON.stringify(pending())
  const markerBefore = JSON.stringify(marker())
  warnLines.length = 0
  const t0 = Date.now()
  // BOTH started in the same tick (each `execute` runs synchronously to its
  // first await), so both ENTRY reads see A AND B running: the genuinely mutual
  // edge — neither caller's check can see an idle registry.
  const [resA, resB] = await Promise.all([
    capturedTool.execute({ wait: true, waitMaxMs: CAP }, { agent: { id: WAITER_A } }),
    capturedTool.execute({ wait: true, waitMaxMs: CAP }, { agent: { id: WAITER_B } }),
  ])
  const windowMs = elapsedSince(t0)
  await settle()
  const killsAfter = killLines().length
  const EXPIRY_RE =
    /^refusing to restart: 1 other session\(s\) mid-turn \((head-test-waiter-[AB])\) — the wait expired after (\d+)ms with those session\(s\) still mid-turn; pass force:true to override$/
  const matchA = EXPIRY_RE.exec(String(resA.error))
  const matchB = EXPIRY_RE.exec(String(resB.error))
  console.log(
    `WAITERS:mutual cap=${CAP}ms wall=${windowMs}ms ` +
      `A(waitedMs=${resA.waitedMs},inFlight=${JSON.stringify(resA.inFlight)}) ` +
      `B(waitedMs=${resB.waitedMs},inFlight=${JSON.stringify(resB.inFlight)}) ` +
      `A-blames=${matchA?.[1]} B-blames=${matchB?.[1]} ` +
      `list=${listCalls} agents-get/roots=${otherAgentCalls.length} sessions=${sessionsCalls.length} messaging=${messagingCalls.length} ` +
      `kills=${killsAfter - killsBefore}\n` +
      `WAITERS:mutual-refusals A="${String(resA.error)}" B="${String(resB.error)}"`,
  )
  check(
    'two-waiters-mutual-both-refuse',
    resA.ok === false && resA.restarting === false && resB.ok === false && resB.restarting === false,
    `A=${JSON.stringify(resA)} B=${JSON.stringify(resB)}`,
  )
  // THE HEADLINE (a1): the SAME rejection on BOTH sides, each naming the OTHER —
  // no deadlock, no silent wait, no partial restart.
  check(
    'two-waiters-mutual-same-loud-expiry',
    matchA !== null && matchB !== null && matchA[1] === WAITER_B && matchB[1] === WAITER_A,
    `A="${String(resA.error)}" | B="${String(resB.error)}"`,
  )
  check(
    'two-waiters-mutual-other-only-in-flight',
    JSON.stringify(resA.inFlight) === JSON.stringify([WAITER_B]) && JSON.stringify(resB.inFlight) === JSON.stringify([WAITER_A]),
    `A=${JSON.stringify(resA.inFlight)} B=${JSON.stringify(resB.inFlight)} (a caller NEVER lists its own turn)`,
  )
  check(
    'two-waiters-mutual-both-flagged-expired',
    resA.waitTimedOut === true &&
      resB.waitTimedOut === true &&
      typeof resA.waitedMs === 'number' &&
      typeof resB.waitedMs === 'number' &&
      resA.waitedMs >= CAP - 50 &&
      resB.waitedMs >= CAP - 50,
    `A=${JSON.stringify(resA)} B=${JSON.stringify(resB)}`,
  )
  check(
    'two-waiters-mutual-both-waited-concurrently',
    windowMs >= CAP && windowMs < CAP * 4,
    `wall ${windowMs}ms for cap ${CAP}ms (a serialized or immediate refusal would be far below the cap)`,
  )
  check('two-waiters-mutual-no-spawn', killsAfter === killsBefore, `kills ${killsAfter} (before ${killsBefore})`)
  check(
    'two-waiters-mutual-no-partial-action',
    JSON.stringify(pending()) === pendingBefore && JSON.stringify(marker()) === markerBefore,
    'a mutual expiry must persist nothing (no pending notice, no marker)',
  )
  // (a3) PASSIVITY AT THE EDGE — invocation counters, not a text/source scan:
  // the ONLY surface either caller touched is `ctx.agents.list()`.
  check(
    'two-waiters-passive-only-list',
    listCalls >= 4 && listCalls <= 6 && otherAgentCalls.length === 0,
    `${listCalls} list() (2 entry reads + 1 poll each) / agents.get|roots: ${otherAgentCalls.join(',') || 'none'}`,
  )
  check(
    'two-waiters-passive-no-messaging-no-wake-no-flush',
    messagingCalls.length === 0 && sessionsCalls.length === 0,
    `messaging [${messagingCalls.join(',')}] sessions [${sessionsCalls.join(',')}]`,
  )
}

// --- 12. (a2) ONE WAITS, THE OTHER CLOSES — the release is not symmetric: B
//         defers on a SHORT cap and gives up (its turn ENDS there: the registry
//         flips B to idle when B's execute settles), which is what UNBLOCKS A.
//         A really restarts and its `waitedMs` reflects the real elapsed time.
{
  const A_CAP = 5_000
  const B_CAP = 400
  const reg = liveRegistry([
    [WAITER_A, 'running'],
    [WAITER_B, 'running'],
  ])
  currentReader = reg.reader
  listCalls = 0
  otherAgentCalls = []
  messagingCalls = []
  sessionsCalls = []
  const killsBefore = killLines().length
  warnLines.length = 0
  const t0 = Date.now()
  const bPromise = capturedTool
    .execute({ wait: true, waitMaxMs: B_CAP }, { agent: { id: WAITER_B } })
    .then((res) => {
      reg.set(WAITER_B, 'idle')
      return res
    })
  const aPromise = capturedTool.execute({ wait: true, waitMaxMs: A_CAP }, { agent: { id: WAITER_A } })
  const [resA, resB] = await Promise.all([aPromise, bPromise])
  const windowMs = elapsedSince(t0)
  const kills = await waitForKillLines(killsBefore + 1)
  const log = warnLines.join('\n')
  console.log(
    `WAITERS:release A_cap=${A_CAP}ms B_cap=${B_CAP}ms wall=${windowMs}ms ` +
      `A(ok=${resA.ok},waitedMs=${resA.waitedMs}) B(ok=${resB.ok},waitTimedOut=${resB.waitTimedOut},inFlight=${JSON.stringify(resB.inFlight)}) ` +
      `list=${listCalls} agents-get/roots=${otherAgentCalls.length} messaging=${messagingCalls.length} kills=${kills.length - killsBefore}\n` +
      `WAITERS:release-refusal B="${String(resB.error)}"`,
  )
  check(
    'two-waiters-release-B-expires-naming-A',
    resB.ok === false && resB.waitTimedOut === true && JSON.stringify(resB.inFlight) === JSON.stringify([WAITER_A]),
    JSON.stringify(resB),
  )
  check(
    'two-waiters-release-A-restarts',
    resA.ok === true && resA.restarting === true && resA.sessionId === WAITER_A && resA.waitTimedOut === undefined,
    JSON.stringify(resA),
  )
  // `waitedMs` is the REAL elapsed deferral: B released at ~400ms, A polls every
  // 1000ms → A proceeds on its first poll (≈1000ms), never at t=0 and never at
  // the cap.
  check(
    'two-waiters-release-A-waited-real-time',
    typeof resA.waitedMs === 'number' &&
      resA.waitedMs >= 900 &&
      resA.waitedMs <= windowMs &&
      resA.waitedMs < A_CAP,
    `A waitedMs=${resA.waitedMs} wall=${windowMs}ms (B released at ~${B_CAP}ms, poll ${1_000}ms, cap ${A_CAP}ms)`,
  )
  check('two-waiters-release-spawn', kills.length === killsBefore + 1, `kills ${kills.length}`)
  check('two-waiters-release-notice-anchored', pending() !== null && pending().sessionId === WAITER_A, JSON.stringify(pending()))
  check(
    'two-waiters-release-log-names-the-released-peer',
    /wait end: registry IDLE after \d+ms \(\d+ poll\(s\)\) — released: head-test-waiter-B; proceeding with the restart/.test(log),
    log
      .split('\n')
      .filter((l) => /wait (start|end)/.test(l))
      .join(' | '),
  )
  check(
    'two-waiters-release-passive',
    otherAgentCalls.length === 0 && messagingCalls.length === 0,
    `agents.get|roots: ${otherAgentCalls.join(',') || 'none'} / messaging: ${messagingCalls.join(',') || 'none'}`,
  )
}

// --- 13. (a4) DERIVED — the ESCAPE HATCH during a mutual wait: while A and B
//         are BOTH stuck waiting on each other, a THIRD caller with `force:true`
//         restarts IMMEDIATELY (no wait at all) and A/B still expire. The
//         bounded-cap livelock always has an exit; `force` is never queued
//         behind other waiters.
{
  const CAP = 1_500
  const reg = liveRegistry([
    [WAITER_A, 'running'],
    [WAITER_B, 'running'],
  ])
  currentReader = reg.reader
  listCalls = 0
  otherAgentCalls = []
  messagingCalls = []
  sessionsCalls = []
  const killsBefore = killLines().length
  warnLines.length = 0
  const t0 = Date.now()
  const aPromise = capturedTool.execute({ wait: true, waitMaxMs: CAP }, { agent: { id: WAITER_A } })
  const bPromise = capturedTool.execute({ wait: true, waitMaxMs: CAP }, { agent: { id: WAITER_B } })
  // Give both waits a real head start so the force call lands INSIDE them.
  await settle(300)
  const tForce = Date.now()
  const resC = await capturedTool.execute({ force: true }, { agent: { id: FORCER_C } })
  const forceMs = elapsedSince(tForce)
  const kills = await waitForKillLines(killsBefore + 1)
  const [resA, resB] = await Promise.all([aPromise, bPromise])
  const windowMs = elapsedSince(t0)
  await settle()
  const EXPIRY_RE =
    /^refusing to restart: 1 other session\(s\) mid-turn \((head-test-waiter-[AB])\) — the wait expired after \d+ms with those session\(s\) still mid-turn; pass force:true to override$/
  const matchA = EXPIRY_RE.exec(String(resA.error))
  const matchB = EXPIRY_RE.exec(String(resB.error))
  console.log(
    `WAITERS:force-during-mutual cap=${CAP}ms forceMs=${forceMs}ms wall=${windowMs}ms ` +
      `C(ok=${resC.ok},sessionId=${resC.sessionId},waitedMs=${resC.waitedMs}) ` +
      `A(ok=${resA.ok},blames=${matchA?.[1]}) B(ok=${resB.ok},blames=${matchB?.[1]}) kills=${kills.length - killsBefore}`,
  )
  check(
    'two-waiters-force-escapes-immediately',
    resC.ok === true && resC.restarting === true && resC.sessionId === FORCER_C && !('waitedMs' in resC),
    `${JSON.stringify(resC)} (force never waits)`,
  )
  check('two-waiters-force-is-immediate', forceMs < 250, `${forceMs}ms while A and B were mid-wait`)
  check('two-waiters-force-spawn', kills.length === killsBefore + 1, `kills ${kills.length}`)
  check('two-waiters-force-notice-anchored', pending() !== null && pending().sessionId === FORCER_C, JSON.stringify(pending()))
  check(
    'two-waiters-force-leaves-both-waiters-expiring',
    matchA !== null && matchA[1] === WAITER_B && matchB !== null && matchB[1] === WAITER_A && resA.ok === false && resB.ok === false,
    `A="${String(resA.error)}" | B="${String(resB.error)}"`,
  )
  check(
    'two-waiters-force-passive',
    otherAgentCalls.length === 0 && messagingCalls.length === 0,
    `agents.get|roots: ${otherAgentCalls.join(',') || 'none'} / messaging: ${messagingCalls.join(',') || 'none'} / sessions: ${sessionsCalls.join(',') || 'none'}`,
  )
}

console.log(failures.length === 0 ? 'ALL:PASS' : `ALL:FAIL (${failures.length})`)
try {
  rmSync(root, { recursive: true, force: true })
} catch {
  // best-effort cleanup
}
process.exit(failures.length === 0 ? 0 : 1)
