# Changelog

All notable changes to **tunlite** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`, tags `vX.Y.Z`,
monotonically increasing). See [docs/VERSIONING.md](docs/VERSIONING.md) for the
release process.

## [0.9.0] - 2026-06-16

### Added
- **ProxyJump / bastion support.** `--jump [user@]host[:port][,...]` on `add`,
  `check`, and `setup-key` (and a per-tunnel `jump` field) makes tunnels through a
  jump host first-class, instead of needing raw `--ssh-opt`.
- **Multiple forwards per tunnel.** `tunlite forward list|add|rm <tunnel>` manages
  several `-L`/`-R`/`-D` forwards carried over a single ssh connection.
- **Edit existing tunnels.** `tunlite set <name> [--to …] [-i key] [--jump …]
  [--ssh-opt …] [--auto-key|--no-auto-key]` changes a tunnel's connection settings
  in place (forwards stay managed by `forward`).
- **Tags / groups.** Label tunnels with `--tag <label>` (repeatable) on `add`, edit
  with `set --tag` / `set --no-tags`, then act on a whole group: `up`/`down`/
  `restart`/`status`/`list`/`monitor` accept `--tag <label>` to select every tunnel
  carrying it (multiple `--tag` = union). A name and `--tag` are mutually exclusive.
  Tags are metadata only and never change the ssh command; the `tags` array shows up
  in `list --json` / `status --json`.

### Changed
- **Dropped the `tun` npm bin alias.** `npm install -g tunlite` no longer
  force-creates a `tun` symlink (which would clobber any existing `tun` on PATH).
  The short `tun` alias is still written by `tunlite install`, and only when free.

### Fixed
- The passwordless probe behind `check` / `up` / `doctor` now applies the tunnel's
  jump hosts and ssh options, so a jump-only host is no longer misreported as not
  passwordless.
- **Reconnect backoff** now resets only after a connection has been sustained for
  `resetAfterMs` (60s), not the instant it reaches "connected". A tunnel that keeps
  dropping right after connecting backs off as intended instead of reconnecting at
  the base delay indefinitely.
- **No more double daemon.** A racing second `up` no longer unlinks a live
  daemon's control socket; a stale socket is removed only after probing that no
  daemon answers. `stop()` also reliably escalates to SIGKILL when an ssh child
  ignores SIGTERM, instead of leaving it wedged.
- **`logs` no longer truncates** — a non-follow `logs -n <N>` waits for the daemon's
  real end-of-stream instead of a fixed 200 ms window, so a large `-N` returns every
  line. An interrupted `install` also self-heals its runtime swap (restores the
  previous copy) rather than leaving no runtime behind.

### Security
- **ssh argument injection closed.** A host or jump hop beginning with `-` is
  rejected on config load, and a `--` terminator precedes the destination, so a
  crafted target can no longer be read by ssh as an option (e.g. `-oProxyCommand=…`).
- **Daemon control socket locked to the owner** — its directory is created `0700`
  and the socket `0600` on Unix, so other local users can't drive the daemon on the
  `~/.tunlite` fallback (used when `XDG_RUNTIME_DIR` is unset, e.g. on macOS).
- **Webhook URLs are redacted** in all CLI output, `--json`, daemon logs, and
  `export` (the Slack/WeCom token rides in the URL); the daemon refuses a
  non-`http(s)` webhook URL.
- **Self-update fetches over `https` or `file` only** — an `http` downgrade or a
  hostile mirror can no longer feed arbitrary code into the updater.
- **Webhook responses are capped at 8 KB** so a hostile or misbehaving endpoint
  can't stream unbounded data into the daemon process.
- **`setup-key` validates the public key** — it refuses a key containing a newline
  or a single quote before building the remote command, closing a shell-injection
  path through a crafted key comment.

## [0.8.0] - 2026-06-06

### Added
- `tunlite doctor [name]` — a read-only health report that pinpoints why a tunnel
  won't connect (ssh client/keys, target reachability/passwordless, local-port
  conflicts, daemon, autostart service, install integrity, config validity). Each
  problem prints the exact fix command. `--json` + stable exit code (1 if any
  check fails).
- **Webhook IM channels.** Alerts are now rendered per channel: `generic` (raw
  JSON, default) and `wecom` (WeCom group robot, `{msgtype:text}`),
  auto-detected from the URL (`--channel` to override). `webhook test` reads the
  response body, so a rejected message (e.g. a wecom `errcode`) is reported
  instead of a misleading HTTP 200.

### Changed
- `status` now prints an aligned table (`NAME STATE HOST TYPE ROUTE PID UP
  RESTARTS`); `status <name>` shows a vertical detail. `monitor` uses the same
  column/field set. The `status --json` shape is unchanged.
- **Breaking:** the `add` verbs are renamed to `local` / `remote` / `dynamic`
  (the old `forward` / `reverse` / `socks` are removed). Flags `--local` /
  `--remote` and stored configs are unchanged (`f.type` was already
  `local`/`remote`/`dynamic`). Update any scripts that call `tunlite add
  forward|reverse|socks`.
- **Breaking:** the alert command is now `tunlite webhook <set|on|off|status|
  events|test>` (verb subcommands, matching `daemon`/`skill`). A new `enabled`
  flag lets `webhook off`/`on` pause and resume without forgetting the URL. The
  old `tunlite alerts …` command is removed (no alias). Update any scripts that
  call it.

## [0.7.0] - 2026-06-05

### Added

- `tunlite install completion [bash|zsh|fish]` / `tunlite uninstall completion` to
  wire shell tab-completion into your shell (zsh/bash append a marked line to the
  rc file; fish writes a completions file). `tunlite install` now also offers it
  during onboarding (`--completion` / `--no-completion` / `TUNLITE_COMPLETION`).
  The raw `completion <shell>` command still exists but is now internal plumbing.

## [0.6.0] - 2026-06-05

### Changed (breaking)
- **Friendlier `add` API — intent subcommands + `:port`.** `add` now takes a
  subcommand and one forward per tunnel: `add forward <name> --to <ssh> --remote
  [host:]P [--local [host:]P]` (reach a remote service locally), `add reverse
  <name> --to <ssh> --local [host:]P [--remote [host:]P]` (expose a local service
  on the server), `add socks <name> --to <ssh> [--local [host:]P]` (default 1080).
  `--local` always names your machine, `--remote` the server side; the subcommand
  decides who listens. A `host:` prefix is the bind address on the listening side
  (`0.0.0.0` to expose) or the target host on the other (default `localhost`). The
  old `-L/-R/-D` colon-tuples are removed.
- **SSH port via the target, not `-p`.** Write `--to user@host:2222` (and `check`
  / `setup-key user@host:2222`); IPv6 literals with a port use brackets
  (`user@[::1]:2222`). `-p` is removed. `status`/`list` now show
  `forward`/`reverse`/`socks` instead of `L`/`R`/`D`.
  The stored `config.json` format is unchanged — existing tunnels load as-is.

### Added
- **Short `tun` alias** — `tunlite install` now also writes a `tun` launcher
  (equivalent to `tunlite`, for everyday typing). It won't clobber a pre-existing
  foreign `tun` on the system (it's skipped with a note), and `uninstall` only
  removes a `tun` it wrote. `tunlite` stays the canonical name.
- **Shell completion** — `tunlite completion <bash|zsh|fish>` prints a completion
  script (source it, e.g. `eval "$(tunlite completion bash)"`). Completes
  subcommands and, for name-taking verbs, live tunnel names.
- **Webhook alerts** — the daemon POSTs a JSON event on tunnel and daemon
  lifecycle edges (edge-triggered, so a reconnect storm alerts once). Tunnel
  events: `up` / `down` / `recovered` / `needs-auth` / `failed` / `stopped`;
  daemon events: `daemon-up` / `daemon-down` / `daemon-crash` (crash detected
  from a stale pidfile at the next start; `daemon-down` is delivered before the
  process exits). Manage with `tunlite alerts`,
  `tunlite alerts webhook <url> [--events <list>] | --off`,
  `tunlite alerts events <names|tunnel|daemon|all|none>`, and
  `tunlite alerts test`. Default subscription is the anomaly+recovery set
  (`down, recovered, needs-auth, failed, daemon-crash`). Pure Node `http`/`https`,
  no new dependency.
- **Config import/export** — `tunlite export` dumps the config (settings +
  tunnels) as JSON; `tunlite import <file> [--force]` merges tunnels (same-name
  skipped by default, `--force` overwrites; local settings/alerts untouched).

## [0.5.1] - 2026-06-05

### Added
- **Windows: `tunlite install` now writes the user `PATH` automatically** — the
  launcher's bin dir is persisted into the per-user `PATH` (PowerShell, user
  scope), so a newly-opened terminal finds `tunlite` without any manual env-var
  editing. The install summary prints PowerShell-correct guidance instead of the
  POSIX `export … >> ~/.profile` hint (which errored under PowerShell/cmd).

### Fixed
- **Windows: `tunlite monitor` quits instantly again** — `q`/Ctrl-C now exits in
  the same tick instead of stalling for seconds (the old resolve→await→exit path
  didn't drain promptly after raw-mode teardown), so the command no longer
  appears to hang on exit.
- **Windows: the monitor logs page renders again** — a stuck monitor used to leak
  one daemon pipe connection per tick and exhaust the named pipe, so later
  monitors couldn't fetch logs (blank page). IPC now destroys the socket on a
  failed connect, and the log tail has a timeout backstop so a missing
  stream-close can't wedge the view.

## [0.5.0] - 2026-06-05

### Changed
- **Install is now `tunlite install`** — one cross-platform command anchors the
  runtime to a stable dir with a node-pinned launcher (immune to nvm/fnm version
  switches) and, in the same run, registers autostart + the agent skill.
  Delivery is `npx`/`npm` or a thin `curl|sh` (Windows `irm|iex`) bootstrap.
- Verb-first CLI: `install [service|skill]` / `uninstall [service|skill]`; the old
  `service …` / `skill …` top-level commands are removed and their state folds
  into `tunlite status`.

### Fixed
- `tunlite update` no longer uses `npm install -g <folder>` (which symlinked the
  global command at a temp dir and then deleted it — update reported success but
  the `tunlite` command vanished). It now fetches a tarball and re-anchors.

### Removed
- `install.sh` / `install.ps1` (replaced by `tunlite install` + thin bootstraps)
  and the npm-as-install-method path.

### Migration (from 0.4.x and earlier — one-time)
- `tunlite update` **cannot** carry an older install across this change: it runs
  the *old* code, which either re-runs the now-deleted `install.sh` (script
  installs — fails) or `npm install -g <folder>` (npm installs — leaves an
  un-anchored copy that future updates refuse). Migrate by **re-installing once**:

      curl -fsSL https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.sh | sh -s -- --service
      # or:  npx "git+https://github.com/yuanyuanzijin/tunlite.git#v0.5.0" install --service
      # Windows: irm https://raw.githubusercontent.com/yuanyuanzijin/tunlite/master/bootstrap.ps1 | iex

  This re-anchors in place, removes the old npm-global `tunlite`, and rewrites the
  autostart service to the node-pinned launcher. `config.json`, tunnel definitions,
  and logs are untouched (paths are unchanged). After this one hop, `tunlite update`
  self-updates as normal.

## [0.4.0] - 2026-06-04

### Added
- `tunlite monitor` gains a per-tunnel **detail view**: press **Enter** (or **→**)
  on the selected tunnel to drill in, **Esc** (or **←**) to return. The detail
  page shows fuller status on top — state, pid, restarts, last exit code, uptime,
  host, every forward, and the last error — and that tunnel's **recent logs**
  below, refreshed each tick like `tail -f`. **↑/↓** scroll the logs: pinned to
  the newest line by default; scrolling up pauses following, scrolling back to the
  bottom resumes. Start / stop / restart still work from the detail page.

### Fixed
- `tunlite monitor` no longer flickers. Every tick used to repaint the whole
  screen, so a per-tick change (e.g. a sub-hour uptime ticking each second) redrew
  the unchanged header too and made it visibly flicker. The renderer now caches
  the last frame and rewrites only the rows that actually changed (absolutely
  positioned `\x1b[row;1H`); a resize or the first paint still does a full repaint.

## [0.3.2] - 2026-06-04

### Fixed
- `tunlite update` on an npm-installed copy no longer misreports itself as a
  source checkout and refuses to update. Install-method detection now resolves
  symlinks before comparing against `npm root -g` (so a symlinked global prefix
  like Homebrew matches), and falls back to the `<node_modules>/tunlite` layout
  when `npm` isn't on PATH.

### Changed
- README restructured to remove duplication: the three overlapping intro
  sections (30-second intro / install / quick start) collapse into one install + quickstart
  flow, the install command appears once, and the command table is the single
  complete reference.

## [0.3.1] - 2026-06-04

### Changed
- `status` and `monitor` now show a colored state indicator: the whole
  `● connected` cell (glyph + word) is colored — green connected, yellow
  starting/retrying, red needs-auth/failed, dim idle — not just the glyph. The
  daemon line is colored by overall service health (green all-good, yellow
  connecting, red down or any tunnel broken) so you can read the whole service
  at a glance, and `status` gains the glyphs it previously lacked. Color is
  suppressed off a TTY, under `NO_COLOR`, and for `--json`. The state→glyph/color
  mapping is now shared by both commands (`src/format.js`).

### Fixed
- Windows: starting a tunnel no longer pops a console window for every ssh
  connection. Each ssh child (and the detached daemon, and the `check` auth
  probe) now spawns with `windowsHide`. Previously the window stayed open for the
  life of the connection; closing it killed that `ssh.exe`, dropped the tunnel,
  and the auto-reconnect popped a fresh window.
- Windows: `tunlite monitor` no longer hangs after you quit. The console stdin
  handle isn't released by `pause()`/`unref()` on Windows (libuv reads it on a
  dedicated thread), so the command now exits explicitly once the screen is
  restored instead of waiting on a never-draining event loop.

## [0.3.0] - 2026-06-04

### Changed
- **Renamed the project `tunl` → `tunlite`** (BREAKING). The CLI command is now
  `tunlite` — run `tunlite …` instead of `tunl …`. On-disk identity moves to the
  new name: config `~/.config/tunlite`, state `~/.local/state/tunlite`, socket
  `~/.tunlite/daemon.sock`, default install dir `~/.local/share/tunlite`; the
  autostart service is `io.github.yuanyuanzijin.tunlite` (launchd) / `tunlite.service` (systemd);
  environment variables are `TUNLITE_*` (e.g. `TUNLITE_HOME`,
  `TUNLITE_FAKE_AUTOSTART`); and the package/repo is `tunlite`
  (`yuanyuanzijin/tunlite`). An existing install is **not** auto-migrated — copy
  `config.json` to the new config dir, install tunlite, start its service, then
  remove the old `tunl` service and files.
- Versioning/release docs now describe the `dev → master` flow (the
  `release/vX.Y.Z` branch is gone).

## [0.2.0] - 2026-06-04

### Added
- `tunlite update [version]` — self-update to the latest release (or a specific
  tag; older tags roll back). Restarts the daemon by default to load new code;
  `--no-restart` to skip, `--check` to only report, `--force` to reinstall.
- `tunlite monitor` (alias `mon`): interactive top-style live dashboard — shows daemon
  status + a color-coded tunnel table and acts on the selected tunnel
  (start / stop / restart, with a `y/N` confirm on stop and restart). Pure Node,
  zero dependencies; `--interval <s>` sets the refresh rate.

### Changed
- Default install no longer pins `#v0.1.0`; the documented command tracks the
  latest release (pin a tag only when you want a specific version).
- CLI now rejects unknown flags with a usage error instead of silently treating
  them as `true`.
- Internal: unified port validation (`config.isValidPort`), single version
  source (`src/version.js`), extracted skill helpers (`src/skill.js`) and
  `Daemon._spawnSupervisor`.

### Fixed
- Supervisor connect-path no longer runs a port probe whose result was discarded;
  it now serves as a health-hint log line.

## [0.1.1] - 2026-06-03

### Added
- `install.sh` / `install.ps1` now also prompt **"register tunlite to start on login
  (autostart the daemon)?"** alongside the existing skill prompt, so a guided
  install can set up autostart in one go. Scriptable via `TUNLITE_SERVICE=yes|no`
  (or `--no-service` / `-NoService`); `tunlite service install` still does the same
  thing by hand. (`npm install -g` stays CLI-only and non-interactive by design —
  run `tunlite service install` / `tunlite skill install` after it if you want them.)

### Changed
- `-p <port>` (the target's SSH port, on `add` / `check` / `setup-key`) is now
  validated: it must be an integer 1–65535, otherwise the command fails with a
  usage error (`exit 2`) instead of silently falling back to 22 and connecting to
  the wrong port. Absent `-p` still defaults to 22. (Forward ports in `-L/-R/-D`
  were already validated.)

### Fixed
- `tunlite check` / `tunlite up` no longer hang on a tunnel-only (forced-command) host
  such as a reverse-tunnel account that authenticates but refuses to run a remote
  command and holds the session open. `probeAuth` now reads `ssh -v` and decides
  from the auth-phase signal instead of how the session ends: an
  "Authenticated to …" line returns **passwordless OK in well under a second**
  (flagged `restricted` when the command can't run), an auth-denial line returns
  not-ok immediately. A hard wall-clock budget over the whole exchange (not just
  `ConnectTimeout`, which only bounds TCP setup) plus `ServerAliveInterval`/
  `CountMax` remain as a safety net for a host that neither authenticates nor
  fails. Previously such a host either hung forever or, with the first fix, paid
  the full ~12s timeout. `check --json` gains `restricted` / `timedOut`.

## [0.1.0] - 2026-06-03

First public release.

### Added
- Cross-platform SSH tunnel manager, zero runtime dependencies (Node stdlib).
- CLI with `--json` on every command and stable exit codes
  (`0` ok · `2` usage · `3` not-found · `4` needs-auth · `5` daemon-unreachable
  · `1` error): `add` / `rename` / `rm` / `list` / `up` / `down` / `restart` /
  `status` / `logs` / `check` / `setup-key` / `daemon` / `service` / `skill` /
  `uninstall`.
- Forward modes: local `-L`, remote `-R`, dynamic SOCKS `-D`.
- Supervisor daemon: one `ssh` child per tunnel, state machine, exponential
  backoff + jitter reconnect, keepalive, and local-port health probing.
  `config.json` is the source of truth, reconciled on (re)start (with a brief
  start delay so a rename/replace doesn't race a freed remote port).
- OS autostart: launchd (macOS), systemd user service (Linux), Task Scheduler
  (Windows) — `service install|uninstall|status`.
- Passwordless setup: connect directly when passwordless works; install the key only when
  it doesn't (`check` / `setup-key`; `up` offers it interactively).
- `tunlite rename` for clean live-connection handover; naming convention
  `<purpose>-<port>` (lowercase, hyphenated).
- Companion agent skill (`skill/ssh-tunnel`): project-scoped auto-load via
  `.claude/skills`, plus `tunlite skill install [--dir user|cwd|<path>]` to install
  it into a Claude Code skills dir.
- Installers: `install.sh` / `install.ps1` copy tunlite into a stable location
  (location-independent after install) and prompt whether/where to install the
  skill; `tunlite uninstall [--purge]` is a full, reversible teardown (daemon +
  service + skill, optionally config/state).
- Robustness: IPC requests are fully time-bounded (never hang on a down/wedged
  daemon — commands fail fast with guidance); benign ssh stderr (TCP_NODELAY,
  post-quantum warning) is not surfaced as an error; tests are sandboxed and
  never touch the real launchd/systemd.
- Docs: README, 30-second quickstart, install & validation checklist, design
  spec, and this changelog + versioning policy.

[0.9.0]: https://github.com/yuanyuanzijin/tunlite/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/yuanyuanzijin/tunlite/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/yuanyuanzijin/tunlite/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/yuanyuanzijin/tunlite/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/yuanyuanzijin/tunlite/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/yuanyuanzijin/tunlite/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/yuanyuanzijin/tunlite/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/yuanyuanzijin/tunlite/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/yuanyuanzijin/tunlite/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yuanyuanzijin/tunlite/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yuanyuanzijin/tunlite/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/yuanyuanzijin/tunlite/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yuanyuanzijin/tunlite/releases/tag/v0.1.0
