/**
 * Pure, deterministic restart-detection + notice logic for dsh-smart-restart.
 *
 * Kept free of I/O, config, and framework imports so it is trivially
 * unit-testable. Filesystem and service wiring live in src/index.ts.
 */

/** A durable boot marker persisted across service restarts. */
export interface BootMarker {
  /** ISO timestamp of the last boot (when this marker was written). */
  lastBootAt: string;
  /** OS process id that wrote the marker — a different pid means a restart. */
  pid: number;
  /** DSH version at the time the marker was written, if discoverable. */
  dshVersion?: string;
}

export interface RestartDetection {
  /** True when a previous marker exists AND was written by a different process. */
  wasRestart: boolean;
  /** Wall-clock time since the previous boot, clamped to >= 0. Zero unless a restart. */
  downtimeMs: number;
}

/**
 * Decide whether this process boot is a restart of the DSH service.
 *
 * A NEW process id (relative to the persisted marker) indicates the service
 * was (re)started; the SAME pid indicates an in-process HMR/reload, which is
 * NOT a restart. A missing or unparseable previous-boot timestamp is treated
 * as a restart with a downtime of 0 (we cannot measure it).
 */
export function detectRestart(
  marker: BootMarker | null,
  nowMs: number,
  pid: number,
): RestartDetection {
  if (!marker) return { wasRestart: false, downtimeMs: 0 };
  if (marker.pid === pid) return { wasRestart: false, downtimeMs: 0 };

  const prevBoot = Date.parse(marker.lastBootAt);
  const downtimeMs = Number.isFinite(prevBoot) ? Math.max(0, nowMs - prevBoot) : 0;
  return { wasRestart: true, downtimeMs };
}

/** Format a downtime for a human: "<1s", "12s", or "1m 30s" once >= 60s. */
export function humanizeDowntime(downtimeMs: number): string {
  if (downtimeMs < 1000) return '<1s';
  const totalSeconds = Math.floor(downtimeMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export interface BuildNoticeOptions {
  /** ISO timestamp of THIS (current) boot. */
  bootAt: string;
  /** ISO timestamp of the previous boot, when known. */
  prevBootAt?: string;
  /** Downtime between the previous boot and now, in milliseconds. */
  downtimeMs: number;
  /** Optional fully-own notice; returned verbatim when provided. */
  customNotice?: string;
}

/** Build the agent-facing restart notice. A customNotice wins verbatim. */
export function buildNotice(opts: BuildNoticeOptions): string {
  if (opts.customNotice) return opts.customNotice;

  let text = `Smart-restart: the DSH service restarted at ${opts.bootAt}.`;
  if (opts.prevBootAt) {
    text += ` Previous boot: ${opts.prevBootAt} (downtime ~${humanizeDowntime(opts.downtimeMs)}).`;
  }
  text += ` If a task was in progress, resume it; otherwise reply with a one-line acknowledgment.`;
  return text;
}

/**
 * Decide whether a target string selects a given agent.
 * - 'all' always matches.
 * - An explicit session id matches by exact string comparison.
 * - 'primary' matches only a root agent (isRoot true); the plugin owner
 *   decides which specific root is "primary" and delivers to it alone.
 */
export function targetsAgent(
  target: string,
  agentSessionId: string | undefined,
  isRoot: boolean,
): boolean {
  if (target === 'all') return true;
  if (target === 'primary') return isRoot;
  if (agentSessionId !== undefined) return target === agentSessionId;
  return false;
}
