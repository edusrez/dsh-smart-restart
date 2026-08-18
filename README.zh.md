# dsh-smart-restart

[English](README.md) | 中文

一个 **DeepSeek Harness (DSH) 宿主插件**，让主代理在服务重启后保持感知——**无需用户主动提示**。每次启动时，它都会检测到新进程已经接管，并以一条简短的“Smart-restart”通知唤醒目标代理（启动时间、上一次启动时间、停机时长）。**v0.2.0** 新增了 `smart_restart` 工具，用于**重启 DSH 本身**，并将通知返回到发起请求的那一个会话；**v0.3.0** 新增了在代理会话处于活动状态期间服务被停止时的**自动检测**功能，因此即使是代理运行过的*普通* `systemctl restart`，也会在启动时通知该会话。

[![npm](https://img.shields.io/npm/v/dsh-smart-restart?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-smart-restart)
[![license](https://img.shields.io/npm/l/dsh-smart-restart?style=flat-square)](LICENSE)
[![stars](https://img.shields.io/github/stars/edusrez/dsh-smart-restart?style=flat-square)](https://github.com/edusrez/dsh-smart-restart)
[![last commit](https://img.shields.io/github/last-commit/edusrez/dsh-smart-restart?style=flat-square)](https://github.com/edusrez/dsh-smart-restart)

## 目录

- [概述](#概述)
- [工作原理](#工作原理)
- [`smart_restart` 工具](#smart_restart-工具)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [行为与生命周期](#行为与生命周期)
- [限制](#限制)
- [开发](#开发)
- [许可证](#许可证)

## 概述

长期运行的 DSH 实例会因多种原因重启：代理安装或重新配置插件并触发重启、宿主机重启，或者服务在 **systemd** 下被重启。经过任何此类重启之后，代理会再次启动并运行，但它**对发生的情况一无所知**——之前的会话已经消失了。如今，让代理继续工作的唯一办法就是由用户告知它，通常类似 *“you restarted”*。

`dsh-smart-restart` 填补了这一空白。它自行检测重启，并在启动时以一条简短、自足的通知唤醒主代理，说明发生了什么，从而由代理决定是恢复被打断的工作、记录停机，还是仅仅确认——无需用户提示。

**v0.3.0 新增**，该插件还覆盖**活动代理**的*非计划*重启。它会跟踪最近一次活动的会话，并在关闭（`SIGTERM`/`SIGINT`）时持久化写入 `shutdown-notice.json`；在启动时则把通知固定回该会话（当它在 `shutdownGraceMs` 内处于活动状态时）。因此，代理运行过的普通 `systemctl restart`——或者代理正在处理任务中途发生的重启——都会自动收到通知，无需用户提示。v0.2.0 让主代理能够*主动*触发重启：`smart_restart` 工具会记录调用它的会话，并通过 systemd 重启 DSH，把通知返回到该确切会话。

- **零提示** — 用户永远不必告诉代理“you restarted”。
- **自我重启** — 主代理可以自行重启 DSH，并在之后自动恢复其任务。
- **自动唤醒** — 空闲的主代理会被唤醒，并自行收到通知。
- **定向投递** — 重启后的通知会返回给发起请求的会话；否则由 `target` 配置决定它落到哪里。
- **精确上下文** — 通知携带启动时间、上一次启动时间、停机时长以及可选的原因。
- **自足** — 单个宿主包；无需运行任何东西，也没有外部服务。

## 工作原理

该插件在每次启动时：

1. **读取上一次的标记** — 一个持久化的 `marker.json`（`{lastBootAt, pid, dshVersion?}`），存放在 `<DSH_HOME>/<stateDir>/` 下。
2. **检测重启** — 若上一次的标记带有与当前 `process.pid` **不同的 `pid`**，则意味着*新进程*已经启动，也就是说服务重启了；停机时长为 `now − 上一次 lastBootAt`，并限制为 `≥ 0`。
3. **立即写入新标记**，以便下一次启动能与本次进行比较。
4. **检查是否有待处理的通知** — 如果 `smart_restart` 工具在之前那次重启前留下了 `pending-notice.json`，本次启动就会把投递**固定**到该确切会话（**最高优先级**；该文件读取一次即被消费）。
5. **检查是否有关机通知** — 如果**没有**待处理通知，插件会读取 `shutdown-notice.json`（由前一个进程在 `SIGTERM`/`SIGINT` 时写入，记录最近一次活动的会话）。若该会话在 `shutdownGraceMs` 内处于活动状态，本次启动会把它**固定**为投递目标（**第二优先级**）；否则跳过固定，投递回退到 `target`。该文件读取一次即被消费。
6. **投递通知** — 每次启动只投递一次，通过来源无关的 `agent/session-start` 钩子（被固定的会话无论发布来源如何都会被匹配，因此连以 `source: 'resume'` **恢复**的会话也能被捕获到），并由**有界轮询**（750ms 周期，约 15s 上限）支撑，用于捕捉延迟懒恢复的被固定会话。

根据重启发生的方式，共有**三条投递路径**：

### (a) 代理发起的重启（`smart_restart` 工具）

主代理调用 `smart_restart(reason?)`。该工具：

- 校验配置好的 `restartUnit` 令牌，
- **同步持久化待处理通知**（调用会话 + 可选原因）到状态目录下的 `pending-notice.json`，*在*任何 spawn 之前完成，以便在即将到来的服务终止中存活下来，
- 派生一个**分离的** `setsid bash` 进程（约 1s 延迟让工具响应的写入得以完成），该进程运行 `systemctl restart <unit>`，并能在本进程被 systemd 终止后存活，
- 返回 `{ok: true, restarting: true, ...}`。

在下次启动时，上面的第 4 步会读取待处理通知，把它**固定**到调用它的会话（**最高优先级**），通知便在那里返回——**无论来源如何**——因此发起请求的代理会恢复其被打断的任务。

### (b) 智能关机自动检测（代理活动时发生普通重启）

如果**没有**待处理通知，插件会查找 `shutdown-notice.json`。该文件由前一个进程在 `SIGTERM`/`SIGINT` 时同步写入，记录**最近一次活动的会话**（在 `agent/session-start` 和 `agent/pre-step` 上跟踪）及其时间戳。在启动时，插件*仅当*该会话在关机的 `shutdownGraceMs` 内处于活动状态时，才把通知**固定**到该会话（最近有活动 ⇒ 用户是在代理处理任务中途重启的，因此自动通知）。如果该会话在关机前早已空闲（用户可能是在空闲时重启的），则跳过固定，投递回退到 `target`。

这正是让代理运行过的普通 `systemctl restart`——或者代理活动时发生的重启——在启动时自动通知该会话的原因，无需用户提示，也无需调用过 `smart_restart`。

### (c) 外部重启（systemd、宿主机重启、开发工具）——没有活动会话

**没有待处理通知**，也**没有可用的关机通知**（要么没有写入，要么最近的活动早于 `shutdownGraceMs`）。启动回退到 `target` 配置（`primary` | `all` | `<session-id>`），以决定哪个/哪些代理收到通知。`source === 'startup'` 的这个门控只适用于这条非固定路径。

### 重启与 HMR 的语义

检测是刻意精确的：

| 情况 | 是否检测为重启？ |
| --------- | ---------------------- |
| 新的 OS 进程，且存在上一次标记 | **是** — 服务（重新）启动。 |
| 同一个 OS 进程（进程内 HMR / 热重载） | **否** — 被忽略。 |
| 首次启动（没有标记） | **否** — 没有可比较的对象。 |
| 标记存在但 `lastBootAt` 过期/损坏 | **是** — 停机时长报告为 0。 |

只有真正意义上的**新进程**才算一次重启。进程内热重载保持同一个 `pid`，因此不会被当作服务重启。投递**每次启动只发生一次**：一个 `deliveredIds` 集合加上一个 `primary` 守卫（针对 `primary` 目标）可防止启动事件与回退轮询重复发送。

### 通知

默认通知（英文）如下：

> Smart-restart: the DSH service restarted at `<iso>`. Previous boot: `<iso>` (downtime ~2m 9s). If a task was in progress, resume it; otherwise reply with a one-line acknowledgment.

当 `smart_restart` 记录了 `reason` 时，它会被追加（`… reason: <reason>.`）到恢复指令之前。当没有已知的上一次启动时间时，会省略上一次启动/停机时长的段落，而整段文本都可通过 `notice` 配置完全自定义（见下文）。

## `smart_restart` 工具

当 `toolEnabled` 为 true（默认值）时，通过 `apply` 中的 `ctx.tools.register` 注册（因此代理会话可用）。它让主代理能够通过 systemd 自行重启 DSH。

**参数**

| 参数    | 类型   | 必填 | 描述 |
| -------- | ------ | -------- | ----------- |
| `reason` | string | 否       | 可选的人类可读说明，例如 `"installed dshmarket in stable+dev"`。会包含在重启后的通知中。 |

**行为**

- 校验配置好的 `restartUnit` — 单个 systemd 单元令牌（`/^[A-Za-z0-9_.@-]+$/`，不含空格/斜杠），以防对分离命令进行 shell 注入。
- 当 `restartUnit` 未配置时**快速失败**（`ok: false`，错误 `restartUnit not configured`），而不是猜测单元名。
- **同步**持久化 `pending-notice.json`（在任何 spawn 之前），以便在服务终止时存活，并定向到正在重启的会话。
- 通过一个**分离的** `setsid bash` 进程（`sleep 1 && systemctl restart <unit>`）重启，该进程比本进程存活更久，然后对其 unref。
- 成功时返回 `{ok: true, restarting: true, sessionId, reason}`，失败时返回 `{ok: false, restarting: false, error}`。

**预期的代理流程**

```
install/change a plugin
  → call smart_restart(reason)   # e.g. "installed dshmarket in stable+dev"
  → DSH restarts (detached, ~1s)
  → after boot, the notice returns to THIS session (pinned)
  → the task continues automatically — no user prompt needed
```

**安全说明**

- 单元令牌会针对严格的正则进行校验，以阻止通过 `restartUnit` 对分离 shell 命令进行 shell 注入。
- 该工具面向 **systemd 托管**的 DSH 安装（`setsid` / `systemctl`）；它不适用于没有 systemd 单元的裸进程。

## 环境要求

- **DSH `>= 0.1.0-rc.7`** — 一个**长期运行、带有实时主代理会话的实例**（web / GUI profile）。该插件专为持续运行、主代理保持驻留的服务而设计；它**不**面向一次性 headless CLI。
- 使用 `smart_restart` 工具需要 **systemd 托管的 DSH 安装** — 它通过 `setsid`/`systemctl` 重启服务，因此 `restartUnit` 中命名的单元必须是真实的 systemd 单元（例如 `dsh.service`）。
- **Node.js / pnpm** — 构建和安装宿主包常用的 DSH 工具链。

## 安装

`dsh-smart-restart` 是一个 **DSH 宿主包**：`package.json` 携带 `dsh.bundle.patch = ./cordis.patch.yml`，因此安装该包可让插件层自动加入 profile 的 `dsh.profile.bundles`。

```bash
# From a registry (npm)
dsh plugin --profile <name> add dsh-smart-restart

# Or link a local checkout while developing
dsh plugin --profile <name> add /path/to/dsh-smart-restart
```

**`add` 之后需要重启** — 而这恰恰是本插件要呈现的场景。打包的补丁会把该层插入 profile 的层栈：

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
        restartUnit: ''   # REQUIRED per profile for smart_restart to work
        toolEnabled: true
```

> **每个 profile 都必须设置 `restartUnit`。** `smart_restart` 工具只有
> 在 `restartUnit` 命名了该 DSH 实例的 systemd 单元时才起作用。在
> `smart-restart` 行上添加一个 `cordis.patch.yml` 覆盖 —— **重申完整的
> config**（部分覆盖会丢弃其他键）—— 使用该 profile 的单元。例如，分别
> 针对稳定实例和开发实例：

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

由于该包声明了 `dsh.bundle`，该层会在安装时自动加入 `dsh.profile.bundles` —— 除了按 profile 覆盖 `restartUnit` 之外，无需手动编辑 profile。

## 配置

所有行为都通过插件行的 `config` 控制：

| 键           | 类型    | 默认值           | 描述 |
| ------------- | ------- | ----------------- | ----------- |
| `enabled`     | boolean | `true`            | 总开关；`false` 时跳过所有处理。 |
| `stateDir`    | string  | `.smart-restart`  | `<DSH_HOME>` 下的子目录，`marker.json`、`pending-notice.json` 和 `shutdown-notice.json` 写入其中。 |
| `target`      | string  | `primary`         | 当**没有**待处理/关机通知时通知哪个/哪些代理：`primary` \| `all` \| `<session-id>`。 |
| `wakeup`      | boolean | `true`            | `true` → `agent.followup()` 唤醒代理并投递；`false` → `agent.inject()` 仅排队面向模型的上下文（不唤醒）。 |
| `notice`      | string  | `''`              | 可选的自定义通知文本；非空时原样返回，否则使用默认文本。 |
| `restartUnit` | string  | `''`              | 调用 `smart_restart` 时重启的 systemd 单元（例如 `dsh.service` 或 `dsh-deepartments-dev.service`）。必须按 profile 设置；为空 → 工具以清晰错误安全失败。 |
| `toolEnabled` | boolean | `true`            | 是否注册 `smart_restart` 工具（是否对代理会话可用）。 |
| `shutdownGraceMs` | number | `600000`          | 关闭前的时间窗口（毫秒，默认 10 分钟），其间最近一次代理活动计为“涉及代理”，用于智能关机自动通知。如果在关机时最近一次活动的会话空闲时间超过了该窗口，则跳过固定，投递回退到 `target`。 |

`target` 语义（仅回退路径 —— 待处理通知或可用的关机通知会覆盖当次启动的 `target`）：

- `primary` — 第一个启动的根代理（主代理）。投递受到守卫，确保只通知一个 primary。
- `all` — 所有根代理。
- `<session-id>` — 一个确切的会话 id，固定到某个特定代理。

完整示例补丁行，重申每个键，并带有自定义通知和显式的 `restartUnit`：

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
```

> **单一投递通道。** 启用 `wakeup` 时通知通过 `agent.followup()` 投递；禁用时通过 `agent.inject()`。同一条消息**绝不会**同时走两者 —— 一条排队进入收件箱的 followup 与同一条消息的并行 inject 会与 Inbox 的“already pending”校验冲突。

## 行为与生命周期

- **被唤醒时**，主代理会收到一条插件来源的用户消息（`source.kind: 'plugin'`、`form: 'notice'`），通常会以一句话确认，或恢复任何被打断的任务。
- **成功时**，插件记录 `[smart-restart] notice delivered to <id>`；当待处理通知在启动时被固定时记录 `[smart-restart] pinned restart notice to session <id>`，当智能关机通知被固定时记录 `[smart-restart] pinned restart notice to last-active session <id>` —— 这些都是日志中可观察到的启动证据。
- **每次启动一次** — 启动事件投递与有界轮询不会同时触发，因此一次重启恰好产生一条通知。
- **固定优先级** —（1）工具调用者的 `pending-notice.json` 胜出；（2）当最近一次活动的会话在 `shutdownGraceMs` 内处于活动状态时，智能关机的 `shutdown-notice.json` 固定到该会话；（3）否则由 `target` 决定。
- **可逆生命周期** — 事件监听器、轮询定时器、工具注册以及 `SIGTERM`/`SIGINT` 处理器都可经由 `ctx.effect` 逆转（在插件卸载 / HMR 时被丢弃）。唯一的刻意例外是标记以及 `pending-notice.json`/`shutdown-notice.json` 文件，它们必须在其所记录的重启中存活下来。

## 限制

诚实地说说这个插件不做的事：

- **仅代理侧感知。** 没有桌面或浏览器 toast —— DSH 目前没有通知服务，因此通知只出现在代理自身的上下文中（在 GUI 会话中可见，而不是作为 OS/浏览器通知）。
- **不适用于一次性 headless CLI。** 启动时的唤醒可能在单次 headless 运行中无法干净退出；本插件面向长期运行的 GUI 实例。通知仍会被投递和提交，但对于 headless 一次性运行来说意义不大。
- **按 DSH-home 的标记。** 标记存放在单个 `<DSH_HOME>` 下，因此不同的 home（例如你的稳定实例与开发实例）会被独立跟踪——重启其一不会通知另一个中的代理。
- **工具需要 restartUnit。** `smart_restart` 工具需要配置好的 `restartUnit`；没有时工具安全失败。当代理在 `shutdownGraceMs` 内处于活动状态时，非工具重启仍会被自动检测，否则回退到 `target`。
- **既有会话可能缺少该工具。** 在安装插件**之前**创建的、其工具集已生成的会话不会有 `smart_restart` —— 安装后请新开聊天以获取它。
- **rc 时代 API。** 该插件面向 DSH `>= 0.1.0-rc.7`；1.0 之前的 API（事件、会话 id、消息形式）在后续版本中可能发生变化。

## 开发

```
src/
  index.ts   — apply() wiring: marker + pending/shutdown-notice I/O, restart detection, activity tracking + SIGTERM/SIGINT hook, smart_restart tool, delivery (followup/inject)
  boot.ts    — pure, deterministic restart + notice logic (I/O-free, unit-testable), incl. parseShutdownNotice / shutdownTarget
test/
  marker.test.js  — detectRestart / parsePendingNotice / parseShutdownNotice / shutdownTarget / selectsAgent / targetsAgent / compiled exports
  notice.test.js  — buildNotice / humanizeDowntime
```

- `pnpm install` — 安装依赖。
- `pnpm build` — 用 `tsc` 把 `src/` 编译到 `lib/`。
- `pnpm test` — 针对构建好的 `lib/` 运行 `test/` 中的单元测试（`node:test`）。

单元测试只覆盖**纯逻辑**（重启检测、待处理通知解析、定向、人类可读的停机时长、通知构建），外加一个对编译后插件导出的简单检查。真正的重启冒烟测试 —— 安装到隔离的开发 profile、触发一次服务重启、确认通知被投递 —— 会针对开发 profile 进行，因为真正的进程重启无法在单元测试进程内部演练。

## 许可证

MIT
