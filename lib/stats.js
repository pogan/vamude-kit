// Statystyki odwiedzin zapisywane po stronie serwera w SQLite aplikacji - bez
// ciasteczek i skryptów firm trzecich. Każda odsłona to osobny wiersz; nic nie
// jest kasowane automatycznie (przegląd danych pod kątem RODO robimy ręcznie,
// według osobnej procedury).
//
// Odwiedzający = HMAC-SHA256(sekret, IP + rodzina przeglądarki + system). Sekret
// jest losowy, stały i leży tylko w bazie aplikacji, więc bez niej skrótu nie da
// się odwrócić. Wersji przeglądarki nie bierzemy pod uwagę, bo zmienia się co
// kilka tygodni i ta sama osoba wyglądałaby jak nowa.
//
// Ekran i okno (od 2.2.0): serwer ich nie widzi, więc strona ładuje mały
// własny skrypt (<beaconPath>.js), który po wczytaniu wysyła jeden POST z
// rozmiarem ekranu, okna i gęstością pikseli. Serwer dopisuje te liczby do
// odsłony, którą właśnie zapisał (ten sam odwiedzający i ścieżka, ostatnie
// minuty). Bez ciasteczek i bez identyfikatorów; ekran nie wchodzi do skrótu
// odwiedzającego. Odsłony bez pomiaru (boty, wyłączony JS, stare dane) mają
// te kolumny puste.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isbot } = require('isbot');
const { parseUserAgent } = require('./userAgent');
const { createPanel } = require('./statsPanel');

const VISIT_GAP_MS = 30 * 60 * 1000;
const DEFAULT_EXCLUDED_PREFIXES = ['/healthz', '/api', '/kierownik', '/admin', '/auth'];
const MAX_TEXT = 300;
const BEACON_WINDOW_MS = 5 * 60 * 1000;
const BEACON_MAX_BYTES = 512;

// Przedziały szerokości okna (CSS px) - tak, jak projektuje się widoki strony.
const VIEWPORT_BUCKETS = [
  [360, '< 360 px'],
  [414, '360–413 px'],
  [600, '414–599 px'],
  [1024, '600–1023 px'],
  [1280, '1024–1279 px'],
  [1440, '1280–1439 px'],
  [1920, '1440–1919 px'],
  [Infinity, '≥ 1920 px'],
];
const NO_MEASUREMENT = '(brak pomiaru)';
const VIEWPORT_SQL = `CASE WHEN viewport_w IS NULL THEN '${NO_MEASUREMENT}' ${VIEWPORT_BUCKETS.slice(0, -1)
  .map(([max, label]) => `WHEN viewport_w < ${max} THEN '${label}'`)
  .join(' ')} ELSE '${VIEWPORT_BUCKETS.at(-1)[1]}' END`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS vk_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vk_pageviews (
    id            INTEGER PRIMARY KEY,
    ts            INTEGER NOT NULL,          -- czas w ms (Unix)
    day           TEXT    NOT NULL,          -- RRRR-MM-DD w strefie czasowej panelu
    path          TEXT    NOT NULL,
    visitor       TEXT    NOT NULL,          -- HMAC, patrz nagłówek pliku
    is_bot        INTEGER NOT NULL,
    new_visitor   INTEGER NOT NULL,          -- pierwsza odsłona tego odwiedzającego w ogóle
    new_visit     INTEGER NOT NULL,          -- pierwsza odsłona wizyty (przerwa > 30 min)
    referrer_host TEXT,
    referrer      TEXT,                      -- bez parametrów zapytania
    utm_source    TEXT,
    utm_medium    TEXT,
    utm_campaign  TEXT,
    browser       TEXT,
    os            TEXT,
    device        TEXT
  );
  CREATE INDEX IF NOT EXISTS vk_pageviews_day ON vk_pageviews (day, is_bot);
  CREATE INDEX IF NOT EXISTS vk_pageviews_visitor ON vk_pageviews (visitor, is_bot, ts);
