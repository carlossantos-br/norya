#!/usr/bin/env node
/**
 * test/latch-filter.test.js — o latch de uma task nova só pode reivindicar
 * uma thread do MESMO provider.
 *
 * O bug (2026-09-09, print do Carlos): um pane rodando `codex` aparecia com o
 * título "(claude session)" e a linha da sidebar dizia "Claude". O filtro de
 * candidatos era `t.accountNum === accNum || t.accountNum == null`, e TODA
 * thread do Claude tem `accountNum: null` (o claude usa HOME real por causa do
 * Keychain — ver decisão 2026-06-14). O `|| null` existia para o latch do
 * Claude funcionar, mas ele abriu a porta para QUALQUER spawn: bastava uma
 * sessão de Claude Code aparecer em ~/.claude/projects no intervalo entre o
 * spawn e o poll do latch — inclusive uma aberta por OUTRO pane — e o spawn de
 * Codex latchava nela. O pane herdava título, provider e id da thread errada,
 * e a fila "Needs attention" passava a rotular pelo nome errado junto.
 *
 * Uso: node test/latch-filter.test.js   → exit 0 = PASS, 1 = FAIL
 */
const assert = require('assert');
const {
  providerOfAgent, providerOfThread, latchCandidates,
} = require('../renderer/latch-filter');

let passed = 0;
const t = (nome, fn) => {
  try { fn(); passed++; console.log(`  ok  ${nome}`); }
  catch (e) { console.error(`  FAIL ${nome}\n       ${e.message}`); process.exitCode = 1; }
};

// ── providerOfAgent ──────────────────────────────────────────────────────────
t('agentId é o próprio provider para as 5 CLIs', () => {
  assert.strictEqual(providerOfAgent('codex'), 'codex');
  assert.strictEqual(providerOfAgent('claude'), 'claude');
  assert.strictEqual(providerOfAgent('aider'), 'aider');
  assert.strictEqual(providerOfAgent('grok'), 'grok');
  assert.strictEqual(providerOfAgent('opencode'), 'opencode');
});

t('agentId ausente/desconhecido → null (chamador decide)', () => {
  assert.strictEqual(providerOfAgent(null), null);
  assert.strictEqual(providerOfAgent(''), null);
  assert.strictEqual(providerOfAgent('gpt-6'), null);
});

// ── providerOfThread ─────────────────────────────────────────────────────────
t('thread com provider explícito manda', () => {
  assert.strictEqual(providerOfThread({ provider: 'claude', accountNum: null }), 'claude');
  assert.strictEqual(providerOfThread({ provider: 'aider', accountNum: 3 }), 'aider');
});

t('thread sem provider e sem conta cai em codex (legado do DB)', () => {
  assert.strictEqual(providerOfThread({ accountNum: 7 }), 'codex');
});

// ── latchCandidates: o bug ───────────────────────────────────────────────────
const base = () => ({
  beforeIds: new Set(['velha-1']),
  claimedIds: new Set(),
  accNum: 12,
  cwd: '/Users/x/dev/app',
});

t('REGRESSÃO: spawn de Codex NÃO latcha numa thread do Claude', () => {
  const threads = [
    { id: 'claude-nova', provider: 'claude', accountNum: null, updated_at_ms: 2000, cwd: '/Users/x/dev/app' },
  ];
  const out = latchCandidates({ ...base(), threads, provider: 'codex' });
  assert.deepStrictEqual(out.map(x => x.id), [],
    'a sessão de Claude entrou como candidata de um spawn de Codex');
});

t('CONTROLE POSITIVO: sem filtro de provider o bug ainda reproduz', () => {
  const threads = [
    { id: 'claude-nova', provider: 'claude', accountNum: null, updated_at_ms: 2000, cwd: '/Users/x/dev/app' },
  ];
  // provider undefined = comportamento antigo. Se este teste passar a falhar,
  // o filtro virou incondicional e o teste acima virou tautologia.
  const out = latchCandidates({ ...base(), threads, provider: null });
  assert.deepStrictEqual(out.map(x => x.id), ['claude-nova']);
});

t('spawn de Claude segue latchando thread de accountNum null', () => {
  const threads = [
    { id: 'claude-nova', provider: 'claude', accountNum: null, updated_at_ms: 2000, cwd: '/Users/x/dev/app' },
  ];
  const out = latchCandidates({ ...base(), threads, provider: 'claude' });
  assert.deepStrictEqual(out.map(x => x.id), ['claude-nova']);
});

t('spawn de Codex latcha a thread de Codex da própria conta', () => {
  const threads = [
    { id: 'claude-nova', provider: 'claude', accountNum: null, updated_at_ms: 3000, cwd: '/Users/x/dev/app' },
    { id: 'codex-nova', provider: 'codex', accountNum: 12, updated_at_ms: 2000, cwd: '/Users/x/dev/app' },
  ];
  const out = latchCandidates({ ...base(), threads, provider: 'codex' });
  assert.deepStrictEqual(out.map(x => x.id), ['codex-nova'],
    'a Claude era mais recente e teria ganhado a ordenação');
});

t('grok/opencode não têm thread listável → nenhum candidato (fica provisória)', () => {
  const threads = [
    { id: 'codex-nova', provider: 'codex', accountNum: 12, updated_at_ms: 2000, cwd: null },
  ];
  assert.deepStrictEqual(latchCandidates({ ...base(), threads, provider: 'grok' }).map(x => x.id), []);
});

// ── latchCandidates: comportamento preservado ────────────────────────────────
t('threads que já existiam antes do spawn ficam de fora', () => {
  const threads = [{ id: 'velha-1', provider: 'codex', accountNum: 12, updated_at_ms: 9000 }];
  assert.deepStrictEqual(latchCandidates({ ...base(), threads, provider: 'codex' }).map(x => x.id), []);
});

t('thread já reivindicada por outro spawn fica de fora (dupla de 2026-08-04)', () => {
  const threads = [{ id: 'codex-nova', provider: 'codex', accountNum: 12, updated_at_ms: 9000 }];
  const o = { ...base(), claimedIds: new Set(['codex-nova']) };
  assert.deepStrictEqual(latchCandidates({ ...o, threads, provider: 'codex' }).map(x => x.id), []);
});

t('thread de OUTRA conta fica de fora', () => {
  const threads = [{ id: 'codex-outra', provider: 'codex', accountNum: 6, updated_at_ms: 9000 }];
  assert.deepStrictEqual(latchCandidates({ ...base(), threads, provider: 'codex' }).map(x => x.id), []);
});

t('cwd igual ao do spawn tem preferência sobre o mais recente', () => {
  const threads = [
    { id: 'outra-pasta', provider: 'codex', accountNum: 12, updated_at_ms: 9000, cwd: '/tmp' },
    { id: 'minha-pasta', provider: 'codex', accountNum: 12, updated_at_ms: 1000, cwd: '/Users/x/dev/app' },
  ];
  assert.deepStrictEqual(latchCandidates({ ...base(), threads, provider: 'codex' }).map(x => x.id), ['minha-pasta']);
});

t('sem casar cwd, cai no pool geral ordenado por recência', () => {
  const threads = [
    { id: 'a', provider: 'codex', accountNum: 12, updated_at_ms: 1000, cwd: '/tmp' },
    { id: 'b', provider: 'codex', accountNum: 12, updated_at_ms: 5000, cwd: '/var' },
  ];
  assert.deepStrictEqual(latchCandidates({ ...base(), threads, provider: 'codex' }).map(x => x.id), ['b', 'a']);
});

console.log(`\n${passed} passaram` + (process.exitCode ? ' — COM FALHAS' : ''));
