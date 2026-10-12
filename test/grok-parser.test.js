#!/usr/bin/env node
/**
 * Unitário de quota/grok-parser.js. Sem Electron.
 *
 * A asserção mais importante aqui é a NEGATIVA: quando o parser não reconhece a
 * saída, ele devolve `null`, e a UI mostra "sem dado". Um parser que chuta 0%
 * produz um painel de uso que mente — pior do que um painel vazio.
 *
 * O formato do `/usage` com conta SuperGrok logada NÃO foi verificado (não temos
 * a assinatura). Os casos "plausíveis" abaixo existem para que o parser não
 * quebre se o formato for um deles; não são promessa de que seja.
 *
 * Uso: node test/grok-parser.test.js
 */
const assert = require('assert');
const { parseGrokUsage, detectGrokLoggedOut } = require('../quota/grok-parser');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

// ── Não autenticado: VERIFICADO com o binário real (grok 0.2.93) ────────────
t('detecta a resposta literal do CLI sem login', () => {
  assert.strictEqual(detectGrokLoggedOut('You are not authenticated.\n\nDefault model: grok-build'), true);
});
t('detecta variantes de pedido de login', () => {
  assert.strictEqual(detectGrokLoggedOut('Please sign in to continue'), true);
  assert.strictEqual(detectGrokLoggedOut('run `grok login` first'), true);
});
t('não confunde texto comum com pedido de login', () => {
  assert.strictEqual(detectGrokLoggedOut('Weekly usage: 42%'), false);
  assert.strictEqual(detectGrokLoggedOut(''), false);
});

// ── A regra dura: sem reconhecimento, sem número ────────────────────────────
t('devolve null quando NADA casa (nunca inventa 0%)', () => {
  assert.strictEqual(parseGrokUsage('bem-vindo ao grok'), null);
  assert.strictEqual(parseGrokUsage(''), null);
  assert.strictEqual(parseGrokUsage(null), null);
  assert.strictEqual(parseGrokUsage('Ask anything...'), null);
});
t('rejeita percentual fora de 0..100', () => {
  assert.strictEqual(parseGrokUsage('usage: 420%'), null);
});

// ── Formatos plausíveis (NÃO verificados contra conta real) ─────────────────
t('lê "Weekly usage: 42%"', () => {
  const s = parseGrokUsage('Weekly usage: 42%');
  assert.strictEqual(s.usedPercent, 42);
  assert.strictEqual(s.percentLeft, 58);
});
t('lê "58% remaining" convertendo para uso', () => {
  assert.strictEqual(parseGrokUsage('58% remaining this week').usedPercent, 42);
});
t('lê "42% used"', () => {
  assert.strictEqual(parseGrokUsage('You have 42% used').usedPercent, 42);
});
t('atravessa ANSI e sequências OSC da TUI', () => {
  const sujo = '\x1b]0;grok\x07\x1b[38;2;1;2;3mWeekly usage: 7%\x1b[0m';
  assert.strictEqual(parseGrokUsage(sujo).usedPercent, 7);
});

// ── Estrutura do snapshot: pool SEMANAL, sem janela de 5h ───────────────────
t('preenche secondary (semanal) e deixa primary NULO', () => {
  const s = parseGrokUsage('Weekly usage: 30%');
  assert.strictEqual(s.primary, null, 'SuperGrok não tem janela de 5h');
  assert.ok(s.secondary, 'deve haver janela semanal');
  assert.strictEqual(s.window, 'weekly');
  assert.strictEqual(s.cli, 'grok');
});

// ── Reset relativo ──────────────────────────────────────────────────────────
t('converte "Resets in 3d" para timestamp absoluto', () => {
  const agora = 1_700_000_000_000;
  const s = parseGrokUsage('Weekly usage: 10%. Resets in 3d', agora);
  assert.strictEqual(s.secondary.resets_at_ms, agora + 3 * 86400e3);
});
t('converte "resets in 6h"', () => {
  const agora = 1_700_000_000_000;
  const s = parseGrokUsage('usage 10%, resets in 6h', agora);
  assert.strictEqual(s.secondary.resets_at_ms, agora + 6 * 3600e3);
});
t('sem reset reconhecível, resets_at fica null (não chuta data)', () => {
  const s = parseGrokUsage('Weekly usage: 10%. Resets on 16 Jul');
  assert.strictEqual(s.secondary.resets_at, null);
  assert.strictEqual(s.resetsAt, null);
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
