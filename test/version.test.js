'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { VERSION } = require('../src/version');
const pkg = require('../package.json');

test('version module mirrors package.json', () => {
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
