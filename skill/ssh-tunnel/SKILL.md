---
name: ssh-tunnel
description: Use when you need to create, manage, inspect, or troubleshoot SSH tunnels / port-forwards on this machine through the `tunlite` CLI — local (-L), remote (-R), or dynamic SOCKS (-D) forwards, auto-reconnecting tunnels supervised by a daemon, registering that daemon to start at login, and setting up passwordless (key-based) access to a target host. Trigger when a task says things like "forward a port over SSH", "keep an SSH tunnel alive", "open a SOCKS proxy through host X", "make a reverse tunnel", "start my tunnels on boot", or "set up passwordless SSH to host Y".
---

# Driving `tunlite` (SSH tunnel manager)

`tunlite` defines named SSH tunnels in a config file and supervises them with a
background daemon that auto-reconnects and can be registered to OS startup.
**Always pass `--json`** for machine-readable output, and **branch on the exit
code** rather than parsing prose.

## Exit codes (stable — branch on these)

| code | meaning | what to do |
|---|---|---|
| 0 | ok | continue |
| 2 | usage error | fix the command syntax |
| 3 | not found | the named tunnel/host doesn't exist |
| 4 | needs-auth | target is not passwordless — see "Passwordless" below |
| 5 | daemon unreachable | run `tunlite daemon start` (or `tunlite up` auto-starts it) |
| 1 | other error | read the JSON `error` field |

## Core workflow

```bash
# 1. Define a tunnel — one forward each. --local = your machine, --remote = the
#    server side; the subcommand picks who listens. Address is [host:]port.
tunlite add local   web-8080 --to user@host --remote 80 --local 8080 --json  # reach server's :80 locally
tunlite add dynamic px-1080  --to user@host --json                           # local SOCKS5 (default 1080)
tunlite add remote  rev-3000 --to user@host --local 3000 --remote 9000 --json # expose local 3000 on server:9000
#   SSH port rides in the target: --to user@host:2222
#   a host: prefix = bind on the listening side (0.0.0.0 to expose) / target host on the other (default localhost)
#   options: -i <keyfile>  --jump [user@]bastion[:port]  --ssh-opt "-o Foo=bar"  --tag <label>  --disabled  --no-auto-key
#   one tunnel can carry several forwards:  tunlite forward add <name> <local|remote|dynamic> ...
#   change an existing tunnel in place:     tunlite set <name> --to user@newhost --json
#   label tunnels and act on a group:       tunlite add ... --tag prod ;  tunlite up --tag prod --json

# 2. Bring it up (enables it, probes passwordless, auto-starts the daemon)
tunlite up web-8080 --json

# 3. Enumerate definitions / check structured runtime state
tunlite list --json          # defined tunnels (from config)
tunlite status --json        # {daemon:{running,pid,version,uptimeMs,uptime}, tunnels:[{name,host,state,pid,uptimeMs,uptime,restarts,lastError,forwards,tags}]}
tunlite status --tag prod --json   # filter the table to a tag (or `tunlite list --tag prod`)
tunlite status web --json

# 3b. Diagnose connection problems (ssh/keys/ports/daemon/service)
tunlite doctor --json        # {ok, summary:{ok,warn,fail}, checks:[{group,id,title,status,detail,fix}]}
tunlite doctor web-8080 --json   # focus on one tunnel

# 4. Rename / restart / take down / remove
tunlite rename web web-prod-8080 --json   # rename (cleanly hands the live tunnel over)
tunlite restart web --json                # bounce a running tunnel (no intent change)
tunlite down web --json                   # stop + disable (won't come back on reboot)
tunlite rm web --json                     # delete the definition entirely
```

`state` values: `idle`, `starting`, `connected`, `retrying`, `needs-auth`,
`failed`, `stopped`, `disabled`, `daemon-stopped`. Treat `connected` as success.
`retrying` is normal during a transient outage (the daemon backs off and reconnects).

For a live, interactive view use `tunlite monitor` (top-style; start/stop/restart by key). `status --json` remains the scriptable one-shot.

## Naming convention (use this when you create or rename tunnels)

Name tunnels **`<purpose>-<port>`, all lowercase, words hyphenated, no spaces**,
where `<port>` is the tunnel's primary port. The name should say *what it is* and
*which port*, so `status`/`logs` read self-explanatory.

- ✅ `tmux-prod-19999` · `progress-board-4705` · `db-staging-5432` · `socks-1080`
- ❌ `Tunnel1` · `MyTmux` · `progress board 4705` (spaces/caps) · `web` (no port)

Allowed characters: letters, digits, `.` `_` `-` (no spaces). To fix an existing
name, use `tunlite rename <old> <new>` rather than rm + add — it preserves the
tunnel's config and hands the live connection over cleanly.

## Passwordless

The daemon runs `ssh` non-interactively (`BatchMode=yes`), so a target that
isn't passwordless shows up as `state: "needs-auth"` and `tunlite status` exits 4.

- First check: `tunlite check user@host --json` → `{passwordless: true|false}`,
  exit 0 if already set up, 4 if not.
- To establish it: `tunlite setup-key user@host` installs your public key on the
  target. **This needs the target password typed once at an interactive
  terminal.** As an agent you usually cannot type that password, so:
  - If a human is available, ask them to run `tunlite setup-key user@host`.
  - Otherwise confirm the host is already passwordless before adding the tunnel.
