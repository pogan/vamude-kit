// Panel administratora `/kierownik` (standard Vamude, ~/vamude/infra/STACK.md).
//
// - Logowanie: "Sign in with Google" (Google Identity Services). Przeglądarka
//   dostaje od Google podpisany token i wysyła go na /kierownik/login; serwer
//   sprawdza podpis (lib/google.js) i adres z ADMIN_EMAILS. Wystarczy
//   GOOGLE_CLIENT_ID z "Authorized JavaScript origins" = domena strony; bez
//   sekretu klienta i bez redirect URI.
// - Sesja: ciasteczko `vk_admin` = {e: email, x: wygaśnięcie} podpisane HMAC
//   kluczem losowanym raz i trzymanym w bazie aplikacji (vk_meta). ADMIN_EMAILS
//   sprawdzamy przy każdym żądaniu: usunięcie adresu odbiera dostęp od razu.
// - Podgląd na STAGING: PREVIEW_LOGIN=true pozwala wejść bez Google, ale tylko
//   na *.staging.vamude.com i localhost (podglądy i tak są za hasłem Caddy).
// - Statystyki (lib/stats.js) są pod /kierownik/stats dla każdego zalogowanego
//   administratora: middleware ustawia res.locals.isAdmin.
const crypto = require('crypto');
const path = require('path');
const { createVerifier } = require('./google');
const { page, escapeHtml } = require('./statsPanel');

const COOKIE = 'vk_admin';
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const PREVIEW_HOST_RE = /(^|\.)staging\.vamude\.com$|^localhost$|^127\.0\.0\.1$/;
const GSI = 'https://accounts.google.com/gsi/';

function parseEmails(value) {
  return String(value || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Body formularza albo JSON: aplikacja mogła je już sparsować (express.urlencoded/json).
function readBody(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return Promise.resolve(req.body);
  if (req.readableEnded) return Promise.resolve(req.body || {});
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 20_000) req.destroy();
    });
    req.on('end', () => {
      if (/json/.test(req.get('content-type') || '')) {
        try {
          return resolve(JSON.parse(raw || '{}'));
        } catch {
          return resolve({});
        }
      }
      return resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
    req.on('error', reject);
  });
}

// Tylko ścieżki tej samej strony ("/x", nie "//obca.pl").
function safeNext(value, fallback) {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : fallback;
}

function wantsJson(req) {
  return /json/.test(req.get('content-type') || '') || /^application\/json/.test(req.get('accept') || '');
}

