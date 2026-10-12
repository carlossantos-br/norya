/**
 * renderer/views.js — header, grid view, view-mode, nova thread, input, menus de contexto.
 *
 * Script CLÁSSICO (ver renderer/state.js): fatia contígua extraída de
 * test-window.html em 2026-07-10, na ordem original. Compartilha o escopo
 * léxico global com os outros — `st`, `api`, `ipcRenderer` e as funções de
 * cada fatia enxergam-se sem import. Ordem de carga preservada = zero mudança
 * de comportamento.
 */
'use strict';

// ── Header ────────────────────────────────────────────────────────────────────
function updateHeader() {
  const num = st.selectedAccountNum;
  const acc = st.accounts.find(a => a.num === num);
  const thread = st.allThreads.find(t => t.id === st.selectedThreadId);
  const title = document.getElementById('headerTitle');
  const sub = document.getElementById('headerSub');
  const kill = document.getElementById('btnKillTerminal');

  if (thread) {
    title.textContent = cleanThreadTitle(thread);
    sub.textContent = acc ? (acc.name || 'Account ' + acc.num) : '';
  } else if (acc) {
    title.textContent = acc.name || 'Account ' + acc.num;
    sub.textContent = '';
  } else {
    title.textContent = '';
    sub.textContent = '';
  }

  // Norya forks 2026-05-26: append lineage chips (fork-of + N-forks) right
  // after headerSub. Removed/re-added on every header update to stay in sync.
  if (typeof _renderHeaderLineageChips === 'function') {
    try { _renderHeaderLineageChips(thread); } catch (err) { console.warn('lineage chips', err); }
  }

  if (st.termRunning[num]) { kill.classList.remove('hidden'); }
  else { kill.classList.add('hidden'); }

  // Close-thread button: only meaningful while a thread is open. Returns to the
  // landing without killing the session (the thread stays in the sidebar).
  const closeBtn = document.getElementById('btnCloseThread');
  if (closeBtn) closeBtn.style.display = thread ? '' : 'none';

  // Thread folder button: visible whenever a thread/PTY is active (incl. a
  // brand-new provisional one), labeled with its working folder. Click → pick a
  // folder + respawn the thread there. Hidden in grid (panes have their own).
  const folderBtn = document.getElementById('btnThreadFolder');
  if (folderBtn) {
    const inGrid = !!(st.gridMode && st.gridMode.enabled);
    const active = !!st.selectedThreadId && !inGrid;
    folderBtn.style.display = active ? '' : 'none';
    if (active) {
      const sid = st.spawnByThread[st.selectedThreadId];
      const cwd = (thread && thread.cwd) || (sid && st.spawnCwd[sid]) || null;
      const lbl = document.getElementById('threadFolderLabel');
      if (lbl) lbl.textContent = _threadFolderLabel(cwd);
    }
  }
}

// Short label for the header folder button: "Home" for the home dir, else the
// folder's basename (keeps the header compact).
function _threadFolderLabel(cwd) {
  if (!cwd) return 'folder';
  let home = '';
  try { home = require('os').homedir(); } catch {}
  if (home && cwd === home) return 'Home';
  const base = String(cwd).split(/[\\/]/).filter(Boolean).pop();
  return base || cwd;
}

// Render lineage chips next to the header sub-title. Kept idempotent: any
// previously-rendered chips are removed before re-rendering.
function _renderHeaderLineageChips(thread) {
  const headerLeft = document.querySelector('.main-header .header-left');
  if (!headerLeft) return;
  // Remove stale chips
  headerLeft.querySelectorAll('.fork-lineage-chip, .fork-children-chip').forEach(el => el.remove());
  if (!thread || !window._forkLineage) return;
  const lineage = window._forkLineage.byChild[thread.id];
  const children = window._forkLineage.byParent[thread.id] || [];

  if (lineage && lineage.parentId) {
    const chip = document.createElement('span');
    chip.className = 'fork-lineage-chip';
    chip.title = 'Forked from "' + (lineage.parentTitle || '(no title)') + '" — click to open';
    const arrow = document.createElement('span');
    arrow.className = 'lineage-arrow';
    arrow.textContent = '↳';
    const lbl = document.createElement('span');
    lbl.textContent = 'fork de ' + ((lineage.parentTitle || 'origem').slice(0, 28));
    chip.appendChild(arrow);
    chip.appendChild(lbl);
    chip.addEventListener('click', () => {
      const parentThread = (st.allThreads || []).find(t => t.id === lineage.parentId);
      if (parentThread && typeof onThreadClick === 'function') {
        onThreadClick(parentThread);
      } else {
        showForkToast({ kind: 'warn', title: 'Source not found',
          msg: 'The original task is no longer in the list (deleted?).', duration: 3500 });
      }
    });
    headerLeft.appendChild(chip);
  }

  if (children.length) {
    const chip = document.createElement('span');
    chip.className = 'fork-children-chip';
    chip.title = children.length + ' fork(s) active — click to list';
    const arrow = document.createElement('span');
    arrow.textContent = '↗';
    arrow.className = 'lineage-arrow';
    const lbl = document.createElement('span');
    lbl.textContent = children.length + ' fork' + (children.length > 1 ? 's' : '');
    chip.appendChild(arrow);
    chip.appendChild(lbl);
    chip.addEventListener('click', e => _openForkChildrenPopover(e.currentTarget, children));
    headerLeft.appendChild(chip);
  }
}

let _forkChildrenPopEl = null;
function _closeForkChildrenPopover() {
  if (_forkChildrenPopEl && _forkChildrenPopEl.parentNode) {
    _forkChildrenPopEl.parentNode.removeChild(_forkChildrenPopEl);
  }
  _forkChildrenPopEl = null;
  document.removeEventListener('click', _onForkChildrenPopOutside, true);
}
function _onForkChildrenPopOutside(e) {
  if (!_forkChildrenPopEl) return;
  if (!_forkChildrenPopEl.contains(e.target)) _closeForkChildrenPopover();
}
function _openForkChildrenPopover(anchor, children) {
  _closeForkChildrenPopover();
  const pop = document.createElement('div');
  pop.className = 'fork-children-pop';
  const title = document.createElement('div');
  title.className = 'fork-children-pop-title';
  title.textContent = 'Active forks';
  pop.appendChild(title);
  for (const child of children) {
    const childThread = (st.allThreads || []).find(t => t.id === child.childId);
    const item = document.createElement('div');
    item.className = 'fork-children-pop-item';
    const titleEl = document.createElement('span');
    titleEl.textContent = (childThread && (childThread.title || childThread.first_user_message)) || child.slug || child.childId.slice(0, 8);
    const branchEl = document.createElement('span');
    branchEl.className = 'child-branch';
    branchEl.textContent = child.branch || '';
    item.appendChild(titleEl);
    if (child.branch) item.appendChild(branchEl);
    item.addEventListener('click', () => {
      _closeForkChildrenPopover();
      if (childThread) {
        if (typeof onThreadClick === 'function') onThreadClick(childThread);
      } else {
        showForkToast({ kind: 'warn', title: 'Fork is not in the list',
          msg: 'It may have been deleted or not yet synced.', duration: 3500 });
      }
    });
    pop.appendChild(item);
  }
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, rect.left) + 'px';
  pop.style.top = (rect.bottom + 6) + 'px';
  _forkChildrenPopEl = pop;
  // Defer outside-click binding so the click that opened us doesn't close.
  setTimeout(() => document.addEventListener('click', _onForkChildrenPopOutside, true), 10);
}

