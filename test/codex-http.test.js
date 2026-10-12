#!/usr/bin/env node
/**
 * Unitário de quota/codex-http.js — além de 5h/semana, o app-server devolve
 * plano, créditos, resets grátis e (via account/read) o e-mail da conta.
 * Fixture sintética com a MESMA forma da resposta real do codex-cli 0.153.2.
 *
 * Uso: node test/codex-http.test.js
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const CodexQuotaFetcher = require('../quota/codex-http');

const RATE = {
  rateLimits: {
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1788902075 },
    secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1789488875 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'plus', rateLimitReachedType: null,
  },
  rateLimitResetCredits: { availableCount: 3, credits: [] },
};
const ACCOUNT = { account: { type: 'chatgpt', email: 'conta@example.com', planType: 'plus' }, requiresOpenaiAuth: true };

// app-server falso: responde às requisições JSON-RPC escritas no stdin.
function fakeSpawn({ account = ACCOUNT, accountError = false, accountSilent = false } = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    proc.stdin = {
      writable: true,
      on() {},
      write(s) {
        const msg = JSON.parse(s);
        const reply = o => setImmediate(() => proc.stdout.emit('data', JSON.stringify(o) + '\n'));
        if (msg.id === 1) reply({ id: 1, result: {} });
        if (msg.id === 2) reply({ id: 2, result: RATE });
        if (msg.id === 3) {
          if (accountSilent) return;
          reply(accountError ? { id: 3, error: { code: -1, message: 'nope' } } : { id: 3, result: account });
        }
      },
    };
    return proc;
  };
}
const ctx = { num: 12, dir: '/tmp', env: {}, authMode: 'chatgpt', shell: '/bin/zsh', nvmScript: '/x', prelude: 'true' };

let n = 0;
const t = async (nome, fn) => { await fn(); console.log(`PASS  ${nome}`); n++; };

(async () => {
  await t('janelas 5h/semana + plano, créditos, resets grátis e e-mail', async () => {
    const f = new CodexQuotaFetcher({ getAccountContext: (num, provider) => { assert.equal(provider, 'codex'); return ctx; }, childSpawn: fakeSpawn(), https: {} });
    const s = await f.fetch(12);
    assert.strictEqual(s.source, 'app-server');
    assert.strictEqual(s.provider, 'codex');
    assert.strictEqual(s.primary.used_percent, 12);
    assert.strictEqual(s.primary.resets_at_ms, 1788902075000);
    assert.strictEqual(s.secondary.used_percent, 3);
    assert.deepStrictEqual(s.windows.map(w => w.id), ['session', 'weekly']);
    assert.deepStrictEqual(s.windows.map(w => w.label), ['Janela de 5h', 'Semanal']);
    assert.strictEqual(s.plan, 'plus');
    assert.strictEqual(s.planLabel, 'Plus');
    assert.strictEqual(s.identity, 'conta@example.com');
    assert.strictEqual(s.resetCredits, 3);
    assert.deepStrictEqual(s.credits, { hasCredits: false, unlimited: false, balance: '0' });
    assert.strictEqual(s.usedPercent, 12);
  });

  await t('account/read com erro não bloqueia o snapshot (fica sem e-mail)', async () => {
    const f = new CodexQuotaFetcher({ getAccountContext: () => ctx, childSpawn: fakeSpawn({ accountError: true }), https: {} });
    const s = await f.fetch(12);
    assert.strictEqual(s.primary.used_percent, 12);
    assert.strictEqual(s.identity, null);
  });

  await t('account/read mudo: tolerância curta, snapshot sai mesmo assim', async () => {
    const f = new CodexQuotaFetcher({ getAccountContext: () => ctx, childSpawn: fakeSpawn({ accountSilent: true }), https: {} });
    const t0 = Date.now();
    const s = await f.fetch(12);
    assert.strictEqual(s.primary.used_percent, 12);
    assert.strictEqual(s.identity, null);
    assert.ok(Date.now() - t0 < 3000, 'esperou demais pelo account/read');
  });

  console.log(`\n${n} casos OK`);
})().catch(e => { console.error(e); process.exit(1); });
