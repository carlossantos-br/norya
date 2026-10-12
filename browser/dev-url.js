'use strict';

/**
 * browser/dev-url.js — extração de URLs de dev server do output de um PTY.
 *
 * Puro e sem dependências: dá para testar sem Electron (test/dev-url.test.js).
 * O estado (dedupe por PTY, debounce) fica em main.js; aqui só a extração.
 *
 * Só loopback. Uma URL externa que aparece no stdout é conteúdo — um link num
 * README, uma doc citada pelo agente — e abrir isso sozinho seria intrusivo.
 * Para URLs externas existe o caminho explícito: a CLI chamar `open <url>`,
 * interceptado por bin/open-shim/open.
 */

/**
 * `(?![\w.-])` ancora o fim do host. Sem isso, `localhost` casa DENTRO de
 * `localhostage.com`, e `127.0.0.1` dentro de `127.0.0.1.evil.com` — abriríamos
 * uma aba para um domínio externo que só se parece com loopback. Depois do host
 * só pode vir `:` (porta), `/` (caminho) ou fim; nunca letra, dígito, ponto ou hífen.
 */
const DEV_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?![\w.-])(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/gi;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Pontuação que a TUI cola no fim: "rodando em http://localhost:5173." */
const TRAILING_PUNCT = /[.,;:!?]+$/;

/**
 * @param {string} texto  chunk cru de stdout (pode conter ANSI)
 * @returns {Array<{url: string, origin: string}>}  na ordem em que aparecem,
 *          sem repetir a mesma origem dentro deste chunk.
 */
function findDevUrls(texto) {
  if (!texto) return [];
  const limpo = String(texto).replace(ANSI_RE, '');
  const brutas = limpo.match(DEV_URL_RE);
  if (!brutas) return [];

  const vistas = new Set();
  const saida = [];
  for (const bruta of brutas) {
    const url = bruta.replace(TRAILING_PUNCT, '');
    let origin;
    try { origin = new URL(url).origin; } catch { continue; }
    if (vistas.has(origin)) continue;   // o Vite reimprime a cada redraw
    vistas.add(origin);
    saida.push({ url, origin });
  }
  return saida;
}

module.exports = { findDevUrls, DEV_URL_RE };
