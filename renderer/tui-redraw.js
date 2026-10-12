'use strict';

/**
 * renderer/tui-redraw.js — conserta o menu de seleção que trava com duas
 * opções marcadas ao mesmo tempo (2026-09-03).
 *
 * ## O bug
 *
 * Print do Carlos: o seletor de opções do Claude Code aparece com `❯` em DUAS
 * opções, o cabeçalho da pergunta some, e a seta não escolhe mais a de cima.
 * O pane fica congelado nesse estado até a thread acabar.
 *
 * ## A causa (medida, não deduzida)
 *
 * Gravando os bytes crus de um `claude` num PTY de 51×16 (o tamanho REAL de uma
 * célula do grid do Norya — `stty -f /dev/ttysNNN size`), a repintura do menu é
 * DIFERENCIAL: uma seta pra baixo emite ~103 bytes, só de movimento relativo
 * (`\x1b[NA` sobe N linhas, `\x1b[NG` vai pra coluna N) mais o caractere que
 * mudou. Não existe UM `\x1b[2J` em toda a sessão, e nem alternate screen.
 *
 * Isso funciona enquanto o frame inteiro couber na tela. Quando o frame é mais
 * alto que `rows` — 3 opções com descrição a 51 colunas dão ~27 linhas contra as
 * 16 do pane — o topo do frame rola pra fora, e aí `\x1b[NA` **satura no topo da
 * tela**: o terminal não sobe além da primeira linha visível (é o comportamento
 * correto, de qualquer emulador). O patch que era pra apagar o `❯` da opção 1
 * cai na linha errada, o `❯` novo é escrito em outro lugar, e como o Claude
 * nunca limpa a tela nada desfaz isso. Daí os dois marcadores e o congelamento.
 *
 * ## Por que o conserto é um resize
 *
 * Medido no mesmo PTY: `Ctrl+L` → 0 bytes, `Ctrl+R` → 0 bytes (o Claude não
 * trata nenhum dos dois). Um SIGWINCH → 908 bytes, o frame inteiro repintado do
 * zero. Resize é o ÚNICO jeito de pedir repintura completa. Um par
 * `rows-1` → `rows` com 16 ms de intervalo já basta (com 0 ms os dois ioctl
 * coalescem e nada acontece).
 *
 * Depois da repintura o frame inteiro está no buffer numa passada só — então
 * subir o scroll do pane finalmente mostra o topo do menu de verdade, que era a
 * intenção do `scrollOnUserInput: false` (2026-08-04).
 *
 * ## Por que não cutuca o tempo todo
 *
 * O nudge custa uma repintura inteira. Ele só é armado por tecla de NAVEGAÇÃO
 * (setas — as que mexem seleção de menu) e só dispara se a escrita seguinte
 * provar o transbordo: o agente pediu para subir `>= rows` linhas, o que é
 * impossível de atender numa tela de `rows`. Enquanto o frame cabe o agente
 * nunca pede isso (ele colapsa a própria lista para caber — medido: `/config`
 * numa tela de 14 linhas pede no máximo 13). Fora desse caso, nada é enviado.
 *
 * Carregado dos dois lados: `require()` nos testes e `<script>` clássico no
 * renderer (vira `window.NoryaTuiRedraw`), como renderer/term-replay.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NoryaTuiRedraw = api;
})(typeof window !== 'undefined' ? window : null, function () {

  /** Janela em que uma tecla de navegação deixa o detector armado. */
  const JANELA_MS = 1200;

  /** Intervalo entre os dois resizes do nudge. Com 0 os ioctl coalescem. */
  const NUDGE_GAP_MS = 20;

  // Setas, nas duas codificações que o xterm manda conforme o modo do cursor:
  // normal (CSI: \x1b[A) e application (SS3: \x1bOA). São as teclas que movem a
  // seleção de um menu — Enter não entra, senão o streaming da resposta que vem
  // logo depois armaria o detector à toa.
  const TECLA_NAVEGACAO = /^(?:\x1b(\[|O)[ABCD]|\x1b\[Z|\t| |[1-9])$/;

  /** A tecla move seleção de menu? (só setas — ver comentário acima) */
  function ehTeclaDeNavegacao(data) {
    return typeof data === 'string' && TECLA_NAVEGACAO.test(data);
  }

  // CUU (`\x1b[NA`, sobe N linhas) e CPL (`\x1b[NF`, sobe N e vai pra coluna 1).
  // Qualquer um dos dois significa "estou remendando o que já desenhei".
  const REPINTURA_NO_LUGAR = /\x1b\[([0-9]*)[AF]/g;

  /**
   * Quantas linhas o chunk tenta subir, no maior salto que ele pede.
   * `\x1b[A` sem número é 1 (default do CSI).
   * @returns {number} 0 se o chunk não sobe nada
   */
  function maiorSubida(data) {
    if (typeof data !== 'string') return 0;
    let max = 0, m;
    REPINTURA_NO_LUGAR.lastIndex = 0;
    while ((m = REPINTURA_NO_LUGAR.exec(data)) !== null) {
      const n = m[1] === '' ? 1 : parseInt(m[1], 10);
      if (n > max) max = n;
    }
    return max;
  }

  /** O chunk é repintura no lugar (mexe pra cima do cursor)? */
  function pedeRepinturaNoLugar(data) {
    return maiorSubida(data) > 0;
  }

  /**
   * Guarda que decide QUANDO pedir repintura completa ao agente.
   *
   * @param {object} opts
   * @param {function} opts.repintar  chamado quando o transbordo é detectado
   * @param {function} [opts.agora]   relógio injetável (testes)
   * @param {number}   [opts.janelaMs]
   */
  function criarGuardaRepintura(opts) {
    const repintar = opts && opts.repintar;
    const agora = (opts && opts.agora) || (() => Date.now());
    const janelaMs = (opts && opts.janelaMs != null) ? opts.janelaMs : JANELA_MS;
    let expiraEm = 0;
    let cauda = '';

    /** Usuário mexeu na seleção — a próxima escrita pode revelar transbordo. */
    function armar() { expiraEm = agora() + janelaMs; }

    /**
     * Chamar com a altura da tela (`rows`). O sinal é `subida >= rows`.
     *
     * O agente dimensiona o próprio frame pelo `rows` que o PTY informa — o
     * `/config` e o `/model` colapsam a lista ("↓ 38 more below") justamente
     * para caber. Enquanto cabe, ele NUNCA pede para subir mais que `rows-1`:
     * medido num PTY real, `/config` em 14 linhas pediu no máximo 13. Quando o
     * frame passa da tela (o menu do AskUserQuestion não colapsa), a subida
     * passa de `rows` — e aí `\x1b[NA` satura no topo, o remendo cai na linha
     * errada e, como o agente nunca limpa a tela, fica errado para sempre.
     *
     * Não dá para usar a posição do cursor como referência: o chunk mexe o
     * cursor por dentro, então comparar com a linha de ANTES acusa saturação
     * que não houve (15 falsos positivos em 16 teclas, medido no `/config`).
     * Rolagem de buffer também não serve: CUU/CUD não rolam a tela.
     *
     * @returns {boolean} true se pediu repintura
     */
    function aposEscrita(ev) {
      const data = cauda + (ev?.data || '');
      // PTY chunks are arbitrary: ESC, [, digits and the final A may arrive
      // separately. Keep only an incomplete cursor-control sequence.
      cauda = data.match(/\x1b(?:\[[0-9]{0,8})?$/)?.[0] || '';
      if (!expiraEm || agora() > expiraEm) return false;
      if (!ev || !(ev.rows > 0)) return false;
      if (maiorSubida(data) < ev.rows) return false;
      expiraEm = 0;               // um nudge por tecla: a repintura completa que
      try { repintar && repintar(); } catch {}  // ele provoca também sobe linhas,
      return true;                              // e sem isso viraria loop.
    }

    return { armar, aposEscrita };
  }

  /**
   * Manda o par de resizes que força o agente a repintar tudo.
   * `enviarResize(cols, rows)` é o `api.resize` já ligado ao spawn.
   */
  function cutucarResize(enviarResize, cols, rows, agendar) {
    const adiar = agendar || ((fn, ms) => setTimeout(fn, ms));
    if (typeof enviarResize !== 'function') return false;
    if (!(cols > 0) || !(rows > 2)) return false;   // pane minúsculo: deixa quieto
    enviarResize(cols, rows - 1);
    adiar(() => { try { enviarResize(cols, rows); } catch {} }, NUDGE_GAP_MS);
    return true;
  }

  return {
    JANELA_MS, NUDGE_GAP_MS,
    ehTeclaDeNavegacao, pedeRepinturaNoLugar, maiorSubida,
    criarGuardaRepintura, cutucarResize,
  };
});
