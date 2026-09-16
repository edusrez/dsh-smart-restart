// RED EVIDENCE for the CVE-2026-82533 canary probe (canaryb2).
//
// Proves the BEHAVIORAL defect on the UNMODIFIED artifact: against a real HTTP
// server that answers 401 on `/` — exactly what the hardened 0.1.5 tree does to
// an unauthenticated read — the canary's liveness declares the instance NOT
// healthy, so the whole window burns and the canary FAILS a tree that is up and
// whose auth is doing its job.
//
// Run against the PRE-fix artifact (the `lib/` on disk, never modified):
//   node test/red-401-liveness.mjs ../lib/canary.js
// and, for the expected GREEN, against a build of the patched `src/`:
//   node test/red-401-liveness.mjs <path-to-patched-canary.js>
//
// `process.argv[2]` is the module under test (default: the on-disk `lib/`).
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.argv[2] ?? '../lib/canary.js'
const canary = await import(pathToFileURL(resolve(process.cwd(), modulePath)).href)

// A real listener standing in for the hardened web surface: `/` is behind the
// auth wall, so an unauthenticated read is 401 with the runtime's own body.
const WALL = createServer((req, res) => {
  if ((req.url ?? '/') === '/') {
    res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
    return
  }
  res.writeHead(404).end()
})

await new Promise((resolve) => WALL.listen(0, '127.0.0.1', resolve))
const port = WALL.address().port

const PATCHED_DUMP = [
  '- id: smart-restart',
  '  name: dsh-smart-restart',
  '  config:',
  '    enabled: false',
].join('\n')

const hooks = {
  execStartOfUnit: () => null,
  dumpConfig: () => ({ ok: true, stderr: '', stdout: PATCHED_DUMP }),
  spawnBoot: () => ({ pid: 4599 }),
  killProcessGroup: () => {},
  readBootStdout: () => null,
  readCatalog: () => null,
  readStateFile: () => null,
}

const cfg = {
  restartUnit: 'dsh.service',
  canary: true,
  canaryTimeoutMs: 1500,
  canaryPort: port,
  canaryBinary: '/usr/bin/dsh',
  canaryProfile: '',
  canaryStateDirOverrides: {},
  canaryClientCheck: false,
  canaryAgentCheck: false,
  canaryPoolerCheck: false,
  canaryMarkersCheck: false,
}

console.log(`module under test : ${modulePath}`)
console.log(`auth-walled server: 127.0.0.1:${port} → GET / = 401 (a HEALTHY, auth-hardened tree)`)
console.log(`probeStatusHealthy(401) = ${String(canary.probeStatusHealthy(401))}`)

const r = await canary.runCanary(undefined, cfg, {}, hooks)
console.log(`runCanary status  : ${r.status}`)
console.log(`runCanary detail  : ${r.detail}`)

WALL.close()

const verdict = r.status === 'passed'
  ? 'GREEN — the auth wall is read as ALIVE (the probe is fixed)'
  : 'RED — a 401-serving (healthy) tree is declared NOT healthy: the canary blocks the switch'
console.log(`VERDICT           : ${verdict}`)
process.exitCode = verdict.startsWith('RED') ? 1 : 0
