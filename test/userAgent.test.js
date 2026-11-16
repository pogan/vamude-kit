const test = require('node:test');
const assert = require('node:assert');
const { parseUserAgent } = require('../lib/userAgent');

const cases = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome', 'Windows', 'komputer'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge', 'Windows', 'komputer'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 'Safari', 'iOS', 'telefon'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1', 'Chrome', 'iOS', 'telefon'],
  ['Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 'Safari', 'iOS', 'tablet'],
  ['Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0', 'Firefox', 'Android', 'telefon'],
  ['Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome', 'Android', 'tablet'],
  ['Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36', 'Samsung Internet', 'Android', 'telefon'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15', 'Safari', 'macOS', 'komputer'],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', 'Firefox', 'Linux', 'komputer'],
  ['', 'inne', 'inne', 'komputer'],
];

test('rodzina przeglądarki, system i urządzenie bez wersji', () => {
  for (const [ua, browser, os, device] of cases) {
    assert.deepEqual(parseUserAgent(ua), { browser, os, device }, ua);
  }
});
