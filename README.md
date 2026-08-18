# dsh-smart-restart

A **DeepSeek Harness (DSH) host plugin** that makes the main agent aware when the DSH service restarts — **without the user having to prompt it**. On every boot the plugin persists a restart marker, detects that a new process has taken over, and wakes the main agent with a short "Smart-restart" notice (boot time, previous boot, downtime) so it can resume interrupted work or acknowledge on its own.

[![npm](https://img.shields.io/npm/v/dsh-smart-restart?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-smart-restart)
[![license](https://img.shields.io/npm/l/dsh-smart-restart?style=flat-square)](LICENSE)
[![stars](https://img.shields.io/github/stars/edusrez/dsh-smart-restart?style=flat-square)](https://github.com/edusrez/dsh-smart-restart)
[![last commit](https://img.shields.io/github/last-commit/edusrez/dsh-smart-restart?style=flat-square)](https://github.com/edusrez/dsh-smart-restart)

## Table of contents

- [Overview](#overview)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Behavior & lifecycle](#behavior--lifecycle)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Overview

A long-lived DSH instance restarts for many reasons: the agent installs or reconfigures a plugin and triggers a reboot, the host machine reboots, or the service is restarted under **systemd**. After any such restart the agent is up and running again, but it has **no idea that anything happened** — the previous session is gone. Today, the only way to get the agent to pick back up is for the user to tell it, usually with something like *"you restarted"*.

`dsh-smart-restart` closes that gap. It detects the restart itself and wakes the main agent at boot with a short, self-contained notice describing what happened, so the agent decides whether to resume interrupted work, note the downtime, or simply acknowledge — no user prompt needed.

- **Zero prompting** — the user never has to tell the agent "you restarted".
- **Automatic wake** — an idle main agent is woken and handed the notice on its own.
- **Precise context** — the notice carries the boot time, the previous boot time, and the downtime.
- **Self-contained** — a single host bundle; nothing to run, no external service.

## How it works

On every boot the plugin:

1. **Reads the previous marker** — a durable `marker.json` (`{lastBootAt, pid, dshVersion?}`) stored under `<DSH_HOME>/<stateDir>/`.
2. **Detects a restart** — a previous marker with a **different `pid`** than the current `process.pid` means a *new process* has started, i.e. the service restarted; downtime is `now − previous lastBootAt`, clamped to `≥ 0`.
3. **Writes a new marker** immediately, so the next boot can be compared against this one.
4. **Wakes the target agent** — listens for the `agent/session-start` event with `source: 'startup'` (registered early so it catches the startup publication), with a bounded ~1.8s `setTimeout` fallback for ordering edge cases. Delivery happens **once per boot**.
5. **Delivers the notice** as a plugin-sourced user message via `agent.followup()` (wakes an idle agent) or `agent.inject()` (queue-only, no wake), depending on the `wakeup` config.

### Restart vs. HMR semantics

The detection is intentionally precise:

| Situation | Detected as a restart? |
| --------- | ---------------------- |
| New OS process, previous marker exists | **Yes** — service (re)started. |
| Same OS process (in-process HMR / hot-reload) | **No** — ignored. |
| First-ever boot (no marker) | **No** — nothing to compare against. |
| Marker present but stale/corrupt `lastBootAt` | **Yes** — downtime reported as 0. |

Only a genuinely **new process** counts as a restart. An in-process hot-reload keeps the same `pid`, so it is not treated as a service restart. Delivery happens **once per boot**: a `deliveredIds` set plus a `primary` guard (for the `primary` target) prevent the startup event and the fallback timer from double-sending.

### Notice

The default notice (English) reads:

> Smart-restart: the DSH service restarted at `<iso>`. Previous boot: `<iso>` (downtime ~2m 9s). If a task was in progress, resume it; otherwise reply with a one-line acknowledgment.

The previous-boot and downtime segment is omitted when no previous boot time is known. The text is fully customizable via the `notice` config (see below).

## Requirements

- **DSH `>= 0.1.0-rc.7`** — a **long-lived instance with a live main-agent session** (the web / GUI profile). This plugin is designed for a continuously-running service whose main agent stays resident; it is **not** aimed at the one-shot headless CLI.
- **Node.js / pnpm** — the usual DSH toolchain for building and installing host bundles.

## Install

`dsh-smart-restart` is a **DSH host bundle**: `package.json` carries `dsh.bundle.patch = ./cordis.patch.yml`, so installing the package lets the plugin layer auto-join the profile's `dsh.profile.bundles`.

```bash
# From a registry (npm)
dsh plugin --profile <name> add dsh-smart-restart

# Or link a local checkout while developing
dsh plugin --profile <name> add /path/to/dsh-smart-restart
```

**A restart is required after `add`** — which is exactly the scenario this plugin exists to surface. The bundled patch inserts the layer into the profile's layer stack:

```yaml
# cordis.patch.yml (bundled with this package)
- insert:
    - id: smart-restart
      name: dsh-smart-restart
      config:
        enabled: true
        stateDir: .smart-restart
        target: primary
        wakeup: true
        notice: ''
```

Because the bundle declares `dsh.bundle`, the layer auto-joins `dsh.profile.bundles` on install — no manual profile edit required.

## Configuration

All behavior is controlled through the plugin row's `config`:

| Key        | Type    | Default           | Description |
| ---------- | ------- | ----------------- | ----------- |
| `enabled`  | boolean | `true`            | Master switch; `false` skips all processing. |
| `stateDir` | string  | `.smart-restart`  | Sub-directory under `<DSH_HOME>` where `marker.json` is written. |
| `target`   | string  | `primary`         | Which agent(s) to notify: `primary` \| `all` \| `<session-id>`. |
| `wakeup`   | boolean | `true`            | `true` → `agent.followup()` wakes the agent and delivers; `false` → `agent.inject()` queues model-facing context only (no wake). |
| `notice`   | string  | `''`              | Optional custom notice text; returned verbatim when non-empty, else the default. |

`target` semantics:

- `primary` — the first root agent to start (the main agent). Delivery is guarded so exactly one primary is notified.
- `all` — every root agent.
- `<session-id>` — an exact session id, pinned to one specific agent.

Example with an explicit target pinned to a session id and a custom notice:

```yaml
- insert:
    - id: smart-restart
      name: dsh-smart-restart
      config:
        enabled: true
        stateDir: .smart-restart
        target: asistente            # notify only the session id "asistente"
        wakeup: true
        notice: "The DSH service restarted. Please check for interrupted work and report your status in one line."
```

> **Single delivery channel.** When `wakeup` is enabled the notice is delivered via `agent.followup()`; when disabled, via `agent.inject()`. It is **never** both with the same message — a followup that queues into the inbox and a parallel inject of the same message would collide with Inbox's "already pending" validation.

## Behavior & lifecycle

- **When woken**, the main agent receives a plugin-source user message (`source.kind: 'plugin'`, `form: 'notice'`) and typically acknowledges with a one-liner or resumes any interrupted task.
- **On success**, the plugin logs `[smart-restart] notice delivered to <id>`.
- **Once per boot** — the startup-event delivery and the ~1.8s fallback cannot both fire, so a restart produces exactly one notice.
- **Reversible lifecycle** — the event listener and fallback timer are registered through `ctx.effect` (reversible on plugin unload). The only intentional exception is the marker file itself, which must survive the restart it documents.

## Limitations

Be honest about what this plugin does not do:

- **Agent-side awareness only.** There is no desktop or browser toast — DSH currently has no notification service, so the notice surfaces only in the agent's own context (visible in the GUI session, not as an OS/browser notification).
- **Not for the one-shot headless CLI.** A boot-time wake may not exit cleanly in a single-shot headless run; this plugin targets long-lived GUI instances. The notice is still delivered and committed, but for headless one-shots it is of little use.
- **Per-DSH-home marker.** The marker lives under a single `<DSH_HOME>`, so separate homes (e.g. your stable vs. dev instance) are tracked independently — a restart of one does not notify agents in the other.
- **rc-era API.** The plugin targets DSH `>= 0.1.0-rc.7`; pre-1.0 APIs (events, session ids, message forms) may change in later releases.

## Development

```
src/
  index.ts   — apply() wiring: marker I/O, restart detection, delivery (followup/inject)
  boot.ts    — pure, deterministic restart + notice logic (I/O-free, unit-testable)
test/
  marker.test.js  — detectRestart / targetsAgent / compiled exports
  notice.test.js  — buildNotice / humanizeDowntime
```

- `pnpm install` — install dependencies.
- `pnpm build` — compile `src/` to `lib/` with `tsc`.
- `pnpm test` — run the unit tests in `test/` (`node:test`) against the built `lib/`.

The unit tests cover **pure logic only** (restart detection, targeting, humanized downtime, notice building). A real reboot smoke — install into an isolated development profile, trigger a service restart, and confirm the notice is delivered — is performed against a dev profile, since a true process restart cannot be exercised inside a unit-test process.

## License

MIT
