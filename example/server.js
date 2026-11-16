// Serwer przykładowy: pokazuje podłączenie pakietu do aplikacji Express i służy
// jako `npm start` dla wspólnego testu uruchomienia w CI.
const express = require('express');
const { readVersion, healthz, createStats } = require('..');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.set('trust proxy', 1);

const version = readVersion();
app.locals.appVersion = version;

const stats = createStats({ file: process.env.STATS_DB || 'data/stats.sqlite' });
app.use(stats.middleware);
app.use(stats.panel);

app.get('/healthz', healthz({ version, checks: { db: () => stats.db.prepare('SELECT 1').get() } }));

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><title>vamude-kit</title>
<p>Serwer przykładowy vamude-kit. <a href="/healthz">/healthz</a> · <a href="/stats">/stats</a></p>
<footer><small>${version.label}</small></footer>`);
});

app.listen(PORT, HOST, () => {
  console.log(`vamude-kit (przykład) ${version.label} nasłuchuje na http://${HOST}:${PORT}`);
});
