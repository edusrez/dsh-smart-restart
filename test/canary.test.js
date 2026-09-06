// Tests for the canary pre-restart gate (src/canary.ts). Pure units plus a
// runCanary exercise with injected/fake hooks — no dsh service, no /opt/dsh,
// no systemctl required, so they pass on any machine after `pnpm build`.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPatchContent,
  checkAgentLiveness,
  checkClientGraph,
  checkDumpConfigCoherent,
  checkPoolerHealth,
  checkRuntimeMarkers,
  clientBundleRegistersId,
  deriveExecStartParams,
  extractBootGraph,
  parseCatalogMembers,
  pickFreePort,
  probeStatusHealthy,
  registeredBundleId,
  resolveExecTarget,
  runCanary,
  runPostBootRuntimeChecks,
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
  assert.ok(content.includes('- id: deepartments\n  config:\n    stateDir: "/tmp/dsh-canary-x1/deepartments"'))
})

test('buildPatchContent: override for smart-restart itself merges stateDir into its own row', () => {
  const content = buildPatchContent('/tmp/dsh-canary-x2', { 'smart-restart': '' })
  assert.ok(content.includes('- id: smart-restart\n  config:\n    enabled: false\n    stateDir: "/tmp/dsh-canary-x2/smart-restart"'))
})

test('buildPatchContent: mixed overrides emit one complete smart-restart row (enabled:false + stateDir) before the other rows', () => {
  const content = buildPatchContent('/tmp/dsh-canary-mix', { deepartments: '', 'smart-restart': '' })
  // Exactly one self-contained smart-restart block: disabled AND redirected,
  // with the merged stateDir INSIDE it (never leaked into another row).
  const srBlock = '- id: smart-restart\n  config:\n    enabled: false\n    stateDir: "/tmp/dsh-canary-mix/smart-restart"'
  assert.ok(content.includes(srBlock), `expected complete smart-restart block in:\n${content}`)
  assert.equal(content.split('- id: smart-restart').length - 1, 1, 'smart-restart row appears exactly once')
  // The other row keeps its own complete block (trailing newline: nothing
  // leaked into it).
  const deBlock = '- id: deepartments\n  config:\n    stateDir: "/tmp/dsh-canary-mix/deepartments"\n'
  assert.ok(content.includes(deBlock), `expected complete deepartments block in:\n${content}`)
  // The smart-restart block precedes the other row.
  assert.ok(content.indexOf(srBlock) < content.indexOf(deBlock), 'smart-restart row emitted before other rows')
})

test('buildPatchContent: absolute override paths are used verbatim, relative ones resolve under tmpDir', () => {
  const content = buildPatchContent('/tmp/dsh-canary-x3', { deepartments: '/tmp/abs-state', other: 'rel/dir' })
  assert.ok(content.includes('- id: deepartments\n  config:\n    stateDir: "/tmp/abs-state"'))
  assert.ok(content.includes('- id: other\n  config:\n    stateDir: "/tmp/dsh-canary-x3/rel/dir"'))
})

test('buildPatchContent: stateDir paths containing spaces render quoted (YAML-safe)', () => {
  const content = buildPatchContent('/tmp/dsh canary x', { deepartments: '' })
  assert.ok(content.includes('- id: deepartments\n  config:\n    stateDir: "/tmp/dsh canary x/deepartments"'))
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
    // The healthy boot serves a client graph whose bundle registers its row
    // id, so the (default-on) post-boot client-graph validation passes too.
    fetchUrl: serveFixture(
      { rev: 'r', entries: [{ id: 'gui', url: '/plugins/gui/client.js?rev=r1', rev: 'r1' }] },
      { gui: bundleFor('gui') },
    ),
    // The hardening checks stay out of this liveness-focused test: no
    // catalog / no runtime markers → both phases skip.
    readCatalog: () => null,
    readStateFile: () => null,
  }
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41232 }, {}, hooks)
  assert.equal(r.status, 'passed')
  assert.deepEqual(killed, [4242])
})

// --- client boot-graph post-boot validation (P1 GUI lesson, 2026-08-29) ------
//
// Fixture: the boot HTML a healthy dsh web instance serves — the composed
// `__DSH_BOOT__` graph injected as one head global row — and helper bundle
// sources with the two real envelope conventions (tab indentation from tsdown
// builds, two-space from the normalize-client-banner wrapper).
const bootHtml = (graph) =>
  `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)}</script></head><body></body></html>`

