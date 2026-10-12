'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('function ensureConfig(dir) {');
const end = source.indexOf('\nconst terminals =', start);
assert.ok(start >= 0 && end > start);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-vault-profile-'));
const home = path.join(root, 'home');
const shared = path.join(home, '.codex');
fs.mkdirSync(shared, { recursive: true });

function ensure(dir, isWin = false, filesystem = fs) {
  const context = { fs: filesystem, path, REAL_HOME: home,
    DEFAULT_CONFIG_TOML: 'model = "gpt-5.5"\n', platform: { isWin },
    logError(label, error) { throw new Error(label + ': ' + error.message); } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.ensureConfig(dir);
}

try {
  fs.writeFileSync(path.join(shared, 'AGENTS.md'), 'Instruções do usuário.');
  fs.writeFileSync(path.join(shared, 'hooks.json'), '{"hooks":{}}');
  const profile = path.join(root, 'new');
  ensure(profile);
  for (const name of ['AGENTS.md', 'hooks.json']) {
    const link = path.join(profile, '.codex', name);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.strictEqual(fs.realpathSync(link), fs.realpathSync(path.join(shared, name)));
  }
  fs.writeFileSync(path.join(shared, 'hooks.json'), '{"hooks":{"Stop":[]}}');
  assert.strictEqual(fs.readFileSync(path.join(profile, '.codex', 'hooks.json'), 'utf8'),
                     '{"hooks":{"Stop":[]}}');
  ensure(profile); // Repeated launches preserve the shared links.

  const custom = path.join(root, 'custom');
  fs.mkdirSync(path.join(custom, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(custom, '.codex', 'AGENTS.md'), 'Instrução própria.');
  fs.writeFileSync(path.join(custom, '.codex', 'hooks.json'), '{"custom":true}');
  ensure(custom);
  assert.strictEqual(fs.readFileSync(path.join(custom, '.codex', 'AGENTS.md'), 'utf8'), 'Instrução própria.');
  assert.strictEqual(fs.readFileSync(path.join(custom, '.codex', 'hooks.json'), 'utf8'), '{"custom":true}');

  const windows = path.join(root, 'windows');
  const winFs = Object.create(fs);
  winFs.symlinkSync = (target, link, type) => {
    if (path.basename(link) === 'skills') return fs.symlinkSync(target, link, type);
    const error = new Error('Windows symlink permission'); error.code = 'EPERM'; throw error;
  };
  ensure(windows, true, winFs);
  assert.strictEqual(fs.readFileSync(path.join(windows, '.codex', 'AGENTS.md'), 'utf8'), 'Instruções do usuário.');

  fs.unlinkSync(path.join(shared, 'AGENTS.md'));
  fs.unlinkSync(path.join(shared, 'hooks.json'));
  const absent = path.join(root, 'absent');
  ensure(absent);
  assert.ok(!fs.existsSync(path.join(absent, '.codex', 'AGENTS.md')));
  assert.ok(!fs.existsSync(path.join(absent, '.codex', 'hooks.json')));
  console.log('vault-profile-config.test.js PASS: herança, idempotência, atualização, arquivos próprios, Windows e ausência.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
