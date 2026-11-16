const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readVersion } = require('..');

test('w repo git: numer z package.json, commit i data', () => {
  const v = readVersion({ root: path.join(__dirname, '..') });
  assert.equal(v.name, 'vamude-kit');
  assert.match(v.version, /^\d+\.\d+\.\d+$/);
  assert.match(v.commit, /^[0-9a-f]{7,}$/);
  assert.match(v.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(v.label.startsWith(`v${v.version} · ${v.commit}`));
});

test('bez gita: sam numer, commit z APP_COMMIT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-version-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'strona', version: '2.1.0' }));
  assert.deepEqual(readVersion({ root: dir, env: {} }), {
    name: 'strona', version: '2.1.0', commit: null, date: null, dirty: false, label: 'v2.1.0',
  });
  assert.equal(readVersion({ root: dir, env: { APP_COMMIT: 'abc1234' } }).label, 'v2.1.0 · abc1234');
});
