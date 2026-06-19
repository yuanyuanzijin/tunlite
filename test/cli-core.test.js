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

test('levenshtein counts single-edit distances', () => {
  assert.equal(core.levenshtein('enable', 'enable'), 0);
  assert.equal(core.levenshtein('enabl', 'enable'), 1);   // deletion
  assert.equal(core.levenshtein('instal', 'install'), 1); // deletion
  assert.equal(core.levenshtein('stauts', 'status'), 2);  // transposition = 2
  assert.equal(core.levenshtein('', 'abc'), 3);
});

test('suggest: aliases win, then nearest plausible typo, else null', () => {
  const cmds = ['enable', 'disable', 'restart', 'status', 'install', 'list'];
  const aliases = { up: 'enable', down: 'disable' };
  // wrong-word aliases win outright (large edit distance)
  assert.equal(core.suggest('up', cmds, aliases), 'enable');
  assert.equal(core.suggest('down', cmds, aliases), 'disable');
  // typos resolve to the nearest command
  assert.equal(core.suggest('enabl', cmds, aliases), 'enable');
  assert.equal(core.suggest('stauts', cmds, aliases), 'status');
  assert.equal(core.suggest('instal', cmds, aliases), 'install');
  // too far -> no suggestion (avoid noise)
  assert.equal(core.suggest('zzzzzz', cmds, aliases), null);
  assert.equal(core.suggest('xy', cmds, aliases), null);
});
