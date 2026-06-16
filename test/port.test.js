'use strict';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');

test('isValidPort accepts only integers 1..65535', () => {
  for (const ok of [1, 22, 2222, 65535]) assert.equal(config.isValidPort(ok), true, `${ok}`);
  for (const bad of [0, -1, 65536, 22.5, NaN]) assert.equal(config.isValidPort(bad), false, `${bad}`);
});
