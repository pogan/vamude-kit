# vamude-kit

Wspólne elementy aplikacji Vamude (standard: `~/vamude/infra/STACK.md`):

- `readVersion()`: wersja do stopki i `/healthz` (`v1.2.0 · abc1234 · 2026-11-16`),
- `healthz()`: `GET /healthz` w jednym formacie dla deployu, CI i dashboardu,
- `createStats()`: własne statystyki odwiedzin w SQLite (bez ciasteczek, z filtrem botów) i panel
  `/kierownik/stats`,
- `createAdmin()`: panel administratora `/kierownik` z logowaniem Google i listą `ADMIN_EMAILS`.

## Instalacja

Zależność z archiwum wydania (bez gita na serwerze, z sumą kontrolną w `package-lock.json`):

```bash
npm install https://github.com/pogan/vamude-kit/archive/refs/tags/v2.1.0.tar.gz
```

Aktualizacja = ta sama komenda z nowym numerem wydania, w PR do `staging`.

Pakiet zależy od `better-sqlite3` (moduł natywny). npm 11.19+ (m.in. na WEBSITES) domyślnie blokuje skrypty
instalacyjne zależności, więc aplikacja musi je zatwierdzić w swoim `package.json`, inaczej nie wystartuje
(`Could not locate the bindings file`):

```bash
npx npm@latest install-scripts approve better-sqlite3 --no-allow-scripts-pin
# → "allowScripts": { "better-sqlite3": true }
```

## Użycie (Express)

```js
const { readVersion, healthz, createStats, createAdmin } = require('vamude-kit');
// ESM: import kit from 'vamude-kit'; const { readVersion, healthz, createStats, createAdmin } = kit;

app.set('trust proxy', 1); // req.ip = adres odwiedzającego zza nginx/Caddy

const version = readVersion();          // raz przy starcie
app.locals.appVersion = version;        // w stopce: <%= appVersion.label %>

const stats = createStats({ db });      // baza aplikacji; bez niej: data/stats.sqlite
const admin = createAdmin({ stats });   // /kierownik, klucz sesji w tej samej bazie
app.use(admin.middleware);              // res.locals.isAdmin / res.locals.admin
app.use(stats.middleware);              // wcześnie, przed trasami stron; obsługuje też /_vk.js i /_vk
// W szablonie strony przed </body>: <%- vkScript %>  (pomiar ekranu, od 2.2.0)
app.use(stats.panel);                   // /kierownik/stats i /kierownik/stats.json
app.use(admin.router);                  // /kierownik, /kierownik/login, /kierownik/wyloguj
app.get('/kierownik/zamowienia', admin.requireAdmin, ...); // własne strony panelu

// Przed bramą hasła / sesją:
app.get('/healthz', healthz({ version, checks: { db: () => db.prepare('SELECT 1').get() } }));
```

### `readVersion({ root })`

Numer z `package.json` aplikacji, commit i data z gita (`root` domyślnie `process.cwd()`). Bez gita commit
z `APP_COMMIT`, a gdy go brak, sam numer. Zwraca `{ name, version, commit, date, dirty, label }`.

### `healthz({ version, checks, timeoutMs })`

```json
{ "status": "ok", "app": "jkbb-website", "version": "1.0.0", "commit": "abc1234", "date": "2026-11-16",
  "uptime": 3600, "node": "24.11.0", "checks": { "db": "ok" } }
```

200 gdy wszystkie checki przeszły, 503 (`"status": "error"`) gdy któryś rzucił wyjątek, zwrócił `false` albo
nie zdążył w `timeoutMs` (2 s). `Cache-Control: no-store`.

### `createStats(options)`

| Opcja | Domyślnie | Opis |
|---|---|---|
| `db` | — | instancja `better-sqlite3`; tabele `vk_meta`, `vk_pageviews` |
| `file` | `data/stats.sqlite` | osobny plik, gdy aplikacja nie ma bazy |
| `exclude(req, res)` | `() => false` | dodatkowe pomijanie; ruch admina (`res.locals.isAdmin`) jest pomijany zawsze |
| `excludePrefixes` | `/healthz`, `/api`, `/kierownik`, `/admin`, `/auth` | ścieżki pomijane w całości |
| `panelPath` | `/kierownik/stats` | adres panelu (`<panelPath>.json` dla danych) |
| `loginPath` | `/kierownik` | dokąd panel odsyła niezalogowanych |
| `guard(req, res)` | `res.locals.isAdmin` | własny warunek dostępu do panelu |
| `sections({ req, from, to })` | — | HTML własnych sekcji pod kafelkami, dla okresu wybranego w panelu (np. lejek sprzedaży); dane z zewnątrz przez `escapeHtml` z pakietu |
| `timeZone` | `Europe/Warsaw` | strefa, w której liczone są dni |
| `beaconPath` | `/_vk` | pomiar ekranu: skrypt `<beaconPath>.js`, dane `POST <beaconPath>`; `false` wyłącza |

