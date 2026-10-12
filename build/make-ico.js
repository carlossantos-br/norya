#!/usr/bin/env node
'use strict';
/**
 * build/make-ico.js — monta o build/icon.ico a partir dos PNGs do iconset.
 *
 * O macOS não tem ferramenta que escreva .ico (o `sips` só lê). Escrever o
 * formato à mão é trivial desde o Vista: um .ico pode EMBUTIR PNGs inteiros em
 * vez de bitmaps DIB. O arquivo é ICONDIR + N entradas + N blobs.
 *
 * Uso: node build/make-ico.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const ORIGEM = path.join(RAIZ, 'assets', 'icon.iconset');
const SAIDA = path.join(__dirname, 'icon.ico');
const TAMANHOS = [16, 24, 32, 48, 64, 128, 256];

// Fonte de maior resolução disponível, para os tamanhos que o iconset não tem.
const MESTRE = path.join(ORIGEM, 'icon_1024x1024.png');
if (!fs.existsSync(MESTRE)) throw new Error(`sem mestre: ${MESTRE}`);

const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'norya-ico-'));
const pngs = TAMANHOS.map(t => {
  const direto = path.join(ORIGEM, `icon_${t}x${t}.png`);
  if (fs.existsSync(direto)) return { t, buf: fs.readFileSync(direto) };
  const alvo = path.join(tmp, `${t}.png`);
  execFileSync('sips', ['-z', String(t), String(t), MESTRE, '--out', alvo], { stdio: 'ignore' });
  return { t, buf: fs.readFileSync(alvo) };
});

const N = pngs.length;
const cabecalho = Buffer.alloc(6);
cabecalho.writeUInt16LE(0, 0);   // reservado
cabecalho.writeUInt16LE(1, 2);   // 1 = ícone
cabecalho.writeUInt16LE(N, 4);

const entradas = [];
let deslocamento = 6 + N * 16;
for (const { t, buf } of pngs) {
  const e = Buffer.alloc(16);
  e[0] = t >= 256 ? 0 : t;       // 0 significa 256
  e[1] = t >= 256 ? 0 : t;
  e[2] = 0;                      // cores da paleta
  e[3] = 0;                      // reservado
  e.writeUInt16LE(1, 4);         // planos
  e.writeUInt16LE(32, 6);        // bits por pixel
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(deslocamento, 12);
  deslocamento += buf.length;
  entradas.push(e);
}

fs.writeFileSync(SAIDA, Buffer.concat([cabecalho, ...entradas, ...pngs.map(p => p.buf)]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`✓ ${SAIDA} — ${N} tamanhos (${TAMANHOS.join(', ')}), ${fs.statSync(SAIDA).size} bytes`);
