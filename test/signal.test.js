// Regression tests for the conditional SIGTERM/SIGINT re-raise (RD #483,
// flush verdict 2026-09-02): the smart-restart handler must re-raise a signal
// ONLY when it is the last registered listener, so on the real host the core
// bootstrap's graceful dispose (fiber.dispose → write-behind flush-all, 5s
// budget) is never cut by a force-exit mid-flush, while bare Node keeps the
// default-action termination (143 / SIGTERM). Pure units against the live
// process listener table plus child-process signal smokes — no dsh service,
// no /opt/dsh, no systemctl required.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { shouldReRaiseSignal } from '../lib/index.js'

const FIXTURE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'signal-topology.js')

test('shouldReRaiseSignal: true when this handler is the only SIGTERM listener (bare Node)', () => {
  const extra = () => {}
  const baseline = process.listenerCount('SIGTERM')
  process.on('SIGTERM', extra)
  try {
    // Exactly one listener (ours) → re-raise. In the repo's CI/test runner
    // the baseline is 0, so this reads: one listener ⇒ true.
    assert.equal(shouldReRaiseSignal('SIGTERM'), baseline + 1 <= 1)
  } finally {
    process.removeListener('SIGTERM', extra)
  }
})

test('shouldReRaiseSignal: false when another SIGTERM listener is registered (host)', () => {
  // Host topology: the plugin's own handler + the bootstrap's handler are both
  // registered (count 2) → the plugin must step aside, not re-raise.
  const pluginLike = () => {}
  const bootstrapLike = () => {}
  process.on('SIGTERM', pluginLike)
  process.on('SIGTERM', bootstrapLike)
  try {
    assert.equal(shouldReRaiseSignal('SIGTERM'), false)
  } finally {
    process.removeListener('SIGTERM', pluginLike)
    process.removeListener('SIGTERM', bootstrapLike)
  }
})

/** Spawn the fixture, send SIGTERM once "READY" appears, resolve on exit. */
function runFixture(topology, legacy = '0') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], {
      env: { ...process.env, TOPOLOGY: topology, LEGACY: legacy },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`fixture timeout (topology=${topology})`))
    }, 8000)
    child.stdout.on('data', (d) => {
      out += String(d)
      if (out.includes('READY')) child.kill('SIGTERM')
    })
    child.stderr.on('data', (d) => {
      out += String(d)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, out })
    })
  })
}

test('SIGTERM smoke (host topology): no re-raise — graceful dispose completes', async () => {
  const { code, signal, out } = await runFixture('host')
  assert.equal(code, 0, `unexpected exit: code=${code} signal=${signal} out:\n${out}`)
  assert.match(out, /DISPOSE_COMPLETE/)
  assert.doesNotMatch(out, /FORCE_EXIT/, 'the plugin re-raised and force-exited the graceful dispose')
})

test('SIGTERM smoke (bare topology): lone handler re-raises → default termination', async () => {
  const { code, signal, out } = await runFixture('bare')
  // Default action on SIGTERM with zero listeners left dies from the signal
  // (143 as the shell would report it); either observation is the fix intact.
  assert.ok(
    code === 143 || signal === 'SIGTERM',
    `expected signal death (143/SIGTERM), got code=${code} signal=${signal} out:\n${out}`,
  )
})

test('SIGTERM smoke (host + LEGACY): reproduces the pre-#483 force-exit cut', async () => {
  // Sensitivity probe: the unconditional re-raise the fix removes MUST show
  // FORCE_EXIT here — proving the smoke detects the old bug.
  const { code, signal, out } = await runFixture('host', '1')
  assert.match(out, /FORCE_EXIT/, `legacy re-raise should force-exit the dispose; code=${code} signal=${signal} out:\n${out}`)
  assert.doesNotMatch(out, /DISPOSE_COMPLETE/)
})