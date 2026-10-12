'use strict';
// Preço de API equivalente (pricing.js). Valores conferidos nas páginas
// oficiais em 2026-10-04; se um destes quebrar, a tabela mudou — confira a
// fonte antes de ajustar o número esperado.
const assert = require('assert/strict');
const { priceKey, priceEvent, LONG_CONTEXT } = require('../pricing');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);
const ev = (model, b, extra = {}) => ({ model, provider: model.startsWith('claude') ? 'claude' : 'codex', _breakdown: {
  input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0,
  total_tokens: 0, ...b }, ...extra });

test('nomes: data, [1m], prefixo do OpenCode e alias; desconhecido fica sem preço', () => {
  assert.equal(priceKey('claude-opus-4-1-20250805'), 'claude-opus-4-1');
  assert.equal(priceKey('claude-sonnet-4-20250514'), 'claude-sonnet-4');
  assert.equal(priceKey('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(priceKey('anthropic / claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(priceKey('openai / gpt-5.4'), 'gpt-5.4');
  assert.equal(priceKey('claude-opus-4-0'), 'claude-opus-4');
  for (const m of ['codex-auto-review', 'gpt-daybreak-blue-latest', 'Modelo não informado', null, 'grok-4.5']) {
    assert.equal(priceKey(m), null, String(m));
  }
  assert.equal(priceEvent(ev('codex-auto-review', { input_tokens: 1e6 })), null);
  assert.equal(priceEvent({ model: 'gpt-5.4', _breakdown: null, tokens_used: 5 }), null, 'total sem detalhamento não tem preço');
});

test('Claude Opus 5: entrada, cache lido 0,1×, gravação 5 min 1,25× e 1 h 2×, saída', () => {
  // 1M de cada tipo; 0,4M da gravação é de 1 h.
  const c = priceEvent(ev('claude-opus-5', { input_tokens: 3e6, cached_input_tokens: 1e6, cache_write_input_tokens: 1e6,
    cache_write_1h_input_tokens: 0.4e6, output_tokens: 1e6 }));
  near(c.input, 5, 'entrada'); near(c.cacheRead, 0.5, 'cache lido');
  near(c.cacheWrite, 0.6 * 6.25 + 0.4 * 10, 'gravação'); near(c.output, 25, 'saída');
  near(c.total, 5 + 0.5 + 7.75 + 25, 'total');
  near(c.saved, 5 - 0.5, 'cache poupou 1M × (5 − 0,5)');
});

test('Claude: hit próprio do Opus 5.5 (0,05×) e Fable 5.1 (0,025×); fast multiplica a base', () => {
  near(priceEvent(ev('claude-opus-5-5', { input_tokens: 1e6, cached_input_tokens: 1e6 })).cacheRead, 0.20, 'opus 5.5');
  near(priceEvent(ev('claude-fable-5-1', { input_tokens: 1e6, cached_input_tokens: 1e6 })).cacheRead, 0.25, 'fable 5.1');
  const f = priceEvent(ev('claude-opus-5', { input_tokens: 2e6, cached_input_tokens: 1e6, output_tokens: 1e6 }, { tier: 'fast' }));
  near(f.input, 10, 'fast entrada'); near(f.cacheRead, 1, 'fast hit = 0,1× do fast'); near(f.output, 50, 'fast saída');
  assert.equal(f.fast, true);
  // Opus 4.7 não tem fast: preço padrão mesmo marcado.
  const g = priceEvent(ev('claude-opus-4-7', { input_tokens: 1e6 }, { tier: 'fast' }));
  near(g.input, 5, 'sem fast'); assert.equal(g.fast, false);
});

test('Claude: busca web US$ 10 por 1.000', () => {
  near(priceEvent(ev('claude-sonnet-5', {}, { web_search_requests: 3 })).webSearch, 0.03, 'busca');
});

test('OpenAI: cache lido, contexto longo na requisição inteira e fast', () => {
  const s = priceEvent(ev('gpt-6-astra', { input_tokens: 200000, cached_input_tokens: 100000, output_tokens: 10000 }));
  near(s.total, (100000 * 10 + 100000 * 1 + 10000 * 50) / 1e6, 'astra curto'); assert.equal(s.long, false);
  const l = priceEvent(ev('gpt-6-astra', { input_tokens: LONG_CONTEXT + 1, output_tokens: 1000 }));
  near(l.input, (LONG_CONTEXT + 1) * 20 / 1e6, 'astra longo: entrada toda a 20'); near(l.output, 1000 * 75 / 1e6, 'saída longa');
  assert.equal(l.long, true);
  const f = priceEvent(ev('gpt-5.4', { input_tokens: 2e5, cached_input_tokens: 2e5, output_tokens: 1e6 }, { tier: 'fast' }));
  near(f.cacheRead, 0.1, 'fast cache'); near(f.output, 30, 'fast saída'); assert.equal(f.fast, true);
  // Sem preço de gravação publicado: gravação vira entrada comum. Pro: sem desconto de cache.
  near(priceEvent(ev('gpt-5.5', { input_tokens: 2e5, cache_write_input_tokens: 2e5 })).cacheWrite, 1, 'gravação = entrada');
  near(priceEvent(ev('gpt-5.5-pro', { input_tokens: 2e5, cached_input_tokens: 2e5 })).cacheRead, 6, 'pro sem desconto');
  // Raciocínio já está dentro da saída: não é cobrado de novo.
  near(priceEvent(ev('gpt-5.6-terra', { input_tokens: 0, output_tokens: 1e6, reasoning_output_tokens: 6e5 })).total, 12, 'raciocínio');
});

(async () => {
  for (const [name, fn] of tests) { await fn(); console.log('PASS', name); }
  console.log(`${tests.length} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
