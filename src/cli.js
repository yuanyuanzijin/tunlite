'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const paths = require('./paths');
const ssh = require('./ssh');
const ipc = require('./ipc');
const autostart = require('./autostart');
const skillmod = require('./skill');
const installer = require('./install');
const { formatDuration, serviceHealth, colorize, renderTunnelTable, tunnelDetailRows, forwardTypes, forwardRoutes, checkStyle } = require('./format');
const monitormod = require('./monitor');
const completionmod = require('./completion');
const doctormod = require('./doctor');
const { EXIT, parseFlags, jsonOut, line, errline, isInteractive, printDaemonDown, pad } = require('./cli-core');
const { daemonPing, ensureDaemon, archiveFetch, resolveLatestTag, restartDaemonProcess, renderUpdate } = require('./daemon-control');
const { selectTunnels, tunnelsByTag, resolveSelection, reloadIfRunning } = require('./selection');
const forwardCmd = require('./commands/forward');
const { buildForward } = forwardCmd;
const webhookCmd = require('./commands/webhook');
const { redactAlerts } = webhookCmd;
const installCmd = require('./commands/install');

const { VERSION } = require('./version');

// Gather the unified { daemon, tunnels } status shape (shared by `status` and `monitor`).
async function gatherStatus(name, opts) {
  const ping = await daemonPing();
  let rows;
  if (ping) {
    rows = await ipc.request(paths.socketPath(), 'status', { name });
  } else {
    const cfg = config.load(opts.configFile);
    rows = selectTunnels(cfg, name).map((t) => ({
      name: t.name, host: t.host,
      port: t.port, identityFile: t.identityFile,
      sshOptions: t.sshOptions, jump: t.jump, tags: t.tags,
      enabled: t.enabled, autoSetupKey: t.autoSetupKey,
      state: 'daemon-stopped', pid: null,
      restarts: 0, uptimeMs: 0, lastError: null, forwards: t.forwards,
    }));
  }
  const tunnels = rows.map((r) => ({ ...r, uptime: r.uptimeMs ? formatDuration(r.uptimeMs) : null }));
  const daemon = ping
    ? { running: true, pid: ping.pid, version: ping.version, uptimeMs: ping.uptimeMs, uptime: formatDuration(ping.uptimeMs) }
    : { running: false };
  // Surface the env root (so the monitor shows whether this is a dev sandbox or
  // the system install) and where config lives. TUNLITE_HOME drives everything.
  const pathsInfo = { home: process.env.TUNLITE_HOME || null, config: paths.configFile() };
  return { daemon, tunnels, paths: pathsInfo };
}

