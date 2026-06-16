# tunlite

**English** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/yuanyuanzijin/tunlite/actions/workflows/ci.yml/badge.svg)](https://github.com/yuanyuanzijin/tunlite/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tunlite)](https://www.npmjs.com/package/tunlite)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A lightweight, cross-platform **SSH tunnel manager** — the one CLI that replaces
*autossh + a systemd unit per tunnel + a scratchpad of `-L`/`-R`/`-D` flags*. Define
named tunnels once; a tiny **zero-dependency** daemon keeps them connected, restarts
them at login, and sets up passwordless access to the target. Every command speaks
**`--json`** with stable exit codes, so **AI agents drive it as easily as you do** — it
even ships an agent skill.

- **Agent-native** — `--json` on every command, stable exit codes, and a bundled agent skill.
- **Zero third-party dependencies** — pure Node.js standard library, no npm packages; all it needs on the box is **Node ≥ 18** and the system `ssh` it wraps.
- **Wraps your system `ssh`** — fully aligned (keys, jump hosts, `ssh_config` all supported).
- **Auto-reconnect** — exponential backoff + jitter, keepalive, port health probes.
- **Start at login** — launchd (macOS) / systemd user service (Linux) / Task Scheduler (Windows — beta).
- **Passwordless setup** — connects directly if keys already work; installs your key only if needed.
- **Three forward types** — local `-L`, remote `-R`, dynamic SOCKS `-D`.

## Why tunlite?

If you keep a few SSH tunnels running — a reverse tunnel to a homelab box, a SOCKS
proxy through a bastion, a port-forward to a staging database — you've probably wired
up `autossh` plus a `systemd`/`launchd` unit for each, and memorized which
`-L`/`-R`/`-D` flag goes where. tunlite folds all of that into one declarative CLI on
top of the `ssh` you already trust: named tunnels a daemon keeps alive and the OS
restarts at boot — no new server, no account, no protocol. And because every command
is `--json` with stable exit codes, an agent drives the exact same surface you do.

| | tunlite | autossh | plain `ssh -L/-R/-D` | sshuttle | frp · bore · chisel | ngrok |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Wraps your system `ssh` (keys, jump hosts, `ssh_config`) | ✅ | ✅ | ✅ | partial | ❌ own protocol | ❌ own service |
| Named, declarative tunnels | ✅ | ❌ | ❌ | ❌ | ✅ config | ✅ |
| Auto-reconnect (backoff, keepalive, health) | ✅ | basic | ❌ | ❌ | ✅ | ✅ |
| Start at login (launchd/systemd/Task Scheduler) | ✅ | DIY | DIY | DIY | DIY | ✅ |
| Local **+** remote **+** dynamic SOCKS | ✅ | ✅ | ✅ | transparent proxy | varies | varies |
| Zero deps · no server to run · self-hosted | ✅ | needs autossh | ✅ | needs python | needs a server | hosted/paid |
| Agent-friendly (`--json`, stable exit codes) | ✅ | ❌ | ❌ | ❌ | ❌ | partial |

## Install

Prerequisite: Node ≥ 18 on your PATH (used to run; `tunlite install` pins it into the launcher).

```bash
# Recommended: one-line fetch + anchor (no global npm needed)
npx tunlite install

# Or: curl one-liner (no npm; just curl/wget + tar + node)
curl -fsSL https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.sh | sh
# With args: … | sh -s -- --service --skill user

# Windows (PowerShell) — beta
irm https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.ps1 | iex
```

> **Windows support is beta.** macOS and Linux are the primary, CI-tested
> platforms; Windows (Task Scheduler autostart, `.cmd` launcher, PATH setup) works
> but is less battle-tested and not yet covered by CI — please report rough edges.

`tunlite install` copies the runtime to a fixed directory and writes a launcher that
**pins node's absolute path** (so switching nvm/fnm versions won't break it). When run
interactively it also asks whether to register login autostart and install the agent skill.

> **Short alias `tun`**: install also writes a `tun` command (equivalent to `tunlite`,
> saving you 4 keystrokes) — `tun status`, `tun up`, `tun logs web -f` all work. If `tun`
> is already taken on your machine, install **skips it with a notice** and never overwrites
> it (just keep using `tunlite`); `tunlite uninstall` only removes the `tun` it created.

## Quick start

