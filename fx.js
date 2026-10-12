'use strict';

// Cotação USD→BRL para mostrar o custo de API em reais (Estatísticas).
// Fonte: PTAX de venda do Banco Central (oficial, sem chave). Guarda a última
// cotação em disco e só consulta de novo após 12 h; sem rede, devolve a última
// conhecida com a data dela — nunca inventa câmbio.
const fs = require('fs');

const TTL_MS = 12 * 60 * 60 * 1000;
const URL_BASE = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/' +
  'CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)';

const mdy = d => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;

function ptaxUrl(now = new Date()) {
  // Janela de 10 dias cobre fim de semana + feriados emendados.
  const from = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  return `${URL_BASE}?@dataInicial='${mdy(from)}'&@dataFinalCotacao='${mdy(now)}'` +
    '&$format=json&$select=cotacaoVenda,dataHoraCotacao';
}

/** Última cotação válida da resposta OData, ou null. */
function parsePtax(json) {
  const list = Array.isArray(json && json.value) ? json.value : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const rate = Number(list[i].cotacaoVenda);
    const date = String(list[i].dataHoraCotacao || '').slice(0, 10);
    if (Number.isFinite(rate) && rate > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)) return { rate, date };
  }
  return null;
}

function createFx({ cachePath, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  let pending = null;
  const readCache = () => { try { return JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { return null; } };
  async function get() {
    const cached = readCache();
    if (cached && cached.rate && now() - cached.fetchedAt < TTL_MS) return { ...cached, source: 'PTAX/BCB' };
    if (pending) return pending;
    pending = (async () => {
      try {
        const res = await fetchImpl(ptaxUrl(new Date(now())), { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const got = parsePtax(await res.json());
        if (!got) throw new Error('sem cotação na janela');
        const fresh = { ...got, fetchedAt: now() };
        try { fs.writeFileSync(cachePath, JSON.stringify(fresh), { mode: 0o600 }); } catch {}
        return { ...fresh, source: 'PTAX/BCB' };
      } catch (err) {
        return cached && cached.rate ? { ...cached, source: 'PTAX/BCB', stale: true } : { error: String(err.message || err) };
      } finally { pending = null; }
    })();
    return pending;
  }
  return { get };
}

module.exports = { createFx, parsePtax, ptaxUrl, TTL_MS };