const HEALTHY_GRAPH = {
  rev: 'rev-graph',
  entries: [
    { id: 'dsh-deepartments', url: '/plugins/dsh-deepartments/client.js?rev=rev-a', rev: 'rev-a', inject: [], immediately: true },
    { id: '@deepseek-ai/dsh-client-modules', url: '/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=rev-b', rev: 'rev-b' },
  ],
}

const bundleFor = (id) =>
  `window.__ModuleLoader__.load({\n  id: "${id}",\n  factory: (require) => {\n    var module = { exports: {} };\n    return module.exports;\n  }\n});\n`

const serveFixture = (graph, bundles) => async (url, _timeoutMs) => {
  if (url.endsWith('/')) return { status: 200, body: bootHtml(graph) }
  for (const [id, body] of Object.entries(bundles)) {
    if (url.includes(`/plugins/${id}/client.js`)) return { status: 200, body }
  }
  return { status: 404, body: '' }
}

test('extractBootGraph: no __DSH_BOOT__ injection → null (a non-web boot has nothing to validate)', () => {
  assert.equal(extractBootGraph('<!doctype html><html><body>hi</body></html>'), null)
})

test('extractBootGraph: parses the injected __DSH_BOOT__ graph (entries by row id + bundle url)', () => {
  const graph = extractBootGraph(bootHtml(HEALTHY_GRAPH))
  assert.equal(graph.rev, 'rev-graph')
  assert.equal(graph.entries.length, 2)
  assert.equal(graph.entries[0].id, 'dsh-deepartments')
  assert.equal(graph.entries[0].url, '/plugins/dsh-deepartments/client.js?rev=rev-a')
  assert.equal(graph.entries[1].rev, 'rev-b')
})

test('extractBootGraph: a present payload that is malformed throws (the browser could not boot either)', () => {
  assert.throws(() => extractBootGraph('<script>globalThis["__DSH_BOOT__"] = {not:json}</script>'), /not valid JSON/)
  assert.throws(() => extractBootGraph(bootHtml({ rev: 'x' })), /no entries array/)
  assert.throws(() => extractBootGraph(bootHtml({ rev: 'x', entries: [{ url: '/plugins/a/client.js' }] })), /malformed/)
})

test('registeredBundleId: decodes the envelope id for both real bundle conventions and single-quoted ids', () => {
  const tsdown = 'window.__ModuleLoader__.load({\n\tid: "@deepseek-ai/dsh-client-modules",\n\tfactory: (require) => {}\n});'
  assert.equal(registeredBundleId(tsdown), '@deepseek-ai/dsh-client-modules')
  assert.equal(registeredBundleId(bundleFor('dsh-deepartments')), 'dsh-deepartments')
  assert.equal(registeredBundleId("window.__ModuleLoader__.load({ id: 'single-quoted', factory: () => ({}) });"), 'single-quoted')
})

test('registeredBundleId: undefined when there is no load call, no argument object, or no leading id member', () => {
  assert.equal(registeredBundleId('module.exports = {}'), undefined)
  assert.equal(registeredBundleId('window.__ModuleLoader__.load() // no argument object'), undefined)
  assert.equal(registeredBundleId('window.__ModuleLoader__.load({ factory: (require) => ({}) });'), undefined)
})

test('clientBundleRegistersId: the loader invariant — a served bundle must register its graph row id', () => {
  assert.equal(clientBundleRegistersId(bundleFor('dsh-deepartments'), 'dsh-deepartments'), true)
  assert.equal(clientBundleRegistersId(bundleFor('dsh-deepartments'), 'dshd-gui'), false)
  assert.equal(clientBundleRegistersId('// no registration here', 'dshd-gui'), false)
})

test('client-graph check: a healthy boot (every row registers its id) passes', async () => {
  const fetchUrl = serveFixture(HEALTHY_GRAPH, {
    'dsh-deepartments': bundleFor('dsh-deepartments'),
    '@deepseek-ai/dsh-client-modules': bundleFor('@deepseek-ai/dsh-client-modules'),
  })
  const r = await checkClientGraph(41240, 5000, fetchUrl)
  assert.equal(r.ok, true)
  assert.equal(r.checked, 2)
  assert.match(r.detail, /2 client row\(s\) register their graph id/)
})

