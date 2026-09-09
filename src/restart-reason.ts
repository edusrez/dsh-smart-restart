/**
 * dsh-smart-restart — FB-234: the INTENTIONAL-RESTART MARKER WRITER.
 *
 * The boot-crash sidecar (dshd-health, the READ side of the convention) treats
 * every boot without its own heartbeat as a pre-tick crash and raises the
 * crashStreak — INCLUDING an INTENTIONAL `smart_restart` of a healthy process
 * (the recorded 2026-09-08 inflations: A-harness 01:41Z + dshmarket 06:30Z —
 * host-plane re-boots, NRestarts stays 0). The fix is a WRITE-AHEAD MARKER:
 * the host's `smart_restart` writes `<runtimeStateDir>/restart-reason.json`
 * ATOMICALLY (tmp + rename in the SAME dir) BEFORE every intentional kill of
 * the GRACE families; the sidecar's next apply start reads it, treats the
 * excused previous boot EXACTLY like a ticked one (streak never rises over an
 * intentional restart) and consumes the marker (use-once).
 *
 * The MARKER CONVENTION is SPECified in dshd-health `src/index.ts` (FB-234
 * block) — this module is the WRITER side of that convention, a deliberate
 * mirror: the plugin must not import the SPEC package (it is not a
 * dependency). The file name, the shape (`{cause, reason?, ts, bootId?}`) and
 * the GRACE family set below MUST stay in sync with the sidecar's
 * `RESTART_REASON_FILE` / `RESTART_GRACE_CAUSES` (module-scoped THERE, not
 * exported) — a NEW intentional family extends BOTH sets BY CODE.
 *
 * Shape contract (what the sidecar's reader validates — see dshd-health
 * `readRestartReasonMarker`): `cause` a NON-EMPTY string (the sidecar excuses
 * only causes IN the GRACE set), `ts` a finite number (ms epoch); `reason` /
 * `bootId` OPTIONAL strings (absent → omitted). A marker whose write FAILED is
 * simply ABSENT at the next boot → the CURRENT crash semantics (regression 0 —
 * this module never throws).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The FB-234 intentional-restart marker filename (SPEC: dshd-health
 * `RESTART_REASON_FILE`) — written by THIS host-side writer, read + consumed
 * by the sidecar. */
export const RESTART_REASON_FILE = 'restart-reason.json'

/** The boot-crash sidecar filename (`<runtimeStateDir>/boot-crash.json`) — the
 * source of the CURRENT boot's bootId anchor (the boot BEING KILLED). */
export const BOOT_CRASH_FILE = 'boot-crash.json'

/** FB-234 — the sanctioned GRACE families (mirror of the SPEC's module-scoped
 * `RESTART_GRACE_CAUSES` = ['canary','deploy','dshmarket']). A restart whose
 * resolved cause is IN this set is INTENTIONAL: the marker is written before
 * the kill and excuses the previous boot. Anything outside the set (or no
 * marker at all) keeps the CURRENT crash semantics. */
export const RESTART_REASON_CAUSES = new Set(['canary', 'deploy', 'dshmarket'])

/** The marker shape this writer produces (the SPEC's `RestartReasonMarker`). */
export interface RestartReasonMarkerDraft {
  /** The intentional restart family — IN `RESTART_REASON_CAUSES`. */
  cause: string
  /** Optional free-form human note (no secrets — never invented here). */
  reason?: string
  /** The write moment (ms epoch). */
  ts: number
  /** Optional self-healing anchor — the CURRENT boot's id (the boot being
   *  killed), copied from `<runtimeStateDir>/boot-crash.json` BEFORE the kill.
   *  ABSENT when the file is missing/unreadable (the sidecar's documented
   *  OPTIONAL anchor — a no-bootId marker excuses whatever previous boot the
   *  next apply start finds; the sidecar consumes it there, so the stale
   *  window is one boot). */
  bootId?: string
}

/**
 * Resolve the marker cause for one `smart_restart` call — the GRACE-route
 * selector:
 *
 *  - an EXPLICIT `cause` argument IN the set → that cause (the tool's
 *    canary/deploy/dshmarket routes);
 *  - an explicit cause OUTSIDE the set → undefined (NOT written — kept the
 *    current crash semantics; the sidecar would not excuse it anyway);
 *  - NO explicit cause but the canary gate RAN (the canary pre-flight
 *    passed/skipped) → 'canary' (a canary-gated restart IS a canary restart);
 *  - otherwise → undefined (NO marker — a bare/ordinary restart keeps the
 *    current behavior byte-for-byte).
 */
export function resolveRestartCause(explicit: string | undefined, canaryGateRan: boolean): string | undefined {
  if (explicit !== undefined) return RESTART_REASON_CAUSES.has(explicit) ? explicit : undefined
  return canaryGateRan ? 'canary' : undefined
}

/** Read the CURRENT boot's bootId from `<runtimeStateDir>/boot-crash.json`
 * (the boot being killed — read BEFORE the kill). Absent / unreadable /
 * malformed → undefined, NEVER a throw; the marker is then written WITHOUT the
 * bootId anchor (SPEC: `bootId` is OPTIONAL — the excusal still holds). */
export function readCurrentBootId(runtimeStateDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeStateDir, BOOT_CRASH_FILE), 'utf8')) as Record<string, unknown>
    if (typeof parsed.bootId === 'string' && parsed.bootId !== '') return parsed.bootId
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Write `<runtimeStateDir>/restart-reason.json` ATOMICALLY: the payload goes
 * to a tmp file IN THE SAME DIRECTORY and is `rename`d over the final name —
 * a reader can only ever observe a COMPLETE marker or NONE (a partial marker
 * mid-write is impossible; the sidecar treats an unreadable marker as ABSENT,
 * so atomicity is exactly the SPEC's "write the marker atomically"). The
 * directory is created when missing. NEVER throws: a write failure degrades to
 * the CURRENT crash semantics (no marker) and the restart proceeds — the
 * marker is best-effort by design (the same durability class as the plugin's
 * own marker.json / pending-notice.json). Payload: NO secrets — only the
 * caller-provided reason, never sessions/headers/keys/env.
 */
export function writeRestartReasonMarker(runtimeStateDir: string, draft: RestartReasonMarkerDraft): void {
  try {
    mkdirSync(runtimeStateDir, { recursive: true })
    const tmpPath = join(runtimeStateDir, `${RESTART_REASON_FILE}.tmp`)
    writeFileSync(tmpPath, JSON.stringify(draft), 'utf8')
    renameSync(tmpPath, join(runtimeStateDir, RESTART_REASON_FILE))
  } catch (err) {
    console.warn('[smart-restart] restart-reason marker write failed (restart proceeds, current crash semantics):', err)
  }
}

/**
 * Remove any pending restart-reason marker (best-effort, NEVER throws). Called
 * for a NON-grace restart (no resolved cause): a stale marker from an EARLIER
 * grace restart must never excuse THIS kill — "no marker" is the current
 * semantics. Absent file → no-op; a delete failure is logged only.
 */
export function clearRestartReasonMarker(runtimeStateDir: string): void {
  try {
    rmSync(join(runtimeStateDir, RESTART_REASON_FILE), { force: true })
  } catch (err) {
    console.warn('[smart-restart] restart-reason marker clear failed (stale marker may linger):', err)
  }
}