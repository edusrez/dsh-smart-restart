// Tests for the FB-234 WRITER lane (src/restart-reason.ts + the smart_restart
// kill-path wiring in src/index.ts): the GRACE-route selector, the boot-crash
// bootId anchor, the atomic marker write/clear, the plugin-surface regression
// (module exports unchanged), and the KILL-PATH HARNESS — a child process that
// boots the REAL plugin (apply + stub ctx) and drives the actual smart_restart
// tool with the kill replaced by a fake `setsid`, proving the marker is on
// disk BEFORE the kill. Pure units + harness — no dsh service, no /opt/dsh, no
// systemctl required; hermetic tmpdirs, passes after `pnpm build`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  BOOT_CRASH_FILE,
  RESTART_REASON_CAUSES,
  RESTART_REASON_FILE,
  clearRestartReasonMarker,
  readCurrentBootId,
  resolveRestartCause,
  writeRestartReasonMarker,
} from '../lib/restart-reason.js'

const FIXTURE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'restart-reason-topology.js')

/** Hermetic temp dir helper: the fn receives a fresh mkdtemp path and the dir
 * is always removed afterwards (the deepartments dual-surface pattern). */
function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'restart-reason-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- GRACE set (mirrors the SPEC's RESTART_GRACE_CAUSES) ----------------------

test('RESTART_REASON_CAUSES: the sanctioned GRACE families are exactly canary/deploy/dshmarket', () => {
  assert.deepEqual([...RESTART_REASON_CAUSES].sort(), ['canary', 'deploy', 'dshmarket'])
})

test('resolveRestartCause: an explicit in-set cause wins verbatim (the 3 GRACE routes)', () => {
  for (const cause of ['canary', 'deploy', 'dshmarket']) {
    assert.equal(resolveRestartCause(cause, false), cause, `explicit ${cause}`)
    assert.equal(resolveRestartCause(cause, true), cause, `explicit ${cause} with gate ran`)
  }
})

test('resolveRestartCause: a canary gate that RAN implies cause canary', () => {
  assert.equal(resolveRestartCause(undefined, true), 'canary')
})

test('resolveRestartCause: no cause + no canary gate → NO marker (current semantics)', () => {
  assert.equal(resolveRestartCause(undefined, false), undefined)
})

test('resolveRestartCause: a cause OUTSIDE the set is rejected → NO marker (crash semantics)', () => {
  assert.equal(resolveRestartCause('oops-wild-crash', false), undefined)
  assert.equal(resolveRestartCause('oops-wild-crash', true), undefined)
  assert.equal(resolveRestartCause('', false), undefined)
})

// --- readCurrentBootId (the pre-kill bootId anchor) ---------------------------

test('readCurrentBootId: reads the CURRENT boot id from boot-crash.json', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, BOOT_CRASH_FILE), JSON.stringify({ bootId: 'boot-X', bootStartedAt: 1, crashStreak: 0 }), 'utf8')
    assert.equal(readCurrentBootId(dir), 'boot-X')
  })
})

test('readCurrentBootId: absent file → undefined, never throws', () => {
  withTmpDir((dir) => {
    assert.equal(readCurrentBootId(dir), undefined)
    assert.equal(readCurrentBootId(join(dir, 'does-not-exist')), undefined)
  })
})

test('readCurrentBootId: broken JSON / empty bootId → undefined, never throws', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, BOOT_CRASH_FILE), '{broken', 'utf8')
    assert.equal(readCurrentBootId(dir), undefined)
    writeFileSync(join(dir, BOOT_CRASH_FILE), JSON.stringify({ bootId: '', bootStartedAt: 1, crashStreak: 0 }), 'utf8')
    assert.equal(readCurrentBootId(dir), undefined)
  })
})

// --- writeRestartReasonMarker (atomic tmp+rename, same dir) -------------------

test('writeRestartReasonMarker: writes the exact marker shape and creates the dir', () => {
  withTmpDir((dir) => {
    const deep = join(dir, 'nested', 'state')
    writeRestartReasonMarker(deep, { cause: 'canary', reason: 'dshmarket 06:30Z', ts: 1750000000000, bootId: 'boot-1' })
    const marker = JSON.parse(readFileSync(join(deep, RESTART_REASON_FILE), 'utf8'))
    assert.deepEqual(marker, { cause: 'canary', reason: 'dshmarket 06:30Z', ts: 1750000000000, bootId: 'boot-1' })
  })
})

test('writeRestartReasonMarker: reason and bootId are OPTIONAL (omitted keys)', () => {
  withTmpDir((dir) => {
    writeRestartReasonMarker(dir, { cause: 'deploy', ts: 42 })
    const marker = JSON.parse(readFileSync(join(dir, RESTART_REASON_FILE), 'utf8'))
    assert.deepEqual(marker, { cause: 'deploy', ts: 42 })
    assert.ok(!('reason' in marker) && !('bootId' in marker))
  })
})

