#!/usr/bin/env node
/**
 * Unitário de quota/pty-parser.js — parseClaudeStatus com a saída REAL do
 * `/usage` do Claude Code 2.1.263 (fixture capturada via node-pty, 2026-09-08).
 *
 * O PTY entrega o texto "colado" (`Currentsession`, `Resets4:50pm`) e, em
 * redraws parciais, com espaços e tudo numa linha só. O parser lê os dois.
 * Bug original: as regexes exigiam `\s+` entre as palavras → a janela de 5h e
 * todos os resets sumiam (cache real: primary null, resets_at null).
 *
 * Uso: node test/pty-parser-claude.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseClaudeStatus } = require('../quota/pty-parser');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-usage-2.1.263.txt'), 'utf8');
let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };
const hm = ms => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const mdhm = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${hm(ms)}`; };

t('fixture real: sessão (5h), semana (todos) e semana (Fable)', () => {
  const s = parseClaudeStatus(fixture);
  assert.ok(s, 'não parseou a fixture');
  assert.strictEqual(s.primary.used_percent, 5);
  assert.strictEqual(s.secondary.used_percent, 16);
  assert.deepStrictEqual(s.windows.map(w => w.id), ['session', 'weekly', 'weekly:Fable']);
  assert.strictEqual(s.windows[2].used_percent, 24);
  assert.strictEqual(s.windows[2].label, 'Semana · Fable');
  assert.strictEqual(s.usedPercent, 24, 'usedPercent = máximo entre TODAS as janelas');
  assert.strictEqual(s.percentLeft, 76);
});

t('fixture real: reset lido janela a janela (colado e com espaços)', () => {
  const s = parseClaudeStatus(fixture);
  assert.strictEqual(hm(s.primary.resets_at_ms), '16:50', 'Resets4:50pm');
  assert.strictEqual(mdhm(s.secondary.resets_at_ms), '9/9 16:00', 'ResetsSep9at4pm');
  assert.strictEqual(mdhm(s.windows[2].resets_at_ms), '9/9 15:59', 'Resets Sep 9 at 3:59pm');
});

t('formato com espaços (versões anteriores) continua lido', () => {
  const s = parseClaudeStatus('Current session ███ 36% used\nResets 6:00pm\n\nCurrent week (all models) ██ 4% used\nResets Jun 3 at 4pm\n');
  assert.strictEqual(s.primary.used_percent, 36);
  assert.strictEqual(hm(s.primary.resets_at_ms), '18:00');
  assert.strictEqual(s.secondary.used_percent, 4);
  assert.strictEqual(s.windows.length, 2);
});

t('redraw da TUI: a última ocorrência de cada janela vence', () => {
  const s = parseClaudeStatus('Currentsession\n█ 3%used\nResets4:50pm\n\nCurrentsession\n██ 7%used\nResets4:50pm\n');
  assert.strictEqual(s.primary.used_percent, 7);
  assert.strictEqual(s.windows.length, 1);
});

t('janela semanal por modelo não vira "semana (todos)"', () => {
  const s = parseClaudeStatus('Current week (Sonnet only) ██ 9% used\nResets Sep 9 at 4pm\n');
  assert.strictEqual(s.secondary, null);
  assert.strictEqual(s.windows[0].id, 'weekly:Sonnet only');
  assert.strictEqual(s.usedPercent, 9);
});

t('sem janela reconhecida → null (nunca inventa 0%)', () => {
  assert.strictEqual(parseClaudeStatus('Settings  Status  Config  Usage\nTotal cost: $0.0000\n'), null);
});

t('deslogado continua detectado antes de qualquer número', () => {
  const s = parseClaudeStatus('Not logged in. Please run /login\nCurrent session 5% used');
  assert.strictEqual(s.loggedOut, true);
  assert.strictEqual(s.primary, null);
});

console.log(`\n${n} casos OK`);