- `tunlite up` will *attempt* setup automatically only when run in an interactive
  TTY with `autoSetupKey` on (the default). In non-interactive/agent contexts it
  will not prompt — it starts the tunnel and reports `needs-auth`.

## Autostart (register the daemon to OS startup)

```bash
tunlite install service --json     # launchd (macOS) / systemd --user (Linux) / Task Scheduler (Windows, beta)
tunlite status --json              # service state folded in under {service: {installed, running, ...}}
tunlite uninstall service --json   # unload the service AND remove the file it created
tunlite uninstall --json           # full teardown: stop daemon + remove service + skill + launcher/lib
tunlite uninstall --purge --json   # also delete config + logs
```

A bare interactive `tunlite uninstall` asks to confirm (and warns if tunnels are
up). `--json` already skips that prompt; `--force` skips it without `--json`.

The OS keeps the **daemon** alive; the daemon keeps the **tunnels** alive and
reconciles from the config on every (re)start, so enabled tunnels resume after
reboot/login.

Shell tab-completion (human convenience, not needed by agents): enable with
`tunlite install completion` (auto-detects the shell; or pass `bash|zsh|fish`),
remove with `tunlite uninstall completion`.

## Logs & daemon control

```bash
tunlite logs web -n 50        # last 50 lines for a tunnel
tunlite logs web -f           # follow (streams; stop by ending the process)
tunlite daemon status --json  # {running, pid, version}
tunlite daemon start|stop     # advanced/plumbing — you normally use up/down instead
```

The daemon starts only via `tunlite up` (on demand) or `tunlite install service` (at
login). Other commands won't start it; if it's down they exit `5` and tell you
how. Note: with the service installed, `tunlite daemon stop` is temporary (the OS
restarts it) — use `tunlite uninstall service` to stop for good.

## Disconnect alerts (webhook)

The daemon can POST a JSON event to a webhook on tunnel and daemon lifecycle edges.

```bash
tunlite webhook --json                                        # {url, channel, enabled, events}
tunlite webhook set https://hook/x --json                     # set + enable (channel auto-detected from URL)
tunlite webhook set https://hook/x --events tunnel,daemon-crash --json
tunlite webhook events down,recovered --json                  # change subscribed events
tunlite webhook off --json                                    # disable (use `webhook on` to re-enable)
tunlite webhook test --json                                   # POST a test event -> {ok, status}
```

Events are edge-triggered (a reconnect storm alerts once). Two scopes:
- tunnel: `up`, `down`, `recovered`, `needs-auth`, `failed`, `stopped`
- daemon: `daemon-up`, `daemon-down`, `daemon-crash`

`webhook events` accepts names, the groups `tunnel`/`daemon`, `all`, or `none`.
Default subscription: `down, recovered, needs-auth, failed, daemon-crash`.
Payload: `{scope, tunnel, host, event, state, lastError, restarts, ts, machine, version}`.

## Config import / export

```bash
tunlite export --json > backup.json     # dump config (settings + tunnels); no secrets
tunlite import backup.json --json       # merge tunnels: {added, skipped, overwritten}
tunlite import backup.json --force --json   # overwrite same-name tunnels
```

`import` merges **tunnels only** (same-name skipped unless `--force`); it never
changes local settings/alerts. A missing file exits 3; a malformed file exits 1
and leaves the current config untouched.

## Tips / gotchas

- `up`/`down` are persistent (they flip the tunnel's `enabled` flag and survive
  reboot). Use `restart` to bounce a running tunnel without changing intent.
- Omitting the name (`tunlite up`, `tunlite status`, `tunlite down`) targets **all**
  tunnels.
- Tags group tunnels: `--tag <label>` (repeatable) on `add`/`set` labels a tunnel
  (`set --no-tags` clears); `up`/`down`/`restart`/`status`/`list`/`monitor` accept
  `--tag <label>` to act on every tunnel carrying it (multiple `--tag` = union). A
  name and `--tag` are mutually exclusive (exit 2); for the one-shot commands
  (`up`/`down`/`restart`/`status`/`list`) a tag that matches nothing exits 3
  (`monitor` is a live view, so it just shows an empty dashboard instead).
  Tags are metadata only — they never change the ssh command. Each tunnel's
  `tags` array is in `list --json` / `status --json`.
- Forwards: `add local <name> --to user@host --remote [host:]P [--local [host:]P]`
  (reach a remote service locally; `--remote` required), `add remote <name> --to
  user@host --local [host:]P [--remote [host:]P]` (expose a local service on the
  server; `--local` required), `add dynamic <name> --to user@host [--local [host:]P]`
  (local SOCKS5, default 1080). `--local`/`--remote` always name your-machine /
  server-side; a `host:` is the bind address on the listening side (`0.0.0.0` to
  expose) or the target host on the other side (default `localhost`).
- A `failed` state with an "address already in use" `lastError` means the listen
  port is taken — pick another port; the daemon won't hot-loop on it.
- Relocate all state for testing/sandboxing with env vars: `TUNLITE_HOME`,
  `TUNLITE_CONFIG`, `TUNLITE_SOCKET`, `TUNLITE_SSH` (override the ssh binary).
