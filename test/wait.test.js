// Tests for the `wait` lane of smart_restart: the bounded deferral that makes
// the fb-168 read-before-edit guard WAIT for the architecture to go idle
// instead of refusing on the first sight of a mid-turn session.
//
// Two layers, both with a SIMULATED registry (the guard is pure, so the live
// snapshot is injected — no harness, no service):
//   1. pure units of `waitForIdle` / `guardRefusalMessage` (src/boot.ts) with a
//      scripted snapshot + a virtual clock + a fake sleep → deterministic
//      timing, no real timers, no wall-clock flakiness;
//   2. a child-process harness (fixtures/smart-restart-wait-topology.js) that
//      boots the REAL plugin (lib/index.js `apply` + stub ctx) and drives the
//      actual smart_restart tool with a SIMULATED live registry and a fake
//      `setsid` kill — the call paths end to end (absent / releases / timeout /
//      force / already-idle / invalid cap), plus the TRAMO (B) BUDGET
//      scenarios: a REAL canary (fake `dsh` on PATH, its boot window delayed)
//      shares ONE `waitMaxMs` budget with the post-canary re-check, so the
//      accumulated `waitedMs` (guard + re-check) can never reach 2x the cap.
//
// This file is ADDITIVE: the pre-existing tests are untouched (zero-regression
// acceptance), so a change of their expectations could never be masked here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  DEFAULT_WAIT_MAX_MS,
  WAIT_POLL_MS,
  guardRefusalMessage,
  waitForIdle,
} from '../lib/boot.js'

const CALLER = 'head-test-caller'
const FIXTURE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'smart-restart-wait-topology.js')

/** The pre-`wait` (fb-168) refusal, verbatim: the `wait` parameter must not
 *  change the immediate-block path by a single byte. */
const FB168_REFUSAL =
  'refusing to restart: 1 other session(s) mid-turn (worker-w1) — pass force:true to override'

/** A SIMULATED live registry: successive reads return successive snapshots and
 *  the LAST one repeats forever (a session that never releases). Counts the
 *  reads so the tests can prove the wait is a passive poll loop. */
function simulatedRegistry(snapshots) {
  let reads = 0
  return {
    reads: () => reads,
    read: () => {
      const snap = snapshots[Math.min(reads, snapshots.length - 1)]
      reads += 1
      return snap
    },
  }
}

/** Virtual clock + fake sleep: the wait's elapsed time is the SUM of the sleeps
 *  it performed, so `waitedMs` is asserted exactly (no timer flakiness). */
function virtualClock(start = 1_000_000) {
  let t = start
  const slept = []
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      t += ms
    },
    slept,
  }
}

const RUNNING = (id) => ({ id, status: 'running' })
const idle = (id) => ({ id, status: 'idle' })

// --- params / defaults --------------------------------------------------------

test('wait defaults: DEFAULT_WAIT_MAX_MS is the declared 2-minute cap, WAIT_POLL_MS the poll', () => {
  assert.equal(DEFAULT_WAIT_MAX_MS, 120_000)
  assert.equal(WAIT_POLL_MS, 1_000)
})

// --- guardRefusalMessage (the loud refusal, unchanged + expiry variant) -------

test('guardRefusalMessage: without waitedMs it is byte-identical to the pre-wait refusal', () => {
  assert.equal(guardRefusalMessage(['worker-w1']), FB168_REFUSAL)
  assert.equal(
    guardRefusalMessage(['a', 'b']),
    'refusing to restart: 2 other session(s) mid-turn (a, b) — pass force:true to override',
  )
})

test('guardRefusalMessage: a spent wait keeps the SAME refusal and states the expiry explicitly', () => {
  assert.equal(
    guardRefusalMessage(['worker-w1'], 120_000),
    'refusing to restart: 1 other session(s) mid-turn (worker-w1) — the wait expired after 120000ms with those session(s) still mid-turn; pass force:true to override',
  )
  // Same list, same override hint, same "refusing to restart:" lead.
  const withWait = guardRefusalMessage(['worker-w1'], 300)
  assert.ok(withWait.startsWith('refusing to restart: 1 other session(s) mid-turn (worker-w1) — '))
  assert.ok(withWait.endsWith('pass force:true to override'))
})

