'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const paths = require('../src/paths');

test('expandHome expands leading ~', () => {
  assert.equal(paths.expandHome('~/foo'), path.join(os.homedir(), 'foo'));
  assert.equal(paths.expandHome('~'), os.homedir());
  assert.equal(paths.expandHome('/abs/path'), '/abs/path');
  assert.equal(paths.expandHome(null), null);
});

test('TUNLITE_HOME relocates config and data under one root', () => {
  const prev = process.env.TUNLITE_HOME;
  process.env.TUNLITE_HOME = '/tmp/tunlite-root';
  try {
    assert.equal(paths.configDir(), path.join('/tmp/tunlite-root', 'config'));
    assert.equal(paths.dataDir(), path.join('/tmp/tunlite-root', 'data'));
    assert.equal(paths.configFile(), path.join('/tmp/tunlite-root', 'config', 'config.json'));
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_HOME;
    else process.env.TUNLITE_HOME = prev;
  }
});

test('TUNLITE_SOCKET overrides socket path', () => {
  const prev = process.env.TUNLITE_SOCKET;
  process.env.TUNLITE_SOCKET = '/tmp/custom.sock';
  try {
    assert.equal(paths.socketPath(), '/tmp/custom.sock');
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_SOCKET;
    else process.env.TUNLITE_SOCKET = prev;
  }
});

test('libDir under TUNLITE_HOME is <root>/lib', () => {
  const prev = process.env.TUNLITE_HOME;
  process.env.TUNLITE_HOME = '/tmp/tlhome';
  try {
    assert.equal(paths.libDir(), path.join('/tmp/tlhome', 'lib'));
    assert.equal(paths.installManifestFile(), path.join('/tmp/tlhome', 'data', 'install.json'));
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prev;
  }
});

test('lockDir under TUNLITE_HOME is <root>/data/locks', () => {
  const prev = process.env.TUNLITE_HOME;
  process.env.TUNLITE_HOME = '/tmp/tllocks';
  try {
    assert.equal(paths.lockDir(), path.join('/tmp/tllocks', 'data', 'locks'));
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prev;
  }
});
