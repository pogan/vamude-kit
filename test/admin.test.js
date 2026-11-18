const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { createStats, createAdmin } = require('..');
const { createVerifier } = require('../lib/google');
const { BROWSER } = require('./support/helpers');

const CLIENT = 'test-client.apps.googleusercontent.com';

// Token "od Google" w testach: JSON z polami, które zwróciłaby weryfikacja.
const fakeVerify = async (token) => {
  if (!token || token === 'zly') throw new Error('zły podpis');
  return JSON.parse(token);
};
const token = (email, verified = true) => JSON.stringify({ email, email_verified: verified });

async function startAdminApp({ env = {}, links } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries({ ADMIN_EMAILS: 'szef@example.com, Druga@Example.com', ...env })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const app = express();
  app.set('trust proxy', true);
  const stats = createStats({ db: new Database(':memory:') });
  const admin = createAdmin({ stats, clientId: CLIENT, verifyIdToken: fakeVerify, links });
  app.use(admin.middleware);
  app.use(stats.middleware);
  app.use(stats.panel);
  app.use(admin.router);
  app.get('/kierownik/zamowienia', admin.requireAdmin, (req, res) => res.send('<p>zamówienia</p>'));
  app.get('/', (req, res) => res.send(`<p>${res.locals.isAdmin ? 'admin' : 'gość'}</p>`));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, { headers = {}, ...init } = {}) =>
    fetch(base + path, { redirect: 'manual', ...init, headers: { ...BROWSER, ...headers } });
  const post = (path, body, headers = {}) =>
    req(path, {
      method: 'POST',
      body: new URLSearchParams(body),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
  const close = () => {
    server.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { base, req, post, stats, close };
}

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('strona logowania z przyciskiem Google, nonce i nagłówkami dla GIS', async (t) => {
  const a = await startAdminApp();
  t.after(a.close);
  const res = await a.req('/kierownik?next=/kierownik/stats');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(`data-client_id="${CLIENT}"`));
  assert.match(html, /name="next" value="\/kierownik\/stats"/);
  assert.doesNotMatch(html, /administrator podglądu/);
  const csp = res.headers.get('content-security-policy');
  const nonce = /'nonce-([^']+)'/.exec(csp)[1];
  assert.match(html, new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}">`));
  assert.match(csp, /frame-src https:\/\/accounts\.google\.com\/gsi\//);
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('logowanie kontem z ADMIN_EMAILS: sesja, panel, statystyki, wylogowanie', async (t) => {
  const a = await startAdminApp();
  t.after(a.close);
  const login = await a.post('/kierownik/login', { credential: token('druga@example.com'), next: '/kierownik/stats' });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/kierownik/stats');
  assert.match(login.headers.get('set-cookie'), /^vk_admin=.+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
  const cookie = cookieOf(login);

  const dash = await a.req('/kierownik', { headers: { cookie } });
  const html = await dash.text();
  assert.match(html, /zalogowano: druga@example\.com/);
  assert.match(html, /href="\/kierownik\/stats"/);
  assert.equal((await a.req('/kierownik/stats', { headers: { cookie } })).status, 200);
  assert.equal((await a.req('/kierownik/zamowienia', { headers: { cookie } })).status, 200);
  assert.equal(await (await a.req('/', { headers: { cookie } })).text(), '<p>admin</p>');

  const out = await a.post('/kierownik/wyloguj', {}, { cookie });
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie'), /^vk_admin=; Path=\/; Max-Age=0/);
});

test('ruch zalogowanego admina nie trafia do statystyk', async (t) => {
  const a = await startAdminApp();
  t.after(a.close);
  const cookie = cookieOf(await a.post('/kierownik/login', { credential: token('szef@example.com') }));
  await a.req('/', { headers: { cookie } });
  await a.req('/');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.stats.db.prepare('SELECT COUNT(*) AS n FROM vk_pageviews').get().n, 1);
});

test('odmowy: konto spoza listy, niepotwierdzony e-mail, zły token, obca strona, przekierowanie poza stronę', async (t) => {
  const a = await startAdminApp();
  t.after(a.close);
  assert.equal((await a.post('/kierownik/login', { credential: token('obcy@example.com') })).status, 403);
  assert.equal((await a.post('/kierownik/login', { credential: token('szef@example.com', false) })).status, 403);
  assert.equal((await a.post('/kierownik/login', { credential: 'zly' })).status, 401);
  const foreign = await a.post('/kierownik/login', { credential: token('szef@example.com') }, { origin: 'https://zla.example' });
  assert.equal(foreign.status, 403);
  const evil = await a.post('/kierownik/login', { credential: token('szef@example.com'), next: '//zla.example/x' });
  assert.equal(evil.headers.get('location'), '/kierownik');
  // Bez logowania: chronione trasy odsyłają do /kierownik.
  const guarded = await a.req('/kierownik/zamowienia');
  assert.equal(guarded.status, 303);
  assert.equal(guarded.headers.get('location'), '/kierownik?next=%2Fkierownik%2Fzamowienia');
});

test('usunięcie adresu z ADMIN_EMAILS odbiera dostęp od razu; podrobione ciasteczko nie działa', async (t) => {
  const a = await startAdminApp();
  t.after(a.close);
  const cookie = cookieOf(await a.post('/kierownik/login', { credential: token('szef@example.com') }));
  assert.equal((await a.req('/kierownik/stats', { headers: { cookie } })).status, 200);
  const forged = cookie.replace(/\.[^.]+$/, '.AAAA');
  assert.equal((await a.req('/kierownik/stats', { headers: { cookie: forged } })).status, 303);
  process.env.ADMIN_EMAILS = 'druga@example.com';
  assert.equal((await a.req('/kierownik/stats', { headers: { cookie } })).status, 303);
});

test('logowanie JSON (np. z okna na stronie aplikacji)', async (t) => {
  const a = await startAdminApp();
  t.after(a.close);
  const res = await a.req('/kierownik/login', {
    method: 'POST',
    body: JSON.stringify({ credential: token('szef@example.com') }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, email: 'szef@example.com' });
  const bad = await a.req('/kierownik/login', {
    method: 'POST',
    body: JSON.stringify({ credential: token('obcy@example.com') }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).ok, false);
});

test('blokada po 10 nieudanych próbach', async (t) => {
  const a = await startAdminApp();
  t.after(a.close);
  for (let i = 0; i < 10; i++) await a.post('/kierownik/login', { credential: 'zly' });
  assert.equal((await a.post('/kierownik/login', { credential: token('szef@example.com') })).status, 429);
});

test('logowanie podglądu tylko z PREVIEW_LOGIN=true i na hoście podglądu', async (t) => {
  const a = await startAdminApp({ env: { PREVIEW_LOGIN: 'true' } });
  t.after(a.close);
  const host = { 'x-forwarded-host': 'bdik.staging.vamude.com' };
  assert.match(await (await a.req('/kierownik', { headers: host })).text(), /administrator podglądu/);
  const res = await a.post('/kierownik/podglad', { next: '/kierownik/stats' }, host);
  assert.equal(res.status, 303);
  const cookie = cookieOf(res);
  assert.equal((await a.req('/kierownik/stats', { headers: { ...host, cookie } })).status, 200);
  // Ta sama sesja na innym hoście (np. produkcyjnym) nic nie daje.
  assert.equal((await a.req('/kierownik/stats', { headers: { 'x-forwarded-host': 'bdik.pl', cookie } })).status, 303);
  assert.equal((await a.post('/kierownik/podglad', {}, { 'x-forwarded-host': 'bdik.pl' })).status, 404);
  process.env.PREVIEW_LOGIN = '';
  assert.equal((await a.req('/kierownik/stats', { headers: { ...host, cookie } })).status, 303);
});

test('dodatkowe pozycje panelu', async (t) => {
  const a = await startAdminApp({ links: [{ href: '/kierownik/zamowienia', label: 'Zamówienia' }] });
  t.after(a.close);
  const cookie = cookieOf(await a.post('/kierownik/login', { credential: token('szef@example.com') }));
  assert.match(await (await a.req('/kierownik', { headers: { cookie } })).text(), /href="\/kierownik\/zamowienia">Zamówienia/);
});

// --- Weryfikacja tokenu Google (podpis RS256, wystawca, odbiorca, ważność) ---
test('weryfikacja tokenu Google', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Date.parse('2026-11-18T12:00:00Z');
  const verify = createVerifier({ clientId: CLIENT, getKey: async (kid) => (kid === 'k1' ? publicKey : null), now: () => now });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload, { kid = 'k1', key = privateKey } = {}) => {
    const data = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(payload)}`;
    return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
  };
  const t = Math.floor(now / 1000);
  const good = { iss: 'https://accounts.google.com', aud: CLIENT, exp: t + 3600, iat: t, email: 'a@b.pl', email_verified: true };

  assert.equal((await verify(sign(good))).email, 'a@b.pl');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verify(sign(good, { key: other })), /zły podpis/);
  await assert.rejects(verify(sign(good, { kid: 'k2' })), /nieznany klucz/);
  await assert.rejects(verify(sign({ ...good, aud: 'inna' })), /innej aplikacji/);
  await assert.rejects(verify(sign({ ...good, iss: 'https://evil' })), /wystawca/);
  await assert.rejects(verify(sign({ ...good, exp: t - 120 })), /wygasł/);
  await assert.rejects(verify('a.b'), /JWT/);
});
