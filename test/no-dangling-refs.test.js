#!/usr/bin/env node
/**
 * Guarda contra referência a arquivo deletado.
 *
 * Motivo: em 2026-07-09 a Fase 1 deletou `browser-preload.js`, mas `main.js`
 * seguia montando `path.join(__dirname, 'browser-preload.js')` e passando o
 * caminho como `preload:` de um popup de OAuth. Um preload inexistente NÃO
 * derruba a janela no Electron — falha em silêncio. `node --check` não vê
 * (o caminho é construído em runtime) e os smokes não viam (nenhum abre popup).
 *
 * Este teste varre o código à procura de nomes de arquivos que já não existem.
 * É barato e pega a classe inteira, não só o caso que nos mordeu.
 *
 * Uso: node test/no-dangling-refs.test.js   → exit 0 = PASS, 1 = FAIL
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = path.join(__dirname, '..');

/** Arquivos e diretórios removidos que NÃO podem mais ser mencionados no código. */
const REMOVIDOS = [
  'browser-preload.js',
  'aider-bridge.py',
  'norya-pip.html',
  'norya-pip-mini.html',
  'browser/tor-manager',
  'browser/privacy-hardener',
  'browser/password-vault',
  'browser/extension-loader',
  'bin/tor',
  'scripts/bundle-tor.sh',
];

/** Onde procurar. Testes e docs podem citar os nomes (é o assunto deles). */
const ALVOS = [
  'main.js',
  'test-window.html',
  'deploy.sh',
  ...fs.readdirSync(path.join(APP, 'renderer')).filter(f => f.endsWith('.js')).map(f => `renderer/${f}`),
  ...fs.readdirSync(path.join(APP, 'browser')).filter(f => f.endsWith('.js')).map(f => `browser/${f}`),
  ...fs.readdirSync(path.join(APP, 'agents')).filter(f => f.endsWith('.js')).map(f => `agents/${f}`),
];

/** deploy.sh PRECISA citar os removidos: é ele quem os poda do bundle. */
const ISENTOS = new Set(['deploy.sh']);

let falhas = 0;
const achados = [];

for (const alvo of ALVOS) {
  if (ISENTOS.has(alvo)) continue;
  const p = path.join(APP, alvo);
  let src;
  try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }

  const linhas = src.split('\n');
  for (const removido of REMOVIDOS) {
    linhas.forEach((linha, i) => {
      if (!linha.includes(removido)) return;
      // Comentário que documenta a remoção é legítimo — só código conta.
      const semComentario = linha.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (!semComentario.includes(removido)) return;
      achados.push(`${alvo}:${i + 1}  → ${removido}\n        ${linha.trim().slice(0, 100)}`);
      falhas++;
    });
  }
}

if (achados.length) {
  console.log('FAIL  referências a arquivos removidos:\n');
  achados.forEach(a => console.log('  ' + a));
} else {
  console.log(`PASS  nenhuma referência a ${REMOVIDOS.length} arquivos removidos (${ALVOS.length - ISENTOS.size} arquivos varridos)`);
}

// Verificação cruzada: os arquivos listados como removidos realmente sumiram?
// Se algum voltou, esta lista está errada e o teste vira ruído.
const ressuscitados = REMOVIDOS.filter(r => fs.existsSync(path.join(APP, r)) || fs.existsSync(path.join(APP, r + '.js')));
if (ressuscitados.length) {
  console.log(`FAIL  estes voltaram a existir — atualize a lista: ${ressuscitados.join(', ')}`);
  falhas++;
} else {
  console.log('PASS  todos os arquivos da lista seguem removidos');
}

assert.strictEqual(falhas, 0, `${falhas} referência(s) pendurada(s)`);
console.log('\nTUDO PASSOU');