```bash
# One forward each below (a tunnel can carry several — see `forward add`).
# --local = your machine's side, --remote = the server's side;
# the subcommand decides who listens.
tunlite add local   web-8080 --to user@server --remote 80 --local 8080   # reach server's :80 locally (local 8080)
tunlite add dynamic px-1080  --to user@server                            # SOCKS5 proxy (local 1080 by default)
tunlite add remote  rev-9000 --to user@server --local 3000 --remote 9000 # expose local 3000 as server:9000

tunlite up                 # enable + start all, bringing up the daemon (sets up keys if needed)
tunlite status             # aligned table: NAME STATE HOST TYPE ROUTE PID UP RESTARTS
tunlite status web-8080    # vertical detail for one tunnel
tunlite logs web-8080 -f   # follow logs
tunlite doctor             # one-shot health check: why it won't connect (ssh/key/port/daemon/service)

tunlite install service    # optional: start the daemon (and your tunnels) at login
```

When the target isn't passwordless yet, running `tunlite up` in a terminal prompts you
for the password once and installs your key automatically. You can also do it explicitly:

```bash
tunlite check user@server      # exit code 0 = passwordless already works
tunlite setup-key user@server  # install your public key (one password prompt)
```

Full options for each command are in the [Commands](#commands) section below.

## Update

Once installed, upgrade with a single command:

```sh
tunlite update              # upgrade to the latest (restarts the daemon by default; tunnels blip ~1s)
tunlite update v0.1.0       # install/roll back to a specific version (tag)
tunlite update --check      # compare current vs latest only; change nothing
tunlite update --no-restart # swap files only, don't restart the daemon (new code applies next start)
tunlite --version           # show the current version
```

`update` fetches a tarball and re-anchors (no npm, no git), replacing the runtime in
place and restarting the daemon. Run from a **source checkout** (a dev clone with
`.git`) it refuses to self-update and tells you to update with git, then run `tunlite install`.

> Note: "latest" is the version in `package.json` on `master`. If `master` changed but the
> version number didn't, `tunlite update` reports "already up to date"; use
> `tunlite update --force` to reinstall the latest code at the same version.

## Uninstall

```bash
tunlite uninstall            # stop daemon + remove autostart + remove skill + remove launcher/lib
tunlite uninstall --purge    # also remove config and logs
tunlite uninstall service    # remove autostart only; uninstall skill removes only the skill
```

## Live dashboard (monitor)

`tunlite monitor` (alias `tunlite mon`) opens a top-style full-screen live dashboard:
daemon status and tunnel counts up top, a color-coded tunnel table below. Keys:

- `↑/k` `↓/j` select, `s` start, `x` stop (`y/N` confirm), `r` restart (`y/N` confirm)
- `?` help, `q` quit
- `--interval <seconds>` adjusts the refresh rate (default 1s)

Requires an interactive terminal; in scripts use `tunlite status --json`.

## Drop alerts (webhook)

When a tunnel drops, the daemon POSTs an alert to a webhook you configure, formatted per
**channel** into what the target chat endpoint expects (currently `generic` + WeCom
`wecom`). The channel is detected from the URL, or overridden with `--channel`.
**Pure Node built-in http/https — no new dependencies.**

```bash
tunlite webhook                                  # show current webhook (URL / channel / on-off / events)
tunlite webhook set https://example.com/hook     # set and enable (channel auto-detected from URL)
tunlite webhook set <url> --channel wecom        # set the channel explicitly
tunlite webhook set <url> --events tunnel,daemon-crash   # set URL and pick events at once
tunlite webhook on | off                         # enable / disable (off keeps the URL)
tunlite webhook events down,recovered            # change the subscribed events only
tunlite webhook test                             # send a test event and report the channel's verdict
```

**Channels** render the alert into the format the target accepts:

- `generic` (default) — the raw JSON event, for your own endpoint.
- `wecom` (WeCom) — a group-bot `{msgtype:text}` text message; auto-enabled when
  `qyapi.weixin.qq.com` is detected. `webhook test` reads the response body, so a rejection
  (errcode) is reported faithfully instead of being mistaken for "sent".

**Events** (edge-triggered on state, so a reconnect storm fires once) come in two groups:

- Tunnel-level: `up` (connected), `down` (dropped after being up), `recovered` (back after a
  drop), `needs-auth` (passwordless broke), `failed` (forward failed, e.g. port in use),
  `stopped` (stopped/deleted by hand).
- Daemon-level: `daemon-up` (daemon started), `daemon-down` (clean exit),
  `daemon-crash` (a previous unclean exit, detected on next start).

`webhook events` accepts **named** items (`down,recovered`), **groups** (`tunnel` / `daemon`),
`all`, and `none`. The default subscribes to the "problem + recovery" group only:
`down, recovered, needs-auth, failed, daemon-crash` (excluding the normal
up/stopped/daemon-up/daemon-down to avoid noise). The `generic` payload looks like
`{scope, tunnel, host, event, state, lastError, restarts, ts, machine, version}`.

## Config import / export

```bash
tunlite export > backup.json          # export config (settings + tunnels), no keys inside
tunlite import backup.json            # merge tunnels: skip same-name by default
tunlite import backup.json --force    # overwrite same-name
```

`import` **only merges tunnels**; it never touches your local settings (so it won't pull
in someone else's webhook).

## Shell completion

```bash
tunlite install completion          # auto-detect the shell (zsh/bash/fish), enable Tab completion
tunlite install completion zsh      # or specify the shell explicitly
tunlite uninstall completion        # disable
```

Bare `tunlite install` also offers to enable it during setup. Once on, it completes
subcommands; for `up/down/restart/status/logs/rm/rename` it also completes defined tunnel
names, for both `tunlite` and the short `tun`. zsh/bash append one marked line to
`~/.zshrc`/`~/.bashrc` (so `uninstall completion` can remove it precisely); fish writes to
`~/.config/fish/completions/`. Reopen the shell or `exec zsh` to take effect.

## Commands

| Command | What it does |
|---|---|
| `add local\|remote\|dynamic <name> --to user@host[:port] [--local [host:]P] [--remote [host:]P] [-i key] [--jump host] [--ssh-opt OPT] [--tag T]... [--disabled] [--no-auto-key]` | Define a tunnel (one forward; add more with `forward`) |
| `rename <old> <new>` | Rename a tunnel (hands off the live connection) |
| `set <name> [--to ...] [-i key] [--jump host] [--ssh-opt OPT] [--tag T \| --no-tags] [--auto-key\|--no-auto-key]` | Change an existing tunnel's host / key / jump / options / tags |
| `rm <name>` | Delete a tunnel (stops it too) |
| `list [--tag T]` | List defined tunnels (`--tag` filters to a label) |
| `forward list\|add\|rm <tunnel> ...` | List / add / remove a tunnel's forwards (a tunnel can carry several) |
| `up [name\|--tag T]` / `down [name\|--tag T]` / `restart [name\|--tag T]` | Control (no name/tag = all; `--tag` = every tunnel with that label) |
| `status [name\|--tag T]` | Structured status (no name = aligned table; with name = vertical detail) |
| `monitor [--interval s] [--tag T]` | Full-screen live dashboard (start/stop/restart tunnels; `--tag` filters) |
| `logs <name> [-f] [-n N]` | View / follow logs |
| `doctor [name]` | One-shot health check: why it won't connect (ssh/key/port/daemon/service) |
| `check <user@host[:port]> [-i key] [--jump host]` / `setup-key <user@host[:port]> [-i key] [--jump host]` | Probe passwordless / install your public key |
| `webhook` / `webhook set <url> [--channel C] [--events L]` / `webhook on\|off` / `webhook events <list>` / `webhook test` | Alerts: view / set / toggle / pick events / send a test (channels `generic`·`wecom`) |
| `export` / `import <file> [--force]` | Export config (JSON) / import & merge tunnels (skip same-name by default) |
| `update [version]` | Update to the latest (or a tag) and restart the daemon |
| `daemon run\|start\|stop\|status` | Daemon lifecycle (`run` = foreground, for the service to call) |
| `install [--service] [--skill user\|cwd\|<path>] [--completion] [--yes]` | Anchor the runtime (pinned-node launcher) + optionally register autostart / install skill / enable completion |
| `install service` / `install skill [--dir user\|cwd\|<path>]` / `install completion [bash\|zsh\|fish]` | Install autostart / agent skill / shell completion individually |
| `uninstall [service\|skill\|completion] [--purge]` | Uninstall (no target = everything: stop daemon + remove service + skill + completion + launcher/lib; `--purge` also drops config/state) |

**Naming convention**: name tunnels `<purpose>-<port>`, all-lowercase, hyphen-separated, no
spaces — e.g. `tmux-prod-19999`, `progress-board-4705`, `db-staging-5432`. That way
`status`/`logs` make it obvious what each one is and which port it uses.

**Forwarding model**: each `add` defines one forward; a tunnel can carry several over a single
connection — manage them with `tunlite forward list|add|rm <tunnel>`. The subcommand carries the intent:
`local` (reach a remote service from your machine), `remote` (expose a local service on the
server), `dynamic` (a local SOCKS5 proxy). **`--local` always means your machine's side and
`--remote` always means the server's side**; the subcommand decides who listens. Addresses
are `[host:]port`: the listening side's `host` is the bind address (default `127.0.0.1`,
use `0.0.0.0` to expose it), the target side's `host` is the host to connect to (default
`localhost`). When omitted: `local`'s `--local` and `remote`'s `--remote` default to the
same port as the other side; `dynamic` defaults to `1080`.