function updateInputState() {
  const field = document.getElementById('inputField');
  const sendBtn = document.getElementById('sendBtn');
  const killBtn = document.getElementById('inputKillBtn');
  const spawnId = st.selectedThreadId && st.spawnByThread[st.selectedThreadId];
  const running = !!(spawnId && st.termRunning[spawnId]);
  // Fase 2: require active profile to send anything
  const noProfile = st.activeProfileNum == null;
  // Gap 2: block sends when active profile != thread owner (consult mode)
  const consult = (typeof isConsultMode === 'function') && isConsultMode();
  field.disabled = !running || noProfile || consult;
  if (noProfile) {
    field.placeholder = 'Select an active profile (bottom-left)';
  } else if (consult) {
    field.placeholder = 'Consult mode — click "Act as ..." in the banner to enable sending';
  } else {
    field.placeholder = running ? 'Send a message or command…' : 'Open or start a task to send input…';
  }
  sendBtn.disabled = !running || !field.value.trim() || noProfile || consult;
  // Stop button: visible whenever a PTY is running for the selected thread
  if (running) killBtn.classList.remove('hidden');
  else killBtn.classList.add('hidden');
  if (running) field.placeholder = 'Agent working — type to queue or click Stop to interrupt';
  // Fase 7: keep fork button state in sync (depends on workspace + working state)
  if (typeof updateForkButtonState === 'function') updateForkButtonState();
  // Fase 8: same for merge button
  if (typeof updateMergeButtonState === 'function') updateMergeButtonState();
  // Gap 2: render/clear consult banner
  if (typeof renderConsultBanner === 'function') renderConsultBanner();
  // Gap 3+4: refresh thread toolbar widgets (branch readonly + profile pill)
  if (typeof updateThreadToolbarWidgets === 'function') updateThreadToolbarWidgets();
  // Hide the input bar on the landing/empty state, show it inside a session.
  if (typeof syncInputAreaVisibility === 'function') syncInputAreaVisibility();
}

// ── Grid view ─────────────────────────────────────────────────────────────────

// Layout do grid (2026-10-04): NUNCA sobra célula vazia. Os panes são
// distribuídos em linhas (as maiores em cima: 5 = 3+2, 7 = 3+2+2) e cada linha
// divide a largura inteira entre os seus panes. Prefere o MENOR número de
// linhas em que todo pane ainda tem largura e altura legíveis — 3 panes numa
// tela comum viram 3 colunas, 4 viram 2×2. Se nenhuma divisão respeita os
// mínimos (muitos panes, janela pequena), fica a mais equilibrada.
// O CSS grid recebe MMC(tamanhos das linhas) colunas e cada célula ocupa
// `span` delas (ver applyGridTemplate).
const GRID_MAX_PANES = 64;
const GRID_MIN_CELL_W = 360;
const GRID_MIN_CELL_H = 240;
function computeGridLayout(countMinusOne, areaW, areaH, gap = 8) {
  const n = Math.max(1, (countMinusOne | 0) + 1);
  const W = Math.max(1, areaW || 1), H = Math.max(1, areaH || 1);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let best = null;
  for (let r = 1; r <= n; r++) {
    const base = Math.floor(n / r), extra = n % r;
    const rowSizes = Array.from({ length: r }, (_, i) => base + (i < extra ? 1 : 0));
    const perRow = rowSizes[0];
    const cellW = (W - (perRow - 1) * gap) / perRow;
    const cellH = (H - (r - 1) * gap) / r;
    const fit = Math.min(cellW / GRID_MIN_CELL_W, cellH / GRID_MIN_CELL_H);
    const cand = { rowSizes, fit };
    if (fit >= 1) { best = cand; break; }          // menos linhas que cabe = melhor
    if (!best || fit > best.fit) best = cand;
  }
  const rowSizes = best.rowSizes;
  const cols = rowSizes.reduce((l, k) => l * k / gcd(l, k), 1);
  return { cols, rows: rowSizes.length, rowSizes };
}

// Roster VISÍVEL do grid — fonte única, usada por renderGrid E pelo handler de
// window.resize (core.js). Antes cada um computava a sua lista: o resize contava
// TODOS os PTYs vivos (mesmo fora do grid, e com off-by-one), então 1 pane
// visível + 3 sessões em background virava um grid 2×2 com um pane só num
// quadrante. Vazio = vazio MESMO: o fallback antigo que re-populava com
// qualquer PTY vivo fazia o último pane "voltar" logo depois de fechado.
function computeVisibleGridIds() {
  const ids = (st.gridMode && st.gridMode.enabled && Array.isArray(st.gridMode.threadIds))
    ? st.gridMode.threadIds.slice() : [];
  // Keep IDs that EITHER have a thread record OR are provisional spawns
  // (where the threadId === spawnId and the PTY is still running).
  // Ou ainda: id real com processo vivo que o list-threads ainda não trouxe — o
  // chat faz o latch pelo protocolo, antes de a sessão aparecer no banco.
  return ids.filter(tid =>
    (st.allThreads || []).some(t => t.id === tid)
    || (st.spawnByThread[tid] === tid && st.termRunning[tid])
    || (st.spawnByThread[tid] && st.termRunning[st.spawnByThread[tid]]));
}

// Fonte ÚNICA do template de colunas/linhas do grid — chamada pelo renderGrid,
// pelo window.resize (core.js) e pelo ResizeObserver da própria área (abaixo).
// Os panes escalam sozinhos via `fr`, mas a DECISÃO de transpor cols/rows
// depende da proporção da área — e a área muda sem window.resize (colapso da
// sidebar, painel do browser abrindo…).
function applyGridTemplate(idsOpt) {
  const area = document.getElementById('gridArea');
  if (!area) return;
  const ids = idsOpt || computeVisibleGridIds();
  if (!ids.length) return;
  const rect = area.getBoundingClientRect();
  const cs = getComputedStyle(area);
  const gap = parseFloat(cs.columnGap) || 0;
  const w = (rect.width || 800) - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const h = (rect.height || 600) - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  const { cols, rows, rowSizes } = computeGridLayout(ids.length - 1, w, h, gap);
  area.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  area.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  // Cada célula ocupa cols/k colunas, k = panes da linha dela (ordem do DOM).
  const spans = rowSizes.flatMap(k => Array(k).fill(cols / k));
  area.querySelectorAll(':scope > .grid-cell').forEach((cell, i) => {
    const v = spans[i] > 1 ? `span ${spans[i]}` : '';
    if (cell.style.gridColumn !== v) cell.style.gridColumn = v;
  });
}

// Re-decide o template + re-fita os xterms quando a ÁREA do grid muda de
// tamanho por qualquer motivo (não só window.resize). Debounced 120ms; o
// fitAndResize já dedupa (SIGWINCH só quando cols/rows mudam de fato).
(function bindGridAreaResize() {
  const area = document.getElementById('gridArea');
  if (!area || typeof ResizeObserver === 'undefined') return;
  let timer = null;
  const obs = new ResizeObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (document.getElementById('app').dataset.view !== 'grid') return;
      applyGridTemplate();
      if (typeof staggeredFit === 'function') staggeredFit(st.gridCellXterms || {}, 60);
    }, 120);
  });
  obs.observe(area);
})();

