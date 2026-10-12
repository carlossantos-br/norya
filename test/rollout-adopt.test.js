#!/usr/bin/env node
/**
 * test/rollout-adopt.test.js — plano de adoção de uma task por outra conta.
 *
 * O caso de uso (Carlos, 2026-09-09): a conta que está rodando a task estourou
 * a quota ("You've hit your usage limit"). Ele quer CONTINUAR A MESMA conversa
 * em outra conta, não recomeçar.
 *
 * A parte que não é óbvia: `codex resume <id>` procura a sessão dentro do
 * `$CODEX_HOME` do perfil, e cada perfil do Norya tem o seu
 * (`accounts/N/.codex`). Então adotar uma task de Codex é um movimento de
 * ARQUIVO — copiar o rollout `.jsonl` para o `sessions/` do perfil destino e
 * mandar o codex ingerir. Verificado no 0.153.4: um rollout solto num CODEX_HOME
 * virgem sai como `"status": "eligible"` no `codex migrate-rollouts`, e o
 * `--apply` o materializa na `state_5.sqlite` daquele perfil.
 *
 * No Claude não há nada a mover: o `claude` roda com HOME real por causa do
 * Keychain, então TODO perfil enxerga `~/.claude/projects` — o resume atravessa
 * contas de graça.
 *
 * Uso: node test/rollout-adopt.test.js   → exit 0 = PASS, 1 = FAIL
 */
const assert = require('assert');
const { sessionsRelPath, findRollout, planAdoption, buildMetadataInsert } = require('../agents/rollout-adopt');

let passed = 0;
const t = (nome, fn) => {
  try { fn(); passed++; console.log(`  ok  ${nome}`); }
  catch (e) { console.error(`  FAIL ${nome}\n       ${e.message}`); process.exitCode = 1; }
};

const ROLL = '/Users/c/.norya/accounts/12/.codex/sessions/2026/05/27/rollout-2026-05-27T16-32-54-019e6b23-e45d-7021-ba22-16d3f0c0d76c.jsonl';

// ── sessionsRelPath ──────────────────────────────────────────────────────────
t('extrai o caminho relativo depois de /sessions/', () => {
  assert.strictEqual(sessionsRelPath(ROLL),
    '2026/05/27/rollout-2026-05-27T16-32-54-019e6b23-e45d-7021-ba22-16d3f0c0d76c.jsonl');
});

t('caminho sem /sessions/ → null (não inventa destino)', () => {
  assert.strictEqual(sessionsRelPath('/tmp/qualquer.jsonl'), null);
});

// ── findRollout ──────────────────────────────────────────────────────────────
t('acha o rollout pelo id no nome do arquivo', () => {
  const files = [
    { path: '/s/sessions/2026/05/25/rollout-2026-05-25T19-43-42-019e6185-daa4-7353-b332-5a4a21cd35a8.jsonl' },
    { path: ROLL },
  ];
  assert.strictEqual(findRollout(files, '019e6b23-e45d-7021-ba22-16d3f0c0d76c'), ROLL);
});

t('id inexistente → null', () => {
  assert.strictEqual(findRollout([{ path: ROLL }], 'nao-existe'), null);
});

t('id é comparado sem diferenciar caixa', () => {
  assert.strictEqual(findRollout([{ path: ROLL }], '019E6B23-E45D-7021-BA22-16D3F0C0D76C'), ROLL);
});

// ── planAdoption ─────────────────────────────────────────────────────────────
const codex = (extra) => Object.assign({
  provider: 'codex', fromAccount: 12, toAccount: 14, rolloutPath: ROLL,
}, extra);

t('Claude não move nada — HOME compartilhado', () => {
  const p = planAdoption({ provider: 'claude', fromAccount: null, toAccount: 14 });
  assert.strictEqual(p.action, 'none');
  assert.match(p.reason, /HOME/);
});

t('mesma conta origem e destino → nada a fazer', () => {
  assert.strictEqual(planAdoption(codex({ toAccount: 12 })).action, 'none');
});

