// GHOST-GUARD (ghostguard1) — the smart_restart read-before-edit guard counts
// RETIRED agents whose live handle was never unregistered.
//
// WHAT THIS TEST IS FOR (the discriminator the mission asks for):
//   The guard predicate (`activeAgentGuard`, src/boot.ts:362) is PURE: it
//   filters whatever `ctx.agents.list()` returns. So the question "is the bug
//   the predicate or the disposition?" is answered by driving the REAL
//   predicate with a registry that reproduces the REAL dispose ordering:
//     - if the predicate were at fault, it would mis-report a FAITHFUL snapshot;
//     - if the disposition is at fault, the predicate reports faithfully and the
//       registry simply never loses the entry.
//
// THE REAL ORDERING THIS REGISTRY REPRODUCES (copied from the installed
// harness, NOT invented):
//
//   @deepseek-ai/dsh-agent-loop/lib/index.js:1132-1152
//     const dispose = (...) => disposing ??= (async () => {
//       abort.abort(new Error(`agent "${id}" lifecycle disposed`));
//       ...
//       try {
//         if (machine === void 0) await machineReady.promise;
//         if (machine !== void 0) {
//           machine.cancel({ kind: "disposed" });      // <- request the stop
//           await machine.whenIdle();                  // <- :1140 BLOCKS until the turn converges
//           await machine.scope.dispose();
//         }
//       } finally {
//         try {
//           detachAgent?.();                           // <- :1145 the ONLY unregister
//           detachSession?.();
//         } finally { ... }
//       }
//     })();
//
//   @deepseek-ai/dsh-agent/lib/types/index.d.ts:147-148 (the declared contract):
//     "`dispose()` stops the loop, awaits its exit, unregisters the agent, ..."
//
//   and `whenIdle()` itself — @deepseek-ai/dsh-agent-loop/lib/index.js:460-465:
//     async whenIdle() { let activity; do await (activity = this.activityDone); while (activity !== this.activityDone); }
//
//   => an agent whose turn NEVER converges to idle is NEVER detached, so it
//      stays in the registry store, so `ctx.agents.list()` keeps returning it.
//
// THE RETIRE SIDE (deepartments, copied semantics, NOT invented):
//   packages/dshd-orchestration/src/tools.ts:3909-3912 — a live RUNNING worker
//     gets `deferDisposeMs = AUTO_RETIRE_DISPOSE_GRACE_MS` (5000) instead of 0.
//   :3945-3946 — the dispose is SCHEDULED on a 5s unref'd timer.
//   :3965 — retirePost RETURNS immediately; it does not await the dispose.
//   :3424-3431 — the only join is BOUNDED (DEEPARTMENTS_DISPOSE_JOIN_TIMEOUT_MS,
//     default 10_000) and on timeout it returns false, logs, and PROCEEDS.
//   :3417-3423 — bounding is deliberate ("A timeout can NEVER corrupt the
//     respawn ... unbounded joining is strictly worse than proceeding").
//
// THE POINT: bounding the CALLER's wait does not unregister the agent. The
// zombie machine stays in the registry forever — the ghost the guard counts.
//
// This file is ADDITIVE: no pre-existing test is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { activeAgentGuard } from '../lib/boot.js'

/** Production default of DEEPARTMENTS_DISPOSE_JOIN_TIMEOUT_MS (tools.ts:3325). */
const DISPOSE_JOIN_TIMEOUT_MS = 10_000

/**
 * A registry that reproduces the REAL harness ordering of `handle.dispose()`
 * (see the header). `turnConverges: false` models the zombie class the
 * deepartments code itself documents at tools.ts:3312-3321 — "whenIdle NEVER
 * settles and the detach becomes a zombie".
 */
function harnessRegistry(agents) {
  const store = new Map(agents.map((a) => [a.id, { ...a, detachCalled: false, cancelCalled: false }]))

  /** `machine.whenIdle()` — resolves at the turn boundary; NEVER for a zombie. */
  const whenIdle = (entry) => {
    if (entry.turnConverges !== false) return Promise.resolve()
    return new Promise(() => {}) // never settles — the documented zombie
  }

  /** `handle.dispose()` — index.js:1132-1152, ordering preserved exactly. */
  const dispose = (id) =>
    (async () => {
      const entry = store.get(id)
      if (entry === undefined) return // already detached (idempotent)
      entry.cancelCalled = true // machine.cancel({ kind: 'disposed' })  :1139
      await whenIdle(entry) // await machine.whenIdle()              :1140
      // only reached once the turn converges:
      store.delete(id) // detachAgent?.()                          :1145
      entry.detachCalled = true
    })()

  return {
    store,
    dispose,
    /** The EXACT snapshot `ctx.agents.list()` would hand the guard. */
    list: () => [...store.values()].map((e) => ({ id: e.id, status: e.status })),
    has: (id) => store.has(id),
  }
}

