#!/usr/bin/env node
/**
 * Regressão do borrão de tela em pane reconstruído (2026-08-25).
 *
 * SINTOMA: abrir um menu de seleção do Claude Code num pane do Norya mostrava
 * frames sobrepostos — a mesma linha repetida três vezes, metade de um texto
 * colada na metade de outro, rodapés empilhados na borda direita.
 *
 * CAUSA: `st.termBuffers[spawnId]` são bytes CRUS de TUI, e bytes de TUI só
 * fazem sentido na largura em que foram gravados (wrap implícito na borda +
 * `\x1b[nA` contando linhas FÍSICAS). O replay num pane reconstruído acontecia
 * num `new Terminal({...})` sem cols/rows — ou seja, no default 80x24 do
 * xterm.js. A 80 colunas as linhas quebram onde não deviam, o cursor-up conta
 * errado, e cada repintura do Ink escreve por cima da anterior.
 *
 * Nada desfaz isso depois: o Ink repinta só o retângulo do próprio frame, nunca
 * limpa a tela. Por isso o estrago sobrevivia até o fim da sessão.
 *
 * Uso: node test/xterm-replay.test.js   (puro — sem Electron, sem app aberto)
 */
const assert = require('assert');
const xh = require('@xterm/headless');
const { Terminal } = xh;
const R = require('../renderer/term-replay');

const XTERM_DEFAULT_COLS = 80;   // o que o Norya usava sem querer
const XTERM_DEFAULT_ROWS = 24;

// Opções idênticas às de renderer/views.js buildGridCellXterm (as que afetam buffer).
const OPTS = {
  scrollback: 8000, allowProposedApi: true, drawBoldTextInBrightColors: true,
  macOptionIsMeta: true, scrollOnUserInput: false, convertEol: false,
};

/**
 * Stream no formato que o Ink emite: desenha um frame de N linhas, sobe N
 * linhas com `\x1b[NA`, e redesenha. Linhas com 88 colunas de texto: cabem
 * inteiras em 96, quebram em duas em 80. É essa quebra que desalinha o
 * cursor-up e produz o borrão.
 */
function inkLikeFrames(repeticoes) {
  const LARGURA = 88;   // > 80 (quebra no default do xterm) e < 96 (cabe no pane)
  const linhas = [
    ('  1. Primeira opcao, com descricao comprida o bastante para ' ).padEnd(LARGURA, 'a'),
    ('  2. Segunda opcao, com descricao comprida o bastante para '  ).padEnd(LARGURA, 'b'),
    ('  3. Terceira opcao, com descricao comprida o bastante para ' ).padEnd(LARGURA, 'c'),
  ];
  linhas.forEach(l => { if (l.length !== LARGURA) throw new Error('fixture: linha com ' + l.length); });
  let out = '\x1b[H\x1b[2J';
  for (let i = 0; i < repeticoes; i++) {
    if (i > 0) out += `\x1b[${linhas.length}A`;   // Ink volta N linhas LÓGICAS
    out += linhas.map(l => '\x1b[2K' + l).join('\r\n') + '\r\n';
  }
  return out;
}

const escreve = (t, s) => new Promise(r => t.write(s, r));

function tela(term) {
  const b = term.buffer.active, linhas = [];
  for (let y = b.viewportY; y < b.viewportY + term.rows; y++) {
    const l = b.getLine(y);
    linhas.push(l ? l.translateToString(true).replace(/\s+$/, '') : '');
  }
  return linhas.join('\n').replace(/\n+$/, '');
}

/** Terminal que sempre esteve no tamanho certo — o que o usuário deveria ver. */
async function referencia(stream, cols, rows) {
  const t = new Terminal({ ...OPTS, cols, rows });
  await escreve(t, stream);
  const s = tela(t); t.dispose(); return s;
}

/** Pane reconstruído: nasce em `nasceCols`x`nasceRows`, replaya, depois o fit. */
async function paneReconstruido(stream, nasceCols, nasceRows, paneCols, paneRows) {
  const t = new Terminal({ ...OPTS, cols: nasceCols, rows: nasceRows });
  await escreve(t, stream);
  t.resize(paneCols, paneRows);                 // setupXtermResize -> fit.fit()
  await new Promise(r => setTimeout(r, 20));
  const s = tela(t); t.dispose(); return s;
}

let n = 0, falhas = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log(`PASS  ${nome}`); n++; }
  catch (e) { console.error(`FAIL  ${nome}\n      ${e.message}`); falhas++; }
};