// Atualiza no lugar as partes mutáveis do header de uma célula reutilizada
// (título pós-latch, dot de estado, datasets). Nunca toca no corpo/xterm.
function refreshGridCellHeader(cell, thread, spawnId) {
  cell.dataset.thread = thread.id;
  if (spawnId) cell.dataset.spawn = spawnId; else delete cell.dataset.spawn;
  const t = cell.querySelector('.grid-cell-title');
  if (t) {
    const s = cleanThreadTitle(thread);
    if (t.textContent !== s) t.textContent = s;
  }
  const dot = cell.querySelector('.grid-cell-dot');
  if (dot) {
    const live = !!(spawnId && st.termRunning[spawnId]);
    if (!live) dot.dataset.state = 'idle';
    else if (dot.dataset.state === 'idle') dot.dataset.state = 'active';
    // 'working'/'active' em pane vivo: deixados como estão (evalSpawnState manda).
  }
  const body = cell.querySelector('.grid-cell-body');
  if (body) body.id = `gridBody-${thread.id}`;
}

function renderGrid() {
  const area = document.getElementById('gridArea');
  if (!area) return;
  // A sidebar lista os panes abertos: acompanha o grid (rAF, roda depois daqui).
  if (typeof renderProjectList === 'function') renderProjectList();

  // Roster explícito do usuário (ver computeVisibleGridIds).
  const ids = computeVisibleGridIds();

  if (!ids.length) {
    disposeAllGridCellXterms();
    while (area.firstChild) area.removeChild(area.firstChild);
    const empty = document.createElement('div');
    empty.className = 'grid-empty';
    const t = document.createElement('div'); t.className = 'grid-empty-title';
    t.textContent = 'Norya Grid empty';
    const s = document.createElement('div'); s.className = 'grid-empty-sub';
    s.textContent = kc('Crie uma sessão nova com ⌘N.');
    empty.append(t, s);
    area.appendChild(empty);
    area.style.gridTemplateColumns = '1fr';
    area.style.gridTemplateRows = '1fr';
    area.classList.remove('has-max');
    st.gridMode.maximizedThreadId = null;
    st.gridMode.focusedThreadId = null;
    // Grid vazio = landing por cima (New Thread). O placeholder fica atrás
    // como fundo neutro; a landing é quem guia o próximo passo. Só com contas:
    // sem elas, showNewThreadPanel abriria o modal de "adicionar conta" sozinho.
    if (st.accounts && st.accounts.length && typeof showNewThreadPanel === 'function') {
      showNewThreadPanel();
    }
    return;
  }

  // ── Render incremental (2026-07-21) ──────────────────────────────────────
  // O renderGrid antigo era destrutivo: dispose de TODOS os xterms + rebuild
  // do DOM inteiro a cada chamada — e ele roda em todo exit de PTY (mesmo de
  // background), latch, clique de thread, remoção… O replay do buffer ANSI
  // truncado reposicionava o texto visível ("letras dançando") e piscava todos
  // os panes. Agora cada célula só é reconstruída quando seu par
  // (threadId, spawnId) muda; as demais são atualizadas/reordenadas no lugar —
  // mover um nó DOM preserva o xterm vivo, sem dispose nem replay.
  const prevEmpty = area.querySelector(':scope > .grid-empty');
  if (prevEmpty) prevEmpty.remove();

  const byThread = new Map();
  const bySpawn = new Map();
  area.querySelectorAll(':scope > .grid-cell').forEach(cell => {
    byThread.set(cell.dataset.thread, cell);
    if (cell.dataset.spawn) bySpawn.set(cell.dataset.spawn, cell);
  });

  const kept = new Set();
  const orderedCells = ids.map(threadId => {
    let thread = st.allThreads.find(t => t.id === threadId);
    // Resolve to a LIVE spawn only: a thread whose PTY died keeps its
    // st.spawnByThread mapping (onExit flips termRunning=false but doesn't
    // delete it), so a stale spawnId would mount an empty/dead xterm instead of
    // the "Thread idle — click to reopen" placeholder. Normalize at the source
    // so every downstream consumer (dataset.spawn, stateDot, body mount) agrees.
    let spawnId = st.spawnByThread[threadId];
    if (spawnId && !st.termRunning[spawnId]) spawnId = null;
    if (!thread) {
      // Provisional pseudo-thread for spawns without a DB row yet
      const accNum = spawnId != null ? st.spawnAccount[spawnId] : null;
      thread = {
        id: threadId,
        // Chat: o 1º prompt já é um título melhor que "(new task)".
        title: (spawnId != null && NoryaChat.firstPrompt(spawnId)) || '(new task)',
        cwd: spawnId != null ? (st.spawnCwd[spawnId] || '') : '',
        accountNum: accNum,
        first_user_message: '',
        updated_at_ms: Date.now(),
        __provisional: true,
      };
    }
    // Reuso: mesma thread, OU mesmo spawn vivo (latch acabou de re-chavear o
    // id provisório → real; os handlers da célula leem cell.dataset na hora do
    // clique, então basta atualizar o header no lugar).
    let cell = byThread.get(threadId) || (spawnId ? bySpawn.get(spawnId) : null);
    if (cell && kept.has(cell)) cell = null; // já reivindicada por outro id
    // TUI ↔ chat no MESMO spawn também reconstrói o corpo.
    const ui = spawnId ? (st.spawnUi[spawnId] || 'tui') : 'tui';
    if (cell && (cell.dataset.spawn || '') === (spawnId || '') && (cell.dataset.ui || 'tui') === ui) {
      refreshGridCellHeader(cell, thread, spawnId);
      kept.add(cell);
      return cell;
    }
    // Rebuild: célula nova, ou o spawn desta thread mudou (morreu/renasceu).
    if (cell) {
      const oldSpawn = cell.dataset.spawn;
      if (oldSpawn) disposeGridCellXterm(oldSpawn);
      cell.remove();
    }
    const acc = st.accounts.find(a => a.num === thread.accountNum);
    const fresh = buildGridCell(thread, acc, spawnId);
    kept.add(fresh);
    return fresh;
  });

  // Remove células que saíram do roster (dispose só dos xterms delas).
  area.querySelectorAll(':scope > .grid-cell').forEach(cell => {
    if (kept.has(cell)) return;
    if (cell.dataset.spawn) disposeGridCellXterm(cell.dataset.spawn);
    cell.remove();
  });

  // Reordena/insere só quando a ordem atual difere — appendChild de um nó já
  // posicionado o move (remove+insere), o que roubaria o foco do xterm à toa.
  const currentOrder = Array.from(area.querySelectorAll(':scope > .grid-cell'));
  const orderChanged = orderedCells.length !== currentOrder.length
    || orderedCells.some((c, i) => currentOrder[i] !== c);
  if (orderChanged) orderedCells.forEach(c => area.appendChild(c));

  // Layout depois da ordem final: o `span` de cada célula depende da posição.
  applyGridTemplate(ids);

  // Re-apply focus / maximize state from st.gridMode after the DOM settles.
  // If the focused/maximized thread is no longer present, clear those fields.
  const presentIds = new Set(ids);
  if (st.gridMode.focusedThreadId && !presentIds.has(st.gridMode.focusedThreadId)) {
    st.gridMode.focusedThreadId = null;
  }
  if (st.gridMode.maximizedThreadId && !presentIds.has(st.gridMode.maximizedThreadId)) {
    st.gridMode.maximizedThreadId = null;
  }
  // Auto-focus first pane if nothing is focused (so ⌘Enter always has a target).
  if (!st.gridMode.focusedThreadId && ids.length) {
    st.gridMode.focusedThreadId = ids[0];
  }
  area.querySelectorAll(':scope > .grid-cell').forEach(cell => {
    cell.classList.toggle('gc-focused', cell.dataset.thread === st.gridMode.focusedThreadId);
    cell.classList.toggle('gc-maximized', cell.dataset.thread === st.gridMode.maximizedThreadId);
  });
  area.classList.toggle('has-max', !!st.gridMode.maximizedThreadId);

  // After the grid lays out, ask every per-cell xterm to refit to its new size.
  // RAF + a short delay lets CSS grid finalize cell dimensions before fit runs.
  // fitAndResize dedupa (só manda SIGWINCH quando cols/rows mudam de fato).
  requestAnimationFrame(() => {
    setTimeout(() => {
      Object.values(st.gridCellXterms || {}).forEach(inst => {
        try { inst.resize && inst.resize.fitAndResize({ force: true }); } catch {}
      });
    }, 60);
  });
}

