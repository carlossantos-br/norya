/**
 * renderer/core.js — ipcRenderer, log viewer, perf, xterm+helpers, chat, reasoning, ANSI, branch icons.
 *
 * Script CLÁSSICO (ver renderer/state.js): fatia contígua extraída de
 * test-window.html em 2026-07-10, na ordem original. Compartilha o escopo
 * léxico global com os outros — `st`, `api`, `ipcRenderer` e as funções de
 * cada fatia enxergam-se sem import. Ordem de carga preservada = zero mudança
 * de comportamento.
 */
'use strict';

const { ipcRenderer } = require('electron');

// ── In-app log viewer (captures console + window errors so we can debug
//    without DevTools when something goes wrong in the new-thread flow) ──
const _norya_logs = [];
const _norya_log_max = 1000;
function _norya_pushLog(level, args) {
  try {
    const stamp = new Date().toLocaleTimeString();
    const parts = Array.from(args).map(a => {
      if (a == null) return String(a);
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a, null, 0).slice(0, 300); } catch { return String(a); }
    });
    _norya_logs.push(`[${stamp}] [${level}] ${parts.join(' ')}`);
    if (_norya_logs.length > _norya_log_max) _norya_logs.splice(0, _norya_logs.length - _norya_log_max);
    _norya_renderLogs();
  } catch {}
}
function _norya_renderLogs() {
  const el = document.getElementById('logsContent');
  if (!el) return;
  el.textContent = _norya_logs.join('\n');
  el.scrollTop = el.scrollHeight;
}
// Forward renderer console calls to main process so they end up in panel.log
// (lets the agent inspect them via `tail` without us having to copy/paste).
const _forwardLog = (level) => (...args) => {
  try {
    const safe = args.map(a => {
      if (a == null) return String(a);
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    });
    ipcRenderer.send('renderer-log', { level, args: safe });
  } catch {}
};
(function wrapConsole() {
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const fwdLog = _forwardLog('log');
  const fwdWarn = _forwardLog('warn');
  const fwdErr = _forwardLog('error');
  const fwdInfo = _forwardLog('info');
  // Patch console after orig is captured — call orig first, then forward
  const oldLog = console.log, oldWarn = console.warn, oldErr = console.error, oldInfo = console.info;
  console.log = (...a) => { try { oldLog.apply(console, a); } catch {}; fwdLog(...a); };
  console.warn = (...a) => { try { oldWarn.apply(console, a); } catch {}; fwdWarn(...a); };
  console.error = (...a) => { try { oldErr.apply(console, a); } catch {}; fwdErr(...a); };
  console.info = (...a) => { try { oldInfo.apply(console, a); } catch {}; fwdInfo(...a); };
  ['log','warn','error','info'].forEach(level => {
    console[level] = function(...args) {
      _norya_pushLog(level, args);
      try { orig[level].apply(console, args); } catch {}
    };
  });
})();
window.addEventListener('error', e => {
  _norya_pushLog('error', ['window.onerror:', e.message, 'at', (e.filename||'') + ':' + (e.lineno||'') + ':' + (e.colno||'')]);
});
window.addEventListener('unhandledrejection', e => {
  _norya_pushLog('error', ['unhandledrejection:', e.reason && (e.reason.stack || e.reason.message) || e.reason]);
});
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');

// ── Performance tuning constants ──────────────────────────────────────────────
// Centralized debounce / throttle values used across the renderer. Anchored
// here so the 4+ panes scenario (grid + PIP + busy sidebar) can be profiled
// and tuned without hunting magic numbers. Kept conservative — values match
// what was in-line before this refactor so behavior is identical.
const DEBOUNCE = Object.freeze({
  XTERM_FIT_DEFAULT: 80,         // scheduleFit() fallback when caller omits delay
  XTERM_FIT_RESIZE_OBS: 120,     // ResizeObserver-triggered fits
  XTERM_FIT_SHOW: 40,            // refit when a hidden pane becomes visible
  XTERM_FIT_LAYOUT_RETRY: 120,   // retry when container is still 0-sized
  XTERM_FIT_DIM_RETRY: 150,      // retry when cols/rows still below MIN
  XTERM_FIT_INITIAL: 50,         // first scheduled fit after term.open()
  PROJECT_LIST_RAF: 0,           // rAF-coalesce sidebar re-renders (0 = next frame)
});

