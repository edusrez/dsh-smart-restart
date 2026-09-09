// Child-process harness for the FB-234 WRITER lane (test/restart-reason.test.js
// drives it, the signal-topology.js pattern): boots the REAL plugin
// (lib/index.js `apply`) with a minimal stub cordis ctx, captures the
// registered smart_restart tool, and drives its execute the way the host
// would — with the kill path (`setsid ... systemctl restart`) replaced by a
// FAKE `setsid` on PATH that records, AT THE MOMENT OF THE KILL, whether the
// restart-reason marker was already on disk, and exits WITHOUT touching
// systemd. Everything is sandboxed under one tmpdir: DSH_HOME (the plugin's
// own marker home), the runtime stateDir (the boot-crash sidecar dir the
// marker writes to), and the fakebin dir. No dsh service, no /opt/dsh, no
// systemctl — hermetic on any machine after `pnpm build`.
//
// Scenarios (each = one smart_restart execute + one kill):
//  1. cause 'canary' + reason            → marker PRESENT at kill, content
//     {cause:'canary', reason, ts, bootId:<current boot-crash.json>}
//  2. cause 'deploy' (empty reason)      → marker PRESENT, cause 'deploy', NO
//     reason key
//  3. cause 'dshmarket'                  → marker PRESENT, cause 'dshmarket'
//  4. cause outside the GRACE set        → stale marker REMOVED, ABSENT at kill
//  5. no cause (bare restart)            → no marker, ABSENT at kill
//  6. BROKEN boot-crash.json + canary    → marker PRESENT WITHOUT bootId
//  7. ABSENT boot-crash.json + deploy    → marker PRESENT WITHOUT bootId
//  8. runtime stateDir is a FILE         → write fails silently, restart STILL
//     proceeds (ok:true) and ABSENT at kill — regression 0 (no-throw writer)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'restart-reason-harness-'))
const dshHome = join(root, 'dsh-home')
const runtimeStateDir = join(root, 'deepartments')
const fakeBin = join(root, 'fakebin')
const MARKER_NAME = 'restart-reason.json'
const markerFile = join(runtimeStateDir, MARKER_NAME)
const setsidLog = join(root, 'setsid.log')
mkdirSync(dshHome)
mkdirSync(runtimeStateDir, { recursive: true })
mkdirSync(fakeBin)

// The FAKE `setsid` (the harness's "kill"): logs its argv + the marker
// presence AT THAT MOMENT and exits 0 — the ORDERING PROOF lives inside the
// kill itself (marker on disk before the kill). Never executes systemctl.
writeFileSync(
  join(fakeBin, 'setsid'),
  `#!/bin/bash
{
  echo "ARGS:$*"
  if [ -f "${markerFile}" ]; then echo "MARKER:PRESENT"; else echo "MARKER:ABSENT"; fi
} >> "${setsidLog}"
exit 0
`,
  { mode: 0o755 },
)

process.env.DSH_HOME = dshHome
process.env.PATH = `${fakeBin}${process.env.PATH ? `:${process.env.PATH}` : ''}`

// The boot-crash sidecar fixture: the CURRENT boot being killed (bootId
// anchor). Written once; scenarios 6/7 break/remove it.
const bootCrashFile = join(runtimeStateDir, 'boot-crash.json')
writeFileSync(bootCrashFile, JSON.stringify({ bootId: 'boot-harness-1', bootStartedAt: 1_000, crashStreak: 0 }), 'utf8')

// A minimal stub ctx covering exactly the apply() surface the plugin touches:
// on/effect (fire-and-forget), agents (get/roots/list — empty registry, so the
// active-agent guard passes), sessions (get → undefined → flush skipped), and
// tools.register capturing the ToolDefinition (its return is the dispose fn).
let capturedTool = null
const ctx = {
  on: () => {},
  effect: () => () => {},
  tools: {
    register: (tool) => {
      capturedTool = tool
      return () => {}
    },
  },
  agents: { get: () => undefined, roots: () => [], list: () => [] },
  sessions: { get: () => undefined, flush: async () => {} },
}

