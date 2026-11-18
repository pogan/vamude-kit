const { readVersion } = require('./lib/version');
const { healthz } = require('./lib/healthz');
const { createStats } = require('./lib/stats');
const { createAdmin } = require('./lib/admin');
const { escapeHtml } = require('./lib/statsPanel');

module.exports = { readVersion, healthz, createStats, createAdmin, escapeHtml };