test('client-graph check: P1 regression fixture — row "dshd-gui" served a bundle registering "dsh-deepartments" FAILS', async () => {
  // The P1 shape (2026-08-29): a `dshd-gui` row with `dsh.client` whose served
  // bundle is the deepartments bundle (envelope id "dsh-deepartments") — the
  // row id can never be satisfied → GUI "loaded without registering".
  const brokenGraph = {
    rev: 'rev-broken',
    entries: [
      { id: 'dshd-gui', url: '/plugins/dshd-gui/client.js?rev=rev-x', rev: 'rev-x' },
      { id: 'dsh-deepartments', url: '/plugins/dsh-deepartments/client.js?rev=rev-y', rev: 'rev-y' },
    ],
  }
  const fetchUrl = serveFixture(brokenGraph, {
    'dshd-gui': bundleFor('dsh-deepartments'),
    'dsh-deepartments': bundleFor('dsh-deepartments'),
  })
  const r = await checkClientGraph(41241, 5000, fetchUrl)
  assert.equal(r.ok, false)
  assert.match(r.detail, /row "dshd-gui" bundle served but registers "dsh-deepartments" instead of "dshd-gui"/)
})

test('client-graph check: a graph row whose bundle is missing (HTTP 404) FAILS', async () => {
  const graph = { rev: 'r', entries: [{ id: 'phantom', url: '/plugins/phantom/client.js?rev=r1', rev: 'r1' }] }
  const r = await checkClientGraph(41242, 5000, serveFixture(graph, {}))
  assert.equal(r.ok, false)
  assert.match(r.detail, /row "phantom" bundle unavailable \(HTTP 404/)
})

test('client-graph check: a boot serving no __DSH_BOOT__ (non-web surface) passes trivially', async () => {
  const fetchUrl = async () => ({ status: 200, body: '<!doctype html><html><body>no graph here</body></html>' })
  const r = await checkClientGraph(41243, 5000, fetchUrl)
  assert.equal(r.ok, true)
  assert.match(r.detail, /no __DSH_BOOT__ client graph served/)
})

test('runCanary: FAILS on a client row the served bundle cannot satisfy (the P1 config shape)', async () => {
  const brokenGraph = { rev: 'r', entries: [{ id: 'dshd-gui', url: '/plugins/dshd-gui/client.js?rev=r1', rev: 'r1' }] }
  const hooks = {
    execStartOfUnit: () => '/usr/bin/dsh --profile dev',
    pickFreePort: async () => 41244,
    dumpConfig: () => ({ ok: true, stderr: '' }),
    spawnBoot: () => ({ pid: 4244 }),
    probeLiveness: async () => true,
    killProcessGroup: () => {},
    fetchUrl: serveFixture(brokenGraph, { 'dshd-gui': bundleFor('dsh-deepartments') }),
  }
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41244 }, {}, hooks)
  assert.equal(r.status, 'failed')
  assert.match(r.detail, /row "dshd-gui" bundle served but registers "dsh-deepartments"/)
})

test('runCanary: passes a healthy boot and reports the client rows checked', async () => {
  const hooks = {
    execStartOfUnit: () => '/usr/bin/dsh --profile dev',
    pickFreePort: async () => 41245,
    dumpConfig: () => ({ ok: true, stderr: '' }),
    spawnBoot: () => ({ pid: 4245 }),
    probeLiveness: async () => true,
    killProcessGroup: () => {},
    fetchUrl: serveFixture(HEALTHY_GRAPH, {
      'dsh-deepartments': bundleFor('dsh-deepartments'),
      '@deepseek-ai/dsh-client-modules': bundleFor('@deepseek-ai/dsh-client-modules'),
    }),
    readCatalog: () => null,
    readStateFile: () => null,
  }
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41245, canaryTimeoutMs: 2000 }, {}, hooks)
  assert.equal(r.status, 'passed')
  assert.match(r.detail, /client-graph: 2 client row\(s\) register their graph id/)
})

test('runCanary: one unsatisfiable row among healthy rows fails the whole canary', async () => {
  const graph = {
    rev: 'r',
    entries: [
      { id: 'good', url: '/plugins/good/client.js?rev=r1', rev: 'r1' },
      { id: 'bad', url: '/plugins/bad/client.js?rev=r2', rev: 'r2' },
    ],
  }
  const hooks = {
    execStartOfUnit: () => '/usr/bin/dsh --profile dev',
    pickFreePort: async () => 41249,
    dumpConfig: () => ({ ok: true, stderr: '' }),
    spawnBoot: () => ({ pid: 4249 }),
    probeLiveness: async () => true,
    killProcessGroup: () => {},
    fetchUrl: serveFixture(graph, { good: bundleFor('good'), bad: bundleFor('other') }),
  }
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41249 }, {}, hooks)
  assert.equal(r.status, 'failed')
  assert.match(r.detail, /1 of 2 row\(s\) unsatisfiable/)
  assert.match(r.detail, /row "bad" bundle served but registers "other" instead of "bad"/)
})

