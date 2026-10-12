'use strict';

/**
 * renderer/term-replay.js — preparo do replay de buffer de PTY num xterm novo.
 *
 * ## O bug que este módulo existe para impedir
 *
 * `st.termBuffers[spawnId]` guarda os BYTES CRUS que o PTY emitiu. Bytes de TUI
 * não são texto: são posicionamento absoluto de cursor, apagar-até-fim-de-linha
 * e wrap implícito na borda direita. **Todos dependem da largura do terminal em
 * que foram gravados.**
 *
 * Quando um pane é reconstruído (troca de thread, re-layout do grid, despejo do
 * LRU em `evictHiddenXterms`), o xterm nasce e o buffer é replayado nele. Só que
 * `new Terminal({...})` sem `cols`/`rows` nasce no default do xterm.js: **80×24**.
 * Replayar 96 colunas de TUI num terminal de 80 quebra cada wrap e joga cada
 * escrita absoluta na célula errada — a tela vira um borrão de frames sobrepostos.
 *
 * E o borrão FICA. O Claude Code (Ink) nunca limpa a tela: ele repinta só o
 * retângulo do próprio frame. Então o menu de seleção seguinte é desenhado por
 * cima do lixo, que foi exatamente o print de 2026-08-25.
 *
 * A correção é sizing, não parsing: o terminal precisa estar na largura de
 * GRAVAÇÃO antes do primeiro byte do replay. Depois disso o `fit` leva pro
 * tamanho real do pane e o reflow do próprio xterm reacomoda as linhas.
 *
 * Carregado dos dois lados: `require()` nos testes e `<script>` clássico no
 * renderer (vira `window.NoryaTermReplay`), como browser/device-presets.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NoryaTermReplay = api;
})(typeof window !== 'undefined' ? window : null, function () {

  /**
   * Tamanho com que main.js sobe TODO PTY (`pty.spawn(..., { cols: 120, rows: 35 })`).
   * É o fallback certo quando ainda não houve nenhum `api.resize` para este
   * spawnId: nesse caso o PTY literalmente ainda está nessas dimensões, então o
   * buffer foi gravado nelas. 80×24 (o default do xterm.js) nunca é a resposta.
   */
  const PTY_SPAWN_COLS = 120;
  const PTY_SPAWN_ROWS = 35;

  /** Teto do buffer de renderer (threads.js). Fonte única desta constante. */
  const RENDERER_BUF_MAX = 256 * 1024;

  const inteiroPositivo = (v) => Number.isInteger(v) && v > 0;

  /**
   * Dimensões em que o buffer foi gravado. `recorded` vem de `st.termSizes[spawnId]`,
   * alimentado por setupXtermResize toda vez que manda `api.resize` pro PTY.
   */
  function replaySize(recorded) {
    const cols = recorded && inteiroPositivo(recorded.cols) ? recorded.cols : PTY_SPAWN_COLS;
    const rows = recorded && inteiroPositivo(recorded.rows) ? recorded.rows : PTY_SPAWN_ROWS;
    return { cols, rows };
  }

  /**
   * `st.termBuffers` é uma janela rolante: `cur.slice(-RENDERER_BUF_MAX)`. Esse
   * corte cai onde cair — inclusive NO MEIO de uma sequência de escape.
   *
   * Alimentar a cauda de uma sequência partida deixa o parser do xterm em estado
   * ruim; num OSC/DCS partido ele engole tudo que vier até achar um terminador
   * que não existe, e o pane fica mudo. Começar num ESC é sempre seguro: ali
   * começa uma sequência nova.
   *
   * Só mexe quando o buffer está NO teto (= foi cortado). Buffer inteiro é
   * replayado byte a byte, incluindo o texto simples do início.
   */
  function safeReplayStart(buf, max) {
    const teto = inteiroPositivo(max) ? max : RENDERER_BUF_MAX;
    if (typeof buf !== 'string' || buf.length < teto) return buf || '';
    const esc = buf.indexOf('\x1b');
    return esc <= 0 ? buf : buf.slice(esc);
  }

  /**
   * Tudo que o chamador precisa para montar o xterm: em que tamanho criá-lo e
   * que texto escrever nele. Escrever ANTES de aplicar cols/rows é o bug.
   */
  function prepareReplay(buf, recorded, max) {
    const { cols, rows } = replaySize(recorded);
    return { text: safeReplayStart(buf, max), cols, rows };
  }

  // Raw output may span many terminal sizes. Replaying it all at the LAST size
  // corrupts cursor-relative frames even when that last size is correct.
  function createHistory(size, max = RENDERER_BUF_MAX) {
    let chunks = [{ ...replaySize(size), text: '' }], length = 0, truncated = false;
    // Corte amortizado (2026-10-03): cada corte copia o buffer inteiro (256 KB),
    // e cortar a cada chunk de PTY — dezenas por segundo por pane trabalhando —
    // era cópia e GC à toa. Deixa passar 25% do teto e corta de uma vez; o
    // snapshot corta exato, então quem lê nunca vê mais que `max`.
    const folga = Math.max(1, Math.floor(max / 4));
    function cortar() {
      while (length > max) {
        const first = chunks[0], remove = Math.min(length - max, first.text.length);
        first.text = first.text.slice(remove); length -= remove; truncated = true;
        if (!first.text && chunks.length > 1) chunks.shift();
      }
    }
    return {
      resize(cols, rows) {
        const last = chunks[chunks.length - 1];
        if (last.cols === cols && last.rows === rows) return;
        if (!last.text) Object.assign(last, { cols, rows });
        else chunks.push({ cols, rows, text: '' });
      },
      write(text) {
        chunks[chunks.length - 1].text += text;
        length += text.length;
        if (length > max + folga) cortar();
      },
      snapshot() {
        cortar();
        const result = chunks.map(c => ({ ...c }));
        if (truncated) {
          // Search across chunk boundaries too (an ESC may have arrived just
          // after a resize). Never feed a dangling UTF-16 low surrogate.
          const text = result.map(c => c.text).join('');
          let skip = Math.max(0, text.indexOf('\x1b'));
          if (!skip && /^[\uDC00-\uDFFF]/.test(text)) skip = 1;
          for (const c of result) { const n = Math.min(skip, c.text.length); c.text = c.text.slice(n); skip -= n; }
        }
        return result;
      },
    };
  }

  // xterm.write is asynchronous. A synchronous resize after write() changes
  // how the not-yet-parsed bytes wrap. Keep replay, live writes and resizes in
  // one queue; disposal cancels pending work before another view takes over.
  //
  // `pace` (2026-10-03, leveza): função que devolve quantos ms segurar o
  // próximo lote de TEXTO (0 = na hora). Pane fora de foco não precisa de 60
  // quadros/s: cada lote liberado vira uma repintura da JANELA inteira no
  // compositor do macOS (pior com vidro). Resize e replay nunca esperam — eles
  // esvaziam a fila na hora, na ordem, então nenhum byte é escrito na largura
  // errada (o bug que este módulo existe para impedir).
  function createStream(term, opts) {
    const pace = opts && typeof opts.pace === 'function' ? opts.pace : null;
    let queue = [], writing = false, disposed = false, timer = null;
    function schedule() {
      if (disposed || writing || timer) return;
      const ms = pace ? pace() : 0;
      if (ms > 0) { timer = setTimeout(() => { timer = null; drain(); }, ms); return; }
      drain();
    }
    function now() { if (timer) { clearTimeout(timer); timer = null; } drain(); }
    function drain() {
      if (disposed || writing) return;
      while (queue.length) {
        const item = queue.shift();
        if (item.size) { term.resize(item.size.cols, item.size.rows); continue; }
        if (!item.text) { if (item.done) item.done(); continue; }
        writing = true;
        term.write(item.text, () => {
          writing = false;
          if (disposed) return;
          if (item.done) item.done();
          drain();
        });
        return;
      }
    }
    return {
      write(text, done) { if (!disposed) { queue.push({ text, done }); schedule(); } },
      resize(cols, rows) { if (!disposed) { queue.push({ size: { cols, rows } }); now(); } },
      replay(chunks) {
        for (const c of chunks) queue.push({ size: { cols: c.cols, rows: c.rows } }, { text: c.text });
        now();
      },
      /** Esvazia o que o `pace` estava segurando (ex.: o pane acabou de ganhar foco). */
      flush() { if (!disposed) now(); },
      dispose() { disposed = true; queue = []; if (timer) { clearTimeout(timer); timer = null; } },
    };
  }

  return {
    PTY_SPAWN_COLS, PTY_SPAWN_ROWS, RENDERER_BUF_MAX,
    replaySize, safeReplayStart, prepareReplay, createHistory, createStream,
  };
});
