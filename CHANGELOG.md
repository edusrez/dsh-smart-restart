# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
