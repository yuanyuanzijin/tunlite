'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ch = require('../src/channels');

const downPayload = {
  scope: 'tunnel', tunnel: 'tmux-prod-19999', host: 'me@host', event: 'down',
  state: 'retrying', lastError: 'Connection refused', restarts: 2,
  ts: 1000, machine: 'mac-studio', version: '9.9.9',
};

test('KNOWN_CHANNELS lists generic and wecom', () => {
  assert.deepEqual(ch.KNOWN_CHANNELS, ['generic', 'wecom']);
});

test('detectChannel maps the wecom host, else generic', () => {
  assert.equal(ch.detectChannel('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), 'wecom');
  assert.equal(ch.detectChannel('https://example.com/hook'), 'generic');
  assert.equal(ch.detectChannel('not a url'), 'generic');
});

test('resolve falls back to generic for an unknown id', () => {
  assert.equal(ch.resolve('nope').id, 'generic');
  assert.equal(ch.resolve('wecom').id, 'wecom');
});

test('generic.format passes the neutral payload through as the body', () => {
  const req = ch.resolve('generic').format(downPayload);
  assert.deepEqual(req.body, downPayload);
  assert.match(req.contentType, /application\/json/);
});

test('generic.check is ok on 2xx, not ok otherwise', () => {
  assert.equal(ch.resolve('generic').check(204, '').ok, true);
  assert.equal(ch.resolve('generic').check(500, 'err').ok, false);
});

test('wecom.format produces a text message body', () => {
  const req = ch.resolve('wecom').format(downPayload);
  assert.equal(req.body.msgtype, 'text');
  assert.match(req.body.text.content, /tunnel tmux-prod-19999 is down/);
  assert.match(req.body.text.content, /target  me@host/);
  assert.match(req.body.text.content, /error   Connection refused/);
  assert.match(req.body.text.content, /machine mac-studio/);
});

test('wecom.check reads errcode: 0 ok, non-zero rejected', () => {
  assert.deepEqual(ch.resolve('wecom').check(200, '{"errcode":0,"errmsg":"ok"}'), { ok: true, detail: '' });
  const bad = ch.resolve('wecom').check(200, '{"errcode":93000,"errmsg":"invalid"}');
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /errcode 93000: invalid/);
});

test('renderText omits target/error lines when absent and handles daemon scope', () => {
  const daemon = { scope: 'daemon', tunnel: null, host: null, event: 'daemon-crash', lastError: null, machine: 'mac-studio' };
  const t = ch.renderText(daemon);
  assert.match(t, /daemon crashed/);
  assert.ok(!/target/.test(t), 'no target line for daemon scope');
  assert.ok(!/error  /.test(t), 'no error line when lastError is null');
  assert.match(t, /machine mac-studio/);
});

test('redactUrl hides the secret path/query but keeps scheme + host', () => {
  // Slack-style: token lives in the path.
  assert.equal(
    ch.redactUrl('https://hooks.slack.com/services/T000/B000/XXXXSECRET'),
    'https://hooks.slack.com/…',
  );
  // WeCom-style: token lives in the ?key= query.
  assert.equal(
    ch.redactUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET'),
    'https://qyapi.weixin.qq.com/…',
  );
  // A bare host with no path/query -> just scheme + host, no ellipsis.
  assert.equal(ch.redactUrl('https://example.com'), 'https://example.com');
  assert.equal(ch.redactUrl('https://example.com/'), 'https://example.com');
  // Empty input -> ''.
  assert.equal(ch.redactUrl(''), '');
  assert.equal(ch.redactUrl(null), '');
  assert.equal(ch.redactUrl(undefined), '');
  // Unparseable non-empty junk -> '(invalid)'.
  assert.equal(ch.redactUrl('not a url'), '(invalid)');
  // The secret tail never appears in the redacted form.
  assert.ok(!ch.redactUrl('https://hooks.slack.com/services/T000/B000/XXXXSECRET').includes('SECRET'));
});

test('renderText renders an unknown event verbatim with the info glyph', () => {
  const t = ch.renderText({ event: 'something-new', tunnel: null, host: null, lastError: null, machine: 'mac-studio' });
  assert.match(t, /\[tunlite\] something-new/);
  assert.match(t, /machine mac-studio/);
});
