/**
 * renderer/grid.js — Norya Grid: orquestração, foco, maximizar, banner, send-to-many, kebab, merge.
 *
 * Script CLÁSSICO (ver renderer/state.js): fatia contígua extraída de
 * test-window.html em 2026-07-10, na ordem original. Compartilha o escopo
 * léxico global com os outros — `st`, `api`, `ipcRenderer` e as funções de
 * cada fatia enxergam-se sem import. Ordem de carga preservada = zero mudança
 * de comportamento.
 */
'use strict';

// ── Norya Grid (orchestration mode) ─────────────────────────────────────────
const GRID_STATE_KEY = 'norya-grid-state';

function loadGridStateFromStorage() {
  // Grid é a ÚNICA view (2026-07-10): sempre ligado. Ignora o `enabled`
  // persistido — o roster/foco ainda vêm do storage, só o enabled é forçado.
  st.gridMode.enabled = true;
  // _persisted distingue "primeiro boot, nada salvo" (auto-popular com as
  // threads working é bem-vindo) de "roster salvo — inclusive vazio de
  // propósito". Sem essa distinção, fechar o último pane re-populava o grid
  // com qualquer PTY vivo e o pane "voltava" sozinho.
  st.gridMode._persisted = false;
  try {
    const raw = localStorage.getItem(GRID_STATE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      st.gridMode._persisted = true;
      // enabled já forçado true acima — não reler o persistido.
      st.gridMode.threadIds = Array.isArray(parsed.threadIds) ? parsed.threadIds : [];
      st.gridMode.lastInteracted = parsed.lastInteracted || null;
      st.gridMode.focusedThreadId = parsed.focusedThreadId || null;
      st.gridMode.maximizedThreadId = parsed.maximizedThreadId || null;
      // Cap threadIds in case persisted state exceeds new max
      if (typeof GRID_MAX_PANES === 'number' && st.gridMode.threadIds.length > GRID_MAX_PANES) {
        st.gridMode.threadIds = st.gridMode.threadIds.slice(0, GRID_MAX_PANES);
      }
    }
  } catch {}
}

let _gridDiskMirrorTimer = null;
function saveGridStateToStorage() {
  const payload = {
    enabled: st.gridMode.enabled,
    threadIds: st.gridMode.threadIds,
    lastInteracted: st.gridMode.lastInteracted,
    focusedThreadId: st.gridMode.focusedThreadId,
    maximizedThreadId: st.gridMode.maximizedThreadId || null,
    savedAt: Date.now(),
  };
  try { localStorage.setItem(GRID_STATE_KEY, JSON.stringify(payload)); } catch {}
  st.gridMode._persisted = true;
  // Mirror to disk so users can inspect / migrate; debounced 500ms to avoid
  // hammering the FS during drag-reorder. Best-effort: errors are swallowed.
  if (_gridDiskMirrorTimer) clearTimeout(_gridDiskMirrorTimer);
  _gridDiskMirrorTimer = setTimeout(() => {
    _gridDiskMirrorTimer = null;
    try { api && api.gridStateSave && api.gridStateSave(payload); } catch {}
  }, 500);
}

// Grid view: renders one xterm per pane (buildGridCell → buildGridCellXterm).
function enterGridMode() {
  st.gridMode.enabled = true;
  // Leave the landing: clear the landing overlay + class, otherwise the landing
  // CSS keeps .grid-area hidden and the ntpPanel on top (the grid never shows).
  try { if (typeof hideNewThreadPanel === 'function') hideNewThreadPanel(); } catch {}
  document.body.classList.remove('landing');
  document.getElementById('app').classList.remove('landing');
  // Auto-populate with currently-working threads — ONLY on first run (nothing
  // persisted yet). A deliberately-emptied roster stays empty; re-populating
  // here made the last pane impossible to close (it came right back).
  if (!st.gridMode.threadIds.length && !st.gridMode._persisted) {
    const working = Object.entries(st.spawnByThread || {})
      .filter(([, sid]) => st.termRunning[sid])
      .map(([tid]) => tid);
    st.gridMode.threadIds = working;
  } else if (st.gridMode.threadIds.length) {
    // Filter out threads whose PTYs are gone (cleanup stale ids)
    st.gridMode.threadIds = st.gridMode.threadIds.filter(tid => {
      const sid = st.spawnByThread[tid];
      // Keep if PTY exists OR if we have a thread record (idle, can be resumed later)
      return !!sid || (st.allThreads || []).some(t => t.id === tid);
    });
  }
  // S1 fix: carry the thread the user was working on (single view) into the grid
  // and make it the focused/active pane — otherwise renderGrid auto-focuses an
  // arbitrary ids[0] or inherits a stale persisted focusedThreadId.
  const cur = st.selectedThreadId;
  if (cur) {
    if (!st.gridMode.threadIds.includes(cur)
        && (typeof GRID_MAX_PANES !== 'number' || st.gridMode.threadIds.length < GRID_MAX_PANES)) {
      st.gridMode.threadIds.push(cur);
    }
    if (st.gridMode.threadIds.includes(cur)) st.gridMode.focusedThreadId = cur;
    st.gridMode.maximizedThreadId = null; // a persisted maximize would hide the focused pane
  } else if (st.gridMode.focusedThreadId && !st.gridMode.threadIds.includes(st.gridMode.focusedThreadId)) {
    // No active thread: drop a stale focus that points outside the roster.
    st.gridMode.focusedThreadId = (st.gridMode.lastInteracted && st.gridMode.threadIds.includes(st.gridMode.lastInteracted))
      ? st.gridMode.lastInteracted : null;
  }
  saveGridStateToStorage();
  document.getElementById('app').dataset.view = 'grid';
  if (typeof renderGrid === 'function') renderGrid();
  if (typeof renderProjectList === 'function') renderProjectList();  // refresh sidebar "+" buttons
  updateNoryaGridButton();
}

// exitGridMode/toggleGridMode removidos (2026-07-10): grid é a única view, não
// há mais para onde "sair". Boot e cliques entram/permanecem no grid. Os antigos
// callers (rail, view-mode dropdown, ⌘G) foram roteados pra enterGridMode/no-op.

