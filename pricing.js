'use strict';

// Preço de API equivalente ao consumo local (2026-10-04). Responde "quanto
// eu pagaria se esse uso fosse pela API", não é fatura: assinaturas não cobram
// por token. Preços públicos em USD por 1M tokens, tier padrão, sem batch,
// sem desconto negociado e sem data residency (os logs mostram roteamento
// global: Claude `inference_geo` = not_available).
//
// Modelo sem preço público NUNCA recebe preço "parecido": fica sem custo e a
// UI mostra quantos tokens ficaram de fora. Foi o erro da estimativa antiga
// (preço padrão para modelo desconhecido), removida em 2026-09-10.
//
// Para atualizar: conferir as duas páginas de SOURCES, mudar as tabelas e
// VERIFIED_AT. test/pricing.test.js trava os casos que já foram conferidos.

const VERIFIED_AT = '2026-10-04';
const SOURCES = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
};

// Anthropic: escrita de cache 5 min = 1,25× a entrada, 1 h = 2×; leitura
// (`hit`) tem preço próprio (0,1× na maioria, 0,05× no Opus 5.5, 0,025× no
// Fable/Mythos 5.1). Desde a família 4.6 não há sobretaxa de contexto longo.
// `fast`: modo rápido (usage.speed = "fast"); os multiplicadores de cache
// incidem sobre o preço fast.
const ANTHROPIC = {
  'claude-fable-5-1':  { in: 10,   out: 50, hit: 0.25 },
  'claude-mythos-5-1': { in: 10,   out: 50, hit: 0.25 },
  'claude-fable-5':    { in: 10,   out: 50, hit: 1 },
  'claude-mythos-5':   { in: 10,   out: 50, hit: 1 },
  'claude-opus-5-5':   { in: 4,    out: 20, hit: 0.20, fast: { in: 8, out: 40 } },
  'claude-opus-5':     { in: 5,    out: 25, hit: 0.50, fast: { in: 10, out: 50 } },
  'claude-opus-4-8':   { in: 5,    out: 25, hit: 0.50, fast: { in: 10, out: 50 } },
  'claude-opus-4-7':   { in: 5,    out: 25, hit: 0.50 },
  'claude-opus-4-6':   { in: 5,    out: 25, hit: 0.50 },
  'claude-opus-4-5':   { in: 5,    out: 25, hit: 0.50 },
  'claude-opus-4-1':   { in: 15,   out: 75, hit: 1.50 },
  'claude-opus-4':     { in: 15,   out: 75, hit: 1.50 },
  'claude-sonnet-5-5': { in: 2,    out: 10, hit: 0.20 },
  'claude-sonnet-5':   { in: 2,    out: 10, hit: 0.20 },
  'claude-sonnet-4-6': { in: 3,    out: 15, hit: 0.30 },
  'claude-sonnet-4-5': { in: 3,    out: 15, hit: 0.30 },
  'claude-sonnet-4':   { in: 3,    out: 15, hit: 0.30 },
  'claude-haiku-4-5':  { in: 1,    out: 5,  hit: 0.10 },
  'claude-3-5-haiku':  { in: 0.80, out: 4,  hit: 0.08 },
};
const ANTHROPIC_ALIASES = { 'claude-opus-4-0': 'claude-opus-4', 'claude-sonnet-4-0': 'claude-sonnet-4' };

// OpenAI: [entrada, cache lido, cache gravado, saída]. `null` = a página não
// publica o item: cache gravado sem preço vira entrada comum, cache lido sem
// preço (modelos pro) não tem desconto. `long` vale para a requisição INTEIRA
// quando a entrada passa de 272K tokens. `fast` = service_tier "priority"
// (renomeado Fast mode em 30/07/2026).
const LONG_CONTEXT = 272000;
const OPENAI = {
  'gpt-6-astra':   { std: [10, 1, 12.5, 50],         long: [20, 2, 25, 75],
                     fast: [20, 2, 25, 100],         fastLong: [40, 4, 50, 150] },
  'gpt-6.1-sol':   { std: [2, 0.10, 2.5, 10],        long: [4, 0.20, 5, 15],
                     fast: [4, 0.20, 5, 20],         fastLong: [8, 0.40, 10, 30] },
  'gpt-6-sol':     { std: [2, 0.20, 2.5, 10],        long: [4, 0.40, 5, 15],
                     fast: [4, 0.40, 5, 20],         fastLong: [8, 0.80, 10, 30] },
  'gpt-6-luna':    { std: [0.10, 0.01, 0.125, 0.50], long: [0.20, 0.02, 0.25, 0.75],
                     fast: [0.20, 0.02, 0.25, 1],    fastLong: [0.40, 0.04, 0.50, 1.50] },
  'gpt-5.6-sol':   { std: [4, 0.40, 5, 20],          long: [8, 0.80, 10, 30],
                     fast: [8, 0.80, 10, 40],        fastLong: [16, 1.60, 20, 60] },
  'gpt-5.6-terra': { std: [2, 0.20, 2.5, 12],        long: [4, 0.40, 5, 18],
                     fast: [4, 0.40, 5, 24],         fastLong: [8, 0.80, 10, 36] },
  'gpt-5.6-luna':  { std: [0.20, 0.02, 0.25, 1.20],  long: [0.40, 0.04, 0.50, 1.80],
                     fast: [0.40, 0.04, 0.50, 2.40], fastLong: [0.80, 0.08, 1, 3.60] },
  'gpt-5.6-cyber': { std: [12.5, 1.25, 15.625, 75] },
  'gpt-5.5':       { std: [5, 0.50, null, 30],       long: [10, 1, null, 45],
                     fast: [12.5, 1.25, null, 75] },
  'gpt-5.5-pro':   { std: [30, null, null, 180],     long: [60, null, null, 270] },
  'gpt-5.5-cyber': { std: [12.5, 1.25, null, 75] },
  'gpt-5.4':       { std: [2.5, 0.25, null, 15],     long: [5, 0.50, null, 22.5],
                     fast: [5, 0.50, null, 30] },
  'gpt-5.4-pro':   { std: [30, null, null, 180],     long: [60, null, null, 270] },
  'gpt-5.4-mini':  { std: [0.75, 0.075, null, 4.5],  fast: [1.5, 0.15, null, 9] },
  'gpt-5.4-nano':  { std: [0.20, 0.02, null, 1.25] },
  'gpt-5.3-codex': { std: [1.75, 0.175, null, 14],   fast: [3.5, 0.35, null, 28] },
};

