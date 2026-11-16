const express = require('express');
const Database = require('better-sqlite3');
const { createStats } = require('../..');

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const BROWSER = { 'user-agent': CHROME_WIN, 'accept-language': 'pl-PL,pl;q=0.9' };

// Aplikacja testowa ze statystykami w pamięci i sterowanym zegarem.
async function startApp(statsOptions = {}, setup = () => {}) {
  const clock = { now: Date.parse('2026-11-16T10:00:00Z') };
  const app = express();
  app.set('trust proxy', true);
  const stats = createStats({ db: new Database(':memory:'), now: () => clock.now, ...statsOptions });
  app.use(stats.middleware);
  app.use(stats.panel);
  setup(app);
  app.get('/', (req, res) => res.send('<p>start</p>'));
  app.get('/o-nas', (req, res) => res.send('<p>o nas</p>'));
  app.get('/plik.css', (req, res) => res.type('css').send('body{}'));
  app.get('/stare', (req, res) => res.redirect('/'));
  app.post('/', (req, res) => res.send('<p>post</p>'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, headers = BROWSER, init = {}) => fetch(base + path, { headers, redirect: 'manual', ...init });
  const rows = () => stats.db.prepare('SELECT * FROM vk_pageviews ORDER BY id').all();
  // Zapis odsłony dzieje się po wysłaniu odpowiedzi - chwila na zdarzenie "finish".
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { app, stats, clock, base, get, rows, settle, close: () => server.close() };
}

module.exports = { startApp, BROWSER, CHROME_WIN };