Liczone są żądania `GET` zakończone odpowiedzią HTML 200 (bez zasobów, przekierowań, 404 i prefetchu).
Boty (`isbot`, brak `User-Agent`, brak języka w `Accept-Language`) zapisywane z flagą, poza liczbami ludzi.

Ekran i okno (od 2.2.0): serwer ich nie widzi, więc strona dołącza własny skrypt `<script src="/_vk.js" defer>`
(w szablonie `<%- vkScript %>`, w statycznym HTML wpisany ręcznie; `stats.scriptTag` to ten sam znacznik).
Skrypt wysyła raz `navigator.sendBeacon` z rozmiarem ekranu, okna, gęstością pikseli i informacją o ekranie
dotykowym. Serwer dopisuje to do odsłony tej samej osoby i ścieżki z ostatnich 5 minut, której jeszcze nie
zmierzono; bez takiej odsłony nic nie zapisuje. Bez ciasteczek, ekran nie wchodzi do identyfikatora osoby.
Zgodne z CSP `script-src 'self'` i `connect-src 'self'` (domyślne w helmet). iPad z Safari (UA Maca) z ekranem
dotykowym zapisywany jako tablet z iOS. Przeglądarki w aplikacjach (Facebook, Instagram, TikTok, LinkedIn,
Google) to osobne pozycje, a nie Safari czy Chrome.

Panel: kafelek „Odsłony z pomiarem ekranu”, tabela „Na czym oglądają stronę” (urządzenie · system ·
przeglądarka · szerokość okna) oraz urządzenia, systemy, przeglądarki, szerokość okna i ekrany z udziałem
w osobach. JSON: `systems`, `viewports`, `screens`, `combos`, `measuredPageviews`.

Odwiedzający = `HMAC-SHA256(sekret, IP + rodzina przeglądarki + system)`, sekret losowy i stały w `vk_meta`.
Wizyta kończy się po 30 min przerwy. Dane nie są kasowane automatycznie (przegląd RODO: ręcznie, osobna procedura).

Panel: każdy zalogowany administrator (`res.locals.isAdmin`, ustawia je `createAdmin` albo własne logowanie
aplikacji). Niezalogowany: HTML → przekierowanie do `/kierownik?next=...`, JSON → 401. `STATS_PASSWORD` już
nie istnieje (od 2.0.0).

### `createAdmin(options)`

| Opcja | Domyślnie | Opis |
|---|---|---|
| `stats` / `db` / `file` | — | baza na klucz podpisu sesji (`vk_meta.admin_secret`, losowany raz) |
| `path` | `/kierownik` | adres panelu |
| `links` | `[]` | dodatkowe pozycje panelu `[{ href, label }]`; „Statystyki odwiedzin” są zawsze |
| `clientId` | `GOOGLE_CLIENT_ID` | identyfikator klienta OAuth (publiczny) |
| `maxAgeDays` | `30` | ważność sesji |

`.env`: `GOOGLE_CLIENT_ID` (Google Cloud → Credentials → OAuth client ID → Web application, w „Authorized
JavaScript origins” domena strony; bez sekretu i redirect URI) oraz `ADMIN_EMAILS` (adresy po przecinku,
sprawdzane przy każdym żądaniu). Na podglądzie `PREVIEW_LOGIN=true`: przycisk „Wejdź jako administrator
podglądu”, działa tylko na `*.staging.vamude.com` i localhost.

Logowanie: przycisk „Sign in with Google” (Google Identity Services) → token JWT → `POST /kierownik/login`
(formularz albo JSON `{ credential }` → `{ ok, email }`), podpis RS256 sprawdzany kluczami Google, odbiorca
= `GOOGLE_CLIENT_ID`, e-mail potwierdzony i na liście. Sesja: ciasteczko `vk_admin` (HttpOnly, SameSite=Lax,
Secure za HTTPS), blokada po 10 nieudanych próbach w 15 min, logowanie i wylogowanie tylko z tej samej strony
(`Origin`). Strony panelu mają własne CSP (nonce, `accounts.google.com/gsi/`), `Referrer-Policy:
strict-origin-when-cross-origin` i `Cross-Origin-Opener-Policy: same-origin-allow-popups`, których wymaga
przycisk Google.

API: `admin.middleware`, `admin.router`, `admin.requireAdmin` (trasy aplikacji pod `/kierownik/...`),
`admin.isAdmin(req)`, `admin.current(req)` → `{ email, preview }` albo `null`.

## Rozwój

```bash
npm test                         # node --test
PORT=3999 ADMIN_EMAILS=ty@example.com PREVIEW_LOGIN=true npm start   # przykład: /, /healthz, /kierownik
```

Wydanie: PR `staging` → `main` (zatwierdza Karol), potem Karol tworzy Release `vX.Y.Z` na `main`
(GitHub → Releases → Draft a new release), a numer z `package.json` musi się zgadzać z tagiem.