// Nome mantido: vários callers (enterGridMode, startNewThread, boot) ainda o
// chamam em toda troca de estado. O botão #btnNoryaGrid saiu na Task 12, então
// o corpo colapsou para a única coisa que ainda importa: avisar o rail, que é
// quem reflete o modo grid hoje (2026-07-10).
function updateNoryaGridButton() {
  if (typeof window.__railSync === 'function') window.__railSync();
}

// Track last interacted thread (used when returning to Single)
function noteThreadInteraction(threadId) {
  if (!threadId) return;
  st.gridMode.lastInteracted = threadId;
  if (st.gridMode.enabled) saveGridStateToStorage();
}

// Add a thread to the grid (idempotent). If grid is active, re-renders.
// Hard-caps at GRID_MAX_PANES (16) — beyond that the UI becomes unusable.
function addThreadToGrid(threadId) {
  if (!threadId) return false;
  if (st.gridMode.threadIds.includes(threadId)) return false;
  if (typeof GRID_MAX_PANES === 'number'
      && st.gridMode.threadIds.length >= GRID_MAX_PANES) {
    if (typeof showGridBanner === 'function') {
      showGridBanner(`Grid full (${GRID_MAX_PANES} panes). Close one first.`, 'warn');
    } else {
      console.warn('Grid full (max ' + GRID_MAX_PANES + ' panes)');
    }
    return false;
  }
  st.gridMode.threadIds.push(threadId);
  saveGridStateToStorage();
  if (st.gridMode.enabled && typeof renderGrid === 'function') renderGrid();
  return true;
}

function removeThreadFromGrid(threadId) {
  const idx = st.gridMode.threadIds.indexOf(threadId);
  if (idx < 0) return;
  st.gridMode.threadIds.splice(idx, 1);
  // Fechar o pane ≠ encerrar a sessão: o PTY segue em segundo plano (por
  // design — o × sempre disse "PTY keeps running" no tooltip). Sem um aviso,
  // "fechei mas continua ativo" parecia bug. Encerrar de verdade: ⋯ → Stop.
  const sid = st.spawnByThread[threadId];
  if (sid && st.termRunning[sid] && typeof showGridBanner === 'function') {
    showGridBanner('Pane closed — the session keeps running in background (⋯ → Stop session to end it).');
  }
  saveGridStateToStorage();
  if (st.gridMode.enabled && typeof renderGrid === 'function') renderGrid();
}

// Spawn (resume) a thread's PTY for a grid cell, resolving the profile by the
// thread's CLI provider — so a Claude thread always opens with `claude`, never
// `codex resume` (which errored). Persists the resolved owner. Returns the
// spawnId, or null when no profile of the right provider is available.
function gridSpawnThread(thread) {
  if (!thread) return null;
  const existing = st.spawnByThread[thread.id];
  if (existing && st.termRunning[existing]) return existing;
  // Sem trava de conta aqui: o backend liberou 2+ codex no mesmo perfil (2476f7c,
  // ver test/smoke-multi-codex.js). O único teto de panes é GRID_MAX_PANES.
  let acc = null;
  const ownerNum = getThreadEffectiveOwner(thread);
  if (ownerNum != null) acc = st.accounts.find(a => a.num === ownerNum);
  if (!acc && thread.accountNum != null) acc = st.accounts.find(a => a.num === thread.accountNum);
  if (!acc) {
    acc = pickProfileForProvider(thread.provider);
    if (!acc) {
      const label = thread.provider === 'claude' ? 'Claude'
                  : thread.provider === 'aider'  ? 'OpenRouter (Aider)' : 'Codex';
      const msg = `No ${label} profile available to open this task. Add or log into one in Profile settings.`;
      if (typeof showGridBanner === 'function') showGridBanner(msg, 'warn'); else alert(msg);
      return null;
    }
    if (!st.threadOwners) st.threadOwners = {};
    st.threadOwners[thread.id] = acc.num;
    try { api.threadOwnerSet(thread.id, acc.num); } catch (e) { console.warn('thread-owner-set', e); }
  }
  const spawnId = launchTerminal(acc, {
    mode: 'resume',
    sessionId: thread.id,
    cwd: thread.cwd,
    projectId: thread.cwd ? folderToProjectId(thread.cwd) : null,
    profileNum: acc.num,
  });
  st.spawnByThread[thread.id] = spawnId;
  noteThreadInteraction(thread.id);
  return spawnId;
}

// ── Grid focus model ─────────────────────────────────────────────────────────
// gridFocusedThreadId is the *visually highlighted* pane (and the destination
// for ⌘Enter / single-target composer sends). Distinct from selectedThreadId
// (sticky sidebar selection). Persisted across renders.
function setGridFocus(threadId) {
  st.gridMode.focusedThreadId = threadId || null;
  document.querySelectorAll('.grid-cell.gc-focused').forEach(c => c.classList.remove('gc-focused'));
  if (!threadId) return;
  const cell = document.querySelector(`.grid-cell[data-thread="${threadId}"]`);
  if (cell) cell.classList.add('gc-focused');
  // Pane que ganhou foco sai do ritmo de 4 quadros/s na hora (views.js).
  if (typeof noryaFlushPane === 'function') noryaFlushPane(st.spawnByThread[threadId] || threadId);
  // Also bump it as last-interacted so single-mode resume opens the right one.
  noteThreadInteraction(threadId);
}

function gridFocusNeighbor(direction) {
  // direction: -1 prev, 1 next. Wraps. No-op outside grid mode.
  if (!st.gridMode || !st.gridMode.enabled) return;
  const ids = st.gridMode.threadIds || [];
  if (!ids.length) return;
  const cur = st.gridMode.focusedThreadId || ids[0];
  let idx = ids.indexOf(cur);
  if (idx < 0) idx = 0;
  const next = ids[(idx + direction + ids.length) % ids.length];
  setGridFocus(next);
  const cell = document.querySelector(`.grid-cell[data-thread="${next}"]`);
  if (cell) {
    cell.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Try to give the xterm of the pane focus too so keys flow there.
    const sid = st.spawnByThread[next];
    const inst = sid && st.gridCellXterms && st.gridCellXterms[sid];
    try { inst && inst.term && inst.term.focus(); } catch {}
  }
}