**SSH port**: this is the target host's **SSH service port** (not a forwarded port); write it
into the target — `--to user@host:2222` (same for `check` / `setup-key`). Omitted, it
defaults to **22**; given, it must be an **integer 1–65535**, otherwise it's a usage error
(`exit 2`) — it won't "silently fall back to 22 and connect to the wrong port". IPv6
literals with a port need brackets: `user@[::1]:2222`. Forward ports are validated too.

**Jump hosts**: reach a target through one or more bastions with `--jump [user@]host[:port][,...]`
(ssh `-J` / ProxyJump) on `add`, `check`, and `setup-key`. It's stored per-tunnel and used for the
auth probe too.

**Tags**: label tunnels with `--tag` (repeatable) on `add`, and edit them with `set --tag` (replaces
the set) or `set --no-tags` (clears). Then act on a whole group at once: `up`/`down`/`restart`/`status`/
`list`/`monitor` all accept `--tag <label>` to select every tunnel carrying that label (multiple
`--tag` = union). A name and `--tag` are mutually exclusive. Tags are metadata only — they never
change the ssh command. Example: `tunlite add remote api-9001 --to me@host --remote 9001 --tag prod`
then `tunlite up --tag prod`.

Add `--json` to any command for machine-readable output. Exit codes:
`0` ok · `2` usage · `3` not found · `4` needs key · `5` can't reach daemon · `1` other.