function _svgIcon(viewBox, paths, opts) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', viewBox); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', (opts && opts.strokeWidth) || '1.5');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function buildGridCell(thread, acc, spawnId) {
  const cell = document.createElement('div');
  // .selected is a SINGLE-view concept (sticky sidebar selection). In grid the
  // only indicator is .gc-focused (focusedThreadId) — never stamp .selected here,
  // or an unrelated pane (st.selectedThreadId pinned to single view) gets a 2nd
  // purple ring on every render.
  cell.className = 'grid-cell' + ((!(st.gridMode && st.gridMode.enabled) && thread.id === st.selectedThreadId) ? ' selected' : '');
  cell.dataset.thread = thread.id;
  if (spawnId) cell.dataset.spawn = spawnId;
  cell.dataset.ui = spawnId ? (st.spawnUi[spawnId] || 'tui') : 'tui';
  cell.draggable = true;
  // Handlers leem o id/spawn ATUAIS do dataset na hora do evento — o render
  // incremental reutiliza a célula quando o latch troca o id provisório pelo
  // real, e uma closure sobre `thread.id`/`spawnId` congelados apontaria pro
  // id morto (foco, fechar, maximizar… tudo viraria no-op silencioso).
  const liveId = () => cell.dataset.thread;
  const liveSpawn = () => cell.dataset.spawn || null;
  const liveThread = () => (st.allThreads || []).find(t => t.id === cell.dataset.thread) || thread;
  const ownerNum = getThreadEffectiveOwner(thread);
  const ownerAcc = ownerNum != null ? st.accounts.find(a => a.num === ownerNum) : acc;

  // ── Header: owner dot + title + branch chip + status dot + fork + close ──
  const header = document.createElement('div');
  header.className = 'grid-cell-header';

  const ownerDot = document.createElement('span');
  ownerDot.className = 'grid-cell-owner-dot';
  if (ownerAcc && ownerAcc.color) {
    ownerDot.style.background = ownerAcc.color;
    ownerDot.title = (ownerAcc.name || 'Profile ' + ownerAcc.num) + ' — click to switch owner';
  } else {
    ownerDot.style.background = 'transparent';
    ownerDot.style.border = '1.5px dashed var(--text-faint)';
    ownerDot.title = 'No owner — send a message to assign one';
  }
  ownerDot.addEventListener('click', e => {
    e.stopPropagation();
    if (typeof openOwnerPicker === 'function') openOwnerPicker(liveThread(), ownerDot);
  });

  const titleEl = document.createElement('span');
  titleEl.className = 'grid-cell-title';
  titleEl.textContent = cleanThreadTitle(thread);

  // Branch chip only if cwd has git
  const _gitForCell = thread.cwd ? _gitInfoByCwd[thread.cwd] : null;
  const branch = (_gitForCell && _gitForCell.hasGit)
    ? (thread.git_branch || _gitForCell.branch)
    : null;
  let branchChip = null;
  if (branch) {
    branchChip = document.createElement('span');
    branchChip.className = 'grid-cell-branch';
    branchChip.style.color = (typeof branchColor === 'function') ? branchColor(branch) : 'var(--accent)';
    branchChip.textContent = branch;
    branchChip.title = 'This task branch (use Fork for another)';
  }

  const stateDot = document.createElement('span');
  stateDot.className = 'grid-cell-dot';
  stateDot.dataset.state = spawnId && st.termRunning[spawnId] ? 'active' : 'idle';

  const forkBtn = document.createElement('button');
  forkBtn.className = 'grid-cell-iconbtn';
  forkBtn.title = 'Fork this task (creates a new worktree)';
  forkBtn.appendChild(_svgIcon('0 0 16 16', ['M4 4.5v7', 'M4 7c0-1 0.5-2 2-2h3'], { strokeWidth: '1.6' }));
  const fc1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  fc1.setAttribute('cx', '4'); fc1.setAttribute('cy', '3'); fc1.setAttribute('r', '1.6');
  fc1.setAttribute('fill', 'currentColor');
  const fc2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  fc2.setAttribute('cx', '4'); fc2.setAttribute('cy', '13'); fc2.setAttribute('r', '1.6');
  fc2.setAttribute('fill', 'currentColor');
  const fc3 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  fc3.setAttribute('cx', '12'); fc3.setAttribute('cy', '6'); fc3.setAttribute('r', '1.6');
  fc3.setAttribute('fill', 'currentColor');
  forkBtn.firstChild.append(fc1, fc2, fc3);
  forkBtn.addEventListener('click', e => { e.stopPropagation(); forkThreadByObject(liveThread()); });

  const folderBtn = document.createElement('button');
  folderBtn.className = 'grid-cell-iconbtn';
  folderBtn.title = 'Change folder — restarts this pane in the new cwd';
  folderBtn.appendChild(_svgIcon('0 0 16 16',
    ['M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z'],
    { strokeWidth: '1.5' }));
  folderBtn.addEventListener('click', async e => {
    e.stopPropagation();
    const folder = await api.pickFolder().catch(() => null);
    if (!folder) return;
    try { await respawnGridCellInFolder(liveThread(), liveSpawn(), folder); }
    catch (err) { console.error('respawnGridCellInFolder', err); alert('Failed: ' + (err && err.message || err)); }
  });

  // × ENCERRA a task (2026-09-09). Até aqui ele só tirava o pane do grid e
  // deixava o PTY vivo em segundo plano (contrato de 2026-07-21) — o Carlos
  // clicava em fechar e a sessão não encerrava, invisível e ainda consumindo
  // quota. Fechar com o PTY vivo virou o gesto RARO: ⌥+clique.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'grid-cell-iconbtn';
  closeBtn.title = 'End task (⌥-click: just hide the pane, session keeps running)';
  closeBtn.appendChild(_svgIcon('0 0 16 16', ['M3 3l10 10', 'M13 3L3 13']));
  closeBtn.addEventListener('click', e => {
    e.stopPropagation();
    const id = liveId();
    if (e.altKey) {
      if (typeof removeThreadFromGrid === 'function') removeThreadFromGrid(id);
      return;
    }
    const sid = liveSpawn();
    if (sid && st.termRunning[sid] && typeof killTerminalForSpawn === 'function') {
      // Libera os buffers quando o PTY confirmar a saída (onExit lê a cauda).
      st.releaseOnExit[sid] = true;
      killTerminalForSpawn(sid);
    } else if (sid && typeof releaseSpawnBuffers === 'function') {
      releaseSpawnBuffers(sid); // já tinha saído: nada mais vai escrever neles
    }
    if (typeof removeThreadFromGrid === 'function') removeThreadFromGrid(id);
  });

  // Maximizar visível (2026-07-10) — grid é a única view; focar = maximizar.
  const maxBtn = document.createElement('button');
  maxBtn.className = 'grid-cell-iconbtn grid-cell-max';
  const _isMax = st.gridMode.maximizedThreadId === thread.id;
  maxBtn.title = kc(_isMax ? 'Restaurar (⌘G)' : 'Maximizar (⌘G)');
  maxBtn.appendChild(_svgIcon('0 0 16 16', _isMax
    ? ['M6.5 2v4.5H2', 'M9.5 14V9.5H14', 'M2 9.5h4.5V14', 'M14 6.5H9.5V2']
    : ['M9.5 2H14v4.5', 'M14 2L9.5 6.5', 'M6.5 14H2V9.5', 'M2 14l4.5-4.5']));
  maxBtn.addEventListener('click', e => { e.stopPropagation(); toggleGridMaximize(liveId()); });

  // Three-dot kebab menu — Maximize / Detach to PIP / Copy thread ID / Remove
  const kebabBtn = document.createElement('button');
  kebabBtn.className = 'grid-cell-iconbtn grid-cell-kebab';
  kebabBtn.title = 'More actions for this pane';
  kebabBtn.appendChild(_svgIcon('0 0 16 16', ['M3 8h.01', 'M8 8h.01', 'M13 8h.01'], { strokeWidth: '2.4' }));
  kebabBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (typeof openGridCellMenu === 'function') openGridCellMenu(liveThread(), liveSpawn(), kebabBtn);
  });

  header.append(ownerDot, titleEl);
  if (branchChip) header.appendChild(branchChip);
  header.append(stateDot, folderBtn, forkBtn, maxBtn, kebabBtn, closeBtn);

  // ── Body: xterm (operacional-panel style) ──
  const body = document.createElement('div');
  body.className = 'grid-cell-body grid-cell-xterm';
  body.id = `gridBody-${thread.id}`;
  body.style.cssText = 'flex:1;min-height:0;position:relative;overflow:hidden;padding:8px 10px 2px;';

  if (spawnId && st.spawnUi[spawnId] === 'chat') {
    // Pane em chat: a conversa desenhada (renderer/chat.js), sem xterm.
    body.className = 'grid-cell-body grid-cell-chat';
    body.style.cssText = '';
    NoryaChat.mount(spawnId, body);
  } else if (spawnId) {
    // Live PTY — mount an xterm view, replay buffer, subscribe to data.
    buildGridCellXterm(spawnId, body);
  } else {
    // Idle thread: placeholder + click to resume (spawn PTY using owner profile).
    const placeholder = document.createElement('div');
    placeholder.className = 'gc-placeholder';
    placeholder.style.cssText = 'color:var(--text-faint);font-size: 12px;display:flex;align-items:center;justify-content:center;height:100%;cursor:pointer;text-align:center;padding:12px;';
    placeholder.textContent = 'Task idle — click to reopen';
    placeholder.addEventListener('click', e => {
      e.stopPropagation();
      if (gridSpawnThread(liveThread())) renderGrid();
    });
    body.appendChild(placeholder);
  }

  // Click anywhere on the pane (including the xterm body) focuses it visually
  // and marks it as last-interacted. Excluded: header iconbtns, input, owner-dot,
  // since those have their own click handlers.
  // Use mousedown (capture) so it fires before xterm steals focus.
  const focusOnInteract = e => {
    if (e.target.closest('.grid-cell-input') ||
        e.target.closest('.grid-cell-iconbtn') ||
        e.target.closest('.grid-cell-owner-dot') ||
        e.target.closest('.ctx-menu')) return;
    if (typeof setGridFocus === 'function') setGridFocus(liveId());
    noteThreadInteraction(liveId());
  };
  cell.addEventListener('mousedown', focusOnInteract, true);
  cell.addEventListener('click', e => {
    if (e.target.closest('.grid-cell-input') ||
        e.target.closest('.grid-cell-iconbtn') ||
        e.target.closest('.grid-cell-owner-dot')) return;
    // Visual focus ring is driven by the capture-phase mousedown -> setGridFocus.
    // Here we just put keystroke focus in this cell's xterm.
    try {
      const sid = liveSpawn();
      if (sid && st.spawnUi[sid] === 'chat') {
        // Clique em texto da conversa não rouba a seleção (chat.js foca no mouseup).
        if (!e.target.closest('.cm-root')) NoryaChat.focus(sid);
        return;
      }
      const inst = sid && st.gridCellXterms && st.gridCellXterms[sid];
      if (inst && inst.term) setTimeout(() => { try { inst.term.focus(); } catch {} }, 30);
    } catch {}
  });
  // Double-click on header (not buttons) toggles maximize.
  header.addEventListener('dblclick', e => {
    if (e.target.closest('.grid-cell-iconbtn') ||
        e.target.closest('.grid-cell-owner-dot')) return;
    if (typeof toggleGridMaximize === 'function') toggleGridMaximize(liveId());
  });

  // Drag & drop (Chunk D — reorder)
  cell.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-grid-thread', liveId());
    cell.classList.add('dragging');
  });
  cell.addEventListener('dragend', () => {
    cell.classList.remove('dragging');
    document.querySelectorAll('.grid-cell.drop-target').forEach(c => c.classList.remove('drop-target'));
  });
  cell.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-grid-thread')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cell.classList.add('drop-target');
  });
  cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
  cell.addEventListener('drop', e => {
    e.preventDefault();
    cell.classList.remove('drop-target');
    const src = e.dataTransfer.getData('text/x-grid-thread');
    if (!src || src === liveId()) return;
    const ids = st.gridMode.threadIds;
    const from = ids.indexOf(src);
    const to = ids.indexOf(liveId());
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, src);
    saveGridStateToStorage();
    renderGrid();
  });

  cell.append(header, body);
  return cell;
}

