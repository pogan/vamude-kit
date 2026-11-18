// Weryfikacja tokenu "Sign in with Google" (Google Identity Services): JWT
// podpisany RS256 kluczem Google. Bez dodatkowych zależności: klucze publiczne
// (JWKS) pobieramy z Google i trzymamy w pamięci tyle, ile pozwala Cache-Control.
const crypto = require('crypto');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_S = 60;

function createKeyStore({ url = CERTS_URL, fetchImpl = globalThis.fetch } = {}) {
  let cache = { keys: new Map(), until: 0 };
  return async function getKey(kid) {
    if (Date.now() >= cache.until || !cache.keys.has(kid)) {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`klucze Google: HTTP ${res.status}`);
      const { keys } = await res.json();
      const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
      cache = {
        keys: new Map(keys.map((jwk) => [jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })])),
        until: Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000,
      };
    }
    return cache.keys.get(kid);
  };
}

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// Zwraca dane z tokenu (email, email_verified, name...) albo rzuca błąd.
function createVerifier({ clientId, getKey = createKeyStore(), now = Date.now } = {}) {
  return async function verifyIdToken(token) {
    if (!clientId) throw new Error('brak GOOGLE_CLIENT_ID');
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('to nie jest JWT');
    const header = decodePart(parts[0]);
    if (header.alg !== 'RS256') throw new Error(`nieobsługiwany algorytm ${header.alg}`);
    const key = await getKey(header.kid);
    if (!key) throw new Error('nieznany klucz podpisu');
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url')
    );
    if (!ok) throw new Error('zły podpis');
    const payload = decodePart(parts[1]);
    const t = Math.floor(now() / 1000);
    if (!ISSUERS.has(payload.iss)) throw new Error('zły wystawca');
    if (payload.aud !== clientId) throw new Error('token dla innej aplikacji');
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < t) throw new Error('token wygasł');
    if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > t) throw new Error('token z przyszłości');
    return payload;
  };
}

module.exports = { createVerifier, createKeyStore };
