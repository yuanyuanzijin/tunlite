'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { check, MIN_MAJOR } = require('../src/node-check');

test('node-check: accepts the minimum and newer majors', () => {
  for (const v of ['18.0.0', '18.20.4', '20.11.1', '22.16.0']) {
    assert.equal(check(v).ok, true, `${v} should be accepted`);
  }
});

test('node-check: rejects too-old majors with an actionable message', () => {
  for (const v of ['12.22.12', '14.21.3', '16.20.2', '17.9.1']) {
    const r = check(v);
    assert.equal(r.ok, false, `${v} should be rejected`);
    assert.match(r.message, /requires Node\.js >= 18/);
    assert.match(r.message, new RegExp(v.replace(/\./g, '\\.'))); // names the actual version
    assert.match(r.message, /nvm/); // points at the fix
  }
});

test('node-check: minimum major is 18', () => {
  assert.equal(MIN_MAJOR, 18);
  assert.equal(check('0.0.0', 17).ok, false);
  assert.equal(check('0.0.0', 18).ok, true);
});
