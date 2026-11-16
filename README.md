# vamude-kit

Wspólne elementy aplikacji Vamude (standard: `~/vamude/infra/STACK.md`):

- `readVersion()`: wersja do stopki i `/healthz` (`v1.2.0 · abc1234 · 2026-11-16`),
- `healthz()`: `GET /healthz` w jednym formacie dla deployu, CI i dashboardu,
- `createStats()`: własne statystyki odwiedzin w SQLite (bez ciasteczek, z filtrem botów) i panel.

## Instalacja

Zależność z archiwum wydania (bez gita na serwerze, z sumą kontrolną w `package-lock.json`):

```bash
npm install https://github.com/pogan/vamude-kit/archive/refs/tags/v1.0.0.tar.gz
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
const { readVersion, healthz, createStats } = require('vamude-kit');
// ESM: import kit from 'vamude-kit'; const { readVersion, healthz, createStats } = kit;

app.set('trust proxy', 1); // req.ip = adres odwiedzającego zza nginx/Caddy

const version = readVersion();          // raz przy starcie
app.locals.appVersion = version;        // w stopce: <%= appVersion.label %>

const stats = createStats({ db });      // baza aplikacji; bez niej: data/stats.sqlite
app.use(stats.middleware);              // wcześnie, przed trasami stron
app.use(stats.panel);                   // /stats i /stats.json

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
| `exclude(req, res)` | `() => false` | np. `(req, res) => res.locals.isAdmin`; sprawdzane po obsłużeniu żądania |
| `excludePrefixes` | `/healthz`, `/api`, `/admin`, `/auth` | ścieżki pomijane w całości |
| `panelPath` | `/stats` | adres panelu (`<panelPath>.json` dla danych) |
| `guard(req, res)` | — | własny dostęp do panelu (np. admin) zamiast hasła |
| `timeZone` | `Europe/Warsaw` | strefa, w której liczone są dni |

Liczone są żądania `GET` zakończone odpowiedzią HTML 200 (bez zasobów, przekierowań, 404 i prefetchu).
Boty (`isbot`, brak `User-Agent`, brak języka w `Accept-Language`) zapisywane z flagą, poza liczbami ludzi.

Odwiedzający = `HMAC-SHA256(sekret, IP + rodzina przeglądarki + system)`, sekret losowy i stały w `vk_meta`.
Wizyta kończy się po 30 min przerwy. Dane nie są kasowane automatycznie (przegląd RODO: ręcznie, osobna procedura).

Panel: hasło w `STATS_PASSWORD` w `.env` (logowanie formularzem, ciasteczko techniczne na 30 dni, blokada po
10 błędnych próbach w 15 min) albo `guard`. JSON: to samo ciasteczko albo `Authorization: Bearer <hasło>`.
Bez hasła i bez `guard` panel zwraca 404.

## Rozwój

```bash
npm test                         # node --test
PORT=3999 STATS_PASSWORD=demo npm start   # serwer przykładowy: /, /healthz, /stats
```

Wydanie: PR `staging` → `main` (zatwierdza Karol), potem Karol tworzy Release `vX.Y.Z` na `main`
(GitHub → Releases → Draft a new release), a numer z `package.json` musi się zgadzać z tagiem.
