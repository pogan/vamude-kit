const test = require('node:test');
const assert = require('node:assert');
const { startApp, BROWSER } = require('./support/helpers');

const PASS = 'tajne-haslo-testowe';
const form = (password) => ({
  method: 'POST',
  body: new URLSearchParams({ password }),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

test.beforeEach(() => { process.env.STATS_PASSWORD = PASS; });
test.afterEach(() => { delete process.env.STATS_PASSWORD; });

test('bez hasła i guard panelu nie ma', async (t) => {
  delete process.env.STATS_PASSWORD;
  const a = await startApp();
  t.after(a.close);
  assert.equal((await a.get('/stats')).status, 404);
  assert.equal((await a.get('/stats.json')).status, 404);
});

test('logowanie hasłem, ciasteczko, panel i JSON', async (t) => {
  const a = await startApp();
  t.after(a.close);
  await a.get('/');
  await a.settle();

  const loginForm = await a.get('/stats');
  assert.equal(loginForm.status, 200);
  assert.match(await loginForm.text(), /type="password"/);
  assert.equal((await a.get('/stats.json')).status, 401);
  assert.equal((await a.get('/stats', BROWSER, form('zle'))).status, 401);

  const ok = await a.get('/stats', BROWSER, form(PASS));
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);

  const panel = await a.get('/stats', { ...BROWSER, cookie });
  assert.equal(panel.status, 200);
  assert.equal(panel.headers.get('x-robots-tag'), 'noindex');
  assert.match(panel.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
  const html = await panel.text();
  assert.match(html, /Unikalne osoby/);
  assert.match(html, /Powracające osoby/);

  const json = await a.get('/stats.json?from=2026-11-16&to=2026-11-16', { authorization: `Bearer ${PASS}` });
  assert.equal(json.status, 200);
  const s = await json.json();
  assert.equal(s.pageviews, 1);
  assert.equal(s.from, '2026-11-16');

  // Wejścia do panelu nie są odsłonami strony.
  await a.settle();
  assert.equal(a.rows().length, 1);
});

test('blokada po 10 błędnych hasłach', async (t) => {
  const a = await startApp();
  t.after(a.close);
  for (let i = 0; i < 10; i++) await a.get('/stats', BROWSER, form('zle'));
  assert.equal((await a.get('/stats', BROWSER, form(PASS))).status, 429);
});

test('guard aplikacji zastępuje hasło', async (t) => {
  delete process.env.STATS_PASSWORD;
  const a = await startApp({ guard: (req) => req.get('x-admin') === '1', panelPath: '/admin/statystyki' });
  t.after(a.close);
  assert.equal((await a.get('/admin/statystyki')).status, 404);
  assert.equal((await a.get('/admin/statystyki', { ...BROWSER, 'x-admin': '1' })).status, 200);
  assert.equal((await a.get('/admin/statystyki.json', { 'x-admin': '1' })).status, 200);
});

test('okresy: domyślnie 30 dni, własny zakres, błędny zakres ignorowany', async (t) => {
  const a = await startApp();
  t.after(a.close);
  const auth = { authorization: `Bearer ${PASS}` };
  const range = async (q) => { const s = await (await a.get(`/stats.json${q}`, auth)).json(); return [s.from, s.to]; };
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
  app.use((req, res, next) => { res.set('Content-Security-Policy', "default-src 'self'"); next(); });
  app.use(createStats({ db: new Database(':memory:') }).panel);
  app.get('/', (req, res) => res.send('<p>start</p>'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const panel = await fetch(`${base}/stats`, { headers: { authorization: `Bearer ${PASS}` } });
  assert.match(panel.headers.get('content-security-policy'), /^default-src 'none'; style-src 'unsafe-inline'/);
  // Reszta aplikacji zachowuje swoją politykę.
  assert.equal((await fetch(`${base}/`)).headers.get('content-security-policy'), "default-src 'self'");
});
