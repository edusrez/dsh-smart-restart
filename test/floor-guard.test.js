// GATE on the FLOOR of `scripts.test` (package.json): the scoped sweep MUST fail LOUDLY
// when it matches ZERO test files.
//
// WHY THIS FILE EXISTS. The floor that keeps the sweep safe is the
// `[ -n "$TESTS" ] || { …; exit 1; }` guard, NOT the `ls` prefix: the prefix is joined to
// the terminator by `;` (not `&&`), so the substitution's exit status is never propagated —
// `$TESTS` simply arrives EMPTY and a bare `node --test` runs with NO argument, falling back
// to the default whole-`test/` tree walk (the class that broke CI runs #19/#20) and exiting 0.
// Because the prose once credited the `ls` prefix for the floor, the guard could look
// redundant and be deleted. Prose cannot stop that; this gate can.
//
// HOW. It asserts the BEHAVIOR, not the wording: it takes the real `scripts.test` string out
// of package.json, RUNS it with `sh -c` in a throwaway cwd whose `test/` directory is EMPTY
// (exactly the renamed/emptied-suite state the floor exists for), and requires a NON-ZERO
// outcome. Delete the guard and that same run falls through to `node --test` with no
// arguments, which exits 0 on an empty tree — so this test goes RED naming the reason.
// Asserting behavior instead of a substring means a script that reaches the same floor by
// another (equally loud) mechanism still passes: the gate pins safety, not spelling.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

test('scripts.test: a ZERO-match scoped sweep is LOUD (the guard is the floor, not the `ls` prefix)', () => {
  const script = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts?.test
  assert.equal(typeof script, 'string', 'package.json must declare a string scripts.test')
  assert.ok(script.length > 0, 'scripts.test must not be empty')

  // A throwaway cwd with an EMPTY test/ dir: `ls -1 test/*.test.js` matches nothing —
  // indistinguishable from a renamed or emptied suite.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-floor-gate-'))
  try {
    mkdirSync(join(dir, 'test'))
    // NODE_TEST_CONTEXT is dropped so the nested run behaves as a STANDALONE run
    // (as CI does) instead of a nested one, which node would refuse to run files in.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const run = spawnSync('sh', ['-c', script], { cwd: dir, env, encoding: 'utf8' })
    assert.ok(run.status !== null, `scripts.test could not be executed: ${run.error?.message}`)
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    assert.notEqual(
      run.status,
      0,
      'scripts.test exited 0 on a ZERO-match sweep: the floor is GONE, so a bare `node --test` ' +
        'has re-enabled the whole-test/-tree walk that broke CI runs #19/#20. Output: ' +
        `${out.trim().slice(0, 400)}`,
    )
    // Deliberately a WEAK wording probe: it only requires that the refusal names the
    // condition it detected, so reformulating the FATAL message does not red the gate.
    // The load-bearing assertion is the non-zero status above.
    assert.match(
      out,
      /zero/i,
      'the floor must announce WHY it refused (a loud, self-explaining non-zero, not a bare one)',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
