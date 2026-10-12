/**
 * renderer/find.js — Cmd+F no terminal (2026-07-15).
 *
 * Busca no scrollback do pane FOCADO do grid via @xterm/addon-search (o addon
 * é anexado na criação de cada xterm — views.js/core.js guardam a instância em
 * `search`). Uma find bar única (#termFindBar) é reposicionada sobre o pane
 * focado ao abrir.
 *
 * Atalhos: Cmd/Ctrl+F abre (fora do painel do browser); Enter próximo;
 * Shift+Enter anterior; Esc fecha e devolve o foco ao terminal.
 *
 * Script clássico: usa os globais st (state.js) e o DOM do test-window.html.
 */
'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const bar = $('termFindBar');
  const input = $('tfInput');
  const count = $('tfCount');

  let current = null;   // { search, term } do pane em busca

  const DECORATIONS = {
    matchBackground: '#e6a81766',
    matchBorder: '#e6a817',
    matchOverviewRuler: '#e6a817',
    activeMatchBackground: '#e6a817cc',
    activeMatchBorder: '#e6a817',
    activeMatchColorOverviewRuler: '#e6a817',
  };

  // Instância do xterm do pane focado do grid (fallback: única viva).
  function focusedInstance() {
    const cells = st.gridCellXterms || {};
    const tid = st.gridMode && st.gridMode.focusedThreadId;
    const sid = tid && st.spawnByThread ? st.spawnByThread[tid] : null;
    if (sid && cells[sid] && cells[sid].search) return cells[sid];
    const all = Object.values(cells).filter(i => i && i.search);
    return all.length === 1 ? all[0] : null;
  }

  function positionOver(inst) {
    // Canto superior direito do container do pane (fixed → coordenadas de viewport).
    try {
      const r = inst.container.getBoundingClientRect();
      bar.style.top = Math.max(4, r.top + 6) + 'px';
      bar.style.left = Math.max(4, r.right - bar.offsetWidth - 14) + 'px';
    } catch { bar.style.top = '52px'; bar.style.right = '24px'; }
  }

  function open() {
    const inst = focusedInstance();
    if (!inst) return;                       // sem pane focado, nada a buscar
    current = inst;
    if (typeof inst.search.onDidChangeResults === 'function' && !inst.__tfWired) {
      inst.__tfWired = true;
      inst.search.onDidChangeResults(({ resultIndex, resultCount }) => {
        if (current !== inst) return;
        count.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : 'No results';
      });
    }
    bar.style.display = 'flex';
    positionOver(inst);
    input.focus();
    input.select();
    if (input.value) next();
  }

  function close() {
    bar.style.display = 'none';
    count.textContent = '';
    if (current) {
      try { current.search.clearDecorations(); } catch {}
      try { current.term.focus(); } catch {}
      current = null;
    }
  }

  function next() {
    if (!current || !input.value) { count.textContent = ''; return; }
    try { current.search.findNext(input.value, { decorations: DECORATIONS }); } catch {}
  }
  function prev() {
    if (!current || !input.value) return;
    try { current.search.findPrevious(input.value, { decorations: DECORATIONS }); } catch {}
  }

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.shiftKey ? prev() : next(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  });
  input.addEventListener('input', () => {
    // Busca incremental: reinicia do topo do viewport a cada edição.
    if (!current) return;
    try { current.search.clearDecorations(); } catch {}
    if (input.value) next(); else count.textContent = '';
  });
  $('tfNext').addEventListener('click', next);
  $('tfPrev').addEventListener('click', prev);
  $('tfClose').addEventListener('click', close);

  window.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.key !== 'f') return;
    // Dentro do painel do browser, Cmd+F não é nosso (página web pode ter o dela).
    const nb = document.getElementById('noryaBrowserPanel');
    if (nb && nb.classList.contains('open') && nb.contains(document.activeElement)) return;
    ev.preventDefault();
    open();
  });

  // Exposto pros smokes (CDP) — não é API de produto.
  window.__termFind = { open, close, next, prev, focusedInstance };
})();