/**
 * `retirePost` — copies the retire semantics (see header). Returns IMMEDIATELY
 * (tools.ts:3965); the dispose is dispatched but never awaited by the caller.
 */
function retirePost(registry, id, { joinTimeoutMs = DISPOSE_JOIN_TIMEOUT_MS } = {}) {
  // 1. MARK, NOT ERASE — durable catalog mark, synchronous (tools.ts:3744-3771).
  //    This is what makes dept_who render 'offline, retired' (boot.ts:534).
  const catalogMark = { retired: true }
  // 2. dispatch the dispose through the BOUNDED join (tools.ts:3424-3431).
  const joined = Promise.race([
    registry.dispose(id).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), joinTimeoutMs)),
  ])
  // 3. RETURN without awaiting — exactly tools.ts:3965.
  return { postId: id, retired: true, catalogMark, joined }
}

const CALLING = 'host-caller-session'

// ---------------------------------------------------------------------------
// (b) THE RED TEST — retire an agent WITH A TURN IN FLIGHT.
// ---------------------------------------------------------------------------
test('ghost-guard: a worker retired WHILE MID-TURN stops counting in the guard listing', async () => {
  // One live worker, turn in flight, whose driver never converges (the zombie).
  const registry = harnessRegistry([
    { id: 'worker-ghost', status: 'running', turnConverges: false },
  ])

  // BEFORE the retire it is legitimately counted — a real in-flight turn.
  const before = activeAgentGuard(registry.list(), CALLING, false)
  assert.equal(before.allowed, false, 'precondition: a real mid-turn session must block the restart')
  assert.deepEqual(before.inFlight, ['worker-ghost'], 'precondition: the guard lists the live session')

  // The head retires it (the measured 14:11Z action).
  const r = retirePost(registry, 'worker-ghost', { joinTimeoutMs: 20 })
  assert.equal(r.retired, true, 'the retire itself succeeds')

  // The retired worker is now catalog-invisible, so dept_who would render
  // 'offline, retired' — exactly the host's observed reading (boot.ts:534).
  assert.equal(r.catalogMark.retired, true, 'the durable catalog mark committed')

  // Let the bounded join elapse fully.
  const joinSettled = await r.joined
  assert.equal(joinSettled, false, 'the bounded join timed out (the documented zombie path)')

  // THE CONTRACT: a RETIRED agent must never be counted as an interruption
  // victim — it is not a session whose work a restart could cut.
  const after = activeAgentGuard(registry.list(), CALLING, false)
  assert.deepEqual(
    after.inFlight,
    [],
    'a RETIRED worker must stop counting in the guard listing — instead the guard still counts it, ' +
      'because dispose() only unregisters AFTER whenIdle() and the retire never awaits/guarantees it',
  )
  assert.equal(after.allowed, true, 'with the ghost gone the restart would be allowed without force')
})

// ---------------------------------------------------------------------------
// (c) THE POSITIVE CONTROL — retire an agent that is IDLE.
// ---------------------------------------------------------------------------
// This case ALREADY WORKED before any fix. It is here so that "we fixed it" is
// never confused with "this case already worked".
test('ghost-guard CONTROL: a worker retired while IDLE disappears from the guard listing', async () => {
  const registry = harnessRegistry([
    { id: 'worker-idle', status: 'idle', turnConverges: true },
  ])

  const before = activeAgentGuard(registry.list(), CALLING, false)
  assert.equal(before.allowed, true, 'precondition: an idle session never blocks the restart')
  assert.deepEqual(before.inFlight, [], 'precondition: an idle session is not mid-turn')

  const r = retirePost(registry, 'worker-idle', { joinTimeoutMs: 20 })
  const joinSettled = await r.joined
  assert.equal(joinSettled, true, 'an idle agent’s dispose settles inside the bounded join')

  const after = activeAgentGuard(registry.list(), CALLING, false)
  assert.deepEqual(after.inFlight, [], 'the retired idle worker is gone from the listing')
  assert.equal(registry.has('worker-idle'), false, 'and it was really detached from the registry store')
})

