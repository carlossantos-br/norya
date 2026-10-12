'use strict';

/**
 * ui-prefs.js — preferências de APARÊNCIA que o main e o renderer precisam ler
 * ANTES de qualquer tela existir.
 *
 * Por que não localStorage (que é onde mora o tema): o vidro é decidido em
 * `new BrowserWindow(...)`, no processo main, onde não existe localStorage. E
 * no renderer ele precisa valer já no <head>, antes do 1º paint — senão a
 * janela nasce opaca e "acende" translúcida no meio do boot. Os dois lados
 * leem ESTE arquivo, síncronamente, do mesmo `norya-state.json`.
 *
 * Módulo puro: só builtins do Node, zero Electron. É o que permite os testes
 * (e o <head> de test-window.html, que roda com nodeIntegration) usarem-no.
 *
 * ── 2026-10-03: o vidro voltou a nascer LIGADO ──────────────────────────────
 * O custo do vidro é por REPINTURA da janela. Com o ritmo de repintura dos
 * panes (renderer/views.js: só o pane em uso desenha ao vivo; os outros a 4
 * quadros/s, todos no mesmo instante), a bancada controlada (4 panes simulando
 * o Claude trabalhando, janela 1100×720, M2) deu, em % de um núcleo:
 *
 *     antes, opaco ............................ ~45%
 *     antes, vidro ............................ ~47%
 *     agora, vidro, usando o Norya ............ ~32%   (opaco: ~27%)
 *     agora, vidro, usando outro app .......... ~7%    (opaco: ~9%)
 *
 * Panes transparentes ou opacos sob o vidro: diferença dentro do ruído. O vidro
 * segue sendo uma chave em Ajustes → Aparência; só `false` explícito desliga.
 *
 * ── Histórico: por que o vidro nasceu DESLIGADO (2026-09-08) ────────────────
 * Medição controlada num MacBook Air M2 (Electron 41, janela 1100×720 Retina,
 * mesma cena animada dos dois lados):
 *
 *     janela opaca    → WindowServer 33,6%  + Electron 12,3%
 *     janela de vidro → WindowServer 41,7%  + Electron 16,4%
 *
 * ~25% a mais de CPU em TUDO que repinta, porque o compositor passa a blendar
 * a janela inteira contra o desktop a cada frame. E há um segundo custo, dentro
 * do app: com vidro o xterm precisa de `allowTransparency: true`, que o tira do
 * caminho rápido de renderização (ver noryaTermOptions, renderer/core.js).
 *
 * O vidro continua inteiro no código — é uma chave em Ajustes → Aparência.
 * Só deixou de ser cobrado de quem não pediu.
 */

const fs = require('fs');
const path = require('path');
const { NORYA_HOME } = require('./norya-home');

const STATE_PATH = path.join(NORYA_HOME, 'norya-state.json');

/** Default de fábrica. Um objeto novo a cada chamada: ninguém muta o padrão. */
function padroes() {
  return { glass: true, pet: true };
}

/**
 * Lê as preferências de aparência. NUNCA lança: estado ilegível, corrompido ou
 * inexistente cai no padrão — a janela abre opaca, que é o modo seguro.
 *
 * @param {string} [statePath] caminho alternativo (testes).
 */
function lerUiPrefs(statePath = STATE_PATH) {
  const out = padroes();
  let bruto;
  try { bruto = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return out; }
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return out;
  // Só `false` literal desliga. Qualquer outra coisa ("false", 0, null) é ruído
  // e fica no padrão.
  if (bruto.glass === false) out.glass = false;
  if (bruto.pet === false) out.pet = false;
  return out;
}

/**
 * Preferências do Mini/pet (2026-10-05), normalizadas: valor fora do domínio
 * cai no padrão (ruído no JSON nunca chega ao helper). `pet` segue a regra do
 * lerUiPrefs: só `false` literal desliga.
 *
 *   pet            Mini aberto (default true)
 *   petKind        auto | codex | clawd | none      (default auto)
 *   petSize        largura em pt, 80–224, inteiro   (default 112)
 *   petVisibility  always | onDemand                (default always)
 */
const PET_KINDS = ['auto', 'codex', 'clawd', 'none'];
const PET_SIZE = { min: 80, max: 224, def: 112 };
function lerPetPrefs(statePath = STATE_PATH) {
  const out = { pet: true, petKind: 'auto', petSize: PET_SIZE.def, petVisibility: 'always' };
  let b;
  try { b = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return out; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return out;
  return Object.assign(out, normalizarPetPrefs(b));
}
/** Só as chaves de pet presentes e válidas em `b` (parcial). */
function normalizarPetPrefs(b) {
  const o = {};
  if (b.pet === false) o.pet = false; else if (b.pet === true) o.pet = true;
  if (PET_KINDS.includes(b.petKind)) o.petKind = b.petKind;
  if (typeof b.petSize === 'number' && Number.isFinite(b.petSize)) {
    o.petSize = Math.min(PET_SIZE.max, Math.max(PET_SIZE.min, Math.round(b.petSize)));
  }
  if (b.petVisibility === 'always' || b.petVisibility === 'onDemand') o.petVisibility = b.petVisibility;
  return o;
}

/** O vidro está ligado? Atalho para o único consumidor de hoje. */
function glassLigado(statePath) {
  return lerUiPrefs(statePath).glass;
}

module.exports = { lerUiPrefs, glassLigado, padroes, lerPetPrefs, normalizarPetPrefs, STATE_PATH };
