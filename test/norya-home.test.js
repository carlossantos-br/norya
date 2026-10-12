#!/usr/bin/env node
/**
 * Unitário de norya-home.js. Sem Electron.
 *
 * A ordem de resolução importa: durante a migração os DOIS caminhos existem
 * (`~/.codex-panel` vira symlink para `~/.norya`). O canônico tem que ganhar,
 * senão o app fica lendo pelo link para sempre e a migração nunca "termina".
 *
 * Uso: node test/norya-home.test.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const { resolverNoryaHome, CANDIDATOS, NORYA_HOME } = require('../norya-home');

const H = os.homedir();
const NOVO = path.join(H, '.norya');
const LEGADO = path.join(H, '.codex-panel');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

const existeApenas = (...paths) => p => paths.includes(p);
const nadaExiste = () => false;

t('$NORYA_HOME vence tudo', () => {
  assert.strictEqual(resolverNoryaHome({ NORYA_HOME: '/tmp/x' }, () => true), '/tmp/x');
});

t('só o legado existe → usa o legado', () => {
  assert.strictEqual(resolverNoryaHome({}, existeApenas(LEGADO)), LEGADO);
});

t('só o novo existe → usa o novo', () => {
  assert.strictEqual(resolverNoryaHome({}, existeApenas(NOVO)), NOVO);
});

t('AMBOS existem (symlink pós-migração) → prefere o canônico ~/.norya', () => {
  assert.strictEqual(resolverNoryaHome({}, existeApenas(NOVO, LEGADO)), NOVO);
});

t('nenhum existe (instalação nova) → cria em ~/.norya', () => {
  assert.strictEqual(resolverNoryaHome({}, nadaExiste), NOVO);
});

t('a ordem dos candidatos é canônico antes de legado', () => {
  assert.deepStrictEqual(CANDIDATOS, [NOVO, LEGADO]);
});

t('NORYA_HOME resolvido aponta para um dos candidatos ou para o env', () => {
  assert.ok(NORYA_HOME === process.env.NORYA_HOME || CANDIDATOS.includes(NORYA_HOME),
    `inesperado: ${NORYA_HOME}`);
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
