#!/usr/bin/env node
/**
 * Unitário de quota/index.js (QuotaManager) — um snapshot por (perfil, provider).
 *
 * O que está em jogo:
 *   • chave composta "12:codex" + espelho legado "12" só do provider PADRÃO
 *     (todo leitor antigo — health, cartão de perfil, pickers — lê "12");
 *   • Claude: HTTP primeiro; TUI só quando o HTTP recusa o token;
 *   • circuit-breaker de deslogado por chave composta, não por perfil;
 *   • refreshProfile cobre todos os providers que o perfil mostra.
 *
 * Tudo com stubs — nada de rede, PTY ou disco.
 * Uso: node test/quota-manager.test.js
 */
const assert = require('assert');
const QuotaManager = require('../quota');

const fakeFs = { existsSync: () => false, mkdirSync() {}, readFileSync() { return '{}'; }, writeFileSync() {} };
const win = (id, pct) => ({ id, label: id, used_percent: pct, percent_left: 100 - pct, resets_at: null, resets_at_ms: null });
const okSnap = (provider, pct, extra = {}) => ({
  provider, cli: provider, source: provider === 'codex' ? 'app-server' : 'claude-http',
  primary: win('session', pct), secondary: null, windows: [win('session', pct)],
  usedPercent: pct, percentLeft: 100 - pct, window: '5h', resetsAt: null, used: null, total: null,
  updatedAt: Date.now(), ...extra,
});

const CTX = {
  12: { num: 12, dir: '/tmp/12', env: {}, authMode: 'chatgpt', quotaProviders: ['codex'], defaultProvider: 'codex' },
  14: { num: 14, dir: '/tmp/14', env: {}, authMode: 'claude', quotaProviders: ['claude'], defaultProvider: 'claude' },
  15: { num: 15, dir: '/tmp/15', env: {}, authMode: 'chatgpt', quotaProviders: ['codex', 'claude'], defaultProvider: 'codex' },
  7:  { num: 7,  dir: '/tmp/7',  env: {}, authMode: 'grok',    quotaProviders: ['grok'], defaultProvider: 'grok' },
  99: { num: 99, dir: '/tmp/99', env: {}, authMode: null,      quotaProviders: [], defaultProvider: null },
};

function make({ codex, claudeHttp, claudeTui, grok } = {}) {
  const calls = { codex: [], claudeHttp: [], claudeTui: [], grok: [] };
  const mgr = new QuotaManager({
    getAccountContext: (n) => CTX[n],
    cachePath: '/nonexistent/quota.json',
    childSpawn: () => { throw new Error('não deve spawnar'); },
    https: {},
    pty: { spawn() { throw new Error('não deve abrir PTY'); } },
    fs: fakeFs,
    parser: { parseClaudeStatus: () => null, parseCodexChunk: () => null, parseClaudeChunk: () => null },
    grokFetch: async (n) => { calls.grok.push(n); return grok ? grok(n) : { state: 'error', error: 'stub' }; },
  });
  mgr.codexFetcher = { fetch: async (n) => { calls.codex.push(n); return codex ? codex(n) : okSnap('codex', 10); } };
  mgr.claudeHttpFetcher = { fetch: async (n) => { calls.claudeHttp.push(n); return claudeHttp ? claudeHttp(n) : okSnap('claude', 20); } };
  mgr.claudeFetcher = { fetch: async (n) => { calls.claudeTui.push(n); return claudeTui ? claudeTui(n) : okSnap('claude', 33, { source: 'claude-status' }); } };
  const events = [];
  mgr.on('quota', e => events.push(e));
  return { mgr, calls, events };
}

let n = 0;
const t = async (nome, fn) => { await fn(); console.log(`PASS  ${nome}`); n++; };