test('runCanary: a boot without a client graph (non-web surface) still passes', async () => {
  const hooks = {
    execStartOfUnit: () => '/usr/bin/dsh --profile dev',
    pickFreePort: async () => 41247,
    dumpConfig: () => ({ ok: true, stderr: '' }),
    spawnBoot: () => ({ pid: 4247 }),
    probeLiveness: async () => true,
    killProcessGroup: () => {},
    fetchUrl: async () => ({ status: 200, body: '<!doctype html><html><body>tui</body></html>' }),
    // The 200-HTML-for-everything fixture would trip the pooler probes (200 +
    // non-JSON body), so this liveness-focused test turns the pooler phase
    // off (config); the catalog/markers phases skip on absent data.
    readCatalog: () => null,
    readStateFile: () => null,
  }
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41247, canaryPoolerCheck: false }, {}, hooks)
  assert.equal(r.status, 'passed')
  assert.match(r.detail, /no __DSH_BOOT__ client graph served/)
})

test('runCanary: a malformed __DSH_BOOT__ payload fails the canary (a page that could not boot)', async () => {
  const hooks = {
    execStartOfUnit: () => '/usr/bin/dsh --profile dev',
    pickFreePort: async () => 41248,
    dumpConfig: () => ({ ok: true, stderr: '' }),
    spawnBoot: () => ({ pid: 4248 }),
    probeLiveness: async () => true,
    killProcessGroup: () => {},
    fetchUrl: async () => ({ status: 200, body: '<script>globalThis["__DSH_BOOT__"] = {rev: "x"}</script>' }),
  }
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41248 }, {}, hooks)
  assert.equal(r.status, 'failed')
  assert.match(r.detail, /not valid JSON/)
})

test('runCanary: canaryClientCheck: false skips the client-graph phase entirely (no fetches)', async () => {
  let fetched = 0
  const hooks = {
    execStartOfUnit: () => '/usr/bin/dsh --profile dev',
    pickFreePort: async () => 41246,
    dumpConfig: () => ({ ok: true, stderr: '' }),
    spawnBoot: () => ({ pid: 4246 }),
    probeLiveness: async () => true,
    killProcessGroup: () => {},
    fetchUrl: async () => {
      fetched += 1
      throw new Error('must not fetch with canaryClientCheck: false')
    },
    // With the whole hardening suite OFF the canary touches neither HTTP
    // fetches nor the catalog/marker files (this test stays about the
    // client-graph toggle).
    readCatalog: () => null,
    listLiveAgents: () => [],
    readStateFile: () => null,
  }
  const r = await runCanary(
    undefined,
    {
      ...baseCfg,
      canaryPort: 41246,
      canaryClientCheck: false,
      canaryAgentCheck: false,
      canaryPoolerCheck: false,
      canaryMarkersCheck: false,
    },
    {},
    hooks,
  )
  assert.equal(r.status, 'passed')
  assert.equal(fetched, 0)
})

// --- post-boot runtime checks (canary hardening): agent liveness (R8) --------

const CATALOG_FIXTURE = JSON.stringify({
  'research-head': { sessionId: 'head-research-head-1', roomId: 'board' },
  'internal-programming-head': { sessionId: 'head-internal-programming-head-1', roomId: 'board' },
  'builder-9': { sessionId: 'worker-builder-9-1', roomId: 'board', role: 'builder', retired: true },
  'builder-10': { sessionId: 'worker-builder-10-1', roomId: 'board', role: 'builder' },
})

test('parseCatalogMembers: heads, workers and retired entries parse', () => {
  const members = parseCatalogMembers(CATALOG_FIXTURE)
  assert.equal(members.length, 4)
  const worker = members.find((m) => m.postId === 'builder-10')
  assert.equal(worker.kind, 'worker')
  assert.equal(worker.sessionId, 'worker-builder-10-1')
  const head = members.find((m) => m.postId === 'research-head')
  assert.equal(head.kind, 'head')
  assert.equal(members.find((m) => m.postId === 'builder-9').retired, true)
})

test('parseCatalogMembers: malformed catalog throws (a catalog the runtime could not load)', () => {
  assert.throws(() => parseCatalogMembers('{not json'), /not valid JSON/)
  assert.throws(() => parseCatalogMembers('[1,2]'), /object keyed by postId/)
  assert.throws(() => parseCatalogMembers(JSON.stringify({ 'builder-1': 42 })), /malformed/)
})

test('checkAgentLiveness: no catalog → skip (generic install)', () => {
  assert.equal(checkAgentLiveness(null, []).ok, true)
  assert.equal(checkAgentLiveness('', []).ok, true)
  assert.match(checkAgentLiveness(null, []).detail, /no catalog/)
})

