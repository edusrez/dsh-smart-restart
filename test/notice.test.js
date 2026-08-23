// Tests for the notice-building logic (src/boot.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNotice, humanizeDowntime } from '../lib/boot.js'

test('buildNotice: custom notice passes through verbatim', () => {
  const out = buildNotice({
    bootAt: '2026-08-18T12:00:00.000Z',
    downtimeMs: 5000,
    customNotice: 'Custom text here',
  })
  assert.equal(out, 'Custom text here')
})

test('buildNotice: empty custom notice is ignored (falls through to default)', () => {
  const out = buildNotice({
    bootAt: '2026-08-18T12:00:00.000Z',
    downtimeMs: 5000,
    customNotice: '',
  })
  assert.match(out, /Smart-restart: the DSH service restarted at 2026-08-18T12:00:00\.000Z\./)
  assert.match(out, /resume it/)
})

test('buildNotice: default text includes bootAt and resume instruction', () => {
  const out = buildNotice({ bootAt: '2026-08-18T12:00:00.000Z', downtimeMs: 0 })
  assert.match(out, /the DSH service restarted at 2026-08-18T12:00:00\.000Z\./)
  assert.match(out, /If a task was in progress, resume it/)
})

test('buildNotice: includes previous boot + downtime when prevBootAt given', () => {
  const out = buildNotice({
    bootAt: '2026-08-18T12:00:00.000Z',
    prevBootAt: '2026-08-18T11:59:00.000Z',
    downtimeMs: 60000,
  })
  assert.match(out, /Previous boot: 2026-08-18T11:59:00\.000Z/)
  assert.match(out, /downtime ~1m/)
})

test('buildNotice: omits previous boot line when prevBootAt absent', () => {
  const out = buildNotice({ bootAt: '2026-08-18T12:00:00.000Z', downtimeMs: 60000 })
  assert.doesNotMatch(out, /Previous boot/)
})

test('buildNotice: includes reason before the resume instruction', () => {
  const out = buildNotice({
    bootAt: '2026-08-18T12:00:00.000Z',
    downtimeMs: 60000,
    reason: 'installed dshmarket in stable+dev',
  })
  assert.match(out, /reason: installed dshmarket in stable\+dev\./)
  assert.match(out, /If a task was in progress, resume it/)
  // reason must come BEFORE the resume sentence
  const reasonIdx = out.indexOf('reason: installed dshmarket in stable+dev')
  const resumeIdx = out.indexOf('If a task was in progress, resume it')
  assert.ok(reasonIdx > -1 && resumeIdx > -1 && reasonIdx < resumeIdx)
})

test('buildNotice: omits reason line when reason absent', () => {
  const out = buildNotice({ bootAt: '2026-08-18T12:00:00.000Z', downtimeMs: 60000 })
  assert.doesNotMatch(out, /reason:/)
})

test('buildNotice: renders interrupted sessions before the resume instruction', () => {
  const out = buildNotice({
    bootAt: '2026-08-18T12:00:00.000Z',
    downtimeMs: 60000,
    interrupted: ['session-worker-1', 'session-worker-2 (worker)'],
  })
  assert.match(out, /Interrupted sessions: session-worker-1, session-worker-2 \(worker\)\./)
  // the interrupted list must come BEFORE the resume sentence
  const interruptIdx = out.indexOf('Interrupted sessions:')
  const resumeIdx = out.indexOf('If a task was in progress, resume it')
  assert.ok(interruptIdx > -1 && resumeIdx > -1 && interruptIdx < resumeIdx)
})

test('buildNotice: omits interrupted line when none given', () => {
  const out = buildNotice({ bootAt: '2026-08-18T12:00:00.000Z', downtimeMs: 60000 })
  assert.doesNotMatch(out, /Interrupted sessions/)
})

test('buildNotice: omits interrupted line when the list is empty', () => {
  const out = buildNotice({ bootAt: '2026-08-18T12:00:00.000Z', downtimeMs: 60000, interrupted: [] })
  assert.doesNotMatch(out, /Interrupted sessions/)
})

test('humanizeDowntime: <1s', () => {
  assert.equal(humanizeDowntime(0), '<1s')
  assert.equal(humanizeDowntime(999), '<1s')
})

test('humanizeDowntime: plain seconds', () => {
  assert.equal(humanizeDowntime(1000), '1s')
  assert.equal(humanizeDowntime(59000), '59s')
})

test('humanizeDowntime: minutes (and seconds) at >=60s', () => {
  assert.equal(humanizeDowntime(60000), '1m')
  assert.equal(humanizeDowntime(90000), '1m 30s')
  assert.equal(humanizeDowntime(600000), '10m')
})