`;

// Kolumny dodane po 1.0 - CREATE TABLE IF NOT EXISTS nie zmienia istniejącej tabeli.
const ADDED_COLUMNS = [
  ['screen', 'TEXT'], // ekran w CSS px, np. "390x844"
  ['viewport_w', 'INTEGER'], // szerokość okna przeglądarki
  ['viewport_h', 'INTEGER'],
  ['dpr', 'REAL'], // gęstość pikseli (devicePixelRatio)
];

function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(vk_pageviews)').all().map((c) => c.name));
  for (const [name, type] of ADDED_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE vk_pageviews ADD COLUMN ${name} ${type}`);
  }
}

// Skrypt pomiaru: bez zależności, bez ciasteczek, błędy po cichu. sendBeacon
// z tekstem wysyła text/plain - bez zapytania CORS i bez czekania na odpowiedź.
function beaconScript(url) {
  return `(function(){try{var u=${JSON.stringify(url)},s=window.screen||{},b=JSON.stringify({p:location.pathname,sw:s.width,sh:s.height,vw:window.innerWidth,vh:window.innerHeight,dpr:window.devicePixelRatio||1,t:navigator.maxTouchPoints||0});if(navigator.sendBeacon){navigator.sendBeacon(u,b)}else{fetch(u,{method:"POST",body:b,keepalive:true,credentials:"omit"})}}catch(e){}})();\n`;
}

function intIn(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
}

function readBody(req) {
  // Aplikacja mogła już odczytać treść własnym parserem (np. express.text()).
  if (typeof req.body === 'string') return Promise.resolve(req.body);
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
    return Promise.resolve(JSON.stringify(req.body));
  }
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= BEACON_MAX_BYTES) chunks.push(c);
    });
    req.on('end', () => resolve(size <= BEACON_MAX_BYTES ? Buffer.concat(chunks).toString('utf8') : ''));
    req.on('error', () => resolve(''));
  });
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT) : null;
}

function openDb(file) {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  return db;
}

function dayIn(timeZone) {
  // en-CA formatuje datę jako RRRR-MM-DD.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (ts) => fmt.format(new Date(ts));
}

// Zewnętrzny referrer: host i ścieżka bez zapytania (tam bywają frazy i tokeny).
// Przejścia w obrębie tej samej strony nie są źródłem wizyty.
function parseReferrer(value, ownHost) {
  if (!value) return { host: null, url: null };
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');
    if (host === String(ownHost || '').replace(/^www\./, '')) return { host: null, url: null };
    return { host, url: clean(`${url.origin}${url.pathname}`) };
  } catch {
    return { host: null, url: null };
  }
}

