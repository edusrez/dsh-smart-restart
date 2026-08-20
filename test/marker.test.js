// Tests for the pure marker/restart logic (src/boot.ts) and a small
// integration check against the compiled plugin (lib/index.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectRestart, ignoredByPrefix, parsePendingNotice, parseShutdownNotice, selectsAgent, shutdownTarget, targetsAgent } from '../lib/boot.js'

const NOW = Date.parse('2026-08-18T12:00:00.000Z')
const PREV = Date.parse('2026-08-18T11:59:00.000Z') // 60_000 ms before NOW

test('detectRestart: null marker is not a restart', () => {
  assert.deepEqual(detectRestart(null, NOW, 100), { wasRestart: false, downtimeMs: 0 })
})

test('detectRestart: same pid (HMR/reload) is not a restart', () => {
  const marker = { lastBootAt: new Date(PREV).toISOString(), pid: 100 }
  assert.deepEqual(detectRestart(marker, NOW, 100), { wasRestart: false, downtimeMs: 0 })
})

test('detectRestart: different pid is a restart with correct downtime', () => {
  const marker = { lastBootAt: new Date(PREV).toISOString(), pid: 100 }
  assert.deepEqual(detectRestart(marker, NOW, 200), { wasRestart: true, downtimeMs: 60_000 })
})

test('detectRestart: downtime clamps negatives to 0', () => {
  const later = { lastBootAt: new Date(NOW + 5000).toISOString(), pid: 100 }
  const result = detectRestart(later, NOW, 200)
  assert.equal(result.wasRestart, true)
  assert.equal(result.downtimeMs, 0)
})

test('detectRestart: stale/corrupt lastBootAt still counts as restart, downtime 0', () => {
  const corrupt = { lastBootAt: 'not-a-date', pid: 100 }
  const result = detectRestart(corrupt, NOW, 200)
  assert.equal(result.wasRestart, true)
  assert.equal(result.downtimeMs, 0)
})

test('targetsAgent: all always matches', () => {
  assert.equal(targetsAgent('all', undefined, false), true)
  assert.equal(targetsAgent('all', 'root-1', true), true)
})

test('targetsAgent: primary matches only a root', () => {
  assert.equal(targetsAgent('primary', 'root-1', true), true)
  assert.equal(targetsAgent('primary', 'child-1', false), false)
})

test('targetsAgent: explicit session id matches by exact string', () => {
  assert.equal(targetsAgent('asistente', 'asistente', true), true)
  assert.equal(targetsAgent('asistente', 'AsisteNte', false), false)
  assert.equal(targetsAgent('asistente', undefined, true), false)
  assert.equal(targetsAgent('asistente', 'other', false), false)
})

// --- v0.2.0: pending-notice parsing + pinned target selection ---------------

test('parsePendingNotice: valid doc with reason', () => {
  const raw = JSON.stringify({ sessionId: 'session-abc', reason: 'installed dshmarket', when: 'x' })
  assert.deepEqual(parsePendingNotice(raw), { sessionId: 'session-abc', reason: 'installed dshmarket' })
})

test('parsePendingNotice: missing reason defaults to empty string', () => {
  const raw = JSON.stringify({ sessionId: 'session-abc' })
  assert.deepEqual(parsePendingNotice(raw), { sessionId: 'session-abc', reason: '' })
})

test('parsePendingNotice: corrupt JSON returns null', () => {
  assert.equal(parsePendingNotice('not json'), null)
})

test('parsePendingNotice: missing/empty sessionId returns null', () => {
  assert.equal(parsePendingNotice('{}'), null)
  assert.equal(parsePendingNotice(JSON.stringify({ sessionId: '' })), null)
})

test('selectsAgent: no pinned target falls back to targetsAgent', () => {
  assert.equal(selectsAgent(undefined, 'primary', 'root-1', true), true)
  assert.equal(selectsAgent(undefined, 'primary', 'child-1', false), false)
  assert.equal(selectsAgent(undefined, 'all', 'root-1', false), true)
})

test('selectsAgent: pinned target overrides target and wins only for that session', () => {
  const pinned = 'session-abc'
  // pinned session matches regardless of the configured target
  assert.equal(selectsAgent(pinned, 'primary', 'session-abc', false), true)
  assert.equal(selectsAgent(pinned, 'all', 'session-abc', false), true)
  // any other session is excluded even for roots / 'all'
  assert.equal(selectsAgent(pinned, 'all', 'root-1', true), false)
  assert.equal(selectsAgent(pinned, 'primary', 'root-1', true), false)
  // a root that IS the pinned session still matches
  assert.equal(selectsAgent(pinned, 'primary', pinned, true), true)
})

// --- v0.3.0: smart shutdown auto-detection (parseShutdownNotice / shutdownTarget)

test('parseShutdownNotice: valid doc parses', () => {
  const raw = JSON.stringify({
    lastSessionId: 'session-abc',
    lastActiveAt: '2026-08-18T11:59:30.000Z',
    when: '2026-08-18T12:00:00.000Z',
  })
  assert.deepEqual(parseShutdownNotice(raw), {
    lastSessionId: 'session-abc',
    lastActiveAt: '2026-08-18T11:59:30.000Z',
    when: '2026-08-18T12:00:00.000Z',
  })
})