// ── Grid maximize: temporarily zoom one pane to fill the entire grid area ──
function toggleGridMaximize(threadId) {
  if (!threadId) return;
  const area = document.getElementById('gridArea');
  if (!area) return;
  const cur = st.gridMode.maximizedThreadId;
  // Clear any maximized state
  area.querySelectorAll('.grid-cell.gc-maximized').forEach(c => c.classList.remove('gc-maximized'));
  if (cur === threadId) {
    st.gridMode.maximizedThreadId = null;
    area.classList.remove('has-max');
  } else {
    const cell = area.querySelector(`.grid-cell[data-thread="${threadId}"]`);
    if (!cell) return;
    cell.classList.add('gc-maximized');
    area.classList.add('has-max');
    st.gridMode.maximizedThreadId = threadId;
    setGridFocus(threadId);
  }
  saveGridStateToStorage();  // persist maximize across reload
  refreshMaximizeButtons();
  // Refit xterms after CSS transition completes.
  requestAnimationFrame(() => {
    setTimeout(() => {
      Object.values(st.gridCellXterms || {}).forEach(inst => {
        try { inst.resize && inst.resize.fitAndResize({ force: true }); } catch {}
      });
    }, 80);
  });
}

// Atualiza os botões ⤢/⤡ SEM renderGrid — re-render mataria os xterms vivos.
function refreshMaximizeButtons() {
  document.querySelectorAll('.grid-cell').forEach(cell => {
    const btn = cell.querySelector('.grid-cell-max');
    if (!btn) return;
    const isMax = st.gridMode.maximizedThreadId === cell.dataset.thread;
    btn.title = kc(isMax ? 'Restaurar (⌘G)' : 'Maximizar (⌘G)');
    btn.textContent = '';
    btn.appendChild(_svgIcon('0 0 16 16', isMax
      ? ['M6.5 2v4.5H2', 'M9.5 14V9.5H14', 'M2 9.5h4.5V14', 'M14 6.5H9.5V2']
      : ['M9.5 2H14v4.5', 'M14 2L9.5 6.5', 'M6.5 14H2V9.5', 'M2 14l4.5-4.5']));
  });
}

// ── Grid banner (transient feedback) ────────────────────────────────────────
let _gridBannerTimer = null;
function showGridBanner(text, kind = 'info') {
  let el = document.getElementById('gridBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gridBanner';
    el.className = 'grid-banner';
    document.body.appendChild(el);
  }
  el.classList.remove('warn');
  if (kind === 'warn') el.classList.add('warn');
  el.textContent = text;
  // Force reflow so the transition replays even on consecutive calls
  void el.offsetHeight;
  el.classList.add('show');
  if (_gridBannerTimer) clearTimeout(_gridBannerTimer);
  _gridBannerTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 1900);
}

// ── Per-pane kebab (three-dot) menu ─────────────────────────────────────────
function openGridCellMenu(thread, spawnId, anchor) {
  if (typeof closeCtxMenu === 'function') closeCtxMenu();
  if (typeof makeCtxMenu !== 'function') return;
  const isMax = st.gridMode.maximizedThreadId === thread.id;
  const items = [
    {
      label: isMax ? 'Restore size' : 'Maximize',
      fn: () => toggleGridMaximize(thread.id),
    },
    {
      label: 'Focus pane',
      fn: () => {
        setGridFocus(thread.id);
        const inst = spawnId && st.gridCellXterms && st.gridCellXterms[spawnId];
        try { inst && inst.term && inst.term.focus(); } catch {}
      },
    },
  ];
  items.push({
    label: 'Copy task ID',
    fn: () => {
      try {
        navigator.clipboard.writeText(thread.id);
        showGridBanner('Task ID copied.');
      } catch {
        showGridBanner('Failed to copy.', 'warn');
      }
    },
  });
  // TUI ↔ chat: reabre a MESMA sessão do outro jeito (Claude e Codex).
  const agenteDoPane = paneAgentOf(thread, spawnId);
  if (agenteDoPane === 'claude' || agenteDoPane === 'codex') {
    const uiAtual = (spawnId && st.termRunning[spawnId]) ? (st.spawnUi[spawnId] || 'tui') : (st.threadUi[thread.id] || 'tui');
    const outra = uiAtual === 'chat' ? 'tui' : 'chat';
    items.push({
      label: outra === 'chat' ? 'Abrir como chat' : 'Abrir como TUI',
      fn: () => reopenPaneAs(thread, spawnId, outra),
    });
  }
  items.push({ sep: true });
  if (spawnId && st.termRunning[spawnId]) {
    items.push({
      label: '■ Stop session',
      danger: true,
      fn: () => {
        if (typeof killTerminalForSpawn === 'function') killTerminalForSpawn(spawnId);
        if (typeof renderGrid === 'function') renderGrid();
      },
    });
  }
  // Desde 2026-09-09 o × do pane ENCERRA a task; esconder sem matar virou o
  // gesto raro (⌥+clique no ×, ou este item).
  items.push({
    label: 'Hide pane (session keeps running)',
    fn: () => { if (typeof removeThreadFromGrid === 'function') removeThreadFromGrid(thread.id); },
  });
  const menu = makeCtxMenu(items);
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - r.right) + 'px';
  // Don't close on the same click that opened us
  setTimeout(() => document.addEventListener('click', closeCtxMenu, { once: true }), 0);
}

// Bind ⌘G shortcut (idempotent). Não há mais botão de view: grid é a única view
// (o #btnNoryaGrid saiu na Task 12). ⌘G agora maximiza/restaura o pane focado.
(function bindNoryaGrid() {
  if (!document._noryaGridShortcutBound) {
    document._noryaGridShortcutBound = true;
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g' && !e.shiftKey) {
        e.preventDefault();
        // Grid é a única view: ⌘G agora maximiza/restaura o pane focado.
        const alvo = st.gridMode.focusedThreadId
          || st.gridMode.lastInteracted
          || (st.gridMode.threadIds || [])[0];
        if (alvo) toggleGridMaximize(alvo);
      }
      // ⌘← / ⌘→ cycle pane focus while in grid view (skipped when typing in any
      // editable field, including the composer — there ⌘←/→ is native caret nav).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')
          && st.gridMode && st.gridMode.enabled) {
        const tag = (e.target && e.target.tagName || '').toLowerCase();
        const inEditable = tag === 'textarea' || tag === 'input'
          || (e.target && e.target.isContentEditable);
        if (!inEditable) {
          e.preventDefault();
          gridFocusNeighbor(e.key === 'ArrowRight' ? 1 : -1);
        }
      }
    });
  }
})();

