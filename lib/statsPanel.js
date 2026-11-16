// Panel statystyk (HTML) i to samo w JSON (np. dla przyszłego dashboardu).
// Dostęp: własna funkcja `guard` aplikacji (np. zalogowany admin w bdik) albo
// hasło z STATS_PASSWORD. Po zalogowaniu hasłem panel ustawia ciasteczko
// techniczne (tylko dla osoby z hasłem, nie dla odwiedzających stronę). Bez
// guard i bez hasła panel nie istnieje (404 z aplikacji).
//
// Basic auth odpada: podglądy na STAGING są już za basic auth Caddy, a
// przeglądarka trzyma jeden nagłówek Authorization na stronę.
const crypto = require('crypto');

const COOKIE = 'vk_stats';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PANEL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Body formularza: aplikacja mogła je już sparsować (express.urlencoded).
function readForm(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) req.destroy();
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
    req.on('error', reject);
  });
}

// --- Daty (RRRR-MM-DD, liczone w UTC, bo to tylko kalendarz) ---------------
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function periods(today, firstDay) {
  const month = today.slice(0, 7);
  const prevMonthEnd = addDays(`${month}-01`, -1);
  return [
    { key: 'dzis', label: 'Dziś', from: today, to: today },
    { key: '7d', label: '7 dni', from: addDays(today, -6), to: today },
    { key: '30d', label: '30 dni', from: addDays(today, -29), to: today },
    { key: 'miesiac', label: 'Ten miesiąc', from: `${month}-01`, to: today },
    { key: 'poprzedni', label: 'Poprzedni miesiąc', from: `${prevMonthEnd.slice(0, 7)}-01`, to: prevMonthEnd },
    { key: 'rok', label: 'Ten rok', from: `${today.slice(0, 4)}-01-01`, to: today },
    { key: 'wszystko', label: 'Wszystko', from: firstDay || today, to: today },
  ];
}

function resolveRange(query, today, firstDay) {
  const list = periods(today, firstDay);
  if (DAY_RE.test(query.from || '') && DAY_RE.test(query.to || '') && query.from <= query.to) {
    return { from: query.from, to: query.to, key: null, list };
  }
  const p = list.find((x) => x.key === query.okres) || list[2];
  return { from: p.from, to: p.to, key: p.key, list };
}

// --- HTML -----------------------------------------------------------------
const STYLE = `
  :root { color-scheme: light dark; --fg:#1d1d1f; --muted:#6e6e73; --bg:#fff; --line:#e5e5ea; --bar:#3b6fd8; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f2f2f7; --muted:#a1a1a6; --bg:#1c1c1e; --line:#3a3a3c; --bar:#6c9cff; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 48px; font:15px/1.45 system-ui, sans-serif; color:var(--fg); background:var(--bg); }
  main { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; } h2 { font-size: 1.05rem; margin: 28px 0 8px; }
  .muted { color: var(--muted); font-size: .85rem; }
  nav { display:flex; flex-wrap:wrap; gap:6px; margin:16px 0 8px; }
  nav a { padding:4px 10px; border:1px solid var(--line); border-radius:999px; color:inherit; text-decoration:none; font-size:.85rem; }
  nav a.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  form.range { display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:.85rem; }
  input, button { font: inherit; padding: 4px 8px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; margin-top:16px; }
  .tile { border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .tile b { display:block; font-size:1.5rem; font-variant-numeric: tabular-nums; }
  .tile span { font-size:.8rem; color: var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap: 0 24px; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th, td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); vertical-align: top; }
  td.n, th.n { text-align:right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.name { word-break: break-all; }
  .bar { height:8px; background:var(--bar); border-radius:4px; min-width:1px; }
  dl { font-size:.8rem; color: var(--muted); } dt { font-weight:600; display:inline; } dd { display:inline; margin:0; } dd::after { content:''; display:block; }
`;

