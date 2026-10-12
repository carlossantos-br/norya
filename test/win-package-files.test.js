#!/usr/bin/env node
/**
 * O pacote do Windows também copia por ALLOWLIST (`files:` do
 * electron-builder.win.yml). Arquivo novo que ninguém põe lá não dá erro no
 * build — o instalador sai, instala, e o app morre no boot com
 * "Cannot find module" na máquina do usuário.
 *
 * Aconteceu: o port de 2026-09 nunca ganhou ui-prefs.js, chat/, token-stats.js,
 * pricing.js, fx.js, pet/ nem o hook do Claude — o main.js de Windows não subia.
 *
 * Este teste é o irmão do deploy-allowlist.test.js (que guarda o deploy.sh do
 * Mac): segue todo require() relativo ALCANÇÁVEL a partir do main.js e do
 * test-window.html (scripts e <script> inline), mais os arquivos que o app abre
 * por caminho em runtime (helpers, shims de bin/), e exige que o `files:` do
 * yml inclua cada um — com a semântica de glob do electron-builder (o último
 * padrão que casa decide; `!` exclui).
 *
 * Uso: node test/win-package-files.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

// ── `files:` do yml ─────────────────────────────────────────────────────────
function lerPadroes() {
  const linhas = fs.readFileSync(path.join(RAIZ, 'electron-builder.win.yml'), 'utf8').split('\n');
  const i = linhas.findIndex(l => /^files:\s*$/.test(l));
  assert.ok(i >= 0, 'electron-builder.win.yml sem `files:`');
  const out = [];
  for (const l of linhas.slice(i + 1)) {
    if (/^\S/.test(l)) break;                       // próxima chave de topo
    const m = l.match(/^\s+-\s+"([^"]+)"/) || l.match(/^\s+-\s+'([^']+)'/) || l.match(/^\s+-\s+([^\s#]+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Glob do electron-builder (minimatch) → RegExp. Cobre o que o yml usa. */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const antes = i === 0 || glob[i - 1] === '/';
      const depois = glob[i + 2] === '/' || i + 2 === glob.length;
      if (antes && glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; continue; }   // **/  = zero ou mais pastas
      if (antes && depois) { re += '.*'; i += 1; continue; }                       // /**  = tudo abaixo
      re += '.*'; i += 1; continue;
    }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '{') {
      const fim = glob.indexOf('}', i);
      re += '(?:' + glob.slice(i + 1, fim).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = fim; continue;
    }
    re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

const PADROES = lerPadroes().map(p => ({ neg: p.startsWith('!'), re: globRe(p.replace(/^!/, '')), src: p }));

/** O último padrão que casa decide (como no electron-builder). */
function incluido(rel) {
  let dentro = false;
  for (const p of PADROES) if (p.re.test(rel)) dentro = !p.neg;
  return dentro;
}

// ── O que o app alcança ─────────────────────────────────────────────────────
const NATIVOS = new Set(require('module').builtinModules);
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
const DEPS = new Set(Object.keys(pkg.dependencies || {}));

