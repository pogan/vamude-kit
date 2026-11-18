const test = require('node:test');
const assert = require('node:assert');
const { startApp, BROWSER } = require('./support/helpers');

const ADMIN = { ...BROWSER, 'x-admin': '1' };

test('bez zalogowanego admina: HTML przekierowuje do /kierownik, JSON 401', async (t) => {
  const a = await startApp();
  t.after(a.close);
  const html = await a.get('/kierownik/stats?okres=7d');
  assert.equal(html.status, 303);
  assert.equal(html.headers.get('location'), '/kierownik?next=%2Fkierownik%2Fstats%3Fokres%3D7d');
  assert.equal((await a.get('/kierownik/stats.json')).status, 401);
  // Stary adres i stare hasło już nie działają.
  process.env.STATS_PASSWORD = 'stare';
  t.after(() => delete process.env.STATS_PASSWORD);
  assert.equal((await a.get('/stats', { authorization: 'Bearer stare' })).status, 404);
});

test('zalogowany admin widzi panel i JSON', async (t) => {
  const a = await startApp();
  t.after(a.close);
  await a.get('/');
  await a.settle();

  const panel = await a.get('/kierownik/stats', ADMIN);
  assert.equal(panel.status, 200);
  assert.equal(panel.headers.get('x-robots-tag'), 'noindex');
  assert.match(panel.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
  const html = await panel.text();
  assert.match(html, /Unikalne osoby/);
  assert.match(html, /href="\/kierownik">← Kierownik/);

  const json = await a.get('/kierownik/stats.json?from=2026-11-16&to=2026-11-16', { 'x-admin': '1' });
  assert.equal(json.status, 200);
  const s = await json.json();
  assert.equal(s.pageviews, 1);
  assert.equal(s.from, '2026-11-16');

  // Wejścia do panelu i ruch admina nie są odsłonami strony.
  await a.get('/', ADMIN);
  await a.settle();
  assert.equal(a.rows().length, 1);
});

test('własny guard i adres panelu', async (t) => {
  const a = await startApp({ guard: (req) => req.get('x-szef') === '1', panelPath: '/kierownik/odwiedziny' });
  t.after(a.close);
  assert.equal((await a.get('/kierownik/odwiedziny')).status, 303);
  assert.equal((await a.get('/kierownik/odwiedziny', { ...BROWSER, 'x-szef': '1' })).status, 200);
});

test('okresy: domyślnie 30 dni, własny zakres, błędny zakres ignorowany', async (t) => {
  const a = await startApp();
  t.after(a.close);
  const range = async (q) => {
    const s = await (await a.get(`/kierownik/stats.json${q}`, { 'x-admin': '1' })).json();
    return [s.from, s.to];
  };
  assert.deepEqual(await range(''), ['2026-10-18', '2026-11-16']);
  assert.deepEqual(await range('?okres=poprzedni'), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(await range('?okres=rok'), ['2026-01-01', '2026-11-16']);
  assert.deepEqual(await range('?from=2026-11-01&to=2026-11-05'), ['2026-11-01', '2026-11-05']);
  assert.deepEqual(await range('?from=2026-11-05&to=2026-11-01'), ['2026-10-18', '2026-11-16']);
});

test('panel nadpisuje restrykcyjne CSP aplikacji (helmet przed panelem)', async (t) => {
  const express = require('express');
  const Database = require('better-sqlite3');
  const { createStats } = require('..');
  const app = express();
  app.use((req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'self'");
    res.locals.isAdmin = true;
    next();
  });
  app.use(createStats({ db: new Database(':memory:') }).panel);
  app.get('/', (req, res) => res.send('<p>start</p>'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const panel = await fetch(`${base}/kierownik/stats`);
  assert.equal(panel.status, 200);
  assert.match(panel.headers.get('content-security-policy'), /^default-src 'none'; style-src 'unsafe-inline'/);
  assert.equal((await fetch(`${base}/`)).headers.get('content-security-policy'), "default-src 'self'");
});
