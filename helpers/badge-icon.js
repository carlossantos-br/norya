'use strict';

/**
 * helpers/badge-icon.js — o disco numerado que vira overlay icon na taskbar.
 *
 * Existe porque o Windows não tem o badge de Dock do macOS. O equivalente é
 * `BrowserWindow.setOverlayIcon(nativeImage, descrição)`, e o ícone precisa ser
 * uma IMAGEM — que muda a cada contagem. Gerar arquivo em disco para 1..9+ seria
 * estado a manter; aqui o PNG é montado na hora, em memória.
 *
 * Sem dependência: `zlib` do Node faz o deflate e o resto é o formato PNG cru
 * (IHDR + IDAT + IEND, RGBA de 8 bits, filtro 0 por scanline).
 *
 * Puro e sem Electron — testável em test/badge-icon.test.js.
 */

const zlib = require('zlib');

// Fonte 3x5. Só dígitos e '+': é tudo que um contador de panes precisa.
const GLIFOS = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

const TAM = 32;                       // o Windows reduz para 16; partir de 32 fica nítido
const FUNDO = [0xE7, 0x4C, 0x3C];     // mesmo vermelho do PROFILE_PALETTE[0]
const TINTA = [0xFF, 0xFF, 0xFF];

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(tipo, dados) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([len, corpo, crc]);
}

/** RGBA cru (TAM*TAM*4) → PNG. */
function encodePng(rgba, largura = TAM, altura = TAM) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  // 10..12 = compression 0, filter 0, interlace 0

  const linhas = Buffer.alloc(altura * (1 + largura * 4));
  for (let y = 0; y < altura; y++) {
    const destino = y * (1 + largura * 4);
    linhas[destino] = 0;   // filtro None
    rgba.copy(linhas, destino + 1, y * largura * 4, (y + 1) * largura * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(linhas, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** '1'..'9' para 1–9; '9+' acima disso; null para 0 ou lixo. */
function rotulo(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 9) return '9+';
  return String(Math.floor(n));
}

/**
 * @param {number} count  panes aguardando
 * @returns {Buffer|null} PNG 32x32, ou null quando não há nada a mostrar
 */
function badgePng(count) {
  const texto = rotulo(count);
  if (!texto) return null;

  const rgba = Buffer.alloc(TAM * TAM * 4, 0);
  const centro = (TAM - 1) / 2;
  const raio = TAM / 2;

  const pinta = (x, y, cor, alfa = 255) => {
    if (x < 0 || y < 0 || x >= TAM || y >= TAM) return;
    const i = (y * TAM + x) * 4;
    rgba[i] = cor[0]; rgba[i + 1] = cor[1]; rgba[i + 2] = cor[2]; rgba[i + 3] = alfa;
  };

  // Disco. Antialias barato: a borda ganha alfa proporcional à distância.
  for (let y = 0; y < TAM; y++) {
    for (let x = 0; x < TAM; x++) {
      const d = Math.hypot(x - centro, y - centro);
      if (d <= raio - 1) pinta(x, y, FUNDO);
      else if (d < raio) pinta(x, y, FUNDO, Math.round(255 * (raio - d)));
    }
  }

  // Texto centralizado. Uma escala que caiba na largura total do rótulo.
  const larguraGlifos = texto.length * 3 + (texto.length - 1);   // 1px de espaço
  const escala = Math.max(2, Math.floor((TAM * 0.62) / larguraGlifos));
  const larguraTexto = larguraGlifos * escala;
  const alturaTexto = 5 * escala;
  let x0 = Math.round((TAM - larguraTexto) / 2);
  const y0 = Math.round((TAM - alturaTexto) / 2);

  for (const ch of texto) {
    const g = GLIFOS[ch];
    if (!g) continue;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (g[gy][gx] !== '1') continue;
        for (let sy = 0; sy < escala; sy++) {
          for (let sx = 0; sx < escala; sx++) {
            pinta(x0 + gx * escala + sx, y0 + gy * escala + sy, TINTA);
          }
        }
      }
    }
    x0 += 4 * escala;
  }

  return encodePng(rgba);
}

module.exports = { badgePng, rotulo, encodePng, GLIFOS, TAM };