function updateThreadToolbarWidgets() {
  const profileBtn = document.getElementById('btnInputProfile');
  const profileDot = document.getElementById('btnInputProfileDot');
  const profileName = document.getElementById('btnInputProfileName');
  const branchBtn = document.getElementById('btnInputBranch');
  const branchDot = document.getElementById('btnInputBranchDot');
  const branchLabel = document.getElementById('btnInputBranchLabel');
  const folderBtn = document.getElementById('btnInputFolder');
  const folderLabel = document.getElementById('btnInputFolderLabel');

  const tid = st.selectedThreadId;
  const thread = tid ? (st.allThreads || []).find(t => t.id === tid) : null;
  // Provisional spawn = selectedThreadId is actually a spawnId (no record yet).
  // Detected when spawnByThread[tid] === tid (we mapped it to itself).
  const isProvisional = tid && st.spawnByThread[tid] === tid && !thread;
  const provisionalAcc = isProvisional
    ? st.accounts.find(a => a.num === (st.spawnAccount[tid] != null ? st.spawnAccount[tid] : st.activeProfileNum))
    : null;

  // Profile pill — show whenever there's a selected thread id (even if the
  // thread record hasn't loaded yet from allThreads). Color matches owner
  // ONLY when the thread is actually active (PTY running). Inactive ones
  // show the owner name + dashed border (visual hint that it's idle).
  if (profileBtn && profileDot && profileName) {
    if (!st.selectedThreadId) {
      profileBtn.classList.add('hidden');
    } else if (isProvisional && provisionalAcc) {
      // Spawn before latch — show the active profile that spawned it so the
      // pill doesn't say "loading…" forever (codex 0.133.0 sometimes never
      // writes the thread row).
      profileBtn.classList.remove('hidden');
      profileDot.style.background = provisionalAcc.color || 'var(--accent)';
      profileDot.style.border = 'none';
      profileName.textContent = provisionalAcc.name || ('Profile ' + provisionalAcc.num);
      profileBtn.title = 'Active owner: ' + (provisionalAcc.name || 'Profile ' + provisionalAcc.num)
                       + ' (task not named yet)';
    } else if (!thread) {
      profileBtn.classList.remove('hidden');
      profileDot.style.background = 'transparent';
      profileDot.style.border = '1.5px dashed var(--text-faint)';
      profileName.textContent = 'loading...';
      profileBtn.title = 'Loading task data…';
    } else {
      const owner = getThreadEffectiveOwner(thread);
      const ownerAcc = owner != null ? st.accounts.find(a => a.num === owner) : null;
      const sid = st.spawnByThread[thread.id];
      const isActive = !!(sid && st.termRunning[sid]);
      profileBtn.classList.remove('hidden');
      if (ownerAcc) {
        if (isActive) {
          profileDot.style.background = ownerAcc.color || 'var(--accent)';
          profileDot.style.border = 'none';
        } else {
          profileDot.style.background = 'transparent';
          profileDot.style.border = '1.5px dashed ' + (ownerAcc.color || 'var(--text-faint)');
        }
        profileName.textContent = ownerAcc.name || 'Profile ' + owner;
        profileBtn.title = (isActive ? 'Active owner: ' : 'Owner (task idle): ')
                         + (ownerAcc.name || 'Profile ' + owner) + ' — click to switch';
      } else {
        profileDot.style.background = 'transparent';
        profileDot.style.border = '1.5px dashed var(--text-faint)';
        profileName.textContent = 'no owner';
        profileBtn.title = 'Task has no linked account — click to choose';
      }
    }
  }

  // Branch readonly — show only when thread cwd has git
  if (branchBtn && branchDot && branchLabel) {
    const cwd = thread && thread.cwd;
    const gitInfo = cwd ? _gitInfoByCwd[cwd] : null;
    if (!thread || !gitInfo || !gitInfo.hasGit) {
      branchBtn.classList.add('hidden');
    } else {
      branchBtn.classList.remove('hidden');
      const branch = thread.git_branch || gitInfo.branch || 'main';
      const projectId = cwd ? folderToProjectId(cwd) : null;
      branchLabel.textContent = branch;
      branchDot.style.background = (typeof branchColor === 'function') ? branchColor(branch, projectId) : 'var(--accent)';
      // agent/branches: click copies branch name, hover shows last commit
      branchBtn.title = 'Branch: ' + branch + '  (click to copy)\nFork to work on another branch.';
      branchBtn.dataset.branchName = branch;
      branchBtn.dataset.branchCwd = cwd || '';
    }
  }

  // Folder pill — visible whenever we have a spawnId. Shows the basename of
  // the current cwd. Click swaps cwd by killing + respawning in the new dir.
  if (folderBtn && folderLabel) {
    const sid = tid && st.spawnByThread[tid];
    if (!sid) {
      folderBtn.classList.add('hidden');
    } else {
      folderBtn.classList.remove('hidden');
      const cwd = st.spawnCwd[sid] || (thread && thread.cwd) || '';
      if (cwd) {
        const short = cwd.split(/[\\/]/).slice(-2).join('/') || cwd;
        folderLabel.textContent = short;
        folderBtn.title = 'Current folder: ' + cwd + '\nClick to switch (restarts the terminal in the new cwd).';
        folderBtn.classList.add('picked');
      } else {
        folderLabel.textContent = 'select folder';
        folderBtn.title = 'Select a folder to run the agent.';
        folderBtn.classList.remove('picked');
      }
    }
  }
}

