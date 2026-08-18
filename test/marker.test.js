// Tests for the pure marker/restart logic (src/boot.ts) and a small
// integration check against the compiled plugin (lib/index.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectRestart, targetsAgent } from '../lib/boot.js'

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

// --- Small integration check against the compiled plugin -------------------
test('compiled plugin exports name and a function apply', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'smart-restart')
  assert.equal(typeof mod.apply, 'function')
})
