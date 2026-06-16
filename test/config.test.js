'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');

test('splitHostPort: bare port, host:port, bracketed IPv6, bare host, multi-colon', () => {
  assert.deepEqual(config.splitHostPort('5432'), { host: '', port: 5432 });
  assert.deepEqual(config.splitHostPort('localhost:80'), { host: 'localhost', port: 80 });
  assert.deepEqual(config.splitHostPort('0.0.0.0:1080'), { host: '0.0.0.0', port: 1080 });
  assert.deepEqual(config.splitHostPort('[::1]:2222'), { host: '::1', port: 2222 });
  assert.deepEqual(config.splitHostPort('db.internal'), { host: 'db.internal', port: null });
  assert.deepEqual(config.splitHostPort('2001:db8::1'), { host: '2001:db8::1', port: null }); // unbracketed IPv6
  assert.throws(() => config.splitHostPort('host:nope'), /invalid port/);
});

test('parseTarget: user@host[:port], default port, IPv6 brackets', () => {
  assert.deepEqual(config.parseTarget('user@host'), { host: 'user@host', port: null });
  assert.deepEqual(config.parseTarget('user@host:2222'), { host: 'user@host', port: 2222 });
  assert.deepEqual(config.parseTarget('host'), { host: 'host', port: null });
  assert.deepEqual(config.parseTarget('me@[::1]:2222'), { host: 'me@::1', port: 2222 });
  assert.throws(() => config.parseTarget('user@host:70000'), /SSH port/);
});

test('parseTarget rejects a host beginning with "-" (ssh argv injection)', () => {
  // A leading "-" host would be read by ssh as an option (e.g. -oProxyCommand=...).
  assert.throws(() => config.parseTarget('-oProxyCommand=touch /tmp/x'), /may not start with "-"/);
  assert.throws(() => config.parseTarget('user@-evil'), /may not start with "-"/);
});

test('parseAddr: [host:]port; port required; range checked', () => {
  assert.deepEqual(config.parseAddr('5432', '--remote'), { host: '', port: 5432 });
  assert.deepEqual(config.parseAddr('db.int:5432', '--remote'), { host: 'db.int', port: 5432 });
  assert.deepEqual(config.parseAddr('0.0.0.0:9000', '--remote'), { host: '0.0.0.0', port: 9000 });
  assert.throws(() => config.parseAddr('db.int', '--remote'), /--remote/);   // missing port
  assert.throws(() => config.parseAddr('99999', '--local'), /1–65535/);      // out of range
});

test('validateTunnel normalizes defaults', () => {
  const v = config.validateTunnel({
    name: 'web', host: 'user@host',
    forwards: [{ type: 'local', srcPort: 8080, destHost: 'localhost', destPort: 80 }],
  });
  assert.equal(v.port, 22);
  assert.equal(v.enabled, true);
  assert.equal(v.autoSetupKey, true);
  assert.equal(v.forwards[0].bind, '127.0.0.1');
});

test('validateTunnel rejects bad name and missing forwards', () => {
  assert.throws(() => config.validateTunnel({ name: 'bad name', host: 'h', forwards: [{ type: 'dynamic', srcPort: 1 }] }));
  assert.throws(() => config.validateTunnel({ name: 'web', host: 'h', forwards: [] }));
  assert.throws(() => config.validateTunnel({ name: 'web', forwards: [{ type: 'dynamic', srcPort: 1 }] }));
});

test('save then load round-trips and rejects duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-cfg-'));
  const file = path.join(dir, 'config.json');
  const c = config.defaultConfig();
  config.upsertTunnel(c, {
    name: 'web', host: 'me@example.com',
    forwards: [{ type: 'local', srcPort: 8080, destHost: 'localhost', destPort: 80 }],
  });
  config.save(c, file);
  const loaded = config.load(file);
  assert.equal(loaded.tunnels.length, 1);
  assert.equal(loaded.tunnels[0].host, 'me@example.com');
  // settings preserved with defaults
  assert.equal(loaded.settings.keepalive.intervalSec, 15);

  const dup = config.defaultConfig();
  dup.tunnels = [loaded.tunnels[0], loaded.tunnels[0]];
  assert.throws(() => config.validateConfig(dup));
});

test('load of missing file returns default config', () => {
  const c = config.load(path.join(os.tmpdir(), 'tunlite-does-not-exist-xyz', 'config.json'));
  assert.deepEqual(c.tunnels, []);
});

test('alerts: default config has a disabled, generic webhook on the default events', () => {
  const c = config.defaultConfig();
  assert.equal(c.settings.alerts.webhook.url, null);
  assert.equal(c.settings.alerts.webhook.channel, 'generic');
  assert.equal(c.settings.alerts.webhook.enabled, false);
  assert.deepEqual(c.settings.alerts.webhook.events, config.DEFAULT_ALERT_EVENTS);
  // the default set is a subset of all known events, and excludes the chatty ones
  assert.ok(config.DEFAULT_ALERT_EVENTS.every((e) => config.ALERT_EVENTS.includes(e)));
  assert.ok(!config.DEFAULT_ALERT_EVENTS.includes('up'));
  assert.ok(!config.DEFAULT_ALERT_EVENTS.includes('daemon-up'));
});

test('alerts: channel defaults to generic and enabled defaults to false when unset', () => {
  const c = config.validateConfig({ settings: { alerts: { webhook: { url: 'https://h/x', events: ['down'] } } }, tunnels: [] });
  assert.equal(c.settings.alerts.webhook.channel, 'generic');
  assert.equal(c.settings.alerts.webhook.enabled, false); // no inference from url; off until `webhook on`
});