// Bind thread-toolbar widgets once (idempotent)
(function bindThreadToolbarWidgets() {
  const profileBtn = document.getElementById('btnInputProfile');
  if (profileBtn && !profileBtn.dataset.bound) {
    profileBtn.dataset.bound = '1';
    profileBtn.addEventListener('click', e => {
      e.stopPropagation();
      const tid = st.selectedThreadId;
      const thread = tid ? (st.allThreads || []).find(t => t.id === tid) : null;
      if (thread && typeof openOwnerPicker === 'function') {
        openOwnerPicker(thread, profileBtn);
      }
    });
  }
  const branchBtn = document.getElementById('btnInputBranch');
  if (branchBtn && !branchBtn.dataset.bound) {
    branchBtn.dataset.bound = '1';
    // agent/branches: primary action is copy. Long-press / right-click still
    // reveals the read-only explanation (kept for users who expected the alert).
    branchBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = branchBtn.dataset.branchName || '';
      if (!name) return;
      try {
        await navigator.clipboard.writeText(name);
      } catch {
        // Fallback for environments without clipboard API
        try {
          const ta = document.createElement('textarea');
          ta.value = name; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        } catch {}
      }
      const labelEl = document.getElementById('btnInputBranchLabel');
      const original = labelEl ? labelEl.textContent : '';
      branchBtn.classList.add('copied');
      if (labelEl) labelEl.textContent = 'copied!';
      setTimeout(() => {
        branchBtn.classList.remove('copied');
        if (labelEl && original) labelEl.textContent = original;
      }, 950);
    });
    branchBtn.addEventListener('contextmenu', e => {
      e.preventDefault();
      window.alert('This task branch is fixed.\n\nUse Fork to work on another branch (separate worktree).');
    });
    // Enrich tooltip with last commit on hover (lazy — only first time per branch)
    let _lastCommitCache = {};
    branchBtn.addEventListener('mouseenter', async () => {
      const name = branchBtn.dataset.branchName;
      const cwd = branchBtn.dataset.branchCwd;
      if (!name || !cwd) return;
      const key = cwd + '::' + name;
      let info = _lastCommitCache[key];
      if (!info) {
        try { info = await api.gitLastCommit(cwd, name); } catch { info = null; }
        if (info && !info.error) _lastCommitCache[key] = info;
      }
      if (info && !info.error && info.sha) {
        branchBtn.title = 'Branch: ' + name + '  (click to copy)\n'
          + 'Last commit: ' + info.sha + ' — ' + (info.subject || '')
          + '\n' + (info.when || '') + ' • ' + (info.author || '')
          + '\nFork to work on another branch.';
      }
    });
  }
  const folderBtn = document.getElementById('btnInputFolder');
  if (folderBtn && !folderBtn.dataset.bound) {
    folderBtn.dataset.bound = '1';
    folderBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const folder = await api.pickFolder().catch(() => null);
      if (!folder) return;
      try { await respawnInFolder(folder); } catch (err) { console.error('respawnInFolder', err); alert('Failed to change folder: ' + (err && err.message || err)); }
    });
  }
})();

// Kill the current PTY + xterm and respawn the same agent in a new cwd.
// Used by the input-bar folder pill. Keeps the same threadId (provisional or
// real) so the UI doesn't lose its selection.
async function respawnInFolder(folder) {
  if (!folder) return;
  const tid = st.selectedThreadId;
  if (!tid) { alert('No task selected.'); return; }
  const oldSpawnId = st.spawnByThread[tid];
  // Resolve account: prefer current owner / active profile.
  const thread = (st.allThreads || []).find(t => t.id === tid);
  let accNum = thread ? getThreadEffectiveOwner(thread) : null;
  if (accNum == null) accNum = st.spawnAccount[oldSpawnId];
  if (accNum == null) accNum = st.activeProfileNum;
  const acc = accNum != null ? st.accounts.find(a => a.num === accNum) : null;
  if (!acc) { alert('No active profile to change the folder.'); return; }
  console.log('[respawnInFolder]', { folder, oldSpawnId, accNum: acc.num });
  // Kill old PTY + dispose xterm
  if (oldSpawnId) {
    try { api.killTerminal(oldSpawnId); } catch {}
    if (xtermInstances[oldSpawnId]) {
      // PERF: cleanup the ResizeObserver + debounce timer + rAF handle.
      // Without this we leaked one observer/timer pair per respawnInFolder
      // call, which adds up fast when bouncing between folders.
      try { xtermInstances[oldSpawnId].resize && xtermInstances[oldSpawnId].resize.cleanup(); } catch {}
      try { xtermInstances[oldSpawnId].term.dispose(); } catch {}
      try { xtermInstances[oldSpawnId].pane.remove(); } catch {}
      delete xtermInstances[oldSpawnId];
    }
    delete st.spawnCwd[oldSpawnId];
  }
  // Spawn new
  const projectId = folderToProjectId(folder);
  const newSpawnId = launchTerminal(acc, {
    mode: 'new-folder',
    cwd: folder,
    projectId,
    profileNum: st.activeProfileNum != null ? st.activeProfileNum : acc.num,
  });
  // Re-bind selectedThreadId / spawnByThread to the new spawn
  if (tid === oldSpawnId) {
    // Provisional thread — drop the old mapping, point selection at new spawnId
    if (st.spawnByThread[oldSpawnId] === oldSpawnId) delete st.spawnByThread[oldSpawnId];
    st.spawnByThread[newSpawnId] = newSpawnId;
    st.selectedThreadId = newSpawnId;
  } else {
    // Real thread — keep tid, point it at the new PTY
    st.spawnByThread[tid] = newSpawnId;
  }
  rememberFolder(folder);
  // Show the new xterm
  const xtermHost = document.getElementById('xtermHost');
  if (xtermHost) xtermHost.style.display = '';
  document.getElementById('outputEmpty').classList.add('hidden');
  try { showXtermFor(newSpawnId); } catch {}
  updateInputState();
  updateThreadToolbarWidgets();
}

// Grid version: respawn ONE specific cell in a new folder. Doesn't touch the
// single-view xterm or any other cell. Keeps the cell's position in the grid.
async function respawnGridCellInFolder(thread, oldSpawnId, folder) {
  if (!folder || !thread) return;
  // Resolve which account: thread owner > spawn account > active profile
  let accNum = getThreadEffectiveOwner(thread);
  if (accNum == null && oldSpawnId) accNum = st.spawnAccount[oldSpawnId];
  if (accNum == null) accNum = st.activeProfileNum;
  const acc = accNum != null ? st.accounts.find(a => a.num === accNum) : null;
  if (!acc) { alert('No profile set for this pane.'); return; }
  console.log('[respawnGridCellInFolder]', { folder, oldSpawnId, oldThreadId: thread.id, accNum: acc.num });
  // Tear down old PTY + xterm
  if (oldSpawnId) {
    try { api.killTerminal(oldSpawnId); } catch {}
    disposeGridCellXterm(oldSpawnId);
    delete st.spawnCwd[oldSpawnId];
  }
  // Spawn new
  const projectId = folderToProjectId(folder);
  const newSpawnId = launchTerminal(acc, {
    mode: 'new-folder',
    cwd: folder,
    projectId,
    profileNum: st.activeProfileNum != null ? st.activeProfileNum : acc.num,
  });
  // Re-map: provisional vs real threadId
  const oldThreadId = thread.id;
  const wasProvisional = (oldThreadId === oldSpawnId);
  if (wasProvisional) {
    if (st.gridMode && st.gridMode.threadIds) {
      const idx = st.gridMode.threadIds.indexOf(oldThreadId);
      if (idx >= 0) { st.gridMode.threadIds[idx] = newSpawnId; saveGridStateToStorage(); }
    }
    if (st.spawnByThread[oldThreadId] === oldSpawnId) delete st.spawnByThread[oldThreadId];
    st.spawnByThread[newSpawnId] = newSpawnId;
    if (st.selectedThreadId === oldThreadId) st.selectedThreadId = newSpawnId;
  } else {
    st.spawnByThread[oldThreadId] = newSpawnId;
  }
  rememberFolder(folder);
  renderGrid();
}

