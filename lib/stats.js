// Statystyki odwiedzin zapisywane po stronie serwera w SQLite aplikacji - bez
// ciasteczek i skryptów firm trzecich. Każda odsłona to osobny wiersz; nic nie
// jest kasowane automatycznie (przegląd danych pod kątem RODO robimy ręcznie,
// według osobnej procedury).
//
// Odwiedzający = HMAC-SHA256(sekret, IP + rodzina przeglądarki + system). Sekret
// jest losowy, stały i leży tylko w bazie aplikacji, więc bez niej skrótu nie da
// się odwrócić. Wersji przeglądarki nie bierzemy pod uwagę, bo zmienia się co
// kilka tygodni i ta sama osoba wyglądałaby jak nowa.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isbot } = require('isbot');
const { parseUserAgent } = require('./userAgent');
const { createPanel } = require('./statsPanel');

const VISIT_GAP_MS = 30 * 60 * 1000;
const DEFAULT_EXCLUDED_PREFIXES = ['/healthz', '/api', '/kierownik', '/admin', '/auth'];
const MAX_TEXT = 300;

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
function createStats(options = {}) {
  const {
    file = path.join(process.cwd(), 'data', 'stats.sqlite'),
    exclude = () => false,
    excludePrefixes = DEFAULT_EXCLUDED_PREFIXES,
    panelPath = '/kierownik/stats',
    loginPath = '/kierownik',
    timeZone = 'Europe/Warsaw',
    now = Date.now,
  } = options;
  const db = options.db || openDb(file);
  db.exec(SCHEMA);

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
  return { middleware, panel, summary: queries.summary, db };
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
    };
  }

  return { summary, firstDay: () => firstDay.get().day };
}

module.exports = { createStats, openDb, VISIT_GAP_MS };