t('Codex entre contas → copiar o rollout e migrar', () => {
  const p = planAdoption(codex());
  assert.strictEqual(p.action, 'copy-and-migrate');
  assert.strictEqual(p.relPath,
    '2026/05/27/rollout-2026-05-27T16-32-54-019e6b23-e45d-7021-ba22-16d3f0c0d76c.jsonl');
});

t('Codex sem rollout localizado → falha explicando, não silenciosa', () => {
  const p = planAdoption(codex({ rolloutPath: null }));
  assert.strictEqual(p.action, 'fail');
  assert.match(p.reason, /sess[ãa]o/i);
});

t('Codex com rollout fora de um sessions/ → falha', () => {
  const p = planAdoption(codex({ rolloutPath: '/tmp/solto.jsonl' }));
  assert.strictEqual(p.action, 'fail');
});

t('providers sem caminho de adoção falham nomeando o provider', () => {
  for (const provider of ['aider', 'grok', 'opencode']) {
    const p = planAdoption(codex({ provider }));
    assert.strictEqual(p.action, 'fail', provider);
    assert.ok(p.reason.includes(provider), `reason devia citar ${provider}: ${p.reason}`);
  }
});

t('conta destino ausente → falha (nunca adivinhar destino)', () => {
  assert.strictEqual(planAdoption(codex({ toAccount: null })).action, 'fail');
});

// ── buildMetadataInsert ──────────────────────────────────────────────────────
// Descoberto rodando o codex de verdade (test/smoke-adopt-thread.js): copiar só
// o rollout NÃO basta quando o perfil destino já tem um thread-store — o
// `migrate-rollouts` devolve failure_reason "missing_sqlite_metadata". A linha
// da thread na state_5.sqlite é a metadata que falta.
const LINHA = {
  id: 'abc', rollout_path: '/origem/sessions/2026/01/01/r.jsonl', title: 'T',
  cwd: '/dev/x', archived: 0, tokens_used: 12,
};
const COLS_DEST = ['id', 'rollout_path', 'title', 'cwd', 'archived', 'tokens_used'];

t('INSERT usa o rollout_path do DESTINO, não o da origem', () => {
  const { sql, values } = buildMetadataInsert(LINHA, COLS_DEST, '/destino/sessions/2026/01/01/r.jsonl');
  const i = sql.match(/\(([^)]*)\) VALUES/)[1].split(', ').indexOf('rollout_path');
  assert.strictEqual(values[i], '/destino/sessions/2026/01/01/r.jsonl');
});

t('colunas que o destino não tem são descartadas (schemas divergentes)', () => {
  const { sql } = buildMetadataInsert({ ...LINHA, coluna_nova: 'x' }, COLS_DEST, '/d/r.jsonl');
  assert.ok(!sql.includes('coluna_nova'), sql);
});

t('colunas que a origem não tem ficam no default do destino', () => {
  const { sql } = buildMetadataInsert(LINHA, COLS_DEST.concat('preview'), '/d/r.jsonl');
  assert.ok(!sql.includes('preview'), sql);
});

t('é INSERT OR REPLACE — adotar duas vezes não estoura a PK', () => {
  assert.match(buildMetadataInsert(LINHA, COLS_DEST, '/d/r.jsonl').sql, /^INSERT OR REPLACE INTO threads/);
});

t('sem a coluna id não dá para escrever nada', () => {
  assert.throws(() => buildMetadataInsert({ title: 'T' }, COLS_DEST, '/d/r.jsonl'), /id/);
});

t('um placeholder por valor', () => {
  const { sql, values } = buildMetadataInsert(LINHA, COLS_DEST, '/d/r.jsonl');
  assert.strictEqual(sql.split('?').length - 1, values.length);
  assert.strictEqual(values.length, COLS_DEST.length);
});

console.log(`\n${passed} passaram` + (process.exitCode ? ' — COM FALHAS' : ''));
