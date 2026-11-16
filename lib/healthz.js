// GET /healthz - jeden format dla wszystkich aplikacji (deploy, CI, dashboard).
// 200 + status "ok", gdy wszystkie checki przeszły; 503 + status "error", gdy
// któryś zawiódł. Checki mają być lekkie (np. SELECT 1), bez zewnętrznych API.
const CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// version: wynik readVersion(); checks: { nazwa: () => wartość | Promise },
// check zawodzi, gdy rzuci wyjątek, zwróci false albo przekroczy limit czasu.
function healthz({ version, checks = {}, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  if (!version) throw new Error('healthz: brak "version" (wynik readVersion())');
  return async function healthzHandler(req, res) {
    const results = {};
    let ok = true;
    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          const value = await withTimeout(Promise.resolve().then(check), timeoutMs);
          if (value === false) throw new Error('false');
          results[name] = 'ok';
        } catch (err) {
          ok = false;
          results[name] = 'error';
          console.error(`[healthz] check "${name}" nieudany:`, err.message);
        }
      })
    );
    res.set('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'error',
      app: version.name,
      version: version.version,
      commit: version.commit,
      date: version.date,
      uptime: Math.round(process.uptime()),
      node: process.versions.node,
      checks: results,
    });
  };
}

module.exports = { healthz };
