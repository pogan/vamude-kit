// Rodzina przeglądarki, system i typ urządzenia z User-Agenta - bez numerów
// wersji, bo te zmieniają się co kilka tygodni i rozbijałyby identyfikator
// odwiedzającego (patrz stats.js). Kolejność reguł ma znaczenie: Edge i Opera
// udają Chrome, a Chrome udaje Safari.
const BROWSERS = [
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
  let device = 'komputer';
  if (/iPad|Tablet/.test(ua) || (os === 'Android' && !/Mobile/.test(ua))) device = 'tablet';
  else if (/Mobi|iPhone|iPod/.test(ua)) device = 'telefon';
  return { browser, os, device };
}

module.exports = { parseUserAgent };
