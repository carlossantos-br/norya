#!/usr/bin/env node
/**
 * O deploy do macOS copia por ALLOWLIST. Um arquivo novo na raiz do app que
 * ninguém adiciona ao `deploy.sh` não gera erro nenhum no deploy — o bundle
 * simplesmente fica sem ele, e o `require()` no topo do main.js derruba o app
 * no boot, depois, na máquina do usuário.
 *
 * Aconteceu na Fase 1 (renderer/), na Fase 3 (agents/) e quase de novo no port
 * do Windows (platform.js, helpers/badge-icon.js). Este teste fecha a porta:
 * todo require relativo do main.js tem que estar coberto pelo deploy.
 *
 * Uso: node test/deploy-allowlist.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
// Comentários FORA: um `# copia platform.js` satisfaria a busca sem copiar
// nada. Só as linhas de comando contam. (Este teste já passou verde por causa
// do próprio comentário que eu tinha acabado de escrever.)
const deploy = fs.readFileSync(path.join(RAIZ, 'deploy.sh'), 'utf8')
  .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const main = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8');

// Diretórios que o deploy.sh copia INTEIROS (rsync/cp -R).
const DIRS_INTEIROS = ['browser', 'bin', 'agents', 'renderer', 'quota', 'branding', 'assets', 'pet', 'chat'];

const requires = [...main.matchAll(/\brequire\(\s*'(\.[^']+)'\s*\)/g)].map(m => m[1]);
assert.ok(requires.length > 5, 'não achei os requires do main.js — regex quebrou?');

const descobertos = [];
for (const rel of requires) {
  const semPonto = rel.replace(/^\.\//, '');
  const dirTopo = semPonto.split('/')[0];
  if (DIRS_INTEIROS.includes(dirTopo)) continue;   // coberto por rsync do diretório

  // Arquivo avulso: o deploy tem que citá-lo pelo nome.
  const arquivo = path.basename(semPonto);
  const nomes = [arquivo, `${arquivo}.js`];
  const citado = nomes.some(n => deploy.includes(n));
  if (!citado) descobertos.push(rel);
}

assert.deepStrictEqual(descobertos, [],
  `require(s) do main.js fora do deploy.sh — o app vai subir sem eles: ${descobertos.join(', ')}`);
console.log(`PASS  todos os ${requires.length} requires do main.js estão cobertos pelo deploy.sh`);

// E o inverso barato: os arquivos citados existem mesmo.
for (const f of ['platform.js', 'helpers/badge-icon.js', 'norya-home.js']) {
  assert.ok(fs.existsSync(path.join(RAIZ, f)), `deploy.sh cita ${f}, que não existe`);
}
console.log('PASS  os arquivos citados pelo deploy.sh existem');
console.log('\nTUDO PASSOU (2/2)');