test('checkAgentLiveness: only retired members → nothing to verify', () => {
  const raw = JSON.stringify({ 'builder-9': { sessionId: 's1', role: 'builder', retired: true } })
  const r = checkAgentLiveness(raw, [])
  assert.equal(r.ok, true)
  assert.match(r.detail, /no non-retired members/)
})

test('checkAgentLiveness: every non-retired member alive → ok with count (retired excluded)', () => {
  const r = checkAgentLiveness(CATALOG_FIXTURE, [
    'head-research-head-1',
    'head-internal-programming-head-1',
    'worker-builder-10-1',
    'worker-builder-9-1', // retired session id present, but the member is excluded
  ])
  assert.equal(r.ok, true)
  assert.equal(r.checked, 3)
  assert.match(r.detail, /all 3 non-retired member\(s\) alive/)
})

test('checkAgentLiveness: a non-retired member WITHOUT a live session fails (R8 liveness)', () => {
  const r = checkAgentLiveness(CATALOG_FIXTURE, ['head-research-head-1'])
  assert.equal(r.ok, false)
  assert.equal(r.checked, 3)
  assert.match(r.detail, /2 of 3 non-retired member\(s\) not alive/)
  assert.match(r.detail, /internal-programming-head \(head\)/)
  assert.match(r.detail, /builder-10 \(worker\)/)
  assert.deepEqual(r.missing, ['internal-programming-head', 'builder-10'])
})

test('checkAgentLiveness: a member with NO sessionId is never alive', () => {
  const raw = JSON.stringify({
    'head-x': { roomId: 'board' },
    'worker-y': { sessionId: 's-y', role: 'researcher' },
  })
  const r = checkAgentLiveness(raw, ['s-y'])
  assert.equal(r.ok, false)
  assert.match(r.detail, /head-x \(head, no sessionId\)/)
})

test('checkAgentLiveness: malformed catalog fails (never a skip)', () => {
  const r = checkAgentLiveness('{not json', ['anything'])
  assert.equal(r.ok, false)
  assert.match(r.detail, /not valid JSON/)
})

// --- pooler health (graceful on missing endpoints — fb-75 deploy PENDING) ---

test('checkPoolerHealth: all endpoints healthy (200 + JSON) pass', async () => {
  const fetchUrl = async (url) => {
    if (url.endsWith('/v1/models')) return { status: 200, body: JSON.stringify({ object: 'list', data: [{ id: 'm1' }] }) }
    if (url.endsWith('/usage')) return { status: 200, body: JSON.stringify({ usage: { rolling: { status: 'ok' } } }) }
    if (url.endsWith('/__keypool/status')) return { status: 200, body: JSON.stringify({ pool: 'ok' }) }
    return { status: 404, body: '' }
  }
  const r = await checkPoolerHealth(41300, 3000, fetchUrl)
  assert.equal(r.ok, true)
  assert.deepEqual(r.checked, ['/v1/models', '/usage', '/__keypool/status'])
  assert.deepEqual(r.skipped, [])
})

test('checkPoolerHealth: fb-75 fixture — a missing /__keypool/status (404) SKIPS gracefully', async () => {
  // The pre-fb-75 pooler: /v1/models + /usage exist, /__keypool/status 404s.
  const fetchUrl = async (url) => {
    if (url.endsWith('/v1/models')) return { status: 200, body: JSON.stringify({ data: [] }) }
    if (url.endsWith('/usage')) return { status: 200, body: JSON.stringify({ usage: {} }) }
    return { status: 404, body: '<html>spa fallback</html>' }
  }
  const r = await checkPoolerHealth(41301, 3000, fetchUrl)
  assert.equal(r.ok, true)
  assert.deepEqual(r.checked, ['/v1/models', '/usage'])
  assert.deepEqual(r.skipped, ['/__keypool/status'])
})