function resolver(base, alvo) {
  const abs = path.resolve(base, alvo);
  for (const ext of ['', '.js', '.json', '/index.js']) {
    const f = abs + ext;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

const alcancaveis = new Set();   // relativos à raiz
const quebrados = [];
const bare = new Set();

/**
 * @param {string} arquivo  absoluto
 * @param {string} baseReq  pasta contra a qual os require('./x') resolvem —
 *   a do próprio arquivo, ou a do HTML para scripts clássicos do renderer
 *   (no renderer o require relativo parte da página, não do script).
 */
function seguir(arquivo, baseReq) {
  const rel = path.relative(RAIZ, arquivo).split(path.sep).join('/');
  if (alcancaveis.has(rel)) return;
  alcancaveis.add(rel);
  if (!arquivo.endsWith('.js')) return;
  const src = fs.readFileSync(arquivo, 'utf8');
  for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const alvo = m[1];
    if (alvo.startsWith('.')) {
      const f = resolver(baseReq, alvo);
      if (f) seguir(f, path.dirname(f));
      else quebrados.push(`${rel} → ${alvo}`);
    } else {
      bare.add(alvo);
    }
  }
}

seguir(path.join(RAIZ, 'main.js'), RAIZ);

const html = fs.readFileSync(path.join(RAIZ, 'test-window.html'), 'utf8');
alcancaveis.add('test-window.html');
for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
  if (/^(https?:)?\/\//.test(m[1])) continue;
  const f = path.join(RAIZ, m[1]);
  if (!fs.existsSync(f)) { quebrados.push(`test-window.html → ${m[1]}`); continue; }
  seguir(f, RAIZ);
}
for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)) {
  if (!/^(https?:)?\/\//.test(m[1])) alcancaveis.add(m[1]);
}
// require() de <script> inline (o <head> lê platform.js e ui-prefs.js antes do 1º paint).
for (const bloco of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  for (const m of bloco[1].matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const f = resolver(RAIZ, m[1]);
    if (f) seguir(f, path.dirname(f)); else quebrados.push(`test-window.html (inline) → ${m[1]}`);
  }
}

// Arquivos que o app abre por CAMINHO, não por require: `path.join(__dirname, 'a', 'b')`
// só com literais no main.js. Os de macOS (helper Swift do Mini) ficam de fora.
// assets/pet: sprites do Mini (só macOS), gerados localmente e fora do repositório.
const SO_MAC = new Set(['helpers/runtime/norya-pet', 'helpers/norya-pet/build/norya-pet', 'assets/pet']);
const mainSrc = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8');
for (const m of mainSrc.matchAll(/path\.join\(__dirname((?:\s*,\s*'[^']*')+)\s*\)/g)) {
  const partes = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
  const rel = partes.join('/');
  if (SO_MAC.has(rel)) continue;
  const abs = path.join(RAIZ, ...partes);
  if (!fs.existsSync(abs)) continue;
  if (fs.statSync(abs).isDirectory()) {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) if (e.isFile()) alcancaveis.add(`${rel}/${e.name}`);
  } else alcancaveis.add(rel);
}
// Shims de Windows: os nomes vêm do platform.js (openShimDirName/BinName, authOpenBinName).
const { makePlatform } = require('../platform');
const win = makePlatform({ platform: 'win32', env: {}, homedir: 'C:\\Users\\x', exists: () => false });
for (const e of fs.readdirSync(path.join(RAIZ, 'bin', win.openShimDirName()))) alcancaveis.add(`bin/${win.openShimDirName()}/${e}`);
alcancaveis.add(`bin/${win.authOpenBinName()}`);
for (const f of ['bin/norya-browser.cmd', 'bin/norya-browser-mcp.cmd', 'bin/norya-browser-mcp.js']) {
  alcancaveis.add(f);
  seguir(path.join(RAIZ, f), path.join(RAIZ, 'bin'));
}
// O hook do Claude roda como script (`node.exe norya-claude-event.js`), e o que ele requer também.
seguir(path.join(RAIZ, 'helpers', 'norya-claude-event.js'), path.join(RAIZ, 'helpers'));

// ── As provas ───────────────────────────────────────────────────────────────
t('todo require() relativo alcançável resolve para um arquivo do repo', () => {
  assert.deepStrictEqual(quebrados, [], `require/script quebrado: ${quebrados.join(' | ')}`);
});

t(`todo arquivo alcançável (${alcancaveis.size}) entra no files: do yml`, () => {
  const fora = [...alcancaveis].filter(r => !incluido(r)).sort();
  assert.deepStrictEqual(fora, [], `o instalador do Windows vai sair SEM: ${fora.join(', ')}`);
});

t('todo require() de pacote é builtin ou dependência de RUNTIME (não devDependency)', () => {
  const faltando = [...bare].filter(m => {
    if (m.startsWith('node:') || m === 'electron') return false;
    const raiz = m.startsWith('@') ? m.split('/').slice(0, 2).join('/') : m.split('/')[0];
    return !NATIVOS.has(raiz) && !DEPS.has(raiz);
  });
  assert.deepStrictEqual(faltando, [], `fora de dependencies do package.json: ${faltando.join(', ')}`);
});

t('o que é só do macOS / do repo fica FORA do pacote', () => {
  for (const r of ['helpers/norya-pet/Package.swift', 'helpers/norya-pet/build/norya-pet',
    'helpers/ensure-signing-identity.sh', 'tools/pet-assets.py', 'docs/windows.md',
    'test/platform.test.js', 'build/verify-win-package.js', 'dist/x.exe', 'quota/test/x.test.js',
    'browser/test/x.test.js', 'assets/icon.iconset/icon_16x16.png', 'assets/pet/manifest.json',
    'node_modules/node-pty/build/Release/pty.node', 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node']) {
    assert.ok(!incluido(r), `não devia ir para o Windows: ${r}`);
  }
});

t('o node-pty de win32 continua entrando', () => {
  assert.ok(incluido('node_modules/node-pty/prebuilds/win32-x64/conpty.node'));
  assert.ok(incluido('node_modules/node-pty/lib/index.js'));
});

t('o glob se comporta como o do electron-builder nos casos do yml', () => {
  assert.ok(globRe('agents/**').test('agents/a/b.js'));
  assert.ok(!globRe('agents/**').test('agentsx/a.js'));
  assert.ok(globRe('**/*.md').test('README.md'));
  assert.ok(globRe('**/{test,docs}/**').test('node_modules/x/test/a.js'));
  assert.ok(!globRe('main.js').test('x/main.js'));
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
