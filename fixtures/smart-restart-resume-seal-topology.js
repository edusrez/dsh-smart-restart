// Child-process harness for the fb-2418 (b) SEAL lane (test/resume-seal.test.js
// drives it, the restart-reason-topology.js / smart-restart-wait-topology.js
// pattern): boots the REAL plugin (lib/index.js `apply`) with a minimal stub
// cordis ctx, writes a REAL shutdown-notice.json (the durable document the
// SIGTERM handler persists) plus REAL catalog documents, and captures the
// notice the plugin ACTUALLY delivers to each session that resumes.
//
// THE HISTORICAL CASE, reproduced with the real ids of 2026-09-22:
//  - `quality-head` ROTATED from `9e1cc8b2` (outgoing) to `a352f359`
//    (incumbent): posts.json lists ONLY the incumbent, exactly as it did live;
//  - the outgoing session was ALSO alive at shutdown, so the notice's
//    interrupted list carried BOTH sessions of the same seat;
//  - the live notice rendered both of them `(main)`, indistinguishably.
//
// Scenarios:
//  1. notice-seals-the-two-same-seat-sessions — the notice text carries DISTINCT
//     seals: `[seat quality-head]` for the incumbent and
//     `[seat quality-head superseded by <incumbent>]` for the outgoing session.
//  2. write-yes-messaging-no — THE ACCEPTANCE CRITERION: the outgoing session
//     (a) is STILL a delivery recipient (its resume notice is delivered — the
//     write/notification is NOT blocked), while (b) the notice text AND the
//     boot log seal it as superseded, i.e. its signature is distinguishable
//     from the incumbent's — attributable without being suppressed.
//  3. unmeasured-catalog-degrades-honestly — with NO readable catalog the labels
//     fall back to the pre-change shape (no seal is fabricated: "could not
//     measure" is never rendered as "not a member").
//
// Everything is sandboxed under one tmpdir: DSH_HOME (the plugin's marker home),
// the catalog documents, and the stub registry. No dsh service, no systemd, no
// /opt/dsh, no live profile state — hermetic after `npm run build`.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'resume-seal-harness-'))
const dshHome = join(root, 'dsh-home')
const stateName = 'state'
const markerDir = join(dshHome, stateName)
const catalogDir = join(root, 'deepartments')
const postsPath = join(catalogDir, 'posts.json')
const hostsPath = join(catalogDir, 'hosts.json')
mkdirSync(markerDir, { recursive: true })
mkdirSync(catalogDir, { recursive: true })

// --- the actors (the live ids of 2026-09-22) ---------------------------------

const SEAT_POST = 'quality-head'
const INCUMBENT = 'head-quality-head-a352f359-131e-4495-b582-398296b0085c'
const OUTGOING = 'head-quality-head-9e1cc8b2-59dc-4626-99fc-9d99413ee7ca'
const OTHER_HEAD = 'head-research-head-b756e371-8b2c-4bea-90e8-21f2aec77d4c'
const HOST_SESSION = 'session-15f80d86-e1d6-4e0f-8ab5-51d165cf6e69'
const HOST_KEY = `host-${HOST_SESSION}`

// posts.json lists ONLY the incumbent for the seat (the live shape).
const POSTS = {
  [SEAT_POST]: {
    sessionId: INCUMBENT,
    roomId: 'board',
    agentPreset: 'deepartments-head-quality',
  },
  'research-head': {
    sessionId: OTHER_HEAD,
    roomId: 'board',
    agentPreset: 'deepartments-head-research',
  },
}
const HOSTS = {
  schemaVersion: 2,
  [HOST_KEY]: { sessionId: HOST_SESSION, roomId: 'board' },
}
writeFileSync(postsPath, JSON.stringify(POSTS, null, 2))
writeFileSync(hostsPath, JSON.stringify(HOSTS, null, 2))

process.env.DSH_HOME = dshHome