test('writeRestartReasonMarker: ATOMIC — a pre-existing broken marker is replaced by a complete one, no tmp litter', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, RESTART_REASON_FILE), '{partial', 'utf8') // broken pre-existing marker
    writeRestartReasonMarker(dir, { cause: 'dshmarket', ts: 7, bootId: 'boot-2' })
    const marker = JSON.parse(readFileSync(join(dir, RESTART_REASON_FILE), 'utf8'))
    assert.deepEqual(marker, { cause: 'dshmarket', ts: 7, bootId: 'boot-2' })
    // The tmp file (same dir, atomic rename) must not linger.
    assert.ok(!existsSync(join(dir, `${RESTART_REASON_FILE}.tmp`)), 'tmp rename artifact must be gone')
  })
})

test('writeRestartReasonMarker: the written marker passes the SPEC reader validation (cause non-empty, ts finite)', () => {
  withTmpDir((dir) => {
    writeRestartReasonMarker(dir, { cause: 'canary', ts: Date.now(), bootId: 'boot-3' })
    const parsed = JSON.parse(readFileSync(join(dir, RESTART_REASON_FILE), 'utf8'))
    assert.equal(typeof parsed.cause, 'string')
    assert.ok(parsed.cause !== '', 'cause must be non-empty')
    assert.equal(typeof parsed.ts, 'number')
    assert.ok(Number.isFinite(parsed.ts), 'ts must be finite')
  })
})

test('writeRestartReasonMarker: NEVER throws — an unwritable stateDir degrades to no marker (restart proceeds)', () => {
  withTmpDir((dir) => {
    const asFile = join(dir, 'state-is-a-file')
    writeFileSync(asFile, 'not a dir', 'utf8')
    let threw = false
    try {
      writeRestartReasonMarker(asFile, { cause: 'canary', ts: 1 })
    } catch {
      threw = true
    }
    assert.equal(threw, false, 'the writer must never throw (best-effort, current crash semantics)')
    assert.equal(existsSync(join(asFile, RESTART_REASON_FILE)), false)
  })
})

// --- clearRestartReasonMarker (stale-marker hygiene on non-grace restarts) ----

test('clearRestartReasonMarker: removes a pending marker; absent file → no-op; never throws', () => {
  withTmpDir((dir) => {
    writeRestartReasonMarker(dir, { cause: 'canary', ts: 1 })
    assert.equal(existsSync(join(dir, RESTART_REASON_FILE)), true)
    clearRestartReasonMarker(dir)
    assert.equal(existsSync(join(dir, RESTART_REASON_FILE)), false)
    clearRestartReasonMarker(dir) // absent → no-op
    const asFile = join(dir, 'state-is-a-file')
    writeFileSync(asFile, 'not a dir', 'utf8')
    let threw = false
    try {
      clearRestartReasonMarker(asFile)
    } catch {
      threw = true
    }
    assert.equal(threw, false)
  })
})

// --- Plugin-surface regression (0 exports nuevos — the package "." surface) ---

test('plugin surface: the public module still exports exactly its pre-fb-234 names', async () => {
  const mod = await import('../lib/index.js')
  for (const n of ['apply', 'name', 'inject', 'shouldReRaiseSignal']) {
    assert.ok(n in mod, `missing export: ${n}`)
  }
  assert.equal(mod.name, 'smart-restart')
  // The writer helpers are NOT part of the public surface (internal module):
  // they must not be reachable from lib/index.js.
  assert.ok(!('writeRestartReasonMarker' in mod), 'writer helper must not be exported from the package surface')
  assert.ok(!('resolveRestartCause' in mod), 'cause resolver must not be exported from the package surface')
})

// --- KILL-PATH HARNESS (fires the REAL smart_restart tool; real plugin boot) --

test('harness: smart_restart writes the marker ATOMICALLY BEFORE the kill, per GRACE cause', { timeout: 30_000 }, async () => {
  const { code, signal, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`fixture timeout — out:\n${out}\nerr:\n${err}`))
    }, 25_000)
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      err += String(d)
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout: out, stderr: err })
    })
  })
  assert.equal(code, 0, `fixture exit ${code}/${signal} — stderr:\n${stderr}\nstdout:\n${stdout}`)
  // Every scenario line PASSes (the fixture asserts marker content + the
  // at-kill presence per GRACE cause; a FAIL would be visible in stdout).
  assert.match(stdout, /SCEN:canary-marker:PASS/)
  assert.match(stdout, /SCEN:canary-at-kill:PASS/)
  assert.match(stdout, /SCEN:deploy-marker:PASS/)
  assert.match(stdout, /SCEN:dshmarket-marker:PASS/)
  assert.match(stdout, /SCEN:non-grace-no-marker:PASS/)
  assert.match(stdout, /SCEN:non-grace-at-kill:PASS/)
  assert.match(stdout, /SCEN:bare-at-kill:PASS/)
  assert.match(stdout, /SCEN:broken-bootcrash-marker:PASS/)
  assert.match(stdout, /SCEN:absent-bootcrash-marker:PASS/)
  assert.match(stdout, /SCEN:fs-fail-no-marker:PASS/)
  assert.match(stdout, /SCEN:fs-fail-result:PASS/)
  assert.match(stdout, /ALL:PASS/)
})