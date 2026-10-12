#!/usr/bin/env node
/**
 * Guarda contra getElementById('x') sem <... id="x"> no HTML.
 *
 * Motivo: 2026-07-10 removeu #railGrid e #btnToggleSidebar do test-window.html.
 * Um addEventListener num getElementById(null) explode; um `?.` falha em
 * silêncio. As duas classes são invisíveis pro `node --check`.
 *
 * Ids criados DINAMICAMENTE via createElement ficam na allowlist.
 * Uso: node test/no-dangling-dom-ids.test.js → exit 0 = PASS
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(APP, 'test-window.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// Ids que o próprio JS cria em runtime (document.createElement + .id = …).
const DINAMICOS = new Set([
  'gridBanner', 'consultBanner', 'mergeAgentBanner', 'norya-splash',
]);
// Pré-existentes (baseline 2026-07-10): não são regressão desta task. Dois grupos:
//   • Criados via innerHTML/h({id}) — o regex `.id =` abaixo não enxerga string:
//     'noryaStatusBar', 'folderPickBrowse'.
//   • Lookups guardados por `if (el)` de elementos opcionais do seletor de view
//     antigo (a grid virou a única view nas Tasks 1-10). Cair fora aqui é inócuo.
//     Os 4 ids do dropdown de view-mode saíram desta lista em 2026-09-08: o
//     código que os procurava foi removido junto (ver renderer/views.js).
// A guarda existe pra pegar NOVOS ids pendurados (railGrid, btnToggleSidebar).
for (const id of [
  'noryaStatusBar', 'folderPickBrowse', 'tcLabel',
]) DINAMICOS.add(id);
// O JS também REGISTRA ids dinâmicos: qualquer `X.id = 'nome'` entra na allowlist.
const files = fs.readdirSync(path.join(APP, 'renderer')).filter(f => f.endsWith('.js'));
for (const f of files) {
  const src = fs.readFileSync(path.join(APP, 'renderer', f), 'utf8');
  for (const m of src.matchAll(/\.id\s*=\s*'([\w-]+)'/g)) DINAMICOS.add(m[1]);
  for (const m of src.matchAll(/\.id\s*=\s*"([\w-]+)"/g)) DINAMICOS.add(m[1]);
}

let falhas = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(APP, 'renderer', f), 'utf8');
  src.split('\n').forEach((linha, i) => {
    const semComentario = linha.replace(/\/\/.*$/, '');
    for (const m of semComentario.matchAll(/getElementById\(\s*'([\w-]+)'\s*\)/g)) {
      const id = m[1];
      if (htmlIds.has(id) || DINAMICOS.has(id)) continue;
      console.log(`FAIL  renderer/${f}:${i + 1}  getElementById('${id}') — id não existe no HTML`);
      falhas++;
    }
  });
}
assert.strictEqual(falhas, 0, `${falhas} id(s) pendurado(s)`);
console.log(`PASS  todos os getElementById apontam pra ids reais (${htmlIds.size} ids no HTML)`);
