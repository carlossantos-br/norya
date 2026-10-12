'use strict';
// Câmbio das Estatísticas (fx.js): PTAX do BCB com cache de 12 h e fallback
// honesto para a última cotação conhecida.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createFx, parsePtax, ptaxUrl, TTL_MS } = require('../fx');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-fx-'));
const cachePath = path.join(tmp, 'fx.json');
const body = { value: [{ cotacaoVenda: 5.2132, dataHoraCotacao: '2026-09-28 13:03:11' }, { cotacaoVenda: 5.2238, dataHoraCotacao: '2026-10-02 13:03:16' }] };
const ok = json => async () => ({ ok: true, json: async () => json });

(async () => {
  assert.deepEqual(parsePtax(body), { rate: 5.2238, date: '2026-10-02' }, 'última cotação da janela');
  assert.equal(parsePtax({ value: [] }), null);
  assert.equal(parsePtax({ value: [{ cotacaoVenda: 'x', dataHoraCotacao: '2026-10-02' }] }), null);
  assert.match(ptaxUrl(new Date(2026, 9, 4)), /dataInicial='09-24-2026'.*dataFinalCotacao='10-04-2026'/);

  let t = 1_000_000, calls = 0;
  const fx = createFx({ cachePath, now: () => t, fetchImpl: async (...a) => { calls++; return ok(body)(...a); } });
  const a = await fx.get();
  assert.equal(a.rate, 5.2238); assert.equal(calls, 1);
  await fx.get(); assert.equal(calls, 1, 'dentro de 12 h usa o cache');
  t += TTL_MS + 1;
  const offline = createFx({ cachePath, now: () => t, fetchImpl: async () => { throw new Error('offline'); } });
  const b = await offline.get();
  assert.equal(b.rate, 5.2238); assert.equal(b.stale, true, 'sem rede devolve a última conhecida, marcada');
  fs.rmSync(cachePath);
  const none = await offline.get();
  assert.ok(none.error && !none.rate, 'sem cache e sem rede: erro, nunca câmbio inventado');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS fx.test.js');
})().catch(e => { console.error(e); process.exit(1); });
