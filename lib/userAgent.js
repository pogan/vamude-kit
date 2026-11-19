// Rodzina przeglądarki, system i typ urządzenia z User-Agenta - bez numerów
// wersji, bo te zmieniają się co kilka tygodni i rozbijałyby identyfikator
// odwiedzającego (patrz stats.js). Kolejność reguł ma znaczenie: Edge i Opera
// udają Chrome, a Chrome udaje Safari.
//
// Przeglądarki wbudowane w aplikacje (link z posta albo reklamy na Facebooku,
// Instagramie, TikToku) idą przed Chrome i Safari: na Androidzie udają Chrome,
// a na iOS nie mają w ogóle słowa "Safari", więc wcześniej wpadały do "inne".
// Kampanie w social media to głównie ten ruch - musi być widoczny osobno.
const BROWSERS = [
  ['Facebook (aplikacja)', /FBAN\/|FBAV\/|FB_IAB\//],
  ['Instagram (aplikacja)', /Instagram /],
  ['TikTok (aplikacja)', /musical_ly|BytedanceWebview|TikTok/],
  ['LinkedIn (aplikacja)', /LinkedInApp/],
  ['Google (aplikacja)', /GSA\//],
  ['Edge', /Edg(e|A|iOS)?\//],
  ['Opera', /OPR\/|Opera/],
  ['Samsung Internet', /SamsungBrowser\//],
  ['Firefox', /Firefox\/|FxiOS\//],
  ['Chrome', /Chrome\/|CriOS\//],
  ['Safari', /Safari\//],
];

const SYSTEMS = [
  ['iOS', /iPhone|iPad|iPod/],
  ['Android', /Android/],
  ['Windows', /Windows/],
  ['ChromeOS', /CrOS/],
  ['macOS', /Mac OS X|Macintosh/],
  ['Linux', /Linux/],
];

function match(rules, ua) {
  for (const [name, re] of rules) if (re.test(ua)) return name;
  return 'inne';
}

function parseUserAgent(ua = '') {
  const browser = match(BROWSERS, ua);
  const os = match(SYSTEMS, ua);
  // Inna aplikacja z wbudowanym WebKitem na iOS (np. Gmail, Messenger bez znacznika).
  const inApp = browser === 'inne' && os === 'iOS' && /AppleWebKit/.test(ua);
  let device = 'komputer';
  if (/iPad|Tablet/.test(ua) || (os === 'Android' && !/Mobile/.test(ua))) device = 'tablet';
  else if (/Mobi|iPhone|iPod/.test(ua)) device = 'telefon';
  return { browser: inApp ? 'inna aplikacja (iOS)' : browser, os, device };
}

// Przeglądarki sprzed lat, których ludzie już nie używają, a scrapery tak:
// listopad 2026 - 460 z ~500 "iPhone'ów" na stronach Vamude to jeden UA
// "iPhone OS 13_2_3 ... Version/13.0.3" z sieci chmurowych, bez pobierania CSS
// i obrazów. Progi: iOS <= 13 (2019; iPhone'y z iOS 14+ to wszystko od 6s
// wzwyż) i Chrome < 100 (2022; nawet Windows 7 kończy na 109).
function isOutdated(ua = '') {
  const ios = /(?:iPhone|CPU) OS (\d+)_/.exec(ua);
  if (ios && /iPhone|iPad|iPod/.test(ua) && Number(ios[1]) <= 13) return true;
  const chrome = /(?:Chrome|CriOS)\/(\d+)\./.exec(ua);
  if (chrome && Number(chrome[1]) < 100) return true;
  return false;
}

module.exports = { parseUserAgent, isOutdated };