function page(title, body) {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function loginPage(panelPath, error) {
  return page(
    'Statystyki',
    `<h1>Statystyki</h1>
<form method="post" action="${escapeHtml(panelPath)}" style="margin-top:16px;display:flex;gap:8px">
  <input type="password" name="password" placeholder="Hasło" autofocus required autocomplete="current-password">
  <button>Zaloguj</button>
</form>${error ? `<p style="color:#d33">${escapeHtml(error)}</p>` : ''}`
  );
}

const fmt = (n) => Number(n || 0).toLocaleString('pl-PL');

function table(rows, nameLabel) {
  if (!rows.length) return '<p class="muted">Brak danych.</p>';
  return `<table><thead><tr><th>${nameLabel}</th><th class="n">Osoby</th><th class="n">Odsłony</th></tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><td class="name">${escapeHtml(r.name ?? '—')}</td><td class="n">${fmt(r.visitors)}</td><td class="n">${fmt(r.pageviews)}</td></tr>`
    )
    .join('')}</tbody></table>`;
}

function statsPage({ panelPath, appName, s, range }) {
  const max = Math.max(1, ...s.daily.map((d) => d.visitors));
  const tiles = [
    ['Odsłony', s.pageviews],
    ['Wizyty', s.visits],
    ['Unikalne osoby', s.visitors],
    ['Nowe osoby', s.newVisitors],
    ['Powracające osoby', s.returningVisitors],
    ['Wróciły w okresie', s.repeatVisitors],
    ['Wizyty na osobę', s.visitsPerVisitor.toLocaleString('pl-PL')],
    ['Odsłony botów', s.botPageviews],
  ];
  const nav = range.list
    .map(
      (p) =>
        `<a href="${escapeHtml(panelPath)}?okres=${p.key}"${p.key === range.key ? ' class="on"' : ''}>${escapeHtml(p.label)}</a>`
    )
    .join('');
  return page(
    `Statystyki ${appName}`,
    `<h1>Statystyki ${escapeHtml(appName)}</h1>
<div class="muted">${escapeHtml(s.from)} – ${escapeHtml(s.to)} · ruch ludzi (boty liczone osobno)</div>
<nav>${nav}</nav>
<form class="range" method="get" action="${escapeHtml(panelPath)}">
  od <input type="date" name="from" value="${escapeHtml(s.from)}"> do <input type="date" name="to" value="${escapeHtml(s.to)}">
  <button>Pokaż</button> <a href="${escapeHtml(panelPath)}.json?from=${s.from}&amp;to=${s.to}">JSON</a>
</form>
<div class="tiles">${tiles.map(([l, v]) => `<div class="tile"><b>${typeof v === 'number' ? fmt(v) : v}</b><span>${l}</span></div>`).join('')}</div>
<h2>Dzień po dniu</h2>
${
  s.daily.length
    ? `<table><thead><tr><th>Dzień</th><th class="n">Osoby</th><th class="n">Wizyty</th><th class="n">Odsłony</th><th style="width:40%"></th></tr></thead><tbody>${s.daily
        .map(
          (d) =>
            `<tr><td>${d.day}</td><td class="n">${fmt(d.visitors)}</td><td class="n">${fmt(d.visits)}</td><td class="n">${fmt(d.pageviews)}</td><td><div class="bar" style="width:${(d.visitors / max) * 100}%"></div></td></tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="muted">Brak danych.</p>'
}
<div class="grid">
  <div><h2>Strony</h2>${table(s.pages, 'Ścieżka')}</div>
  <div><h2>Źródła wizyt</h2>${table(s.sources, 'Źródło')}</div>
  <div><h2>Kampanie (utm_campaign)</h2>${table(s.campaigns, 'Kampania')}</div>
  <div><h2>Urządzenia</h2>${table(s.devices, 'Urządzenie')}</div>
  <div><h2>Przeglądarki</h2>${table(s.browsers, 'Przeglądarka')}</div>
