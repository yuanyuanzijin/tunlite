# Changelog

All notable changes to **tunlite** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`, tags `vX.Y.Z`,
monotonically increasing). See [docs/VERSIONING.md](docs/VERSIONING.md) for the
release process.

> tunlite debuted publicly at **0.9.0**. Earlier `0.x` releases were a private
> prototype and are not part of this public history.

## [0.9.4] - 2026-06-18

### Fixed
- **`logs <name>` now exits not-found (`3`) for an unknown tunnel** instead of
  silently tailing an empty channel and exiting `0` — it was the only
  name-taking command that didn't honor the not-found contract, so an agent
  probing `tunlite logs typo --json` read it as "succeeded, no logs". A bare
  `logs` with no name still tails the daemon's own log.
- **`add` refuses a duplicate name (exit `2`) instead of silently overwriting.**
  It used to upsert, so re-adding an existing name replaced the prior definition
  and exited `0` — quiet data loss. Use `set <name> …` to change a tunnel in place
  or `rm <name>` first. An invalid tunnel name is now a usage error (`2`) too,
  rather than bubbling up as a generic error (`1`).
- **`list` / `status` with a `--tag` that matches nothing now exit not-found (`3`)**,
  matching `up`/`down`/`restart` and the documented tag contract. `list` returned
  `0` and `status` returned `0` (daemon up) or even `5` (daemon down); the tag is
  now checked against config up front, so the answer is a consistent `3` either way.
  (`monitor` is a live dashboard, so it shows an empty view rather than exiting.)
- **Anchored-install detection is now symlink-tolerant.** `isAnchored()` compared
  the manifest's literal `libDir` against the realpath-resolved running directory,
  so when the install dir was reached through a symlink — `/home` → `/var/home` on
  Fedora Silverblue/CoreOS/openSUSE MicroOS, or `/tmp` → `/private/tmp` on macOS —
  a correct install reported un-anchored forever: the "run `tunlite install`" nudge
  never cleared and `tunlite update` refused to self-update. It now compares
  canonical paths on both sides.
- **`status <name> --json` now exits not-found (`3`) for an unknown tunnel**,
  matching the human path. It returned the full snapshot with an empty
  `tunnels[]` and exit `0`, so an agent couldn't tell "doesn't exist" from
  "exists" by exit code; it now emits `{error, code: 3}` and exits `3`.
- **`<command> --help` / `-h` now prints help and exits `0` for every command**,
  as the README promises. Previously only the bare command position honored it;
  placed after a verb (`tunlite status --help`) it fell through and was rejected
  as an unknown option — and `tunlite export --help` ignored the flag and dumped
  the config. `-h`/`--help` are not real flags on any command, so they are now
  intercepted globally.

## [0.9.3] - 2026-06-17

### Added
- **`uninstall` now confirms before tearing everything down**, and warns when
  tunnels are currently up (counted from the daemon), so you can't wipe a live
  setup by reflex. `--force` skips the prompt; `--json` and non-interactive runs
  proceed unprompted as before.

### Changed
- **`tunlite update` upgrades to the latest published *release tag*, not the
  branch tip.** It resolves the newest `vX.Y.Z` tag and re-anchors that, so a
  self-update can only ever land on a real released version (which, by release
  discipline, is also on npm) — the installed version can no longer drift onto an
  unreleased commit, and `npm`'s view can't diverge from what's actually running.
- **`update` refuses a non-anchored install with the right per-channel guidance:**
  a git checkout → `git pull`; an `npm i -g` install → `npm i -g tunlite@latest`
  (so that channel's version metadata stays authoritative); anything else → re-run
  `npx tunlite install`.

### Docs
- Slimmed the README (EN/ZH) to a concise landing that points to the documentation
  site for the deep reference; trimmed this changelog to the public era (0.9.0+);
  de-duplicated the quickstart — `install service` is optional autostart that also
  brings tunnels up, so it no longer reads as a step after `up`.

## [0.9.2] - 2026-06-17

### Fixed
- **Too-old Node now fails fast with a clear message instead of a cryptic
  crash.** Running under Node < 18 (e.g. an old `nvm` default) let `install`
  print success and then throw a `SyntaxError` from a module using newer syntax,
  with no hint why. The entry point now checks the Node version first — before
  requiring any modern module — and exits with `tunlite requires Node.js >= 18 …`
  plus the `nvm install 18` fix. The guard lives in a small ES5-only
  `src/node-check.js` so it parses on any runtime.
- **`curl … | sh` now prompts instead of silently skipping setup.** Piped into a
  shell the installer's stdin carries the script, so the interactive service /
  skill / completion questions were skipped — nothing got registered and the
  daemon never started, making it look like `install` hadn't run. `confirm()`
  now reads the answer from the controlling terminal (`/dev/tty`) when stdin is
  piped, so the one-liner asks the same y/N questions as a direct run (pre-answer
  with `--service` / `--no-skill` / … to stay non-interactive). Both bootstraps
  also verify Node ≥ 18 up front. On Windows (no `/dev/tty`) the bootstrap
  registers autostart by default; the skill and completion stay opt-in.

## [0.9.1] - 2026-06-16

### Fixed
- **`install` confirmation prompts were invisible on a real terminal.** The
  prompt was written separately and then readline opened with an empty query;
  in terminal mode readline's line refresh erased the just-written text, leaving
  a blank line where the question should be (you had to answer blind). The
  prompt is now rendered by readline itself, so it always shows.

## [0.9.0] - 2026-06-16

First public release.

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

[0.9.3]: https://github.com/yuanyuanzijin/tunlite/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/yuanyuanzijin/tunlite/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/yuanyuanzijin/tunlite/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/yuanyuanzijin/tunlite/releases/tag/v0.9.0
