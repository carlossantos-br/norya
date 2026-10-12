'use strict';

/**
 * quota/grok-parser.js — leitura do `/usage` do Grok Build.
 *
 * PURO. Sem electron, sem pty. Testado em test/grok-parser.test.js.
 *
 * ══ Honestidade sobre o que é verificado ══════════════════════════════════
 *
 * VERIFICADO contra o binário real (grok 0.2.93, 2026-07-10):
 *   • não existe subcomando `grok usage` — só o slash command interativo;
 *   • sem login, o CLI responde literalmente "You are not authenticated.".
 *
 * NÃO VERIFICADO: o formato exato da saída de `/usage` com uma conta SuperGrok
 * logada. Não temos como capturá-lo sem a assinatura. Por isso o parser é
 * TOLERANTE e, acima de tudo, HONESTO: quando nada casa, devolve `null` — o
 * chamador mostra "sem dado". Ele NUNCA inventa 0%.
 *
 * ══ O que a xAI publica sobre a assinatura ═══════════════════════════════
 *
 * Desde jun/2026 a SuperGrok é um POOL SEMANAL ÚNICO, compartilhado entre Chat,
 * Imagine, Voice e Build. Não existe janela de 5 h. Por isso o snapshot preenche
 * `secondary` (semanal) e deixa `primary` nulo — desenhar uma barra de 5 h para
 * o Grok seria desenhar algo que não existe.
 */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const limpar = t => String(t || '').replace(OSC, '').replace(ANSI, '');

/** Copiado do CONTRACT.md — mesma semântica de main.js parseRateLimitsResponse. */
function buildWindow(usedPercent, resetsAtSec) {
  const up = typeof usedPercent === 'number' ? usedPercent : 0;
  return {
    used_percent: up,
    percent_left: Math.max(0, 100 - up),
    resets_at: resetsAtSec || null,
    resets_at_ms: resetsAtSec ? resetsAtSec * 1000 : null,
  };
}

/**
 * O CLI diz isto textualmente quando não há sessão. Verificado com o binário.
 * @returns {boolean}
 */
function detectGrokLoggedOut(texto) {
  const t = limpar(texto);
  return /you are not authenticated|not authenticated|please (sign|log) ?in|run ['`]?grok login/i.test(t);
}

/**
 * Extrai percentual de uso e reset semanal da saída do `/usage`.
 *
 * Aceita várias formas plausíveis porque o formato não foi verificado:
 *   "Weekly usage: 42%"      "42% used"       "58% remaining"
 *   "Resets in 3d"           "Resets on 16 Jul"
 *
 * @returns {object|null} QuotaSnapshot parcial, ou null quando NADA casa.
 */
function parseGrokUsage(texto, agora = Date.now()) {
  const t = limpar(texto);
  if (!t.trim()) return null;

  let usado = null;

  // "42% used" / "usage: 42%" / "weekly: 42%"
  const usadoRe = /(?:usage|used|weekly|semanal)\D{0,20}?(\d{1,3})\s*%|(\d{1,3})\s*%\s*(?:used|usado)/i;
  const mUsado = t.match(usadoRe);
  if (mUsado) usado = Number(mUsado[1] ?? mUsado[2]);

  // "58% remaining" / "58% left"
  if (usado == null) {
    const mResta = t.match(/(\d{1,3})\s*%\s*(?:remaining|left|restante)/i);
    if (mResta) usado = 100 - Number(mResta[1]);
  }

  if (usado == null || !Number.isFinite(usado) || usado < 0 || usado > 100) return null;

  // Reset. Só relativo em dias/horas — datas por extenso variam com o locale e
  // adivinhar o ano é pior do que não mostrar reset nenhum.
  let resetSec = null;
  const mDias = t.match(/resets?\s+in\s+(\d{1,2})\s*d/i);
  const mHoras = t.match(/resets?\s+in\s+(\d{1,3})\s*h/i);
  if (mDias) resetSec = Math.floor((agora + Number(mDias[1]) * 86400e3) / 1000);
  else if (mHoras) resetSec = Math.floor((agora + Number(mHoras[1]) * 3600e3) / 1000);

  const semanal = buildWindow(usado, resetSec);
  return {
    // SuperGrok não tem janela de 5 h: pool semanal único desde jun/2026.
    primary: null,
    secondary: semanal,
    usedPercent: usado,
    percentLeft: semanal.percent_left,
    window: 'weekly',
    resetsAt: semanal.resets_at_ms,
    used: null,
    total: null,
    source: 'pty',
    cli: 'grok',
    updatedAt: agora,
  };
}

module.exports = { parseGrokUsage, detectGrokLoggedOut, buildWindow };