</div>
<h2>Jak liczymy</h2>
<dl>
  <dt>Osoba:</dt> <dd>ten sam adres IP i ta sama przeglądarka z systemem (bez ciasteczek, więc w przybliżeniu).</dd>
  <dt>Wizyta:</dt> <dd>ciąg odsłon jednej osoby; po 30 minutach przerwy zaczyna się nowa.</dd>
  <dt>Nowe osoby:</dt> <dd>pierwszy raz na stronie w tym okresie.</dd>
  <dt>Powracające osoby:</dt> <dd>były na stronie już przed tym okresem.</dd>
  <dt>Wróciły w okresie:</dt> <dd>miały w tym okresie co najmniej dwie wizyty.</dd>
  <dt>Źródło wizyty:</dt> <dd>utm_source z linku, a gdy go brak, strona, z której przyszła osoba.</dd>
  <dt>Boty:</dt> <dd>znane roboty (User-Agent) i klienci bez nagłówka języka; nie wchodzą do pozostałych liczb.</dd>
</dl>`
  );
}

// --- Middleware -----------------------------------------------------------
function createPanel({ panelPath, secret, guard, queries, today }) {
  const failures = new Map(); // IP -> { count, since }

  const password = () => process.env.STATS_PASSWORD || '';
  const tokenFor = (pass) => crypto.createHmac('sha256', secret).update(`panel|${pass}`).digest('hex');

  function authorized(req, res) {
    if (guard) return Boolean(guard(req, res));
    const pass = password();
    if (!pass) return false;
    const bearer = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (bearer && safeEqual(bearer[1], pass)) return true;
    const cookie = readCookie(req, COOKIE);
    return Boolean(cookie) && safeEqual(cookie, tokenFor(pass));
  }

  function blocked(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > FAILURE_WINDOW_MS) {
      failures.delete(ip);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }

  function fail(ip) {
    const f = failures.get(ip);
    if (f && Date.now() - f.since <= FAILURE_WINDOW_MS) f.count += 1;
    else failures.set(ip, { count: 1, since: Date.now() });
  }

  async function login(req, res) {
    const pass = password();
    if (blocked(req.ip)) {
      return res.status(429).type('html').send(loginPage(panelPath, 'Za dużo prób. Spróbuj za kwadrans.'));
    }
    const form = await readForm(req);
    if (!safeEqual(form.password || '', pass)) {
      fail(req.ip);
      return res.status(401).type('html').send(loginPage(panelPath, 'Nieprawidłowe hasło.'));
    }
    failures.delete(req.ip);
    const secure = req.secure ? '; Secure' : '';
    res.set(
      'Set-Cookie',
      `${COOKIE}=${tokenFor(pass)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict${secure}`
    );
    return res.redirect(303, panelPath);
  }

  return async function statsPanel(req, res, next) {
    const isJson = req.path === `${panelPath}.json`;
    if (req.path !== panelPath && !isJson) return next();
    // Bez guard i bez hasła panelu nie ma.
    if (!guard && !password()) return next();
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    // Własna polityka panelu zamiast CSP aplikacji (helmet), która zwykle
    // blokuje style inline: panel nie ładuje skryptów ani zasobów z zewnątrz.
    res.set('Content-Security-Policy', PANEL_CSP);
    try {
      if (!isJson && req.method === 'POST' && !guard) return await login(req, res);
      if (req.method !== 'GET') return next();
      if (!authorized(req, res)) {
        if (guard) return next();
        if (isJson) return res.status(401).json({ error: 'unauthorized' });
        return res.status(200).type('html').send(loginPage(panelPath));
      }
      const range = resolveRange(req.query || {}, today(), queries.firstDay());
      const s = queries.summary({ from: range.from, to: range.to });
      if (isJson) return res.json(s);
      const appName = req.app?.locals?.appVersion?.name || req.hostname;
      return res.type('html').send(statsPage({ panelPath, appName, s, range }));
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createPanel, addDays };