// --- waitForIdle: already idle (no wait, no sleep) ----------------------------

test('waitForIdle: an already-idle registry never sleeps (wait is a no-op, 0 polls)', async () => {
  const reg = simulatedRegistry([[RUNNING(CALLER), { id: 'worker-w1', status: 'idle' }]])
  const clock = virtualClock()
  const logs = []
  const res = await waitForIdle({
    readAgents: reg.read,
    callingSessionId: CALLER,
    maxMs: DEFAULT_WAIT_MAX_MS,
    sleep: clock.sleep,
    now: clock.now,
    onLog: (l) => logs.push(l),
  })
  assert.deepEqual(res, { idle: true, inFlight: [], waitedMs: 0, timedOut: false, polls: 0, waitedOn: [] })
  assert.deepEqual(clock.slept, [], 'an idle registry must not sleep at all')
  assert.equal(reg.reads(), 1, 'exactly one snapshot read')
  assert.match(logs.join('\n'), /wait: registry already IDLE/)
})

test('waitForIdle: the CALLING session is never waited on (own turn cannot self-block)', async () => {
  const reg = simulatedRegistry([[RUNNING(CALLER)]])
  const clock = virtualClock()
  const res = await waitForIdle({
    readAgents: reg.read,
    callingSessionId: CALLER,
    maxMs: DEFAULT_WAIT_MAX_MS,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(res.idle, true)
  assert.equal(res.waitedMs, 0)
  assert.deepEqual(clock.slept, [])
})

// --- waitForIdle: the registry releases → the restart may proceed --------------

test('waitForIdle: sessions that go idle release the wait (idle:true + how long it waited)', async () => {
  // Entry read: the caller + a worker mid-turn. Poll 1: still running.
  // Poll 2: the worker finished → the whole registry is idle.
  const reg = simulatedRegistry([
    [RUNNING(CALLER), RUNNING('worker-w1')],
    [RUNNING(CALLER), RUNNING('worker-w1')],
    [RUNNING(CALLER), { id: 'worker-w1', status: 'idle' }],
  ])
  const clock = virtualClock()
  const logs = []
  const res = await waitForIdle({
    readAgents: reg.read,
    callingSessionId: CALLER,
    maxMs: DEFAULT_WAIT_MAX_MS,
    sleep: clock.sleep,
    now: clock.now,
    onLog: (l) => logs.push(l),
  })
  assert.equal(res.idle, true)
  assert.equal(res.timedOut, false)
  assert.deepEqual(res.inFlight, [])
  assert.equal(res.polls, 2)
  assert.equal(res.waitedMs, 2 * WAIT_POLL_MS)
  assert.deepEqual(res.waitedOn, ['worker-w1'], 'the wait records WHO it waited on')
  assert.deepEqual(clock.slept, [WAIT_POLL_MS, WAIT_POLL_MS], 'polls at the declared interval')
  assert.equal(reg.reads(), 3, 'entry read + one read per poll — no hidden interactions')
  const text = logs.join('\n')
  assert.match(text, /wait start: 1 other session\(s\) mid-turn \(worker-w1\) — waiting up to 120000ms/)
  assert.match(text, /wait end: registry IDLE after 2000ms \(2 poll\(s\)\) — released: worker-w1; proceeding with the restart/)
})

// --- waitForIdle: never releases → timeout (the SAME refusal) ------------------

test('waitForIdle: a registry that never releases times out at the cap (idle:false, timedOut:true)', async () => {
  const reg = simulatedRegistry([[RUNNING(CALLER), RUNNING('worker-w1'), RUNNING('worker-w2')]])
  const clock = virtualClock()
  const logs = []
  const res = await waitForIdle({
    readAgents: reg.read,
    callingSessionId: CALLER,
    maxMs: 3_000,
    sleep: clock.sleep,
    now: clock.now,
    onLog: (l) => logs.push(l),
  })
  assert.equal(res.idle, false)
  assert.equal(res.timedOut, true)
  assert.deepEqual(res.inFlight, ['worker-w1', 'worker-w2'], 'who was still mid-turn at the cap')
  assert.deepEqual(res.waitedOn, ['worker-w1', 'worker-w2'])
  assert.equal(res.polls, 3)
  assert.equal(res.waitedMs, 3_000, 'the wait never outlives the cap')
  assert.equal(reg.reads(), 4)
  const text = logs.join('\n')
  assert.match(text, /wait start: 2 other session\(s\) mid-turn \(worker-w1, worker-w2\) — waiting up to 3000ms/)
  assert.match(text, /wait end: TIMEOUT after 3000ms \(3 poll\(s\)\) — still mid-turn: worker-w1, worker-w2/)
  // The caller then returns the fb-168 refusal with the expiry stated.
  assert.equal(
    guardRefusalMessage(res.inFlight, res.waitedMs),
    'refusing to restart: 2 other session(s) mid-turn (worker-w1, worker-w2) — the wait expired after 3000ms with those session(s) still mid-turn; pass force:true to override',
  )
})

test('waitForIdle: maxMs 0 never sleeps — the refusal is immediate (today-shape, flagged as expired)', async () => {
  const reg = simulatedRegistry([[RUNNING('worker-w1')]])
  const clock = virtualClock()
  const res = await waitForIdle({
    readAgents: reg.read,
    callingSessionId: CALLER,
    maxMs: 0,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.deepEqual(clock.slept, [])
  assert.equal(res.idle, false)
  assert.equal(res.timedOut, true)
  assert.equal(res.waitedMs, 0)
  assert.equal(res.polls, 0)
  assert.deepEqual(res.inFlight, ['worker-w1'])
})

test('waitForIdle: a non-finite cap degrades to no waiting (never unbounded)', async () => {
  const reg = simulatedRegistry([[RUNNING('worker-w1')]])
  const clock = virtualClock()
  const res = await waitForIdle({
    readAgents: reg.read,
    callingSessionId: CALLER,
    maxMs: Number.NaN,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.deepEqual(clock.slept, [])
  assert.equal(res.timedOut, true)
  assert.equal(res.waitedMs, 0)
})

test('waitForIdle: the final poll is CLAMPED to the remaining cap (never oversleeps)', async () => {
  const reg = simulatedRegistry([[RUNNING('worker-w1')]])
  const clock = virtualClock()
  const res = await waitForIdle({
    readAgents: reg.read,
    callingSessionId: CALLER,
    maxMs: 1_200,
    pollMs: 5_000,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.deepEqual(clock.slept, [1_200])
  assert.equal(res.waitedMs, 1_200)
  assert.equal(res.polls, 1)
})

test('waitForIdle: the registry is re-read EVERY poll — a session that starts a turn mid-wait keeps it waiting', async () => {
  // Entry read: worker-w1 mid-turn. Poll 1: still mid-turn. Poll 2: a NEW turn
  // (worker-w3) appeared — the reason the loop must never cache the entry
  // snapshot. Poll 3: everyone finished → release.
  const reg = simulatedRegistry([
    [RUNNING('worker-w1')],
    [RUNNING('worker-w1')],
    [RUNNING('worker-w1'), RUNNING('worker-w3')],
    [idle('worker-w1'), idle('worker-w3')],
  ])
  const clock = virtualClock()
  const res = await waitForIdle({
    readAgents: reg.read,
    callingSessionId: CALLER,
    maxMs: 10_000,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(res.idle, true)
  assert.equal(res.polls, 3)
  assert.equal(reg.reads(), 4)
  assert.equal(res.waitedMs, 3 * WAIT_POLL_MS)
})

// --- the tool end to end (real plugin boot, simulated registry) ---------------

test('harness: the smart_restart wait paths against a SIMULATED live registry', { timeout: 90_000 }, async () => {
  const { code, signal, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`fixture timeout — out:\n${out}\nerr:\n${err}`))
    }, 80_000)
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      err += String(d)
    })
    child.on('error', reject)
    child.on('exit', (c, s) => {
      clearTimeout(timer)
      resolve({ code: c, signal: s, stdout: out, stderr: err })
    })
  })
  assert.equal(code, 0, `fixture exit ${code}/${signal} — stderr:\n${stderr}\nstdout:\n${stdout}`)
  assert.match(stdout, /ALL:PASS/)
  // The four call paths.
  assert.match(stdout, /SCEN:wait-absent-immediate-refusal:PASS/)
  assert.match(stdout, /SCEN:wait-releases-restart:PASS/)
  assert.match(stdout, /SCEN:wait-timeout-same-refusal:PASS/)
  assert.match(stdout, /SCEN:force-wins-no-wait:PASS/)
  // TRAMO (B) — the budget is shared with the post-canary re-check: the
  // headline is the TOTAL ≤ the cap (the ceiling is never doubled), with the
  // canary window really charged and the re-check getting only the remainder.
  assert.match(stdout, /SCEN:canary-budget-total-not-doubled:PASS/)
  assert.match(stdout, /SCEN:canary-budget-recheck-gets-remainder:PASS/)
  assert.match(stdout, /SCEN:canary-budget-waited-is-accumulated:PASS/)
  assert.match(stdout, /SCEN:canary-exhausted-same-refusal:PASS/)
  assert.match(stdout, /SCEN:canary-exhausted-no-zero-length-wait:PASS/)
  assert.match(stdout, /SCEN:canary-recheck-timeout-accumulated:PASS/)
  assert.match(stdout, /SCEN:canary-recheck-timeout-no-spawn:PASS/)
  assert.match(stdout, /SCEN:canary-spent-idle-proceeds:PASS/)
  assert.match(stdout, /SCEN:canary-spent-idle-no-extra-wait:PASS/)
  // The printed budget arithmetic of the point-5 scenario: the re-check's cap
  // is the REMAINDER (never the full cap again) and the total stays ≤ the cap.
  const budget = /BUDGET:total cap=(\d+)ms guard=(\d+)ms canaryWindow=(\d+)ms spent=(\d+)ms recheckCap=\d+ms recheckLeft=(\d+)ms waitedMs=(\d+)ms wall=(\d+)ms => waitedMs<=cap:true/.exec(stdout)
  assert.ok(budget, `the point-5 BUDGET line is missing from:\n${stdout}`)
  const [, cap, guard, canaryWindow, spent, left, waitedMs] = budget.map(Number)
  assert.ok(waitedMs <= cap, `the accumulated wait (${waitedMs}ms) must never exceed the cap (${cap}ms)`)
  assert.equal(left, Math.max(0, cap - spent), 'the re-check cap must be max(0, waitMaxMs - spent)')
  assert.ok(left < cap, 'the re-check must NEVER dispose of the full cap again')
  assert.ok(canaryWindow >= 700, `the canary window (${canaryWindow}ms) must really consume budget`)
  assert.ok(waitedMs >= guard, 'the outcome carries the ACCUMULATED wait (guard + re-check)')
  // Honest logging: the wait's start/end lines come from the REAL tool.
  assert.match(stderr, /wait start: 1 other session\(s\) mid-turn \(worker-w1\)/)
  assert.match(stderr, /wait end: registry IDLE after \d+ms \(\d+ poll\(s\)\) — released: worker-w1/)
  assert.match(stderr, /wait end: TIMEOUT after \d+ms \(\d+ poll\(s\)\) — still mid-turn: worker-w1/)
  assert.match(stderr, /wait ignored — force:true wins \(no waiting\)/)
  // The (B) budget line + the loud re-check refusals.
  assert.match(stderr, /post-canary re-check: wait budget \d+ms — \d+ms waited at the guard, \d+ms canary window, \d+ms spent so far → \d+ms left/)
  assert.match(stderr, /BLOCKED at the post-canary re-check/)
  assert.match(stderr, /refusing now \(no zero-length wait\)/)
})
