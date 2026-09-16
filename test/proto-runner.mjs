// Prototype runner (canaryb2) — runs the REAL suite against an ALTERNATE build
// of `src/canary.ts` without touching the deployed `lib/` (which the live
// profile loads; building it IS deploying).
//
// The suite imports its subject as the literal specifier `'../lib/canary.js'`.
// This runner copies the suite to a temp file with that ONE specifier rewritten
// to the absolute build under test, so the suite's assertions run unchanged
// against the prototype. Loader-level only: no file in the repo is modified.
//
//   node test/proto-runner.mjs ./.prototype-green/canary.js
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const target = resolve(process.cwd(), process.argv[2] ?? './lib/canary.js')
const suite = resolve(process.cwd(), 'test/canary.test.js')
const dir = mkdtempSync(join(tmpdir(), 'dsh-proto-'))
const out = join(dir, 'canary.proto.test.mjs')
writeFileSync(out, readFileSync(suite, 'utf8').replace("'../lib/canary.js'", `'${pathToFileURL(target).href}'`), 'utf8')
console.log(`suite      : ${suite}`)
console.log(`subject    : ${target}`)
try {
  await import(pathToFileURL(out).href)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
