const { readVersion } = require('./lib/version');
const { healthz } = require('./lib/healthz');
const { createStats } = require('./lib/stats');
const { createAdmin } = require('./lib/admin');

module.exports = { readVersion, healthz, createStats, createAdmin };