## How it works

Three roles, each with one job — think of them as **remote / engine / guard**:

| Role | What it is | Job |
|---|---|---|
| **CLI** (`tunlite …`) | the commands you type | Control tunnels (add/up/down/status/logs); edit `config.json`, talk to the daemon. Exits when done. |
| **daemon** (`tunlite daemon run`) | a long-lived background process | Actually keeps tunnels connected, reconnects on drop, serves status/logs. Tunnels live because of it. |
| **service** (`tunlite install service`) | a launchd/systemd/Task Scheduler entry | Keeps the **daemon** alive — starts it at boot, restarts it on crash. What it runs is `tunlite daemon run`. |

```
 you ── tunlite <cmd>(CLI) ──┬─ write config.json (add/rm/up/down)
                          ├─ NDJSON IPC → daemon (status/logs/restart)
                          └─ one-shot ssh (check/setup-key)

 OS service ── runs ──▶ tunlite daemon run (daemon) ──spawn──▶ ssh -N (-L/-R/-D)
   ▲ created by `install service`            │ supervise + reconnect (backoff)
   └ keeps the daemon alive                  ▼
                                     config.json ◀── reconcile on (re)start
```

`config.json` is the single source of truth. **The OS service keeps the daemon alive**, **the
daemon keeps every tunnel alive**, and on each start it reconciles running tunnels against the config.

**When does the daemon start?** Only on `tunlite up` (on demand) or `tunlite install service`
(autostart at boot + auto-restart). Other commands won't start it — if it isn't running, they
tell you how to start it. With the service installed, `tunlite daemon stop` is only temporary
(the OS brings it back); to truly stop it, run `tunlite uninstall service`.

**Day to day** you only need: `add` → `up` → `status`/`logs` → `down`, plus `install service`
once if you want autostart. You rarely type `tunlite daemon …` by hand — that's the low-level
plumbing that `up`/the service drive for you.

## For agents

Agents are a first-class user. Every command takes `--json` and returns a stable exit
code (`0/2/3/4/5/1`), so an agent acts on results without scraping prose. The
[`skill/ssh-tunnel`](skill/ssh-tunnel/SKILL.md) skill — installed with `tunlite install
skill` and bundled in the npm package — tells an agent exactly how to drive `tunlite`:
`--json`, branching on exit codes, and how to handle `needs-auth`.

## Config paths

- Config: `$XDG_CONFIG_HOME/tunlite/config.json` · `%APPDATA%\tunlite\config.json`
- State/logs: `$XDG_STATE_HOME/tunlite` · `%LOCALAPPDATA%\tunlite`
- Use `TUNLITE_HOME` to put everything under one root (handy for testing).

## Development

```bash
node --test     # run the test suite (no external dependencies)
```

Tests use a controllable fake `ssh` (`fixtures/fake-ssh.js`, injected via `TUNLITE_SSH`), so
the full lifecycle — connect, reconnect, auth failure, IPC — runs deterministically offline.

## Versioning

Follows SemVer (`vMAJOR.MINOR.PATCH`). Release notes are in [`CHANGELOG.md`](https://github.com/yuanyuanzijin/tunlite/blob/master/CHANGELOG.md);
the release process is in [`docs/VERSIONING.md`](https://github.com/yuanyuanzijin/tunlite/blob/master/docs/VERSIONING.md).

## License

MIT
