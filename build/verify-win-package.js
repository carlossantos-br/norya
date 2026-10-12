#!/usr/bin/env node
'use strict';
/**
 * build/verify-win-package.js — auditoria do pacote Windows, rodando no Mac.
 *
 * Não dá para executar o app aqui. O que DÁ para provar, e é onde moram os
 * erros que só apareceriam depois de instalado:
 *
 *   • um `require()` apontando para arquivo que não foi empacotado
 *     (o deploy por allowlist já causou isso no macOS mais de uma vez);
 *   • um `<script src>` do renderer que não existe no pacote — falha MUDA:
 *     a página carrega e a função simplesmente não está definida;
 *   • um binário de macOS (Mach-O) dentro do app de Windows;
 *   • o node-pty sem os .node de win32, ou COM o build/ de macOS na frente
 *     (o loader procura build/Release ANTES de prebuilds/).
 *
 * Uso: node build/verify-win-package.js [dir]   (default: dist/win-unpacked)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ_DIST = process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked');
const APP = path.join(RAIZ_DIST, 'resources', 'app');

let falhas = 0;
const ok = m => console.log(`PASS  ${m}`);
const falhou = m => { console.log(`FAIL  ${m}`); falhas++; };
const check = (cond, m) => cond ? ok(m) : falhou(m);

if (!fs.existsSync(APP)) {
  console.error(`Pacote não encontrado em ${APP}. Rode: npm run dist:win`);
  process.exit(1);
}

// ── 1. Arquivos que o app precisa para nascer ────────────────────────────────
const OBRIGATORIOS = [
  'main.js', 'platform.js', 'norya-home.js', 'claude-meta.js', 'test-window.html',
  'ui-prefs.js', 'token-stats.js', 'pricing.js', 'fx.js',
  'package.json', 'renderer/keycaps.js', 'helpers/badge-icon.js',
  'helpers/norya-claude-event.js',
  'agents/registry.js', 'agents/commands.js', 'agents/claude-hook.js',
  'chat/chat-session.js', 'chat/chat-protocol.js', 'chat/chat-files.js',
  'pet/pet-manager.js',
  'browser/mcp-server.js', 'browser/auth-flow-router.js', 'quota/index.js',
  'bin/open-shim-win/norya-open.js', 'bin/open-shim-win/norya-open.cmd',
  'bin/open-shim-win/open.cmd', 'bin/open-shim-win/xdg-open.cmd',
  'bin/norya-auth-open.cmd', 'bin/norya-browser.cmd',
];
for (const f of OBRIGATORIOS) check(fs.existsSync(path.join(APP, f)), `presente: ${f}`);
// Só de macOS (fonte Swift do Mini, ferramentas e docs do repo): não vão.
for (const f of ['helpers/norya-pet', 'tools', 'docs', 'test', 'build', 'dist']) {
  check(!fs.existsSync(path.join(APP, f)), `ausente: ${f}/`);
}

// ── 2. node-pty: os binários certos, e SÓ eles ───────────────────────────────
const PTY = path.join(APP, 'node_modules', 'node-pty');
for (const f of ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty-agent.exe', 'winpty.dll']) {
  check(fs.existsSync(path.join(PTY, 'prebuilds', 'win32-x64', f)), `node-pty win32-x64: ${f}`);
}
check(!fs.existsSync(path.join(PTY, 'build')),
  'node-pty SEM build/ (o loader olha build/Release antes de prebuilds/)');
check(!fs.existsSync(path.join(PTY, 'prebuilds', 'darwin-arm64')),
  'node-pty sem prebuilds de macOS');

// ── 3. Nada de Mach-O no pacote ──────────────────────────────────────────────
{
  const suspeitos = [];
  const anda = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { anda(p); continue; }
      if (!/\.(node|dylib|so|exe|dll)$/i.test(e.name)) continue;
      const fd = fs.openSync(p, 'r');
      const b = Buffer.alloc(4);
      fs.readSync(fd, b, 0, 4, 0);
      fs.closeSync(fd);
      const magic = b.readUInt32BE(0);
      // Mach-O: feedface / feedfacf / cafebabe (fat)
      if ([0xfeedface, 0xfeedfacf, 0xcafebabe].includes(magic)) suspeitos.push(path.relative(APP, p));
    }
  };
  anda(APP);
  check(suspeitos.length === 0, `nenhum binário de macOS no pacote${suspeitos.length ? ' — ' + suspeitos.join(', ') : ''}`);
}

// ── 4. Todo require() do nosso código resolve dentro do pacote ───────────────
{
  const NATIVOS = new Set([
    'fs', 'path', 'os', 'net', 'crypto', 'child_process', 'https', 'http', 'zlib',
    'events', 'util', 'stream', 'url', 'assert', 'worker_threads', 'readline',
    'node:sqlite', 'node:test', 'electron', 'tty', 'buffer', 'timers',
  ]);
  const nossos = [];
  const anda = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) anda(p);
      else if (e.name.endsWith('.js')) nossos.push(p);
    }
  };
  anda(APP);

  // Script clássico carregado pelo test-window.html: no renderer o require
  // relativo parte da PÁGINA (raiz do app), não da pasta do script — é assim
  // que renderer/settings.js acha `./platform`.
  const doHtml = new Set([...fs.readFileSync(path.join(APP, 'test-window.html'), 'utf8')
    .matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => path.join(APP, m[1])));
  const quebrados = [];
  for (const arquivo of nossos) {
    const src = fs.readFileSync(arquivo, 'utf8');
    for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const alvo = m[1];
      if (alvo.startsWith('.')) {
        const base = path.resolve(doHtml.has(arquivo) ? APP : path.dirname(arquivo), alvo);
        const existe = ['', '.js', '.json', '/index.js'].some(ext => fs.existsSync(base + ext));
        if (!existe) quebrados.push(`${path.relative(APP, arquivo)} → ${alvo}`);
      } else {
        const raiz = alvo.startsWith('@') ? alvo.split('/').slice(0, 2).join('/') : alvo.split('/')[0];
        if (NATIVOS.has(alvo) || NATIVOS.has(raiz) || alvo.startsWith('node:')) continue;
        if (!fs.existsSync(path.join(APP, 'node_modules', raiz))) quebrados.push(`${path.relative(APP, arquivo)} → ${alvo}`);
      }
    }
  }
  check(quebrados.length === 0,
    `todos os require() resolvem (${nossos.length} arquivos)${quebrados.length ? ' — QUEBRADOS: ' + quebrados.join(' | ') : ''}`);
}

// ── 5. Todo <script src> e <link href> do renderer existe ────────────────────
{
  const html = fs.readFileSync(path.join(APP, 'test-window.html'), 'utf8');
  const refs = [
    ...[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1]),
    ...[...html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)].map(m => m[1]),
  ].filter(r => !/^(https?:)?\/\//.test(r));
  const faltando = refs.filter(r => !fs.existsSync(path.join(APP, r)));
  check(faltando.length === 0,
    `todos os ${refs.length} assets do HTML existem${faltando.length ? ' — FALTANDO: ' + faltando.join(', ') : ''}`);
  check(html.includes('renderer/keycaps.js'), 'keycaps.js é carregado pelo HTML');
  check(html.indexOf('renderer/keycaps.js') < html.indexOf('renderer/state.js'),
    'keycaps.js carrega ANTES de state.js (KC/kc são globais)');
}

// ── 6. Os .cmd precisam de CRLF ──────────────────────────────────────────────
{
  const cmds = ['bin/norya-auth-open.cmd', 'bin/norya-browser.cmd',
                'bin/open-shim-win/open.cmd', 'bin/open-shim-win/norya-open.cmd'];
  const semCrlf = cmds.filter(c => !fs.readFileSync(path.join(APP, c), 'utf8').includes('\r\n'));
  check(semCrlf.length === 0, `.cmd com CRLF${semCrlf.length ? ' — LF puro: ' + semCrlf.join(', ') : ''}`);
}

// ── 7. Executável e ícone ────────────────────────────────────────────────────
check(fs.existsSync(path.join(RAIZ_DIST, 'Norya.exe')), 'Norya.exe no pacote');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  check(fs.existsSync(path.join(APP, pkg.main)), `package.json main aponta para arquivo real (${pkg.main})`);
  for (const dep of Object.keys(pkg.dependencies || {})) {
    check(fs.existsSync(path.join(APP, 'node_modules', dep)), `dependência empacotada: ${dep}`);
  }
}

console.log(falhas === 0 ? '\n✓ PACOTE ÍNTEGRO' : `\n✗ ${falhas} PROBLEMA(S)`);
process.exit(falhas ? 1 : 0);
