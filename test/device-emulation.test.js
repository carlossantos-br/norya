#!/usr/bin/env node
/**
 * Unitário de browser/device-presets.js — presets de device e cálculo de escala
 * para o dock do navegador. Sem Electron. Uso: node test/device-emulation.test.js
 *
 * O que este módulo resolve: a largura FÍSICA do dock não é o viewport da página.
 * `enableDeviceEmulation({viewSize, scale})` renderiza 1440×900 dentro de 560px
 * reais — por isso Desktop e iPhone custam a mesma largura de tela.
 */
const assert = require('assert');
const D = require('../browser/device-presets');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };
const round = (x, casas = 4) => Number(x.toFixed(casas));

// ── Presets ────────────────────────────────────────────────────────────────
t('expõe os presets da spec, com o responsivo primeiro', () => {
  const ids = D.PRESETS.map(p => p.id);
  assert.strictEqual(ids[0], 'responsive');
  for (const id of ['iphone-15-pro', 'ipad', 'desktop-1280', 'desktop-1440', 'desktop-1920']) {
    assert.ok(ids.includes(id), `falta o preset ${id}`);
  }
});

t('o preset padrão do dock é Desktop 1440', () => {
  assert.strictEqual(D.DEFAULT_PRESET_ID, 'desktop-1440');
});

// ── Escala ─────────────────────────────────────────────────────────────────
t('encolhe o viewport para caber na largura útil do dock', () => {
  assert.strictEqual(round(D.computeScale(1440, 560)), round(560 / 1440));
});

t('nunca amplia: viewport menor que o dock fica em 1', () => {
  assert.strictEqual(D.computeScale(393, 560), 1);
});

t('largura útil inválida cai em escala 1 em vez de 0 ou NaN', () => {
  for (const ruim of [0, -10, null, undefined, NaN]) {
    assert.strictEqual(D.computeScale(1440, ruim), 1, `falhou para ${ruim}`);
  }
});

t('viewport inválido cai em escala 1', () => {
  assert.strictEqual(D.computeScale(0, 560), 1);
  assert.strictEqual(D.computeScale(undefined, 560), 1);
});

// ── Params de emulação ─────────────────────────────────────────────────────
t('responsivo devolve null — o chamador desliga a emulação', () => {
  assert.strictEqual(D.emulationParams('responsive', 560), null);
});

t('preset desconhecido devolve null em vez de explodir', () => {
  assert.strictEqual(D.emulationParams('nao-existe', 560), null);
});

t('Desktop 1440 monta viewSize 1440x900 com escala de encaixe', () => {
  const p = D.emulationParams('desktop-1440', 560);
  assert.deepStrictEqual(p.viewSize, { width: 1440, height: 900 });
  assert.deepStrictEqual(p.screenSize, { width: 1440, height: 900 });
  assert.strictEqual(p.screenPosition, 'desktop');
  assert.strictEqual(p.deviceScaleFactor, 0);
  assert.strictEqual(round(p.scale), round(560 / 1440));
});

t('iPhone usa screenPosition mobile e deviceScaleFactor 3', () => {
  const p = D.emulationParams('iphone-15-pro', 560);
  assert.deepStrictEqual(p.viewSize, { width: 393, height: 852 });
  assert.strictEqual(p.screenPosition, 'mobile');
  assert.strictEqual(p.deviceScaleFactor, 3);
  assert.strictEqual(p.scale, 1);   // cabe inteiro num dock de 560
});

t('viewPosition sempre na origem', () => {
  assert.deepStrictEqual(D.emulationParams('ipad', 560).viewPosition, { x: 0, y: 0 });
});

// ── Rotação ────────────────────────────────────────────────────────────────
t('rotacionar troca largura e altura do preset', () => {
  const p = D.emulationParams('iphone-15-pro', 900, { rotated: true });
  assert.deepStrictEqual(p.viewSize, { width: 852, height: 393 });
});

t('rotacionar recalcula a escala pela nova largura', () => {
  const p = D.emulationParams('iphone-15-pro', 560, { rotated: true });
  assert.strictEqual(round(p.scale), round(560 / 852));
});

t('rotacionar o responsivo continua sendo null', () => {
  assert.strictEqual(D.emulationParams('responsive', 560, { rotated: true }), null);
});

// ── Caminho do MCP (browser_set_viewport) ──────────────────────────────────
t('set_viewport sem width devolve null — volta ao responsivo', () => {
  assert.strictEqual(D.viewportParams({}, 560), null);
  assert.strictEqual(D.viewportParams(null, 560), null);
  assert.strictEqual(D.viewportParams({ height: 800 }, 560), null);
});

t('set_viewport com width monta params e escala igual ao preset', () => {
  const p = D.viewportParams({ width: 1440, height: 900 }, 560);
  assert.deepStrictEqual(p.viewSize, { width: 1440, height: 900 });
  assert.strictEqual(round(p.scale), round(560 / 1440));
});

t('set_viewport sem height usa uma altura padrão em vez de 0', () => {
  const p = D.viewportParams({ width: 375 }, 560);
  assert.strictEqual(p.viewSize.width, 375);
  assert.ok(p.viewSize.height > 0, 'altura precisa ser positiva');
});

t('set_viewport estreito é tratado como mobile', () => {
  assert.strictEqual(D.viewportParams({ width: 375 }, 560).screenPosition, 'mobile');
  assert.strictEqual(D.viewportParams({ width: 1280 }, 560).screenPosition, 'desktop');
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