(async () => {
  // ── módulo puro ────────────────────────────────────────────────────────────
  await t('replaySize cai no tamanho de spawn do PTY, nunca em 80x24', () => {
    assert.deepStrictEqual(R.replaySize(null), { cols: R.PTY_SPAWN_COLS, rows: R.PTY_SPAWN_ROWS });
    assert.deepStrictEqual(R.replaySize({}), { cols: R.PTY_SPAWN_COLS, rows: R.PTY_SPAWN_ROWS });
    assert.notStrictEqual(R.replaySize(null).cols, XTERM_DEFAULT_COLS);
  });

  await t('replaySize usa o tamanho gravado quando existe', () => {
    assert.deepStrictEqual(R.replaySize({ cols: 96, rows: 20 }), { cols: 96, rows: 20 });
  });

  await t('replaySize ignora dimensão inválida (0, negativa, fracionária, NaN)', () => {
    for (const ruim of [0, -5, 12.5, NaN, '96', null, undefined]) {
      assert.strictEqual(R.replaySize({ cols: ruim, rows: 20 }).cols, R.PTY_SPAWN_COLS, `cols=${ruim}`);
      assert.strictEqual(R.replaySize({ cols: 96, rows: ruim }).rows, R.PTY_SPAWN_ROWS, `rows=${ruim}`);
    }
  });

  await t('safeReplayStart deixa buffer inteiro intacto', () => {
    const buf = 'abc\x1b[2Kdef';
    assert.strictEqual(R.safeReplayStart(buf, 1024), buf);
  });

  await t('safeReplayStart corta a cauda de escape partida quando o buffer está no teto', () => {
    // slice(-N) caiu dentro de um OSC: sobrou "8;;http://x\x07" sem o ESC].
    // Alimentar isso deixa o parser esperando um terminador que nunca veio.
    const partido = '8;;http://exemplo\x07texto\x1b[2Klimpo';
    const saida = R.safeReplayStart(partido, partido.length);
    assert.strictEqual(saida, '\x1b[2Klimpo');
    assert.ok(saida.startsWith('\x1b'), 'replay tem que começar num ESC');
  });

  await t('safeReplayStart não engole tudo se não houver ESC nenhum', () => {
    const semEsc = 'so texto puro';
    assert.strictEqual(R.safeReplayStart(semEsc, semEsc.length), semEsc);
  });

  await t('prepareReplay entrega texto + dimensões juntos', () => {
    const r = R.prepareReplay('oi', { cols: 96, rows: 20 });
    assert.deepStrictEqual(r, { text: 'oi', cols: 96, rows: 20 });
  });

  // ── comportamento real do xterm ────────────────────────────────────────────
  const PANE = { cols: 96, rows: 20 };
  const stream = inkLikeFrames(3);
  const esperado = await referencia(stream, PANE.cols, PANE.rows);

  await t('o bug existe: replay em 80x24 (default do xterm.js) borra a tela', async () => {
    const borrado = await paneReconstruido(stream, XTERM_DEFAULT_COLS, XTERM_DEFAULT_ROWS, PANE.cols, PANE.rows);
    assert.notStrictEqual(borrado, esperado,
      'o fixture parou de reproduzir o bug — este teste virou tautologia, conserte o fixture');
    // O borrão tem assinatura: a mesma opção aparece mais de uma vez na tela.
    const repetidas = (borrado.match(/1\. Primeira opcao/g) || []).length;
    assert.ok(repetidas > 1, `esperava linha duplicada no borrão, achei ${repetidas}`);
  });

  await t('o fix: nascer na largura de gravação reproduz a tela correta', async () => {
    const r = R.prepareReplay(stream, { cols: PANE.cols, rows: PANE.rows });
    const corrigido = await paneReconstruido(r.text, r.cols, r.rows, PANE.cols, PANE.rows);
    assert.strictEqual(corrigido, esperado);
  });

  await t('o fix vale quando o pane MUDOU de tamanho enquanto o xterm estava morto', async () => {
    // Gravado em 96x20, pane reaberto em 110x30: não dá pra ser byte-idêntico
    // (o conteúdo foi desenhado com 96 colunas), mas não pode haver borrão.
    const r = R.prepareReplay(stream, { cols: PANE.cols, rows: PANE.rows });
    const corrigido = await paneReconstruido(r.text, r.cols, r.rows, 110, 30);
    const repetidas = (corrigido.match(/1\. Primeira opcao/g) || []).length;
    assert.strictEqual(repetidas, 1, `linha duplicada após resize do pane:\n${corrigido}`);
  });

  await t('sem tamanho gravado o fallback (120x35) ainda não borra', async () => {
    const s120 = inkLikeFrames(3);
    const ref120 = await referencia(s120, R.PTY_SPAWN_COLS, R.PTY_SPAWN_ROWS);
    const r = R.prepareReplay(s120, undefined);
    const corrigido = await paneReconstruido(r.text, r.cols, r.rows, R.PTY_SPAWN_COLS, R.PTY_SPAWN_ROWS);
    assert.strictEqual(corrigido, ref120);
  });

  console.log(`\n${n} passaram, ${falhas} falharam`);
  process.exit(falhas ? 1 : 0);
})();
