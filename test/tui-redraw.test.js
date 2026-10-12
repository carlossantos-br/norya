#!/usr/bin/env node
/**
 * Regressão do menu de seleção travado com DUAS opções marcadas (2026-09-03).
 *
 * SINTOMA (print do Carlos): o seletor de opções do Claude Code num pane do grid
 * mostra `❯` em duas opções ao mesmo tempo, o cabeçalho da pergunta some, e a
 * seta não escolhe mais a de cima.
 *
 * CAUSA: a repintura do Claude Code é DIFERENCIAL e só usa movimento relativo —
 * capturado em bytes crus de um PTY real: uma seta emite ~103 bytes de `\x1b[NA`
 * (sobe N linhas) + `\x1b[NG` (coluna N) + o caractere que mudou. Nenhum
 * `\x1b[2J` na sessão inteira. Quando o frame é mais alto que `rows`, o topo
 * rola pra fora e o `\x1b[NA` SATURA no topo da tela: o patch cai na linha
 * errada e o `❯` velho nunca é apagado. Sem limpeza de tela, o estrago é
 * permanente — o pane fica congelado assim.
 *
 * O terminal está certo (saturar CUU no topo da tela é o comportamento de
 * qualquer emulador). O que o Norya pode fazer é pedir repintura COMPLETA, e o
 * único gatilho que o Claude atende é SIGWINCH — medido no mesmo PTY:
 * Ctrl+L → 0 bytes, Ctrl+R → 0 bytes, resize → 908 bytes.
 *
 * Uso: node test/tui-redraw.test.js   (puro — sem Electron, sem app aberto)
 */
const assert = require('assert');
const { Terminal } = require('@xterm/headless');
const R = require('../renderer/tui-redraw');

const COLS = 51;                 // largura real de uma célula do grid do Norya
const ROWS_PANE = 16;            // altura real de uma célula (stty -f /dev/ttysNNN)
const ROWS_FOLGA = 26;           // pane alto o bastante pro frame caber

// Opções idênticas às de renderer/views.js buildGridCellXterm (as que afetam buffer).
const OPTS = {
  scrollback: 8000, allowProposedApi: true, drawBoldTextInBrightColors: true,
  macOptionIsMeta: true, scrollOnUserInput: false, convertEol: false,
};

// ── Frame igual ao do print: pergunta + 3 opções com descrição + rodapé ───────
const desc = n => Array.from({ length: 5 }, (_, i) => `     linha ${i + 1} da descricao da opcao ${n}`);
const FRAME = [
  'Escolha uma opcao:',
  '',
  '  1. 30 dias, teto de 24 (Recomendado)',
  ...desc(1),
  '  2. 30 dias puros, sem teto',
  ...desc(2),
  '  3. Sempre as 24 mais novas',
  ...desc(3),
  '',
  'Enter para confirmar',
];
const LINHA_OPCAO = [2, 8, 14];   // onde mora o `❯` de cada opção
const COL_MARCADOR = 1;           // coluna 1 (1-indexed), como o Claude faz
FRAME.forEach(l => { if (l.length >= COLS) throw new Error('fixture: linha faria wrap: ' + l); });
assert.ok(FRAME.length > ROWS_PANE, 'a fixture precisa ser mais alta que o pane');

/**
 * Renderizador diferencial fiel ao que o Claude Code emite (bytes capturados de
 * um PTY real): desenha uma vez e depois só remenda, sempre com movimento
 * RELATIVO. Ele é correto no próprio modelo — num terminal alto o bastante o
 * resultado é perfeito. A única variável do teste é a altura do terminal.
 */
function criarRenderizador(selecionada) {
  let linhaAtual = 0;            // linha do frame onde o cursor está
  let pend = '';
  const mover = destino => {
    const d = destino - linhaAtual;
    if (d < 0) pend += `\x1b[${-d}A`;
    else if (d > 0) pend += `\x1b[${d}B`;
    linhaAtual = destino;
  };
  const patch = (linha, col, ch) => { mover(linha); pend += `\x1b[${col}G${ch}`; };

  // Primeira pintura: frame inteiro, uma passada só.
  pend += FRAME.map((l, i) => (i === LINHA_OPCAO[selecionada] ? '❯' + l.slice(1) : l)).join('\r\n');
  linhaAtual = FRAME.length - 1;

  return {
    /** Move a seleção como uma seta faria: apaga o marcador velho, escreve o novo. */
    mover(para) {
      patch(LINHA_OPCAO[selecionada], COL_MARCADOR, ' ');
      patch(LINHA_OPCAO[para], COL_MARCADOR, '❯');
      selecionada = para;
      return this;
    },
    /** Bytes ainda não entregues ao terminal (o PTY entrega em chunks). */
    novo() { const s = pend; pend = ''; return s; },
  };
}

const escreve = (t, s) => new Promise(r => t.write(s, r));
const noFim = t => { const b = t.buffer.active; return b.viewportY >= b.baseY - 1; };

