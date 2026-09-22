// fb-2418 (b) — THE SEAL OF THE RESUME NOTICE: the notice's per-session seat
// attribution, and the host's adjudicated acceptance criterion
// «ESCRITURA SÍ, MENSAJERÍA NO» as an executable assertion.
//
// THE DEFECT (verified in the live session artifact, not assumed): the resume
// notice lists interrupted sessions BY SESSION, never BY POST. On
// 2026-09-22T17:48:34.779Z the live notice carried
//   head-quality-head-a352f359-…  (the post's CURRENT session)
//   head-quality-head-9e1cc8b2-…  (its ROTATED-OUT predecessor)
// in the SAME list, both rendered `(main)` — so the reader cannot tell the
// titular seat from the outgoing session, and the system has no concept of
// "incumbent" when it composes the list.
//
// THE FIX IS A SEAL, NOT A BLOCK (the host's decision): the outgoing emitter's
// write PASSES and stays fully effective; it is made ATTRIBUTABLE instead.
// Blocking it would have prevented the only channel that carried state across
// the QH's incarnations (fb-2419), i.e. blocking IS the defect today.
//
// Two layers:
//   1. PURE units of `resolveSessionSeals` (src/boot.ts — the seal RENDERS in
//      the same call, so the whole concept crosses one boundary) against the
//      REAL document shapes (posts.json rows + hosts.json rows), with the
//      historical pair of 2026-09-22 as the fixture;
//   2. a child-process harness (fixtures/smart-restart-resume-seal-topology.js)
//      that boots the REAL plugin (lib/index.js `apply` + stub ctx), writes a
//      REAL shutdown-notice.json + REAL catalog documents, and asserts the
//      notice TEXT the plugin actually delivers — including that the outgoing
//      session is STILL a delivery recipient (write yes, messaging no).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { resolveSessionSeals } from '../lib/boot.js'

const FIXTURE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'fixtures',
  'smart-restart-resume-seal-topology.js',
)

// --- The historical pair (2026-09-22), verbatim from the live documents ------
const INCUMBENT = 'head-quality-head-a352f359-131e-4495-b582-398296b0085c'
const OUTGOING = 'head-quality-head-9e1cc8b2-59dc-4626-99fc-9d99413ee7ca'
const HOST_SESSION = 'session-15f80d86-e1d6-4e0f-8ab5-51d165cf6e69'

const POSTS = JSON.stringify({
  'quality-head': {
    sessionId: INCUMBENT,
    roomId: 'board',
    agentPreset: 'deepartments-head-quality',
  },
  'research-head': {
    sessionId: 'head-research-head-b756e371-8b2c-4bea-90e8-21f2aec77d4c',
    roomId: 'board',
    agentPreset: 'deepartments-head-research',
    previousChildId: 'head-research-head-fdb31e58-edc6-4757-b15e-e6eb313d2f2f',
    rotated: true,
  },
  'builder-454': {
    sessionId: 'worker-builder-454-572e456e-a70a-4920-ad93-f5e310b95417',
    role: 'builder',
    retired: true,
  },
})

const HOSTS = JSON.stringify({
  schemaVersion: 2,
  'host-session-15f80d86-e1d6-4e0f-8ab5-51d165cf6e69': {
    sessionId: HOST_SESSION,
    roomId: 'board',
  },
})

test('resolveSessionSeals: the notice\'s two same-seat sessions get DISTINCT seals (the discriminator)', () => {
  const seals = resolveSessionSeals([INCUMBENT, OUTGOING], { postsRaw: POSTS, hostsRaw: HOSTS })
  assert.equal(seals.length, 2)
  const byId = new Map(seals.map((s) => [s.sessionId, s]))
  const inc = byId.get(INCUMBENT)
  const out = byId.get(OUTGOING)
  // The incumbent is the seat's current holder.
  assert.equal(inc.seat, 'quality-head')
  assert.equal(inc.current, true)
  assert.equal(inc.label, '[seat quality-head]')
  // The outgoing predecessor names the seat AND the session that superseded it.
  assert.equal(out.seat, 'quality-head')
  assert.equal(out.current, false)
  assert.equal(out.supersededBy, INCUMBENT)
  assert.equal(out.label, `[seat quality-head superseded by ${INCUMBENT}]`)
  // THE POINT OF THE FICHE: the two labels differ. Before the seal, both
  // rendered `(main)` and were indistinguishable.
  assert.notEqual(inc.label, out.label)
})