// Opcje:
//   db          - instancja better-sqlite3 aplikacji (tabele vk_* obok jej tabel); bez niej
//                 osobny plik `file` (domyślnie data/stats.sqlite w katalogu aplikacji)
//   exclude     - (req, res) => true, gdy odsłony nie liczyć; ruch zalogowanego admina
//                 (res.locals.isAdmin) jest pomijany zawsze
//   excludePrefixes - ścieżki pomijane w całości (domyślnie /healthz, /api, /kierownik, /admin, /auth)
//   panelPath   - adres panelu (domyślnie /kierownik/stats)
//   loginPath   - logowanie administratora (domyślnie /kierownik)
//   guard       - (req, res) => true, gdy wolno otworzyć panel (domyślnie res.locals.isAdmin)
//   sections    - ({ req, from, to }) => HTML dodatkowych sekcji panelu (np. lejek sprzedaży)
//   timeZone    - strefa dni w panelu (domyślnie Europe/Warsaw)
//   beaconPath  - adres pomiaru ekranu (domyślnie /_vk; skrypt pod /_vk.js); false wyłącza
function createStats(options = {}) {
  const {
    file = path.join(process.cwd(), 'data', 'stats.sqlite'),
    exclude = () => false,
    excludePrefixes = DEFAULT_EXCLUDED_PREFIXES,
    panelPath = '/kierownik/stats',
    loginPath = '/kierownik',
    timeZone = 'Europe/Warsaw',
    beaconPath = '/_vk',
    now = Date.now,
  } = options;
  const db = options.db || openDb(file);
  db.exec(SCHEMA);
  migrate(db);
  const scriptPath = beaconPath ? `${beaconPath}.js` : null;
  const scriptBody = beaconPath ? beaconScript(beaconPath) : '';
  const scriptTag = beaconPath ? `<script src="${scriptPath}" defer></script>` : '';

  db.prepare("INSERT OR IGNORE INTO vk_meta (key, value) VALUES ('secret', ?)").run(
    crypto.randomBytes(32).toString('hex')
  );
  const secret = db.prepare("SELECT value FROM vk_meta WHERE key = 'secret'").get().value;
  const toDay = dayIn(timeZone);

  const lastSeen = db.prepare(
    'SELECT ts FROM vk_pageviews WHERE visitor = ? AND is_bot = ? ORDER BY ts DESC LIMIT 1'
  );
  const insert = db.prepare(`
    INSERT INTO vk_pageviews (ts, day, path, visitor, is_bot, new_visitor, new_visit, referrer_host, referrer,
                              utm_source, utm_medium, utm_campaign, browser, os, device)
    VALUES (@ts, @day, @path, @visitor, @is_bot, @new_visitor, @new_visit, @referrer_host, @referrer,
            @utm_source, @utm_medium, @utm_campaign, @browser, @os, @device)
  `);

  const forBeacon = db.prepare(`
    SELECT id, os, device FROM vk_pageviews
    WHERE visitor = ? AND path = ? AND screen IS NULL AND ts >= ?
    ORDER BY ts DESC LIMIT 1
  `);
  const setScreen = db.prepare(`
    UPDATE vk_pageviews SET screen = @screen, viewport_w = @vw, viewport_h = @vh, dpr = @dpr,
                            os = @os, device = @device
    WHERE id = @id
  `);

  function visitorId(ip, ua) {
    return crypto.createHmac('sha256', secret).update(`${ip}|${ua.browser}|${ua.os}`).digest('hex').slice(0, 32);
  }

  // Każda przeglądarka wysyła Accept-Language z kodem języka; brak nagłówka albo
  // samo "*" (domyślne w fetch z Node) to prawie zawsze skrypt. Boty zapisujemy
  // z flagą zamiast je pomijać, żeby panel pokazywał ich udział.
  function isBotRequest(req) {
    const ua = req.get('user-agent') || '';
    return !ua || isbot(ua) || !/^\s*[a-z]{2,3}\b/i.test(req.get('accept-language') || '');
  }

  function record(req) {
    const ts = now();
    const uaString = req.get('user-agent') || '';
    const ua = parseUserAgent(uaString);
    const bot = isBotRequest(req) ? 1 : 0;
    const visitor = visitorId(req.ip || '', ua);
    const last = lastSeen.get(visitor, bot);
    const ref = parseReferrer(req.get('referer'), req.hostname);
    const q = req.query || {};
    insert.run({
      ts,
      day: toDay(ts),
      path: req.path.slice(0, MAX_TEXT),
      visitor,
      is_bot: bot,
      new_visitor: last ? 0 : 1,
      new_visit: !last || ts - last.ts > VISIT_GAP_MS ? 1 : 0,
      referrer_host: ref.host,
      referrer: ref.url,
      utm_source: clean(q.utm_source),
      utm_medium: clean(q.utm_medium),
      utm_campaign: clean(q.utm_campaign),
      browser: ua.browser,
      os: ua.os,
      device: ua.device,
    });
  }

  // Dopisuje ekran do świeżej odsłony tego samego odwiedzającego. Bez pasującej
  // odsłony (admin, wykluczona ścieżka, minęło 5 min, już zmierzona) nic nie robi,
  // więc z zewnątrz nie da się tym dodać ani nadpisać danych.
  async function recordBeacon(req) {
    let data;
    try {
      data = JSON.parse(await readBody(req));
    } catch {
      return;
    }
    if (!data || typeof data.p !== 'string' || !data.p.startsWith('/')) return;
    const sw = intIn(data.sw, 100, 10000);
    const sh = intIn(data.sh, 100, 10000);
    const vw = intIn(data.vw, 100, 10000);
    const vh = intIn(data.vh, 100, 10000);
    const dpr = Number.isFinite(Number(data.dpr)) ? Math.min(Math.max(Number(data.dpr), 0.5), 5) : null;
    const touch = intIn(data.t, 0, 32) || 0;
    if (!vw) return;
    const ua = parseUserAgent(req.get('user-agent') || '');
    const row = forBeacon.get(visitorId(req.ip || '', ua), data.p.slice(0, MAX_TEXT), now() - BEACON_WINDOW_MS);
    if (!row) return;
    // iPadOS (Safari) przedstawia się jak Mac; Mac nie ma ekranu dotykowego.
    const iPad = row.os === 'macOS' && touch > 1;
    setScreen.run({
      id: row.id,
      screen: sw && sh ? `${sw}x${sh}` : null,
      vw,
      vh,
      dpr: dpr === null ? null : Math.round(dpr * 100) / 100,
      os: iPad ? 'iOS' : row.os,
      device: iPad ? 'tablet' : row.device,
    });
  }

  function beacon(req, res) {
    if (req.method === 'GET' && req.path === scriptPath) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.type('application/javascript').send(scriptBody);
    }
    if (req.method !== 'POST') return false;
    recordBeacon(req)
      .catch((err) => console.error('[stats] pomiar ekranu:', err.message))
      .finally(() => res.status(204).end());
    return true;
  }

  function skipped(req) {
    if (req.method !== 'GET') return true;
    // Spekulatywne pobranie strony przez przeglądarkę to jeszcze nie odsłona.
    if (/prefetch|prerender/.test(`${req.get('sec-purpose') || ''} ${req.get('purpose') || ''}`)) return true;
    const p = req.path;
    if (p === panelPath || p === `${panelPath}.json`) return true;
    return excludePrefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
  }

  // Liczone po wysłaniu odpowiedzi: tylko strony HTML z kodem 200, czyli bez
  // zasobów statycznych, przekierowań i 404 skanerów (wp-login.php itp.).
  // `exclude` sprawdzamy dopiero wtedy, bo np. flagę admina ustawia middleware
  // zamontowany później.
  function middleware(req, res, next) {
    if (beaconPath && (req.path === beaconPath || req.path === scriptPath)) {
      if (beacon(req, res) !== false) return undefined;
      return next();
    }
    // Do szablonów: <%- vkScript %> przed </body>.
    res.locals.vkScript = scriptTag;
    if (!skipped(req)) {
      res.on('finish', () => {
        try {
          if (res.statusCode !== 200) return;
          if (!/^text\/html/.test(String(res.get('content-type') || ''))) return;
          if (res.locals.isAdmin || exclude(req, res)) return;
          record(req);
        } catch (err) {
          console.error('[stats] nie zapisano odsłony:', err.message);
        }
      });
    }
    next();
  }

  const queries = createQueries(db);
  const panel = createPanel({
    panelPath,
    loginPath,
    guard: options.guard,
    sections: options.sections,
    queries,
    today: () => toDay(now()),
  });
  return { middleware, panel, summary: queries.summary, db, scriptTag };
}