// Qual CLI roda (ou rodaria) este pane: agente fixado da thread → do spawn →
// provider da linha do banco.
function paneAgentOf(thread, spawnId) {
  return (thread && st.threadAgents[thread.id])
    || (spawnId && st.spawnAgent[spawnId])
    || (thread && thread.provider === 'claude' ? 'claude' : null)
    || (thread && thread.provider === 'codex' ? 'codex' : null)
    || (spawnId && window.__attention && window.__attention.spawnAgents && (window.__attention.spawnAgents.get(spawnId) || {}).agent)
    || null;
}

/**
 * Reabre o pane como TUI ou chat. Task com sessão = resume da MESMA conversa
 * (os dois modos gravam no mesmo histórico da CLI). Task que ainda não tem
 * sessão (nada enviado) = pane novo na mesma pasta.
 *
 * Sempre com spawnId NOVO: reaproveitar o id deixaria o `terminal-exit` do
 * processo velho cair em cima do novo.
 */
function reopenPaneAs(thread, spawnId, ui) {
  if (!thread) return;
  let accNum = getThreadEffectiveOwner(thread);
  if (accNum == null && spawnId) accNum = st.spawnAccount[spawnId];
  if (accNum == null) accNum = st.activeProfileNum;
  const acc = accNum != null ? st.accounts.find(a => a.num === accNum) : null;
  if (!acc) { showGridBanner('Sem perfil para este pane.', 'warn'); return; }
  const agentId = paneAgentOf(thread, spawnId) || undefined;
  const cwd = thread.cwd || (spawnId && st.spawnCwd[spawnId]) || null;
  const provisional = !!spawnId && thread.id === spawnId;
  const sessionId = provisional ? (NoryaChat.sessionOf(spawnId) || null) : thread.id;

  if (spawnId && st.termRunning[spawnId]) {
    st.releaseOnExit[spawnId] = true;
    killTerminalForSpawn(spawnId);
  }
  if (spawnId) disposeGridCellXterm(spawnId);

  const newSpawnId = 'ui-' + acc.num + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const opts = sessionId
    ? { mode: 'resume', sessionId, cwd, projectId: cwd ? folderToProjectId(cwd) : null, profileNum: acc.num }
    : (cwd ? { mode: 'new-folder', cwd, projectId: folderToProjectId(cwd), profileNum: acc.num } : { mode: 'default', profileNum: acc.num });
  Object.assign(opts, { spawnId: newSpawnId, ui, agentId });
  launchTerminal(acc, opts);

  const ids = st.gridMode && st.gridMode.threadIds;
  if (sessionId) {
    setThreadUi(sessionId, ui);
    st.spawnByThread[sessionId] = newSpawnId;
    if (provisional && ids) {
      // Pane provisório que já tinha sessão: passa a usar o id real.
      const idx = ids.indexOf(thread.id);
      if (idx >= 0) ids[idx] = sessionId;
      if (st.spawnByThread[thread.id] === spawnId) delete st.spawnByThread[thread.id];
      if (st.gridMode.focusedThreadId === thread.id) st.gridMode.focusedThreadId = sessionId;
    }
  } else if (ids) {
    // Sem sessão: o pane novo é provisório até o 1º envio (latch do chat/TUI).
    const idx = ids.indexOf(thread.id);
    if (idx >= 0) ids[idx] = newSpawnId;
    if (st.spawnByThread[thread.id] === spawnId) delete st.spawnByThread[thread.id];
    st.spawnByThread[newSpawnId] = newSpawnId;
    if (st.gridMode.focusedThreadId === thread.id) st.gridMode.focusedThreadId = newSpawnId;
    if (ui === 'chat') {
      NoryaChat.onSession(newSpawnId, realId => {
        if (realId && typeof _latchSpawn === 'function') { _latchSpawn(newSpawnId, realId, acc); refreshThreads().catch(() => {}); }
      });
    }
  }
  saveGridStateToStorage();
  renderGrid();
}

// Effective owner of a thread: prefers explicit thread-owners.json entry, falls
// back to the historical thread.accountNum from the codex DB. This keeps
// existing threads visually owned by their original account even before any
// new interaction sets an explicit owner.
function getThreadEffectiveOwner(thread) {
  if (!thread) return null;
  const explicit = st.threadOwners && st.threadOwners[thread.id];
  if (explicit != null) return explicit;
  return thread.accountNum != null ? thread.accountNum : null;
}

// Resolve which profile should run an *ownerless* thread, honoring its CLI
// provider (Norya 2026-06-13 QA fix). Without this, a Claude thread
// (accountNum:null — every Claude thread is one) opened while a Codex profile
// was active ran `codex resume` on a Claude session id and dumped a raw
// "No saved session found" error into the terminal — ~64% of the sidebar was
// affected. Prefers the active profile when it already matches the provider,
// then a healthy matching profile, then any matching one; returns null when no
// profile of the right provider exists so the caller can warn instead of
// spawning the wrong CLI.
function pickProfileForProvider(provider) {
  // Resolve por CREDENCIAL REAL, não por authMode legado: no mundo
  // multi-provider um perfil pode ter Claude + Codex ao mesmo tempo, então
  // quem "combina" com o provider é quem tem a credencial dele no accounts/N/.
  const matches = (a) => profileHasProvider(a, provider || 'codex');
  const healthy = (a) => { try { return getProfileHealth(a, st.quota[String(a.num)]).ok; } catch { return false; } };
  const active = st.accounts.find(a => a.num === st.activeProfileNum);
  if (active && matches(active)) return active;
  return st.accounts.find(a => matches(a) && healthy(a))
      || st.accounts.find(a => matches(a))
      || null;
}

