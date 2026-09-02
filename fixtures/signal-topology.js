// Child-process fixture for the RD #483 re-raise regression tests
// (test/signal.test.js). Models the REAL host SIGTERM topology:
//   - core-bootstrap-style handler (registered FIRST, like the real host's
//     profile-boot): starts a graceful async "dispose"; a SECOND signal while
//     the dispose is pending force-exits immediately (the profile-boot
//     interrupt() → forceExitOnce semantics that the old unconditional
//     re-raise used to trigger).
//   - smart-restart-style handler (registered LAST): uses the REAL
//     shouldReRaiseSignal export, exactly as src/index.ts does after the fix,
//     and re-raises only when it is the last registered listener.
//
// Env: TOPOLOGY=bare|host (default bare); LEGACY=1 forces the pre-#483
// unconditional re-raise so the test proves the smoke is sensitive to the fix.
// The parent only sends SIGTERM after this process prints "READY".
import { shouldReRaiseSignal } from '../lib/index.js'

const topology = process.env.TOPOLOGY ?? 'bare'
const legacy = process.env.LEGACY === '1'

let disposing = false
if (topology === 'host') {
  // Registered FIRST, like the real host's bootstrap (profile-boot).
  process.on('SIGTERM', () => {
    if (disposing) {
      // Second signal while the graceful dispose is pending → force-exit
      // immediately (this is what the old re-raise made the bootstrap do).
      process.stdout.write('FORCE_EXIT\n')
      process.exit(0)
    }
    disposing = true
    setTimeout(() => {
      process.stdout.write('DISPOSE_COMPLETE\n') // graceful dispose drained
      process.exit(0)
    }, 150)
  })
}

// The smart-restart-style handler (registered LAST). The decision is the REAL
// shouldReRaiseSignal used by src/index.ts; LEGACY=1 only overrides it to
// reproduce the pre-fix unconditional re-raise for the sensitivity probe.
const onSigterm = () => {
  if (legacy || shouldReRaiseSignal('SIGTERM')) {
    process.removeListener('SIGTERM', onSigterm)
    process.kill(process.pid, 'SIGTERM')
  }
}
process.on('SIGTERM', onSigterm)

process.stdout.write('READY\n')

// Keep the event loop alive until the parent's SIGTERM arrives (signal
// listeners alone do not keep a Node process running).
setInterval(() => {}, 1000)