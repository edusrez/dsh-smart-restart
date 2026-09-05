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
  /** Session labels (id, or "id (type)") interrupted by the shutdown. Rendered
   *  BEFORE the resume instruction so the agent sees exactly whose work was cut.
   *  Ignored when a customNotice wins verbatim. */
  interrupted?: string[];
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
  if (opts.interrupted && opts.interrupted.length > 0) {
    text += ` Interrupted sessions: ${opts.interrupted.join(', ')}.`;
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

/**
 * One session that was active (mid-turn) within the shutdown grace window when
 * the process was stopped — i.e. it was likely interrupted by the restart.
 */
export interface ShutdownSession {
  /** Session id that was active at shutdown. */
  id: string;
  /** ISO timestamp of that session's last recorded activity. */
  lastActiveAt: string;
}

/**
 * A durable shutdown notice persisted on SIGTERM/SIGINT by the running process
 * so the NEXT boot can detect that the process stopped while an agent session
 * was active — and auto-notify that session without requiring the smart_restart
 * tool to have been invoked.
 */
export interface ShutdownNotice {
  /** Session id that was last active just before the process went down. Kept
   *  as the single-session pin (derived from the max-timestamp entry) for
   *  backward compatibility with the existing auto-pin behavior. */
  lastSessionId: string;
  /** ISO timestamp of that last activity. */
  lastActiveAt: string;
  /** ISO timestamp of when the shutdown notice was written. */
  when: string;
  /** Optional list of sessions that were active within the grace window at
   *  shutdown — the FULL interrupted set (heads included since fb-168), used
   *  both for the "Interrupted sessions:" render of the main notice and as the
   *  source of the interrupted-HEAD resume recipients (`interruptedHeads`). */
  sessions?: ShutdownSession[];
}

/**
 * Parse a shutdown-notice JSON document written by the SIGTERM/SIGINT handler.
 * Tolerant of missing/corrupt JSON; requires a non-empty `lastSessionId` and a
 * parseable `lastActiveAt` timestamp. When a `sessions` array is present, valid
 * entries (non-empty id + parseable timestamp) are carried through; malformed
 * entries are dropped. Returns null when the document is not a usable shutdown
 * notice.
 */
export function parseShutdownNotice(raw: string): ShutdownNotice | null {
  try {
    const data = JSON.parse(raw) as Partial<ShutdownNotice>;
    if (
      data &&
      typeof data.lastSessionId === 'string' &&
      data.lastSessionId.length > 0 &&
      typeof data.lastActiveAt === 'string' &&
      Number.isFinite(Date.parse(data.lastActiveAt))
    ) {
      const parsed: ShutdownNotice = {
        lastSessionId: data.lastSessionId,
        lastActiveAt: data.lastActiveAt,
        when: typeof data.when === 'string' ? data.when : '',
      };
      if (Array.isArray(data.sessions)) {
        const sessions = data.sessions
          .filter(
            (s): s is ShutdownSession =>
              !!s &&
              typeof s.id === 'string' &&
              s.id.length > 0 &&
              typeof s.lastActiveAt === 'string' &&
              Number.isFinite(Date.parse(s.lastActiveAt)),
          )
          .map((s) => ({ id: s.id, lastActiveAt: s.lastActiveAt }));
        if (sessions.length > 0) parsed.sessions = sessions;
      }
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Systemd unit token rule for cgroup-derived units — the same rule the
 *  smart_restart tool guard applies in index.ts: a single unit token, no
 *  spaces, slashes, or shell metacharacters. */
const UNIT_TOKEN_RE = /^[A-Za-z0-9_.@-]+$/

/**
 * Parse the plugin's OWN systemd unit name from `/proc/self/cgroup` content.
 *
 * Reads cgroup text (one or more lines; typically the unified hierarchy line
 * `0::/system.slice/foo.service`). It returns the LAST path segment ending in
 * `.service` across all lines — exactly one line/segment is expected in
 * practice, but the parser is tolerant: trailing whitespace is stripped and
 * malformed lines are ignored. The candidate must match the unit token rule
 * (`/^[A-Za-z0-9_.@-]+$/`) before it is returned. Returns null when no line
 * has a usable `.service` segment: no `.service` present (e.g. a user-slice
 * scope), empty/whitespace-only text, or a malformed token.
 */
export function parseCgroupUnit(cgroupText: string): string | null {
  if (typeof cgroupText !== 'string' || !cgroupText.trim()) return null
  let found: string | null = null
  for (const rawLine of cgroupText.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const segment = line.split('/').pop() ?? ''
    if (!segment.endsWith('.service')) continue
    if (!UNIT_TOKEN_RE.test(segment)) continue
    found = segment
  }
  return found
}

/**
 * Whether a session id should be excluded from the "last active" selection.
 *
 * Deepartments department heads are now FIRST-CLASS ROOT AGENTS with durable
 * sessions whose id is `head-<postId>` (e.g. `head-research-head`,
 * `head-programming-head`). At shutdown a head session can look like the most
 * recently active session, so without this filter dsh-smart-restart would pin
 * its post-restart notice to a head — making it run a spurious boot turn (which
 * on the dev GUI froze mid-stream). A head must NEVER be selected as the
 * "last active" session for the smart-shutdown auto-notification.
 *
 * A session is ignored when its id starts with ANY of the passed prefixes
 * (defaults to the deepartments `head-` convention). The prefix set is
 * configurable via `ignoredSessionPrefixes` so other patterns can be added.
 */
export function ignoredByPrefix(
  sessionId: string | undefined,
  prefixes: readonly string[],
): boolean {
  if (!sessionId || !prefixes || prefixes.length === 0) return false;
  for (const prefix of prefixes) {
    if (prefix && sessionId.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Decide which session the shutdown notice should be pinned to, if any.
 *
 * A notice present on boot means the process was stopped while at least one
 * session was active. It returns the last-active session id ONLY if that
 * session was active within `graceMs` of the shutdown (recent activity ⇒ the
 * user likely restarted while an agent was mid-task, so auto-notify). When the
 * last activity predates the whole grace window the session was idle well
 * before shutdown (the user probably restarted while idle), so we return null
 * and let the caller fall back to the existing `target`.
 *
 * Guards: null notice → null; an unbounded/NaN shutdown time → null.
 */
export function shutdownTarget(
  notice: ShutdownNotice | null,
  shutdownAtMs: number,
  graceMs: number,
): string | null {
  if (!notice) return null;
  const lastActiveAtMs = Date.parse(notice.lastActiveAt);
  if (!Number.isFinite(lastActiveAtMs) || !Number.isFinite(shutdownAtMs)) return null;
  if (shutdownAtMs - lastActiveAtMs <= graceMs) return notice.lastSessionId;
  return null;
}

/** One live agent as the read-before-edit guard sees it (duck-typed from the
 *  harness Agent handle: `status` is the lifecycle state, `'running'` while a
 *  driver is actively draining/checkpointing a turn, `'idle'` otherwise). */
export interface ActiveAgentView {
  id: unknown
  status: string
}

export interface ActiveAgentGuardResult {
  /** true → the restart may proceed (no OTHER session mid-turn, or an explicit
   *  `force` override was passed). */
  allowed: boolean
  /** Sessions mid-turn at check time, EXCLUDING the calling session — the
   *  caller restarts itself intentionally and is pinned for resume, so it is
   *  never counted as an interruption victim. Empty when none in flight. */
  inFlight: string[]
}

/**
 * fb-168 (a) — the read-before-edit guard for the smart_restart tool.
 *
 * Decides whether a restart may proceed based on the LIVE agent registry of
 * the DSH process: a session with `status === 'running'` has an active turn in
 * flight that a restart would cut. The guard BLOCKS (returns `allowed: false`
 * with the in-flight list) when ANY session other than the calling session is
 * running and no explicit `force` override was passed — a blind interruption
 * becomes structurally impossible. The caller always logs the outcome (and the
 * in-flight list), so an exercised `force` override is always visible.
 *
 * Pure & IO-free: the live registry snapshot is passed in, so unit tests run
 * without a harness.
 */
export function activeAgentGuard(
  agents: readonly ActiveAgentView[],
  callingSessionId: string,
  force: boolean,
): ActiveAgentGuardResult {
  const inFlight = agents
    .filter((a) => a.status === 'running' && String(a.id) !== callingSessionId)
    .map((a) => String(a.id))
  return { allowed: inFlight.length === 0 || force, inFlight }
}

/**
 * fb-168 (b) — the automatic resume-notify recipients of a shutdown notice.
 *
 * The sessions of the interrupted list that match the ignored prefixes
 * (deepartments department HEADS by default, `head-`): their turns were cut by
 * the restart, and the boot must notify each of them so the organization never
 * hangs idle post-restart without knowing (fb-46). Non-ignored interrupted
 * sessions (workers) are NOT recipients — they surface in the main notice's
 * "Interrupted sessions:" list, and the notified heads are exactly who
 * re-deploys them.
 */
export function interruptedHeads(
  sessions: readonly ShutdownSession[] | undefined,
  prefixes: readonly string[],
): string[] {
  if (!sessions) return []
  return sessions
    .filter(({ id }) => ignoredByPrefix(id, prefixes))
    .map(({ id }) => id)
}
