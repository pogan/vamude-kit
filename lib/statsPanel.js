// Panel statystyk (HTML) i to samo w JSON (np. dla przyszłego dashboardu).
// Dostęp ma każdy zalogowany administrator (`/kierownik`, lib/admin.js):
// domyślnie `res.locals.isAdmin`, który ustawia admin.middleware albo własne
// logowanie aplikacji (bdik, bookowska). Aplikacja może podać własny `guard`.
// Bez uprawnień: HTML przekierowuje do logowania, JSON zwraca 401.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PANEL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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

function statsPage({ panelPath, loginPath, appName, s, range, extra = '' }) {
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
    `<div class="muted"><a href="${escapeHtml(loginPath)}">← Kierownik</a></div>
<h1>Statystyki ${escapeHtml(appName)}</h1>
<div class="muted">${escapeHtml(s.from)} – ${escapeHtml(s.to)} · ruch ludzi (boty liczone osobno)</div>
<nav>${nav}</nav>
<form class="range" method="get" action="${escapeHtml(panelPath)}">
  od <input type="date" name="from" value="${escapeHtml(s.from)}"> do <input type="date" name="to" value="${escapeHtml(s.to)}">
  <button>Pokaż</button> <a href="${escapeHtml(panelPath)}.json?from=${s.from}&amp;to=${s.to}">JSON</a>
</form>
<div class="tiles">${tiles.map(([l, v]) => `<div class="tile"><b>${typeof v === 'number' ? fmt(v) : v}</b><span>${l}</span></div>`).join('')}</div>
${extra}
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
const defaultGuard = (req, res) => Boolean(res.locals && res.locals.isAdmin);

// Sekcje aplikacji (np. lejek sprzedaży): sections({ req, from, to }) zwraca HTML
// wstawiany pod kafelkami. HTML jest zaufany (kod aplikacji): dane z zewnątrz
// aplikacja musi sama przepuścić przez escapeHtml. Bez skryptów (CSP panelu).
function renderSections(sections, ctx) {
  if (!sections) return '';
  try {
    return String(sections(ctx) || '');
  } catch (err) {
    console.error('[stats] sekcja aplikacji w panelu:', err.message);
    return '<h2>Sekcje aplikacji</h2><p class="muted">Nie udało się policzyć (szczegóły w logu).</p>';
  }
}

function createPanel({ panelPath, loginPath, guard = defaultGuard, sections, queries, today }) {
  return function statsPanel(req, res, next) {
    const isJson = req.path === `${panelPath}.json`;
    if (req.path !== panelPath && !isJson) return next();
    if (req.method !== 'GET') return next();
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    // Własna polityka panelu zamiast CSP aplikacji (helmet), która zwykle
    // blokuje style inline: panel nie ładuje skryptów ani zasobów z zewnątrz.
    res.set('Content-Security-Policy', PANEL_CSP);
    try {
      if (!guard(req, res)) {
        if (isJson) return res.status(401).json({ error: 'unauthorized' });
        return res.redirect(303, `${loginPath}?next=${encodeURIComponent(req.originalUrl)}`);
      }
      const range = resolveRange(req.query || {}, today(), queries.firstDay());
      const s = queries.summary({ from: range.from, to: range.to });
      if (isJson) return res.json(s);
      const appName = req.app?.locals?.appVersion?.name || req.hostname;
      const extra = renderSections(sections, { req, from: range.from, to: range.to });
      return res.type('html').send(statsPage({ panelPath, loginPath, appName, s, range, extra }));
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createPanel, addDays, page, escapeHtml, table, fmt, STYLE };
