'use strict';

// `webhook` command group (disconnect alerts): show / set / on / off / events /
// test, plus the redactAlerts helper shared with `export`. Imports shared
// primitives from cli-core and reloadIfRunning from selection; never requires ../cli.

const os = require('os');
const config = require('../config');
const { VERSION } = require('../version');
const { EXIT, fail, parseFlags, jsonOut, line, errline, failUnknown } = require('../cli-core');
const { reloadIfRunning } = require('../selection');

// Deep-copy an `alerts` block with the webhook url redacted, for display/export.
// Never mutates the loaded config (which still gets saved with the real url).
function redactAlerts(alerts, channels) {
  const copy = JSON.parse(JSON.stringify(alerts || {}));
  if (copy.webhook && copy.webhook.url) copy.webhook.url = channels.redactUrl(copy.webhook.url);
  return copy;
}

// Webhook alerts: show / set / on / off / test / events. Verb subcommands,
// matching `daemon`/`skill` (bare group = status); flags only modify `set`.
async function webhook(args, io, opts) {
  const channels = require('../channels');
  const sub = args[0];
  const cfg = config.load(opts.configFile);
  const w = cfg.settings.alerts.webhook;

  if (!sub || sub === 'status') {
    if (opts.json) { jsonOut(io, redactAlerts(cfg.settings.alerts, channels)); return EXIT.OK; }
    line(io, w.url ? `webhook: ${channels.redactUrl(w.url)}` : 'webhook: (not set)');
    line(io, `channel: ${channels.resolve(w.channel).label}`);
    line(io, `enabled: ${w.enabled ? 'yes' : 'no'}`);
    line(io, `events:  ${w.events.join(', ') || '(none)'}`);
    return EXIT.OK;
  }

  if (sub === 'set') {
    const { flags, positionals } = parseFlags(args.slice(1), { value: ['--events', '--channel'] });
    const url = positionals[0];
    if (!url) { fail('usage: tunlite webhook set <url> [--channel <id>] [--events <list>]'); }
    if (!/^https?:\/\//i.test(url)) { fail(`invalid webhook url "${url}" (must be http(s)://...)`); }
    let channel; let source;
    if (flags['--channel'] !== undefined) {
      if (!channels.KNOWN_CHANNELS.includes(flags['--channel'])) {
        fail(`unknown channel "${flags['--channel']}" (known: ${channels.KNOWN_CHANNELS.join(', ')})`);
      }
      channel = flags['--channel']; source = 'from --channel';
    } else {
      channel = channels.detectChannel(url); source = 'detected from URL';
    }
    if (flags['--events'] !== undefined) {
      try { w.events = config.expandEvents(flags['--events'].split(',')); }
      catch (e) { fail(e.message); }
    }
    w.url = url; w.channel = channel; w.enabled = true;
    config.save(cfg, opts.configFile); // re-validates the alerts shape
    const reloaded = await reloadIfRunning();
    if (opts.json) { jsonOut(io, { ...redactAlerts(cfg.settings.alerts, channels), daemonRunning: reloaded }); return EXIT.OK; }
    line(io, `webhook set: ${channels.redactUrl(url)}${reloaded ? '' : '  (daemon not running — applies when it starts)'}`);
    line(io, `channel: ${channels.resolve(channel).label} (${source})`);
    line(io, `events:  ${w.events.join(', ') || '(none)'}`);
    return EXIT.OK;
  }

  if (sub === 'on' || sub === 'off') {
    if (sub === 'on' && !w.url) { fail('no webhook url set (run: tunlite webhook set <url>)'); }
    w.enabled = (sub === 'on');
    config.save(cfg, opts.configFile);
    const reloaded = await reloadIfRunning();
    if (opts.json) { jsonOut(io, { ...redactAlerts(cfg.settings.alerts, channels), daemonRunning: reloaded }); return EXIT.OK; }
    line(io, `webhook ${w.enabled ? 'on' : 'off'}${reloaded ? '' : '  (daemon not running — applies when it starts)'}`);
    return EXIT.OK;
  }

  if (sub === 'events') {
    const list = args.slice(1);
    if (!list.length) { fail('usage: tunlite webhook events <down,recovered,… | tunnel | daemon | all | none>'); }
    let events;
    try { events = config.expandEvents(list.join(',').split(',')); }
    catch (e) { fail(e.message); }
    w.events = events;
    config.save(cfg, opts.configFile);
    const reloaded = await reloadIfRunning();
    if (opts.json) { jsonOut(io, { ...redactAlerts(cfg.settings.alerts, channels), daemonRunning: reloaded }); return EXIT.OK; }
    line(io, `webhook events: ${events.length ? events.join(', ') : '(none)'}`);
    return EXIT.OK;
  }

  if (sub === 'test') {
    if (!w.url) { fail('no webhook configured (set one: tunlite webhook set <url>)'); }
    const { defaultPost } = require('../alerter');
    const ch = channels.resolve(w.channel);
    const payload = {
      scope: 'test', tunnel: '(test)', host: null, event: 'test', state: 'test',
      lastError: null, restarts: 0, ts: Date.now(), machine: os.hostname(), version: VERSION,
    };
    try {
      const res = await defaultPost(w.url, ch.format(payload));
      const v = ch.check(res.status, res.text);
      if (opts.json) { jsonOut(io, { ok: v.ok, status: res.status, detail: v.detail, channel: w.channel, url: channels.redactUrl(w.url) }); return v.ok ? EXIT.OK : EXIT.ERROR; }
      if (v.ok) { line(io, `test event sent to ${channels.redactUrl(w.url)} [${ch.label}] (HTTP ${res.status})`); return EXIT.OK; }
      errline(io, `test rejected by ${ch.label}: ${v.detail} (HTTP ${res.status})`); return EXIT.ERROR;
    } catch (e) {
      if (opts.json) { jsonOut(io, { ok: false, error: e.message, url: channels.redactUrl(w.url) }); return EXIT.ERROR; }
      errline(io, `test failed: ${e.message}`); return EXIT.ERROR;
    }
  }

  failUnknown('webhook subcommand', sub, ['status', 'set', 'on', 'off', 'events', 'test']);
}

module.exports = { webhook, redactAlerts };