test('resolveSessionSeals: supersession is read from previousChildId (posts) — the rotated predecessor', () => {
  const rotatedOut = 'head-research-head-fdb31e58-edc6-4757-b15e-e6eb313d2f2f'
  const incumbent = 'head-research-head-b756e371-8b2c-4bea-90e8-21f2aec77d4c'
  const seals = resolveSessionSeals([rotatedOut, incumbent], { postsRaw: POSTS, hostsRaw: HOSTS })
  const byId = new Map(seals.map((s) => [s.sessionId, s]))
  assert.equal(byId.get(incumbent).current, true)
  assert.equal(byId.get(incumbent).label, '[seat research-head]')
  assert.equal(byId.get(rotatedOut).supersededBy, incumbent)
  assert.match(byId.get(rotatedOut).label, /^\[seat research-head superseded by /)
})

test('resolveSessionSeals: posts.json ALONE would FALSE-SEAL the live host session (both documents required)', () => {
  // Measured live: the host session is absent from posts.json. Resolving
  // against posts.json only would seal it `[not a catalog incumbent]` — a
  // positive claim that is false. hosts.json is what makes it legible.
  const postsOnly = resolveSessionSeals([HOST_SESSION], { postsRaw: POSTS, hostsRaw: null })
  assert.equal(postsOnly[0].label, '[not a catalog incumbent]')
  const both = resolveSessionSeals([HOST_SESSION], { postsRaw: POSTS, hostsRaw: HOSTS })
  assert.equal(both[0].listedIn, 'hosts')
  assert.equal(both[0].current, true)
  assert.notEqual(both[0].label, '[not a catalog incumbent]')
})

test('resolveSessionSeals: a NON-member session is sealed explicitly (its write is attributed, never hidden)', () => {
  const stranger = 'head-some-department-deadbeef-0000-0000-0000-000000000000'
  const seals = resolveSessionSeals([stranger], { postsRaw: POSTS, hostsRaw: HOSTS })
  assert.deepEqual(seals, [{ sessionId: stranger, label: '[not a catalog incumbent]' }])
})

test('resolveSessionSeals: a RETIRED listing is not an incumbent (retired post is named as such)', () => {
  const retired = 'worker-builder-454-572e456e-a70a-4920-ad93-f5e310b95417'
  const seals = resolveSessionSeals([retired], { postsRaw: POSTS, hostsRaw: HOSTS })
  assert.equal(seals[0].seat, 'builder-454')
  assert.equal(seals[0].current, false)
  assert.equal(seals[0].label, '[seat builder-454 (retired post)]')
})

test('resolveSessionSeals: NO readable catalog → NO seal (unmeasured is never "not a member")', () => {
  // The day's rule (fb-2400): "I could not measure it" must not be rendered as
  // the positive claim "this session is not a member".
  assert.deepEqual(resolveSessionSeals([OUTGOING], { postsRaw: null, hostsRaw: null }), [])
  // A present but CORRUPT document is unmeasured too — never a crash, never an
  // empty-roster verdict.
  assert.deepEqual(resolveSessionSeals([OUTGOING], { postsRaw: '{not json', hostsRaw: null }), [])
  assert.deepEqual(resolveSessionSeals([OUTGOING], { postsRaw: '[]', hostsRaw: null }), [])
  // A PRESENT and EMPTY catalog IS a measurement: the session is not listed.
  const empty = resolveSessionSeals([OUTGOING], { postsRaw: '{}', hostsRaw: null })
  assert.equal(empty[0].label, '[not a catalog incumbent]')
})

test('resolveSessionSeals: the seal of a not-listed session is ADDITIVE — the id is never dropped', () => {
  const seals = resolveSessionSeals([OUTGOING, INCUMBENT], { postsRaw: POSTS, hostsRaw: HOSTS })
  // Every requested session yields exactly one seal, always carrying its id:
  // an outgoing session is ATTRIBUTED, never silently omitted from the notice.
  assert.deepEqual(
    seals.map((s) => s.sessionId),
    [OUTGOING, INCUMBENT],
  )
  assert.ok(seals.every((s) => typeof s.sessionId === 'string' && s.sessionId.length > 0))
})

test('resolveSessionSeals: the ID-DERIVED supersession (the live quality-head row has NO previousChildId)', () => {
  // MEASURED on the live posts.json: the `quality-head` row records NO
  // `previousChildId`, so explicit-supersession alone leaves the exact case of
  // this fiche unsealed. The session id names the seat while the seat lists a
  // DIFFERENT session ⇒ it is the rotated-out predecessor, and the row's
  // `sessionId` is its superseder.
  const posts = JSON.stringify({
    'quality-head': { sessionId: INCUMBENT, roomId: 'board' },
  })
  const seals = resolveSessionSeals([OUTGOING], { postsRaw: posts, hostsRaw: null })
  assert.equal(seals[0].seat, 'quality-head')
  assert.equal(seals[0].current, false)
  assert.equal(seals[0].supersededBy, INCUMBENT)
  assert.equal(seals[0].label, `[seat quality-head superseded by ${INCUMBENT}]`)
})

test('resolveSessionSeals: the id-derived path never invents a seat for an unrelated session', () => {
  // The host session's id embeds no seat name, so it is not forced into one.
  const hostsOnly = resolveSessionSeals([HOST_SESSION], { postsRaw: null, hostsRaw: HOSTS })
  assert.equal(hostsOnly[0].seat, `host-${HOST_SESSION}`)
  assert.equal(hostsOnly[0].current, true)
})

// --- Layer 2: the REAL plugin, end to end (acceptance criterion) -------------

/** Run the harness fixture; it prints SCEN:<name>:PASS|FAIL lines and exits
 *  non-zero when any scenario fails. */
function runHarness() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FIXTURE], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('harness: the resume notice is SEALED, the outgoing emitter is still a recipient (write yes, messaging no)', async () => {
  const { code, stdout, stderr } = await runHarness()
  const lines = stdout.split('\n').filter((l) => l.startsWith('SCEN:'))
  const failed = lines.filter((l) => l.includes(':FAIL'))
  assert.equal(
    failed.length,
    0,
    `harness scenarios failed:\n${failed.join('\n')}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  )
  assert.equal(code, 0, `harness exit ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
  assert.match(stdout, /SCEN:notice-seals-the-two-same-seat-sessions:PASS/)
  assert.match(stdout, /SCEN:write-yes-messaging-no:PASS/)
})
