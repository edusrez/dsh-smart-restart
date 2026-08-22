// Tests for the canary pre-restart gate (src/canary.ts). Pure units plus a
// runCanary exercise with injected/fake hooks — no dsh service, no /opt/dsh,
// no systemctl required, so they pass on any machine after `pnpm build`.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPatchContent,
  deriveExecStartParams,
  pickFreePort,
  probeStatusHealthy,
  resolveExecTarget,
  runCanary,
} from '../lib/canary.js'

// --- deriveExecStartParams --------------------------------------------------

test('deriveExecStartParams: plain ExecStart with --profile', () => {
  assert.deepEqual(deriveExecStartParams('/usr/bin/dsh --profile deepartments-dev --port 3090 --trusted-host localhost'), {
    binary: '/usr/bin/dsh',
    profile: 'deepartments-dev',
  })
})

test('deriveExecStartParams: systemctl record form (argv[]= payload)', () => {
  const line = 'ExecStart={ path=/usr/bin/dsh ; argv[]=/usr/bin/dsh --profile deepartments-dev --port 3090 ; ignore_errors=no ; start_time=[n/a] }'
  assert.deepEqual(deriveExecStartParams(line), {
    binary: '/usr/bin/dsh',
    profile: 'deepartments-dev',
  })
})

test('deriveExecStartParams: skips leading env assignments and an env wrapper', () => {
  assert.deepEqual(deriveExecStartParams('FOO=bar BAZ=qux /usr/bin/env /usr/bin/dsh --profile prod'), {
    binary: '/usr/bin/dsh',
    profile: 'prod',
  })
})

test('deriveExecStartParams: no --profile → profile omitted', () => {
  assert.deepEqual(deriveExecStartParams('/usr/bin/dsh --port 3090'), { binary: '/usr/bin/dsh' })
})

test('deriveExecStartParams: null when there is no executable', () => {
  assert.equal(deriveExecStartParams(''), null)
  assert.equal(deriveExecStartParams('   '), null)
  assert.equal(deriveExecStartParams('FOO=bar'), null)
  assert.equal(deriveExecStartParams('/usr/bin/env'), null)
})

// --- buildPatchContent ------------------------------------------------------

test('buildPatchContent: disables smart-restart and applies a relative override under tmpDir', () => {
  const content = buildPatchContent('/tmp/dsh-canary-x1', { deepartments: '' })
  assert.ok(content.includes('- id: smart-restart\n  config:\n    enabled: false'))
  assert.ok(content.includes('- id: deepartments\n  config:\n    stateDir: /tmp/dsh-canary-x1/deepartments'))
})

test('buildPatchContent: override for smart-restart itself merges stateDir into its own row', () => {
  const content = buildPatchContent('/tmp/dsh-canary-x2', { 'smart-restart': '' })
  assert.ok(content.includes('- id: smart-restart\n  config:\n    enabled: false\n    stateDir: /tmp/dsh-canary-x2/smart-restart'))
})

test('buildPatchContent: absolute override paths are used verbatim, relative ones resolve under tmpDir', () => {
  const content = buildPatchContent('/tmp/dsh-canary-x3', { deepartments: '/tmp/abs-state', other: 'rel/dir' })
  assert.ok(content.includes('- id: deepartments\n  config:\n    stateDir: /tmp/abs-state'))
  assert.ok(content.includes('- id: other\n  config:\n    stateDir: /tmp/dsh-canary-x3/rel/dir'))
})

test('buildPatchContent: emitted document is a well-formed top-level row list', () => {
  const content = buildPatchContent('/tmp/dsh-canary-x4', { deepartments: '', b: '/abs' })
  const body = content
    .trimEnd()
    .split('\n')
    .filter((line) => !line.startsWith('#'))
  for (const line of body) {
    // Every line of the body must be a top-level `- id:` row, a 2-space
    // `config:` block, or a 4-space key: value within a config block —
    // the exact shape the dsh entry-list loader parses (no YAML parser ships
    // with this repo, so validity is asserted structurally).
    assert.match(line, /^(?:- id: \S+| {2}config:| {4}[A-Za-z][A-Za-z0-9]*: .+)$/, `unexpected line: ${line}`)
  }
  assert.ok(body[0].startsWith('- id: smart-restart'))
})

// --- pickFreePort (auto-pick) ------------------------------------------------

test('pickFreePort: two concurrent picks differ and are valid port numbers', async () => {
  const [a, b] = await Promise.all([pickFreePort(), pickFreePort()])
  assert.notEqual(a, b)
  assert.ok(Number.isInteger(a) && a > 0 && a <= 65535, `invalid port: ${a}`)
  assert.ok(Number.isInteger(b) && b > 0 && b <= 65535, `invalid port: ${b}`)
})

