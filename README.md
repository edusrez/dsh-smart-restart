# dsh-smart-restart

English | [中文](README.zh.md)

A **DeepSeek Harness (DSH) host plugin** that keeps the main agent aware of service restarts — **without the user having to prompt it**. On every boot it detects that a new process has taken over, wakes the target agent with a short "Smart-restart" notice (boot time, previous boot, downtime). New in **v0.2.0** it added the `smart_restart` tool to **restart DSH itself** and return the notice to the exact session that asked; new in **v0.3.0** it **auto-detects** when the service was stopped while an agent session was active, so even a *plain* `systemctl restart` the agent ran notifies that session at boot; new in **v0.4.0** it can **validate the launch first** with an optional canary pre-restart gate that aborts the restart when an ephemeral boot fails.

[![npm](https://img.shields.io/npm/v/dsh-smart-restart?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-smart-restart)
[![license](https://img.shields.io/npm/l/dsh-smart-restart?style=flat-square)](LICENSE)
[![stars](https://img.shields.io/github/stars/edusrez/dsh-smart-restart?style=flat-square)](https://github.com/edusrez/dsh-smart-restart)
[![last commit](https://img.shields.io/github/last-commit/edusrez/dsh-smart-restart?style=flat-square)](https://github.com/edusrez/dsh-smart-restart)

## Table of contents

- [Overview](#overview)
- [How it works](#how-it-works)
- [The `smart_restart` tool](#the-smart_restart-tool)
- [Canary pre-restart validation](#canary-pre-restart-validation)
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

**New in v0.3.0**, the plugin also covers the *unplanned* restart of an **active agent**. It tracks the last active session and, on shutdown (`SIGTERM`/`SIGINT`), persists a `shutdown-notice.json`; on boot it pins the notice back to that session (when it was active within `shutdownGraceMs`). So a plain `systemctl restart` the agent ran — or a restart that happened while an agent was mid-task — is auto-notified without the user prompting. v0.2.0 let the main agent *cause* restarts: the `smart_restart` tool records the calling session and restarts DSH through systemd, returning the notice to that exact session.

- **Zero prompting** — the user never has to tell the agent "you restarted".
- **Self-restart** — the main agent can restart DSH itself and resume its task automatically afterwards.
- **Automatic wake** — an idle main agent is woken and handed the notice on its own.
- **Targeted delivery** — the post-restart notice returns to the session that requested it; otherwise the `target` config decides where it lands.
- **Precise context** — the notice carries the boot time, the previous boot time, the downtime, and an optional reason.
- **Canary safety** — an optional pre-restart gate boots an ephemeral DSH instance and aborts the restart when it fails (see below).
- **Self-contained** — a single host bundle; nothing to run, no external service.

## How it works

On every boot the plugin:

1. **Reads the previous marker** — a durable `marker.json` (`{lastBootAt, pid, dshVersion?}`) stored under `<DSH_HOME>/<stateDir>/`.
2. **Detects a restart** — a previous marker with a **different `pid`** than the current `process.pid` means a *new process* has started, i.e. the service restarted; downtime is `now − previous lastBootAt`, clamped to `≥ 0`.
3. **Writes a new marker** immediately, so the next boot can be compared against this one.
4. **Checks for a pending notice** — if the `smart_restart` tool left a `pending-notice.json` before the previous restart, this boot **pins** delivery to that exact session (**highest priority**; the file is consumed once read).
5. **Checks for a shutdown notice** — if there was **no** pending notice, the plugin reads `shutdown-notice.json` (written by the previous process on `SIGTERM`/`SIGINT`, recording the last active session). If that session was active within `shutdownGraceMs`, this boot **pins** delivery to it (**second priority**); otherwise the pin is skipped and delivery falls back to `target`. The file is consumed once read.
6. **Delivers the notice** — once per boot via the source-agnostic `agent/session-start` hook (a pinned session is matched regardless of publication source, so a session that **resumes** with `source: 'resume'` is caught too), backed by a **bounded poll** (750ms tick, ~15s cap) that picks up a pinned session which resumes lazily late.

There are **three delivery paths**, depending on how the restart happened:

### (a) Agent-initiated restart (`smart_restart` tool)

The main agent calls `smart_restart(reason?)`. The tool:

- validates the configured `restartUnit` token,
- **persists the pending notice synchronously** (calling session + optional reason) to `pending-notice.json` under the state dir, *before* any spawn so it survives the imminent service kill,
- spawns a **detached** `setsid bash` process (a ~1s delay lets the tool's response be written) that runs `systemctl restart <unit>` and survives this process being killed by systemd,
- returns `{ok: true, restarting: true, ...}`.

On the next boot, step 4 above reads the pending notice, **pins** it to the calling session (**highest priority**), and the notice returns there — **regardless of source** — so the agent that asked resumes its interrupted task.

### (b) Smart shutdown auto-detection (plain restart while an agent was active)

If there is **no** pending notice, the plugin looks for a `shutdown-notice.json`. This file is written synchronously by the previous process on `SIGTERM`/`SIGINT`, recording the **last active session** (tracked on `agent/session-start` and `agent/pre-step`) and its timestamp. On boot the plugin **pins** the notice to that session *only if* it was active within `shutdownGraceMs` of shutdown (recent activity ⇒ the user restarted while the agent was mid-task, so auto-notify). If the session was idle well before shutdown (the user probably restarted while idle), the pin is skipped and delivery falls back to `target`.

This is what makes a **plain `systemctl restart`** that the agent ran — or a restart that happened while an agent was active — auto-notify that session at boot, with no user prompt and no need to have called `smart_restart`.

### (c) External restart (systemd, host reboot, dev tools) — no active session

There is **no pending notice** and **no usable shutdown notice** (either none was written, or the last activity predates `shutdownGraceMs`). The boot falls back to the `target` config (`primary` | `all` | `<session-id>`) to decide which agent(s) get the notice. The `source === 'startup'` gate applies only to this non-pinned path.

### Restart vs. HMR semantics

The detection is intentionally precise:

| Situation | Detected as a restart? |
| --------- | ---------------------- |
| New OS process, previous marker exists | **Yes** — service (re)started. |
| Same OS process (in-process HMR / hot-reload) | **No** — ignored. |
| First-ever boot (no marker) | **No** — nothing to compare against. |
| Marker present but stale/corrupt `lastBootAt` | **Yes** — downtime reported as 0. |

Only a genuinely **new process** counts as a restart. An in-process hot-reload keeps the same `pid`, so it is not treated as a service restart. Delivery happens **once per boot**: a `deliveredIds` set plus a `primary` guard (for the `primary` target) prevent the startup event and the fallback poll from double-sending.

### Notice

The default notice (English) reads:

> Smart-restart: the DSH service restarted at `<iso>`. Previous boot: `<iso>` (downtime ~2m 9s). If a task was in progress, resume it; otherwise reply with a one-line acknowledgment.

When a `reason` was recorded by `smart_restart`, it is appended (`… reason: <reason>.`) before the resume instruction. The previous-boot/downtime segment is omitted when no previous boot time is known, and the whole text is fully customizable via the `notice` config (see below).

## The `smart_restart` tool

Registered via `ctx.tools.register` in `apply` (so it is available to agent sessions) when `toolEnabled` is true (the default). It lets the main agent restart DSH itself through systemd.

**Parameters**

| Param    | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `reason` | string | no       | Optional human-readable note, e.g. `"installed dshmarket in stable+dev"`. Included in the post-restart notice. |
| `canary` | boolean | no      | Optional canary pre-restart validation for THIS call: boots an ephemeral DSH instance and aborts the restart on failure (see [Canary pre-restart validation](#canary-pre-restart-validation)). Overrides the configured `canary` for this call. |

**Behavior**

- Validates the configured `restartUnit` — a single systemd unit token (`/^[A-Za-z0-9_.@-]+$/`, no spaces/slashes) to prevent shell injection into the detached command.
- **Fails fast** when `restartUnit` is not configured (`ok: false`, error `restartUnit not configured`) rather than guessing a unit.
- Persists `pending-notice.json` **synchronously** (before any spawn) so it survives the service kill and targets the restarting session.
- Restarts via a **detached** `setsid bash` process (`sleep 1 && systemctl restart <unit>`) that outlives this process, then unrefs it.
- Returns `{ok: true, restarting: true, sessionId, reason}` on success, or `{ok: false, restarting: false, error}` when it fails.

**Intended agent flow**

```
install/change a plugin
  → call smart_restart(reason)   # e.g. "installed dshmarket in stable+dev"
  → DSH restarts (detached, ~1s)
  → after boot, the notice returns to THIS session (pinned)
  → the task continues automatically — no user prompt needed
```

**Safety notes**

- The unit token is validated against a strict regex to block shell injection through `restartUnit` into the detached shell command.
- The tool targets a **systemd-managed** DSH install (`setsid` / `systemctl`); it does not apply to a bare process without a systemd unit.

## Canary pre-restart validation

> **New in v0.4.0.** Optional, opt-in, and fully generic — it works on any DSH
> install: `restartUnit` remains the only required tool config.

When enabled, the `smart_restart` tool can validate the launch **before** anything is persisted or restarted: it boots an **ephemeral DSH instance** from the same binary and profile as the systemd unit, verifies it starts, and only then proceeds with the real `systemctl restart`. A failed canary **aborts the restart** — no pending notice is written, nothing is spawned, and the calling session is alerted live (same plugin-source notice channel).

**What it does, step by step**

1. **Resolves the dsh binary/profile** — an explicit `canaryBinary` / `canaryProfile` wins; otherwise both are derived from `systemctl show -p ExecStart <restartUnit>` (binary falls back to `dsh` on PATH). The `--profile` flag is omitted when no profile resolves.
2. **Creates a temp state dir and a temp patch overlay** (`dsh --patch <tmp>/canary.patch.yml`, applied after the profile layer): the `smart-restart` row itself is disabled in the canary (`enabled: false`) and every `canaryStateDirOverrides` entry gets its `stateDir` redirected into the temp dir — so the canary never writes a marker, notice, or live board state.
3. **Pre-flights the launch** with `--dump-config` (20s timeout; a compose failure aborts the restart).
4. **Boots the ephemeral instance** detached with the same overlay on an auto-picked free port (`canaryPort` when set) and **polls** `http://127.0.0.1:<port>/` until HTTP 200 or `canaryTimeoutMs` elapses (per-attempt 800ms; a refused connection or non-200 is "not yet").
5. **Stops the ephemeral** (process-group kill) and returns: `passed` → the restart proceeds; `failed` → abort + alert the caller; `skipped` → the restart proceeds (a skip is not a failure).

**When it skips (never blocks)** — if the dsh binary/profile cannot be derived (no `systemctl` lookup result AND no explicit `canaryBinary`/`canaryProfile`), the canary reports `skipped` and the restart proceeds unchanged. Generic installs are therefore always safe: a canary failure only ever aborts a restart when *you* opted in with an actual, resolvable launch target.

**How to enable**

- **Per profile**: add `canary: true` (plus any overrides) to the `smart-restart` row. The per-profile patch row REPLACES the row's whole config, so restate your existing fields (see the example in [Configuration](#configuration)).
- **Per call** (agent-facing): call `smart_restart(canary: true, reason)`, which overrides the configured default for that single call.

**Config fields**

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `canary` | boolean | `false` | Master opt-in for the canary gate. |
| `canaryTimeoutMs` | number | `45000` | Hard window (ms) for the canary boot liveness probe; a timeout is a canary failure and aborts the restart. |
| `canaryPort` | number | `0` | HTTP port for the ephemeral canary instance; `0` auto-picks a free port. |
| `canaryProfile` | string | `''` | Explicit dsh profile for the canary launch; empty derives from the unit's `ExecStart` (`--profile`). |
| `canaryBinary` | string | `''` | Explicit dsh binary for the canary launch; empty derives from the unit's `ExecStart`, else `dsh` on PATH. |
| `canaryStateDirOverrides` | object | `{}` | Plugin-row id → temp dir: those rows get their `stateDir` redirected in the canary patch (e.g. `deepartments: ''` keeps the canary off live board state). Relative or empty values resolve under the canary temp dir; absolute values are used verbatim. |

> **Note on overrides and row replacement.** Patch rows replace their row's
> WHOLE config (no merge) — and the canary is a throwaway instance, so a
> listed row gets only its `stateDir` overridden and its remaining config
> reverts to that plugin's own defaults. Use `canaryStateDirOverrides` only
> for rows that boot fine with defaulted config (the live profile's row is
> untouched). Rows that don't exist in the canary's composed tree are skipped
> with a loader warning.

**Output** — when a canary ran, the tool result carries `canary` (`passed` /
`skipped` / `failed`) plus `canaryDetail`, and the rendered response gains a
`Canary: …` line (`Canary: passed — restarting…`, `Canary: failed — restart
ABORTED: <detail>`, or `Canary: skipped — <detail>`).

## Requirements

- **DSH `>= 0.1.0-rc.7`** — a **long-lived instance with a live main-agent session** (the web / GUI profile). This plugin is designed for a continuously-running service whose main agent stays resident; it is **not** aimed at the one-shot headless CLI.
- **systemd-managed DSH install** for the `smart_restart` tool — it restarts the service through `setsid`/`systemctl`. Since **v0.5.0** the tool **auto-detects its own systemd unit** from `/proc/self/cgroup`, so no `restartUnit` config is needed; the detected unit must be a real systemd unit (e.g. `dsh.service`).
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
        restartUnit: ''   # OPTIONAL since v0.5.0 — auto-detected on systemd installs; set explicitly when the unit differs
        toolEnabled: true
```

> **`restartUnit` is OPTIONAL since v0.5.0 on systemd installs.** The plugin
> auto-detects its **own systemd unit** from `/proc/self/cgroup`, so the
> `smart_restart` tool (and the canary's `ExecStart` derivation) work with
> **zero config** on a systemd-managed DSH install. Set `restartUnit`
> explicitly when the unit name differs from the auto-detected one or when
> detection is unavailable (e.g. a bare non-systemd process). If you DO set
> it, add a `cordis.patch.yml` override on the `smart-restart` row —
> **restating the full config** (a partial override would drop the other keys)
> — with the unit for that profile. For example, for the stable instance and
> the dev instance respectively:

```yaml
# Override on the smart-restart row — profile "stable" (dsh.service)
- insert:
    - id: smart-restart
      name: dsh-smart-restart
      config:
        enabled: true
        stateDir: .smart-restart
        target: primary
        wakeup: true
        notice: ''
        restartUnit: dsh.service
        toolEnabled: true

# Override on the smart-restart row — profile "deepartments-dev" (dsh-deepartments-dev.service)
- insert:
    - id: smart-restart
      name: dsh-smart-restart
      config:
        enabled: true
        stateDir: .smart-restart
        target: primary
        wakeup: true
        notice: ''
        restartUnit: dsh-deepartments-dev.service
        toolEnabled: true
```

Because the bundle declares `dsh.bundle`, the layer auto-joins `dsh.profile.bundles` on install — no manual profile edit required. `restartUnit` is **usually auto-detected** (v0.5.0); add the explicit override above only when the unit name differs or detection is unavailable.

## Configuration

All behavior is controlled through the plugin row's `config`:

| Key           | Type    | Default           | Description |
| ------------- | ------- | ----------------- | ----------- |
| `enabled`     | boolean | `true`            | Master switch; `false` skips all processing. |
| `stateDir`    | string  | `.smart-restart`  | Sub-directory under `<DSH_HOME>` where `marker.json`, `pending-notice.json` and `shutdown-notice.json` are written. |
| `target`      | string  | `primary`         | Which agent(s) to notify when there is **no** pending/shutdown notice: `primary` \| `all` \| `<session-id>`. |
| `wakeup`      | boolean | `true`            | `true` → `agent.followup()` wakes the agent and delivers; `false` → `agent.inject()` queues model-facing context only (no wake). |
| `notice`      | string  | `''`              | Optional custom notice text; returned verbatim when non-empty, else the default. |
| `restartUnit` | string  | `''`              | Systemd unit to restart when `smart_restart` is invoked (e.g. `dsh.service` or `dsh-deepartments-dev.service`). Since **v0.5.0** it is **auto-detected from `/proc/self/cgroup`** (the plugin's own unit) when empty; an explicit value always wins. Empty with no detectable unit → the tool fails safe with a clear error. |
| `toolEnabled` | boolean | `true`            | Whether the `smart_restart` tool is registered (available to agent sessions). |
| `shutdownGraceMs` | number | `600000`          | Grace window (ms, default 10 minutes) before shutdown within which last agent activity counts as "agent-involved" for the smart shutdown auto-notification. If the last-active session was idle beyond this window on shutdown, the pin is skipped and delivery falls back to `target`. |
| `ignoredSessionPrefixes` | string[] | `['head-']` | Session-id prefixes that must never be selected as "last active" for the smart-shutdown auto-notification, so Deepartments department-head sessions (`head-<postId>`) don't get a spurious post-restart notice. Configurable list; default ON (heads skipped). |
| `canary` | boolean | `false` | Opt-in [canary pre-restart validation](#canary-pre-restart-validation): boot an ephemeral DSH instance and abort the restart on failure. The per-call `canary` tool parameter overrides this for one call. |
| `canaryTimeoutMs` | number | `45000` | Hard window (ms) for the canary boot liveness probe (default 45s); a timeout is a canary failure and aborts the restart. |
| `canaryPort` | number | `0` | HTTP port for the ephemeral canary instance; `0` auto-picks a free port. |
| `canaryProfile` | string | `''` | Explicit dsh profile for the canary launch; empty derives it from the unit's `ExecStart` (`--profile`). |
| `canaryBinary` | string | `''` | Explicit dsh binary for the canary launch; empty derives it from the unit's `ExecStart`, else `dsh` on PATH. |
| `canaryStateDirOverrides` | object | `{}` | Plugin-row id → temp dir; those rows get their `stateDir` redirected in the canary patch so the ephemeral never writes live state (e.g. `deepartments: ''` keeps the canary off live board state). Relative or empty values resolve under the canary temp dir; absolute values are used verbatim. |

`target` semantics (fallback path only — a pending notice or a usable shutdown notice overrides `target` for that boot):

- `primary` — the first root agent to start (the main agent). Delivery is guarded so exactly one primary is notified.
- `all` — every root agent.
- `<session-id>` — an exact session id, pinned to one specific agent.

Full example patch row, restating every key with a custom notice and an explicit `restartUnit`:

```yaml
- insert:
    - id: smart-restart
      name: dsh-smart-restart
      config:
        enabled: true
        stateDir: .smart-restart
        target: primary
        wakeup: true
        notice: "The DSH service restarted. Please check for interrupted work and report your status in one line."
        restartUnit: dsh.service
        toolEnabled: true
        shutdownGraceMs: 600000
        ignoredSessionPrefixes:
          - head-
        canary: true
        canaryTimeoutMs: 45000
        canaryPort: 0
        canaryProfile: ''
        canaryBinary: ''
        canaryStateDirOverrides:
          deepartments: ''
```

> **Single delivery channel.** When `wakeup` is enabled the notice is delivered via `agent.followup()`; when disabled, via `agent.inject()`. It is **never** both with the same message — a followup that queues into the inbox and a parallel inject of the same message would collide with Inbox's "already pending" validation.

## Behavior & lifecycle

- **When woken**, the main agent receives a plugin-source user message (`source.kind: 'plugin'`, `form: 'notice'`) and typically acknowledges with a one-liner or resumes any interrupted task.
- **On success**, the plugin logs `[smart-restart] notice delivered to <id>`; when a pending notice is pinned on boot it logs `[smart-restart] pinned restart notice to session <id>`, and when a smart shutdown notice is pinned it logs `[smart-restart] pinned restart notice to last-active session <id>` — all observable boot evidence in the journal.
- **Once per boot** — the startup-event delivery and the bounded poll cannot both fire, so a restart produces exactly one notice.
- **Pinning priority** — (1) a tool-caller `pending-notice.json` wins; (2) a smart shutdown `shutdown-notice.json` pins to the last-active session when it was active within `shutdownGraceMs`; (3) otherwise `target` decides.
- **Reversible lifecycle** — the event listeners, poll timer, tool registration, and `SIGTERM`/`SIGINT` handlers are reversible via `ctx.effect` (dropped on plugin unload / HMR). The only intentional exceptions are the marker and the `pending-notice.json`/`shutdown-notice.json` files, which must survive the restart they document.

## Limitations

Be honest about what this plugin does not do:

- **Agent-side awareness only.** There is no desktop or browser toast — DSH currently has no notification service, so the notice surfaces only in the agent's own context (visible in the GUI session, not as an OS/browser notification).
- **Not for the one-shot headless CLI.** A boot-time wake may not exit cleanly in a single-shot headless run; this plugin targets long-lived GUI instances. The notice is still delivered and committed, but for headless one-shots it is of little use.
- **Per-DSH-home marker.** The marker lives under a single `<DSH_HOME>`, so separate homes (e.g. your stable vs. dev instance) are tracked independently — a restart of one does not notify agents in the other.
- **Tool requires a systemd unit.** Since **v0.5.0** the `smart_restart` tool **auto-detects the plugin's own unit from `/proc/self/cgroup`** on systemd-managed installs — no `restartUnit` config needed. On a host where no unit is detectable (a bare non-systemd process), the tool still fails safe: set `restartUnit` explicitly to override the auto-detected unit or to enable the tool there. Non-tool restarts are still auto-detected when an agent was active within `shutdownGraceMs`, otherwise they fall back to `target`.
- **Canary adds latency.** A canary-gated call blocks the tool for up to `canaryTimeoutMs` (default 45s) while the ephemeral instance boots and is probed; disable the canary (or lower the timeout) for fast, low-risk restarts. The canary validates config/compose + boot health, not the `systemctl restart` command itself (the restart remains fire-and-forget).
- **Existing sessions may lack the tool.** A session whose toolset was created **before** the plugin was installed won't have `smart_restart` — start a new chat after installing to pick it up.
- **rc-era API.** The plugin targets DSH `>= 0.1.0-rc.7`; pre-1.0 APIs (events, session ids, message forms) may change in later releases.

## Development

```
src/
  index.ts   — apply() wiring: marker + pending/shutdown-notice I/O, restart detection, activity tracking + SIGTERM/SIGINT hook, smart_restart tool (incl. the optional canary gate + abort alert), delivery (followup/inject)
  boot.ts    — pure, deterministic restart + notice logic (I/O-free, unit-testable), incl. parseShutdownNotice / shutdownTarget
  canary.ts  — optional canary pre-restart validation: ExecStart derivation, temp patch build, free-port pick, dump-config pre-flight, boot + liveness probe (all IO injectable via CanaryHooks)
test/
  marker.test.js  — detectRestart / parsePendingNotice / parseShutdownNotice / shutdownTarget / selectsAgent / targetsAgent / compiled exports
  notice.test.js  — buildNotice / humanizeDowntime
  canary.test.js  — deriveExecStartParams / buildPatchContent / pickFreePort / probeStatusHealthy / resolveExecTarget / runCanary with injected hooks
```

- `pnpm install` — install dependencies.
- `pnpm build` — compile `src/` to `lib/` with `tsc`.
- `pnpm test` — run the unit tests in `test/` (`node:test`) against the built `lib/`.

The unit tests cover **pure logic only** (restart detection, pending-notice parsing, targeting, humanized downtime, notice building) plus a small check of the compiled plugin exports. A real reboot smoke — install into an isolated development profile, trigger a service restart, and confirm the notice is delivered — is performed against a dev profile, since a true process restart cannot be exercised inside a unit-test process.

## License

MIT