// ── Ritmo de repintura dos panes (2026-10-03, leveza) ──────────────────────
// Só o pane em que você está (focado no grid, com o cursor nele ou recém
// digitado) desenha em tempo real. Os outros juntam a saída e desenham a 4
// quadros/s, TODOS no mesmo instante (relógio alinhado em 250 ms): o macOS
// recompõe a janela uma vez por lote em vez de uma vez por pane por quadro.
// É isso que torna o vidro barato — o custo dele é por repintura.
// Com o Norya fora de foco (você no Chrome/Figma), todo pane fica no ritmo.
const NORYA_PACE_MS = 250;
function noryaPaneAoVivo(spawnId, term) {
  if (!document.hasFocus()) return false;
  if (term && term.textarea && document.activeElement === term.textarea) return true;
  if (Date.now() - (st.lastInputTime[spawnId] || 0) < 1500) return true;
  const tid = st.gridMode && st.gridMode.focusedThreadId;
  return !!tid && (tid === spawnId || st.spawnByThread[tid] === spawnId);
}
function noryaPace(spawnId, term) {
  if (noryaPaneAoVivo(spawnId, term)) return 0;
  return NORYA_PACE_MS - (Date.now() % NORYA_PACE_MS);
}
function noryaFlushPane(spawnId) {
  const inst = st.gridCellXterms && st.gridCellXterms[spawnId];
  if (inst && inst.stream && inst.stream.flush) inst.stream.flush();
}
window.addEventListener('focus', () => {
  Object.keys(st.gridCellXterms || {}).forEach(noryaFlushPane);
});

