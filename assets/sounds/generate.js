#!/usr/bin/env node
'use strict';

/**
 * assets/sounds/generate.js — gera os sons do motor de atenção (2026-10-04).
 *
 * Os sons de marimba antigos (knock-knock, 3 batidas) eram longos e chamativos
 * para algo que toca dezenas de vezes por dia. Agora são ticks curtos e
 * discretos, sintetizados aqui para que qualquer ajuste seja reproduzível:
 *
 *   task-done.wav   1 tick  ~90 ms, senoide 1,2 kHz          (turno/PTY terminou)
 *   needs-you.wav   2 ticks curtos subindo, mais baixos      (espera você)
 *   task-error.wav  1 tick uma oitava abaixo (600 Hz)        (PTY saiu com erro)
 *
 * Tick = ataque de 2 ms + decaimento exponencial, com um 2º parcial suave que
 * morre antes do fundamental (dá "corpo" sem virar bip). Pico em ~-20 dBFS.
 * WAV mono, 44,1 kHz, 16 bits — os nomes são os que renderer/attention.js usa.
 *
 * Uso: node assets/sounds/generate.js   (sobrescreve os .wav desta pasta)
 */

const fs = require('fs');
const path = require('path');

const RATE = 44100;

const dbfs = db => Math.pow(10, db / 20);

/** Um tick em Float32: senoide + 2º parcial, envelope ataque/decaimento. */
function tick({ freq, durMs = 90, attackMs = 2, peakDb = -20, partial = 0.22 }) {
  const n = Math.round(RATE * durMs / 1000);
  const att = Math.max(1, Math.round(RATE * attackMs / 1000));
  // Decaimento que chega a ~-60 dB no fim: e^(-6.9) ≈ 0,001.
  const tau = (n - att) / 6.9;
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    // Ataque em meia-senoide: sem clique no começo.
    const env = i < att ? Math.sin((Math.PI / 2) * (i / att)) : Math.exp(-(i - att) / tau);
    // O 2º parcial decai 2,5× mais rápido: brilho só no começo.
    const env2 = i < att ? env : Math.exp(-(i - att) / (tau / 2.5));
    const v = env * Math.sin(2 * Math.PI * freq * t) + partial * env2 * Math.sin(2 * Math.PI * 2 * freq * t);
    out[i] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  const g = dbfs(peakDb) / (peak || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** Mixa trechos em posições (ms) num buffer só. */
function mix(parts, totalMs) {
  const out = new Float32Array(Math.round(RATE * totalMs / 1000));
  for (const { at, buf } of parts) {
    const off = Math.round(RATE * at / 1000);
    for (let i = 0; i < buf.length && off + i < out.length; i++) out[off + i] += buf[i];
  }
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);   // PCM
  h.writeUInt16LE(1, 22);                         // mono
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const SONS = {
  'task-done.wav': () => tick({ freq: 1200, durMs: 90 }),
  // Quarta justa acima (1200 → 1600): pergunta, sem alarme. 2 dB mais baixo.
  'needs-you.wav': () => mix([
    { at: 0, buf: tick({ freq: 1200, durMs: 70, peakDb: -22 }) },
    { at: 105, buf: tick({ freq: 1600, durMs: 80, peakDb: -22 }) },
  ], 190),
  'task-error.wav': () => tick({ freq: 600, durMs: 110 }),
};

if (require.main === module) {
  for (const [nome, gerar] of Object.entries(SONS)) {
    const buf = wav(gerar());
    fs.writeFileSync(path.join(__dirname, nome), buf);
    console.log(`${nome}  ${buf.length} bytes`);
  }
}

module.exports = { tick, mix, wav, SONS, RATE };