/**
 * Escreve um chunk como o listener do Norya faz (renderer/views.js
 * buildGridCellXterm): mede o "stick" antes, escreve, e só volta pro fim se já
 * estava lá.
 */
async function escreveComoNorya(t, chunk) {
  const stick = noFim(t);
  await escreve(t, chunk);
  if (stick) t.scrollToBottom();
}

/** O que o usuário ENXERGA: as `rows` linhas a partir do viewport. */
function janela(term) {
  const b = term.buffer.active, L = [];
  for (let y = b.viewportY; y < b.viewportY + term.rows; y++) {
    const l = b.getLine(y);
    L.push(l ? l.translateToString(true).replace(/\s+$/, '') : '');
  }
  return L.join('\n');
}
const marcadores = s => (s.match(/❯/g) || []).length;
/** A invariante que importa: o `❯` está grudado no título da opção escolhida. */
const marcadorNaOpcao3 = s => /❯ 3\. Sempre/.test(s);

/** Abre o menu na opção 1 e aperta a seta até a 3, num pane de `rows` linhas. */
async function cenario(rows) {
  const t = new Terminal({ ...OPTS, cols: COLS, rows });
  const r = criarRenderizador(0);
  await escreveComoNorya(t, r.novo());
  await escreveComoNorya(t, r.mover(2).novo());
  const visto = janela(t);
  t.dispose();
  return visto;
}

let n = 0, falhas = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log(`PASS  ${nome}`); n++; }
  catch (e) { console.error(`FAIL  ${nome}\n      ${e.message}`); falhas++; }
};