test('alerts: a webhook with no events field defaults to the standard alert set', () => {
  const c = config.validateConfig({ settings: { alerts: { webhook: { url: 'https://h/x' } } }, tunnels: [] });
  assert.deepEqual(c.settings.alerts.webhook.events, config.DEFAULT_ALERT_EVENTS);
});

test('alerts: an unknown channel and a non-boolean enabled are rejected', () => {
  assert.throws(() => config.validateConfig({ settings: { alerts: { webhook: { url: 'https://h', channel: 'telegram' } } }, tunnels: [] }), /unknown alerts.webhook.channel/);
  assert.throws(() => config.validateConfig({ settings: { alerts: { webhook: { url: 'https://h', enabled: 'yes' } } }, tunnels: [] }), /enabled must be a boolean/);
});

test('expandEvents: names, groups, all, none, dedup, and unknown', () => {
  assert.deepEqual(config.expandEvents(['down', 'recovered']), ['down', 'recovered']);
  assert.deepEqual(config.expandEvents(['daemon']), config.ALERT_GROUPS.daemon);
  assert.deepEqual(config.expandEvents(['all']), config.ALERT_EVENTS);
  assert.deepEqual(config.expandEvents(['none']), []);
  assert.deepEqual(config.expandEvents(['down', 'tunnel', 'down']).filter((e) => e === 'down').length, 1); // deduped
  assert.ok(config.expandEvents(['tunnel', 'daemon-crash']).includes('daemon-crash'));
  assert.throws(() => config.expandEvents(['bogus']), /unknown alert event\/group/);
});

test('alerts: a config without an alerts block gets default alerts', () => {
  const c = config.validateConfig({ version: 1, settings: { keepalive: { intervalSec: 9 } }, tunnels: [] });
  assert.equal(c.settings.keepalive.intervalSec, 9); // user override preserved
  assert.equal(c.settings.alerts.webhook.url, null); // alerts filled with defaults
});

test('alerts: a valid http(s) url and known events round-trip', () => {
  const c = config.validateConfig({
    settings: { alerts: { webhook: { url: 'https://h/x', events: ['down', 'recovered'] } } },
    tunnels: [],
  });
  assert.equal(c.settings.alerts.webhook.url, 'https://h/x');
  assert.deepEqual(c.settings.alerts.webhook.events, ['down', 'recovered']);
});

test('alerts: bad url and unknown event are rejected', () => {
  assert.throws(() => config.validateConfig({ settings: { alerts: { webhook: { url: 'ftp://nope' } } }, tunnels: [] }), /webhook\.url/);
  assert.throws(() => config.validateConfig({ settings: { alerts: { webhook: { url: 'http://h', events: ['boom'] } } }, tunnels: [] }), /unknown alert event/);
});

test('parseJump: comma-separated hops, validated and normalized', () => {
  assert.deepEqual(config.parseJump('user@bastion'), ['user@bastion']);
  assert.deepEqual(config.parseJump('a@h1:2222,b@h2'), ['a@h1:2222', 'b@h2']);
  assert.deepEqual(config.parseJump(['j1', 'j2']), ['j1', 'j2']);
  assert.deepEqual(config.parseJump(''), []);
  assert.deepEqual(config.parseJump(undefined), []);
  assert.throws(() => config.parseJump('bad@:'), /invalid/);
});

test('parseJump rejects a hop whose host begins with "-" (ssh -J injection)', () => {
  assert.throws(() => config.parseJump('-oProxyCommand=touch /tmp/x'), /may not start with "-"/);
  assert.throws(() => config.parseJump('good,user@-evil'), /may not start with "-"/);
});

test('validateTunnel normalizes jump (string -> hop array; default [])', () => {
  const t = config.validateTunnel({ name: 'x', host: 'me@h', forwards: [{ type: 'dynamic', srcPort: 1080 }], jump: 'user@bastion:2222' });
  assert.deepEqual(t.jump, ['user@bastion:2222']);
  const t2 = config.validateTunnel({ name: 'y', host: 'me@h', forwards: [{ type: 'dynamic', srcPort: 1080 }] });
  assert.deepEqual(t2.jump, []);
});

test('parseTags: array or comma string, trimmed, deduped, charset-checked', () => {
  assert.deepEqual(config.parseTags(['work', 'prod']), ['work', 'prod']);
  assert.deepEqual(config.parseTags('work,prod'), ['work', 'prod']);
  assert.deepEqual(config.parseTags([' work ', 'work', 'db']), ['work', 'db']); // trim + dedupe
  assert.deepEqual(config.parseTags(['a,b', 'c']), ['a', 'b', 'c']);            // comma inside an element
  assert.deepEqual(config.parseTags(''), []);
  assert.deepEqual(config.parseTags(undefined), []);
  assert.throws(() => config.parseTags('bad tag'), /invalid tag/);             // space illegal
  assert.throws(() => config.parseTags(['ok', 'no@good']), /invalid tag/);
});

test('validateTunnel normalizes tags (string -> array; default [])', () => {
  const t = config.validateTunnel({ name: 'x', host: 'me@h', forwards: [{ type: 'dynamic', srcPort: 1080 }], tags: 'work,prod' });
  assert.deepEqual(t.tags, ['work', 'prod']);
  const t2 = config.validateTunnel({ name: 'y', host: 'me@h', forwards: [{ type: 'dynamic', srcPort: 1080 }] });
  assert.deepEqual(t2.tags, []);
});
