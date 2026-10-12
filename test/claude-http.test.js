#!/usr/bin/env node
/**
 * Unitário de quota/claude-http.js — uso da assinatura Claude pelo endpoint
 * que o próprio `/usage` do Claude Code consulta (GET /api/oauth/usage).
 *
 * Fixture: resposta REAL capturada em 2026-09-08 (conta Max 5x), sem token.
 * O token NUNCA pode aparecer em log — há um caso só para isso.
 *
 * Uso: node test/claude-http.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ClaudeUsageHttpFetcher, parseOauthUsage, planLabelFrom } = require('../quota/claude-http');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-oauth-usage.json'), 'utf8'));
const META = { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x', expiresAt: Date.now() + 3600e3 };
const CRED = { token: 'sk-ant-oat01-SEGREDO-DE-TESTE', kind: 'keychain', identity: 'conta do Mac', meta: META };

let n = 0;
const t = (nome, fn) => { const r = fn(); if (r && r.then) return r.then(() => { console.log(`PASS  ${nome}`); n++; }); console.log(`PASS  ${nome}`); n++; };

// ── parse puro ───────────────────────────────────────────────────────────────
t('fixture real: 3 janelas a partir de limits[], na ordem da API', () => {
  const s = parseOauthUsage(fixture, CRED);
  assert.deepStrictEqual(s.windows.map(w => w.id), ['session', 'weekly', 'weekly:Fable']);
  assert.deepStrictEqual(s.windows.map(w => w.used_percent), [5, 17, 24]);
  assert.strictEqual(s.windows[2].label, 'Semana · Fable');
  assert.strictEqual(s.windows[0].resets_at_ms, Date.parse('2026-09-08T20:49:59.797341+00:00'));
  assert.strictEqual(s.windows[0].resets_at, Math.floor(s.windows[0].resets_at_ms / 1000));
  assert.strictEqual(s.windows[1].severity, 'normal');
  assert.strictEqual(s.primary.used_percent, 5);
  assert.strictEqual(s.secondary.used_percent, 17);
  assert.strictEqual(s.usedPercent, 24);
  assert.strictEqual(s.percentLeft, 76);
  assert.strictEqual(s.provider, 'claude');
  assert.strictEqual(s.cli, 'claude');
  assert.strictEqual(s.source, 'claude-http');
});

t('plano e identidade vêm da credencial, não da resposta', () => {
  const s = parseOauthUsage(fixture, CRED);
  assert.strictEqual(s.plan, 'max');
  assert.strictEqual(s.planLabel, 'Max 5x');
  assert.strictEqual(s.identity, 'conta do Mac');
  assert.strictEqual(s.extraUsage.enabled, false);
  assert.ok(!('token' in s), 'snapshot não pode carregar o token');
});

t('planLabelFrom: tier manda; sem tier cai no tipo da assinatura', () => {
  assert.strictEqual(planLabelFrom({ rateLimitTier: 'default_claude_max_20x', subscriptionType: 'max' }), 'Max 20x');
  assert.strictEqual(planLabelFrom({ subscriptionType: 'max' }), 'Max');
  assert.strictEqual(planLabelFrom({ subscriptionType: 'pro' }), 'Pro');
  assert.strictEqual(planLabelFrom({ subscriptionType: 'team' }), 'Team');
  assert.strictEqual(planLabelFrom(null), null);
});

t('sem limits[]: cai em five_hour / seven_day / seven_day_<modelo>', () => {
  const iso = '2026-09-09T19:59:59+00:00';
  const s = parseOauthUsage({
    five_hour: { utilization: 40.0, resets_at: iso },
    seven_day: { utilization: 10.0, resets_at: iso },
    seven_day_opus: { utilization: 55.0, resets_at: iso },
    seven_day_sonnet: null,
  }, CRED);
  assert.deepStrictEqual(s.windows.map(w => w.id), ['session', 'weekly', 'weekly:Opus']);
  assert.strictEqual(s.windows[2].used_percent, 55);
  assert.strictEqual(s.secondary.resets_at_ms, Date.parse(iso));
});

t('extra usage ligado vira janela "extra" com valores em dinheiro', () => {
  const s = parseOauthUsage({
    ...fixture,
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25.0, currency: 'USD', decimal_places: 2, user_disabled: false },
  }, CRED);
  const extra = s.windows.find(w => w.id === 'extra');
  assert.ok(extra, 'janela extra ausente');
  assert.strictEqual(extra.used_percent, 25);
  assert.deepStrictEqual(s.extraUsage, { enabled: true, utilization: 25, used: 1250, limit: 5000, currency: 'USD', decimals: 2 });
});

t('resposta sem nenhuma janela → null (nunca inventa 0%)', () => {
  assert.strictEqual(parseOauthUsage({ limits: [], five_hour: null, seven_day: null }, CRED), null);
  assert.strictEqual(parseOauthUsage(null, CRED), null);
});

// ── fetcher com https falso ─────────────────────────────────────────────────
function fakeHttps({ status = 200, body = JSON.stringify(fixture), fail = null, hang = false } = {}) {
  const calls = [];
  return {
    calls,
    request(opts, cb) {
      calls.push(opts);
      const req = new EventEmitter();
      req.end = () => {
        if (hang) return;
        if (fail) { setImmediate(() => req.emit(fail, new Error('ECONNRESET'))); return; }
        const res = new EventEmitter();
        res.statusCode = status;
        res.setEncoding = () => {};
        res.resume = () => {};
        setImmediate(() => { cb(res); res.emit('data', body); res.emit('end'); });
      };
      req.destroy = () => {};
      req.setTimeout = (_ms, fn) => { req._onTimeout = fn; };
      return req;
    },
  };
}

t('200 → snapshot autoritativo; log nunca contém o token', async () => {
  const logs = [];
  const https = fakeHttps();
  const f = new ClaudeUsageHttpFetcher({ getClaudeCredential: () => CRED, https, logFn: m => logs.push(m) });
  const s = await f.fetch(14);
  assert.strictEqual(s.source, 'claude-http');
  assert.strictEqual(s.windows.length, 3);
  assert.ok(typeof s.updatedAt === 'number');
  assert.ok(!logs.join('\n').includes('SEGREDO'), 'token vazou no log');
  const opts = https.calls[0];
  assert.strictEqual(opts.hostname, 'api.anthropic.com');
  assert.strictEqual(opts.path, '/api/oauth/usage');
  assert.strictEqual(opts.headers.Authorization, 'Bearer ' + CRED.token);
  assert.ok(opts.headers['anthropic-beta'], 'header anthropic-beta obrigatório');
});

t('401 → token recusado (auth), sem marcar deslogado: o CLI renova sozinho', async () => {
  const f = new ClaudeUsageHttpFetcher({ getClaudeCredential: () => CRED, https: fakeHttps({ status: 401, body: '{}' }) });
  const s = await f.fetch(14);
  assert.strictEqual(s.errorKind, 'auth');
  assert.strictEqual(s.tokenRejected, true);
  assert.notStrictEqual(s.loggedOut, true);
});

t('sem credencial → deslogado', async () => {
  const f = new ClaudeUsageHttpFetcher({ getClaudeCredential: () => null, https: fakeHttps() });
  const s = await f.fetch(14);
  assert.strictEqual(s.loggedOut, true);
  assert.strictEqual(s.errorKind, 'auth');
});

t('erro de rede → error; timeout → timeout (números antigos ficam com o store)', async () => {
  const f1 = new ClaudeUsageHttpFetcher({ getClaudeCredential: () => CRED, https: fakeHttps({ fail: 'error' }) });
  assert.strictEqual((await f1.fetch(14)).errorKind, 'error');
  const f2 = new ClaudeUsageHttpFetcher({ getClaudeCredential: () => CRED, https: fakeHttps({ hang: true }) });
  assert.strictEqual((await f2.fetch(14, { timeoutMs: 30 })).errorKind, 'timeout');
});

t('5xx / corpo inválido → error, não auth', async () => {
  const f = new ClaudeUsageHttpFetcher({ getClaudeCredential: () => CRED, https: fakeHttps({ status: 503, body: 'nope' }) });
  assert.strictEqual((await f.fetch(14)).errorKind, 'error');
});

setTimeout(() => console.log(`\n${n} casos OK`), 200);
