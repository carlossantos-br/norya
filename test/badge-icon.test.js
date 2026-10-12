#!/usr/bin/env node
/**
 * Unitário do gerador do badge da taskbar (Windows).
 *
 * O macOS tem `app.dock.setBadge(String)`; o Windows exige uma IMAGEM. Como o
 * número muda a cada evento, o PNG é montado em memória — e um PNG malformado
 * não dá erro no Electron, só não aparece. Daí o teste checar a estrutura.
 *
 * Uso: node test/badge-icon.test.js
 */
const assert = require('assert');
const zlib = require('zlib');
const { badgePng, rotulo, TAM } = require('../helpers/badge-icon');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

t('sem panes aguardando não há badge', () => {
  assert.strictEqual(badgePng(0), null);
  assert.strictEqual(badgePng(-1), null);
  assert.strictEqual(badgePng('abc'), null);
  assert.strictEqual(badgePng(undefined), null);
});

t('1..9 mostram o número; acima disso, 9+', () => {
  assert.strictEqual(rotulo(1), '1');
  assert.strictEqual(rotulo(9), '9');
  assert.strictEqual(rotulo(10), '9+');
  assert.strictEqual(rotulo(999), '9+');
});

t('a saída é um PNG de verdade (assinatura + IHDR + IEND)', () => {
  const png = badgePng(3);
  assert.deepStrictEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.strictEqual(png.slice(12, 16).toString('ascii'), 'IHDR');
  assert.strictEqual(png.slice(-8, -4).toString('ascii'), 'IEND');
});

t('IHDR declara 32x32 RGBA', () => {
  const png = badgePng(3);
  assert.strictEqual(png.readUInt32BE(16), TAM);
  assert.strictEqual(png.readUInt32BE(20), TAM);
  assert.strictEqual(png[24], 8, 'bit depth 8');
  assert.strictEqual(png[25], 6, 'color type 6 = RGBA');
});

t('o IDAT descomprime no tamanho exato das scanlines', () => {
  const png = badgePng(7);
  // IHDR: 8 (assinatura) + 12 + 13 = 33 → aqui começa o próximo chunk.
  const len = png.readUInt32BE(33);
  assert.strictEqual(png.slice(37, 41).toString('ascii'), 'IDAT');
  const cru = zlib.inflateSync(png.slice(41, 41 + len));
  assert.strictEqual(cru.length, TAM * (1 + TAM * 4), 'filtro + RGBA por linha');
  for (let y = 0; y < TAM; y++) {
    assert.strictEqual(cru[y * (1 + TAM * 4)], 0, `scanline ${y} deve usar filtro None`);
  }
});

t('o desenho tem pixels de fundo E de tinta (não é um disco vazio)', () => {
  const png = badgePng(4);
  const len = png.readUInt32BE(33);
  const cru = zlib.inflateSync(png.slice(41, 41 + len));
  let fundo = 0, tinta = 0, transp = 0;
  for (let y = 0; y < TAM; y++) {
    const base = y * (1 + TAM * 4) + 1;
    for (let x = 0; x < TAM; x++) {
      const i = base + x * 4;
      const [r, g, b, a] = [cru[i], cru[i + 1], cru[i + 2], cru[i + 3]];
      if (a === 0) transp++;
      else if (r === 255 && g === 255 && b === 255) tinta++;
      else if (r === 0xE7) fundo++;
    }
  }
  assert.ok(tinta > 20, `dígito quase invisível (${tinta} px)`);
  assert.ok(fundo > 300, `disco pequeno demais (${fundo} px)`);
  assert.ok(transp > 100, 'os cantos fora do disco têm que ser transparentes');
});

t('contagens diferentes geram imagens diferentes', () => {
  assert.notStrictEqual(badgePng(1).toString('base64'), badgePng(2).toString('base64'));
  assert.strictEqual(badgePng(10).toString('base64'), badgePng(50).toString('base64'),
    'acima de 9 o rótulo é o mesmo, então o PNG também');
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
