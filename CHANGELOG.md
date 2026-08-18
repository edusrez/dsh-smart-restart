# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