// ── xterm.js terminal instances (one per account) ─────────────────────────────
const xtermInstances = {}; // { [num]: { term, fit, pane, resize, fitAndResize } }

// Centralized fit + PTY resize, with debounce + dedupe so SIGWINCH only fires
// when dimensions ACTUALLY changed. Guards against tiny dimensions (cell still
// in CSS-transition) which would otherwise tell the TUI cols=2 and the agent
// would render text vertically.
//   - MIN_COLS / MIN_ROWS: skip api.resize when dims look unfinished
//   - Retry the initial fit until we get sensible dimensions (or give up)
function setupXtermResize(spawnId, term, fit, container, stream) {
  let debounceTimer, retryTimer, redrawTimer, rafHandle;
  let retries = 0, disposed = false;
  const sendSize = (cols, rows, force = false) => {
    if (disposed) return;
    const old = st.termSizes[spawnId];
    if (!force && old?.cols === cols && old?.rows === rows) return;
    st.termHistory[spawnId]?.resize(cols, rows);
    st.termSizes[spawnId] = { cols, rows };
    if (stream) stream.resize(cols, rows); else term.resize(cols, rows);
    api.resize(spawnId, cols, rows);
  };
  const retry = opts => {
    // Hidden panes rely on ResizeObserver when shown, instead of waking up
    // forever every 120ms. Only one bounded initial retry chain per view.
    if (opts?.noRetry || retries++ >= 12) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => fitAndResize(opts), DEBOUNCE.XTERM_FIT_LAYOUT_RETRY);
  };
  const fitAndResize = opts => {
    if (disposed) return;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      if (disposed) return;
      if (!container?.clientWidth || !container?.clientHeight) { retry(opts); return; }
      try {
        // fit.fit() mutates the terminal BEFORE validation. A transient 2x1
        // layout used to shrink xterm while leaving the PTY at its old size.
        const size = fit.proposeDimensions();
        if (!size || !Number.isInteger(size.cols) || !Number.isInteger(size.rows)
            || size.cols < 20 || size.rows < 5) { retry(opts); return; }
        clearTimeout(retryTimer);
        clearTimeout(redrawTimer);
        redrawTimer = null;
        sendSize(size.cols, size.rows, opts?.force);
      } catch {}
    });
  };
  const scheduleFit = delay => {
    if (disposed) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fitAndResize, delay ?? DEBOUNCE.XTERM_FIT_DEFAULT);
  };
  const nudge = () => {
    if (disposed || redrawTimer) return;
    const size = st.termSizes[spawnId] || { cols: term.cols, rows: term.rows };
    if (size.rows <= 5) return;
    sendSize(size.cols, size.rows - 1);
    redrawTimer = setTimeout(() => {
      redrawTimer = null;
      sendSize(size.cols, size.rows);
    }, NoryaTuiRedraw.NUDGE_GAP_MS);
  };
  const observer = container && typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => scheduleFit(DEBOUNCE.XTERM_FIT_RESIZE_OBS)) : null;
  observer?.observe(container);
  retryTimer = setTimeout(() => fitAndResize({ force: true }), DEBOUNCE.XTERM_FIT_INITIAL);
  const cleanup = () => {
    disposed = true;
    observer?.disconnect();
    clearTimeout(debounceTimer); clearTimeout(retryTimer); clearTimeout(redrawTimer);
    if (rafHandle) cancelAnimationFrame(rafHandle);
    stream?.dispose();
  };
  return { fitAndResize, scheduleFit, cleanup, nudge };
}

function terminalReplayChunks(spawnId) {
  if (st.termHistory[spawnId]) return st.termHistory[spawnId].snapshot();
  const replay = NoryaTermReplay.prepareReplay(st.termBuffers[spawnId], st.termSizes[spawnId]);
  return [{ cols: replay.cols, rows: replay.rows, text: replay.text }];
}

