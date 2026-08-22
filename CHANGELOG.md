# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-08-22

### Fixed

- **Canary-failure render consolidated to a single line.** When the canary aborts a restart, the `smart_restart` tool's rendered response now shows only `Canary: failed — restart ABORTED: <detail>`; the previously duplicated generic `smart_restart failed: …` line is omitted. The `Canary: passed` / `Canary: skipped` render lines are unchanged.
- **Canary patch `stateDir` values are now quoted.** `buildPatchContent` emits `stateDir: "<path>"` (also for the `smart-restart` row's own merged redirect), which is YAML-safe for paths containing spaces, e.g. `/tmp` paths with spaces.

## [0.4.0] - 2026-08-22

### Added

- **Canary pre-restart validation** (opt-in per profile and/or per call, fully generic). Before restarting, the `smart_restart` tool can boot an **ephemeral DSH instance** from the same binary/profile as the systemd unit — an auto-picked free port, a temp state dir, and a temp `dsh --patch` overlay (applied after the profile) that disables this plugin in the canary (`enabled: false`) and redirects listed rows' `stateDir` into the temp dir. The launch is first validated with `--dump-config`, then the boot is probed over HTTP until healthy or the timeout, and the ephemeral is always stopped (process-group kill) before returning. A canary **failure aborts the restart** — no pending notice is persisted, nothing is spawned, and the calling session is alerted live through the same plugin-source notice channel (followup/inject). A canary **skip is not a failure** and never blocks a restart. It is **skipped** (never blocks) when the dsh binary/profile cannot be derived (no `systemctl` lookup result AND no explicit binary/profile), so generic installs stay safe.
- **`canary` config** (default `false`): master opt-in for the canary gate; the per-call `canary` tool parameter overrides it for a single call.
- **`canaryTimeoutMs` config** (default `45000`): hard window for the canary boot liveness probe; a timeout is a canary failure and aborts the restart.
- **`canaryPort` config** (default `0`): fixed HTTP port for the ephemeral canary instance; `0` auto-picks a free port.
- **`canaryProfile` / `canaryBinary` config** (default `''`): explicit dsh profile/binary for the canary launch; empty derives them from `systemctl show -p ExecStart <restartUnit>` (binary falls back to `dsh` on PATH).
- **`canaryStateDirOverrides` config** (default `{}`): plugin-row id → temp dir map; those rows get their `stateDir` redirected in the canary patch (e.g. `deepartments: ''` keeps the canary off live board state). Relative or empty values resolve under the canary temp dir; absolute values are used verbatim.
- Pure-logic unit tests for `deriveExecStartParams`, `buildPatchContent`, the free-port picker, the liveness status mapping, and the `runCanary` skipped/failed/passed paths with injected hooks — no dsh service, `/opt/dsh`, or systemctl needed.

### Changed

- The `smart_restart` tool output is extended (backward compatible): two optional result fields `canary` (`skipped` | `passed` | `failed`) and `canaryDetail`, plus an optional `canary` input parameter; the rendered response gains a `Canary: …` line when a canary ran (`Canary: passed — restarting…`, `Canary: failed — restart ABORTED: <detail>`, `Canary: skipped — <detail>`).
- The canary gate runs **after** the existing `restartUnit`/session guards and **before** the pending-notice persist and the restart spawn — a failed canary leaves no pending notice behind; `restartUnit` remains the only required tool config.

## [0.3.1] - 2026-08-20

### Fixed

- The smart-shutdown "last active session" selection can no longer pick a **Deepartments department head** session. Heads are now first-class root agents with durable session ids `head-<postId>` (e.g. `head-research-head`), and at shutdown a head could look like the most recently active session, so the plugin would pin a spurious post-restart notice to it — making the head run a boot turn that froze mid-stream on the dev GUI (reported 2026-08-20). Head sessions are now filtered out of last-active tracking, the shutdown-notice write, and the boot-side pin consumption.

### Added

- **`ignoredSessionPrefixes` config** (default `['head-']`): session-id prefixes that must never be selected as "last active" for the smart-shutdown auto-notification. Defaults to the Deepartments `head-` convention; add other prefixes to ignore more patterns. Excludes only the smart-shutdown auto-notification path — the explicit `smart_restart` tool target (the caller) and genuine user/main-agent sessions are untouched.

## [0.3.0] - 2026-08-18

### Fixed

- SIGTERM/SIGINT handler now re-raises the signal after writing the shutdown notice (previously the handler suppressed the default termination, which would stall systemd restarts until TimeoutStopSec — found in an isolated live smoke before release).

### Added

- **Smart shutdown auto-detection**: the plugin now tracks the **last active session** (refreshed on `agent/session-start` and `agent/pre-step`) and, on `SIGTERM`/`SIGINT`, synchronously persists a durable `shutdown-notice.json` (`{lastSessionId, lastActiveAt, when}`) under the state dir before the process dies. On the next boot, if there was **no** `pending-notice.json`, the plugin reads that notice and **pins** the post-restart notice to the last-active session when it was active within `shutdownGraceMs`. This auto-notifies the agent that was active when the process went down — so a **plain `systemctl restart`** run by the agent (or while an agent was active) notifies that session at boot without the user prompting.
- **`shutdownGraceMs` config** (default `600000` = 10 minutes): the window before shutdown within which last agent activity must fall for the shutdown-notice to be considered "agent-involved". If the session was idle beyond the grace window (the user probably restarted while idle), the pin is skipped and delivery falls back to `target`.
- **Boot pinning priority** for the post-restart notice: `pending-notice.json` (the `smart_restart` tool) **wins**; otherwise `shutdown-notice.json` (auto-detected last-active session, subject to `shutdownGraceMs`); otherwise nothing pinned and delivery uses the existing `target`/primary fallback. The shutdown notice is consumed (unlinked) after being read.
- Pure-logic unit tests for `parseShutdownNotice` (valid/missing/corrupt/empty `lastSessionId`/unparseable timestamp) and `shutdownTarget` (within grace → session; exactly at boundary → session; beyond grace → null; null notice → null; NaN guard → null).

### Changed

- Boot delivery now treats a **smart-shutdown auto-detected session** as a second-priority pin, behind the tool-caller pending notice and ahead of the `target` fallback.
- `SIGTERM`/`SIGINT` handlers and the activity trackers are reversible via `ctx.effect` (removed on plugin unload / HMR); the only intentional durable artifacts remain the marker and the notice files that must survive the restart they document.

## [0.2.0] - 2026-08-18

### Added

- **`smart_restart` tool** (registered via `ctx.tools.register` in `apply`, available to agent sessions; controllable via `toolEnabled`): the main agent invokes it to restart the DSH service through systemd instead of guessing the target session. The tool records **which session asked** (from `exec.agent.id`) and an **optional `reason`**, persists a durable `pending-notice.json` under the state dir, spawns a **detached** `setsid bash` process that survives the service kill, and returns an acknowledgement.
- **`restartUnit` config** (default `''`): the systemd unit to restart (e.g. `dsh.service` or `dsh-deepartments-dev.service`). Set per profile. If left empty the tool fails safe with a clear error rather than guessing; the value is validated as a single unit token (`/^[A-Za-z0-9_.@-]+$/`) to prevent shell injection.
- **`toolEnabled` config** (default `true`): whether the `smart_restart` tool is registered.
- **Targeted post-restart delivery**: on boot the plugin reads `pending-notice.json` and pins the notice to the exact session that requested the restart (the tool caller wins over `target` 'primary'/'all' for that boot), delivered on that session's startup or via the fallback timer; if the pinned session never resolves, delivery falls back to the existing `target` logic so the notice still lands.

### Changed

- Boot delivery now **prioritizes the tool-caller session** over the configured `target` when a pending notice is present.
- `buildNotice` accepts a `reason` and includes it (`… reason: <reason>.`) before the resume instruction.

### Fixed

- **Pinned delivery is now source-agnostic.** The `agent/session-start` listener previously delivered only on `source === 'startup'`; a pinned session that RESUMES from the previous process publishes with `source: 'resume'`, so the pinned notice was silently skipped in a real restart. The pinned path now matches the pinned session id regardless of source; the `source === 'startup'` gate applies only to the non-pinned `config.target` path.
- **Replaced the one-shot ~1.8s `setTimeout` fallback with a bounded retry interval** (`750ms` poll, `~15s` cap) that reliably handles a pinned session which resumes lazily late: each tick delivers to the pinned session the moment it is live (then stops). Non-pinned (`config.target`) behavior stays one-shot on the first tick; the interval is cleared on delivery, window expiry with no live pin, or plugin unload (`ctx.effect`). Verified in a live restart smoke (`[smart-restart] notice delivered to session-<id>`).

## [0.1.0] - 2026-08-18

### Added

- Initial release of `dsh-smart-restart`, a DSH host plugin that wakes the main agent when the DSH service restarts.
- Boot **marker** persisted to `<DSH_HOME>/<stateDir>/marker.json` (`{lastBootAt, pid, dshVersion?}`) on every boot, durable across the restart it documents.
- **Restart detection** based on a new process id: a previous marker with a `pid` different from the current `process.pid` counts as a service restart; the same `pid` (in-process HMR / hot-reload) is ignored; a first-ever boot (no marker) is not a restart; a stale/corrupt `lastBootAt` still counts with downtime 0.
- **Downtime** computed as `now − previous lastBootAt`, clamped to `≥ 0`, and humanized (`<1s`, `12s`, or `1m 30s`) for the notice.
- **Plugin-source notice** delivered to the main agent via `agent.followup()` (wakes an idle agent, `wakeup: true`) or `agent.inject()` (queue-only context, `wakeup: false`), surfaced as a `createUserMessage` with `source.kind: 'plugin'`, `form: 'notice'`.
- Delivery hooked to the `agent/session-start` event with `source: 'startup'` (registered early in `apply`), with a bounded ~1.8s `setTimeout` fallback for ordering edge cases; both cleaned up via `ctx.effect`, and delivery fires **once per boot**.
- `target` config (`primary` | `all` | `<session-id>`) controlling which agent(s) are notified, defaulting to `primary`.
- `wakeup` and `notice` config: toggling between wake-and-deliver vs. context-only injection, and a fully custom notice that overrides the default verbatim when set.
- Success log line `[smart-restart] notice delivered to <id>`.
- Unit tests (17/17) covering the pure restart-detection, targeting, humanized-downtime, and notice-building logic plus the compiled plugin exports.

### Fixed

- **Before release**: `deliver()` previously called both `inject()` and `followup()` with the same message, colliding with Inbox's "already pending" validation and failing the wake. Delivery now uses a **single** channel — `followup()` when `wakeup` is enabled, `inject()` otherwise — never both with the same message. Verified in a real reboot smoke test.
