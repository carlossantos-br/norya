/**
 * renderer/modals.js — modais (rename/delete/add), view select, kill, sidebar colapsável, send, paleta ⌘K, init().
 *
 * Script CLÁSSICO (ver renderer/state.js): fatia contígua extraída de
 * test-window.html em 2026-07-10, na ordem original. Compartilha o escopo
 * léxico global com os outros — `st`, `api`, `ipcRenderer` e as funções de
 * cada fatia enxergam-se sem import. Ordem de carga preservada = zero mudança
 * de comportamento.
 */
'use strict';

// ── Rename modal ─────────────────────────────────────────────────────────────
let renameTargetAcc = null;

function openRenameModal(acc) {
  renameTargetAcc = acc;
  document.getElementById('renameInput').value = acc.name || '';
  document.getElementById('modalRename').classList.remove('hidden');
  document.getElementById('renameInput').focus();
}

document.getElementById('btnRenameCancel').addEventListener('click', () => {
  document.getElementById('modalRename').classList.add('hidden');
});

document.getElementById('btnRenameConfirm').addEventListener('click', async () => {
  const acc = renameTargetAcc;
  if (!acc) return;
  const name = document.getElementById('renameInput').value.trim();
  if (!name) return;
  await api.renameAccount(acc.num, name).catch(() => {});
  acc.name = name;
  renderAccountItem(acc.num);
  updateHeader();
  document.getElementById('modalRename').classList.add('hidden');
});

document.getElementById('renameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnRenameConfirm').click();
  if (e.key === 'Escape') document.getElementById('btnRenameCancel').click();
});

// ── Delete modal ─────────────────────────────────────────────────────────────
let deleteTargetAcc = null;

function openDeleteModal(acc) {
  deleteTargetAcc = acc;
  document.getElementById('deleteMsg').textContent =
    `Delete the profile "${acc.name || 'Profile ' + acc.num}"?\n\nThe profile will be removed from the list. Tasks it created stay accessible (without an owner color). Only the identity (name, color, key) is discarded.`;
  document.getElementById('modalDelete').classList.remove('hidden');
}

document.getElementById('btnDeleteCancel').addEventListener('click', () => {
  document.getElementById('modalDelete').classList.add('hidden');
});

document.getElementById('btnDeleteConfirm').addEventListener('click', async () => {
  const acc = deleteTargetAcc;
  if (!acc) return;
  const r = await api.deleteAccount(acc.num).catch(err => ({ error: String(err && err.message || err) }));
  if (r && r.error) { window.alert('Error: ' + r.error); return; }
  st.accounts = st.accounts.filter(a => a.num !== acc.num);
  if (st.activeProfileNum === acc.num && typeof setActiveProfile === 'function') {
    setActiveProfile(null);
  }
  if (st.selectedAccountNum === acc.num) {
    st.selectedAccountNum = null;
    st.selectedThreadId = null;
  }
  if (typeof _profilesTabExpanded !== 'undefined') _profilesTabExpanded.delete(acc.num);
  renderAccountList();
  renderProjectList();
  if (typeof renderProfileButton === 'function') renderProfileButton();
  if (typeof renderProfilesTab === 'function') renderProfilesTab();
  updateHeader();
  showEmptyState();
  document.getElementById('modalDelete').classList.add('hidden');
  deleteTargetAcc = null;
});

// ── Add account modal ─────────────────────────────────────────────────────────
function openAddModal() {
  document.getElementById('addAccName').value = '';
  document.getElementById('modalAdd').classList.remove('hidden');
  document.getElementById('addAccName').focus();
}

document.getElementById('btnAddAcc').addEventListener('click', openAddModal);

document.getElementById('btnAddCancel').addEventListener('click', () => {
  document.getElementById('modalAdd').classList.add('hidden');
});

document.getElementById('btnAddConfirm').addEventListener('click', async () => {
  const name = document.getElementById('addAccName').value.trim();
  if (!name) return;
  const result = await api.addAccount({ name }).catch(err => { console.error('addAccount failed', err); return null; });
  if (!result || result.error) {
    window.alert('Could not create the profile: ' + ((result && result.error) || 'unknown error'));
    return;
  }
  st.accounts = await api.getAccounts().catch(() => st.accounts);
  renderAccountList();
  renderProfileButton();
  document.getElementById('modalAdd').classList.add('hidden');
  document.getElementById('addAccName').value = '';
  // If we're in the Profiles settings tab, refresh and auto-expand the new card
  const settingsModal = document.getElementById('modalSettings');
  if (settingsModal && !settingsModal.classList.contains('hidden')) {
    if (typeof _profilesTabExpanded !== 'undefined' && result.num) {
      _profilesTabExpanded.add(result.num);
    }
    if (typeof renderProfilesTab === 'function') renderProfilesTab();
  }
});

document.getElementById('addAccName').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnAddConfirm').click();
  if (e.key === 'Escape') document.getElementById('btnAddCancel').click();
});

// ── Kill terminal ─────────────────────────────────────────────────────────────
document.getElementById('btnKillTerminal').addEventListener('click', () => killTerminalForNum(st.selectedAccountNum));
document.getElementById('btnCloseThread').addEventListener('click', () => { try { closeOpenThread(); } catch (e) { console.warn('closeOpenThread failed', e); } });
// Change the active thread's working folder — picks a dir then respawns the PTY
// there (the thread keeps its identity). Replaces the removed input-bar pill.
document.getElementById('btnThreadFolder').addEventListener('click', async () => {
  const folder = await api.pickFolder().catch(() => null);
  if (!folder) return;
  try { await respawnInFolder(folder); }
  catch (e) { console.error('respawnInFolder', e); alert('Failed to change folder: ' + (e && e.message || e)); }
});

// ── Collapsible sidebar ───────────────────────────────────────────────────────
// Slides the rail away (width→0) and lets .main reclaim the space. State persists
// across launches. Toggle: click the rail's already-active button (rail.js) or ⌘.
// (period) — the dedicated header button was removed 2026-07-10.
function setSidebarCollapsed(collapsed, opts) {
  const silent = opts && opts.silent;
  // On silent restore (page load), suppress the slide so the rail paints already
  // collapsed instead of animating 280→0 on first frame.
  const sb = document.querySelector('.sidebar');
  if (silent && sb) sb.style.transition = 'none';
  document.body.classList.toggle('sidebar-collapsed', !!collapsed);
  if (silent && sb) { void sb.offsetWidth; requestAnimationFrame(() => { sb.style.transition = ''; }); }
  try { localStorage.setItem('norya-sidebar-collapsed', collapsed ? '1' : '0'); } catch {}
  // The terminal width changed — refit after the slide finishes so xterm reflows
  // to the new column count (single-view + every grid pane). Skip on silent restore.
  if (!opts || !opts.silent) {
    setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch {} }, 260);
  }
}
function toggleSidebar() {
  setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
}
window.addEventListener('keydown', e => {
  // ⌘. / Ctrl+. toggles the sidebar (⌘B is taken by the browser panel).
  if ((e.metaKey || e.ctrlKey) && e.key === '.' && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    toggleSidebar();
  }
  // ⌘, abre as configurações (padrão do macOS; a linha "Settings ⌘," no
  // rodapé da sidebar anuncia o atalho).
  if ((e.metaKey || e.ctrlKey) && e.key === ',' && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (typeof openSettings === 'function') openSettings('general');
  }
});
// Botões de recolher/expandir (2026-09-07): o da barra da sidebar esconde; o
// do header principal só aparece com a sidebar recolhida e traz de volta.
document.getElementById('sidebarToggle')?.addEventListener('click', toggleSidebar);
document.getElementById('sidebarExpand')?.addEventListener('click', toggleSidebar);
// Restore persisted state without animating on first paint.
try { if (localStorage.getItem('norya-sidebar-collapsed') === '1') setSidebarCollapsed(true, { silent: true }); } catch {}

