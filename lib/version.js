// Wersja aplikacji do stopki i /healthz: numer z package.json aplikacji (podbijany
// `npm version` przy wydaniu) plus skrót i data ostatniego commita. Deploy to
// git checkout, więc na serwerze i w podglądzie jest .git i każdy deploy da się
// rozpoznać nawet bez podbicia numeru. Brak gita (albo błąd) nie blokuje startu:
// zostaje numer z package.json, a commit można podać w APP_COMMIT.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(root, args) {
  try {
    // safe.directory: w kontenerze podglądu kod należy do innego użytkownika
    // niż proces, a git odmawia wtedy pracy w repo ("dubious ownership").
    return execFileSync('git', ['-c', `safe.directory=${root}`, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

// root: katalog aplikacji (z package.json). Domyślnie katalog roboczy procesu -
// PM2 (cwd w ecosystem.config.js), CI i `npm start` uruchamiają aplikację z niego.
function readVersion({ root = process.cwd(), env = process.env } = {}) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    // bez package.json zostaje sama informacja z gita
  }
  const commit = git(root, ['rev-parse', '--short', 'HEAD']) || env.APP_COMMIT || null;
  const date = git(root, ['log', '-1', '--format=%cs']);
  // Niezacommitowane zmiany w śledzonych plikach (typowo lokalny dev).
  const dirty = date ? Boolean(git(root, ['status', '--porcelain', '--untracked-files=no'])) : false;
  const version = pkg.version || null;
  const label = [version && `v${version}`, commit && `${commit}${dirty ? '-dirty' : ''}`, date]
    .filter(Boolean)
    .join(' · ');
  return { name: pkg.name || path.basename(root), version, commit, date, dirty, label };
}

module.exports = { readVersion };