// Per-cell xterm: mounts an independent xterm.js instance bound to a spawnId.
// Stored in st.gridCellXterms for cleanup when the grid re-renders.
function buildGridCellXterm(spawnId, container) {
  if (!spawnId) return null;
  if (!st.gridCellXterms) st.gridCellXterms = {};
  // Tear down previous instance for this spawnId (re-render case)
  disposeGridCellXterm(spawnId);
  // Pre-paint container background to match theme — avoids first-frame flash
  // when 4+ cells mount near-simultaneously.
  try { container.style.backgroundColor = xtermHostBg(); } catch {}
  const isDark = document.documentElement.dataset.theme === 'dark';
  // Nasce na largura em que o PTY gravou o buffer que vamos replayar logo
  // abaixo — nunca no default 80x24 do xterm.js. Ver renderer/term-replay.js:
  // replay em largura errada quebra todo wrap e todo posicionamento absoluto,
  // e o Ink (Claude Code) nunca limpa a tela para desfazer o estrago.
  const replay = NoryaTermReplay.prepareReplay(st.termBuffers[spawnId], st.termSizes[spawnId]);
  // Tema/fonte/cursor/paleta: noryaTermOptions (core.js), um só lugar pros
  // dois xterms. Inclui scrollOnUserInput:false (2026-08-04): o padrão do
  // xterm é true — qualquer tecla salta pro tail. Num menu de TUI mais alto
  // que o pane (seletor de opções do Claude), navegar com ↑/↓ jogava a barra
  // pro fundo e escondia as opções de cima, que era justamente o que se
  // queria ler. Voltar ao tail continua acontecendo, mas só ao ENVIAR (ver
  // onData abaixo).
  const term = new Terminal(noryaTermOptions({
    cols: replay.cols,
    rows: replay.rows,
  }));
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Busca no scrollback (Cmd+F → renderer/find.js).
  const search = new SearchAddon();
  term.loadAddon(search);
  term.open(container);
  const stream = NoryaTermReplay.createStream(term, { pace: () => noryaPace(spawnId, term) });
  stream.replay(terminalReplayChunks(spawnId));
  const resize = setupXtermResize(spawnId, term, fit, container, stream);
  // Menu de opções mais alto que o pane: o remendo relativo do agente satura no
  // topo da tela e o `❯` vai parar na linha errada, pra sempre. Ver
  // renderer/tui-redraw.js — o único jeito de pedir repintura inteira é SIGWINCH.
  const guardaRepintura = NoryaTuiRedraw.criarGuardaRepintura({
    repintar: () => {
      resize.nudge();
      // A repintura vem no fim do buffer: leva o viewport junto, senão o usuário
      // continua olhando o frame velho (corrompido) que ficou no scrollback.
      try { term.scrollToBottom(); } catch {}
    },
  });
  term.onData(data => {
    noteUserInput(spawnId);
    try { api.sendInput(spawnId, data); } catch {}
    if (NoryaTuiRedraw.ehTeclaDeNavegacao(data)) guardaRepintura.armar();
    // Enter = "mandei, quero ver a resposta" → volta pro tail. Setas, tab e
    // letras deixam o viewport onde o usuário o colocou.
    if (data.indexOf('\r') >= 0 || data.indexOf('\n') >= 0) { try { term.scrollToBottom(); } catch {} }
  });
  // Cmd/Ctrl+C copy on selection; colagem é do xterm (ver attachXtermClipboard).
  attachXtermClipboard(term);
  const listener = (_, data) => {
    try {
      // `rows` é a régua: o agente só pede subida >= rows quando o frame dele
      // não coube na tela — e a partir daí todo remendo erra (tui-redraw.js).
      const rows = st.termSizes[spawnId]?.rows || term.rows;
      stream.write(data, () => guardaRepintura.aposEscrita({ data, rows }));
    } catch {}
  };
  ipcRenderer.on(`terminal-data-${spawnId}`, listener);
  st.gridCellXterms[spawnId] = { term, stream, fit, search, listener, spawnId, resize, fitAndResize: resize.fitAndResize, container };
  return st.gridCellXterms[spawnId];
}

function disposeGridCellXterm(spawnId) {
  // A vista de chat sai junto (o MODELO fica: a sessão segue viva sem pane).
  try { NoryaChat.unmount(spawnId); } catch {}
  const inst = st.gridCellXterms && st.gridCellXterms[spawnId];
  if (!inst) return;
  try { if (inst.resize) inst.resize.cleanup(); } catch {}
  try { ipcRenderer.removeListener(`terminal-data-${spawnId}`, inst.listener); } catch {}
  try { inst.term.dispose(); } catch {}
  delete st.gridCellXterms[spawnId];
}

function disposeAllGridCellXterms() {
  if (!st.gridCellXterms) return;
  Object.keys(st.gridCellXterms).forEach(disposeGridCellXterm);
}

// Force the single-thread output area to show the xterm (never chat).
// Idempotent + safe to call from any flow that selects/opens a thread.
function forceXtermView() {
  const xt = document.getElementById('xtermHost');
  if (xt) xt.style.display = '';
}

// Dropdown de view-mode: REMOVIDO em 2026-09-08.
//
// A grid virou a única view nas Tasks 1-10 (2026-07-10) e o dropdown saiu do
// header — mas as ~78 linhas que o controlavam ficaram, operando em
// #viewModeMenu / #viewModeWrap / #btnViewMode, que não existem mais no HTML.
// Todas eram no-op guardado por `if (!menu) return`. O próprio código já
// avisava: "No-op até o menu/dropdown ser removido (Task 11/12)".
// test/smoke-cdp.js afirma que o dropdown não está no header; agora o código
// concorda com o teste.

// ── New thread ────────────────────────────────────────────────────────────────
// New Thread modal controller removed 2026-06-28: startNewThread() now spawns
// instantly in Home via createThreadInFolder(); the folder is changed afterward
// through the header folder button (respawnInFolder).

// Queued click: New Thread pressed while init() was still loading accounts.
// init() fires it as soon as boot finishes, so the click is never lost.
let _pendingNewThread = false;

async function startNewThread() {
  // Boot still in flight → queue the intent instead of silently no-oping.
  // (Pre-fix, a click during the boot window fell through to showEmptyState()
  // and NOTHING visible happened — the classic dead button.)
  if (!st.initDone) {
    _pendingNewThread = true;
    if (typeof noryaToast === 'function') noryaToast('Loading profiles… your thread will open in a moment.', 'info', { timeout: 3000 });
    return;
  }
  // Pre-conditions: must have an active profile + accounts loaded.
  if (!st.accounts.length) { openAddModal(); return; }
  const accNum = st.activeProfileNum;
  const acc = (accNum == null) ? null : st.accounts.find(a => a.num === accNum);
  if (!acc) {
    // No active profile → tell the user what's missing and open the picker,
    // instead of the old silent fall-through to the empty state.
    if (typeof noryaToast === 'function') noryaToast('Pick a profile to start a thread.', 'warn', { timeout: 4000 });
    if (typeof openProfileDropdown === 'function') openProfileDropdown();
    return;
  }

  // New Thread opens INSTANTLY in the user's Home folder — no upfront folder
  // picker (2026-06-28). Change the folder afterward via the header 📁 button,
  // which respawns the thread in the chosen folder. (OpenRouter/aider still use
  // the landing above, since the bridge needs a folder up front.)
  let home = '~';
  try { home = require('os').homedir(); } catch {}
  createThreadInFolder(home, { skipGitPrompt: true });
}