// ── Largura da sidebar (arrastável, 2026-09-07) ──────────────────────────────
// A ref tem 217px; o padrão aqui é --sidebar-w (styles.css). A alça na borda
// direita ajusta entre MIN e MAX e persiste; duplo clique volta ao padrão.
(function bindSidebarResizer() {
  const MIN = 200, MAX = 360, KEY = 'norya-sidebar-width';
  const root = document.documentElement;
  const apply = w => root.style.setProperty('--sidebar-w', Math.round(w) + 'px');
  try {
    const saved = parseInt(localStorage.getItem(KEY), 10);
    if (saved >= MIN && saved <= MAX) apply(saved);
  } catch {}
  const handle = document.getElementById('sidebarResizer');
  const sb = document.getElementById('sidebar');
  if (!handle || !sb) return;
  const refit = () => setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch {} }, 0);
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = sb.getBoundingClientRect().width;
    document.body.classList.add('sidebar-resizing');
    const move = ev => apply(Math.min(MAX, Math.max(MIN, startW + ev.clientX - startX)));
    const up = () => {
      document.body.classList.remove('sidebar-resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      try { localStorage.setItem(KEY, String(Math.round(sb.getBoundingClientRect().width))); } catch {}
      refit();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  handle.addEventListener('dblclick', () => {
    root.style.removeProperty('--sidebar-w');
    try { localStorage.removeItem(KEY); } catch {}
    refit();
  });
})();
document.getElementById('inputKillBtn').addEventListener('click', () => {
  const spawnId = st.selectedThreadId && st.spawnByThread[st.selectedThreadId];
  if (spawnId) killTerminalForSpawn(spawnId);
  else killTerminalForNum(st.selectedAccountNum);
});

// ── Send ───────────────────────────────────────────────────────────────────────
document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('inputField').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
document.getElementById('inputField').addEventListener('input', function() {
  autoResize(this);
  // Re-evaluate send-enable through the SINGLE source of truth (thread-keyed +
  // noProfile + consult), not the old account-keyed shortcut that re-enabled Send
  // even in consult / no-active-profile states.
  updateInputState();
});

// ── New thread button ─────────────────────────────────────────────────────────
document.getElementById('btnNewThread').addEventListener('click', startNewThread);

// ── Full thread-title tooltip (custom, fast) ───────────────────────────────────
// Delegated on the stable #projectList so it survives every re-render. Shows the
// hovered row's full (untruncated) title after a short delay. (2026-06-28)
(function initThreadTooltip() {
  const list = document.getElementById('projectList');
  if (!list || list.dataset.tipBound) return;
  list.dataset.tipBound = '1';
  let tip = null, showTimer = null, curRow = null;
  function ensureTip() {
    if (!tip) { tip = document.createElement('div'); tip.className = 'norya-thread-tip'; document.body.appendChild(tip); }
    return tip;
  }
  function position(row) {
    const t = ensureTip();
    const r = row.getBoundingClientRect();
    t.style.left = Math.max(6, Math.min(r.left + 6, window.innerWidth - t.offsetWidth - 8)) + 'px';
    const above = r.top - t.offsetHeight - 6;
    t.style.top = (above < 6 ? r.bottom + 6 : above) + 'px';
  }
  function show(row) {
    const full = row.dataset.fullTitle;
    if (!full) return;
    const t = ensureTip();
    t.textContent = full;
    t.classList.remove('show');
    t.style.left = '-9999px'; t.style.top = '0px';
    requestAnimationFrame(() => { position(row); t.classList.add('show'); });
  }
  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (tip) tip.classList.remove('show');
    curRow = null;
  }
  list.addEventListener('mouseover', e => {
    const row = e.target.closest('.thread-item');
    if (!row || row === curRow) return;
    curRow = row;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => show(row), 220);
  });
  list.addEventListener('mouseout', e => {
    const row = e.target.closest('.thread-item');
    if (!row) return;
    if (e.relatedTarget && row.contains(e.relatedTarget)) return;
    hide();
  });
  list.addEventListener('scroll', hide, true);
  window.addEventListener('scroll', hide, true);
})();

// ── Keyboard shortcuts ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); startNewThread(); }
  // ⌘\ → toggle raw terminal (useful for aider y/n prompts or debugging)
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    toggleRawTerminal();
  }
  // ⌘⇧M → open Merge Queue, pre-selecting the current thread's project
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    if (typeof openMergeQueueModal === 'function') {
      openMergeQueueModal();
      // Pre-select the active thread's project dir if available
      try {
        const sel = document.getElementById('mqProjectSel');
        const thread = (st.allThreads || []).find(t => t.id === st.selectedThreadId);
        if (sel && thread && thread.cwd) {
          for (const opt of sel.options) {
            if (opt.value && (opt.value === thread.cwd || thread.cwd.startsWith(opt.value + '/'))) {
              sel.value = opt.value; break;
            }
          }
        }
      } catch {}
    }
    return;
  }
  // Norya forks 2026-05-26:
  // ⌘⇧F → open fork modal for the current thread.
  // ⌘⌥F → quick fork (no modal, defaults).
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    const t = (st.allThreads || []).find(x => x.id === st.selectedThreadId);
    if (t && t.cwd) openForkModal(t);
    else showForkToast({ kind: 'warn', title: 'Fork unavailable', msg: 'Select a thread first.', duration: 2500 });
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'f' || e.key === 'F' || e.key === 'ƒ')) {
    e.preventDefault();
    const t = (st.allThreads || []).find(x => x.id === st.selectedThreadId);
    if (t && t.cwd) quickForkThread(t);
    else showForkToast({ kind: 'warn', title: 'Fork unavailable', msg: 'Select a thread first.', duration: 2500 });
    return;
  }
  if (e.key === 'Escape') {
    closeCtxMenu();
    hideQuotaCard();
    hideNewThreadPanel();
    document.getElementById('lightbox').classList.add('hidden');
    document.getElementById('modalSettings').classList.add('hidden');
    document.getElementById('modalRename').classList.add('hidden');
    document.getElementById('modalDelete').classList.add('hidden');
    document.getElementById('modalAdd').classList.add('hidden');
    closeForkModal();
  }
});