// --- the REAL shutdown document the SIGTERM handler would have written -------
// every session active within the grace window at shutdown, INCLUDING the
// outgoing predecessor (that is exactly what happened live).
const shutdownDoc = {
  lastSessionId: INCUMBENT,
  lastActiveAt: new Date().toISOString(),
  when: new Date().toISOString(),
  sessions: [
    { id: OTHER_HEAD, lastActiveAt: new Date().toISOString() },
    { id: INCUMBENT, lastActiveAt: new Date().toISOString() },
    { id: OUTGOING, lastActiveAt: new Date().toISOString() },
  ],
}
writeFileSync(join(markerDir, 'shutdown-notice.json'), JSON.stringify(shutdownDoc, null, 2))

// A bootMarker written by a DIFFERENT pid ⇒ this boot IS a restart.
writeFileSync(
  join(markerDir, 'marker.json'),
  JSON.stringify({ lastBootAt: new Date(Date.now() - 200_000).toISOString(), pid: process.pid + 1 }),
)

// --- the stub registry: every interrupted session comes live at this boot ----
// Each handle records the followup/inject deliveries (the "messaging" side).
const delivered = []
const liveIds = [HOST_SESSION, OTHER_HEAD, INCUMBENT, OUTGOING]
const agents = liveIds.map((id) => ({
  id,
  status: 'idle',
  followup: (msg) => {
    delivered.push({ id, via: 'followup', text: msg.content.map((c) => c.text).join('') })
  },
  inject: (msg) => {
    delivered.push({ id, via: 'inject', text: msg.content.map((c) => c.text).join('') })
  },
}))
const byId = new Map(agents.map((a) => [String(a.id), a]))

const events = {}
const ctx = {
  on: (name, fn) => {
    events[name] = fn
  },
  effect: () => () => {},
  tools: { register: () => () => {} },
  agents: {
    get: (id) => byId.get(String(id)),
    roots: () => agents,
    list: () => agents,
  },
  sessions: { get: () => undefined, flush: async () => {} },
}

// Capture the plugin's boot log (the second, machine-readable seal surface).
// Only ACTIVE while an apply() runs, so the harness's own SCEN lines still
// reach the test runner's stdout.
const logLines = []
let capturing = false
const origLog = console.log
console.log = (...args) => {
  if (capturing) {
    logLines.push(args.map((a) => String(a)).join(' '))
    return
  }
  origLog(...args)
}

const { apply } = await import('../lib/index.js')

/** Boot ONE instance with the given catalog path and deliver to every session
 *  the plugin notifies for this boot. Returns the captured deliveries + log. */
function bootWith(catalogPath) {
  delivered.length = 0
  logLines.length = 0
  // The shutdown document is CONSUMED (unlinked) by each boot — re-write it so
  // every scenario starts from the same real post-SIGTERM state.
  writeFileSync(join(markerDir, 'shutdown-notice.json'), JSON.stringify(shutdownDoc, null, 2))
  writeFileSync(
    join(markerDir, 'marker.json'),
    JSON.stringify({ lastBootAt: new Date(Date.now() - 200_000).toISOString(), pid: process.pid + 1 }),
  )
  capturing = true
  apply(ctx, {
    enabled: true,
    toolEnabled: false,
    stateDir: stateName,
    target: 'all',
    wakeup: true,
    ignoredSessionPrefixes: ['head-', 'worker-'],
    canaryCatalogPath: catalogPath,
  })
  // The interrupted-head resume delivery happens on `agent/session-start`
  // (source-agnostic for an interrupted head) — publish it for each session.
  const sessionStart = events['agent/session-start']
  if (typeof sessionStart === 'function') {
    for (const agent of agents) sessionStart({ agent, source: 'resume' })
  }
  capturing = false
}

const failures = []
function check(name, cond, detail) {
  if (!cond) failures.push(`${name}: ${detail}`)
  console.log(`SCEN:${name}:${cond ? 'PASS' : `FAIL — ${detail}`}`)
}

const textFor = (id) => {
  const row = delivered.filter((d) => d.id === id)
  return row.length > 0 ? row.map((r) => r.text).join('\n') : null
}

// --- scenario 1 + 2: the real catalog (both documents present) --------------
bootWith(postsPath)

const incNotice = textFor(INCUMBENT)
const outNotice = textFor(OUTGOING)