// Candidatos ao latch de uma thread recém-criada: linhas novas do DB que não
// existiam no spawn. A regra de escolha (conta + PROVIDER + cwd) mora em
// `renderer/latch-filter.js`, puro e testado em `test/latch-filter.test.js` —
// aqui fica só a leitura do estado global.
//
// `spawnId` é obrigatório desde 2026-09-09: é por ele que se descobre QUAL CLI
// este spawn está rodando (`st.spawnAgent`), e sem isso um spawn de Codex
// latchava numa sessão de Claude (accountNum null passava no filtro de conta) —
// o pane de `gpt-6-astra` que aparecia intitulado "(claude session)".
function _latchCandidates(beforeIds, accNum, cwd, spawnId) {
  // Ids já reivindicados por OUTRO spawn (2026-08-04). Dois latches em voo — o
  // caso de "digitei numa task e abri outra logo em seguida" — enxergavam as
  // MESMAS linhas novas e ambos escolhiam mine[0]: o segundo sobrescrevia
  // st.spawnByThread[realId], o primeiro PTY virava órfão invisível e a mesma
  // thread entrava duas vezes em gridMode.threadIds. Daí a linha duplicada na
  // sidebar e o pane que "some" ou aparece em dobro.
  const claimed = new Set(Object.keys(st.spawnByThread || {}));
  const agentId = spawnId ? (st.spawnAgent || {})[spawnId] : null;
  return NoryaLatchFilter.latchCandidates({
    threads: st.allThreads || [],
    beforeIds,
    claimedIds: claimed,
    accNum,
    cwd,
    provider: NoryaLatchFilter.providerOfAgent(agentId),
  });
}

// Actually spawn a new thread/PTY in the given folder. Extracted from the old
// startNewThread so the modal, landing flow and shortcuts share one code path.
// opts2.title is currently advisory (codex names the thread on first turn).
async function createThreadInFolder(folder, opts2) {
  opts2 = opts2 || {};
  if (!st.accounts.length) { openAddModal(); return; }
  // Honor an explicitly-chosen profile (from the modal selector) so the user can
  // create threads in DIFFERENT profiles at the same time. Switching the active
  // profile to the chosen one keeps the invariant "viewing a thread ⇒ active
  // profile === owner" and avoids confusion about which profile the PTY belongs to.
  const accNum = (opts2.profileNum != null) ? opts2.profileNum : st.activeProfileNum;
  if (accNum == null) { showNewThreadPanel(); return; }
  const acc = st.accounts.find(a => a.num === accNum);
  if (!acc) { showNewThreadPanel(); return; }
  if (accNum !== st.activeProfileNum && typeof setActiveProfile === 'function') {
    setActiveProfile(accNum);
  }

  // If folder has git, ask whether to work on the current branch (could clash
  // with other panes in this project) or create a fresh worktree for safe
  // parallel work. Skip the prompt for non-git folders, and for the silent
  // default-Home open (skipGitPrompt) so New Thread stays instant.
  if (folder && !opts2.skipGitPrompt) {
    let gitInfo = null;
    try { gitInfo = await api.gitDetect(folder); } catch {}
    if (gitInfo && gitInfo.hasGit) {
      const stayOnBranch = window.confirm(
        `This folder uses git (branch: ${gitInfo.branch || 'main'}).\n\n` +
        '  OK = open on this branch (careful if another pane touches it)\n' +
        '  Cancel = create a new worktree (recommended for working in parallel)'
      );
      if (!stayOnBranch) {
        const defaultSlug = 'feature-' + Date.now().toString(36).slice(-5);
        const slug = window.prompt('Branch/worktree name:', defaultSlug);
        if (!slug) return;
        const projectId = folderToProjectId(folder);
        let wtRes;
        try { wtRes = await api.gitWorktreeAdd({ projectId, slug, projectDir: folder }); }
        catch (e) { wtRes = { error: String(e && e.message || e) }; }
        if (!wtRes || wtRes.error) {
          alert('Failed to create worktree:\n' + (wtRes && wtRes.error || 'unknown'));
          return;
        }
        folder = wtRes.path;  // PTY abre no novo worktree
      }
    }
  }

  const opts = folder
    ? { mode: 'new-folder', cwd: folder, projectId: folderToProjectId(folder), profileNum: accNum }
    : { mode: 'default', profileNum: accNum };
  // Agente explícito (sobrepõe o seletor do Mac).
  if (opts2.agentId) opts.agentId = opts2.agentId;
  // Prompt inicial (Mini/pet): vira argumento posicional da CLI, só em sessão nova.
  if (opts2.initialPrompt) opts.initialPrompt = String(opts2.initialPrompt);

  console.log('[startNewThread] spawning direct', { accNum, folder, opts, gridMode: !!(st.gridMode && st.gridMode.enabled) });
  const spawnId = launchTerminal(acc, opts);

  // Provisional mapping — xterm uses spawnId as the visible thread key until
  // a background poll latches it to a real threadId after the first turn.
  st.selectedThreadId = spawnId;
  st.spawnByThread[spawnId] = spawnId;
  st.lastRunThreadId[accNum] = spawnId;
  // Show the provisional row highlighted in the sidebar RIGHT NOW — instant
  // visual anchor that the thread exists (see _provisionalThreads). Synchronous
  // on purpose: the RAF-debounced renderProjectList() doesn't fire while the
  // window is hidden/occluded, and spawn is exactly when feedback matters.
  renderProjectListNow();

  if (st.gridMode && st.gridMode.enabled) {
    // Grid mode: add the new spawn as a fresh pane and keep the grid view.
    // The spawnId acts as the provisional threadId until latch.
    if (!st.gridMode.threadIds.includes(spawnId)) {
      st.gridMode.threadIds.push(spawnId);
    }
    // O pane recém-criado é onde o usuário vai digitar — foca ele, em vez de
    // deixar o foco no pane antigo (e o ⌘Enter indo pro lugar errado).
    st.gridMode.focusedThreadId = spawnId;
    st.gridMode.lastInteracted = spawnId;
    saveGridStateToStorage();
    document.getElementById('app').dataset.view = 'grid';
    document.body.classList.remove('landing');
    document.getElementById('app').classList.remove('landing');
    const ntpPanel = document.getElementById('newThreadPanel');
    if (ntpPanel) ntpPanel.classList.add('hidden');
    renderGrid();
    updateInputState();
  } else {
    // Single view: dedicated xterm-host display
    document.getElementById('app').dataset.view = 'single';
    const xtermHost = document.getElementById('xtermHost');
    const outputEmpty = document.getElementById('outputEmpty');
    const ntpPanel = document.getElementById('newThreadPanel');
    if (ntpPanel) ntpPanel.classList.add('hidden');
    document.body.classList.remove('landing');
    document.getElementById('app').classList.remove('landing');
    if (xtermHost) xtermHost.style.display = '';
    if (outputEmpty) outputEmpty.classList.add('hidden');
    try {
      const inst = getOrCreateXterm(spawnId);
      inst.resize.scheduleFit(80);
      showXtermFor(spawnId);
    } catch (e) { console.warn('xterm show failed', e); }
    updateInputState();
    try { updateHeader(); } catch {}
  }

  // Background latch: poll the threads DB for the row codex inserts after
  // the first user_event. Once we find it, swap the provisional mapping.
  const beforeIds = new Set((st.allThreads || []).map(t => t.id));
  const spawnCwdForLatch = (opts && opts.cwd) || null;
  let latched = false;
  async function poll(retries) {
    if (latched) return;
    await refreshThreads();
    const mine = _latchCandidates(beforeIds, acc.num, spawnCwdForLatch, spawnId);
    if (mine.length) {
      latched = true;
      _latchSpawn(spawnId, mine[0].id, acc);
      return;
    }
    if (retries > 0) setTimeout(() => poll(retries - 1), 1500);
    // Janela rápida esgotada com o PTY ainda vivo (1º prompt demorou mais de
    // 90s) — segue tentando devagar; sem isso a linha provisória "New thread"
    // virava fantasma permanente ao lado da linha real quando ela chegasse.
    // 30s (era 10s): esses pollers lentos são PERMANENTES e se acumulam um por
    // task nunca latchada, então a cadência deles é custo fixo de main process.
    else if (st.termRunning[spawnId]) setTimeout(() => poll(0), 30000);
  }
  if (st.spawnUi[spawnId] === 'chat') {
    // Chat: a CLI diz o id da sessão pelo protocolo — latch direto, sem varrer
    // o banco (o `claude -p` nem aparece lá até o list-threads conhecê-lo).
    NoryaChat.onSession(spawnId, realId => {
      if (latched || !realId) return;
      latched = true;
      _latchSpawn(spawnId, realId, acc);
      refreshThreads().catch(() => {});
    });
  } else {
    setTimeout(() => poll(60), 2500);
  }
  return spawnId;
}

