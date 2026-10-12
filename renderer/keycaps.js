'use strict';

/**
 * renderer/keycaps.js — rótulos de tecla por plataforma.
 *
 * O app nasceu no Mac e mostra ⌘/⇧/⌥ em ~40 lugares. A LÓGICA de teclado já
 * era portátil (`e.metaKey || e.ctrlKey` em todos os handlers); só os RÓTULOS
 * mentiam: no Windows um menu dizendo "⌘K" é instrução para uma tecla que não
 * existe naquele teclado.
 *
 * Duas frentes, porque há duas origens de texto:
 *   1. Strings montadas em JS  → passam por `kc(...)` na hora de escrever.
 *   2. Markup estático do test-window.html → uma varredura ÚNICA no boot.
 *
 * Por que a varredura é única e não um MutationObserver: o conteúdo do terminal
 * também é DOM, e as CLIs (o próprio Claude Code, entre elas) imprimem ⌘ nas
 * suas dicas de atalho. Um observador global reescreveria a saída do agente —
 * corromper o que o usuário está lendo é pior do que um rótulo errado. A
 * varredura roda antes de existir qualquer terminal e ainda assim pula
 * `.xterm` e `<webview>` por precaução.
 *
 * Carregado ANTES de todos os outros scripts do renderer (`KC` e `kc` são
 * globais que eles usam na primeira renderização).
 */

const KC = (() => {
  const mac = (typeof process !== 'undefined' && process.platform === 'darwin');
  return mac
    ? { mac: true,  mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '⏎' }
    : { mac: false, mod: 'Ctrl+', shift: 'Shift+', alt: 'Alt+', ctrl: 'Ctrl+', enter: 'Enter' };
})();

/** Traduz os glifos de um texto pronto. No Mac é identidade. */
function kc(texto) {
  if (KC.mac || texto == null) return texto;
  return String(texto)
    .replace(/⌘/g, KC.mod)
    .replace(/⇧/g, KC.shift)
    .replace(/⌥/g, KC.alt)
    .replace(/⌃/g, KC.ctrl);
}

/**
 * Varre o markup estático uma vez. Só `title` e o texto dos elementos que NÓS
 * criamos como tecla (`.kbd`, `.ntb-kbd`) — nada de reescrever texto solto.
 */
function applyKeycapsToStaticDom(raiz) {
  if (KC.mac) return 0;
  const escopo = raiz || document;
  let trocas = 0;
  const dentroDeTerminal = el => !!(el.closest && el.closest('.xterm, webview, .term-host'));

  for (const el of escopo.querySelectorAll('[title]')) {
    if (dentroDeTerminal(el)) continue;
    const t = el.getAttribute('title');
    const novo = kc(t);
    if (novo !== t) { el.setAttribute('title', novo); trocas++; }
  }
  for (const el of escopo.querySelectorAll('.kbd, .ntb-kbd, [data-keycap]')) {
    if (dentroDeTerminal(el)) continue;
    const novo = kc(el.textContent);
    if (novo !== el.textContent) { el.textContent = novo; trocas++; }
  }
  return trocas;
}

if (typeof document !== 'undefined') {
  const rodar = () => { try { applyKeycapsToStaticDom(document); } catch (e) { console.warn('[keycaps]', e); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rodar, { once: true });
  else rodar();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KC, kc, applyKeycapsToStaticDom };
}
