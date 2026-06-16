'use strict';

// Single source of truth for the package version. Consumed by cli.js,
// daemon.js, and update.js so the version is read in exactly one place.
module.exports = { VERSION: require('../package.json').version };