// ── Xterm helpers (additive — used by both single-view and grid-cell xterms) ──
// Theme-aware background color for the host pane. Pre-painted before Terminal
// renders to avoid the white/black flash on first open with multiple panes.
function xtermHostBg() {
  // Com vidro (html[data-glass]) o pane é transparente: a tinta do body e o
  // card do pane fazem o fundo. Sem vidro, cor sólida do tema.
  if (document.documentElement.dataset.glass) return 'transparent';
  return document.documentElement.dataset.theme === 'dark' ? '#151618' : '#ffffff';
}

// ── Terminal: fonte, cursor e paleta (2026-09-07, liquid glass) ─────────────
// Norya não desenha a TUI do Claude/Codex — desenha o TERMINAL. O que dá pra
// deixar bonito é isto: fonte, entrelinha, cursor e as 16 cores ANSI que a TUI
// usa. Um só lugar alimenta os dois `new Terminal` (core.js e views.js); antes
// o tema vivia duplicado nos dois, com 4 cores só.
// SF Mono é nativa do macOS (JetBrains Mono não está instalada aqui) — fica
// primeiro na pilha; no Windows cai em Cascadia/Consolas.
const NORYA_TERM_FONT = "'SF Mono', 'JetBrains Mono', 'Cascadia Mono', ui-monospace, Menlo, Consolas, monospace";
const NORYA_TERM_PALETTE = {
  // "Norya Dusk": neutros frios, acentos saturados o bastante pra ler sobre
  // vidro escuro com wallpaper claro atrás.
  dark: {
    foreground: '#e4e6eb', cursor: '#b49cff', cursorAccent: '#0f1012',
    selectionBackground: 'rgba(124,90,240,0.34)', selectionInactiveBackground: 'rgba(124,90,240,0.18)',
    black: '#2b2d33', red: '#ff6b7a', green: '#7ee787', yellow: '#f2cc60',
    blue: '#79b8ff', magenta: '#c9a1ff', cyan: '#7fdfe8', white: '#cfd3da',
    brightBlack: '#6b7280', brightRed: '#ff8a95', brightGreen: '#9cf0a6', brightYellow: '#ffd97a',
    brightBlue: '#a0cfff', brightMagenta: '#dbbcff', brightCyan: '#a3edf3', brightWhite: '#ffffff',
  },
  // "Norya Day": paleta escura sobre vidro claro (contraste AA nos 8 básicos).
  light: {
    foreground: '#1f2328', cursor: '#7c5af0', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(124,90,240,0.22)', selectionInactiveBackground: 'rgba(124,90,240,0.12)',
    black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700',
    blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d4e00',
    brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
};
// Troca de tema AO VIVO (2026-09-07): xterm aceita term.options.theme depois
// de aberto. Antes, alternar Dark Mode deixava cada pane com o tema de quando
// nasceu (texto claro sobre vidro claro) até ser reconstruído.
function noryaRethemeTerminals() {
  const opts = noryaTermOptions();
  const apply = inst => {
    if (!inst || !inst.term) return;
    try { inst.term.options.theme = opts.theme; } catch {}
    const host = inst.pane || inst.container;
    try { if (host) host.style.backgroundColor = xtermHostBg(); } catch {}
  };
  try { Object.values(xtermInstances).forEach(apply); } catch {}
  try { Object.values(st.gridCellXterms || {}).forEach(apply); } catch {}
}
function noryaTermOptions(extra) {
  const isDark = document.documentElement.dataset.theme === 'dark';
  const glass = !!document.documentElement.dataset.glass;
  const pal = NORYA_TERM_PALETTE[isDark ? 'dark' : 'light'];
  return Object.assign({
    theme: Object.assign({ background: glass ? 'rgba(0,0,0,0)' : (isDark ? '#151618' : '#ffffff') }, pal),
    // allowTransparency só quando há vidro: com fundo sólido o xterm fica no
    // caminho rápido.
    allowTransparency: glass,
    fontFamily: NORYA_TERM_FONT,
    fontSize: 12.5,
    lineHeight: 1.4,
    letterSpacing: 0,
    fontWeight: '400',
    fontWeightBold: '600',
    // cursorBlink: false (2026-09-08, perf). O blink é uma animação CSS do
    // xterm que força o compositor a recompor a JANELA INTEIRA 2×/s — por
    // terminal. Com o grid cheio (16 panes) são 32 recomposições/s só de
    // cursor piscando, num Air M2 sem ventoinha. E não se perde nada: quem
    // marca o pane focado já é o par cursorStyle 'bar' (focado, sólido) x
    // cursorInactiveStyle 'outline' (os outros, contorno vazado). O blink
    // era informação duplicada, cobrada em bateria.
    cursorBlink: false,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'outline',
    // 3000 e não 8000 (2026-10-03, RAM): cada linha de scrollback custa
    // ~1,5 KB (colunas × 12 bytes); um pane longo de 8000 linhas eram ~12 MB, e
    // o grid cheio multiplica. O histórico completo continua no transcript da
    // própria CLI (ctrl+o no Claude, /transcript no Codex).
    scrollback: 3000,
    allowProposedApi: true,
    drawBoldTextInBrightColors: true,
    macOptionIsMeta: true,
    scrollOnUserInput: false,
  }, extra || {});
}

// Attach Cmd/Ctrl+C copy. Returns the `customKeyEventHandler` for
// xterm.attachCustomKeyEventHandler — returning false tells xterm to NOT
// forward the key to the PTY (we handled it). When there is no selection on
// copy, we fall through (return true) so apps can still receive Ctrl+C as
// SIGINT inside the TUI.
//
// COLAR NÃO PASSA POR AQUI (2026-08-13). Quem cola é o próprio xterm, pelo
// evento `paste` do DOM (Clipboard.ts: handlePasteEvent → paste →
// triggerDataEvent → nosso onData). Até hoje este handler TAMBÉM lia o
// clipboard e mandava o texto pro PTY em ⌘V, e devolver `false` no
// customKeyEventHandler não cancela nada: pra combinações com ⌘ no Mac o
// xterm sai por `return true` sem preventDefault (Keyboard.ts, ramo
// `isMac && ev.metaKey` — só ⌘A faz algo), então o evento nativo disparava
// igual. Dois caminhos vivos = todo ⌘V colava 2×.
//
// Ficou o caminho do xterm, que é o melhor dos dois: normaliza \n → \r e
// embrulha em bracketed paste quando a TUI pede — a colagem chega como UM
// bloco em vez de N linhas já enviadas.
function attachXtermClipboard(term) {
  const MULTILINE_THRESHOLD = 8; // lines that trigger paste confirm
  const handler = (e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return true;
    const key = (e.key || '').toLowerCase();
    // Copy: only intercept when there IS a selection. Otherwise let Ctrl+C
    // go through as interrupt to the PTY.
    if (key === 'c') {
      try {
        const sel = term.getSelection && term.getSelection();
        if (sel && sel.length) {
          try { navigator.clipboard.writeText(sel); } catch {}
          return false;
        }
      } catch {}
      return true;
    }
    return true;
  };
  try { term.attachCustomKeyEventHandler(handler); } catch {}

  // Guarda de colagem grande (>= 8 linhas), agora no próprio evento `paste`.
  // Em CAPTURE no elemento-pai de propósito: o xterm escuta no textarea (que
  // é filho), então cancelar aqui acontece ANTES — o texto não chega ao PTY.
  // No fluxo normal não fazemos nada e o xterm cola sozinho.
  try {
    const root = term.element;
    if (root) {
      root.addEventListener('paste', (ev) => {
        let text = '';
        try { text = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || ''; } catch {}
        const lineCount = (text.match(/\n/g) || []).length;
        if (lineCount < MULTILINE_THRESHOLD) return;
        if (window.confirm(`Paste ${lineCount + 1} lines into the terminal? Commands may run immediately.`)) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      }, true);
    }
  } catch {}
  return handler;
}

// Stagger fits across N instances so 4+ ResizeObservers/window-resize
// callbacks don't all hit requestAnimationFrame in the same frame.
function staggeredFit(instances, baseDelay) {
  const arr = Array.isArray(instances) ? instances : Object.values(instances || {});
  arr.forEach((inst, i) => {
    if (!inst || !inst.resize) return;
    try { inst.resize.scheduleFit((baseDelay || 100) + i * 25); } catch {}
  });
}

/**
 * Carimba "o usuário mandou tecla PRA ESTE PTY agora".
 *
 * Existe porque o volume de bytes que sai do PTY não distingue trabalho de eco:
 * a TUI redesenha o input box a cada tecla (medido: ~560 bytes por janela de
 * 1,5s digitando a 8 teclas/s, contra um piso de 300 em evalSpawnState()), então
 * digitar parece "agente trabalhando". Só o teclado desempata — ver o gate em
 * renderer/attention.js. Chamado de TODO caminho de entrada humana: onData do
 * xterm (pane e terminal de perfil) e colagem.
 */
function noteUserInput(id) {
  if (id == null) return;
  st.lastInputTime[id] = Date.now();
}

function getOrCreateXterm(num) {
  if (xtermInstances[num]) return xtermInstances[num];
  const host = document.getElementById('xtermHost');
  const pane = document.createElement('div');
  pane.className = 'xterm-pane';
  pane.id = 'xterm-pane-' + num;
  // Pre-paint background to match theme so the first frame doesn't flash
  // white/black before xterm renders its own canvas.
  pane.style.backgroundColor = xtermHostBg();
  host.appendChild(pane);

  const isDark = document.documentElement.dataset.theme === 'dark';
  // Nasce na largura em que o PTY está gravando, NUNCA no default 80x24 do
  // xterm.js: showOutputFor replaya st.termBuffers aqui dentro antes do
  // primeiro fit, e replay em largura errada borra a tela (term-replay.js).
  const born = NoryaTermReplay.replaySize(st.termSizes[num]);
  // Tema/fonte/cursor vêm de noryaTermOptions (um só lugar pros dois xterms).
  // scrollOnUserInput:false está lá dentro — ver o comentário gêmeo em
  // buildGridCellXterm (views.js): setas não podem arrastar o viewport pro
  // fim, senão navegar num menu de TUI mais alto que o pane esconde as opções.
  const term = new Terminal(noryaTermOptions({
    cols: born.cols,
    rows: born.rows,
    fontSize: 13,
    // smoothScrollDuration: 0 (2026-09-08, perf). Cada rolagem virava uma
    // animação de 80 ms a 60fps; com PTY cuspindo saída o viewport rola o
    // tempo todo, então isso era animação CONTÍNUA na janela inteira. O salto
    // seco não muda a leitura — o texto para no mesmo lugar.
    smoothScrollDuration: 0,
    convertEol: false,
  }));
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Busca no scrollback (Cmd+F → renderer/find.js).
  const search = new SearchAddon();
  term.loadAddon(search);
  term.open(pane);
  const stream = NoryaTermReplay.createStream(term);
  stream.replay(terminalReplayChunks(num));
  const resize = setupXtermResize(num, term, fit, pane, stream);
  // Bind keystrokes → PTY. xterm.js encodes Enter as \r, backspace, arrows,
  // Ctrl+C, etc. natively — same as the operacional panel.
  // Gêmeo do de buildGridCellXterm (views.js): menu de opções mais alto que o
  // pane satura o cursor-up do agente e trava o `❯` na linha errada. Quem
  // consome é o listener de dados em renderer/threads.js. Ver tui-redraw.js.
  const guardaRepintura = NoryaTuiRedraw.criarGuardaRepintura({
    repintar: () => {
      resize.nudge();
      try { term.scrollToBottom(); } catch {}
    },
  });
  term.onData(data => {
    noteUserInput(num);
    try { api.sendInput(num, data); } catch {}
    if (NoryaTuiRedraw.ehTeclaDeNavegacao(data)) guardaRepintura.armar();
    if (data.indexOf('\r') >= 0 || data.indexOf('\n') >= 0) { try { term.scrollToBottom(); } catch {} }
  });
  // Cmd/Ctrl+C copy on selection; colagem é do xterm (ver attachXtermClipboard).
  attachXtermClipboard(term);
  xtermInstances[num] = { term, stream, fit, search, pane, resize, guardaRepintura, _replayed: true, fitAndResize: resize.fitAndResize };
  return xtermInstances[num];
}

function showXtermFor(num) {
  document.querySelectorAll('.xterm-pane').forEach(p => p.classList.remove('active'));
  const inst = getOrCreateXterm(num);
  inst._touched = Date.now();
  inst.pane.classList.add('active');
  // Pane just became visible — re-fit so dimensions match the new visible area.
  if (inst.resize) inst.resize.scheduleFit(DEBOUNCE.XTERM_FIT_SHOW);
  // Restore focus to the xterm so keystrokes land in the right pane.
  try { setTimeout(() => { try { inst.term.focus(); } catch {} }, 60); } catch {}
  evictHiddenXterms(num);
}

// PERF (2026-07-01): cap the number of live xterm VIEWS. Each Terminal with a
// full 8000-line scrollback holds ~23MB of renderer memory (measured: 12 full
// instances = +274MB RSS), and before this cap they were only disposed on
// respawnInFolder — a day of thread-hopping left the renderer at 400MB+.
// Evicting is safe and invisible: the PTY process and st.termBuffers are
// untouched; re-opening the thread recreates the view and replays the buffer
// (showOutputFor's existing _replayed path). Keep the visible pane + the 3
// most recently viewed.
const XTERM_VIEW_LRU = 3;
function evictHiddenXterms(visibleNum) {
  const entries = Object.entries(xtermInstances)
    .filter(([id]) => id !== String(visibleNum))
    .sort((a, b) => (b[1]._touched || 0) - (a[1]._touched || 0));
  for (const [id, inst] of entries.slice(XTERM_VIEW_LRU)) {
    try { inst.resize && inst.resize.cleanup(); } catch {}
    try { inst.term.dispose(); } catch {}
    try { inst.pane.remove(); } catch {}
    delete xtermInstances[id];
    if (st._activeXtermSpawn === id) st._activeXtermSpawn = null;
  }
}

window.addEventListener('resize', () => {
  // Per-pane ResizeObserver already handles re-fits; window.resize only needs
  // to re-flow the grid layout. Schedule fits as a safety net — staggered so
  // 4+ panes don't all hit requestAnimationFrame in the same tick.
  staggeredFit(xtermInstances, DEBOUNCE.XTERM_FIT_RESIZE_OBS);
  staggeredFit(st.gridCellXterms || {}, DEBOUNCE.XTERM_FIT_RESIZE_OBS + 20);
  if (document.getElementById('app').dataset.view === 'grid') {
    // MESMA fonte de verdade do renderGrid (applyGridTemplate → roster visível).
    // A versão antiga contava TODOS os PTYs vivos — mesmo threads fora do grid
    // — e ainda passava o count sem o -1 que computeGridLayout espera (ele soma
    // +1 por dentro): 1 pane visível + sessões em background virava um template
    // 2×2 com um pane só, encolhido num quadrante.
    if (typeof applyGridTemplate === 'function') applyGridTemplate();
  }
});

function relDate(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const diff = Date.now() - d;
  if (diff < 60000)    return 'now';
  if (diff < 3600000)  return Math.round(diff / 60000) + 'm';
  if (diff < 86400000) return Math.round(diff / 3600000) + 'h';
  return Math.round(diff / 86400000) + 'd';
}

function formatDuration(ms) {
  if (ms <= 0) return 'soon';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function projectName(cwd, originUrl) {
  if (originUrl) {
    const m = originUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  }
  if (!cwd) return 'Untitled';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

// ── Branch icon helpers ───────────────────────────────────────────────────────
// agent/branches: extended to 16 muted-yet-distinct hues, intentionally OFFSET
// from PROFILE_PALETTE (which uses Material-Design saturated colors). Branch
// hues sit in the desaturated/pastel range so profile colors stay visually
// dominant when both appear in the same row.
const BRANCH_PALETTE = [
  '#e06c75','#e5c07b','#98c379','#56b6c2','#61afef','#c678dd','#d19a66','#be5046',
  '#7fb069','#c9a86b','#a78bfa','#5eead4','#fb7185','#f0abfc','#94a3b8','#fbbf24',
];
// main/master shows white in dark themes (and dark-gray in light theme via
// CSS var --text). Using --text keeps it adaptive and always visible.
const MAIN_COLOR = 'var(--text)';

// agent/branches: persisted color overrides loaded from ~/.codex-panel/branch-colors.json
// Keyed by "<projectId>::<branch>". Populated at init; absence = use hash.
const _branchColorOverrides = {};
function branchColorKey(projectId, branch) { return (projectId || '') + '::' + (branch || ''); }
function getBranchColorOverride(projectId, branch) {
  if (!projectId || !branch) return null;
  return _branchColorOverrides[branchColorKey(projectId, branch)] || null;
}

function branchColor(branch, projectId) {
  if (!branch || branch === 'main' || branch === 'master') return MAIN_COLOR;
  const ov = projectId ? getBranchColorOverride(projectId, branch) : null;
  if (ov) return ov;
  let hash = 5381;
  for (let i = 0; i < branch.length; i++) { hash = ((hash << 5) + hash) + branch.charCodeAt(i); hash |= 0; }
  return BRANCH_PALETTE[Math.abs(hash) % BRANCH_PALETTE.length];
}

// Always render the same 2-dot+line icon. Uses currentColor inside the SVG
// so CSS variables (var(--text) for main/master) resolve correctly.
function makeBranchIcon(branch) {
  const color = branchColor(branch);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '11'); svg.setAttribute('height', '11');
  svg.setAttribute('viewBox', '0 0 11 11'); svg.setAttribute('fill', 'none');
  svg.style.color = color;  // CSS var works here, attribute fill="var(...)" wouldn't
  const c1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c1.setAttribute('cx', '2.5'); c1.setAttribute('cy', '8.5'); c1.setAttribute('r', '1.8'); c1.setAttribute('fill', 'currentColor');
  const c2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c2.setAttribute('cx', '8.5'); c2.setAttribute('cy', '2.5'); c2.setAttribute('r', '1.8'); c2.setAttribute('fill', 'currentColor');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2.5 6.7V4.5A3.2 3.2 0 0 1 5.7 1.3h1.5');
  path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.3'); path.setAttribute('stroke-linecap', 'round');
  svg.append(c1, c2, path);
  return svg;
}


// Fase 6.1: cache git info per cwd (hasGit + current branch). Populated
// async after threads are loaded, so the sidebar can auto-show the
// Workspaces icon for projects that already have git, and threads can
// display their *actual* current branch (not the stale value from sqlite).
const _gitInfoByCwd = {};

async function refreshGitInfoForProjects() {
  if (!st.allThreads || !st.allThreads.length) return;
  const cwds = [...new Set(st.allThreads.map(t => t.cwd).filter(Boolean))];
  if (!cwds.length) return;
  let info;
  try { info = await api.gitStatusBulk(cwds); } catch { return; }
  if (!info) return;
  let changedKeys = false;
  let changedThreads = false;
  const enabled = new Set(getWorkspaceEnabledKeys());
  for (const cwd of cwds) {
    const r = info[cwd];
    if (!r) continue;
    _gitInfoByCwd[cwd] = r;
    // Auto-mark project as workspace-enabled if it has git
    if (r.hasGit) {
      // Find the project key for this cwd
      const proj = (st.allThreads || []).find(t => t.cwd === cwd);
      if (proj) {
        const key = proj.git_origin_url ? proj.git_origin_url.replace(/\.git$/, '') : (proj.cwd || 'unknown');
        if (!enabled.has(key)) { enabled.add(key); changedKeys = true; }
      }
    }
    // Patch stale git_branch on threads sharing this cwd
    if (r.hasGit && r.branch) {
      for (const t of st.allThreads) {
        if (t.cwd === cwd && t.git_branch !== r.branch) {
          t.git_branch = r.branch;
          changedThreads = true;
        }
      }
    }
  }
  if (changedKeys) {
    try { localStorage.setItem('norya-workspace-enabled', JSON.stringify([...enabled])); } catch {}
  }
  if (changedKeys || changedThreads) renderProjectList();
}

// Derive a stable project ID from a folder path. Used for worktree storage:
// ~/.codex-panel/worktrees/<projectId>/<slug>. Stable across runs and unique
// enough to avoid collisions between projects with the same basename.
function folderToProjectId(folder) {
  if (!folder) return 'proj';
  const base = (folder.split('/').filter(Boolean).pop() || 'proj')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'proj';
  let hash = 0;
  for (let i = 0; i < folder.length; i++) hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0;
  return base + '-' + Math.abs(hash).toString(36).slice(0, 6);
}
