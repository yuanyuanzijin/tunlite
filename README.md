# tunlite

**English** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/yuanyuanzijin/tunlite/actions/workflows/ci.yml/badge.svg)](https://github.com/yuanyuanzijin/tunlite/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tunlite)](https://www.npmjs.com/package/tunlite)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A lightweight, cross-platform **SSH tunnel manager** — the one CLI that replaces
*autossh + a systemd unit per tunnel + a scratchpad of `-L`/`-R`/`-D` flags*. Define
named tunnels once; a tiny **zero-dependency** daemon keeps them connected, restarts
them at login, and sets up passwordless access. Every command speaks **`--json`** with
stable exit codes, so **AI agents drive it as easily as you do**.

> 📖 **Full documentation → [yuanyuanzijin.github.io/tunlite](https://yuanyuanzijin.github.io/tunlite/)**

- **Agent-native** — `--json` on every command, stable exit codes, a bundled agent skill.
- **Zero third-party dependencies** — pure Node.js standard library; all it needs on the box is **Node ≥ 18** and the system `ssh` it wraps.
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

Prerequisite: **Node ≥ 18** and the system `ssh`, both on your PATH.

```bash
# Recommended — fetch + anchor (no global npm needed)
npx tunlite install

# Or a curl one-liner (just curl/wget + tar + node)
curl -fsSL https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.sh | sh

# Windows (PowerShell) — beta
irm https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.ps1 | iex
```

`tunlite install` copies the runtime to a fixed directory and writes a launcher that
**pins node's absolute path** (so switching nvm/fnm versions won't break it), then asks
whether to register login autostart, install the agent skill, and enable shell
completion. It also writes a short `tun` alias when that name is free. **Windows
(autostart, launcher, PATH) is beta** — macOS/Linux are the CI-tested platforms.

## Quick start

```bash
# --local = your machine's side, --remote = the server's side; the subcommand decides who listens.
tunlite add local   web-8080 --to user@server --remote 80 --local 8080   # reach server's :80 at localhost:8080
tunlite add dynamic px-1080  --to user@server                            # SOCKS5 proxy (local 1080)
tunlite add remote  rev-9000 --to user@server --local 3000 --remote 9000 # expose local 3000 as server:9000

tunlite up                 # start everything now (brings up the daemon; configures keys if needed)
tunlite status             # aligned table: NAME STATE HOST TYPE ROUTE PID UP RESTARTS
tunlite logs web-8080 -f   # follow logs
tunlite doctor             # health check: why a tunnel won't connect
```

When the target isn't passwordless yet, running `tunlite up` in a terminal prompts for
the password once and installs your key. Or do it explicitly: `tunlite check user@server`
(exit 0 = already passwordless) / `tunlite setup-key user@server`.

**Autostart (optional):** `tunlite install service` registers the daemon to start at
login (and restart on crash). It also starts everything right away, so it *replaces* `up`
when you want tunnels up persistently — you don't need both.

## Update

```sh
tunlite update              # upgrade to the latest (restarts the daemon; tunnels blip ~1s)
tunlite update v0.9.0       # install / roll back to a specific tag
tunlite update --check      # compare current vs latest only; change nothing
```

`update` upgrades to the **latest release tag** — it fetches that tag's tarball from GitHub
and re-anchors in place (**no npm, no git**), so `npx` installs the first copy and `update`
keeps it current at a real published version. It only self-updates an anchored install: from
a git checkout it points you to `git pull`, and from an `npm i -g` install to
`npm i -g tunlite@latest` (so that channel's version stays authoritative).

## Commands

```
add local|remote|dynamic   define a tunnel        set / rm / rename     edit / delete / rename
forward list|add|rm        forwards per tunnel    list [--tag T]        list tunnels
up / down / restart        control (name|--tag|all)
status / logs / monitor    inspect (table · follow · live dashboard)
doctor                     why a tunnel won't connect
check / setup-key          probe / install passwordless access
webhook …                  drop alerts to a webhook (generic · WeCom)
export / import            back up / merge tunnels
install [service|skill|completion] / uninstall      anchor runtime · autostart · agent skill · Tab-completion
update                     self-update from GitHub
```

Run `tunlite help` or any command with `--help` for full flags, or see the
[documentation](https://yuanyuanzijin.github.io/tunlite/) for jump hosts (`--jump`),
tags (`--tag`), the webhook channels/events, and shell completion.

**Forwarding model:** each `add` defines one forward (a tunnel can carry several via
`forward add`). `--local` always means *your* side, `--remote` the *server's* side; the
subcommand picks who listens — `local` (reach a remote service locally), `remote` (expose
a local service on the server), `dynamic` (a local SOCKS5 proxy). The SSH port goes on the
target (`--to user@host:2222`, default 22).

**Exit codes** (add `--json` to any command): `0` ok · `2` usage · `3` not found ·
`4` needs key · `5` can't reach daemon · `1` other.

## How it works

Three roles, each with one job:

| Role | What it is | Job |
|---|---|---|
| **CLI** (`tunlite …`) | the commands you type | Edit `config.json`, talk to the daemon, run one-shot ssh. Exits when done. |
| **daemon** (`tunlite daemon run`) | a background process | Keeps tunnels connected, reconnects on drop, serves status/logs. |
| **service** (`install service`) | a launchd/systemd/Task Scheduler entry | Keeps the **daemon** alive — starts it at boot, restarts on crash. |

`config.json` is the single source of truth. The OS service keeps the daemon alive, the
daemon keeps every tunnel alive. Day to day you only need `add` → `up` → `status`/`logs`,
plus `install service` once for autostart.

## For agents

Agents are a first-class user: every command takes `--json` and returns a stable exit
code, so an agent acts on results without scraping prose. The bundled
[`skill/ssh-tunnel`](skill/ssh-tunnel/SKILL.md) (installed by `tunlite install skill`)
tells an agent exactly how to drive `tunlite` — `--json`, branching on exit codes, and
handling `needs-auth`.

## Versioning & license

SemVer (`vMAJOR.MINOR.PATCH`); release notes in [`CHANGELOG.md`](https://github.com/yuanyuanzijin/tunlite/blob/master/CHANGELOG.md).
MIT.
