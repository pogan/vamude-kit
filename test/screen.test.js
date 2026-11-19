const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { createStats } = require('..');
const { startApp, BROWSER } = require('./support/helpers');

const IPHONE = {
  'user-agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  'accept-language': 'pl-PL',
};
const IPAD_AS_MAC = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  'accept-language': 'pl-PL',
};
const ADMIN = { ...BROWSER, 'x-admin': '1' };

function beacon(a, headers, body) {
  return a.get('/_vk', { ...headers, 'content-type': 'text/plain;charset=UTF-8' }, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('skrypt pomiaru: JS z cache, nie jest odsłoną; szablon dostaje vkScript', async (t) => {
  let seen;
  const a = await startApp({}, (app) => app.get('/szablon', (req, res) => { seen = res.locals.vkScript; res.send('<p>x</p>'); }));
  t.after(a.close);
  const js = await a.get('/_vk.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /sendBeacon\(u,b\)/);
  await a.get('/szablon');
  await a.settle();
  assert.equal(seen, '<script src="/_vk.js" defer></script>');
  assert.deepEqual(a.rows().map((r) => r.path), ['/szablon']);
});

test('pomiar dopisuje ekran i okno do świeżej odsłony tej samej osoby', async (t) => {
  const a = await startApp();
  t.after(a.close);
  await a.get('/o-nas', IPHONE);
  await a.settle();
  const res = await beacon(a, IPHONE, { p: '/o-nas', sw: 390, sh: 844, vw: 390, vh: 664, dpr: 3, t: 5 });
  assert.equal(res.status, 204);
  await a.settle();
  const [row] = a.rows();
  assert.equal(row.screen, '390x844');
  assert.equal(row.viewport_w, 390);
  assert.equal(row.dpr, 3);
  assert.equal(row.device, 'telefon');

  const s = a.stats.summary({ from: '2026-11-16', to: '2026-11-16' });
  assert.equal(s.measuredPageviews, 1);
  assert.deepEqual(s.viewports.map((v) => v.name), ['360–413 px']);
  assert.deepEqual(s.screens.map((v) => v.name), ['390x844 @3x']);
  assert.deepEqual(
    s.combos.map((c) => [c.device, c.os, c.browser, c.viewport, c.visitors]),
    [['telefon', 'iOS', 'Safari', '360–413 px', 1]]
  );
});

test('iPad z Safari (udaje Maca) rozpoznany po ekranie dotykowym', async (t) => {
  const a = await startApp();
  t.after(a.close);
  await a.get('/', IPAD_AS_MAC);
  await a.settle();
  await beacon(a, IPAD_AS_MAC, { p: '/', sw: 820, sh: 1180, vw: 820, vh: 1106, dpr: 2, t: 5 });
  await a.settle();
  const [row] = a.rows();
  assert.equal(row.os, 'iOS');
  assert.equal(row.device, 'tablet');
});

test('pomiar bez pasującej odsłony niczego nie zmienia ani nie dodaje', async (t) => {
  const a = await startApp();
  t.after(a.close);
  // Brak odsłony w ogóle (np. admin albo wykluczona ścieżka).
  await beacon(a, IPHONE, { p: '/', sw: 390, sh: 844, vw: 390, vh: 664, dpr: 3 });
  await a.get('/', ADMIN);
  await beacon(a, ADMIN, { p: '/', sw: 1920, sh: 1080, vw: 1900, vh: 1000, dpr: 1 });
  await a.settle();
  assert.equal(a.rows().length, 0);

  // Inna osoba, inna ścieżka, po 5 minutach, drugi pomiar, śmieci.
  await a.get('/', IPHONE);
  await a.settle();
  await beacon(a, BROWSER, { p: '/', sw: 1920, sh: 1080, vw: 1900, vh: 1000, dpr: 1 });
  await beacon(a, IPHONE, { p: '/o-nas', sw: 390, sh: 844, vw: 390, vh: 664, dpr: 3 });
  await beacon(a, IPHONE, 'nie json');
  await beacon(a, IPHONE, { p: '/', vw: 'x' });
  await beacon(a, IPHONE, 'x'.repeat(2000));
  await a.settle();
  assert.equal(a.rows()[0].screen, null);
  a.clock.now += 6 * 60 * 1000;
  await beacon(a, IPHONE, { p: '/', sw: 390, sh: 844, vw: 390, vh: 664, dpr: 3 });
  await a.settle();
  assert.equal(a.rows()[0].screen, null);
  a.clock.now -= 6 * 60 * 1000;
  await beacon(a, IPHONE, { p: '/', sw: 390, sh: 844, vw: 390, vh: 664, dpr: 3 });
  await beacon(a, IPHONE, { p: '/', sw: 999, sh: 999, vw: 999, vh: 999, dpr: 1 });
  await a.settle();
  assert.equal(a.rows()[0].screen, '390x844');
  assert.equal(a.rows().length, 1);
});

test('panel: tabela kombinacji, okna, ekrany i udział', async (t) => {
  const a = await startApp();
  t.after(a.close);
  await a.get('/', IPHONE);
  await a.get('/', BROWSER);
  await a.settle();
  await beacon(a, IPHONE, { p: '/', sw: 390, sh: 844, vw: 390, vh: 664, dpr: 3 });
  await a.settle();
  const html = await (await a.get('/kierownik/stats', ADMIN)).text();
  assert.match(html, /Na czym oglądają stronę/);
  assert.match(html, /<td>telefon<\/td><td>iOS<\/td><td>Safari<\/td><td>360–413 px<\/td><td class="n">1<\/td><td class="n">50%<\/td>/);
  assert.match(html, /<td>komputer<\/td><td>Windows<\/td><td>Chrome<\/td><td>\(brak pomiaru\)<\/td>/);
  assert.match(html, /Szerokość okna/);
  assert.match(html, /390x844 @3/);
  const json = await (await a.get('/kierownik/stats.json', ADMIN)).json();
  assert.equal(json.combos.length, 2);
  assert.equal(json.measuredPageviews, 1);
});

test('beaconPath: false wyłącza pomiar', async (t) => {
  const a = await startApp({ beaconPath: false });
  t.after(a.close);
  assert.equal((await a.get('/_vk.js')).status, 404);
});

test('migracja: tabela z 2.1 dostaje nowe kolumny, stare wiersze zostają', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE vk_pageviews (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL, path TEXT NOT NULL,
    visitor TEXT NOT NULL, is_bot INTEGER NOT NULL, new_visitor INTEGER NOT NULL, new_visit INTEGER NOT NULL,
    referrer_host TEXT, referrer TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, browser TEXT, os TEXT, device TEXT)`);
  db.exec(`INSERT INTO vk_pageviews (ts, day, path, visitor, is_bot, new_visitor, new_visit, browser, os, device)
           VALUES (1, '2026-11-01', '/', 'v', 0, 1, 1, 'Safari', 'iOS', 'telefon')`);
  const stats = createStats({ db });
  const cols = db.prepare('PRAGMA table_info(vk_pageviews)').all().map((c) => c.name);
  for (const c of ['screen', 'viewport_w', 'viewport_h', 'dpr']) assert.ok(cols.includes(c), c);
  const s = stats.summary({ from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(s.viewports.map((v) => v.name), ['(brak pomiaru)']);
  createStats({ db }); // drugi start bez błędu
});
