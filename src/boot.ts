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
  /** Optional human reason recorded by the smart_restart tool caller. */
  reason?: string;
}

/** Build the agent-facing restart notice. A customNotice wins verbatim. */
export function buildNotice(opts: BuildNoticeOptions): string {
  if (opts.customNotice) return opts.customNotice;

  let text = `Smart-restart: the DSH service restarted at ${opts.bootAt}.`;
  if (opts.prevBootAt) {
    text += ` Previous boot: ${opts.prevBootAt} (downtime ~${humanizeDowntime(opts.downtimeMs)}).`;
  }
  if (opts.reason) {
    text += ` reason: ${opts.reason}.`;
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

/** A durable pending notice recorded by the smart_restart tool before restart. */
export interface PendingNotice {
  /** Session id that requested the restart; the notice must return to it. */
  sessionId: string;
  /** Optional human reason recorded alongside the request. */
  reason: string;
}

/** Arguments accepted by the smart_restart tool. */
export interface SmartRestartParams {
  /** Optional human-readable note included in the post-restart notice. */
  reason?: string;
}

/** Result returned by the smart_restart tool. */
export interface SmartRestartResult {
  ok: boolean;
  restarting: boolean;
  sessionId?: string;
  reason?: string;
  error?: string;
}

/**
 * Parse a pending-notice JSON document written by the smart_restart tool.
 * Tolerant of missing/corrupt JSON and a missing reason; requires a non-empty
 * sessionId. Returns null when the document is not a usable pending notice.
 */
export function parsePendingNotice(raw: string): PendingNotice | null {
  try {
    const data = JSON.parse(raw) as Partial<PendingNotice>;
    if (data && typeof data.sessionId === 'string' && data.sessionId.length > 0) {
      return {
        sessionId: data.sessionId,
        reason: typeof data.reason === 'string' ? data.reason : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide whether this agent should receive the restart notice on this boot.
 *
 * A pinned target (set from a pending notice left by the smart_restart tool)
 * overrides the configured `target` entirely: only the pinned session wins.
 * Without a pinned target, the existing `target` matching applies.
 */
export function selectsAgent(
  pinnedTarget: string | undefined,
  target: string,
  agentSessionId: string | undefined,
  isRoot: boolean,
): boolean {
  if (pinnedTarget) {
    return agentSessionId !== undefined && pinnedTarget === agentSessionId;
  }
  return targetsAgent(target, agentSessionId, isRoot);
}