// Gap 2: detect consult mode (viewing a thread whose owner is not the active profile)
function isConsultMode() {
  const tid = st.selectedThreadId;
  if (!tid) return false;
  const thread = (st.allThreads || []).find(t => t.id === tid);
  const owner = getThreadEffectiveOwner(thread);
  if (owner == null) return false;
  return owner !== st.activeProfileNum;
}

function renderConsultBanner() {
  const existing = document.getElementById('consultBanner');
  if (existing) existing.remove();
  if (!isConsultMode()) return;
  const thread = (st.allThreads || []).find(t => t.id === st.selectedThreadId);
  const owner = getThreadEffectiveOwner(thread);
  const ownerAcc = st.accounts.find(a => a.num === owner);
  const activeAcc = st.accounts.find(a => a.num === st.activeProfileNum);
  if (!ownerAcc) return;

  const banner = document.createElement('div');
  banner.className = 'consult-banner';
  banner.id = 'consultBanner';

  const dot = document.createElement('span');
  dot.className = 'consult-banner-dot';
  dot.style.background = ownerAcc.color || 'var(--accent)';
  banner.appendChild(dot);

  const text = document.createElement('div');
  text.className = 'consult-banner-text';
  const activeName = activeAcc ? (activeAcc.name || 'Profile ' + st.activeProfileNum) : '(none)';
  const ownerName = ownerAcc.name || 'Profile ' + owner;
  const part1 = document.createTextNode('Consult mode: you are ');
  const strong1 = document.createElement('strong'); strong1.textContent = activeName;
  const part2 = document.createTextNode(', but this task belongs to ');
  const strong2 = document.createElement('strong'); strong2.textContent = ownerName;
  const part3 = document.createTextNode('. Sending disabled.');
  text.append(part1, strong1, part2, strong2, part3);
  banner.appendChild(text);

  const btn = document.createElement('button');
  btn.className = 'consult-banner-btn';
  btn.textContent = 'Act as ' + ownerName;
  btn.addEventListener('click', () => {
    setActiveProfile(owner);
  });
  banner.appendChild(btn);

  const xtermHost = document.getElementById('xtermHost');
  if (xtermHost && xtermHost.parentNode) xtermHost.parentNode.insertBefore(banner, xtermHost);
}

// Bind Fork button (idempotent)
(function bindForkBtn() {
  const btn = document.getElementById('btnFork');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => forkCurrentThread());
  }
})();

// ── Fase 8: Merge button on thread toolbar + agent resolver ──────────────────
// Precheck cache: { [projectDir]: { ts, conflictBranches, cleanBranches } }
const _mergePrecheckCache = {};
const PRECHECK_TTL_MS = 60 * 1000; // 60s

function _applyMergeBadge(state, tooltipExtra) {
  const dot = document.getElementById('mergeBadgeDot');
  if (!dot) return;
  dot.classList.remove('clean', 'conflict', 'empty');
  dot.classList.add(state);
  if (tooltipExtra) dot.title = tooltipExtra;
}

async function refreshMergePrecheck(projectDir) {
  if (!projectDir) return;
  const cached = _mergePrecheckCache[projectDir];
  if (cached && (Date.now() - cached.ts) < PRECHECK_TTL_MS) {
    _applyMergeBadge(cached.conflictBranches > 0 ? 'conflict' : (cached.cleanBranches > 0 ? 'clean' : 'empty'),
      cached.conflictBranches > 0
        ? `🔴 ${cached.conflictBranches} conflict branch(es), ${cached.cleanBranches} clean`
        : (cached.cleanBranches > 0 ? `🟢 ${cached.cleanBranches} clean branch(es) ready to merge` : 'No branches to merge'));
    return;
  }
  if (!api.gitMergePrecheck) return;
  try {
    const res = await api.gitMergePrecheck(projectDir, null);
    if (res && !res.error) {
      _mergePrecheckCache[projectDir] = {
        ts: Date.now(),
        conflictBranches: res.conflictBranches || 0,
        cleanBranches: res.cleanBranches || 0,
      };
      // Only re-apply if the current selected thread still points to this dir
      const tid = st.selectedThreadId;
      const t = (st.allThreads || []).find(x => x.id === tid);
      if (t && t.cwd === projectDir) {
        _applyMergeBadge(
          res.conflictBranches > 0 ? 'conflict' : (res.cleanBranches > 0 ? 'clean' : 'empty'),
          res.conflictBranches > 0
            ? `🔴 ${res.conflictBranches} conflict branch(es), ${res.cleanBranches} clean`
            : (res.cleanBranches > 0 ? `🟢 ${res.cleanBranches} clean branch(es) ready to merge` : 'No branches to merge'));
      }
    }
  } catch {}
}

function updateMergeButtonState() {
  const btn = document.getElementById('btnMergeToolbar');
  if (!btn) return;
  const threadId = st.selectedThreadId;
  const thread = (st.allThreads || []).find(t => t.id === threadId);
  const cwd = thread && thread.cwd;
  const gitInfo = cwd ? _gitInfoByCwd[cwd] : null;
  const hasGit = gitInfo && gitInfo.hasGit;
  if (!threadId || !hasGit) {
    btn.classList.add('disabled');
    btn.title = !threadId ? 'Open a thread in a project with Workspaces'
                          : 'Enable Norya Workspaces for this project to do merges';
    _applyMergeBadge('empty', 'Pre-merge status');
  } else {
    btn.classList.remove('disabled');
    btn.title = kc('Merge Queue: analyze and merge this project branches (⌘⇧M)');
    // Kick off precheck (cached); badge updates async.
    refreshMergePrecheck(cwd);
  }
}

(function bindMergeBtn() {
  const btn = document.getElementById('btnMergeToolbar');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      if (btn.classList.contains('disabled')) return;
      // Pre-select project = current thread's project dir
      if (typeof openMergeQueueModal === 'function') openMergeQueueModal();
      const sel = document.getElementById('mqProjectSel');
      const thread = (st.allThreads || []).find(t => t.id === st.selectedThreadId);
      if (sel && thread && thread.cwd) {
        // Find option matching this cwd (or its repo root) — set if present
        for (const opt of sel.options) {
          if (opt.value && (opt.value === thread.cwd || thread.cwd.startsWith(opt.value + '/'))) {
            sel.value = opt.value; break;
          }
        }
      }
    });
  }
})();