// --- liveness result mapping -------------------------------------------------

test('probeStatusHealthy: HTTP 200 is healthy; refused / other statuses are not', () => {
  assert.equal(probeStatusHealthy(200), true)
  assert.equal(probeStatusHealthy(undefined), false) // ECONNREFUSED → no response
  assert.equal(probeStatusHealthy(0), false)
  assert.equal(probeStatusHealthy(404), false)
  assert.equal(probeStatusHealthy(500), false)
})

// --- resolveExecTarget -------------------------------------------------------

test('resolveExecTarget: explicit config wins, derived fills the gap, impossible → null', () => {
  assert.deepEqual(resolveExecTarget({ canaryBinary: '/bin/dsh', canaryProfile: 'p' }, { binary: '/usr/bin/dsh', profile: 'q' }), {
    binary: '/bin/dsh',
    profile: 'p',
  })
  assert.deepEqual(resolveExecTarget({ canaryBinary: '', canaryProfile: '' }, { binary: '/usr/bin/dsh', profile: 'q' }), {
    binary: '/usr/bin/dsh',
    profile: 'q',
  })
  assert.deepEqual(resolveExecTarget({ canaryBinary: '', canaryProfile: '' }, null), null)
  // Explicit binary alone escapes the "cannot derive" skip (binary falls back to 'dsh').
  assert.deepEqual(resolveExecTarget({ canaryBinary: '/bin/dsh', canaryProfile: '' }, null), {
    binary: '/bin/dsh',
    profile: '',
  })
})

// --- runCanary with injected/fake hooks --------------------------------------

const baseCfg = {
  restartUnit: 'dsh.service',
  canary: true,
  canaryTimeoutMs: 1000,
  canaryPort: 0,
  canaryProfile: '',
  canaryBinary: '',
  canaryStateDirOverrides: {},
}

test('runCanary: skipped (never blocks) when disabled for the call', async () => {
  const r = await runCanary(undefined, { ...baseCfg, canary: false }, {}, {})
  assert.equal(r.status, 'skipped')
  assert.equal(r.detail, 'canary not enabled')
})

test('runCanary: skipped (never blocks) when the launch cannot be derived (no systemctl, no explicit binary/profile)', async () => {
  const hooks = { execStartOfUnit: () => null } // e.g. systemctl unavailable
  const r = await runCanary(undefined, baseCfg, {}, hooks)
  assert.equal(r.status, 'skipped')
  assert.equal(r.detail, 'cannot derive dsh binary/profile for canary')
})

test('runCanary: failed on a dump-config failure — nothing is spawned, nothing is probed', async () => {
  let spawned = false
  const hooks = {
    execStartOfUnit: () => '/usr/bin/dsh --profile dev',
    pickFreePort: async () => 41230,
    dumpConfig: () => ({ ok: false, stderr: 'bad config' }),
    spawnBoot: () => {
      spawned = true
      return { pid: 4240 }
    },
    probeLiveness: async () => true,
  }
  const r = await runCanary(undefined, baseCfg, {}, hooks)
  assert.equal(r.status, 'failed')
  assert.equal(r.detail, 'dump-config failed: bad config')
  assert.equal(spawned, false)
})

test("runCanary: failed when the boot never becomes healthy — timeout detail, group killed", async () => {
  const killed = []
  const hooks = {
    execStartOfUnit: () => '/usr/bin/dsh --profile dev',
    pickFreePort: async () => 41231,
    dumpConfig: () => ({ ok: true, stderr: '' }),
    spawnBoot: () => ({ pid: 4241 }),
    probeLiveness: async () => false, // simulates the whole timeout window
    killProcessGroup: (pid) => killed.push(pid),
  }
  const r = await runCanary(undefined, { ...baseCfg, canaryTimeoutMs: 90000 }, {}, hooks)
  assert.equal(r.status, 'failed')
  assert.equal(r.detail, 'canary boot did not become healthy within 90000ms')
  assert.deepEqual(killed, [4241])
})

test('runCanary: passed when the fake boot becomes healthy — process group killed before returning', async () => {
  const killed = []
  const hooks = {
    execStartOfUnit: () => '/usr/bin/dsh --profile dev',
    pickFreePort: async () => 41232,
    dumpConfig: () => ({ ok: true, stderr: '' }),
    spawnBoot: () => ({ pid: 4242 }),
    probeLiveness: async () => true,
    killProcessGroup: (pid) => killed.push(pid),
  }
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41232 }, {}, hooks)
  assert.equal(r.status, 'passed')
  assert.deepEqual(killed, [4242])
})