'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { run } = require('../src/cli');
const config = require('../src/config');

function capture() {
  const out = [];
  const err = [];
  return {
    io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

// Run with an isolated TUNLITE_HOME (no daemon involved for these commands).
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-io-'));
  const prev = process.env.TUNLITE_HOME;
  process.env.TUNLITE_HOME = home;
  const restore = () => { if (prev === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prev; };
  return Promise.resolve(fn(home)).then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
}

test('export prints only tunnels as an importable {version, tunnels} doc', async () => {
  await withHome(async () => {
    await run(['add', 'web-8080', '--to', 'me@h', '-L', '8080:localhost:80'], capture().io);
    const c = capture();
    assert.equal(await run(['export'], c.io), 0);
    const dump = JSON.parse(c.out());
    // export is the portable subset: tunnels only. Settings/alerts are
    // machine-local and import never reads them, so they must NOT be emitted.
    assert.ok(!('settings' in dump), 'export must not carry settings');
    assert.equal(dump.version, 1);
    assert.equal(dump.tunnels.length, 1);
    assert.equal(dump.tunnels[0].name, 'web-8080');
  });
});

test('import adds new tunnels, skips same-name, overwrites with --force', async () => {
  await withHome(async (home) => {
    // an import file with two tunnels
    const src = config.defaultConfig();
    config.upsertTunnel(src, { name: 'a', host: 'me@h1', forwards: [{ type: 'dynamic', srcPort: 1080 }] });
    config.upsertTunnel(src, { name: 'b', host: 'me@h2', forwards: [{ type: 'dynamic', srcPort: 1081 }] });
    const file = path.join(home, 'in.json');
    config.save(src, file);

    // current config already has "a" pointing somewhere else
    await run(['add', 'a', '--to', 'old@host', '-D', '9999'], capture().io);

    // default: "a" skipped, "b" added
    let c = capture();
    assert.equal(await run(['import', file, '--json'], c.io), 0);
    let res = JSON.parse(c.out());
    assert.deepEqual(res.added, ['b']);
    assert.deepEqual(res.skipped, ['a']);
    assert.deepEqual(res.overwritten, []);

    // "a" still the original
    let after = config.load(path.join(home, 'config', 'config.json'));
    assert.equal(after.tunnels.find((t) => t.name === 'a').host, 'old@host');

    // --force: "a" overwritten, "b" overwritten (already present from prev import)
    c = capture();
    assert.equal(await run(['import', file, '--force', '--json'], c.io), 0);
    res = JSON.parse(c.out());
    assert.deepEqual(res.added, []);
    assert.deepEqual(res.overwritten.sort(), ['a', 'b']);
    after = config.load(path.join(home, 'config', 'config.json'));
    assert.equal(after.tunnels.find((t) => t.name === 'a').host, 'me@h1');
  });
});

test('import of a missing file is a not-found error; malformed file leaves config untouched', async () => {
  await withHome(async (home) => {
    await run(['add', 'keep', '--to', 'me@h', '-D', '1080'], capture().io);

    const c1 = capture();
    assert.equal(await run(['import', path.join(home, 'nope.json')], c1.io), 3);
    assert.match(c1.err(), /no such file/);

    const bad = path.join(home, 'bad.json');
    fs.writeFileSync(bad, '{ not valid json ');
    const c2 = capture();
    assert.equal(await run(['import', bad], c2.io), 1);
    assert.match(c2.err(), /import failed/);

    // original tunnel survived both failures
    const after = config.load(path.join(home, 'config', 'config.json'));
    assert.deepEqual(after.tunnels.map((t) => t.name), ['keep']);
  });
});

test('webhook: show, set (auto-detect generic), on/off round-trip', async () => {
  await withHome(async (home) => {
    const cfgPath = path.join(home, 'config', 'config.json');
    let c = capture();
    await run(['webhook'], c.io);
    assert.match(c.out(), /webhook: \(not set\)/);

    c = capture();
    assert.equal(await run(['webhook', 'set', 'https://hook/x'], c.io), 0);
    // Displayed url is REDACTED (the secret lives in the path); the on-disk
    // config still keeps the full url (checked below).
    assert.match(c.out(), /webhook set: https:\/\/hook\/…/);
    assert.match(c.out(), /channel: generic \(detected from URL\)/);
    let w = config.load(cfgPath).settings.alerts.webhook;
    assert.equal(w.url, 'https://hook/x');
    assert.equal(w.channel, 'generic');
    assert.equal(w.enabled, true);

    // status --json exposes the machine-readable shape
    c = capture();
    assert.equal(await run(['webhook', 'status', '--json'], c.io), 0);
    const shown = JSON.parse(c.out());
    assert.equal(shown.webhook.url, 'https://hook/…'); // redacted in display output
    assert.equal(shown.webhook.channel, 'generic');
    assert.equal(shown.webhook.enabled, true);

    // bad url rejected, config unchanged
    c = capture();
    assert.equal(await run(['webhook', 'set', 'ftp://nope'], c.io), 2);
    assert.match(c.err(), /invalid webhook url/);

    // off keeps the url; on resumes
    assert.equal(await run(['webhook', 'off'], capture().io), 0);
    assert.equal(config.load(cfgPath).settings.alerts.webhook.enabled, false);
    assert.equal(config.load(cfgPath).settings.alerts.webhook.url, 'https://hook/x');
    assert.equal(await run(['webhook', 'on'], capture().io), 0);
    assert.equal(config.load(cfgPath).settings.alerts.webhook.enabled, true);
  });
});

test('webhook set --channel overrides detection; a bogus channel is rejected', async () => {
  await withHome(async (home) => {
    const cfgPath = path.join(home, 'config', 'config.json');
    const c = capture();
    assert.equal(await run(['webhook', 'set', 'https://qyapi.weixin.qq.com/x', '--channel', 'generic'], c.io), 0);
    assert.match(c.out(), /channel: generic \(from --channel\)/);
    assert.equal(config.load(cfgPath).settings.alerts.webhook.channel, 'generic');

    const c2 = capture();
    assert.equal(await run(['webhook', 'set', 'https://h/x', '--channel', 'telegram'], c2.io), 2);
    assert.match(c2.err(), /unknown channel "telegram"/);
  });
});

test('webhook set auto-detects wecom from the URL', async () => {
  await withHome(async (home) => {
    const c = capture();
    assert.equal(await run(['webhook', 'set', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'], c.io), 0);
    assert.match(c.out(), /channel: WeCom \(detected from URL\)/);
    assert.equal(config.load(path.join(home, 'config', 'config.json')).settings.alerts.webhook.channel, 'wecom');
  });
});

test('webhook events: names, group shortcut, all, none, and rejection', async () => {
  await withHome(async (home) => {
    const cfgPath = path.join(home, 'config', 'config.json');
    assert.equal(await run(['webhook', 'events', 'down,recovered'], capture().io), 0);
    assert.deepEqual(config.load(cfgPath).settings.alerts.webhook.events, ['down', 'recovered']);
    assert.equal(await run(['webhook', 'events', 'daemon'], capture().io), 0);
    assert.deepEqual(config.load(cfgPath).settings.alerts.webhook.events, config.ALERT_GROUPS.daemon);
    assert.equal(await run(['webhook', 'events', 'all'], capture().io), 0);
    assert.deepEqual(config.load(cfgPath).settings.alerts.webhook.events, config.ALERT_EVENTS);
    assert.equal(await run(['webhook', 'events', 'none'], capture().io), 0);
    assert.deepEqual(config.load(cfgPath).settings.alerts.webhook.events, []);
    const c = capture();
    assert.equal(await run(['webhook', 'events', 'bogus'], c.io), 2);
    assert.match(c.err(), /unknown alert event\/group/);
  });
});

test('webhook set --events sets url and events together', async () => {
  await withHome(async (home) => {
    const c = capture();
    assert.equal(await run(['webhook', 'set', 'https://h/x', '--events', 'tunnel,daemon-crash'], c.io), 0);
    const w = config.load(path.join(home, 'config', 'config.json')).settings.alerts.webhook;
    assert.equal(w.url, 'https://h/x');
    assert.ok(w.events.includes('daemon-crash'));
    assert.ok(w.events.includes('up'));
  });
});

test('webhook test reports the status; rejection (wecom errcode) exits non-zero', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 200; res.end('{"errcode":93000,"errmsg":"invalid"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await withHome(async () => {
      const c0 = capture();
      assert.equal(await run(['webhook', 'test'], c0.io), 2);
      assert.match(c0.err(), /no webhook configured/);

      // generic endpoint: 200 with an errcode body but channel=generic => ok
      await run(['webhook', 'set', `http://127.0.0.1:${port}/hook`], capture().io);
      const c = capture();
      assert.equal(await run(['webhook', 'test', '--json'], c.io), 0);
      assert.equal(JSON.parse(c.out()).ok, true);

      // force wecom channel on the same endpoint => errcode !=0 => rejected, exit 1
      await run(['webhook', 'set', `http://127.0.0.1:${port}/hook`, '--channel', 'wecom'], capture().io);
      const c2 = capture();
      assert.equal(await run(['webhook', 'test', '--json'], c2.io), 1);
      const res = JSON.parse(c2.out());
      assert.equal(res.ok, false);
      assert.match(res.detail, /errcode 93000/);
    });
  } finally {
    server.close();
  }
});