// ---- commands -----------------------------------------------------------
const commands = {
  // add <local|remote|dynamic> <name> --to user@host[:port] ...
  //   local   --remote [host:]PORT [--local [host:]PORT]   (reach a remote service locally)
  //   remote  --local  [host:]PORT [--remote [host:]PORT]  (expose a local service on the server)
  //   dynamic [--local [host:]PORT]                        (local SOCKS5; default 1080)
  async add(args, io, opts) {
    const sub = args[0];
    if (!['local', 'remote', 'dynamic'].includes(sub)) {
      errline(io, 'usage: tunlite add <local|remote|dynamic> <name> --to user@host[:port] ...');
      return EXIT.USAGE;
    }
    const { flags, positionals } = parseFlags(args.slice(1), {
      value: ['--to', '--local', '--remote', '-i', '--jump'],
      repeat: ['--ssh-opt', '--tag'],
      bool: ['--disabled', '--no-auto-key'],
    });
    const name = positionals[0];
    const targetRaw = flags['--to'] || positionals[1];
    if (!name || !targetRaw) { errline(io, `usage: tunlite add ${sub} <name> --to user@host[:port] ...`); return EXIT.USAGE; }

    let target, forward, jump, tags;
    try {
      target = config.parseTarget(targetRaw);
      forward = buildForward(sub, flags);
      jump = config.parseJump(flags['--jump']);
      tags = config.parseTags(flags['--tag']);
    } catch (e) { errline(io, e.message); return EXIT.USAGE; }

    const tunnel = {
      name, host: target.host,
      port: target.port || 22,
      identityFile: flags['-i'] || null,
      jump,
      tags,
      forwards: [forward],
      sshOptions: flags['--ssh-opt'] || [],
      enabled: !flags['--disabled'],
      autoSetupKey: !flags['--no-auto-key'],
    };
    const cfg = config.load(opts.configFile);
    // Refuse to clobber an existing tunnel. `add` used to upsert, so re-adding a
    // name silently overwrote the prior definition (exit 0, data loss); steer to
    // `set` (change in place) or `rm` first — mirrors rename's conflict guard.
    if (config.findTunnel(cfg, name)) {
      errline(io, `a tunnel named "${name}" already exists (use \`tunlite set ${name} ...\` to change it, or \`tunlite rm ${name}\` first)`);
      return EXIT.USAGE;
    }
    // The name is validated inside upsertTunnel; a bad name is a usage error (2),
    // not an uncaught throw bubbling up as a generic error (1) — matches rename.
    let v;
    try { v = config.upsertTunnel(cfg, tunnel); }
    catch (e) { errline(io, e.message); return EXIT.USAGE; }
    config.save(cfg, opts.configFile);
    const reloaded = await reloadIfRunning();
    if (opts.json) { jsonOut(io, { ...v, daemonRunning: reloaded }); return EXIT.OK; }
    line(io, `added "${name}" -> ${target.host}  [${forwardTypes(v)} ${forwardRoutes(v)}]`);
    if (!reloaded && v.enabled) {
      line(io, 'daemon not running — start it to bring this tunnel up:  tunlite up   (or: tunlite daemon start / tunlite install service)');
    }
    return EXIT.OK;
  },

  async rm(args, io, opts) {
    const { positionals } = parseFlags(args);
    const name = positionals[0];
    if (!name) { errline(io, 'usage: tunlite rm <name>'); return EXIT.USAGE; }
    const cfg = config.load(opts.configFile);
    if (!config.removeTunnel(cfg, name)) {
      errline(io, `no such tunnel: ${name}`); return EXIT.NOTFOUND;
    }
    config.save(cfg, opts.configFile);
    await reloadIfRunning(); // daemon reconcile stops the removed tunnel
    if (opts.json) { jsonOut(io, { removed: name }); return EXIT.OK; }
    line(io, `removed "${name}"`);
    return EXIT.OK;
  },

  async rename(args, io, opts) {
    const { positionals } = parseFlags(args);
    const [oldName, newName] = positionals;
    if (!oldName || !newName) { errline(io, 'usage: tunlite rename <old> <new>'); return EXIT.USAGE; }
    if (oldName === newName) { line(io, 'name unchanged'); return EXIT.OK; }
    const cfg = config.load(opts.configFile);
    const t = config.findTunnel(cfg, oldName);
    if (!t) { errline(io, `no such tunnel: ${oldName}`); return EXIT.NOTFOUND; }
    if (config.findTunnel(cfg, newName)) { errline(io, `a tunnel named "${newName}" already exists`); return EXIT.USAGE; }
    let renamed;
    try { renamed = config.validateTunnel({ ...t, name: newName }); }
    catch (e) { errline(io, `invalid name "${newName}": ${e.message}`); return EXIT.USAGE; }
    config.removeTunnel(cfg, oldName);
    config.upsertTunnel(cfg, renamed);
    config.save(cfg, opts.configFile);
    // The daemon reconcile stops the old-named supervisor and starts the new one;
    // its built-in start delay covers the freed remote port.
    const reloaded = await reloadIfRunning();
    if (opts.json) { jsonOut(io, { from: oldName, to: newName, daemonRunning: reloaded }); return EXIT.OK; }
    line(io, `renamed "${oldName}" -> "${newName}"`);
    if (!reloaded && renamed.enabled) line(io, 'daemon not running — start it with:  tunlite up');
    return EXIT.OK;
  },

  // set <name> [--to ...] [-i key] [--jump ...] [--ssh-opt OPT] [--auto-key|--no-auto-key]
  //   change an existing tunnel's connection settings (host/port/key/jump/options).
  //   Forwards are managed separately via `forward`.
  async set(args, io, opts) {
    const { flags, positionals } = parseFlags(args, {
      value: ['--to', '-i', '--jump'],
      repeat: ['--ssh-opt', '--tag'],
      bool: ['--auto-key', '--no-auto-key', '--no-tags'],
    });
    const name = positionals[0];
    if (!name) { errline(io, 'usage: tunlite set <name> [--to user@host[:port]] [-i key] [--jump host] [--ssh-opt OPT] [--tag T | --no-tags] [--auto-key|--no-auto-key]'); return EXIT.USAGE; }
    const cfg = config.load(opts.configFile);
    const t = config.findTunnel(cfg, name);
    if (!t) { errline(io, `no such tunnel: ${name}`); return EXIT.NOTFOUND; }

    const changed = [];
    try {
      if (flags['--to'] !== undefined) { const tg = config.parseTarget(flags['--to']); t.host = tg.host; t.port = tg.port || 22; changed.push('host'); }
      if (flags['-i'] !== undefined) { t.identityFile = flags['-i'] || null; changed.push('identity'); }
      if (flags['--jump'] !== undefined) { t.jump = config.parseJump(flags['--jump']); changed.push('jump'); }
      if (flags['--ssh-opt'] !== undefined) { t.sshOptions = flags['--ssh-opt']; changed.push('ssh-opt'); }
      if (flags['--no-tags']) { t.tags = []; changed.push('tags'); }
      else if (flags['--tag'] !== undefined) { t.tags = config.parseTags(flags['--tag']); changed.push('tags'); }
      if (flags['--no-auto-key']) { t.autoSetupKey = false; changed.push('auto-key'); }
      else if (flags['--auto-key']) { t.autoSetupKey = true; changed.push('auto-key'); }
    } catch (e) { errline(io, e.message); return EXIT.USAGE; }

    if (changed.length === 0) { errline(io, 'nothing to set — pass one of --to / -i / --jump / --ssh-opt / --tag / --no-tags / --auto-key / --no-auto-key'); return EXIT.USAGE; }

    let v;
    try { v = config.upsertTunnel(cfg, t); } catch (e) { errline(io, e.message); return EXIT.USAGE; }
    config.save(cfg, opts.configFile);
    const reloaded = await reloadIfRunning();
    if (opts.json) { jsonOut(io, { ...v, daemonRunning: reloaded }); return EXIT.OK; }
    line(io, `"${name}": updated ${changed.join(', ')}${reloaded ? '' : '   (daemon not running)'}`);
    return EXIT.OK;
  },

  async list(args, io, opts) {
    const { flags } = parseFlags(args, { repeat: ['--tag'] });
    const cfg = config.load(opts.configFile);
    let tags;
    try { tags = config.parseTags(flags['--tag']); } catch (e) { errline(io, e.message); return EXIT.USAGE; }
    const tunnels = tags.length ? tunnelsByTag(cfg, tags) : cfg.tunnels;
    // An explicit --tag that matches nothing is not-found (3), consistent with
    // up/down/restart/status (the documented tag contract).
    if (tags.length && tunnels.length === 0) {
      const msg = `no tunnels tagged ${tags.map((x) => `"${x}"`).join(', ')}`;
      if (opts.json) jsonOut(io, { error: msg, code: EXIT.NOTFOUND });
      else errline(io, msg);
      return EXIT.NOTFOUND;
    }
    if (opts.json) { jsonOut(io, tunnels); return EXIT.OK; }
    if (tunnels.length === 0) {
      line(io, 'no tunnels defined. add one with: tunlite add <name> --to user@host -L ...');
      return EXIT.OK;
    }
    for (const t of tunnels) {
      const mark = t.enabled ? '' : ' (disabled)';
      const tagStr = (t.tags && t.tags.length) ? `\t[${t.tags.join(',')}]` : '';
      line(io, `${t.name}${mark}\t${t.host}\t${forwardTypes(t)} ${forwardRoutes(t)}${tagStr}`);
    }
    return EXIT.OK;
  },

  // forward add|rm|list <tunnel> ... — manage a tunnel's forwards (one tunnel can
  // carry several -L/-R/-D over a single ssh connection).
  forward: forwardCmd.forward,

  async up(args, io, opts) {
    const { flags, positionals } = parseFlags(args, { repeat: ['--tag'] });
    const cfg = config.load(opts.configFile);
    const sel = resolveSelection(cfg, positionals[0], flags['--tag']);
    if (sel.error) { errline(io, sel.error); return sel.code; }
    const targets = sel.targets;
    if (targets.length === 0) { errline(io, 'no tunnels defined'); return EXIT.NOTFOUND; }
    for (const t of targets) t.enabled = true;
    config.save(cfg, opts.configFile);

    // Passwordless probe / setup before handing off to the daemon.
    for (const t of targets) {
      const probe = await ssh.probeAuth(t.host, { port: t.port, identityFile: t.identityFile, jump: t.jump, sshOptions: t.sshOptions });
      if (probe.ok) continue;
      if (t.autoSetupKey && isInteractive()) {
        line(io, `"${t.name}": ${t.host} is not passwordless yet — setting up key (you'll be asked for the password once)...`);
        const res = ssh.setupKey(t.host, { port: t.port, identityFile: t.identityFile, jump: t.jump });
        const re = await ssh.probeAuth(t.host, { port: t.port, identityFile: t.identityFile, jump: t.jump, sshOptions: t.sshOptions });
        if (!re.ok) errline(io, `"${t.name}": key setup did not verify (${res.method}); the daemon will report needs-auth.`);
        else line(io, `"${t.name}": passwordless access established.`);
      } else {
        errline(io, `"${t.name}": not passwordless. Run \`tunlite setup-key ${t.host}\` (needs a password). Daemon will show needs-auth.`);
      }
    }

    await ensureDaemon(io);
    await ipc.request(paths.socketPath(), 'reload', {});
    const statusArgs = sel.tags.length ? sel.tags.flatMap((x) => ['--tag', x]) : [positionals[0]].filter(Boolean);
    return commands.status(statusArgs, io, opts);
  },

  async down(args, io, opts) {
    const { flags, positionals } = parseFlags(args, { repeat: ['--tag'] });
    const cfg = config.load(opts.configFile);
    const sel = resolveSelection(cfg, positionals[0], flags['--tag']);
    if (sel.error) { errline(io, sel.error); return sel.code; }
    const targets = sel.targets;
    for (const t of targets) t.enabled = false;
    config.save(cfg, opts.configFile);
    await reloadIfRunning();
    if (opts.json) { jsonOut(io, { down: targets.map((t) => t.name) }); return EXIT.OK; }
    line(io, `stopped: ${targets.map((t) => t.name).join(', ') || '(none)'}`);
    return EXIT.OK;
  },

  async restart(args, io, opts) {
    const { flags, positionals } = parseFlags(args, { repeat: ['--tag'] });
    // Resolve a tag selection to concrete names from config (the restart IPC
    // takes names); a bare name or nothing keeps the prior behavior. No name and
    // no --tag restarts all.
    let names;
    if (flags['--tag'] !== undefined || positionals[0]) {
      const cfg = config.load(opts.configFile);
      const sel = resolveSelection(cfg, positionals[0], flags['--tag']);
      if (sel.error) { errline(io, sel.error); return sel.code; }
      names = sel.targets.map((t) => t.name);
    } else {
      names = [];
    }
    const ping = await daemonPing();
    if (!ping) return commands.up(args, io, opts);
    const res = await ipc.request(paths.socketPath(), 'restart', { names });
    if (opts.json) { jsonOut(io, res); return EXIT.OK; }
    line(io, `restarted: ${res.restarted.join(', ') || '(all)'}`);
    return EXIT.OK;
  },

  async status(args, io, opts) {
    const { flags, positionals } = parseFlags(args, { repeat: ['--tag'] });
    const name = positionals[0];
    let tags;
    try { tags = config.parseTags(flags['--tag']); } catch (e) { errline(io, e.message); return EXIT.USAGE; }
    if (tags.length && name) { errline(io, 'give a tunnel name or --tag, not both'); return EXIT.USAGE; }
    // An explicit --tag that matches nothing in config is not-found (3) — checked
    // against config up front so the answer is the same whether or not the daemon
    // is up (otherwise a down daemon would mask it as daemon-unreachable, 5).
    if (tags.length && !tunnelsByTag(config.load(opts.configFile), tags).length) {
      const msg = `no tunnels tagged ${tags.map((x) => `"${x}"`).join(', ')}`;
      if (opts.json) jsonOut(io, { error: msg, code: EXIT.NOTFOUND });
      else errline(io, msg);
      return EXIT.NOTFOUND;
    }
    // Tag selection gathers everything and filters here (the daemon status IPC
    // only knows names); a plain name still filters at the source.
    const gathered = await gatherStatus(tags.length ? undefined : name, opts);
    const daemon = gathered.daemon;
    let tunnels = gathered.tunnels;
    if (tags.length) {
      const want = new Set(tags);
      tunnels = tunnels.filter((t) => (t.tags || []).some((x) => want.has(x)));
    }
    const ping = daemon.running;

    let service = { installed: false, running: false };
    try { service = autostart.adapterFor().status(autostart.context()); } catch (_) {}
    const skillRows = skillmod.readManifest().map((d) => ({ path: d, present: fs.existsSync(path.join(d, 'SKILL.md')) }));
    const skill = { installed: skillRows.some((r) => r.present), entries: skillRows };

    // A named tunnel that doesn't exist is not-found in BOTH modes. The human
    // detail path checked this below; --json returned the full snapshot with an
    // empty tunnels[] and exit 0, so an agent doing `status <name> --json` could
    // not tell "doesn't exist" from "exists" by exit code. Check before the json
    // return so the contract holds in either mode. (A --tag matching nothing is
    // an empty list, not not-found — unchanged.)
    if (name && tunnels.length === 0) {
      if (opts.json) jsonOut(io, { error: `no such tunnel: ${name}`, code: EXIT.NOTFOUND });
      else errline(io, `no such tunnel: ${name}`);
      return EXIT.NOTFOUND;
    }

    if (opts.json) { jsonOut(io, { daemon, tunnels, service, skill }); return EXIT.OK; }

    const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

    // Single-tunnel vertical detail.
    if (name) {
      const tdet = tunnels[0];
      line(io, `${tdet.name}`);
      for (const [label, value, vcolor] of tunnelDetailRows(tdet)) {
        line(io, `  ${pad(label, 9)} ${vcolor ? colorize(value, vcolor, useColor) : value}`);
      }
      if (!ping) { line(io, ''); printDaemonDown(io); return EXIT.DAEMON; }
      return tdet.state === 'needs-auth' ? EXIT.NEEDS_AUTH : EXIT.OK;
    }

    // List view.
    const health = serviceHealth(ping, tunnels);
    if (ping) line(io, colorize(`● daemon  pid ${daemon.pid} · v${daemon.version} · up ${daemon.uptime || '0s'}`, health, useColor));
    else line(io, colorize('● daemon  not running — configured tunnels:', health, useColor));
    const svcWord = service.installed ? (service.running ? 'on' : 'installed') : 'off';
    line(io, colorize(`  autostart: ${svcWord} · skill: ${skill.installed ? 'installed' : '—'}`, 'dim', useColor));
    if (tunnels.length === 0) {
      line(io, ping ? 'no tunnels' : '(none)');
      if (!ping) { line(io, ''); printDaemonDown(io); return EXIT.DAEMON; }
      return EXIT.OK;
    }
    line(io, '');
    for (const l of renderTunnelTable(tunnels, { color: useColor })) line(io, l);
    if (!ping) { line(io, ''); printDaemonDown(io); return EXIT.DAEMON; }
    const needsAuth = tunnels.some((r) => r.state === 'needs-auth');
    return needsAuth ? EXIT.NEEDS_AUTH : EXIT.OK;
  },

  async monitor(args, io, opts) {
    const { flags } = parseFlags(args, { value: ['--interval'], repeat: ['--tag'] });
    if (opts.json || !isInteractive()) {
      errline(io, 'tunlite monitor needs an interactive terminal; for scripts use `tunlite status --json`');
      return EXIT.USAGE;
    }
    let intervalMs = 1000;
    if (flags['--interval'] !== undefined) {
      const s = Number(flags['--interval']);
      if (!Number.isFinite(s) || s < 0.25 || s > 60) { errline(io, 'invalid --interval (expected seconds, 0.25–60)'); return EXIT.USAGE; }
      intervalMs = Math.round(s * 1000);
    }
    let tags;
    try { tags = config.parseTags(flags['--tag']); } catch (e) { errline(io, e.message); return EXIT.USAGE; }
    // When filtering by tag, keep only matching tunnels in the live feed; the
    // header shows the active filter so an empty/partial board isn't confusing.
    const tagWant = tags.length ? new Set(tags) : null;
    const applyTagFilter = (st) => (tagWant ? { ...st, tunnels: (st.tunnels || []).filter((t) => (t.tags || []).some((x) => tagWant.has(x))) } : st);
    require('readline').emitKeypressEvents(process.stdin);
    const setEnabled = async (name, enabled) => {
      const cfg = config.load(opts.configFile);
      const t = config.findTunnel(cfg, name);
      if (!t) return;
      t.enabled = enabled;
      config.save(cfg, opts.configFile);
      await reloadIfRunning();
    };
    const deps = {
      fetchState: async () => applyTagFilter(await gatherStatus(undefined, opts)),
      fetchLogs: async (name, n) => {
        const ping = await daemonPing();
        if (!ping) return [];
        try {
          const frames = await ipc.collect(paths.socketPath(), 'logs', { name, follow: false, n });
          return frames.filter((f) => f.line).map((f) => ({ ts: f.ts, line: f.line }));
        } catch (_) { return []; }
      },
      start: (name) => setEnabled(name, true),
      stop: (name) => setEnabled(name, false),
      restart: async (name) => { const ping = await daemonPing(); if (ping) await ipc.request(paths.socketPath(), 'restart', { names: [name] }); },
      input: process.stdin,
      output: process.stdout,
      setRawMode: (b) => { if (process.stdin.setRawMode) process.stdin.setRawMode(b); },
      onResize: (cb) => process.stdout.on('resize', cb),
      offResize: (cb) => process.stdout.removeListener('resize', cb),
      now: () => Date.now(),
      schedule: (fn, ms) => setInterval(fn, ms),
      cancel: (tk) => clearInterval(tk),
      // Exit synchronously from inside the quit keypress. The fallback
      // process.exit below the await is unreliable on Windows (the resolve→await
      // continuation stalls for seconds after raw-mode teardown), so monitor
      // calls this directly the moment `q`/Ctrl-C is handled.
      exit: (code) => process.exit(code || 0),
      color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    };
    const code = await monitormod.runMonitor(io, deps, { intervalMs, tagFilter: tags });
    // runMonitor restores the terminal before resolving. Exit explicitly: on
    // Windows the console stdin handle isn't released by pause()/unref() (libuv
    // reads it on a dedicated thread), so the event loop can stay alive and the
    // command hangs after you quit. stdout is a TTY here (monitor refuses
    // non-interactive use), so its writes have already flushed synchronously.
    process.exit(code || 0);
  },

  async logs(args, io, opts) {
    const { flags, positionals } = parseFlags(args, { value: ['-n'], bool: ['-f', '--follow'] });
    const name = positionals[0];
    // A named tunnel must exist (consistent with down/restart/rm/status); a bare
    // `logs` with no name tails the daemon's own log. Without this guard an
    // unknown name silently tailed an empty channel and exited 0, breaking the
    // not-found (3) contract every other name-taking command honors.
    if (name && !config.findTunnel(config.load(opts.configFile), name)) {
      errline(io, `no such tunnel: ${name}`); return EXIT.NOTFOUND;
    }
    const follow = Boolean(flags['-f'] || flags['--follow']);
    const n = flags['-n'] ? Number(flags['-n']) : 100;
    const ping = await daemonPing();
    if (!ping) { printDaemonDown(io); return EXIT.DAEMON; }
    await new Promise((resolve, reject) => {
      ipc.stream(paths.socketPath(), 'logs', { name, follow, n }, (frame) => {
        if (!frame.line) return; // skip the empty-tail sentinel in both modes
        // --json: NDJSON — one compact JSON object per line (not pretty-printed,
        // so each frame is independently parseable). Human path is byte-for-byte
        // unchanged.
        if (opts.json) io.out.write(JSON.stringify({ ts: frame.ts, line: frame.line }) + '\n');
        else line(io, `${new Date(frame.ts).toISOString()} ${frame.line}`);
      }).then((handle) => {
        // follow (-f): the daemon keeps the stream open; we resolve only when the
        // socket closes (Ctrl-C / daemon exit). non-follow: the daemon ends the
        // stream after pushing every requested frame (daemon.js logs handler ->
        // ctx.socket.end()), so resolve on the real stream end — no fixed timer
        // that would truncate a large `-n`. A generous backstop guards against a
        // missing end event so the command can never wedge.
        const done = () => { handle.stop(); resolve(); };
        handle.socket.on('close', done);
        handle.socket.on('end', done);
        if (!follow) {
          const backstop = setTimeout(done, 5000);
          if (typeof backstop.unref === 'function') backstop.unref();
        }
      }).catch(reject);
    });
    return EXIT.OK;
  },

  async check(args, io, opts) {
    const { flags, positionals } = parseFlags(args, { value: ['-i', '--jump'] });
    if (!positionals[0]) { errline(io, 'usage: tunlite check <user@host[:port]> [-i key] [--jump host]'); return EXIT.USAGE; }
    let target, jump;
    try { target = config.parseTarget(positionals[0]); jump = config.parseJump(flags['--jump']); } catch (e) { errline(io, e.message); return EXIT.USAGE; }
    const host = target.host;
    const probe = await ssh.probeAuth(host, { port: target.port || 22, identityFile: flags['-i'], jump });
    if (opts.json) {
      jsonOut(io, { host, passwordless: probe.ok, code: probe.code, restricted: !!probe.restricted, timedOut: !!probe.timedOut });
    } else if (probe.restricted) {
      line(io, `${host}: passwordless OK (tunnel-only host — authenticated, but it won't run remote commands; fine for tunneling)`);
    } else {
      line(io, probe.ok ? `${host}: passwordless OK` : `${host}: NOT passwordless (needs setup-key)`);
    }
    return probe.ok ? EXIT.OK : EXIT.NEEDS_AUTH;
  },

  async 'setup-key'(args, io, opts) {
    const { flags, positionals } = parseFlags(args, { value: ['-i', '--jump'] });
    if (!positionals[0]) { errline(io, 'usage: tunlite setup-key <user@host[:port]> [-i key] [--jump host]'); return EXIT.USAGE; }
    let target, jump;
    try { target = config.parseTarget(positionals[0]); jump = config.parseJump(flags['--jump']); } catch (e) { errline(io, e.message); return EXIT.USAGE; }
    const host = target.host;
    const port = target.port || 22;
    const pre = await ssh.probeAuth(host, { port, identityFile: flags['-i'], jump });
    if (pre.ok) { line(io, `${host}: already passwordless, nothing to do.`); return EXIT.OK; }
    const res = ssh.setupKey(host, { port, identityFile: flags['-i'], jump });
    const post = await ssh.probeAuth(host, { port, identityFile: flags['-i'], jump });
    if (opts.json) { jsonOut(io, { host, method: res.method, ok: post.ok }); }
    else line(io, post.ok ? `${host}: passwordless access established (${res.method}).` : `${host}: setup ran (${res.method}) but verification failed.`);
    return post.ok ? EXIT.OK : EXIT.ERROR;
  },

  async doctor(args, io, opts) {
    const { positionals } = parseFlags(args);
    const name = positionals[0];
    const res = await doctormod.diagnose({ configFile: opts.configFile, name });
    if (opts.json) { jsonOut(io, res); return res.ok ? EXIT.OK : EXIT.ERROR; }
    const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    let lastGroup = null;
    for (const c of res.checks) {
      if (c.group !== lastGroup) { line(io, ''); line(io, colorize(groupTitle(c.group), 'dim', useColor)); lastGroup = c.group; }
      const st = checkStyle(c.status);
      line(io, `  ${colorize(st.glyph, st.color, useColor)} ${c.title}${c.detail ? ' — ' + c.detail : ''}`);
      if (c.fix) line(io, colorize(`      ↳ fix: ${c.fix}`, 'dim', useColor));
    }
    line(io, '');
    line(io, `${res.summary.ok} ok, ${res.summary.warn} warnings, ${res.summary.fail} problems`);
    return res.ok ? EXIT.OK : EXIT.ERROR;
  },

  async daemon(args, io, opts) {
    const sub = args[0];
    if (sub === 'run') {
      const { Daemon } = require('./daemon');
      const d = new Daemon({ configFile: opts.configFile });
      await d.start();
      return new Promise(() => {}); // run forever
    }
    if (sub === 'start') {
      const p = await ensureDaemon(io);
      if (opts.json) jsonOut(io, p); else line(io, `daemon running (pid ${p.pid})`);
      return EXIT.OK;
    }
    if (sub === 'stop') {
      const ping = await daemonPing();
      if (!ping) { line(io, 'daemon not running'); return EXIT.OK; }
      try { await ipc.request(paths.socketPath(), 'shutdown', {}); } catch (_) {}
      // If the OS service is keeping it alive, a plain stop won't last.
      let svcInstalled = false;
      try { svcInstalled = autostart.adapterFor().status(autostart.context()).installed; } catch (_) {}
      if (opts.json) { jsonOut(io, { stopping: true, serviceInstalled: svcInstalled }); return EXIT.OK; }
      line(io, 'daemon stopping');
      if (svcInstalled) {
        line(io, 'note: the OS autostart service is installed, so it will be restarted automatically.');
        line(io, '      to stop permanently: tunlite uninstall service   (or disable tunnels: tunlite down)');
      }
      return EXIT.OK;
    }
    if (sub === 'status' || !sub) {
      const ping = await daemonPing();
      if (opts.json) { jsonOut(io, { running: Boolean(ping), ...(ping || {}) }); return EXIT.OK; }
      line(io, ping ? `daemon running (pid ${ping.pid}, v${ping.version})` : 'daemon not running');
      return EXIT.OK;
    }
    errline(io, `unknown daemon subcommand: ${sub}`); return EXIT.USAGE;
  },

  // Install the companion agent skill into a Claude Code skills dir.
  // Reached only via `install skill` / `uninstall skill` (no top-level surface):
  //   tunlite install skill [--dir user|cwd|<path>] [--link]
  //   tunlite uninstall skill [--dir ...]   (no --dir removes all recorded installs)
  //   tunlite install skill status
  skill: installCmd.skill,

  // Full teardown driven by the install manifest: stop the daemon, remove the OS
  // autostart service, remove the agent skill, delete the launcher + lib dir, and
  // (with --purge) delete config + state. Sub-targets do one piece only:
  //   uninstall service   remove just the autostart service
  //   uninstall skill      route to the skill module's uninstall
  uninstall: installCmd.uninstall,

  install: installCmd.install,

  async update(args, io, opts) {
    const updateMod = require('./update');
    const { flags, positionals } = parseFlags(args, { bool: ['--check', '--no-restart', '--force'] });
    const installRoot = path.join(__dirname, '..');
    const pkg = require('../package.json');
    const repoUrl = updateMod.httpsRepoUrl((pkg.repository && pkg.repository.url) || pkg.homepage || '');
    const deps = {
      currentVersion: VERSION,
      detectMethod: () => updateMod.detectInstallMethod(installRoot),
      fetch: (tag) => archiveFetch(repoUrl, tag),
      resolveLatestTag: () => resolveLatestTag(repoUrl),
      readVersion: (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version,
      anchor: (dir) => { const m = installer.readManifest() || {}; installer.anchor({ src: dir, libDir: m.libDir, binDir: m.binDir }); },
      restartDaemon: () => restartDaemonProcess(io),
      rmTemp: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
      log: (m) => line(io, m),
    };
    let res;
    try {
      res = await updateMod.runUpdate({
        version: positionals[0],
        check: Boolean(flags['--check']),
        noRestart: Boolean(flags['--no-restart']),
        force: Boolean(flags['--force']),
      }, deps);
    } catch (err) {
      if (opts.json) jsonOut(io, { error: err.message });
      else errline(io, `update failed: ${err.message}`);
      return err.exitCode || EXIT.ERROR;
    }
    if (opts.json) jsonOut(io, res);
    else renderUpdate(io, res);
    return EXIT.OK;
  },

  // Print a shell completion script (sourced by the user), or the bare tunnel
  // names the generated scripts call back for.
  async completion(args, io, opts) {
    const sub = args[0];
    if (sub === 'names') {
      for (const n of completionmod.tunnelNames(opts.configFile)) line(io, n);
      return EXIT.OK;
    }
    if (!['bash', 'zsh', 'fish'].includes(sub)) {
      errline(io, 'usage: tunlite completion <bash|zsh|fish>');
      return EXIT.USAGE;
    }
    io.out.write(completionmod.script(sub));
    return EXIT.OK;
  },

  // Webhook alerts: show / set / on / off / test / events. Verb subcommands,
  // matching `daemon`/`skill` (bare group = status); flags only modify `set`.
  webhook: webhookCmd.webhook,

  // Dump the validated config (settings + tunnels) as JSON for backup/sharing.
  // No secrets: identityFile is a path, not key material; the webhook url (which
  // embeds a token) is redacted so the dump is safe to share. The on-disk config
  // is never modified.
  async export(_args, io, opts) {
    const channels = require('./channels');
    const cfg = JSON.parse(JSON.stringify(config.load(opts.configFile)));
    if (cfg.settings && cfg.settings.alerts) {
      cfg.settings.alerts = redactAlerts(cfg.settings.alerts, channels);
    }
    jsonOut(io, cfg);
    return EXIT.OK;
  },

  // Merge tunnels from a file into the current config. Same-name tunnels are
  // skipped unless --force. Local settings/alerts are left untouched.
  async import(args, io, opts) {
    const { flags, positionals } = parseFlags(args, { bool: ['--force'] });
    const file = positionals[0];
    if (!file) { errline(io, 'usage: tunlite import <file> [--force]'); return EXIT.USAGE; }
    if (!fs.existsSync(file)) { errline(io, `no such file: ${file}`); return EXIT.NOTFOUND; }
    let incoming;
    try { incoming = config.load(file); }
    catch (e) { errline(io, `import failed: ${e.message}`); return EXIT.ERROR; }

    const cfg = config.load(opts.configFile);
    const added = [], skipped = [], overwritten = [];
    for (const t of incoming.tunnels) {
      const exists = config.findTunnel(cfg, t.name);
      if (exists && !flags['--force']) { skipped.push(t.name); continue; }
      config.upsertTunnel(cfg, t);
      (exists ? overwritten : added).push(t.name);
    }
    config.save(cfg, opts.configFile);
    const reloaded = await reloadIfRunning();

    if (opts.json) { jsonOut(io, { added, skipped, overwritten, daemonRunning: reloaded }); return EXIT.OK; }
    line(io, `imported: +${added.length} added, ${overwritten.length} overwritten, ${skipped.length} skipped`);
    if (added.length) line(io, `  added: ${added.join(', ')}`);
    if (overwritten.length) line(io, `  overwritten: ${overwritten.join(', ')}`);
    if (skipped.length) line(io, `  skipped (exists — use --force to overwrite): ${skipped.join(', ')}`);
    return EXIT.OK;
  },

  async version(_args, io) { line(io, VERSION); return EXIT.OK; },
  async help(_args, io) { line(io, HELP); return EXIT.OK; },
};

function groupTitle(g) {
  if (g === 'env') return 'environment';
  if (g === 'install') return 'install';
  if (g === 'daemon') return 'daemon & service';
  return g; // "tunnel:<name>"
}

const HELP = `tunlite — cross-platform SSH tunnel manager

USAGE
  tunlite <command> [options]            (add --json to most commands for machine output)

DEFINE (--local = your machine, --remote = the server side)
  add local   <name> --to user@host[:port] --remote [host:]PORT [--local [host:]PORT]
                              reach a remote service on your machine
  add remote  <name> --to user@host[:port] --local [host:]PORT [--remote [host:]PORT]
                              expose a local service on the server
  add dynamic <name> --to user@host[:port] [--local [host:]PORT]
                              local SOCKS5 proxy (default port 1080)
       common: [-i keyfile] [--jump [user@]host[:port][,...]] [--ssh-opt OPT] [--tag T]... [--disabled] [--no-auto-key]
       a host: prefix is the bind address on the listening side (0.0.0.0 to expose),
       or the host to connect to on the target side (default localhost).
  rename <old> <new>          rename a tunnel (cleanly hands the live tunnel over)
  set <name> [--to user@host[:port]] [-i key] [--jump host] [--ssh-opt OPT] [--tag T | --no-tags] [--auto-key|--no-auto-key]
                              change an existing tunnel's host / key / jump / options / tags
  rm <name>
  list [--tag T]              list tunnels (--tag filters to a label)

  forward list <tunnel>                              list a tunnel's forwards (with indexes)
  forward add  <tunnel> <local|remote|dynamic> ...   add another forward to a tunnel
  forward rm   <tunnel> <index>                       remove a forward (a tunnel keeps >=1)

  Naming convention: lowercase, "<purpose>-<port>", words hyphenated, no spaces.
  e.g. tmux-prod-19999 · progress-board-4705 · db-staging-5432

CONTROL
  up [name] [--tag T]    enable + start (probes/sets up passwordless first); no name/tag = all
  down [name] [--tag T]  disable + stop
  restart [name] [--tag T]   bounce running tunnel(s)
       --tag selects every tunnel carrying that label (repeatable = union); a
       name and --tag are mutually exclusive.

INSPECT
  status [name] [--tag T]  structured state (pid/uptime/restarts/lastError)
  monitor [--interval s] [--tag T]   live top-style dashboard; act on tunnels (start/stop/restart)
  logs <name> [-f] [-n N]
  doctor [name]      diagnose why a tunnel won't connect (ssh/keys/ports/daemon/service)
  check <user@host[:port]> [-i key] [--jump host]   exit 0 if passwordless works

KEYS (passwordless setup)
  setup-key <user@host[:port]> [-i key] [--jump host]   install your public key on the target

WEBHOOK (disconnect alerts)
  webhook                             show the current webhook (url/channel/enabled/events)
  webhook set <url> [--channel ID] [--events L]   set + enable (channel auto-detected from URL)
  webhook on | off                    enable / disable without forgetting the url
  webhook events <list>               choose events: names, or groups tunnel|daemon|all|none
                                      tunnel: up down recovered needs-auth failed stopped
                                      daemon: daemon-up daemon-down daemon-crash
  webhook test                        POST a test event and report the channel's verdict
                                      channels: generic (raw JSON) · wecom (WeCom)

CONFIG I/O
  export                              print config (settings + tunnels) as JSON
  import <file> [--force]             merge tunnels from a file (skip same-name; --force overwrites)

INSTALL
  install [--service] [--skill user|cwd|<path>] [--completion] [--yes]   anchor + onboarding
  install service                                         add just the autostart service
  install skill [--dir user|cwd|<path>]                   add just the agent skill
  install completion [bash|zsh|fish]                      enable tab-completion (auto-detects your shell)
  uninstall [service|skill|completion] [--purge] [--force] remove (no target = everything; confirms first, --force skips)

UPDATE
  update [version]   upgrade to latest (or a tag, e.g. v0.1.0), then restart the daemon
                     flags: --check (report only) · --no-restart · --force

ADVANCED (plumbing — you normally don't need these)
  daemon run                                the supervisor process itself (what 'up' / the service launch)
  daemon start|stop|status                  poke that process directly

MENTAL MODEL — three roles
  CLI (this command)  you control tunnels: add/up/down/status/logs. Exits immediately.
  daemon              one background process that holds the tunnels open & reconnects.
  service             the OS keeping that daemon alive across reboots/crashes.
  Day to day you only need: add · up · down · status · logs, plus 'install service'
  once if you want them to survive reboot. The daemon starts only via 'tunlite up'
  (on demand) or 'tunlite install service' (at login); other commands won't start it,
  they tell you how. Note: with the service installed, 'daemon stop' is temporary
  — the OS restarts it; use 'tunlite uninstall service' to stop for good.

EXIT CODES
  0 ok · 2 usage · 3 not-found · 4 needs-auth · 5 daemon-unreachable · 1 error
`;

async function run(argv, io = { out: process.stdout, err: process.stderr }) {
  // global flags
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  let cmd = args[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { line(io, HELP); return EXIT.OK; }
  if (cmd === '-v' || cmd === '--version') cmd = 'version';
  if (cmd === 'mon') cmd = 'monitor';
  const handler = commands[cmd];
  if (!handler) { errline(io, `unknown command: ${cmd}\nrun \`tunlite help\``); return EXIT.USAGE; }

  // The README promises "any command with `--help` for full flags". Only the
  // command position was honoring -h/--help; placed after a command (`status
  // --help`) it fell through to the handler, which rejected it as an unknown
  // option (or, for `export`, ran and dumped config). -h/--help aren't real
  // flags on any command, so intercept them anywhere and show the full help.
  const rest = args.slice(1);
  if (rest.includes('-h') || rest.includes('--help')) { line(io, HELP); return EXIT.OK; }

  // Gentle nudge if running un-anchored (e.g. straight from node_modules / a
  // dev tree) — except for the commands that are about anchoring or are trivial.
  // Suppressed under --json so machine output stays clean even if stderr is
  // merged into stdout (2>&1).
  const HINT_SKIP = new Set(['install', 'uninstall', 'update', 'version', 'help', 'daemon', 'completion']);
  if (!json && !HINT_SKIP.has(cmd) && !installer.isAnchored()) {
    errline(io, 'note: run `tunlite install` to anchor tunlite (survives node version switches)');
  }

  const opts = { json, configFile: process.env.TUNLITE_CONFIG || paths.configFile() };
  try {
    return await handler(args.slice(1), io, opts);
  } catch (err) {
    if (opts.json) jsonOut(io, { error: err.message, code: err.code });
    else errline(io, `error: ${err.message}`);
    return err.exitCode || EXIT.ERROR;
  }
}

module.exports = { run, commands, parseFlags, EXIT, HELP, archiveFetch };