// Opcje:
//   stats      - wynik createStats() (baza na klucz sesji); albo `db` (better-sqlite3), albo `file`
//   path       - adres panelu (domyślnie /kierownik)
//   links      - dodatkowe pozycje panelu: [{ href, label }] (statystyki są zawsze)
//   clientId   - domyślnie GOOGLE_CLIENT_ID z .env
//   maxAgeDays - ważność sesji (domyślnie 30 dni)
//   verifyIdToken - własna weryfikacja tokenu (testy)
function createAdmin(options = {}) {
  const {
    path: base = '/kierownik',
    links = [],
    clientId = process.env.GOOGLE_CLIENT_ID || '',
    maxAgeDays = 30,
    statsPath = `${base}/stats`,
  } = options;
  let db = options.db || (options.stats && options.stats.db);
  if (!db) {
    const { openDb } = require('./stats');
    db = openDb(options.file || path.join(process.cwd(), 'data', 'stats.sqlite'));
  }
  db.exec('CREATE TABLE IF NOT EXISTS vk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare("INSERT OR IGNORE INTO vk_meta (key, value) VALUES ('admin_secret', ?)").run(
    crypto.randomBytes(32).toString('hex')
  );
  const secret = db.prepare("SELECT value FROM vk_meta WHERE key = 'admin_secret'").get().value;
  const verifyIdToken = options.verifyIdToken || createVerifier({ clientId });
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const failures = new Map(); // IP -> { count, since }

  const emails = () => parseEmails(process.env.ADMIN_EMAILS);
  if (!clientId) console.warn('[kierownik] brak GOOGLE_CLIENT_ID w .env: logowanie Google wyłączone');
  if (!emails().length) console.warn('[kierownik] ADMIN_EMAILS jest puste: nikt nie ma dostępu');

  const previewAllowed = (req) => process.env.PREVIEW_LOGIN === 'true' && PREVIEW_HOST_RE.test(req.hostname || '');

  // --- Sesja --------------------------------------------------------------
  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  function setSession(req, res, email, preview = false) {
    const data = Buffer.from(JSON.stringify({ e: email, x: Date.now() + maxAgeMs, ...(preview ? { p: 1 } : {}) })).toString(
      'base64url'
    );
    res.append(
      'Set-Cookie',
      `${COOKIE}=${data}.${sign(data)}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${
        req.secure ? '; Secure' : ''
      }`
    );
  }

  function clearSession(req, res) {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
  }

  // { email, preview } zalogowanego administratora albo null.
  function current(req) {
    if (req.vkAdmin !== undefined) return req.vkAdmin;
    let result = null;
    const token = readCookie(req, COOKIE);
    const dot = token ? token.lastIndexOf('.') : -1;
    if (dot > 0) {
      const data = token.slice(0, dot);
      const sig = Buffer.from(token.slice(dot + 1));
      const expected = Buffer.from(sign(data));
      if (sig.length === expected.length && crypto.timingSafeEqual(sig, expected)) {
        try {
          const s = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
          if (typeof s.x === 'number' && Date.now() < s.x) {
            if (s.p ? previewAllowed(req) : emails().includes(s.e)) result = { email: s.e, preview: Boolean(s.p) };
          }
        } catch {
          result = null;
        }
      }
    }
    req.vkAdmin = result;
    return result;
  }

  const isAdmin = (req) => Boolean(current(req));

  // Wcześnie w łańcuchu: flaga dla widoków, statystyk (pomijanie ruchu admina) i panelu.
  function middleware(req, res, next) {
    const admin = current(req);
    res.locals.admin = admin;
    if (admin) res.locals.isAdmin = true;
    next();
  }

  // Dla własnych tras aplikacji pod /kierownik/... (np. zamówienia).
  function requireAdmin(req, res, next) {
    if (isAdmin(req)) return next();
    if (wantsJson(req) || req.method !== 'GET') return res.status(401).json({ ok: false, error: 'Zaloguj się.' });
    return res.redirect(303, `${base}?next=${encodeURIComponent(req.originalUrl)}`);
  }

  // --- Ochrona przed zgadywaniem -------------------------------------------
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

  // Formularz z obcej strony nie może zalogować ani wylogować (Origin z przeglądarki).
  function sameOrigin(req) {
    const origin = req.get('origin');
    if (!origin) return true;
    try {
      return new URL(origin).host === req.get('host');
    } catch {
      return false;
    }
  }

  // --- Strony --------------------------------------------------------------
  function securityHeaders(res, nonce) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' ${GSI}client`,
        `style-src 'unsafe-inline' ${GSI}style`,
        `frame-src ${GSI}`,
        `connect-src ${GSI}`,
        'img-src https: data:',
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
    // Przycisk Google potrzebuje źródła strony w Referer i okna logowania (popup)
    // połączonego z naszym: domyślne ustawienia helmet blokują jedno i drugie.
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  }

  const appName = (req) => req.app?.locals?.appVersion?.name || req.hostname;

  function loginPage(req, res, { status = 200, error = '' } = {}) {
    const nonce = crypto.randomBytes(16).toString('base64');
    securityHeaders(res, nonce);
    const next = safeNext(req.query?.next || req.body?.next, base);
    const google = clientId
      ? `<script src="${GSI}client" async nonce="${nonce}"></script>
<div id="g_id_onload" data-client_id="${escapeHtml(clientId)}" data-callback="vkLogin" data-auto_prompt="false" data-ux_mode="popup"></div>
<div class="g_id_signin" data-type="standard" data-size="large" data-text="signin_with" data-locale="pl"></div>
<form id="vk-login" method="post" action="${base}/login"><input type="hidden" name="credential"><input type="hidden" name="next" value="${escapeHtml(next)}"></form>
<script nonce="${nonce}">function vkLogin(r){var f=document.getElementById('vk-login');f.credential.value=r.credential;f.submit();}</script>`
      : '<p class="muted">Logowanie Google nie jest skonfigurowane (brak GOOGLE_CLIENT_ID w .env).</p>';
    const preview = previewAllowed(req)
      ? `<form method="post" action="${base}/podglad" style="margin-top:16px"><input type="hidden" name="next" value="${escapeHtml(next)}"><button>Wejdź jako administrator podglądu</button></form>`
      : '';
    return res
      .status(status)
      .type('html')
      .send(
        page(
          `Kierownik · ${appName(req)}`,
          `<h1>Kierownik</h1><p class="muted">${escapeHtml(appName(req))} · panel administratora. Zaloguj się kontem Google z listy administratorów.</p>
<div style="margin-top:16px">${google}</div>${preview}${error ? `<p style="color:#d33">${escapeHtml(error)}</p>` : ''}`
        )
      );
  }

  function dashboard(req, res) {
    securityHeaders(res, crypto.randomBytes(16).toString('base64'));
    const admin = current(req);
    const items = [{ href: statsPath, label: 'Statystyki odwiedzin' }, ...links];
    return res.type('html').send(
      page(
        `Kierownik · ${appName(req)}`,
        `<h1>Kierownik</h1><p class="muted">${escapeHtml(appName(req))} · zalogowano: ${escapeHtml(admin.email)}${
          admin.preview ? ' (podgląd)' : ''
        }</p>
<ul style="margin-top:16px;line-height:2">${items
          .map((l) => `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></li>`)
          .join('')}</ul>
<form method="post" action="${base}/wyloguj"><button>Wyloguj</button></form>`
      )
    );
  }

  async function login(req, res) {
    const json = wantsJson(req);
    const reply = (status, error) =>
      json ? res.status(status).json({ ok: false, error }) : loginPage(req, res, { status, error });
    if (!sameOrigin(req)) return reply(403, 'Logowanie tylko z tej strony.');
    if (blocked(req.ip)) return reply(429, 'Za dużo prób. Spróbuj za kwadrans.');
    const body = await readBody(req);
    req.body = body;
    let payload;
    try {
      payload = await verifyIdToken(body.credential);
    } catch (err) {
      fail(req.ip);
      console.warn(`[kierownik] odrzucony token Google: ${err.message}`);
      return reply(401, 'Nie udało się potwierdzić logowania Google.');
    }
    const email = String(payload.email || '').toLowerCase();
    if (!payload.email_verified || !emails().includes(email)) {
      fail(req.ip);
      console.warn('[kierownik] logowanie konta spoza ADMIN_EMAILS');
      return reply(403, 'To konto nie ma dostępu do panelu.');
    }
    failures.delete(req.ip);
    setSession(req, res, email);
    console.log('[kierownik] zalogowano administratora');
    if (json) return res.json({ ok: true, email });
    return res.redirect(303, safeNext(body.next, base));
  }

  async function router(req, res, next) {
    const p = req.path;
    if (p !== base && !p.startsWith(`${base}/`)) return next();
    try {
      if (p === base && req.method === 'GET') return current(req) ? dashboard(req, res) : loginPage(req, res);
      if (p === `${base}/login` && req.method === 'POST') return await login(req, res);
      if (p === `${base}/podglad` && req.method === 'POST') {
        if (!previewAllowed(req) || !sameOrigin(req)) return res.status(404).end();
        const body = await readBody(req);
        setSession(req, res, 'podglad@staging.vamude.com', true);
        return res.redirect(303, safeNext(body.next, base));
      }
      if (p === `${base}/wyloguj` && req.method === 'POST') {
        if (!sameOrigin(req)) return res.status(403).end();
        clearSession(req, res);
        return wantsJson(req) ? res.json({ ok: true }) : res.redirect(303, base);
      }
      return next();
    } catch (err) {
      return next(err);
    }
  }

  return { middleware, router, requireAdmin, isAdmin, current, path: base };
}

module.exports = { createAdmin, parseEmails };
