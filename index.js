const { readVersion } = require('./lib/version');
const { healthz } = require('./lib/healthz');
const { createStats } = require('./lib/stats');

module.exports = { readVersion, healthz, createStats };