// --- Zestawienia ----------------------------------------------------------
function createQueries(db) {
  const range = 'day BETWEEN @from AND @to';
  const totals = db.prepare(`
    SELECT COUNT(*) AS pageviews,
           COALESCE(SUM(new_visit), 0) AS visits,
           COUNT(DISTINCT visitor) AS visitors,
           COALESCE(SUM(new_visitor), 0) AS newVisitors
    FROM vk_pageviews WHERE is_bot = 0 AND ${range}
  `);
  const repeat = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT visitor FROM vk_pageviews WHERE is_bot = 0 AND ${range}
      GROUP BY visitor HAVING SUM(new_visit) >= 2
    )
  `);
  const bots = db.prepare(`SELECT COUNT(*) AS n FROM vk_pageviews WHERE is_bot = 1 AND ${range}`);
  const daily = db.prepare(`
    SELECT day, COUNT(*) AS pageviews, SUM(new_visit) AS visits, COUNT(DISTINCT visitor) AS visitors
    FROM vk_pageviews WHERE is_bot = 0 AND ${range} GROUP BY day ORDER BY day
  `);
  const top = (column, where = '') =>
    db.prepare(`
      SELECT ${column} AS name, COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS visitors
      FROM vk_pageviews WHERE is_bot = 0 AND ${range} ${where}
      GROUP BY name ORDER BY visitors DESC, pageviews DESC LIMIT @limit
    `);
  const topPages = top('path');
  // Źródło liczymy po pierwszej odsłonie wizyty: utm_source ma pierwszeństwo przed referrerem.
  const topSources = top("COALESCE(utm_source, referrer_host, '(wejście bezpośrednie)')", 'AND new_visit = 1');
  const topCampaigns = top('utm_campaign', 'AND new_visit = 1 AND utm_campaign IS NOT NULL');
  const topDevices = top('device');
  const topBrowsers = top('browser');
  const topSystems = top('os');
  const topViewports = top(VIEWPORT_SQL);
  const topScreens = top(
    "screen || CASE WHEN dpr IS NULL THEN '' ELSE ' @' || printf('%g', dpr) || 'x' END",
    'AND screen IS NOT NULL'
  );
  // Połączenie urządzenia, systemu, przeglądarki i szerokości okna w jeden wiersz:
  // odpowiada na pytanie "na czym konkretnie oglądają stronę".
  const topCombos = db.prepare(`
    SELECT device, os, browser, ${VIEWPORT_SQL} AS viewport,
           COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS visitors
    FROM vk_pageviews WHERE is_bot = 0 AND ${range}
    GROUP BY device, os, browser, viewport ORDER BY visitors DESC, pageviews DESC LIMIT @limit
  `);
  const measured = db.prepare(
    `SELECT COUNT(*) AS n FROM vk_pageviews WHERE is_bot = 0 AND screen IS NOT NULL AND ${range}`
  );
  const firstDay = db.prepare('SELECT MIN(day) AS day FROM vk_pageviews');

  function summary({ from, to, limit = 20 }) {
    const p = { from, to };
    const t = totals.get(p);
    return {
      from,
      to,
      pageviews: t.pageviews,
      visits: t.visits,
      visitors: t.visitors,
      newVisitors: t.newVisitors,
      // Byli na stronie przed tym okresem.
      returningVisitors: t.visitors - t.newVisitors,
      // Przyszli w tym okresie co najmniej dwa razy (osobne wizyty).
      repeatVisitors: repeat.get(p).n,
      visitsPerVisitor: t.visitors ? Math.round((t.visits / t.visitors) * 100) / 100 : 0,
      botPageviews: bots.get(p).n,
      daily: daily.all(p),
      pages: topPages.all({ ...p, limit }),
      sources: topSources.all({ ...p, limit }),
      campaigns: topCampaigns.all({ ...p, limit }),
      devices: topDevices.all({ ...p, limit }),
      browsers: topBrowsers.all({ ...p, limit }),
      systems: topSystems.all({ ...p, limit }),
      viewports: topViewports.all({ ...p, limit }),
      screens: topScreens.all({ ...p, limit }),
      combos: topCombos.all({ ...p, limit: Math.max(limit, 25) }),
      // Odsłony ludzi z pomiarem ekranu (skrypt się wykonał).
      measuredPageviews: measured.get(p).n,
    };
  }

  return { summary, firstDay: () => firstDay.get().day };
}

module.exports = { createStats, openDb, VISIT_GAP_MS, VIEWPORT_BUCKETS };