(async () => {
  // ── módulo puro ────────────────────────────────────────────────────────────
  await t('só seta arma o detector (Enter e texto não)', () => {
    for (const k of ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1bOA', '\x1bOB'])
      assert.ok(R.ehTeclaDeNavegacao(k), `devia armar: ${JSON.stringify(k)}`);
    for (const k of ['\r', '\n', 'a', '\x1b', '\x1b[1~', '', null, undefined])
      assert.ok(!R.ehTeclaDeNavegacao(k), `NÃO devia armar: ${JSON.stringify(k)}`);
  });

  await t('maiorSubida lê o maior salto pra cima do chunk', () => {
    assert.strictEqual(R.maiorSubida('\x1b[14A'), 14);
    assert.strictEqual(R.maiorSubida('\x1b[A'), 1, 'CSI sem número é 1');
    assert.strictEqual(R.maiorSubida('a\x1b[3A b \x1b[11A c \x1b[2A'), 11);
    assert.strictEqual(R.maiorSubida('texto\x1b[3F'), 3, 'CPL também sobe');
    assert.strictEqual(R.maiorSubida('so texto\r\n'), 0);
    assert.strictEqual(R.maiorSubida('\x1b[5B\x1b[2G'), 0, 'só desce: é fluxo novo');
    assert.strictEqual(R.maiorSubida(null), 0);
  });

  await t('cutuca só quando teve seta E a subida não cabe na tela', () => {
    let nudges = 0;
    const g = R.criarGuardaRepintura({ repintar: () => nudges++, agora: () => 1000 });
    // sem seta: nada, por maior que seja a subida
    assert.strictEqual(g.aposEscrita({ data: '\x1b[20A', rows: 16 }), false);
    g.armar();
    // sobe 15 numa tela de 16: cabe — é o agente repintando um frame que coube
    assert.strictEqual(g.aposEscrita({ data: '\x1b[15A', rows: 16 }), false);
    // não sobe nada: é saída nova streamando
    assert.strictEqual(g.aposEscrita({ data: 'saida nova\r\n', rows: 16 }), false);
    // sobe 20 numa tela de 16: impossível de atender — o frame transbordou
    assert.strictEqual(g.aposEscrita({ data: '\x1b[20A x', rows: 16 }), true);
    assert.strictEqual(nudges, 1);
  });

  await t('medida real: /config em 14 linhas (subida máx. 13) NÃO cutuca', () => {
    let nudges = 0;
    const g = R.criarGuardaRepintura({ repintar: () => nudges++, agora: () => 1000 });
    // subidas capturadas de um PTY real rodando /config a 51x14
    for (const sub of [13, 9, 9, 8, 8, 7, 7, 6, 6, 9, 7]) {
      g.armar();
      assert.strictEqual(g.aposEscrita({ data: `\x1b[${sub}A`, rows: 14 }), false, `subida ${sub}`);
    }
    assert.strictEqual(nudges, 0, 'menu que colapsa pra caber não pode ser cutucado');
  });

  await t('um nudge por tecla — a repintura que ele provoca não re-dispara', () => {
    let nudges = 0;
    const g = R.criarGuardaRepintura({ repintar: () => nudges++, agora: () => 1000 });
    g.armar();
    const ev = { data: '\x1b[19A', rows: 16 };
    g.aposEscrita(ev);
    g.aposEscrita(ev);   // a repintura completa também sobe linhas
    g.aposEscrita(ev);
    assert.strictEqual(nudges, 1, 'sem essa trava o nudge vira loop infinito');
  });

  await t('o armamento expira — streaming tardio não cutuca', () => {
    let nudges = 0, relogio = 1000;
    const g = R.criarGuardaRepintura({ repintar: () => nudges++, agora: () => relogio, janelaMs: 1200 });
    g.armar();
    relogio = 1000 + 1201;
    assert.strictEqual(g.aposEscrita({ data: '\x1b[19A', rows: 16 }), false);
    assert.strictEqual(nudges, 0);
  });

  await t('cutucarResize manda rows-1 e volta pra rows, em dois ioctl separados', () => {
    const enviados = []; const pendentes = [];
    const ok = R.cutucarResize((c, r) => enviados.push([c, r]), 51, 16, fn => pendentes.push(fn));
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(enviados, [[51, 15]], 'o segundo resize não pode sair junto');
    pendentes.forEach(fn => fn());
    assert.deepStrictEqual(enviados, [[51, 15], [51, 16]]);
  });

  await t('cutucarResize não mexe em pane minúsculo nem sem canal', () => {
    assert.strictEqual(R.cutucarResize(() => {}, 51, 2, fn => fn()), false);
    assert.strictEqual(R.cutucarResize(() => {}, 0, 16, fn => fn()), false);
    assert.strictEqual(R.cutucarResize(null, 51, 16, fn => fn()), false);
  });

  // ── comportamento real do xterm ────────────────────────────────────────────
  await t('pane alto: o frame cabe e o remendo acerta a linha', async () => {
    const visto = await cenario(ROWS_FOLGA);
    assert.strictEqual(marcadores(visto), 1, `um marcador só:\n${visto}`);
    assert.ok(marcadorNaOpcao3(visto), `e na opção escolhida:\n${visto}`);
  });

  await t('O BUG: pane de 16 linhas põe o ❯ na linha ERRADA (o print do Carlos)', async () => {
    const visto = await cenario(ROWS_PANE);
    assert.ok(!marcadorNaOpcao3(visto),
      `este teste prova o print; se passou a acertar, o mecanismo mudou:\n${visto}`);
  });

  await t('o estrago é PERMANENTE: mais setas não desentortam', async () => {
    const t2 = new Terminal({ ...OPTS, cols: COLS, rows: ROWS_PANE });
    const r = criarRenderizador(0);
    await escreveComoNorya(t2, r.novo());
    for (const alvo of [2, 1, 2, 0, 2]) await escreveComoNorya(t2, r.mover(alvo).novo());
    const visto = janela(t2);
    t2.dispose();
    assert.ok(!marcadorNaOpcao3(visto),
      `sem limpar a tela, nenhuma repintura parcial conserta:\n${visto}`);
  });

  // ── fiação: o listener do Norya + a guarda, como em views.js/threads.js ────
  /**
   * Roda o mesmo caminho de código do renderer (arma na seta, escreve, checa no
   * callback do write) e conta quantos nudges sairiam.
   */
  async function comFiacao(rows) {
    const term = new Terminal({ ...OPTS, cols: COLS, rows });
    let nudges = 0;
    const guarda = R.criarGuardaRepintura({ repintar: () => nudges++ });
    const escreverComoListener = async chunk => {
      const stick = noFim(term);
      guarda.aposEscrita({ data: chunk, rows: term.rows });
      await escreve(term, chunk);
      if (stick) term.scrollToBottom();
    };
    const r = criarRenderizador(0);
    await escreverComoListener(r.novo());       // primeira pintura: sem tecla antes
    guarda.armar();                             // usuário apertou ↓ (onData)
    await escreverComoListener(r.mover(2).novo());
    term.dispose();
    return nudges;
  }

  await t('fiação: pane que TRANSBORDA pede repintura (1 nudge)', async () => {
    assert.strictEqual(await comFiacao(ROWS_PANE), 1);
  });

  await t('fiação: pane que CABE não pede nada (0 nudge)', async () => {
    assert.strictEqual(await comFiacao(ROWS_FOLGA), 0,
      'nudge em pane que cabe seria uma repintura inteira desperdiçada por tecla');
  });

  await t('FIX: a repintura completa que o nudge provoca põe o ❯ de volta no lugar', async () => {
    const t3 = new Terminal({ ...OPTS, cols: COLS, rows: ROWS_PANE });
    const r = criarRenderizador(0);
    await escreveComoNorya(t3, r.novo());
    await escreveComoNorya(t3, r.mover(2).novo());
    assert.ok(!marcadorNaOpcao3(janela(t3)), 'precondição: a tela está corrompida');

    // O que o SIGWINCH causa (medido: 908 bytes): frame inteiro numa passada só.
    await escreveComoNorya(t3, '\r\n' + criarRenderizador(2).novo());
    const visto = janela(t3);
    t3.dispose();
    assert.strictEqual(marcadores(visto), 1, `um marcador só:\n${visto}`);
    assert.ok(marcadorNaOpcao3(visto), `e na linha CERTA:\n${visto}`);
  });

  console.log(`\n${n} passaram, ${falhas} falharam`);
  process.exit(falhas ? 1 : 0);
})();