(async () => {
  await t('refresh(12): grava "12:codex" E o espelho "12" (provider padrão)', async () => {
    const { mgr, events } = make();
    const s = await mgr.refresh(12);
    assert.strictEqual(s.usedPercent, 10);
    assert.strictEqual(mgr.get(12, 'codex').usedPercent, 10);
    assert.strictEqual(mgr.get(12).usedPercent, 10, 'espelho legado');
    assert.deepStrictEqual(events.map(e => e.key).sort(), ['12', '12:codex']);
    assert.strictEqual(events.find(e => e.key === '12:codex').provider, 'codex');
    assert.strictEqual(events.find(e => e.key === '12').num, 12);
  });

  await t('provider que não é o padrão NÃO toca o espelho legado', async () => {
    const { mgr } = make();
    await mgr.refresh(15);                          // codex (padrão)
    await mgr.refresh(15, { provider: 'claude' });  // claude (extra)
    assert.strictEqual(mgr.get(15, 'claude').usedPercent, 20);
    assert.strictEqual(mgr.get(15).provider, 'codex', 'o espelho seguiu sendo o codex');
    assert.strictEqual(mgr.get(15).usedPercent, 10);
  });

  await t('Claude: HTTP 200 → TUI não sobe', async () => {
    const { mgr, calls } = make();
    const s = await mgr.refresh(14);
    assert.strictEqual(s.source, 'claude-http');
    assert.deepStrictEqual(calls.claudeTui, []);
  });

  await t('Claude: HTTP recusou o token → TUI sobe UMA vez e o parse dela vale', async () => {
    const { mgr, calls } = make({ claudeHttp: async () => ({ provider: 'claude', cli: 'claude', source: 'claude-http', errorKind: 'auth', tokenRejected: true, updatedAt: Date.now() }) });
    const s = await mgr.refresh(14);
    assert.deepStrictEqual(calls.claudeTui, [14]);
    assert.strictEqual(s.source, 'claude-status');
    assert.strictEqual(s.usedPercent, 33);
    assert.strictEqual(mgr.get(14).errorKind, null, 'sucesso limpa a flag de auth do HTTP');
  });

  await t('Claude: HTTP diz deslogado → TUI não sobe; erro de rede → TUI não sobe', async () => {
    const a = make({ claudeHttp: async () => ({ provider: 'claude', source: 'claude-http', errorKind: 'auth', loggedOut: true, updatedAt: Date.now() }) });
    await a.mgr.refresh(14);
    assert.deepStrictEqual(a.calls.claudeTui, []);
    assert.strictEqual(a.mgr.get(14).loggedOut, true);
    const b = make({ claudeHttp: async () => ({ provider: 'claude', source: 'claude-http', errorKind: 'timeout', updatedAt: Date.now() }) });
    await b.mgr.refresh(14);
    assert.deepStrictEqual(b.calls.claudeTui, []);
  });

  await t('erro de rede preserva os números antigos (ficam "desatualizados")', async () => {
    let fail = false;
    const { mgr } = make({ claudeHttp: async () => fail
      ? { provider: 'claude', source: 'claude-http', errorKind: 'error', updatedAt: Date.now() }
      : okSnap('claude', 20) });
    await mgr.refresh(14);
    fail = true;
    await mgr.refresh(14, { force: true });
    const q = mgr.get(14, 'claude');
    assert.strictEqual(q.errorKind, 'error');
    assert.strictEqual(q.primary.used_percent, 20, 'barra antiga continua lá');
    assert.ok(q.readAt && q.readAt <= q.updatedAt, 'readAt = última leitura boa, não o erro');
  });

  await t('circuit-breaker é por chave composta', async () => {
    const { mgr, calls } = make({ codex: async () => ({ provider: 'codex', source: 'app-server', errorKind: 'auth', loggedOut: true, updatedAt: Date.now() }) });
    await mgr.refresh(15);                     // codex deslogado → breaker arma "15:codex"
    await mgr.refresh(15);                     // automático → pulado
    assert.strictEqual(calls.codex.length, 1);
    await mgr.refresh(15, { provider: 'claude' });   // outro provider do mesmo perfil → passa
    assert.strictEqual(calls.claudeHttp.length, 1);
    await mgr.refresh(15, { force: true });    // ação explícita → passa
    assert.strictEqual(calls.codex.length, 2);
  });

  await t('refreshProfile cobre todos os providers do perfil; refreshAll é por perfil', async () => {
    const { mgr, calls } = make();
    const r = await mgr.refreshProfile(15);
    assert.deepStrictEqual(Object.keys(r).sort(), ['claude', 'codex']);
    assert.deepStrictEqual(calls.codex, [15]);
    assert.deepStrictEqual(calls.claudeHttp, [15]);
    await mgr.refreshAll([{ num: 12 }, { num: 14 }]);
    assert.deepStrictEqual(calls.codex.sort(), [12, 15]);
    assert.deepStrictEqual(calls.claudeHttp.sort(), [14, 15]);
  });

  await t('perfil sem provider padrão nem credencial própria → null, sem fetch', async () => {
    const { mgr, calls } = make();
    assert.strictEqual(await mgr.refresh(99), null);
    assert.strictEqual(await mgr.refresh(12, { provider: 'aider' }), null);
    assert.strictEqual(calls.codex.length + calls.claudeHttp.length, 0);
  });

  await t('grok: sob demanda, snapshot com fonte grok-usage; deslogado vira flag', async () => {
    const { mgr } = make({ grok: async () => ({ state: 'ok', snapshot: { primary: null, secondary: win('weekly', 42), usedPercent: 42, percentLeft: 58, window: 'weekly', resetsAt: null, source: 'pty', cli: 'grok', updatedAt: Date.now() } }) });
    const s = await mgr.refresh(7);
    assert.strictEqual(s.source, 'grok-usage');
    assert.strictEqual(s.provider, 'grok');
    assert.strictEqual(mgr.get(7, 'grok').usedPercent, 42);
    assert.strictEqual(mgr.get(7).usedPercent, 42, 'grok é o padrão do 7 → espelho');
    const b = make({ grok: async () => ({ state: 'logged-out' }) });
    const s2 = await b.mgr.refresh(7);
    assert.strictEqual(s2.loggedOut, true);
    assert.strictEqual(s2.errorKind, 'auth');
  });

  await t('feedPty grava na chave composta da CLI e só espelha se for o padrão', async () => {
    const { mgr } = make();
    mgr._parser = { detectRateLimitHit: () => ({ hit: true, resetsAt: null, scope: '5h' }), parseClaudeChunk: () => null, parseCodexChunk: () => null };
    mgr.feedPty(15, 'claude', 'rate limit');
    assert.strictEqual(mgr.get(15, 'claude').usedPercent, 100);
    assert.strictEqual(mgr.get(15), null, 'claude não é o padrão do 15');
    mgr._lastParse = new Map();
    mgr.feedPty(15, 'codex', 'rate limit');
    assert.strictEqual(mgr.get(15).usedPercent, 100, 'codex é o padrão → espelha');
  });

  await t('force não duplica um fetch em voo (junta-se a ele)', async () => {
    let resolver; let vezes = 0;
    const { mgr } = make({ codex: () => { vezes++; return new Promise(r => { resolver = r; }); } });
    const p1 = mgr.refresh(12);
    const p2 = mgr.refresh(12, { force: true });
    resolver(okSnap('codex', 10));
    await Promise.all([p1, p2]);
    assert.strictEqual(vezes, 1);
  });

  await t('getAll devolve as duas famílias de chave', async () => {
    const { mgr } = make();
    await mgr.refresh(12);
    const all = mgr.getAll();
    assert.ok(all['12'] && all['12:codex']);
  });

  console.log(`\n${n} casos OK`);
})().catch(e => { console.error(e); process.exit(1); });
