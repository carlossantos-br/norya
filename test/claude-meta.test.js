#!/usr/bin/env node
/**
 * Unitário de claude-meta.js (scanner de rollouts do Claude). Sem Electron.
 *
 * O bug que motivou o módulo: sessão iniciada por comando local tem como
 * primeira linha `user` só o bloco <local-command-caveat>…; o scanner antigo
 * congelava os primeiros 80 chars disso como firstMsg/título, o renderer
 * removia as tags e sobrava vazio → "Session · hh:mm" na sidebar. O prompt
 * real vem DEPOIS, muitas vezes com content em ARRAY (texto + imagem), que o
 * scanner antigo nem parseava.
 *
 * Uso: node test/claude-meta.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanClaudeRollout, cleanUserText } = require('../claude-meta');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-meta-test-'));
function rollout(rows) {
  const p = path.join(TMP, 'r' + (++rollout._i || (rollout._i = 1)) + '.jsonl');
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
const user = content => ({ type: 'user', message: { role: 'user', content }, isSidechain: false, cwd: '/x' });

// ── cleanUserText ────────────────────────────────────────────────────────────
t('cleanUserText: caveat-only vira vazio', () => {
  assert.strictEqual(cleanUserText('<local-command-caveat>Caveat: The messages below…</local-command-caveat>'), '');
});

t('cleanUserText: command-name/message/args viram vazio', () => {
  assert.strictEqual(cleanUserText('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'), '');
});

t('cleanUserText: stdout de comando local vira vazio', () => {
  assert.strictEqual(cleanUserText('<local-command-stdout>Set model to X</local-command-stdout>'), '');
});

t('cleanUserText: prefixo [Image #N] cai, texto fica', () => {
  assert.strictEqual(cleanUserText('[Image #1] arruma a sidebar'), 'arruma a sidebar');
});

t('cleanUserText: linha [Image: source: …] some', () => {
  assert.strictEqual(cleanUserText('[Image: source: /a/b/1.png]'), '');
});

t('cleanUserText: wrapper truncado (sem fechamento) não vaza texto de caveat', () => {
  // O scanner lê uma janela de bytes — a tag pode chegar cortada.
  assert.strictEqual(cleanUserText('<local-command-caveat>Caveat: The messages below were generated'), '');
});

t('cleanUserText: texto normal passa intacto', () => {
  assert.strictEqual(cleanUserText('  faz  o refactor\nda sidebar '), 'faz o refactor da sidebar');
});

// ── scanClaudeRollout ────────────────────────────────────────────────────────
t('caveat/comando são pulados; primeiro prompt REAL vira firstMsg', () => {
  const p = rollout([
    user('<local-command-caveat>Caveat: The messages below…</local-command-caveat>'),
    user('<command-name>/model</command-name>'),
    user('<local-command-stdout>Set model</local-command-stdout>'),
    user('preciso que veja como eh o codex com tarefas e projetos'),
  ]);
  const r = scanClaudeRollout(p, 64 * 1024);
  assert.strictEqual(r.firstMsg, 'preciso que veja como eh o codex com tarefas e projetos');
  assert.strictEqual(r.cwd, '/x');
});

t('content em ARRAY (imagem + texto) é parseado', () => {
  const p = rollout([
    user('<local-command-caveat>…</local-command-caveat>'),
    user([{ type: 'text', text: '[Image #1] replica o layout do codex' }, { type: 'image', source: {} }]),
  ]);
  const r = scanClaudeRollout(p, 64 * 1024);
  assert.strictEqual(r.firstMsg, 'replica o layout do codex');
});

t('ai-title tem precedência sobre firstMsg (campo aiTitle preservado)', () => {
  const p = rollout([
    user('primeiro prompt'),
    { type: 'ai-title', aiTitle: 'Revisar Codex e corrigir bugs no Norya' },
  ]);
  const r = scanClaudeRollout(p, 64 * 1024);
  assert.strictEqual(r.aiTitle, 'Revisar Codex e corrigir bugs no Norya');
  assert.strictEqual(r.firstMsg, 'primeiro prompt');
});

t('lastPrompt é capturado como fallback quando nenhum user row tem texto', () => {
  const p = rollout([
    { type: 'last-prompt', leafUuid: 'a' },                       // sem lastPrompt — ignora
    user('<local-command-caveat>…</local-command-caveat>'),
    { type: 'last-prompt', lastPrompt: '[Image #1] conserta a sidebar', leafUuid: 'b' },
  ]);
  const r = scanClaudeRollout(p, 64 * 1024);
  assert.strictEqual(r.firstMsg, '');
  assert.strictEqual(r.lastPrompt, 'conserta a sidebar');
});

t('tool_result em array NÃO vira título', () => {
  const p = rollout([
    user([{ type: 'tool_result', content: 'saída de tool' }]),
    user('prompt de verdade'),
  ]);
  const r = scanClaudeRollout(p, 64 * 1024);
  assert.strictEqual(r.firstMsg, 'prompt de verdade');
});

t('entrypoint sdk-* e sidechain continuam detectados (filtro de ocultação)', () => {
  const p1 = rollout([
    { type: 'attachment', entrypoint: 'sdk-py', isSidechain: false },
    user('You are summarizing…'),
  ]);
  assert.strictEqual(scanClaudeRollout(p1, 64 * 1024).entrypoint, 'sdk-py');
  const p2 = rollout([
    { type: 'attachment', entrypoint: 'cli', isSidechain: true },
    user('oi'),
  ]);
  assert.strictEqual(scanClaudeRollout(p2, 64 * 1024).isSidechain, true);
});

t('environment_context continua ignorado', () => {
  const p = rollout([
    user('<environment_context>stuff</environment_context>'),
    user('prompt real'),
  ]);
  const r = scanClaudeRollout(p, 64 * 1024);
  assert.strictEqual(r.firstMsg, 'prompt real');
});

t('firstMsg é capado em 80 chars DEPOIS da limpeza', () => {
  const longo = 'x'.repeat(200);
  const r = scanClaudeRollout(rollout([user('[Image #2] ' + longo)]), 64 * 1024);
  assert.strictEqual(r.firstMsg.length, 80);
  assert.ok(r.firstMsg.startsWith('xxx'));
});

console.log(`\n${n} testes OK`);