// Spawn a "merge agent" thread to resolve conflicts. Uses the active profile
// temporarily — UI shows an explicit banner about this until the dedicated
// Norya agent ships.
function spawnMergeAgent({ projectDir, baseBranch, conflictBranch, conflictFiles }) {
  const acc = st.accounts.find(a => a.num === st.activeProfileNum);
  if (!acc) { window.alert('Select an active profile (bottom-left) before invoking the agent'); return; }

  const projectId = folderToProjectId(projectDir);
  const prompt = [
    'I am in a Git merge conflict and need your help to resolve it.',
    '',
    'Directory: ' + projectDir,
    'Branch base: ' + baseBranch,
    'Branch sendo mergeada: ' + conflictBranch,
    conflictFiles && conflictFiles.length ? 'Conflicting files:\n  - ' + conflictFiles.join('\n  - ') : '',
    '',
    'Please:',
    '  1. Inspect each conflicting file (look for the markers <<<<<<<, =======, >>>>>>>)',
    '  2. Resolve while preserving the intent of both branches where possible',
    '  3. Quando terminar, rode:  git add . && git commit --no-edit',
    '  4. Reporte um resumo curto do que foi mudado em cada arquivo',
    '',
    '⚠ I (the Norya UI) am using you as a temporary merge agent — a dedicated agent is coming soon.',
  ].filter(Boolean).join('\n');

  const spawnId = launchTerminal(acc, {
    mode: 'new-folder',
    cwd: projectDir,
    projectId,
    profileNum: st.activeProfileNum,
  });

  // Send prompt after codex starts
  setTimeout(() => api.sendInput(spawnId, prompt + '\r'), 1200);

  // Latch new session id then mark this thread as "merge"
  const sinceMs = Date.now() - 500;
  let latched = false;
  async function pollNew(tries) {
    if (latched) return;
    try {
      const r = await api.findLatestSession(acc.num, sinceMs);
      if (r && r.sessionId) {
        latched = true;
        st.selectedThreadId = r.sessionId;
        st.spawnByThread[r.sessionId] = spawnId;
        api.threadOwnerSet(r.sessionId, st.activeProfileNum).catch(() => {});
        st.threadOwners[r.sessionId] = st.activeProfileNum;
        // Auto-rename thread to "Merge: <conflictBranch> → <baseBranch>"
        api.renameThread(acc.num, r.sessionId, `Merge: ${conflictBranch} → ${baseBranch}`).catch(() => {});
        try { st.allThreads = await api.listThreads(null, null) || []; invalidateSidebarCache(); renderProjectList(); } catch {}
        // Show merge agent banner above chat
        showMergeAgentBanner(acc.name || 'Profile ' + acc.num);
        updateInputState();
        return;
      }
    } catch {}
    if (tries > 0) setTimeout(() => pollNew(tries - 1), 600);
  }
  setTimeout(() => pollNew(30), 600);

  // Close the merge queue modal so user sees the new thread
  const mqModal = document.getElementById('modalMergeQueue');
  if (mqModal) mqModal.classList.add('hidden');
}

function showMergeAgentBanner(profileName) {
  // Remove existing banner if any
  const existing = document.getElementById('mergeAgentBanner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  // Subtler info-style banner: lower-contrast, dismissible, with "future" link
  banner.className = 'merge-agent-banner info';
  banner.id = 'mergeAgentBanner';
  // Use a small info-circle icon (less alarming than the original triangle)
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('fill', 'none');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '8'); circle.setAttribute('cy', '8'); circle.setAttribute('r', '6.5');
  circle.setAttribute('stroke', 'currentColor'); circle.setAttribute('stroke-width', '1.3');
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', '8'); dot.setAttribute('cy', '5.2'); dot.setAttribute('r', '0.9');
  dot.setAttribute('fill', 'currentColor');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', 'M8 7.5v4');
  line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '1.3');
  line.setAttribute('stroke-linecap', 'round');
  icon.appendChild(circle); icon.appendChild(dot); icon.appendChild(line);
  banner.appendChild(icon);
  const text = document.createElement('span');
  text.style.flex = '1';
  text.textContent = 'Merge agent active — using profile "' + profileName + '" temporariamente.';
  banner.appendChild(text);
  const futureLink = document.createElement('button');
  futureLink.className = 'merge-agent-banner-link';
  futureLink.textContent = 'How it will work in the future';
  futureLink.title = 'Coming soon: a dedicated Norya merge agent, independent of the active profile, with its own automatic-resolution pipeline + reviewable diff.';
  futureLink.addEventListener('click', () => {
    alert([
      'How it will work in the future:',
      '',
      '• Dedicated Norya merge agent (does not use the active profile)',
      '• Its own pipeline: analysis → automatic attempt → reviewable diff',
      '• Side-by-side assisted resolution of the hunks in the task itself',
      '• Structured history per project (already available in the History tab)',
      '',
      'For now, the active profile is used as a temporary agent.',
    ].join('\n'));
  });
  banner.appendChild(futureLink);
  const close = document.createElement('button');
  close.className = 'merge-agent-banner-close';
  close.title = 'Dispensar';
  close.textContent = '×';
  close.addEventListener('click', () => banner.remove());
  banner.appendChild(close);
  // Insert at top of the output area
  const xtermHost = document.getElementById('xtermHost');
  if (xtermHost && xtermHost.parentNode) {
    xtermHost.parentNode.insertBefore(banner, xtermHost);
  }
  // Persistence: mark the most-recent failed merge as "agent used"
  if (_mqLastConflictResolve && api.mergeHistoryMarkAgent) {
    api.mergeHistoryList().then(res => {
      const rec = (res && res.records || []).find(r =>
        r.projectDir === _mqLastConflictResolve.projectDir
        && r.stoppedAt === _mqLastConflictResolve.conflictBranch
        && !r.agentUsed);
      if (rec) api.mergeHistoryMarkAgent(rec.ts, profileName).catch(() => {});
    }).catch(() => {});
  }
}