// ---------------------------------------------------------------------------
// THE PREDICATE IS FAITHFUL — the discriminator itself.
// ---------------------------------------------------------------------------
// Given a snapshot, the REAL predicate reports exactly that snapshot. Feeding
// it a registry in which the ghost is ABSENT (the post-fix state) yields the
// correct answer, so the predicate can never be the thing that keeps the ghost:
// the ghost exists because the DISPOSITION leaves the entry in the store.
test('ghost-guard DISCRIMINATOR: the predicate is faithful — it reports the registry verbatim', () => {
  const faithful = [
    { id: 'worker-live', status: 'running' },
    { id: 'worker-other', status: 'idle' },
  ]
  const g = activeAgentGuard(faithful, CALLING, false)
  assert.deepEqual(g.inFlight, ['worker-live'], 'the predicate reports exactly the running, non-caller sessions')
  assert.equal(g.allowed, false)

  // With the ghost genuinely removed by disposition, the SAME predicate allows
  // the restart — proving no predicate change is needed.
  const ghostRemoved = [{ id: 'worker-other', status: 'idle' }]
  const g2 = activeAgentGuard(ghostRemoved, CALLING, false)
  assert.deepEqual(g2.inFlight, [])
  assert.equal(g2.allowed, true, 'the unchanged predicate allows the restart once the entry is really gone')
})

test('ghost-guard DISCRIMINATOR: the caller session is never counted (unchanged semantics)', () => {
  const g = activeAgentGuard([{ id: CALLING, status: 'running' }], CALLING, false)
  assert.deepEqual(g.inFlight, [], 'the calling session restarts itself intentionally and is excluded')
  assert.equal(g.allowed, true)
})

// ---------------------------------------------------------------------------
// FIDELITY GUARD — bind the mocked ordering to the REAL harness artifact.
// ---------------------------------------------------------------------------
// The RED test above is only meaningful if `harnessRegistry` reproduces the
// REAL dispose ordering. This test reads the installed harness's own dispose
// implementation and asserts the ordering the mock encodes:
//
//     machine.cancel(...)   ->   await machine.whenIdle()   ->   detachAgent?.()
//
// i.e. the unregister (detachAgent) comes AFTER the awaited idle convergence.
// If a future harness unregisters BEFORE awaiting idle, this test fails loudly
// and the ghost class is structurally gone — the mock would then be the thing
// at fault, and this test says so instead of silently passing.
//
// Derived, never composed: the path is resolved from the module graph, with a
// bounded upward search of the harness install; when the harness is absent
// (e.g. a bare CI checkout) the check reports SKIPPED rather than passing
// silently — an absent instrument is NOT a green measurement.
import { readFileSync, existsSync } from 'node:fs'
import { join as joinPath, dirname as dirnamePath } from 'node:path'
import { createRequire } from 'node:module'

/** Locate the installed `dsh-agent-loop` implementation of the agent handle. */
function findHarnessLoopSource() {
  const seeds = []
  try {
    const req = createRequire(import.meta.url)
    seeds.push(dirnamePath(req.resolve('@deepseek-ai/dsh-agent/package.json')))
  } catch {
    /* not resolvable from this repo — fall through to the fixed roots */
  }
  // The harness is installed under the profile's node_modules tree.
  seeds.push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  const rel = joinPath('dsh-agent-loop', 'lib', 'index.js')
  for (const seed of seeds) {
    // The loop may sit beside the seed, or under a shared node_modules.
    const candidates = [
      joinPath(seed, rel),
      joinPath(seed, '..', rel),
      joinPath(seed, 'node_modules', '@deepseek-ai', rel),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  }
  return undefined
}

test('ghost-guard FIDELITY: the real harness unregisters AFTER awaiting idle convergence', (t) => {
  const src = findHarnessLoopSource()
  if (src === undefined) {
    t.skip('dsh-agent-loop implementation not installed — an absent instrument is not a green measurement')
    return
  }
  const text = readFileSync(src, 'utf8')

  // Anchor on the dispose teardown, exactly as src/boot.ts does.
  const cancelAt = text.indexOf('machine.cancel({ kind: "disposed" })')
  const whenIdleAt = text.indexOf('await machine.whenIdle()')
  const detachAt = text.indexOf('detachAgent?.()', whenIdleAt === -1 ? 0 : whenIdleAt)

  assert.ok(cancelAt !== -1, `expected machine.cancel({ kind: "disposed" }) in ${src}`)
  assert.ok(whenIdleAt !== -1, `expected \`await machine.whenIdle()\` in ${src}`)
  assert.ok(detachAt !== -1, `expected \`detachAgent?.()\` in ${src}`)

  assert.ok(
    cancelAt < whenIdleAt,
    'the cancel must precede the awaited idle convergence',
  )
  assert.ok(
    whenIdleAt < detachAt,
    'THE GHOST-CLASS INVARIANT: the unregister (detachAgent) comes AFTER `await machine.whenIdle()` — ' +
      'so an agent whose turn never converges to idle is never unregistered, and the guard keeps counting it. ' +
      'If this assertion fails, the harness fixed the ordering and the ghost class is structurally gone.',
  )
})