// Norya forks: wire fork modal buttons + slug input live preview
(function bindForkModal() {
  const cancel = document.getElementById('btnForkCancel');
  const confirm = document.getElementById('btnForkConfirm');
  const slug = document.getElementById('forkSlugInput');
  const overlay = document.getElementById('modalFork');
  if (cancel && !cancel.dataset.bound) {
    cancel.dataset.bound = '1';
    cancel.addEventListener('click', () => closeForkModal());
  }
  if (confirm && !confirm.dataset.bound) {
    confirm.dataset.bound = '1';
    confirm.addEventListener('click', () => _confirmForkModal());
  }
  if (slug && !slug.dataset.bound) {
    slug.dataset.bound = '1';
    slug.addEventListener('input', () => {
      _forkModalSlugManuallyEdited = true;
      _updateForkPreview();
      document.getElementById('forkModalErr').classList.remove('visible');
    });
    slug.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); _confirmForkModal(); }
    });
  }
  // Click on backdrop closes (matches other modals' pattern)
  if (overlay && !overlay.dataset.bound) {
    overlay.dataset.bound = '1';
    overlay.addEventListener('click', e => { if (e.target === overlay) closeForkModal(); });
  }
})();

// Norya forks: lineage cache is loaded by init() (see above). No need
// to trigger here — kept as a comment marker for searchability.


// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ agent/ux — UX flows (additive, non-invasive)                              ║
// ║ Command palette, shortcut overview, quick-switch, status bar, toasts,     ║
// ║ undo for destructive actions, onboarding empty state, custom confirms.    ║
// ║ Single self-contained IIFE. Safe to revert by deleting this block.        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
(function () {
  'use strict';

  // ── helper: build elements ──────────────────────────────────────────
  function h(tag, props, children) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        if (k === 'class') el.className = props[k];
        else if (k === 'style') el.style.cssText = props[k];
        else if (k === 'text') el.textContent = props[k];
        else if (k === 'on' && props[k]) {
          for (const ev of Object.keys(props[k])) el.addEventListener(ev, props[k][ev]);
        } else if (k.startsWith('data-')) el.setAttribute(k, props[k]);
        else el[k] = props[k];
      }
    }
    if (children) for (const c of children) if (c != null) el.appendChild(c);
    return el;
  }

  // ── 0. Inject CSS additively ────────────────────────────────────────────
  const _uxStyle = document.createElement('style');
  _uxStyle.id = 'norya-ux-styles';
  _uxStyle.textContent = `
/* ── Toast container & cards ──────────────────────────────────────────── */
#noryaToastHost {
  position: fixed; bottom: 32px; right: 18px; z-index: 1200;
  display: flex; flex-direction: column; gap: 8px;
  pointer-events: none;
  max-width: 360px;
}
.norya-toast {
  pointer-events: auto;
  background: var(--modal-bg);
  color: var(--text);
  border: 1px solid var(--modal-border);
  border-radius: 10px;
  box-shadow: var(--shadow-3);
  padding: 10px 14px 10px 14px;
  font-size: 13px; line-height: 1.45;
  display: flex; align-items: flex-start; gap: 10px;
  min-width: 220px; max-width: 360px;
  animation: noryaToastIn 0.2s cubic-bezier(0.2,0.8,0.2,1);
}
.norya-toast.exiting { animation: noryaToastOut 0.18s ease forwards; }
.norya-toast .nt-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; background: var(--text-muted); }
.norya-toast.info .nt-dot { background: #4a8bff; }
.norya-toast.success .nt-dot { background: #2dbb6c; }
.norya-toast.warn .nt-dot { background: #f0a93b; }
.norya-toast.error .nt-dot { background: #dc4a4a; }
.norya-toast .nt-body { flex: 1; min-width: 0; }
.norya-toast .nt-msg { word-wrap: break-word; }
.norya-toast .nt-actions { display: flex; gap: 8px; margin-top: 6px; }
.norya-toast .nt-btn {
  background: transparent; border: none; padding: 0;
  color: var(--accent); font-size: 12px; font-weight: 600;
  cursor: pointer; text-decoration: none;
}
.norya-toast .nt-btn:hover { text-decoration: underline; }
.norya-toast .nt-close {
  background: none; border: none; cursor: pointer;
  color: var(--text-faint); font-size: 14px; line-height: 1;
  padding: 0 2px; margin-left: 4px;
}
.norya-toast .nt-close:hover { color: var(--text); }
.norya-toast .nt-details {
  margin-top: 6px; padding: 6px 8px; border-radius: 6px;
  background: var(--input-bg); color: var(--text-muted);
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px; max-height: 140px; overflow: auto;
  white-space: pre-wrap; word-break: break-word;
}
@keyframes noryaToastIn {
  from { opacity: 0; transform: translateY(8px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0)    scale(1); }
}
@keyframes noryaToastOut {
  to { opacity: 0; transform: translateY(6px) scale(0.98); }
}

/* ── Command palette ──────────────────────────────────────────────────── */
#noryaPalette {
  position: fixed; inset: 0; z-index: 1100;
  background: rgba(0,0,0,0.32);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 14vh;
  animation: noryaPaletteFade 0.16s ease;
}
#noryaPalette.hidden { display: none; }
.np-box {
  width: 560px; max-width: 92vw;
  background: var(--modal-bg);
  border: 1px solid var(--modal-border);
  border-radius: 14px;
  box-shadow: var(--shadow-4);
  overflow: hidden;
  display: flex; flex-direction: column;
  max-height: 64vh;
  animation: noryaPaletteIn 0.18s cubic-bezier(0.2,0.8,0.2,1);
}
.np-input-row {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--modal-border);
}
.np-icon { color: var(--text-faint); font-size: 14px; }
.np-input {
  flex: 1; border: none; outline: none; background: transparent;
  color: var(--text); font-size: 15px;
}
.np-input::placeholder { color: var(--text-faint); }
.np-hint { color: var(--text-faint); font-size: 11px; flex-shrink: 0; }
.np-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.np-list::-webkit-scrollbar { width: 6px; }
.np-list::-webkit-scrollbar-thumb { background: var(--sidebar-border); border-radius: 4px; }
.np-section-label {
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-faint);
  padding: 8px 16px 4px;
}
.np-item {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 16px; cursor: pointer;
  color: var(--text); font-size: 13px;
  border-left: 2px solid transparent;
}
.np-item .np-item-icon {
  width: 18px; height: 18px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; font-size: 11px; color: var(--text-muted);
  background: var(--sidebar-active);
}
.np-item .np-item-main { flex: 1; min-width: 0; overflow: hidden; }
.np-item .np-item-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-item .np-item-sub {
  font-size: 11px; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.np-item .np-item-kind {
  font-size: 10px; color: var(--text-faint); flex-shrink: 0;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.np-item.active {
  background: var(--sidebar-hover);
  border-left-color: var(--accent);
}
.np-item.active .np-item-icon { background: var(--accent-light); color: var(--accent); }
.np-empty {
  padding: 24px 16px; text-align: center;
  color: var(--text-faint); font-size: 13px;
}
@keyframes noryaPaletteFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes noryaPaletteIn {
  from { opacity: 0; transform: translateY(-8px) scale(0.985); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ── Shortcut overview ────────────────────────────────────────────────── */
#noryaShortcutsModal {
  position: fixed; inset: 0; z-index: 1100;
  background: rgba(0,0,0,0.32);
  display: flex; align-items: center; justify-content: center;
}
#noryaShortcutsModal.hidden { display: none; }
.ns-box {
  width: 560px; max-width: 92vw; max-height: 78vh;
  background: var(--modal-bg);
  border: 1px solid var(--modal-border);
  border-radius: 14px;
  box-shadow: var(--shadow-4);
  display: flex; flex-direction: column; overflow: hidden;
  animation: noryaPaletteIn 0.18s cubic-bezier(0.2,0.8,0.2,1);
}
.ns-header {
  padding: 14px 18px; border-bottom: 1px solid var(--modal-border);
  display: flex; align-items: center; justify-content: space-between;
}
.ns-title { font-size: 14px; font-weight: 600; color: var(--text); }
.ns-close {
  background: none; border: none; cursor: pointer;
  color: var(--text-muted); font-size: 18px; line-height: 1;
  padding: 2px 6px; border-radius: 4px;
}
.ns-close:hover { background: var(--sidebar-hover); color: var(--text); }
.ns-body { padding: 14px 18px 18px; overflow-y: auto; }
.ns-group { margin-bottom: 14px; }
.ns-group-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 6px;
}
.ns-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 0; font-size: 13px; color: var(--text);
}
.ns-row + .ns-row { border-top: 1px dashed var(--sidebar-border); }
.ns-row .ns-label { flex: 1; color: var(--text-muted); }
.ns-keys { display: inline-flex; gap: 3px; }
.ns-keys .kbd {
  background: var(--kbd-bg); color: var(--kbd-text);
  font-size: 11px; padding: 1px 5px; border-radius: 3px;
  border: 1px solid var(--sidebar-border); font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}

/* ── Status bar (bottom) ──────────────────────────────────────────────── */
#noryaStatusBar {
  position: fixed; left: 0; right: 0; bottom: 0;
  height: 26px;
  background: var(--header-bg);
  border-top: 1px solid var(--header-border);
  display: flex; align-items: center; gap: 14px;
  padding: 0 12px;
  font-size: 11px; color: var(--text-muted);
  z-index: 80;
  user-select: none;
  -webkit-app-region: drag;
}
#noryaStatusBar .nsb-item {
  display: inline-flex; align-items: center; gap: 5px;
  cursor: pointer;
  -webkit-app-region: no-drag;
  padding: 2px 6px; border-radius: 4px;
  transition: background-color 0.12s ease, color 0.12s ease;
}
#noryaStatusBar .nsb-item:hover { background: var(--sidebar-hover); color: var(--text); }
#noryaStatusBar .nsb-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--text-faint);
  display: inline-block;
}
#noryaStatusBar .nsb-spacer { flex: 1; }
#noryaStatusBar .nsb-item.dim { opacity: 0.6; }
/* Lift the app 22px so the status bar doesn't cover content. .app is
   height:100vh — override to leave 22px for the status bar. */
body.norya-ux-statusbar .app { height: calc(100vh - 26px); }

/* ── Onboarding empty state cards ─────────────────────────────────────── */
.norya-onboard {
  display: flex; flex-direction: column; align-items: center;
  gap: 14px; padding: 18px;
  width: 100%; max-width: 480px;
}
.norya-onboard h3 {
  font-size: 15px; font-weight: 600; color: var(--text);
  margin: 0;
}
.norya-onboard p {
  font-size: 13px; color: var(--text-muted); margin: 0 0 4px;
  text-align: center;
}
.norya-onboard-cards { display: flex; flex-direction: column; gap: 10px; width: 100%; }
.norya-onboard-card {
  background: var(--sidebar-bg);
  border: 1px solid var(--modal-border);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex; align-items: center; gap: 12px;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.norya-onboard-card.active { border-color: var(--accent); }
.norya-onboard-card.done { opacity: 0.55; }
.norya-onboard-step {
  width: 26px; height: 26px; border-radius: 50%;
  background: var(--sidebar-active); color: var(--text-muted);
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 12px; flex-shrink: 0;
}
.norya-onboard-card.active .norya-onboard-step { background: var(--accent); color: #fff; }
.norya-onboard-card.done .norya-onboard-step { background: #2dbb6c; color: #fff; }
.norya-onboard-body { flex: 1; min-width: 0; }
.norya-onboard-title { font-size: 13px; font-weight: 600; color: var(--text); }
.norya-onboard-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.norya-onboard-btn {
  background: var(--accent); color: #fff; border: none;
  padding: 6px 12px; border-radius: 7px; font-size: 12px;
  cursor: pointer; font-weight: 500; flex-shrink: 0;
}
.norya-onboard-btn:hover { background: var(--accent-hover); }
.norya-onboard-card.done .norya-onboard-btn,
.norya-onboard-card:not(.active) .norya-onboard-btn { display: none; }

/* ── Send button transient states ─────────────────────────────────────── */
.pi-send.sending { opacity: 0.65; pointer-events: none; }
.pi-send.sending::after {
  content: '';
  width: 10px; height: 10px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  display: inline-block;
  animation: noryaSpin 0.7s linear infinite;
  margin-left: 4px;
}
@keyframes noryaSpin { to { transform: rotate(360deg); } }
`;
  document.head.appendChild(_uxStyle);

  // ── 1. Toast system ──────────────────────────────────────────────────
  let _toastHost = null;
  function _ensureToastHost() {
    if (_toastHost && document.body.contains(_toastHost)) return _toastHost;
    _toastHost = h('div', { id: 'noryaToastHost' });
    document.body.appendChild(_toastHost);
    return _toastHost;
  }

  /**
   * Show a toast.
   * @param {string} msg
   * @param {'info'|'success'|'warn'|'error'} [type='info']
   * @param {object} [opts]
   * @param {number} [opts.timeout=4000] ms, 0 = sticky
   * @param {string} [opts.actionLabel]   button label (e.g. 'Desfazer')
   * @param {function} [opts.onAction]    handler when action button clicked
   * @param {string} [opts.details]       expandable raw text (e.g. stacktrace)
   * @returns {{ dismiss: () => void, el: HTMLElement }}
   */
  function toast(msg, type, opts) {
    type = type || 'info';
    opts = opts || {};
    const host = _ensureToastHost();
    const el = h('div', { class: 'norya-toast ' + type });
    const dot = h('span', { class: 'nt-dot' });
    const body = h('div', { class: 'nt-body' });
    const msgEl = h('div', { class: 'nt-msg', text: String(msg) });
    body.appendChild(msgEl);

    const actions = h('div', { class: 'nt-actions' });
    let _dismissed = false;
    function dismiss() {
      if (_dismissed) return;
      _dismissed = true;
      el.classList.add('exiting');
      setTimeout(() => { try { el.remove(); } catch {} }, 220);
    }
    if (opts.actionLabel && typeof opts.onAction === 'function') {
      const ab = h('button', {
        class: 'nt-btn',
        text: opts.actionLabel,
        on: {
          click: () => {
            try { opts.onAction(); } catch (e) { console.warn('toast action', e); }
            dismiss();
          },
        },
      });
      actions.appendChild(ab);
    }
    if (opts.details) {
      const detEl = h('pre', { class: 'nt-details', text: String(opts.details) });
      detEl.style.display = 'none';
      const detBtn = h('button', {
        class: 'nt-btn',
        text: 'Detalhes',
        on: {
          click: () => {
            const hidden = detEl.style.display === 'none';
            detEl.style.display = hidden ? '' : 'none';
            detBtn.textContent = hidden ? 'Hide' : 'Detalhes';
          },
        },
      });
      actions.appendChild(detBtn);
      body.appendChild(detEl);
    }
    if (actions.children.length) body.appendChild(actions);

    const closeBtn = h('button', {
      class: 'nt-close',
      text: '×',
      title: 'Close',
      on: { click: () => dismiss() },
    });

    el.append(dot, body, closeBtn);
    host.appendChild(el);

    const tm = opts.timeout != null ? opts.timeout : 4000;
    if (tm > 0) setTimeout(dismiss, tm);
    return { dismiss, el };
  }
  window.noryaToast = toast;

  // ── 2. Custom confirm dialog ──────────────────────────────────────────
  /**
   * Promise-based confirm modal styled like the app.
   * Falls back to window.confirm on errors.
   */
  function noryaConfirm(message, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      try {
        const overlay = h('div', { class: 'modal-overlay' });
        overlay.style.zIndex = '1300';
        const box = h('div', { class: 'modal-box' });
        box.style.maxWidth = '420px';
        const title = h('div', { class: 'modal-title', text: opts.title || 'Confirm' });
        const desc = h('div', { style: 'font-size:12px;color:var(--text-muted);line-height:1.5;white-space:pre-wrap;margin-bottom:6px', text: String(message) });
        const cancelBtn = h('button', { class: 'btn-cancel', text: opts.cancelLabel || 'Cancel' });
        const okBtn = h('button', { class: opts.danger ? 'btn-danger' : 'btn-primary', text: opts.okLabel || (opts.danger ? 'Delete' : 'OK') });
        const actions = h('div', { class: 'modal-actions' }, [cancelBtn, okBtn]);
        box.append(title, desc, actions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        function cleanup(val) {
          try { overlay.remove(); } catch {}
          document.removeEventListener('keydown', onKey, true);
          resolve(val);
        }
        function onKey(e) {
          if (e.key === 'Escape') { e.stopPropagation(); cleanup(false); }
          else if (e.key === 'Enter') { e.stopPropagation(); cleanup(true); }
        }
        cancelBtn.addEventListener('click', () => cleanup(false));
        okBtn.addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(false); });
        document.addEventListener('keydown', onKey, true);
        setTimeout(() => { try { okBtn.focus(); } catch {} }, 30);
      } catch (e) {
        console.warn('noryaConfirm fallback', e);
        resolve(window.confirm(message));
      }
    });
  }
  window.noryaConfirm = noryaConfirm;

  // ── 3. SHORTCUTS registry (single source of truth) ────────────────────
  const SHORTCUTS = [
    { keys: [KC.mod, 'K'], label: 'Command palette', group: 'Navigation' },
    { keys: [KC.mod, '/'], label: 'Show shortcuts', group: 'Navigation' },
    { keys: [KC.mod, 'N'], label: 'New thread', group: 'Navigation' },
    { keys: [KC.mod, '1'], label: 'Jump to 1st thread', group: 'Navigation' },
    { keys: [KC.mod, '2…9'], label: 'Jump to Nth thread', group: 'Navigation' },
    { keys: [KC.mod, '0'], label: 'Last thread', group: 'Navigation' },
    { keys: [KC.mod, 'G'], label: 'Toggle Norya Grid', group: 'Modes' },
    { keys: [KC.mod, 'P'], label: 'Toggle PIP (always on top)', group: 'Modes' },
    { keys: [KC.mod, 'L'], label: 'Toggle log viewer', group: 'Modes' },
    { keys: [KC.mod, '\\'], label: 'Toggle terminal raw / chat', group: 'Modes' },
    { keys: [KC.mod, KC.shift, 'F'], label: 'Fork thread', group: 'Actions' },
    { keys: [KC.mod, KC.alt, 'F'], label: 'Quick fork', group: 'Actions' },
    { keys: [KC.mod, KC.shift, 'M'], label: 'Merge queue', group: 'Actions' },
    { keys: [KC.mod, '→'], label: 'Cycle pane focus (grid)', group: 'Grid' },
    { keys: [KC.mod, '←'], label: 'Cycle pane focus back (grid)', group: 'Grid' },
    { keys: ['Enter'], label: 'Send message (in the input)', group: 'Edit' },
    { keys: ['Shift', 'Enter'], label: 'New line in the input', group: 'Edit' },
    { keys: ['Esc'], label: 'Close modal / palette / menu', group: 'Edit' },
  ];
  window.NORYA_SHORTCUTS = SHORTCUTS;

  // ── 4. Shortcut overview modal (⌘/) ───────────────────────────────────
  let _shortcutsModal = null;
  function openShortcutsModal() {
    if (_shortcutsModal) { _shortcutsModal.classList.remove('hidden'); return; }
    const close = h('button', { class: 'ns-close', text: '×', on: { click: closeShortcutsModal } });
    const header = h('div', { class: 'ns-header' }, [
      h('div', { class: 'ns-title', text: 'Keyboard shortcuts' }),
      close,
    ]);
    const body = h('div', { class: 'ns-body' });
    // group by .group
    const groups = new Map();
    for (const s of SHORTCUTS) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    for (const [groupName, items] of groups) {
      const g = h('div', { class: 'ns-group' }, [
        h('div', { class: 'ns-group-title', text: groupName }),
      ]);
      for (const it of items) {
        const keysWrap = h('span', { class: 'ns-keys' });
        for (const k of it.keys) keysWrap.appendChild(h('span', { class: 'kbd', text: k }));
        const row = h('div', { class: 'ns-row' }, [
          h('span', { class: 'ns-label', text: it.label }),
          keysWrap,
        ]);
        g.appendChild(row);
      }
      body.appendChild(g);
    }
    const box = h('div', { class: 'ns-box' }, [header, body]);
    const modal = h('div', { id: 'noryaShortcutsModal' }, [box]);
    modal.addEventListener('click', e => { if (e.target === modal) closeShortcutsModal(); });
    document.body.appendChild(modal);
    _shortcutsModal = modal;
  }
  function closeShortcutsModal() {
    if (_shortcutsModal) _shortcutsModal.classList.add('hidden');
  }

  // ── 5. Fuzzy matching (small subsequence scorer) ──────────────────────
  function _fuzzyScore(text, query) {
    if (!query) return 1;
    text = (text || '').toLowerCase();
    query = query.toLowerCase();
    let ti = 0, qi = 0, score = 0, streak = 0;
    while (ti < text.length && qi < query.length) {
      if (text[ti] === query[qi]) {
        score += 1 + streak;
        streak += 1;
        // Bonus for word-start match
        if (ti === 0 || /[\s\/_\-.]/.test(text[ti - 1])) score += 2;
        qi++;
      } else {
        streak = 0;
      }
      ti++;
    }
    if (qi < query.length) return 0;
    // Slight preference for shorter targets
    return score / (1 + Math.log(1 + text.length));
  }

  // ── 6. Command palette (⌘K) ───────────────────────────────────────────
  let _palette = null;
  let _paletteItems = [];
  let _paletteSelected = 0;

  function _safe(fn) { try { fn(); } catch (e) { console.warn('palette action', e); } }

  function _collectPaletteSources() {
    const items = [];
    const stRef = (typeof window.st === 'object' && window.st) || (typeof st === 'object' && st) || {};
    const accounts = Array.isArray(stRef.accounts) ? stRef.accounts : [];
    const allThreads = Array.isArray(stRef.allThreads) ? stRef.allThreads : [];

    const actions = [
      { kind: 'Action', title: 'New thread', sub: kc('⌘N'), icon: '+', run: () => _safe(() => startNewThread()) },
      // Grid virou a única view (2026-07-10): ⌘G não togglava mais nada — hoje
      // maximiza/restaura o pane focado. O item reflete isso (o antigo clique no
      // #btnNoryaGrid removido só rodava um botão sem handler).
      { kind: 'Action', title: 'Maximize/restore pane', sub: kc('⌘G'), icon: '⊞', run: () => _safe(() => {
        const alvo = st.gridMode.focusedThreadId || st.gridMode.lastInteracted || (st.gridMode.threadIds || [])[0];
        if (alvo && typeof toggleGridMaximize === 'function') toggleGridMaximize(alvo);
      }) },
      { kind: 'Action', title: 'Toggle terminal raw', sub: kc('⌘\\'), icon: '>_', run: () => _safe(() => typeof toggleRawTerminal === 'function' && toggleRawTerminal()) },
      { kind: 'Action', title: 'Show logs', sub: kc('⌘L'), icon: 'L', run: () => _safe(() => document.getElementById('btnLogs') && document.getElementById('btnLogs').click()) },
      { kind: 'Action', title: 'Settings', sub: 'General', icon: '⚙', run: () => _safe(() => { if (typeof openSettings === 'function') openSettings('general'); }) },
      { kind: 'Action', title: 'Show shortcuts', sub: kc('⌘/'), icon: '?', run: () => openShortcutsModal() },
      { kind: 'Action', title: 'Toggle theme (light/dark)', sub: 'Appearance', icon: '◐', run: () => _safe(() => {
          const cb = document.getElementById('darkModeToggle');
          if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        }) },
    ];
    items.push.apply(items, actions);

    for (const acc of accounts) {
      items.push({
        kind: 'Profile',
        title: acc.name || ('Profile ' + acc.num),
        sub: acc.authMode || '',
        icon: '●',
        iconColor: acc.color || null,
        run: () => _safe(() => typeof setActiveProfile === 'function' && setActiveProfile(acc.num)),
      });
    }

    const threadsList = allThreads.slice(0, 60);
    for (const th of threadsList) {
      const acc = accounts.find(a => a.num === th.accountNum);
      const title = th.title || th.first_user_message || 'Session';
      const branch = th.git_branch && th.git_branch !== 'main' && th.git_branch !== 'master' ? th.git_branch : '';
      const subParts = [];
      if (acc) subParts.push(acc.name || ('Profile ' + acc.num));
      if (branch) subParts.push(branch);
      items.push({
        kind: 'Thread',
        title,
        sub: subParts.join(' · '),
        icon: '◇',
        run: () => _safe(() => typeof onThreadClick === 'function' && onThreadClick(th)),
      });
    }

    if (typeof buildProjectMap === 'function') {
      try {
        const pm = buildProjectMap(allThreads);
        for (const proj of pm.values()) {
          items.push({
            kind: 'Project',
            title: proj.name,
            sub: proj.cwd || '',
            icon: '▸',
            run: () => _safe(() => {
              if (stRef.collapsedProjects) {
                stRef.collapsedProjects[proj.key] = false;
                if (typeof renderProjectList === 'function') renderProjectList();
              }
              setTimeout(() => {
                const el = document.querySelector('.proj-section[data-proj-key="' + CSS.escape(proj.key) + '"]');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }, 30);
            }),
          });
        }
      } catch (e) { /* ignore */ }
    }
    return items;
  }

  function openPalette() {
    if (_palette) { _palette.classList.remove('hidden'); _palette.querySelector('.np-input').focus(); return; }
    const ic = h('span', { class: 'np-icon', text: KC.mac ? '⌘' : '⌨' });
    const input = h('input', {
      class: 'np-input', type: 'text',
      placeholder: 'Search threads, projects, profiles, actions…',
      autocomplete: 'off', spellcheck: false,
    });
    const hint = h('span', { class: 'np-hint', text: '↑↓ navigate · ↵ open · esc close' });
    const inputRow = h('div', { class: 'np-input-row' }, [ic, input, hint]);
    const list = h('div', { class: 'np-list' });
    const box = h('div', { class: 'np-box' }, [inputRow, list]);
    const overlay = h('div', { id: 'noryaPalette' }, [box]);
    overlay.addEventListener('click', e => { if (e.target === overlay) closePalette(); });
    document.body.appendChild(overlay);
    _palette = overlay;

    function rerender() {
      const q = input.value.trim();
      const sources = _collectPaletteSources();
      let filtered;
      if (!q) {
        filtered = sources.slice(0, 30);
      } else {
        const scored = sources
          .map(it => ({ it, s: _fuzzyScore(it.title + ' ' + (it.sub || ''), q) }))
          .filter(x => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 40);
        filtered = scored.map(x => x.it);
      }
      _paletteItems = filtered;
      _paletteSelected = 0;
      list.textContent = '';
      if (!filtered.length) {
        list.appendChild(h('div', { class: 'np-empty', text: q ? 'No matches.' : 'Loading…' }));
        return;
      }
      const byKind = new Map();
      for (const it of filtered) {
        if (!byKind.has(it.kind)) byKind.set(it.kind, []);
        byKind.get(it.kind).push(it);
      }
      const kindOrder = ['Action', 'Profile', 'Thread', 'Project'];
      const grouped = [];
      for (const kind of kindOrder) {
        if (!byKind.has(kind)) continue;
        list.appendChild(h('div', { class: 'np-section-label', text: kind }));
        for (const it of byKind.get(kind)) {
          grouped.push(it);
          const idx = grouped.length - 1;
          const iconEl = h('span', { class: 'np-item-icon', text: it.icon || '·' });
          if (it.iconColor) iconEl.style.background = it.iconColor;
          const mainKids = [h('div', { class: 'np-item-title', text: it.title })];
          if (it.sub) mainKids.push(h('div', { class: 'np-item-sub', text: it.sub }));
          const main = h('span', { class: 'np-item-main' }, mainKids);
          const kindLbl = h('span', { class: 'np-item-kind', text: it.kind });
          const row = h('div', { class: 'np-item', 'data-idx': String(idx) }, [iconEl, main, kindLbl]);
          row.addEventListener('mouseenter', () => setSelected(idx));
          row.addEventListener('click', () => activate(idx));
          list.appendChild(row);
        }
      }
      _paletteItems = grouped;
      setSelected(0);
    }
    function setSelected(i) {
      if (!_paletteItems.length) return;
      i = ((i % _paletteItems.length) + _paletteItems.length) % _paletteItems.length;
      _paletteSelected = i;
      const rows = list.querySelectorAll('.np-item');
      rows.forEach(r => r.classList.toggle('active', parseInt(r.dataset.idx, 10) === i));
      const active = list.querySelector('.np-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
    function activate(i) {
      const it = _paletteItems[i];
      if (!it) return;
      closePalette();
      setTimeout(() => { try { it.run(); } catch (e) { console.warn('palette run', e); } }, 10);
    }
    input.addEventListener('input', rerender);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(_paletteSelected + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(_paletteSelected - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); activate(_paletteSelected); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });
    rerender();
    setTimeout(() => input.focus(), 30);
  }
  function closePalette() {
    if (_palette) _palette.classList.add('hidden');
  }
  window.noryaPalette = { open: openPalette, close: closePalette };

  // ── 7. Quick-switch threads (⌘1..9, ⌘0) ───────────────────────────────
  function _visibleSidebarThreads() {
    const nodes = document.querySelectorAll('.proj-section:not(.proj-archived-section) .thread-item');
    return Array.from(nodes);
  }
  function quickSwitchByIndex(idx) {
    const nodes = _visibleSidebarThreads();
    if (!nodes.length) return false;
    let target;
    if (idx === -1) target = nodes[nodes.length - 1];
    else target = nodes[idx];
    if (!target) return false;
    const tid = target.dataset.threadId;
    if (!tid) return false;
    const stRef = (typeof window.st === 'object' && window.st) || null;
    if (!stRef || !Array.isArray(stRef.allThreads)) return false;
    const thread = stRef.allThreads.find(t => t.id === tid);
    if (!thread) return false;
    try { onThreadClick(thread); } catch (e) { console.warn('quickSwitch', e); return false; }
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return true;
  }

  // ── 8. Status bar ─────────────────────────────────────────────────────
  function _ensureStatusBar() {
    let bar = document.getElementById('noryaStatusBar');
    if (bar) return bar;
    bar = h('div', { id: 'noryaStatusBar' });
    document.body.appendChild(bar);
    document.body.classList.add('norya-ux-statusbar');
    return bar;
  }
  function updateStatusBar() {
    const bar = _ensureStatusBar();
    const stRef = (typeof window.st === 'object' && window.st) || null;
    if (!stRef) return;
    const accounts = Array.isArray(stRef.accounts) ? stRef.accounts : [];
    const allThreads = Array.isArray(stRef.allThreads) ? stRef.allThreads : [];
    const activeAcc = accounts.find(a => a.num === stRef.activeProfileNum);
    const selectedThread = allThreads.find(t => t.id === stRef.selectedThreadId);

    let working = 0;
    if (stRef.termRunning) {
      for (const k of Object.keys(stRef.termRunning)) if (stRef.termRunning[k]) working++;
    }

    bar.textContent = '';
    const dot = h('span', { class: 'nsb-dot' });
    if (activeAcc && activeAcc.color) dot.style.background = activeAcc.color;
    const profItem = h('span', {
      class: 'nsb-item' + (activeAcc ? '' : ' dim'),
      title: 'Switch active profile',
      on: { click: () => { if (typeof openSettings === 'function') openSettings('general'); } },
    }, [
      dot,
      h('span', { text: activeAcc ? (activeAcc.name || ('Profile ' + activeAcc.num)) : 'No profile' }),
    ]);
    bar.appendChild(profItem);

    bar.appendChild(h('span', {
      class: 'nsb-item',
      title: 'Threads with a running PTY now',
      text: working + ' working',
      on: { click: () => openPalette() },
    }));
    bar.appendChild(h('span', {
      class: 'nsb-item',
      title: 'Total de threads',
      text: allThreads.length + ' threads',
      on: { click: () => openPalette() },
    }));
    if (selectedThread && selectedThread.git_branch) {
      bar.appendChild(h('span', {
        class: 'nsb-item',
        title: 'Active thread branch',
        text: '⎇ ' + selectedThread.git_branch,
      }));
    }
    bar.appendChild(h('span', { class: 'nsb-spacer' }));
    bar.appendChild(h('span', {
      class: 'nsb-item',
      title: kc('Shortcuts (⌘/)'),
      text: kc('⌘K palette · ⌘/ help'),
      on: { click: () => openShortcutsModal() },
    }));
  }
  setInterval(() => { if (document.hidden) return; try { updateStatusBar(); } catch {} }, 1500);
  setTimeout(() => { try { updateStatusBar(); } catch {} }, 400);

  // ── 9. Onboarding empty state ─────────────────────────────────────────
  function maybeShowOnboarding() {
    const stRef = (typeof window.st === 'object' && window.st) || null;
    if (!stRef) return false;
    const accounts = Array.isArray(stRef.accounts) ? stRef.accounts : [];
    const threads = Array.isArray(stRef.allThreads) ? stRef.allThreads : [];
    if (accounts.length || threads.length) return false;
    const empty = document.getElementById('outputEmpty');
    if (!empty) return false;
    if (empty.querySelector('.norya-onboard')) return true;
    const title = empty.querySelector('#emptyTitle');
    const sub = empty.querySelector('#emptySub');
    const btn = empty.querySelector('#emptyActionBtn');
    const logo = empty.querySelector('#emptyLogo');
    const phrase = empty.querySelector('#emptyPhrase');
    if (title) title.style.display = 'none';
    if (sub) sub.style.display = 'none';
    if (btn) btn.style.display = 'none';
    if (logo) logo.style.display = 'none';
    if (phrase) phrase.style.display = 'none';
    empty.classList.remove('hidden');
    // Grid é a única view e esconde .output-area; body.onboarding é o carve-out
    // que reexibe a empty-state por cima do grid enquanto não há conta/thread.
    document.body.classList.add('onboarding');

    const card1 = h('div', { class: 'norya-onboard-card active' }, [
      h('div', { class: 'norya-onboard-step', text: '1' }),
      h('div', { class: 'norya-onboard-body' }, [
        h('div', { class: 'norya-onboard-title', text: 'Create a profile' }),
        h('div', { class: 'norya-onboard-desc', text: 'Agent identity: name, color, authentication.' }),
      ]),
      h('button', {
        class: 'norya-onboard-btn',
        text: 'Open Settings',
        on: { click: () => { if (typeof openSettings === 'function') openSettings('general'); } },
      }),
    ]);
    const card2 = h('div', { class: 'norya-onboard-card' }, [
      h('div', { class: 'norya-onboard-step', text: '2' }),
      h('div', { class: 'norya-onboard-body' }, [
        h('div', { class: 'norya-onboard-title', text: 'Add a project' }),
        h('div', { class: 'norya-onboard-desc', text: 'Point to a folder with your code.' }),
      ]),
    ]);
    const card3 = h('div', { class: 'norya-onboard-card' }, [
      h('div', { class: 'norya-onboard-step', text: '3' }),
      h('div', { class: 'norya-onboard-body' }, [
        h('div', { class: 'norya-onboard-title', text: 'Start a thread' }),
        h('div', { class: 'norya-onboard-desc', text: kc('⌘N opens the new-thread panel.') }),
      ]),
    ]);
    const root = h('div', { class: 'norya-onboard' }, [
      h('h3', { text: 'Welcome to Norya' }),
      h('p', { text: 'Three steps to start orchestrating.' }),
      h('div', { class: 'norya-onboard-cards' }, [card1, card2, card3]),
    ]);
    empty.appendChild(root);
    return true;
  }
  function maybeHideOnboarding() {
    const empty = document.getElementById('outputEmpty');
    if (!empty) return;
    const ob = empty.querySelector('.norya-onboard');
    if (!ob) return;
    const stRef = (typeof window.st === 'object' && window.st) || null;
    if (!stRef) return;
    const accounts = Array.isArray(stRef.accounts) ? stRef.accounts : [];
    const threads = Array.isArray(stRef.allThreads) ? stRef.allThreads : [];
    if (accounts.length || threads.length) {
      ob.remove();
      // Entrou conta/thread: solta o carve-out e devolve .output-area ao grid.
      document.body.classList.remove('onboarding');
      const title = empty.querySelector('#emptyTitle');
      const sub = empty.querySelector('#emptySub');
      const btn = empty.querySelector('#emptyActionBtn');
      const logo = empty.querySelector('#emptyLogo');
      const phrase = empty.querySelector('#emptyPhrase');
      if (title) title.style.display = '';
      if (sub) sub.style.display = '';
      if (btn) btn.style.display = '';
      if (logo) logo.style.display = '';
      if (phrase) phrase.style.display = '';
    }
  }
  const _onboardInterval = setInterval(() => {
    if (document.hidden) return;
    try { maybeShowOnboarding(); maybeHideOnboarding(); } catch {}
    // Once profiles/threads exist and onboarding is gone, stop the perpetual scan.
    try {
      const stRef = (typeof window.st === 'object' && window.st) || null;
      if (stRef && ((stRef.accounts || []).length || (stRef.allThreads || []).length) && !document.querySelector('.norya-onboard')) {
        clearInterval(_onboardInterval);
      }
    } catch {}
  }, 2000);
  setTimeout(() => { try { maybeShowOnboarding(); } catch {} }, 1500);

  // ── 10. Send feedback wrapper ─────────────────────────────────────────
  let _lastSendAt = 0;
  let _sendTimer2s = null;
  let _sendTimer10s = null;
  let _send10sToast = null;
  function _markSent() {
    _lastSendAt = Date.now();
    const sb = document.getElementById('sendBtn');
    if (sb) sb.classList.add('sending');
    if (_sendTimer2s) clearTimeout(_sendTimer2s);
    if (_sendTimer10s) clearTimeout(_sendTimer10s);
    _sendTimer2s = setTimeout(() => {
      if (sb && sb.classList.contains('sending')) {
        toast('Waiting for agent to start…', 'info', { timeout: 2500 });
      }
    }, 2000);
    _sendTimer10s = setTimeout(() => {
      if (sb && sb.classList.contains('sending')) {
        _send10sToast = toast('No response for 10s.', 'warn', {
          timeout: 0,
          actionLabel: 'Cancel',
          onAction: () => _clearSend(),
        });
      }
    }, 10000);
  }
  function _clearSend() {
    const sb = document.getElementById('sendBtn');
    if (sb) sb.classList.remove('sending');
    if (_sendTimer2s) { clearTimeout(_sendTimer2s); _sendTimer2s = null; }
    if (_sendTimer10s) { clearTimeout(_sendTimer10s); _sendTimer10s = null; }
    if (_send10sToast) { _send10sToast.dismiss(); _send10sToast = null; }
  }
  document.addEventListener('click', e => {
    const sb = e.target && e.target.closest && e.target.closest('#sendBtn');
    if (sb && !sb.disabled) _markSent();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.target && e.target.id === 'inputField' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const inp = e.target;
      if (inp.value && inp.value.trim()) _markSent();
    }
  }, true);
  setInterval(() => {
    const sb = document.getElementById('sendBtn');
    if (!sb || !sb.classList.contains('sending')) return;
    if (Date.now() - _lastSendAt > 700) {
      const stRef = (typeof window.st === 'object' && window.st) || null;
      if (stRef && stRef.lastOutputTime) {
        for (const k of Object.keys(stRef.lastOutputTime)) {
          if (stRef.lastOutputTime[k] && (Date.now() - stRef.lastOutputTime[k] < 500)) {
            _clearSend();
            return;
          }
        }
      }
      if (Date.now() - _lastSendAt > 1500) _clearSend();
    }
  }, 250);

  // ── 11. Undo wrapper for archive (window.archiveProject if exposed) ────
  try {
    if (typeof window.archiveProject === 'function') {
      const orig = window.archiveProject;
      window.archiveProject = function (key) {
        try { orig(key); } catch (e) { console.warn('archiveProject', e); return; }
        toast('Project archived.', 'success', {
          timeout: 5000,
          actionLabel: 'Desfazer',
          onAction: () => {
            try {
              if (typeof window.unarchiveProject === 'function') window.unarchiveProject(key);
              else if (typeof unarchiveProject === 'function') unarchiveProject(key);
            } catch (e) { console.warn('unarchive', e); }
          },
        });
      };
    }
  } catch (e) { console.warn('patch archiveProject', e); }

  // ── 12. Global keyboard shortcuts router ──────────────────────────────
  function _isEditable(el) {
    if (!el) return false;
    const t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }
  document.addEventListener('keydown', e => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    if (e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (_palette && !_palette.classList.contains('hidden')) closePalette();
      else openPalette();
      return;
    }
    if (e.key === '/' && !e.shiftKey) {
      e.preventDefault();
      if (_shortcutsModal && !_shortcutsModal.classList.contains('hidden')) closeShortcutsModal();
      else openShortcutsModal();
      return;
    }
    if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
      if (_isEditable(document.activeElement)) return;
      e.preventDefault();
      const idx = parseInt(e.key, 10) - 1;
      quickSwitchByIndex(idx);
      return;
    }
    if (e.key === '0' && !e.shiftKey && !e.altKey) {
      if (_isEditable(document.activeElement)) return;
      e.preventDefault();
      quickSwitchByIndex(-1);
      return;
    }
  }, true);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (_palette && !_palette.classList.contains('hidden')) closePalette();
      if (_shortcutsModal && !_shortcutsModal.classList.contains('hidden')) closeShortcutsModal();
    }
  });

  // ── 13. Toast-ify alert() ─────────────────────────────────────────────
  const _origAlert = window.alert;
  window.alert = function (msg) {
    if (window.NORYA_UX_TOAST_ALERTS === false) return _origAlert(msg);
    try {
      const s = String(msg == null ? '' : msg);
      const isErrorish = /falha|erro|error|failed|cannot|não|impossível/i.test(s);
      toast(s, isErrorish ? 'error' : 'info', { timeout: isErrorish ? 7000 : 4500 });
    } catch (e) {
      return _origAlert(msg);
    }
  };
  if (typeof window.NORYA_UX_TOAST_ALERTS === 'undefined') {
    window.NORYA_UX_TOAST_ALERTS = true;
  }

  // ── 14. Bootstrap: refresh status bar on focus / visibility ───────────
  window.addEventListener('focus', () => { try { updateStatusBar(); } catch {} });
  document.addEventListener('visibilitychange', () => { try { updateStatusBar(); } catch {} });

  console.log(kc('[norya-ux] flows loaded · ⌘K palette · ⌘/ atalhos · ⌘1..9 quick switch · status bar · toasts'));
})();

// ── Start ─────────────────────────────────────────────────────────────────────
init();
