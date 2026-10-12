#!/usr/bin/env node
/**
 * Unitário de browser/dev-url.js — extração de URL de dev server do stdout.
 * Sem Electron. Uso: node test/dev-url.test.js
 */
const assert = require('assert');
const { findDevUrls } = require('../browser/dev-url');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };
const urls = txt => findDevUrls(txt).map(x => x.url);

t('acha a URL do Vite', () => {
  assert.deepStrictEqual(urls('  ➜  Local:   http://localhost:5173/'), ['http://localhost:5173/']);
});

t('acha 127.0.0.1 e 0.0.0.0 com porta', () => {
  assert.deepStrictEqual(urls('serving on http://127.0.0.1:8000'), ['http://127.0.0.1:8000']);
  assert.deepStrictEqual(urls('bound http://0.0.0.0:3000/app'), ['http://0.0.0.0:3000/app']);
});

t('atravessa códigos ANSI', () => {
  const ansi = '\x1b[32m  ➜  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:5173/\x1b[39m\x1b[0m';
  assert.deepStrictEqual(urls(ansi), ['http://localhost:5173/']);
});

t('tira pontuação colada no fim', () => {
  assert.deepStrictEqual(urls('rodando em http://localhost:4000.'), ['http://localhost:4000']);
  assert.deepStrictEqual(urls('veja http://localhost:4001, depois'), ['http://localhost:4001']);
});

t('dedupe por origem dentro do mesmo chunk', () => {
  const txt = 'http://localhost:5173/ e http://localhost:5173/about e http://localhost:5174/';
  assert.deepStrictEqual(urls(txt), ['http://localhost:5173/', 'http://localhost:5174/']);
});

t('IGNORA URL externa (conteúdo, não pedido de abrir)', () => {
  assert.deepStrictEqual(urls('veja https://example.com/docs e https://github.com/x'), []);
  assert.deepStrictEqual(urls('curl https://api.openai.com/v1'), []);
});

t('não casa com host que apenas SE PARECE com loopback', () => {
  // Sem lookahead, `localhost` casaria dentro de `localhostage.com` e abriríamos
  // uma aba para um domínio externo. Mesma armadilha com `127.0.0.1.evil.com`.
  for (const disfarce of [
    'http://localhostage.com/x',
    'https://localhost.evil.com/',
    'http://127.0.0.1.evil.com/',
    'http://0.0.0.0.attacker.net/',
    'http://localhost-staging.io/',
  ]) {
    const r = urls(disfarce);
    assert.deepStrictEqual(r, [], `${disfarce} não deveria casar, casou: ${JSON.stringify(r)}`);
  }
});

t('ainda casa loopback legítimo com porta e caminho', () => {
  assert.deepStrictEqual(urls('http://localhost:5173/a/b'), ['http://localhost:5173/a/b']);
  assert.deepStrictEqual(urls('http://localhost/'), ['http://localhost/']);
});

t('não explode com entrada vazia ou lixo', () => {
  assert.deepStrictEqual(urls(''), []);
  assert.deepStrictEqual(urls(null), []);
  assert.deepStrictEqual(urls('http://'), []);
});

t('devolve origin junto da url', () => {
  const [x] = findDevUrls('http://localhost:5173/rota/funda?q=1');
  assert.strictEqual(x.origin, 'http://localhost:5173');
  assert.strictEqual(x.url, 'http://localhost:5173/rota/funda?q=1');
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