test('checkPoolerHealth: ALL endpoints missing (pooler not in this boot) passes harmlessly', async () => {
  const r = await checkPoolerHealth(41302, 3000, async () => ({ status: 404, body: '' }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.checked, [])
  assert.equal(r.skipped.length, 3)
})

test('checkPoolerHealth: a 5xx endpoint FAILS (a broken pooler is an outage, not an absence)', async () => {
  const fetchUrl = async (url) =>
    url.endsWith('/usage') ? { status: 500, body: '' } : { status: 200, body: JSON.stringify({ data: [] }) }
  const r = await checkPoolerHealth(41303, 3000, fetchUrl)
  assert.equal(r.ok, false)
  assert.match(r.detail, /\/usage returned HTTP 500/)
})

test('checkPoolerHealth: 200 with a non-JSON body FAILS (broken handler)', async () => {
  const fetchUrl = async (url) =>
    url.endsWith('/v1/models') ? { status: 200, body: '<html>not json</html>' } : { status: 404, body: '' }
  const r = await checkPoolerHealth(41304, 3000, fetchUrl)
  assert.equal(r.ok, false)
  assert.match(r.detail, /non-JSON body/)
})

test('checkPoolerHealth: a models 200 without a data array FAILS (shape sanity)', async () => {
  const fetchUrl = async () => ({ status: 200, body: JSON.stringify({ object: 'list' }) })
  const r = await checkPoolerHealth(41305, 3000, fetchUrl)
  assert.equal(r.ok, false)
  assert.match(r.detail, /no data array/)
})

test('checkPoolerHealth: an unreachable endpoint (network failure) FAILS', async () => {
  const r = await checkPoolerHealth(41306, 3000, async () => null)
  assert.equal(r.ok, false)
  assert.match(r.detail, /unreachable/)
})

// --- config integrity (dump-config coherence) ---------------------------------

const PATCHED_DUMP = [
  '# == dsh-base',
  '- id: timer',
  "  name: '@deepseek-ai/cordis-plugin-timer'",
  '# == dsh-smart-restart, patched by /tmp/dsh-canary-x/canary.patch.yml',
  '- id: smart-restart',
  '  name: dsh-smart-restart',
  '  config:',
  '    enabled: false',
  '    stateDir: .smart-restart',
  '- id: deepartments',
  '  name: dsh-deepartments',
  '  config:',
  '    stateDir: /tmp/dsh-canary-x/deepartments',
].join('\n')

const UNPATCHED_DUMP = PATCHED_DUMP.replace('    enabled: false', '    enabled: true')

test('checkDumpConfigCoherent: patched dump — coherent entry list with smart-restart disabled', () => {
  const r = checkDumpConfigCoherent(PATCHED_DUMP)
  assert.equal(r.ok, true)
  assert.equal(r.rows, 3)
  assert.equal(r.smartRestartDisabled, true)
  assert.match(r.detail, /smart-restart row disabled/)
})

test('checkDumpConfigCoherent: an ENABLED smart-restart row fails (patch not applied → live-state leak)', () => {
  const r = checkDumpConfigCoherent(UNPATCHED_DUMP)
  assert.equal(r.ok, false)
  assert.match(r.detail, /smart-restart row is NOT disabled/)
})

test('checkDumpConfigCoherent: a row-level `disabled: true` form is accepted too', () => {
  const dump = ['- id: smart-restart', '  name: dsh-smart-restart', '  disabled: true'].join('\n')
  const r = checkDumpConfigCoherent(dump)
  assert.equal(r.ok, true)
  assert.equal(r.smartRestartDisabled, true)
})

test('checkDumpConfigCoherent: no smart-restart row in the tree → ok note (nothing to disable)', () => {
  const dump = ['- id: timer', '  name: t', '- id: deepartments', '  name: dsh-deepartments'].join('\n')
  const r = checkDumpConfigCoherent(dump)
  assert.equal(r.ok, true)
  assert.equal(r.smartRestartDisabled, false)
  assert.match(r.detail, /no smart-restart row/)
})

test('checkDumpConfigCoherent: unavailable stdout → skip; empty stdout → fail', () => {
  assert.equal(checkDumpConfigCoherent(undefined).ok, true)
  assert.equal(checkDumpConfigCoherent(null).ok, true)
  const r = checkDumpConfigCoherent('')
  assert.equal(r.ok, false)
  assert.match(r.detail, /empty output/)
})

test('checkDumpConfigCoherent: blank lines (incl. inside block scalars) are tolerated — the real-dump shape', () => {
  // The real deepartments-dev dump carries blank lines between rows and inside
  // the plan-mode `section: >` folded scalar; they are noise, never a break.
  const dump = [
    '- id: smart-restart',
    '  name: dsh-smart-restart',
    '  config:',
    '    enabled: false',
    '',
    '- id: plan-mode',
    "  name: '@deepseek-ai/dsh-plan-mode'",
    '  config:',
    '    section: >',
    '      You are in plan mode.',
    '',
    '      Explore first.',
    '- id: deepartments',
    '  name: dsh-deepartments',
  ].join('\n')
  const r = checkDumpConfigCoherent(dump)
  assert.equal(r.ok, true)
  assert.equal(r.rows, 3)
  assert.equal(r.smartRestartDisabled, true)
})

test('checkDumpConfigCoherent: no rows → fail; a column-0 non-row line inside a block → fail', () => {
  assert.equal(checkDumpConfigCoherent('# only comments\n').ok, false)
  const bad = ['- id: smart-restart', '  name: n', 'stray-line-at-column-0'].join('\n')
  const r = checkDumpConfigCoherent(bad)
  assert.equal(r.ok, false)
  assert.match(r.detail, /column-0 line/)
})

// --- runtime markers (R8 presence + R9 toolset-audit) -------------------------

const PRESENCE_FIXTURE = JSON.stringify({ present: false, updatedAt: Date.now() - 60_000 })
const AUDIT_FIXTURE = ['{"ts":1,"wp":"post-mount","postId":"w1"}', '{"ts":2,"wp":"probe","postId":"w1"}'].join('\n')

test('checkRuntimeMarkers: presence + audit well-formed pass (freshness reported, not enforced)', () => {
  const r = checkRuntimeMarkers(PRESENCE_FIXTURE, AUDIT_FIXTURE, Date.now())
  assert.equal(r.ok, true)
  assert.equal(r.presence, 'ok')
  assert.equal(r.audit, 'ok')
  assert.match(r.detail, /presence.json ok/)
  assert.match(r.detail, /toolset-audit.jsonl ok \(2 row/)
})

test('checkRuntimeMarkers: absent files skip (generic install)', () => {
  const r = checkRuntimeMarkers(null, null)
  assert.equal(r.ok, true)
  assert.equal(r.presence, 'skipped')
  assert.equal(r.audit, 'skipped')
})

test('checkRuntimeMarkers: malformed presence fails; a truncated TRAILING audit row is tolerated', () => {
  const badPresence = checkRuntimeMarkers('{bad', AUDIT_FIXTURE)
  assert.equal(badPresence.ok, false)
  assert.match(badPresence.detail, /not valid JSON/)
  // The append-only sidecar can be mid-write at read time: the LAST row being
  // truncated must not fail the canary.
  const withTruncatedTail = `${AUDIT_FIXTURE}\n{"ts":3,"wp":"probe","postId":"w1"`
  const r = checkRuntimeMarkers(PRESENCE_FIXTURE, withTruncatedTail, Date.now())
  assert.equal(r.ok, true)
  assert.equal(r.audit, 'ok')
})

test('checkRuntimeMarkers: a malformed NON-tail audit row fails (broken writer)', () => {
  const bad = '{"ts":1,"wp":"ok"}\nNOT_JSON\n{"ts":3,"wp":"ok"}'
  const r = checkRuntimeMarkers(PRESENCE_FIXTURE, bad)
  assert.equal(r.ok, false)
  assert.match(r.detail, /malformed row 2 of 3/)
})

test('checkRuntimeMarkers: presence with a missing shape field fails', () => {
  const r = checkRuntimeMarkers(JSON.stringify({ present: true }), AUDIT_FIXTURE)
  assert.equal(r.ok, false)
  assert.match(r.detail, /malformed/)
})

// --- runCanary integration with the new post-boot checks ----------------------

const healthyHooks = (overrides = {}) => ({
  execStartOfUnit: () => '/usr/bin/dsh --profile dev',
  pickFreePort: async () => 41310,
  dumpConfig: () => ({ ok: true, stderr: '', stdout: PATCHED_DUMP }),
  spawnBoot: () => ({ pid: 4310 }),
  probeLiveness: async () => true,
  killProcessGroup: () => {},
  ...overrides,
})

test('runCanary: a fully healthy hardening pass — catalog, pooler, markers — passes with details', async () => {
  const killed = []
  const hooks = healthyHooks({
    killProcessGroup: (pid) => killed.push(pid),
    readCatalog: () => CATALOG_FIXTURE,
    listLiveAgents: () => ['head-research-head-1', 'head-internal-programming-head-1', 'worker-builder-10-1'],
    readStateFile: (rel) =>
      rel === 'presence.json' ? PRESENCE_FIXTURE : rel === 'toolset-audit.jsonl' ? AUDIT_FIXTURE : null,
    fetchUrl: async (url) => {
      if (url.endsWith('/')) return { status: 200, body: bootHtml({ rev: 'r', entries: [] }) }
      if (url.includes('/v1/models')) return { status: 200, body: JSON.stringify({ data: [{ id: 'm' }] }) }
      if (url.includes('/usage')) return { status: 200, body: JSON.stringify({ usage: {} }) }
      if (url.includes('/__keypool/status')) return { status: 200, body: JSON.stringify({ pool: 'ok' }) }
      return { status: 404, body: '' }
    },
  })
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41310 }, {}, hooks)
  assert.equal(r.status, 'passed')
  assert.deepEqual(killed, [4310])
  assert.match(r.detail, /agent-liveness: all 3 non-retired member\(s\) alive/)
  assert.match(r.detail, /pooler: 3 endpoint\(s\) healthy/)
  assert.match(r.detail, /presence.json ok/)
  assert.match(r.detail, /toolset-audit.jsonl ok/)
})