const { apply } = await import('../lib/index.js')
apply(ctx, {
  enabled: true,
  toolEnabled: true,
  restartUnit: 'dsh-test.service',
  canaryRuntimeStateDir: runtimeStateDir,
  canary: false,
})

if (!capturedTool || typeof capturedTool.execute !== 'function') {
  console.error('HARNESS:TOOL-CAPTURE-FAILED')
  process.exit(1)
}

/** Wait until the fake-kill log has at least `n` lines (the kill spawn is
 * async — the ordering proof must read AFTER the kill actually ran). */
async function waitForLogLines(n, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      const lines = readFileSync(setsidLog, 'utf8').trim().split('\n').filter((l) => l.length > 0)
      if (lines.length >= n) return lines
    } catch {
      // log not created yet
    }
    if (Date.now() > deadline) throw new Error(`fake-kill log did not reach ${n} lines within ${budgetMs}ms`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function readMarker() {
  if (!existsSync(markerFile)) return null
  return JSON.parse(readFileSync(markerFile, 'utf8'))
}

const failures = []
function check(name, cond, detail) {
  if (!cond) failures.push(`${name}: ${detail}`)
  console.log(`SCEN:${name}:${cond ? 'PASS' : `FAIL — ${detail}`}`)
}

let logLines = 0

// --- 1. canary (explicit GRACE cause + reason) --------------------------------
{
  const res = await capturedTool.execute({ cause: 'canary', reason: 'harness canary 01:00Z' }, { agent: { id: 'asistente' } })
  await waitForLogLines(logLines + 2)
  logLines += 2
  const m = readMarker()
  const lines = readFileSync(setsidLog, 'utf8').trim().split('\n').filter(Boolean)
  const atKill = lines[lines.length - 1]
  check('canary-marker', m !== null && m.cause === 'canary' && m.ts === Number(m.ts) && Number.isFinite(m.ts) && m.bootId === 'boot-harness-1' && m.reason === 'harness canary 01:00Z', JSON.stringify(m))
  check('canary-at-kill', atKill === 'MARKER:PRESENT', atKill)
  check('canary-result', res.ok === true && res.restarting === true && res.sessionId === 'asistente', JSON.stringify(res))
}

// --- 2. deploy (empty reason → reason key omitted) ----------------------------
{
  const res = await capturedTool.execute({ cause: 'deploy', reason: '' }, { agent: { id: 'asistente' } })
  await waitForLogLines(logLines + 2)
  logLines += 2
  const m = readMarker()
  const lines = readFileSync(setsidLog, 'utf8').trim().split('\n').filter(Boolean)
  const atKill = lines[lines.length - 1]
  check('deploy-marker', m !== null && m.cause === 'deploy' && !('reason' in m) && m.bootId === 'boot-harness-1', JSON.stringify(m))
  check('deploy-at-kill', atKill === 'MARKER:PRESENT', atKill)
  check('deploy-result', res.ok === true && res.restarting === true, JSON.stringify(res))
}

// --- 3. dshmarket ---------------------------------------------------------------
{
  const res = await capturedTool.execute({ cause: 'dshmarket' }, { agent: { id: 'asistente' } })
  await waitForLogLines(logLines + 2)
  logLines += 2
  const m = readMarker()
  const lines = readFileSync(setsidLog, 'utf8').trim().split('\n').filter(Boolean)
  const atKill = lines[lines.length - 1]
  check('dshmarket-marker', m !== null && m.cause === 'dshmarket' && !('reason' in m) && m.bootId === 'boot-harness-1', JSON.stringify(m))
  check('dshmarket-at-kill', atKill === 'MARKER:PRESENT', atKill)
  check('dshmarket-result', res.ok === true, JSON.stringify(res))
}

// --- 4. cause OUTSIDE the GRACE set → stale marker REMOVED, no marker at kill -
{
  const res = await capturedTool.execute({ cause: 'oops-wild-crash' }, { agent: { id: 'asistente' } })
  await waitForLogLines(logLines + 2)
  logLines += 2
  const m = readMarker()
  const lines = readFileSync(setsidLog, 'utf8').trim().split('\n').filter(Boolean)
  const atKill = lines[lines.length - 1]
  check('non-grace-no-marker', m === null, JSON.stringify(m))
  check('non-grace-at-kill', atKill === 'MARKER:ABSENT', atKill)
  check('non-grace-result', res.ok === true, JSON.stringify(res))
}

// --- 5. NO cause (bare restart) → no marker, ABSENT at kill -------------------
{
  const res = await capturedTool.execute({}, { agent: { id: 'asistente' } })
  await waitForLogLines(logLines + 2)
  logLines += 2
  const m = readMarker()
  const lines = readFileSync(setsidLog, 'utf8').trim().split('\n').filter(Boolean)
  const atKill = lines[lines.length - 1]
  check('bare-no-marker', m === null, JSON.stringify(m))
  check('bare-at-kill', atKill === 'MARKER:ABSENT', atKill)
  check('bare-result', res.ok === true && res.restarting === true, JSON.stringify(res))
}

// --- 6. BROKEN boot-crash.json → marker STILL written, WITHOUT bootId ---------
{
  writeFileSync(bootCrashFile, '{broken', 'utf8')
  const res = await capturedTool.execute({ cause: 'canary' }, { agent: { id: 'asistente' } })
  await waitForLogLines(logLines + 2)
  logLines += 2
  const m = readMarker()
  const lines = readFileSync(setsidLog, 'utf8').trim().split('\n').filter(Boolean)
  const atKill = lines[lines.length - 1]
  check('broken-bootcrash-marker', m !== null && m.cause === 'canary' && !('bootId' in m), JSON.stringify(m))
  check('broken-bootcrash-at-kill', atKill === 'MARKER:PRESENT', atKill)
  check('broken-bootcrash-result', res.ok === true, JSON.stringify(res))
}

// --- 7. ABSENT boot-crash.json → marker STILL written, WITHOUT bootId ---------
{
  rmSync(bootCrashFile, { force: true })
  const res = await capturedTool.execute({ cause: 'deploy' }, { agent: { id: 'asistente' } })
  await waitForLogLines(logLines + 2)
  logLines += 2
  const m = readMarker()
  const lines = readFileSync(setsidLog, 'utf8').trim().split('\n').filter(Boolean)
  const atKill = lines[lines.length - 1]
  check('absent-bootcrash-marker', m !== null && m.cause === 'deploy' && !('bootId' in m), JSON.stringify(m))
  check('absent-bootcrash-at-kill', atKill === 'MARKER:PRESENT', atKill)
  check('absent-bootcrash-result', res.ok === true, JSON.stringify(res))
}

// --- 8. runtime stateDir is a FILE → writer fails silently, restart PROCEEDS --
{
  rmSync(runtimeStateDir, { recursive: true, force: true })
  writeFileSync(runtimeStateDir, 'i am a file, not a dir', 'utf8')
  const res = await capturedTool.execute({ cause: 'dshmarket' }, { agent: { id: 'asistente' } })
  await waitForLogLines(logLines + 2)
  logLines += 2
  const m = readMarker() // the marker path is inside a FILE → cannot exist
  const lines = readFileSync(setsidLog, 'utf8').trim().split('\n').filter(Boolean)
  const atKill = lines[lines.length - 1]
  check('fs-fail-no-marker', m === null, String(m))
  check('fs-fail-at-kill', atKill === 'MARKER:ABSENT', atKill)
  check('fs-fail-result', res.ok === true && res.restarting === true, JSON.stringify(res))
}

console.log(failures.length === 0 ? 'ALL:PASS' : 'ALL:FAIL')
try {
  rmSync(root, { recursive: true, force: true })
} catch {
  // best-effort cleanup
}
process.exit(failures.length === 0 ? 0 : 1)