/** Nome do log → chave da tabela. `null` quando não há preço público. */
function priceKey(model) {
  if (!model || typeof model !== 'string') return null;
  // OpenCode grava "provider / modelo"; Claude pode trazer data e [1m].
  let m = model.split('/').pop().trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  if (m.startsWith('claude-')) {
    m = m.replace(/-\d{8}$/, '');
    m = ANTHROPIC_ALIASES[m] || m;
    return ANTHROPIC[m] ? m : null;
  }
  return OPENAI[m] ? m : null;
}

const M = 1e6;

/**
 * Custo de UMA resposta em USD, por componente. `null` se o modelo não tem
 * preço público ou se o registro não tem detalhamento (total histórico sem
 * separação entrada/cache/saída não pode ser precificado honestamente).
 */
function priceEvent(e) {
  const b = e && e._breakdown;
  const key = priceKey(e && e.model);
  if (!b || !key) return null;
  const fast = e.tier === 'fast';
  const read = b.cached_input_tokens, write = b.cache_write_input_tokens;
  const plain = b.input_tokens - read - write;
  // `saved`: quanto o cache lido poupou frente a pagar esses tokens como entrada.
  const out = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, webSearch: 0, total: 0, saved: 0, long: false, fast: false };
  if (key.startsWith('claude-')) {
    const p = ANTHROPIC[key];
    const base = fast && p.fast ? p.fast : p;
    const hit = p.hit / p.in * base.in;
    const w1h = Math.min(write, b.cache_write_1h_input_tokens || 0);
    out.input = plain * base.in / M;
    out.cacheRead = read * hit / M;
    out.saved = read * base.in / M - out.cacheRead;
    out.cacheWrite = ((write - w1h) * base.in * 1.25 + w1h * base.in * 2) / M;
    out.output = b.output_tokens * base.out / M;
    out.webSearch = (e.web_search_requests || 0) * 0.01;      // US$ 10 / 1.000 buscas
    out.fast = !!(fast && p.fast);
  } else {
    const p = OPENAI[key];
    const long = b.input_tokens > LONG_CONTEXT;
    // Fast sem tabela de contexto longo publicada: usa a fast de contexto curto.
    const rates = (fast && long && p.fastLong) || (fast && p.fast) || (long && p.long) || p.std;
    const [inp, cached, cw, o] = rates;
    out.input = plain * inp / M;
    out.cacheRead = read * (cached == null ? inp : cached) / M;
    out.saved = read * inp / M - out.cacheRead;
    out.cacheWrite = write * (cw == null ? inp : cw) / M;
    out.output = b.output_tokens * o / M;
    out.long = long && !!(fast && p.fast ? p.fastLong : p.long);
    out.fast = !!(fast && p.fast);
  }
  out.total = out.input + out.cacheRead + out.cacheWrite + out.output + out.webSearch;
  return out;
}

/** Tabela resumida para a UI (US$/1M tokens, tier padrão, contexto curto). */
function priceTable() {
  const rows = [];
  for (const [k, p] of Object.entries(ANTHROPIC)) {
    rows.push({ model: k, vendor: 'anthropic', input: p.in, cacheRead: p.hit, cacheWrite5m: p.in * 1.25, cacheWrite1h: p.in * 2, output: p.out });
  }
  for (const [k, p] of Object.entries(OPENAI)) {
    const [inp, cached, cw, o] = p.std;
    rows.push({ model: k, vendor: 'openai', input: inp, cacheRead: cached ?? inp, cacheWrite5m: cw ?? inp, cacheWrite1h: null, output: o });
  }
  return rows;
}

module.exports = { VERIFIED_AT, SOURCES, LONG_CONTEXT, priceKey, priceEvent, priceTable };
