const test = require('node:test');
const assert = require('node:assert');
const { startApp, BROWSER, CHROME_WIN } = require('./support/helpers');

const MIN = 60 * 1000;
const as = (ip, extra = {}) => ({ ...BROWSER, 'x-forwarded-for': ip, ...extra });

test('liczy tylko strony HTML z kodem 200 pobrane GET-em', async (t) => {
  const a = await startApp({}, (app) => app.get('/healthz', (req, res) => res.send('<p>ok</p>')));
  t.after(a.close);
  await a.get('/');
  await a.get('/plik.css');
  await a.get('/stare');
  await a.get('/nie-ma');
  await a.get('/healthz');
  await a.get('/', BROWSER, { method: 'POST' });
  await a.get('/', { ...BROWSER, 'sec-purpose': 'prefetch' });
  await a.settle();
  assert.deepEqual(a.rows().map((r) => r.path), ['/']);
});

test('boty zapisuje z flagą, poza liczbami ludzi', async (t) => {
  const a = await startApp();
  t.after(a.close);
  await a.get('/', as('1.1.1.1', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }));
  await a.get('/', as('1.1.1.2', { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)' }));
  await a.get('/', { 'user-agent': CHROME_WIN, 'x-forwarded-for': '1.1.1.3' }); // brak Accept-Language
  await a.get('/', { 'x-forwarded-for': '1.1.1.4' }); // fetch wysyła wtedy własny User-Agent "node"
  await a.get('/', as('1.1.1.6', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1' }));
  await a.get('/', as('1.1.1.5'));
  await a.settle();
  assert.deepEqual(a.rows().map((r) => r.is_bot), [1, 1, 1, 1, 1, 0]);
  const s = a.stats.summary({ from: '2026-11-16', to: '2026-11-16' });
  assert.equal(s.pageviews, 1);
  assert.equal(s.visitors, 1);
  assert.equal(s.botPageviews, 5);
});

test('exclude aplikacji (np. admin) sprawdzany po obsłużeniu żądania', async (t) => {
  const a = await startApp({ exclude: (req, res) => res.locals.isAdmin }, (app) =>
    app.use((req, res, next) => { res.locals.isAdmin = req.get('x-admin') === '1'; next(); })
  );
  t.after(a.close);
  await a.get('/', as('2.2.2.2', { 'x-admin': '1' }));
  await a.get('/', as('2.2.2.3'));
  await a.settle();
  assert.equal(a.rows().length, 1);
});

test('wizyty, nowe i powracające osoby', async (t) => {
  const a = await startApp();
  t.after(a.close);
  const view = async (ip, path = '/', extra) => { await a.get(path, as(ip, extra)); await a.settle(); };

  // 15.11: osoba A raz.
  a.clock.now = Date.parse('2026-11-15T10:00:00Z');
  await view('10.0.0.1');
  // 16.11: A wraca (powracająca), dwie odsłony w jednej wizycie, potem druga wizyta po 31 min.
  a.clock.now = Date.parse('2026-11-16T10:00:00Z');
  await view('10.0.0.1');
  a.clock.now += 10 * MIN;
  await view('10.0.0.1', '/o-nas');
  a.clock.now += 31 * MIN;
  await view('10.0.0.1');
  // B: nowa, jedna wizyta. Nowsza wersja Chrome to ta sama osoba, Firefox z tego IP - inna.
  await view('10.0.0.2');
  a.clock.now += 5 * MIN;
  await view('10.0.0.2', '/', { 'user-agent': CHROME_WIN.replace('141.0.0.0', '142.0.0.0') });
  await view('10.0.0.2', '/', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0' });

  const day = a.stats.summary({ from: '2026-11-16', to: '2026-11-16' });
  assert.equal(day.pageviews, 6);
  assert.equal(day.visits, 4); // A: 2, B Chrome: 1, B Firefox: 1
  assert.equal(day.visitors, 3);
  assert.equal(day.newVisitors, 2);
  assert.equal(day.returningVisitors, 1);
  assert.equal(day.repeatVisitors, 1);
  assert.equal(day.visitsPerVisitor, 1.33);
  assert.deepEqual(day.daily, [{ day: '2026-11-16', pageviews: 6, visits: 4, visitors: 3 }]);
  assert.deepEqual(day.pages[0], { name: '/', pageviews: 5, visitors: 3 });

  const both = a.stats.summary({ from: '2026-11-15', to: '2026-11-16' });
  assert.equal(both.visitors, 3);
  assert.equal(both.newVisitors, 3);
  assert.equal(both.returningVisitors, 0);
  assert.equal(both.repeatVisitors, 1);
});

test('dzień liczony w strefie Europe/Warsaw', async (t) => {
  const a = await startApp();
  t.after(a.close);
  a.clock.now = Date.parse('2026-11-16T23:30:00Z'); // 17.11 00:30 w Polsce
  await a.get('/', as('3.3.3.3'));
  await a.settle();
  assert.equal(a.rows()[0].day, '2026-11-17');
});

test('źródło: zewnętrzny referrer bez zapytania, utm z linku, nawigacja wewnętrzna pomijana', async (t) => {
  const a = await startApp();
  t.after(a.close);
  await a.get('/', as('4.4.4.1', { referer: 'https://www.google.com/search?q=slub+humanistyczny' }));
  await a.get('/?utm_source=facebook&utm_medium=social&utm_campaign=jesien', as('4.4.4.2'));
  await a.get('/o-nas', as('4.4.4.3', { referer: `${a.base}/` }));
  await a.settle();
  const [g, fb, internal] = a.rows();
  assert.equal(g.referrer_host, 'google.com');
  assert.equal(g.referrer, 'https://www.google.com/search');
  assert.deepEqual([fb.utm_source, fb.utm_medium, fb.utm_campaign], ['facebook', 'social', 'jesien']);
  assert.equal(internal.referrer_host, null);
  const s = a.stats.summary({ from: '2026-11-16', to: '2026-11-16' });
  assert.deepEqual(s.sources.map((r) => r.name).sort(), ['(wejście bezpośrednie)', 'facebook', 'google.com']);
  assert.deepEqual(s.campaigns.map((r) => r.name), ['jesien']);
});

test('identyfikator nie zawiera IP, sekret jest stały w bazie', async (t) => {
  const a = await startApp();
  t.after(a.close);
  await a.get('/', as('5.5.5.5'));
  await a.settle();
  const [row] = a.rows();
  assert.match(row.visitor, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(row).includes('5.5.5.5'));
  const secret = a.stats.db.prepare("SELECT value FROM vk_meta WHERE key = 'secret'").get().value;
  const { createStats } = require('..');
  createStats({ db: a.stats.db }); // ponowny start aplikacji
  assert.equal(a.stats.db.prepare("SELECT value FROM vk_meta WHERE key = 'secret'").get().value, secret);
});