// Troca o id provisório (spawnId) pelo id real da thread em todo lugar que o
// guarda. Usado pelo poll do banco (TUI) e pelo evento de sessão (chat).
function _latchSpawn(spawnId, realId, acc) {
  if (st.spawnByThread[spawnId] === spawnId) delete st.spawnByThread[spawnId];
  st.spawnByThread[realId] = spawnId;
  st.selectedThreadId = realId;
  // Also swap in gridMode.threadIds if this was a grid spawn — including
  // the focus/maximize fields, or renderGrid would drop the stale focus
  // and auto-jump it to the FIRST pane (bug: focus pulava sozinho após o
  // primeiro turno de uma thread nova).
  if (st.gridMode && st.gridMode.threadIds) {
    const idx = st.gridMode.threadIds.indexOf(spawnId);
    if (idx >= 0) {
      st.gridMode.threadIds[idx] = realId;
      if (st.gridMode.focusedThreadId === spawnId) st.gridMode.focusedThreadId = realId;
      if (st.gridMode.lastInteracted === spawnId) st.gridMode.lastInteracted = realId;
      if (st.gridMode.maximizedThreadId === spawnId) st.gridMode.maximizedThreadId = realId;
      saveGridStateToStorage();
      if (document.getElementById('app').dataset.view === 'grid') renderGrid();
    }
  }
  const ownerNum = st.activeProfileNum != null ? st.activeProfileNum : acc.num;
  api.threadOwnerSet(realId, ownerNum).catch(() => {});
  persistThreadAgent(realId, spawnId);
  updateInputState();
  // Reabrir esta task volta do mesmo jeito (TUI ou chat).
  if (st.spawnUi[spawnId]) setThreadUi(realId, st.spawnUi[spawnId]);
  console.log('[startNewThread] latched threadId=' + realId);
}

function setThreadUi(threadId, ui) {
  if (!threadId) return;
  delete st.threadUi[threadId];
  st.threadUi[threadId] = ui;
  // Teto: as mais recentes (ordem de inserção) — tasks velhas reabrem no padrão.
  const ks = Object.keys(st.threadUi);
  for (const k of ks.slice(0, Math.max(0, ks.length - 400))) delete st.threadUi[k];
  try { localStorage.setItem('norya-thread-ui', JSON.stringify(st.threadUi)); } catch {}
}

// Returns true if any thread running for the given account number.
// After the multi-PTY refactor, st.termRunning is keyed by spawnId, so we walk
// st.spawnAccount to find any spawn associated with this account.
function anyThreadRunningForAccount(num) {
  if (st.termRunning && st.termRunning[num]) return true;
  if (st.spawnAccount) {
    for (const [spawnId, accNum] of Object.entries(st.spawnAccount)) {
      if (accNum === num && st.termRunning[spawnId]) return true;
    }
  }
  return false;
}

// ── Input ─────────────────────────────────────────────────────────────────────
function sendMessage() {
  const field = document.getElementById('inputField');
  const text = field.value.trim();
  if (!text) return;
  const tid = st.selectedThreadId;
  const spawnId = tid && st.spawnByThread[tid];
  if (!spawnId || !st.termRunning[spawnId]) return;
  field.value = '';
  field.style.height = 'auto';
  // Toda thread escreve no stdin do PTY. O bridge Python do Aider foi removido
  // em 2026-07-09: o Aider virou uma CLI como as outras, montada pelo registry.
  api.sendInput(spawnId, text + '\r');
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── Account context menu ───────────────────────────────────────────────────────
function showAccountMenu(acc, anchor) {
  closeCtxMenu();
  const menu = makeCtxMenu([
    { label: 'Rename', fn: () => openRenameModal(acc) },
    { label: 'Refresh quota', fn: () => refreshAccQuota(acc.num) },
    { sep: true },
    { label: 'Delete account', danger: true, fn: () => openDeleteModal(acc) },
  ]);
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + 4 + 'px';
  menu.style.left = r.left + 'px';
  if (r.left + menu.offsetWidth > window.innerWidth - 8)
    menu.style.left = (window.innerWidth - menu.offsetWidth - 8) + 'px';
  setTimeout(() => document.addEventListener('click', closeCtxMenu, { once: true }), 0);
}

function makeCtxMenu(items) {
  const menu = document.createElement('div');
  menu.id = 'ctxMenu';
  menu.className = 'ctx-menu';
  items.forEach(a => {
    if (a.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (a.danger ? ' danger' : '');
    btn.textContent = a.label;
    btn.addEventListener('click', () => { closeCtxMenu(); a.fn(); });
    menu.appendChild(btn);
  });
  return menu;
}

function closeCtxMenu() {
  const m = document.getElementById('ctxMenu');
  if (m) m.remove();
}

// ── More header menu ───────────────────────────────────────────────────────────
document.getElementById('btnMoreHeader').addEventListener('click', function() {
  const num = st.selectedAccountNum;
  const acc = st.accounts.find(a => a.num === num);
  if (!acc) return;
  closeCtxMenu();
  const items = [
    { label: 'Refresh quota', fn: () => refreshAccQuota(acc.num) },
    { label: 'Rename profile', fn: () => openRenameModal(acc) },
    { sep: true },
    { label: 'Reload tasks', fn: async () => {
      try { st.allThreads = await api.listThreads(null, null) || []; invalidateSidebarCache(); } catch {}
      renderProjectList();
    }},
  ];
  if (st.termRunning[num]) items.unshift({ label: '■ Stop session', fn: () => killTerminalForNum(num) });

  const menu = makeCtxMenu(items);
  document.body.appendChild(menu);
  const r = this.getBoundingClientRect();
  menu.style.top = r.bottom + 4 + 'px';
  menu.style.right = (window.innerWidth - r.right) + 'px';
  setTimeout(() => document.addEventListener('click', closeCtxMenu, { once: true }), 0);
});
