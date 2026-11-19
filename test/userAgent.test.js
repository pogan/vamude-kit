const test = require('node:test');
const assert = require('node:assert');
const { parseUserAgent, isOutdated } = require('../lib/userAgent');

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
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/490.0.0;FBBV/1;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.1;FBLC/pl_PL]', 'Facebook (aplikacja)', 'iOS', 'telefon'],
  ['Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/490.0;]', 'Facebook (aplikacja)', 'Android', 'telefon'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0 (iPhone15,2; iOS 18_1; pl_PL; pl; scale=3.00; 1179x2556; 123)', 'Instagram (aplikacja)', 'iOS', 'telefon'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/340.0 Mobile/15E148 Safari/604.1', 'Google (aplikacja)', 'iOS', 'telefon'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'inna aplikacja (iOS)', 'iOS', 'telefon'],
  ['', 'inne', 'inne', 'komputer'],
];

test('rodzina przeglądarki, system i urządzenie bez wersji', () => {
  for (const [ua, browser, os, device] of cases) {
    assert.deepEqual(parseUserAgent(ua), { browser, os, device }, ua);
  }
});

test('przestarzałe przeglądarki (scrapery) rozpoznawane, aktualne nie', () => {
  const old = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36',
  ];
  for (const ua of old) assert.equal(isOutdated(ua), true, ua);
  for (const [ua] of cases) assert.equal(isOutdated(ua), false, ua);
  assert.equal(isOutdated('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1'), false);
  assert.equal(isOutdated('Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36'), false);
});
