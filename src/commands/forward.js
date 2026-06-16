'use strict';

// `forward` command group: list/add/rm a tunnel's forwards, plus the helpers
// (buildForward / forwardLabel) shared with the top-level `add`. Imports shared
// primitives from cli-core and reloadIfRunning from selection; never requires ../cli.

const config = require('../config');
const { EXIT, parseFlags, jsonOut, line, errline } = require('../cli-core');
const { reloadIfRunning } = require('../selection');

// Build one forward object from the add subcommand + its --local/--remote flags.
// --local always = your machine; --remote always = the server side. The subcommand
// decides who listens (see the `add` comment). Throws a usage error on a missing
// required endpoint or a bad address.
function buildForward(sub, flags) {
  const has = (k) => flags[k] !== undefined;
  if (sub === 'dynamic') {
    const a = has('--local') ? config.parseAddr(flags['--local'], '--local') : { host: '', port: 1080 };
    return { type: 'dynamic', bind: a.host || '127.0.0.1', srcPort: a.port };
  }
  if (sub === 'local') {
    if (!has('--remote')) throw new Error('local needs --remote [host:]port (the service to reach)');
    const r = config.parseAddr(flags['--remote'], '--remote');
    const l = has('--local') ? config.parseAddr(flags['--local'], '--local') : { host: '', port: r.port };
    return { type: 'local', bind: l.host || '127.0.0.1', srcPort: l.port, destHost: r.host || 'localhost', destPort: r.port };
  }
  // remote
  if (!has('--local')) throw new Error('remote needs --local [host:]port (the service to expose)');
  const l = config.parseAddr(flags['--local'], '--local');
  const r = has('--remote') ? config.parseAddr(flags['--remote'], '--remote') : { host: '', port: l.port };
  return { type: 'remote', bind: r.host || '127.0.0.1', srcPort: r.port, destHost: l.host || 'localhost', destPort: l.port };
}

// Human-readable one-line label for a single forward (used by `forward list`).
function forwardLabel(f) {
  if (f.type === 'dynamic') return `dynamic  ${f.bind}:${f.srcPort}  (SOCKS5)`;
  const arrow = f.type === 'remote' ? '<-' : '->';
  return `${f.type.padEnd(7)} ${f.bind}:${f.srcPort} ${arrow} ${f.destHost}:${f.destPort}`;
}

// forward list <tunnel> — show a tunnel's forwards with 1-based indexes.
async function forwardList(args, io, opts) {
  const { positionals } = parseFlags(args);
  const name = positionals[0];
  if (!name) { errline(io, 'usage: tunlite forward list <tunnel>'); return EXIT.USAGE; }
  const cfg = config.load(opts.configFile);
  const t = config.findTunnel(cfg, name);
  if (!t) { errline(io, `no such tunnel: ${name}`); return EXIT.NOTFOUND; }
  if (opts.json) { jsonOut(io, t.forwards); return EXIT.OK; }
  t.forwards.forEach((f, i) => line(io, `${i + 1}\t${forwardLabel(f)}`));
  return EXIT.OK;
}

// forward add <tunnel> <local|remote|dynamic> ... — append a forward to a tunnel.
async function forwardAdd(args, io, opts) {
  const name = args[0];
  const sub = args[1];
  if (!name || !['local', 'remote', 'dynamic'].includes(sub)) {
    errline(io, 'usage: tunlite forward add <tunnel> <local|remote|dynamic> [--local [host:]PORT] [--remote [host:]PORT]');
    return EXIT.USAGE;
  }
  const { flags } = parseFlags(args.slice(2), { value: ['--local', '--remote'] });
  const cfg = config.load(opts.configFile);
  const t = config.findTunnel(cfg, name);
  if (!t) { errline(io, `no such tunnel: ${name}`); return EXIT.NOTFOUND; }
  let forward;
  try { forward = buildForward(sub, flags); } catch (e) { errline(io, e.message); return EXIT.USAGE; }
  t.forwards.push(forward);
  try { config.upsertTunnel(cfg, t); } catch (e) { errline(io, e.message); return EXIT.USAGE; }
  config.save(cfg, opts.configFile);
  const reloaded = await reloadIfRunning();
  if (opts.json) { jsonOut(io, { name, forwards: t.forwards, daemonRunning: reloaded }); return EXIT.OK; }
  line(io, `"${name}": added forward  ${forwardLabel(forward)}${reloaded ? '' : '   (daemon not running)'}`);
  return EXIT.OK;
}

// forward rm <tunnel> <index> — remove the Nth forward (1-based); keeps at least one.
async function forwardRm(args, io, opts) {
  const { positionals } = parseFlags(args);
  const name = positionals[0];
  const idx = Number(positionals[1]);
  if (!name || !Number.isInteger(idx)) { errline(io, 'usage: tunlite forward rm <tunnel> <index>   (index from `forward list`)'); return EXIT.USAGE; }
  const cfg = config.load(opts.configFile);
  const t = config.findTunnel(cfg, name);
  if (!t) { errline(io, `no such tunnel: ${name}`); return EXIT.NOTFOUND; }
  if (idx < 1 || idx > t.forwards.length) { errline(io, `no forward #${idx} on "${name}" (it has ${t.forwards.length})`); return EXIT.USAGE; }
  if (t.forwards.length === 1) { errline(io, `"${name}" has only one forward — remove the whole tunnel with:  tunlite rm ${name}`); return EXIT.USAGE; }
  const [removed] = t.forwards.splice(idx - 1, 1);
  config.upsertTunnel(cfg, t);
  config.save(cfg, opts.configFile);
  const reloaded = await reloadIfRunning();
  if (opts.json) { jsonOut(io, { name, removed, forwards: t.forwards, daemonRunning: reloaded }); return EXIT.OK; }
  line(io, `"${name}": removed forward #${idx}  ${forwardLabel(removed)}`);
  return EXIT.OK;
}

// forward add|rm|list <tunnel> ... — manage a tunnel's forwards (one tunnel can
// carry several -L/-R/-D over a single ssh connection).
async function forward(args, io, opts) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'add') return forwardAdd(rest, io, opts);
  if (sub === 'rm' || sub === 'remove') return forwardRm(rest, io, opts);
  if (sub === 'list' || sub === 'ls') return forwardList(rest, io, opts);
  errline(io, 'usage: tunlite forward <add|rm|list> <tunnel> ...');
  return EXIT.USAGE;
}

module.exports = { buildForward, forwardLabel, forwardList, forwardAdd, forwardRm, forward };