test('runCanary: agent-liveness failure blocks the restart (registered member not alive)', async () => {
  const killed = []
  const hooks = healthyHooks({
    killProcessGroup: (pid) => killed.push(pid),
    readCatalog: () => CATALOG_FIXTURE,
    listLiveAgents: () => ['head-research-head-1'], // builder-10 + IP head missing
    readStateFile: () => null,
    fetchUrl: serveFixture({ rev: 'r', entries: [] }, {}),
  })
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41311 }, {}, hooks)
  assert.equal(r.status, 'failed')
  assert.deepEqual(killed, [4310])
  assert.match(r.detail, /2 of 3 non-retired member\(s\) not alive/)
})

test('runCanary: pooler 5xx blocks the restart', async () => {
  const killed = []
  const hooks = healthyHooks({
    killProcessGroup: (pid) => killed.push(pid),
    readCatalog: () => null,
    readStateFile: () => null,
    fetchUrl: async (url) => {
      if (url.endsWith('/')) return { status: 200, body: bootHtml({ rev: 'r', entries: [] }) }
      if (url.includes('/usage')) return { status: 500, body: '' }
      if (url.includes('/v1/models')) return { status: 200, body: JSON.stringify({ data: [] }) }
      return { status: 404, body: '' }
    },
  })
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41312 }, {}, hooks)
  assert.equal(r.status, 'failed')
  assert.match(r.detail, /pooler: \/usage returned HTTP 500/)
  assert.deepEqual(killed, [4310])
})

