'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const core = require('../src/cli-core');

// Drive confirm() with a fake stdin line and a captured io. The prompt must be
// written through the injected io.out (the fix), and the y/N answer parsed.
function withFakeStdin(input, fn) {
  const fake = new Readable({ read() {} });
  fake.isTTY = false;
  const orig = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    const p = fn();
    fake.push(input);
    fake.push(null);
    return p;
  } finally {
    Object.defineProperty(process, 'stdin', orig);
  }
}

function capture() {
  const out = [];
  const err = [];
  return {
    io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

test('confirm writes the prompt through io.out (not process.stdout directly)', async () => {
  const c = capture();
  const answered = await withFakeStdin('y\n', () => core.confirm(c.io, 'delete "rev"? (y/N) '));
  assert.equal(answered, true);
  // The prompt is visible to a captured-io context — the seam the fix closes.
  assert.match(c.out(), /delete "rev"\? \(y\/N\)/);
});

test('confirm returns false for a non-yes answer', async () => {
  const c = capture();
  const answered = await withFakeStdin('\n', () => core.confirm(c.io, 'proceed? '));
  assert.equal(answered, false);
  assert.match(c.out(), /proceed\?/);
});

test('canPrompt is false when stdio is not a terminal (tests / CI)', () => {
  // Under `node --test` stdout is piped (not a tty), so neither the stdin+stdout
  // path nor the /dev/tty path qualifies — install onboarding stays non-interactive.
  assert.equal(core.canPrompt(), false);
});
