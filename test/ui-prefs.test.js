#!/usr/bin/env node
/**
 * Unitário de ui-prefs.js. Sem Electron.
 *
 * O que este teste protege: o vidro nasce LIGADO (desde 2026-10-03, quando o
 * ritmo de repintura dos panes o deixou tão barato quanto a janela opaca) e só
 * `false` literal o desliga — um estado meio-gravado (JSON truncado, "false"
 * em string) não pode desligar a escolha do usuário por acidente.
 *
 * Uso: node test/ui-prefs.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lerUiPrefs, glassLigado, padroes, lerPetPrefs, normalizarPetPrefs } = require('../ui-prefs');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-uiprefs-'));
const arq = (conteudo) => {
  const p = path.join(tmp, `s${n}.json`);
  fs.writeFileSync(p, conteudo);
  return p;
};

t('padrão de fábrica: vidro LIGADO (2026-10-03, com o ritmo de repintura)', () => {
  assert.deepStrictEqual(padroes(), { glass: true, pet: true });
});

t('padrões() devolve objeto NOVO (ninguém muta o padrão)', () => {
  const a = padroes(); a.glass = false;
  assert.strictEqual(padroes().glass, true);
});

t('arquivo inexistente → padrão, sem lançar', () => {
  assert.deepStrictEqual(lerUiPrefs(path.join(tmp, 'nao-existe.json')), { glass: true, pet: true });
});

t('JSON corrompido (gravação interrompida) → padrão, sem lançar', () => {
  assert.deepStrictEqual(lerUiPrefs(arq('{"glass": fa')), { glass: true, pet: true });
});

t('glass: false desliga', () => {
  assert.strictEqual(glassLigado(arq('{"glass": false}')), false);
});

t('glass: true liga', () => {
  assert.strictEqual(glassLigado(arq('{"glass": true}')), true);
});

t('chave ausente → ligado (estado antigo, pré-toggle)', () => {
  assert.strictEqual(glassLigado(arq('{"activeProfileNum": 14}')), true);
});

t('"false" em STRING não desliga (só o booleano)', () => {
  assert.strictEqual(glassLigado(arq('{"glass": "false"}')), true);
});

t('0 não desliga', () => {
  assert.strictEqual(glassLigado(arq('{"glass": 0}')), true);
});

t('JSON válido mas array → padrão', () => {
  assert.strictEqual(glassLigado(arq('[1,2,3]')), true);
});

t('JSON válido mas null → padrão', () => {
  assert.strictEqual(glassLigado(arq('null')), true);
});

t('lerUiPrefs preserva o resto do estado sem vazar chaves', () => {
  assert.deepStrictEqual(lerUiPrefs(arq('{"pet": false}')), { glass: true, pet: false });  // mascote desligado
  assert.deepStrictEqual(lerUiPrefs(arq('{"glass": false, "activeProfileNum": 9}')), { glass: false, pet: true });
});

t('lerPetPrefs: padrões do Mini e normalização (fora do domínio cai no padrão; tamanho clampado)', () => {
  assert.deepStrictEqual(lerPetPrefs(path.join(tmp, 'nao-existe.json')), { pet: true, petKind: 'auto', petSize: 112, petVisibility: 'always' });
  assert.deepStrictEqual(lerPetPrefs(arq('{"pet":false,"petKind":"clawd","petSize":300,"petVisibility":"onDemand"}')),
    { pet: false, petKind: 'clawd', petSize: 224, petVisibility: 'onDemand' });
  assert.deepStrictEqual(lerPetPrefs(arq('{"petKind":"dog","petSize":"99","petVisibility":"x","pet":"false"}')),
    { pet: true, petKind: 'auto', petSize: 112, petVisibility: 'always' });
  assert.strictEqual(lerPetPrefs(arq('{"petSize":10.4}')).petSize, 80);
  assert.deepStrictEqual(normalizarPetPrefs({ glass: false, petKind: 'none' }), { petKind: 'none' });
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nTUDO PASSOU (${n}/${n})`);