test('runCanary: pooler endpoints missing (fb-75 deploy PENDING fixture) is graceful — canary passes', async () => {
  const hooks = healthyHooks({
    readCatalog: () => null,
    readStateFile: () => null,
    fetchUrl: async (url) => {
      if (url.endsWith('/')) return { status: 200, body: bootHtml({ rev: 'r', entries: [] }) }
      return { status: 404, body: '<html>spa</html>' } // no pooler routes mounted
    },
  })
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41313 }, {}, hooks)
  assert.equal(r.status, 'passed')
  assert.match(r.detail, /3 endpoint\(s\) not deployed — graceful skip/)
})

test('runCanary: an incoherent dump-config (enabled smart-restart row) fails BEFORE spawn', async () => {
  let spawned = false
  const hooks = healthyHooks({
    dumpConfig: () => ({ ok: true, stderr: '', stdout: UNPATCHED_DUMP }),
    spawnBoot: () => {
      spawned = true
      return { pid: 4311 }
    },
  })
  const r = await runCanary(undefined, { ...baseCfg, canaryPort: 41314 }, {}, hooks)
  assert.equal(r.status, 'failed')
  assert.equal(spawned, false)
  assert.match(r.detail, /dump-config integrity failed/)
})

test('runCanary: every hardening check can be disabled with config (client graph off included)', async () => {
  let fetched = 0
  const hooks = healthyHooks({
    fetchUrl: async () => {
      fetched += 1
      throw new Error('must not fetch with all checks disabled')
    },
  })
  const r = await runCanary(
    undefined,
    {
      ...baseCfg,
      canaryPort: 41315,
      canaryClientCheck: false,
      canaryAgentCheck: false,
      canaryPoolerCheck: false,
      canaryMarkersCheck: false,
    },
    {},
    hooks,
  )
  assert.equal(r.status, 'passed')
  assert.equal(fetched, 0)
  assert.match(r.detail, /agent-liveness check disabled \(config\)/)
  assert.match(r.detail, /pooler-health check disabled \(config\)/)
  assert.match(r.detail, /runtime-markers check disabled \(config\)/)
})

test('runPostBootRuntimeChecks: disabled checks report per-phase notes without reading anything', async () => {
  let reads = 0
  const r = await runPostBootRuntimeChecks(
    { canaryAgentCheck: false, canaryPoolerCheck: false, canaryMarkersCheck: false },
    undefined,
    41316,
    {
      readCatalog: () => {
        reads += 1
        return CATALOG_FIXTURE
      },
      fetchUrl: async () => {
        reads += 1
        return null
      },
    },
  )
  assert.equal(r.ok, true)
  assert.equal(reads, 0)
  assert.match(r.detail, /agent-liveness check disabled/)
})