test('parseShutdownNotice: missing when defaults to empty string', () => {
  const raw = JSON.stringify({ lastSessionId: 's1', lastActiveAt: '2026-08-18T12:00:00.000Z' })
  assert.deepEqual(parseShutdownNotice(raw), {
    lastSessionId: 's1',
    lastActiveAt: '2026-08-18T12:00:00.000Z',
    when: '',
  })
})

test('parseShutdownNotice: missing/empty lastSessionId returns null', () => {
  assert.equal(parseShutdownNotice('{}'), null)
  assert.equal(parseShutdownNotice(JSON.stringify({ lastSessionId: '', lastActiveAt: '2026-08-18T12:00:00.000Z' })), null)
})

test('parseShutdownNotice: corrupt JSON returns null', () => {
  assert.equal(parseShutdownNotice('not json'), null)
})

test('parseShutdownNotice: unparseable lastActiveAt returns null', () => {
  const raw = JSON.stringify({ lastSessionId: 's1', lastActiveAt: 'not-a-date' })
  assert.equal(parseShutdownNotice(raw), null)
})

test('shutdownTarget: null notice returns null', () => {
  assert.equal(shutdownTarget(null, NOW, 600_000), null)
})

test('shutdownTarget: active within grace returns the session', () => {
  const notice = { lastSessionId: 'session-abc', lastActiveAt: new Date(NOW - 30_000).toISOString(), when: '' }
  assert.equal(shutdownTarget(notice, NOW, 600_000), 'session-abc')
})

test('shutdownTarget: activity exactly at the grace boundary returns the session', () => {
  // lastActiveAt exactly graceMs before shutdown is still "within" the window
  const notice = { lastSessionId: 'session-abc', lastActiveAt: new Date(NOW - 600_000).toISOString(), when: '' }
  assert.equal(shutdownTarget(notice, NOW, 600_000), 'session-abc')
})

test('shutdownTarget: inactive beyond grace returns null', () => {
  const notice = { lastSessionId: 'session-abc', lastActiveAt: new Date(NOW - 601_000).toISOString(), when: '' }
  assert.equal(shutdownTarget(notice, NOW, 600_000), null)
})

test('shutdownTarget: NaN guards return null', () => {
  const notice = { lastSessionId: 'session-abc', lastActiveAt: 'bad-date', when: '' }
  assert.equal(shutdownTarget(notice, NOW, 600_000), null)
  assert.equal(shutdownTarget(notice, NaN, 600_000), null)
  // undefined shutdown time -> NaN
  assert.equal(shutdownTarget(notice, Number.NaN, 600_000), null)
})

// --- v0.3.1: ignored-session-prefix filter (deepartments heads) ------------

// Deepartments heads are root agents with session id `head-<postId>`. They must
// never be selected as the smart-shutdown "last active" session.
test('ignoredByPrefix: deepartments head session is ignored by default head- prefix', () => {
  assert.equal(ignoredByPrefix('head-research-head', ['head-']), true)
  assert.equal(ignoredByPrefix('head-programming-head', ['head-']), true)
  assert.equal(ignoredByPrefix('head-studio-head', ['head-']), true)
})

test('ignoredByPrefix: a head-* session is never selected as last active', () => {
  // Any id starting with `head-` is ineligible for the last-active selection.
  assert.equal(ignoredByPrefix('head-research-head', ['head-']), true)
  assert.equal(ignoredByPrefix('head-research-head', ['head-', 'sys-']), true)
})

test('ignoredByPrefix: a normal session is NOT ignored', () => {
  assert.equal(ignoredByPrefix('asistente', ['head-']), false)
  assert.equal(ignoredByPrefix('primary', ['head-']), false)
  assert.equal(ignoredByPrefix('session-abc', ['head-']), false)
  // A session merely CONTAINING `head-` but not starting with it is fine.
  assert.equal(ignoredByPrefix('the-head-office', ['head-']), false)
})

test('ignoredByPrefix: config overrides — custom prefixes replace the default', () => {
  // With a custom prefix set, `head-` is no longer ignored unless listed.
  assert.equal(ignoredByPrefix('head-research-head', ['bot-']), false)
  assert.equal(ignoredByPrefix('bot-assistant', ['bot-']), true)
  // Multiple custom prefixes all apply.
  assert.equal(ignoredByPrefix('indexer-1', ['bot-', 'indexer-']), true)
  assert.equal(ignoredByPrefix('asistente', ['bot-', 'indexer-']), false)
})

test('ignoredByPrefix: guards — undefined id and empty prefix set are not ignored', () => {
  assert.equal(ignoredByPrefix(undefined, ['head-']), false)
  assert.equal(ignoredByPrefix('head-x', []), false)
  assert.equal(ignoredByPrefix('head-x', ['']), false)
})

// --- Small integration check against the compiled plugin -------------------
test('compiled plugin exports name and a function apply', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'smart-restart')
  assert.equal(typeof mod.apply, 'function')
})