check(
  'outgoing-session-still-notified',
  outNotice !== null,
  `the outgoing session received NO notice (delivered to: ${delivered.map((d) => d.id).join(', ') || 'nobody'})`,
)
check(
  'incumbent-still-notified',
  incNotice !== null,
  `the incumbent received NO notice (delivered to: ${delivered.map((d) => d.id).join(', ') || 'nobody'})`,
)

if (incNotice !== null && outNotice !== null) {
  // The notice's interrupted list must carry BOTH sessions of the seat…
  check(
    'notice-lists-both-sessions-of-the-seat',
    incNotice.includes(INCUMBENT) && incNotice.includes(OUTGOING),
    `one of the two same-seat sessions is missing from the notice text`,
  )
  // …and give them DISTINCT seals (the defect: both rendered `(main)`).
  const incSeal = `[seat ${SEAT_POST}]`
  const outSeal = `[seat ${SEAT_POST} superseded by ${INCUMBENT}]`
  check(
    'notice-seals-the-two-same-seat-sessions',
    incNotice.includes(incSeal) && outNotice.includes(outSeal) && incSeal !== outSeal,
    `incumbent notice had "${incSeal}": ${incNotice.includes(incSeal)} / outgoing notice had "${outSeal}": ${outNotice.includes(outSeal)}`,
  )
  // The two sessions of the seat must NOT share an identical label: each one's
  // own notice carries BOTH labels, so the seat and its predecessor are told
  // apart from the same delivered text.
  check(
    'same-seat-sessions-are-distinguishable',
    incNotice.includes(incSeal) && incNotice.includes(outSeal) && outNotice.includes(outSeal),
    `incumbent notice had both seals: ${incNotice.includes(incSeal) && incNotice.includes(outSeal)} / outgoing notice had its own: ${outNotice.includes(outSeal)}`,
  )
}

// THE ACCEPTANCE CRITERION, in one assertion: the outgoing session's write is
// ACCEPTED (it is a live recipient, its notice was delivered) WHILE the notice
// AND the boot log seal it as no longer the seat's holder (attributable).
const logText = logLines.join('\n')
check(
  'boot-log-seals-the-outgoing-session',
  logText.includes(`[seat ${SEAT_POST} superseded by ${INCUMBENT}]`) &&
    logText.includes(`[seat ${SEAT_POST}]`),
  `the boot log did not carry both seals; log:\n${logText}`,
)
check(
  'write-yes-messaging-no',
  outNotice !== null && outNotice.includes(`[seat ${SEAT_POST} superseded by ${INCUMBENT}]`),
  `the outgoing session must be WRITTEN TO and SEALED as superseded — delivered=${outNotice !== null}`,
)
check(
  'seal-never-suppresses-the-write',
  delivered.some((d) => d.id === OUTGOING) && outNotice !== null,
  `a seal must never remove the outgoing session from delivery (delivered: ${delivered.map((d) => d.id).join(', ')})`,
)

// --- scenario 3: NO readable catalog → honest degradation -------------------
bootWith(join(root, 'no-such-posts.json'))
const incNoCat = textFor(INCUMBENT)
const outNoCat = textFor(OUTGOING)
check(
  'unmeasured-catalog-degrades-honestly',
  incNoCat !== null &&
    !incNoCat.includes('[not a catalog incumbent]') &&
    !incNoCat.includes('[seat ') &&
    outNoCat !== null,
  `with no catalog the labels must stay unsealed (never fabricated): "${String(incNoCat).slice(0, 200)}"`,
)
check(
  'unmeasured-catalog-still-delivers',
  incNoCat !== null && outNoCat !== null,
  `no catalog must not stop deliveries (delivered: ${delivered.map((d) => d.id).join(', ') || 'nobody'})`,
)

console.log = origLog
console.log(failures.length === 0 ? 'ALL:PASS' : `ALL:FAIL (${failures.length})`)
try {
  rmSync(root, { recursive: true, force: true })
} catch {
  // best-effort cleanup
}
process.exit(failures.length === 0 ? 0 : 1)
