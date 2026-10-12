/**
 * renderer/newthread.js — painel de nova thread, pre-spawn, anexos, lightbox, toolbar.
 *
 * Script CLÁSSICO (ver renderer/state.js): fatia contígua extraída de
 * test-window.html em 2026-07-10, na ordem original. Compartilha o escopo
 * léxico global com os outros — `st`, `api`, `ipcRenderer` e as funções de
 * cada fatia enxergam-se sem import. Ordem de carga preservada = zero mudança
 * de comportamento.
 */
'use strict';

// ── New Thread Panel ────────────────────────────────────────────────────────────
// Set one random motivational phrase (no morph animation).
function startGooeyText() {
  const el = document.getElementById('ntpPhrase');
  if (!el || !INTRO_PHRASES.length) return;
  el.textContent = INTRO_PHRASES[Math.floor(Math.random() * INTRO_PHRASES.length)];
}
function stopGooeyText() { /* no-op */ }

// Short, motivating phrases in the spirit of Roosevelt's "Man in the Arena".
const INTRO_PHRASES = [
  "Step into the arena.",
  "The credit belongs to the one who does.",
  "Dare greatly.",
  "It is the doing that counts.",
  "Strive valiantly.",
  "Begin. The rest follows.",
  "Action over hesitation.",
  "Spend yourself in a worthy cause.",
  "Build something that matters.",
  "Show up. The rest is craft.",
  "Cold and timid souls never knew victory.",
  "Better to fail trying than never to try.",
  "Dust and sweat — that's the work.",
  "The arena is open. Walk in.",
  "Make today the proof.",
  "Start now. Iterate later.",
  "Move. Momentum is its own reward.",
  "Effort compounds. Begin.",
  "Bold beats perfect.",
  "Ship the first version.",
];

let ntpAcc = null;
let ntpFolder = null;

// Always read the currently-selected account from the dropdown — single source of truth.
// We read both .value and the selected option's value attribute for robustness against
// edge cases where one might be stale.
function getCurrentNtpAcc() {
  // New profile model: ntp always uses the active profile (canto inferior).
  // The legacy #ntpAccountSel is hidden — don't read from it anymore.
  if (st.activeProfileNum != null) {
    const f = st.accounts.find(a => a.num === st.activeProfileNum);
    if (f) return f;
  }
  // Fallback chain (only if no active profile is set)
  if (ntpAcc) return ntpAcc;
  if (st.selectedAccountNum != null) {
    const f = st.accounts.find(a => a.num === st.selectedAccountNum);
    if (f) return f;
  }
  if (st.accounts && st.accounts.length) return st.accounts[0];
  return null;
}

function populateNtpAccountSel() {
  const sel = document.getElementById('ntpAccountSel');
  if (!sel) return;
  const isInactive = (acc) => {
    const q = st.quota[String(acc.num)];
    return q && q.loggedOut === true;
  };
  // Only available accounts make it into the dropdown
  const available = st.accounts.filter(a => !isInactive(a));
  const opts = ['<option value="">Pick account…</option>']
    .concat(available.map(a => {
      const label = (a.name || 'Account ' + a.num).replace(/</g,'&lt;');
      return `<option value="${a.num}">${label}</option>`;
    }));
  sel.innerHTML = opts.join('');

  let initialNum = null;
  if (ntpAcc && !isInactive(ntpAcc)) initialNum = ntpAcc.num;
  else if (st.selectedAccountNum != null && available.find(a => a.num === st.selectedAccountNum)) initialNum = st.selectedAccountNum;
  else if (available.length) initialNum = available[0].num;
  if (initialNum != null) {
    sel.value = String(initialNum);
    const found = available.find(a => a.num === initialNum);
    if (found) ntpAcc = found;
  } else {
    ntpAcc = null;
  }
  console.log('[populateNtpAccountSel] total=' + st.accounts.length + ' available=' + available.length + ' sel.value=' + sel.value + ' ntpAcc=' + (ntpAcc && ntpAcc.num));
}

function updateNtpSendState() {
  // Sync ntpAcc from dropdown EVERY time (single source of truth)
  ntpAcc = getCurrentNtpAcc();
  const send = document.getElementById('ntpSendBtn');
  const hint = document.getElementById('ntpHint');
  const text = (document.getElementById('ntpField').value || '').trim();
  // Require: active profile (= ntpAcc) AND folder AND text. Additionally, if a
  // pre-spawn is running for the current folder/acc, wait until it's READY.
  // No pre-spawn? canSubmit relies on the in-submit fallback delay.
  const preSpawnMatches = _ntpPreSpawn
    && ntpAcc && _ntpPreSpawn.acc && _ntpPreSpawn.acc.num === ntpAcc.num
    && _ntpPreSpawn.cwd === ntpFolder;
  const preSpawnBlocking = preSpawnMatches && !_ntpPreSpawn.ready;
  const canSubmit = !!ntpAcc && !!text && !!ntpFolder && !preSpawnBlocking;
  send.disabled = !canSubmit;
  send.classList.toggle('loading', preSpawnBlocking);
  // Single source of truth for "why can't I send yet" — drives BOTH the hint
  // line and the send button's tooltip so they can never disagree. (The tooltip
  // used to be hard-coded to "select a profile" even with a profile active.)
  let reason;
  if (!ntpAcc) reason = 'Select an active profile (bottom-left) to start.';
  else if (!ntpFolder && !text) reason = 'Select a project and describe what you want to do.';
  else if (!ntpFolder) reason = 'Select a project first.';
  else if (preSpawnBlocking) reason = 'Starting codex in the project…';
  else if (!text) reason = 'Describe what you want to do.';
  else reason = 'Ready — press Enter to send.';
  hint.textContent = reason;
  send.title = canSubmit ? 'Send (Enter)' : reason;
}

function showNewThreadPanel() {
  if (!st.accounts.length) { openAddModal(); return; }

  // New landing flow (2026-06-22): the "Describe what you want to build" composer
  // is only for OpenRouter/aider profiles — those have no xterm and need a prompt
  // box. Codex/xterm profiles get the clean empty state instead ("Select a thread
  // or start a new one"), and start fresh threads via the folder modal. This
  // delegates BEFORE adding the .landing class, so the empty state stays visible
  // (body.landing hides .output-empty).
  const _activeAcc = st.accounts.find(a => a.num === st.activeProfileNum);
  if (!_activeAcc || _activeAcc.authMode !== 'openrouter') {
    showEmptyState();
    return;
  }

  // Any orphan pre-spawn from a previous open is now stale (different folder/acc).
  // Kill it so we start clean — a new one fires once the user picks a folder.
  if (_ntpPreSpawn) ntpKillPreSpawn();

  // Pre-select: toolbar override > sidebar selection > nothing
  if (st.selectedAccountOverride != null) {
    ntpAcc = st.accounts.find(a => a.num === st.selectedAccountOverride) || null;
  } else if (st.selectedAccountNum != null) {
    ntpAcc = st.accounts.find(a => a.num === st.selectedAccountNum) || null;
  }
  ntpFolder = null;

  populateNtpAccountSel();
  const panel = document.getElementById('newThreadPanel');
  startGooeyText();
  panel.classList.remove('hidden');
  document.getElementById('app').classList.add('landing');
  document.body.classList.add('landing');
  document.getElementById('ntpBg').classList.remove('fading');

  const field = document.getElementById('ntpField');
  field.value = '';
  field.style.height = 'auto';
  const folderLabel = document.getElementById('ntpFolderLabel');
  if (folderLabel) folderLabel.textContent = 'Select project';
  document.getElementById('ntpPickFolderBtn').classList.remove('picked');
  // Fase 6: hide branch button until a folder is picked
  const branchBtn = document.getElementById('ntpBranchBtn');
  if (branchBtn) branchBtn.classList.add('hidden');
  _ntpBranchSelection = { type: 'main', branch: 'main' };
  // agent/branches: hide stale slug preview when panel reopens
  const slugChip = document.getElementById('ntpSlugPreview');
  if (slugChip) slugChip.classList.add('hidden');
  updateNtpSendState();
  if (typeof syncInputAreaVisibility === 'function') syncInputAreaVisibility();
  setTimeout(() => field.focus(), 50);
}

// Bind branch button toggle (idempotent)
(function bindNtpBranchBtn() {
  const btn = document.getElementById('ntpBranchBtn');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', e => { e.stopPropagation(); toggleNtpBranchPop(); });
  }
})();

function hideNewThreadPanel() {
  document.getElementById('newThreadPanel').classList.add('hidden');
  document.getElementById('app').classList.remove('landing');
  document.body.classList.remove('landing');
  // Fade out the falling-pattern background after the panel slides down
  const bg = document.getElementById('ntpBg');
  bg.classList.add('fading');
  setTimeout(() => bg.classList.remove('fading'), 700);
  stopGooeyText();
  if (typeof syncInputAreaVisibility === 'function') syncInputAreaVisibility();
}

// Account selector inside the new-thread panel
document.getElementById('ntpAccountSel').addEventListener('change', function() {
  const n = parseInt(this.value);
  ntpAcc = isNaN(n) ? null : (st.accounts.find(a => a.num === n) || null);
  // Account changed → existing pre-spawn (if any) is for the wrong account.
  // Re-start it for the new account if folder is already picked.
  if (_ntpPreSpawn && (!ntpAcc || _ntpPreSpawn.acc.num !== ntpAcc.num)) ntpKillPreSpawn();
  if (ntpAcc && ntpFolder) ntpStartPreSpawn();
  updateNtpSendState();
});

// ── Pre-spawn: when the user picks a folder + has an active profile, start the
// codex CLI in the background immediately. By the time they finish typing the
// prompt, the TUI is booted and idle, so we can send the first message right
// away (no more 800/2500ms guessing games).
//   _ntpPreSpawn = { spawnId, acc, cwd, projectId, profileNum, ready, startedAt }
let _ntpPreSpawn = null;
let _ntpReadyPoller = null;

function ntpKillPreSpawn() {
  if (!_ntpPreSpawn) return;
  console.log('[ntpPreSpawn] killing', _ntpPreSpawn.spawnId);
  try { api.killTerminal(_ntpPreSpawn.spawnId); } catch {}
  _ntpPreSpawn = null;
  if (_ntpReadyPoller) { clearTimeout(_ntpReadyPoller); _ntpReadyPoller = null; }
  updateNtpSendState();
}

function ntpStartPreSpawn() {
  if (!ntpAcc || !ntpFolder) return;
  // Skip OpenRouter/aider profiles — they use a different flow (aider bridge)
  if (ntpAcc.authMode === 'openrouter') return;
  // Already have a matching pre-spawn? Reuse it.
  if (_ntpPreSpawn
      && _ntpPreSpawn.acc && _ntpPreSpawn.acc.num === ntpAcc.num
      && _ntpPreSpawn.cwd === ntpFolder
      && st.termRunning[_ntpPreSpawn.spawnId]) {
    return;
  }
  ntpKillPreSpawn();
  const projectId = folderToProjectId(ntpFolder);
  const profileNum = st.activeProfileNum != null ? st.activeProfileNum : ntpAcc.num;
  const spawnId = launchTerminal(ntpAcc, {
    mode: 'new-folder',
    cwd: ntpFolder,
    projectId,
    profileNum,
  });
  _ntpPreSpawn = {
    spawnId, acc: ntpAcc, cwd: ntpFolder, projectId, profileNum,
    ready: false, startedAt: Date.now(),
  };
  console.log('[ntpPreSpawn] started', { spawnId, cwd: ntpFolder, acc: ntpAcc.num });
  updateNtpSendState();
  // Poll for "ready": PTY idle ≥600ms AND buffer ≥800 bytes AND boot ≥1.8s.
  // Failsafe: declare ready anyway after 8s.
  const checkReady = () => {
    _ntpReadyPoller = null;
    if (!_ntpPreSpawn || _ntpPreSpawn.spawnId !== spawnId) return;
    const buf = st.termBuffers[spawnId] || '';
    const lastOut = st.lastOutputTime[spawnId] || 0;
    const idleMs = Date.now() - lastOut;
    const bootMs = Date.now() - _ntpPreSpawn.startedAt;
    if (bootMs >= 1800 && buf.length >= 800 && idleMs >= 600) {
      _ntpPreSpawn.ready = true;
      console.log('[ntpPreSpawn] ready', { spawnId, bufLen: buf.length, idleMs, bootMs });
      updateNtpSendState();
      return;
    }
    if (bootMs >= 8000) {
      _ntpPreSpawn.ready = true;
      console.warn('[ntpPreSpawn] forcing ready after 8s', { spawnId, bufLen: buf.length });
      updateNtpSendState();
      return;
    }
    _ntpReadyPoller = setTimeout(checkReady, 200);
  };
  _ntpReadyPoller = setTimeout(checkReady, 800);
}

// Folder picker — opens a popover with recently-used folders + "Choose folder…"
function setNtpFolder(folder) {
  if (!folder) return;
  const changed = (folder !== ntpFolder);
  ntpFolder = folder;
  const label = document.getElementById('ntpFolderLabel');
  if (label) {
    const short = folder.split(/[\\/]/).slice(-2).join('/') || folder;
    label.textContent = short;
    label.title = folder;
  }
  document.getElementById('ntpPickFolderBtn').classList.add('picked');
  rememberFolder(folder);
  // Kick off the codex in the background so it's ready when the user submits.
  // If the folder didn't change, the existing pre-spawn already covers it.
  if (changed) ntpStartPreSpawn();
  updateNtpSendState();
  // Fase 6: refresh Branch button visibility/state based on folder's git state
  updateNtpBranchButton();
}

// Fase 6: Branch selection state for new-thread panel
// Shapes:
//   { type: 'main' }                            — default, use main branch (no new worktree)
//   { type: 'existing', branch, worktreePath }  — reuse an existing worktree
//   { type: 'new' }                             — create a new worktree on send (slug derived from prompt)
let _ntpBranchSelection = { type: 'main', branch: 'main' };
let _ntpBranchInfo = null; // cached git info for current folder

async function updateNtpBranchButton() {
  const btn = document.getElementById('ntpBranchBtn');
  const label = document.getElementById('ntpBranchLabel');
  if (!btn || !label) return;
  if (!ntpFolder) {
    btn.classList.add('hidden');
    _ntpBranchInfo = null;
    return;
  }
  let gitInfo;
  try { gitInfo = await api.gitDetect(ntpFolder); } catch { gitInfo = { hasGit: false }; }
  if (!gitInfo.hasGit) {
    btn.classList.add('hidden');
    _ntpBranchInfo = null;
    return;
  }
  // Has git → show button + load branches/worktrees
  btn.classList.remove('hidden');
  try {
    const [branchesRes, wtRes] = await Promise.all([
      api.gitListBranches(ntpFolder),
      api.gitWorktreeList(ntpFolder),
    ]);
    _ntpBranchInfo = {
      branches: (branchesRes && branchesRes.branches) || [],
      currentBranch: branchesRes && branchesRes.current,
      worktrees: (wtRes && wtRes.worktrees) || [],
    };
  } catch {
    _ntpBranchInfo = { branches: [], currentBranch: null, worktrees: [] };
  }
  // Reset selection to main when folder changes (unless we're keeping a 'new' intent)
  if (_ntpBranchSelection.type !== 'new') {
    _ntpBranchSelection = { type: 'main', branch: 'main' };
  }
  renderNtpBranchButtonLabel();
}

function renderNtpBranchButtonLabel() {
  const btn = document.getElementById('ntpBranchBtn');
  const label = document.getElementById('ntpBranchLabel');
  if (!btn || !label) return;
  btn.classList.remove('main', 'new');
  // agent/branches: also tint the dot so users can preview the chosen color
  const dot = btn.querySelector('.pi-branch-btn-dot');
  const projectId = ntpFolder ? folderToProjectId(ntpFolder) : null;
  if (_ntpBranchSelection.type === 'main') {
    btn.classList.add('main');
    label.textContent = _ntpBranchInfo && _ntpBranchInfo.currentBranch ? _ntpBranchInfo.currentBranch : 'main';
    btn.title = 'Trabalhar em main';
    if (dot) dot.style.background = 'var(--accent)';
  } else if (_ntpBranchSelection.type === 'new') {
    btn.classList.add('new');
    label.textContent = _ntpBranchSelection.customSlug
      ? '+ wt/' + _ntpBranchSelection.customSlug
      : '+ novo worktree';
    btn.title = _ntpBranchSelection.customSlug
      ? 'Will create wt/' + _ntpBranchSelection.customSlug + ' on send'
      : 'Will create a new worktree (slug derived from the prompt) on send';
    if (dot) dot.style.background = 'var(--accent)';
  } else if (_ntpBranchSelection.type === 'attach') {
    label.textContent = _ntpBranchSelection.branch || 'branch';
    btn.title = 'Existing branch without a worktree — Norya will create one on send';
    if (dot && typeof branchColor === 'function') dot.style.background = branchColor(_ntpBranchSelection.branch, projectId);
  } else {
    label.textContent = _ntpBranchSelection.branch || 'branch';
    btn.title = 'Worktree: ' + (_ntpBranchSelection.worktreePath || '');
    if (dot && typeof branchColor === 'function') dot.style.background = branchColor(_ntpBranchSelection.branch, projectId);
  }
  // Refresh slug preview chip below the input
  if (typeof updateNtpSlugPreview === 'function') updateNtpSlugPreview();
}

// agent/branches: keyboard nav state for branch dropdown
let _ntpBranchKeyIndex = 0;
let _ntpBranchFilter = '';

// agent/branches: live slug preview — debounced deriveSlug while user types.
// Visible only when branch selection is "new" (creating a new worktree).
let _ntpSlugDebounce = null;
async function updateNtpSlugPreview() {
  const chip = document.getElementById('ntpSlugPreview');
  const nameEl = document.getElementById('ntpSlugPreviewName');
  if (!chip || !nameEl) return;
  if (!_ntpBranchSelection || _ntpBranchSelection.type !== 'new') {
    chip.classList.add('hidden');
    return;
  }
  const fieldEl = document.getElementById('ntpField');
  const text = fieldEl ? (fieldEl.value || '').trim() : '';
  const projectId = ntpFolder ? folderToProjectId(ntpFolder) : null;
  if (_ntpBranchSelection.customSlug) {
    nameEl.textContent = 'wt/' + _ntpBranchSelection.customSlug;
    chip.classList.remove('hidden');
    return;
  }
  if (!text) {
    nameEl.textContent = 'wt/<type the prompt>';
    chip.classList.remove('hidden');
    return;
  }
  // debounce expensive IPC
  if (_ntpSlugDebounce) clearTimeout(_ntpSlugDebounce);
  _ntpSlugDebounce = setTimeout(async () => {
    try {
      const res = await api.deriveSlug(text, projectId);
      if (res && res.slug) nameEl.textContent = 'wt/' + res.slug;
      else nameEl.textContent = 'wt/thread';
    } catch {
      nameEl.textContent = 'wt/thread';
    }
  }, 180);
  chip.classList.remove('hidden');
}

// Edit button on the slug preview chip — prompt for a custom slug.
(function bindNtpSlugPreviewEdit() {
  const btn = document.getElementById('ntpSlugPreviewEdit');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const current = (_ntpBranchSelection && _ntpBranchSelection.customSlug) || '';
      const input = window.prompt('New worktree slug (without the wt/ prefix):', current);
      if (input == null) return;
      const cleaned = input.trim().replace(/^wt\//, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
      if (!cleaned) {
        _ntpBranchSelection = { type: 'new', customSlug: null };
      } else {
        _ntpBranchSelection = { type: 'new', customSlug: cleaned };
      }
      renderNtpBranchButtonLabel();
    });
  }
})();

function _ntpRenderBranchPop() {
  const pop = document.getElementById('ntpBranchPop');
  if (!pop || !_ntpBranchInfo) return;
  while (pop.firstChild) pop.removeChild(pop.firstChild);

  const filter = (_ntpBranchFilter || '').toLowerCase().trim();
  const projectId = ntpFolder ? folderToProjectId(ntpFolder) : null;
  // All branches the user can choose. Comes from `git branch` (all local refs),
  // not only worktrees, so they can switch into ANY existing branch — but if a
  // worktree already exists for it we reuse its path, otherwise we'll auto-add.
  const allBranches = Array.isArray(_ntpBranchInfo.branches) ? _ntpBranchInfo.branches.slice() : [];
  const worktreeByBranch = {};
  (_ntpBranchInfo.worktrees || []).forEach(w => { if (w.branch) worktreeByBranch[w.branch] = w; });

  // Determine if search input should appear (>8 branches besides main/master)
  const nonMainCount = allBranches.filter(b => b !== 'main' && b !== 'master').length;
  const showSearch = nonMainCount > 8;

  // ── Optional search input ─────────────────────────────────────────────────
  if (showSearch) {
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'pi-branch-search';
    search.placeholder = 'Search branch… (' + nonMainCount + ' total)';
    search.value = _ntpBranchFilter;
    search.id = 'ntpBranchSearchInput';
    search.addEventListener('input', () => {
      _ntpBranchFilter = search.value;
      _ntpBranchKeyIndex = 0;
      _ntpRenderBranchPop();
      const fresh = document.getElementById('ntpBranchSearchInput');
      if (fresh) fresh.focus();
    });
    search.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
        e.preventDefault();
        _ntpHandleBranchKey(e.key);
      } else if (e.key === 'Escape') { closeNtpBranchPop(); }
    });
    pop.appendChild(search);
    setTimeout(() => search.focus(), 0);
  }

  // collect items for keyboard navigation
  const navItems = [];

  // ── Main branch (always present, never filtered out) ──────────────────────
  if ('main'.includes(filter) || filter === '') {
    const mainSec = document.createElement('div');
    mainSec.className = 'pi-branch-pop-section';
    mainSec.textContent = 'Branch principal';
    pop.appendChild(mainSec);

    const mainItem = document.createElement('div');
    mainItem.className = 'pi-branch-item main star' + (_ntpBranchSelection.type === 'main' ? ' active' : '');
    const mainDot = document.createElement('span');
    mainDot.className = 'pi-branch-item-dot';
    mainDot.style.background = 'var(--accent)';
    mainItem.appendChild(mainDot);
    const mainName = document.createElement('span');
    mainName.className = 'pi-branch-item-name';
    mainName.textContent = _ntpBranchInfo.currentBranch || 'main';
    mainItem.appendChild(mainName);
    mainItem.addEventListener('click', () => {
      _ntpBranchSelection = { type: 'main', branch: 'main' };
      renderNtpBranchButtonLabel();
      closeNtpBranchPop();
    });
    pop.appendChild(mainItem);
    navItems.push(mainItem);
  }

  // ── All existing local branches (non-main/master), worktree status as meta
  const otherBranches = allBranches
    .filter(b => b && b !== 'main' && b !== 'master')
    .filter(b => !filter || b.toLowerCase().includes(filter));

  if (otherBranches.length) {
    const sec = document.createElement('div');
    sec.className = 'pi-branch-pop-section';
    sec.textContent = 'Branches';
    pop.appendChild(sec);
    otherBranches.forEach(branchName => {
      const wt = worktreeByBranch[branchName];
      const isSel = _ntpBranchSelection.type === 'existing'
        && (_ntpBranchSelection.branch === branchName);
      const item = document.createElement('div');
      item.className = 'pi-branch-item' + (isSel ? ' active' : '');
      const dot = document.createElement('span');
      dot.className = 'pi-branch-item-dot';
      dot.style.background = (typeof branchColor === 'function')
        ? branchColor(branchName, projectId) : 'var(--text-faint)';
      item.appendChild(dot);
      const name = document.createElement('span');
      name.className = 'pi-branch-item-name';
      name.textContent = branchName;
      item.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'pi-branch-item-meta';
      meta.textContent = wt ? 'wt' : 'no wt';
      item.appendChild(meta);
      item.addEventListener('click', () => {
        if (wt && wt.path) {
          _ntpBranchSelection = { type: 'existing', branch: branchName, worktreePath: wt.path };
        } else {
          // Branch exists but no worktree yet — schedule worktree-add on send.
          _ntpBranchSelection = { type: 'attach', branch: branchName };
        }
        renderNtpBranchButtonLabel();
        closeNtpBranchPop();
      });
      pop.appendChild(item);
      navItems.push(item);
    });
  } else if (filter) {
    const empty = document.createElement('div');
    empty.className = 'pi-branch-empty';
    empty.textContent = 'No branches found';
    pop.appendChild(empty);
  }

  // ── Divider + "+ Novo worktree" with inline slug input ───────────────────
  const div = document.createElement('div');
  div.className = 'pi-branch-divider';
  pop.appendChild(div);

  const newItem = document.createElement('div');
  newItem.className = 'pi-branch-item new-wt' + (_ntpBranchSelection.type === 'new' ? ' active' : '');
  const plusDot = document.createElement('span');
  plusDot.className = 'pi-branch-item-dot';
  plusDot.style.background = 'transparent';
  plusDot.style.border = '1.5px dashed currentColor';
  newItem.appendChild(plusDot);
  if (_ntpBranchSelection.type === 'new' && _ntpBranchSelection._editing) {
    // inline slug input
    const slugIn = document.createElement('input');
    slugIn.className = 'pi-branch-item-slug-input';
    slugIn.type = 'text';
    slugIn.placeholder = 'wt/<slug>  (leave empty = derive from the prompt)';
    slugIn.value = _ntpBranchSelection.customSlug || '';
    slugIn.addEventListener('click', e => e.stopPropagation());
    slugIn.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        _ntpBranchSelection = { type: 'new', customSlug: slugIn.value.trim() || null };
        renderNtpBranchButtonLabel();
        closeNtpBranchPop();
      } else if (e.key === 'Escape') {
        closeNtpBranchPop();
      }
    });
    newItem.appendChild(slugIn);
    setTimeout(() => slugIn.focus(), 0);
  } else {
    const newName = document.createElement('span');
    newName.className = 'pi-branch-item-name';
    newName.textContent = '+ Novo worktree';
    newItem.appendChild(newName);
    const newHint = document.createElement('span');
    newHint.className = 'pi-branch-item-hint';
    newHint.textContent = _ntpBranchSelection.type === 'new' && _ntpBranchSelection.customSlug
      ? 'slug: ' + _ntpBranchSelection.customSlug
      : 'type or derive from the prompt';
    newItem.appendChild(newHint);
    newItem.addEventListener('click', () => {
      // First click selects 'new' mode; second click reveals the slug input.
      if (_ntpBranchSelection.type === 'new') {
        _ntpBranchSelection._editing = true;
        _ntpRenderBranchPop();
      } else {
        _ntpBranchSelection = { type: 'new', customSlug: null };
        renderNtpBranchButtonLabel();
        closeNtpBranchPop();
      }
    });
  }
  pop.appendChild(newItem);
  navItems.push(newItem);

  // apply keynav highlight
  navItems.forEach((el, i) => el.classList.toggle('keynav', i === _ntpBranchKeyIndex));
  pop._navItems = navItems;
}

function _ntpHandleBranchKey(key) {
  const pop = document.getElementById('ntpBranchPop');
  if (!pop || !pop._navItems) return;
  const items = pop._navItems;
  if (!items.length) return;
  if (key === 'ArrowDown') {
    _ntpBranchKeyIndex = (_ntpBranchKeyIndex + 1) % items.length;
  } else if (key === 'ArrowUp') {
    _ntpBranchKeyIndex = (_ntpBranchKeyIndex - 1 + items.length) % items.length;
  } else if (key === 'Enter') {
    const el = items[_ntpBranchKeyIndex];
    if (el) el.click();
    return;
  }
  items.forEach((el, i) => el.classList.toggle('keynav', i === _ntpBranchKeyIndex));
  // scroll into view if needed
  const cur = items[_ntpBranchKeyIndex];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function openNtpBranchPop() {
  _ntpBranchKeyIndex = 0;
  _ntpBranchFilter = '';
  // Strip ephemeral _editing flag from previous open
  if (_ntpBranchSelection && _ntpBranchSelection._editing) delete _ntpBranchSelection._editing;
  _ntpRenderBranchPop();
  const pop = document.getElementById('ntpBranchPop');
  if (!pop) return;
  pop.classList.remove('hidden');

  // Close on outside click
  setTimeout(() => {
    const closer = (ev) => {
      const btn = document.getElementById('ntpBranchBtn');
      if (pop.contains(ev.target) || (btn && btn.contains(ev.target))) return;
      closeNtpBranchPop();
      document.removeEventListener('click', closer);
    };
    document.addEventListener('click', closer);
  }, 0);
}

function closeNtpBranchPop() {
  const pop = document.getElementById('ntpBranchPop');
  if (pop) pop.classList.add('hidden');
}

function toggleNtpBranchPop() {
  const pop = document.getElementById('ntpBranchPop');
  if (!pop) return;
  if (pop.classList.contains('hidden')) openNtpBranchPop();
  else closeNtpBranchPop();
}

function getRememberedFolders() {
  // Combine localStorage MRU list with cwd's from all known threads (so the
  // user can pick any folder Norya has ever launched codex in).
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem('norya-recent-folders') || '[]'); } catch {}
  const fromThreads = Array.from(new Set((st.allThreads || [])
    .map(t => t.cwd).filter(c => typeof c === 'string' && c.startsWith('/'))));
  // Stored first (most recent), then thread cwd's not already in stored
  const merged = [];
  for (const f of stored) if (!merged.includes(f)) merged.push(f);
  for (const f of fromThreads) if (!merged.includes(f)) merged.push(f);
  return merged.slice(0, 30);
}
function rememberFolder(folder) {
  try {
    let stored = JSON.parse(localStorage.getItem('norya-recent-folders') || '[]');
    stored = stored.filter(f => f !== folder);
    stored.unshift(folder);
    stored = stored.slice(0, 30);
    localStorage.setItem('norya-recent-folders', JSON.stringify(stored));
  } catch {}
}

function openFolderPicker(anchor) {
  closeFolderPicker();
  const pop = document.createElement('div');
  pop.className = 'folder-pop';
  pop.id = 'folderPop';

  const recents = getRememberedFolders();
  let html = `<div class="folder-item new" id="folderPickBrowse">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
      <span>Select folder…</span>
    </div>`;
  if (recents.length) {
    html += '<div class="folder-pop-section" style="border-top:1px solid var(--main-border);margin-top:6px;padding-top:8px">Recentes</div>';
    html += recents.map(f => {
      const short = f.split(/[\\/]/).slice(-2).join('/') || f;
      return `<div class="folder-item" data-folder="${f.replace(/"/g,'&quot;')}">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/></svg>
        <span class="folder-item-path">${short}</span>
        <span class="folder-item-sub">${f}</span>
      </div>`;
    }).join('');
  }
  pop.innerHTML = html;

  document.body.appendChild(pop);
  // Position above the trigger
  requestAnimationFrame(() => {
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    let top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  });

  pop.querySelectorAll('.folder-item[data-folder]').forEach(el => {
    el.addEventListener('click', () => {
      setNtpFolder(el.dataset.folder);
      closeFolderPicker();
    });
  });
  document.getElementById('folderPickBrowse').addEventListener('click', async () => {
    closeFolderPicker();
    const folder = await api.pickFolder().catch(() => null);
    if (folder) setNtpFolder(folder);
  });

  // Click outside closes
  setTimeout(() => {
    function onDocClick(e) {
      if (!pop.contains(e.target) && e.target.id !== 'ntpPickFolderBtn' && !e.target.closest('#ntpPickFolderBtn')) {
        closeFolderPicker();
        document.removeEventListener('click', onDocClick);
      }
    }
    document.addEventListener('click', onDocClick);
  }, 0);
}
function closeFolderPicker() {
  const old = document.getElementById('folderPop');
  if (old) old.remove();
}

document.getElementById('ntpPickFolderBtn').addEventListener('click', e => {
  e.stopPropagation();
  if (document.getElementById('folderPop')) { closeFolderPicker(); return; }
  openFolderPicker(e.currentTarget);
});

document.getElementById('ntpField').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  updateNtpSendState();
  // agent/branches: live slug preview when creating a new worktree
  if (typeof updateNtpSlugPreview === 'function') updateNtpSlugPreview();
});

document.getElementById('ntpField').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    console.log('[ntpField keydown] Enter — calling ntpSubmit');
    ntpSubmit();
  }
});

document.getElementById('ntpSendBtn').addEventListener('click', () => {
  console.log('[ntpSendBtn click] — calling ntpSubmit');
  ntpSubmit();
});

async function ntpSubmit() {
  try {
    const text = document.getElementById('ntpField').value.trim();
    // Always read account fresh from the dropdown
    ntpAcc = getCurrentNtpAcc();
    console.log('[ntpSubmit] start', { text: !!text, ntpAcc: ntpAcc && ntpAcc.num, ntpFolder });
    if (!text) { updateNtpSendState(); return; }
    if (!ntpAcc) {
      alert('Pick an account in the dropdown first.');
      updateNtpSendState();
      return;
    }
    // Block submission only for ChatGPT-mode profiles (quota check is about
    // the codex ChatGPT auth; doesn't apply to apikey/openrouter modes).
    const accQuota = st.quota[String(ntpAcc.num)];
    const isChatGptMode = ntpAcc.authMode === 'chatgpt' || ntpAcc.authMode == null;
    if (isChatGptMode && accQuota && accQuota.loggedOut === true) {
      alert(
        'Profile "' + (ntpAcc.name || 'Profile ' + ntpAcc.num) + '" is logged out of ChatGPT.\n\n' +
        'The codex CLI returned 401 token_invalidated. Log in again before starting a task:\n\n' +
        '  CODEX_HOME=' + (ntpAcc.dir || '~/.codex-panel/accounts/' + ntpAcc.num) + '/.codex codex login\n\n' +
        '(Or in Profile settings, switch to "API Key" or "OpenRouter".)'
      );
      return;
    }
    if (!ntpFolder) {
      console.log('[ntpSubmit] opening folder picker');
      const folder = await api.pickFolder().catch(() => null);
      console.log('[ntpSubmit] picker returned', folder);
      if (!folder) { updateNtpSendState(); return; }
      ntpFolder = folder;
      const label = document.getElementById('ntpFolderLabel');
      const short = folder.split(/[\\/]/).slice(-2).join('/') || folder;
      if (label) label.textContent = short;
      document.getElementById('ntpPickFolderBtn').classList.add('picked');
    }

    // Grid é a única view (2026-07-10): não trocamos mais para 'single' nem
    // montamos o xterm avulso. A landing só fecha lá embaixo, no bloco pós-spawn,
    // quando o pane novo já entrou no grid — evita piscar o grid vazio durante o
    // await de picker/worktree/spawn.
    console.log('[ntpSubmit] ntpFolder=', ntpFolder);

    st.selectedAccountNum = ntpAcc.num;
    document.querySelectorAll('.acc-item').forEach(el => el.classList.toggle('selected', parseInt(el.dataset.num) === ntpAcc.num));
    updateHeader();

    // Fase 6: resolve effective cwd based on branch selection (worktree support)
    let effectiveCwd = ntpFolder;
    const projectId = folderToProjectId(ntpFolder);
    if (_ntpBranchSelection.type === 'new') {
      // agent/branches: prefer custom slug typed in dropdown, fall back to deriveSlug
      let slug = _ntpBranchSelection.customSlug && _ntpBranchSelection.customSlug.trim()
        ? _ntpBranchSelection.customSlug.replace(/^wt\//, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
        : null;
      if (!slug) {
        const slugRes = await api.deriveSlug(text, projectId).catch(() => null);
        slug = slugRes && slugRes.slug ? slugRes.slug : 'thread';
      }
      const wtRes = await api.gitWorktreeAdd({ projectId, slug, projectDir: ntpFolder });
      if (wtRes && wtRes.error) {
        alert('Failed to create worktree:\n' + wtRes.error + '\n\nUsando branch principal.');
      } else if (wtRes && wtRes.path) {
        effectiveCwd = wtRes.path;
        console.log('[ntpSubmit] created worktree', wtRes);
      }
    } else if (_ntpBranchSelection.type === 'existing' && _ntpBranchSelection.worktreePath) {
      effectiveCwd = _ntpBranchSelection.worktreePath;
    } else if (_ntpBranchSelection.type === 'attach' && _ntpBranchSelection.branch) {
      // agent/branches: branch exists but no worktree → create one wired to it
      const branchName = _ntpBranchSelection.branch;
      const slug = branchName.replace(/^wt\//, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'thread';
      const wtRes = await api.gitWorktreeAdd({ projectId, slug, projectDir: ntpFolder, branch: branchName });
      if (wtRes && wtRes.error) {
        alert('Failed to attach worktree at ' + branchName + ':\n' + wtRes.error + '\n\nUsando branch principal.');
      } else if (wtRes && wtRes.path) {
        effectiveCwd = wtRes.path;
        console.log('[ntpSubmit] attached worktree on existing branch', wtRes);
      }
    }

    // Reuse the pre-spawned PTY (kicked off by setNtpFolder) if it matches.
    // Otherwise spawn a fresh one — same options as before.
    const profileNumForSpawn = st.activeProfileNum != null ? st.activeProfileNum : ntpAcc.num;
    const preSpawnMatches = _ntpPreSpawn
      && _ntpPreSpawn.acc && _ntpPreSpawn.acc.num === ntpAcc.num
      && _ntpPreSpawn.cwd === effectiveCwd
      && st.termRunning[_ntpPreSpawn.spawnId];
    let spawnId;
    if (preSpawnMatches) {
      spawnId = _ntpPreSpawn.spawnId;
      console.log('[ntpSubmit] reusing pre-spawned terminal', { spawnId, ready: _ntpPreSpawn.ready });
    } else {
      if (_ntpPreSpawn) ntpKillPreSpawn(); // mismatched preSpawn — discard it
      console.log('[ntpSubmit] launching terminal', { acc: ntpAcc.num, cwd: effectiveCwd, projectId });
      spawnId = launchTerminal(ntpAcc, {
        mode: 'new-folder',
        cwd: effectiveCwd,
        projectId,
        profileNum: profileNumForSpawn,
      });
      console.log('[ntpSubmit] spawnId =', spawnId);
    }

    // Grid é a única view: o spawn novo entra como pane focado. O provisional
    // key é o próprio spawnId (vira threadId real no latch, abaixo). renderGrid
    // monta o xterm ao vivo da célula (buildGridCellXterm) e replaya o buffer;
    // termRunning[spawnId] já foi ligado por launchTerminal.
    st.spawnByThread[spawnId] = spawnId;
    hideNewThreadPanel();
    addThreadToGrid(spawnId);
    if (typeof renderGrid === 'function') renderGrid();
    setGridFocus(spawnId);

    // Send the user's first message directly. The pre-spawn flow (kicked off
    // by setNtpFolder) means the codex TUI is already booted and idle by now;
    // if not, fall back to a 2500ms delay to cover the bootstrap window.
    // NB: codex TUI is in raw mode — it expects \r (Enter), not \n (LF).
    const usedPreSpawn = (_ntpPreSpawn && _ntpPreSpawn.spawnId === spawnId && _ntpPreSpawn.ready);
    const sendDelay = usedPreSpawn ? 50 : 2500;
    setTimeout(() => {
      console.log('[ntpSubmit] sending first message to', spawnId, '(preSpawn=' + usedPreSpawn + ', delay=' + sendDelay + 'ms)');
      api.sendInput(spawnId, text + '\r');
    }, sendDelay);

    // Latch the thread once codex names it. With pre-spawn idiomatic flow, we
    // only need ONE strategy: poll the threads table — codex inserts the row
    // after the first user_event completes (typically 5-30s into the turn).
    // TODAS as ids no momento do spawn — o filtro por accountNum deixava as
    // threads do Claude (accountNum null) fora do "antes" E do "depois", e o
    // latch nunca disparava para elas (ver _latchCandidates em views.js).
    const beforeIds = new Set((st.allThreads || []).map(t => t.id));
    let threadLatched = false;

    function latch(threadId, source) {
      if (threadLatched) return;
      threadLatched = true;
      console.log('[ntpSubmit] latched threadId=' + threadId + ' via ' + source);
      // Swap provisional spawnId-as-thread mapping → real threadId.
      if (st.spawnByThread[spawnId] === spawnId) delete st.spawnByThread[spawnId];
      st.selectedThreadId = threadId;
      st.spawnByThread[threadId] = spawnId;
      // Grid: o pane entrou no roster com o spawnId provisório como id. Como o
      // self-mapping spawnByThread[spawnId] acabou de sumir acima, o roster
      // precisa migrar spawnId→threadId real — senão o próximo renderGrid filtra
      // o pane pra fora e ele some do grid. Mesmo padrão do createThreadInFolder
      // (views.js). Preserva o foco/último-interagido no pane recém-latchado.
      if (st.gridMode && Array.isArray(st.gridMode.threadIds)) {
        const gi = st.gridMode.threadIds.indexOf(spawnId);
        if (gi >= 0) {
          st.gridMode.threadIds[gi] = threadId;
          if (st.gridMode.focusedThreadId === spawnId) st.gridMode.focusedThreadId = threadId;
          if (st.gridMode.lastInteracted === spawnId) st.gridMode.lastInteracted = threadId;
          if (typeof saveGridStateToStorage === 'function') saveGridStateToStorage();
          if (document.getElementById('app').dataset.view === 'grid' && typeof renderGrid === 'function') renderGrid();
        }
      }
      updateInputState();
      const ownerNum = st.activeProfileNum != null ? st.activeProfileNum : ntpAcc.num;
      api.threadOwnerSet(threadId, ownerNum).catch(e => console.warn('thread-owner-set failed', e));
      persistThreadAgent(threadId, spawnId);
    }

    async function findNewThreadDB(retries) {
      if (threadLatched) return;
      await refreshThreads();
      const mine = _latchCandidates(beforeIds, ntpAcc.num, effectiveCwd, spawnId);
      if (mine.length) {
        latch(mine[0].id, 'db');
        return;
      }
      if (retries > 0) setTimeout(() => findNewThreadDB(retries - 1), 1500);
      // PTY vivo sem linha no DB ainda — segue tentando devagar (mesma razão
      // do poll() de views.js: fantasma "New thread" permanente).
      else if (st.termRunning[spawnId]) setTimeout(() => findNewThreadDB(0), 30000);
      else console.warn('[ntpSubmit] never found the new thread in the DB');
    }

    // 60 retries × 1500ms = 90s max — gives the model time to finish the first
    // turn and codex enough time to persist the thread row.
    setTimeout(() => findNewThreadDB(60), 2500);

    // Pre-spawn was consumed (or this submit triggered a fresh spawn). Clear
    // the pre-spawn slot so a future ntpPanel open starts clean.
    if (_ntpPreSpawn && _ntpPreSpawn.spawnId === spawnId) _ntpPreSpawn = null;

    // Aggressive refresh of allThreads + projects so new thread appears
    // in the sidebar quickly (the latch above sets selectedThreadId but
    // doesn't guarantee the row is in allThreads yet). Fires for 30s.
    let refreshTries = 15;
    const refreshInterval = setInterval(async () => {
      await refreshThreads();
      if (--refreshTries <= 0 || (threadLatched && st.allThreads.some(t => t.id === st.selectedThreadId))) {
        clearInterval(refreshInterval);
      }
    }, 2000);
  } catch (err) {
    console.error('[ntpSubmit] crashed:', err);
    alert('Something went wrong starting the task:\n\n' + (err && err.message || err));
  }
}

// ── Attachment strip ────────────────────────────────────────────────────────────
document.getElementById('imageFileInput').addEventListener('change', function() {
  Array.from(this.files).forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      st.attachments.push({ dataUrl: e.target.result, file });
      renderAttachmentStrip();
    };
    reader.readAsDataURL(file);
  });
  this.value = '';
});

function renderAttachmentStrip() {
  const strip = document.getElementById('attachmentStrip');
  strip.innerHTML = '';
  if (!st.attachments.length) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  st.attachments.forEach((att, i) => {
    const thumb = document.createElement('div'); thumb.className = 'attach-thumb';
    const img = document.createElement('img'); img.src = att.dataUrl;
    img.addEventListener('click', () => openLightbox(att.dataUrl));
    const rm = document.createElement('div'); rm.className = 'attach-remove'; rm.textContent = '✕';
    rm.addEventListener('click', e => { e.stopPropagation(); st.attachments.splice(i, 1); renderAttachmentStrip(); });
    thumb.append(img, rm); strip.appendChild(thumb);
  });
}

// Trigger file pick from the + button when already in a session
document.getElementById('btnPickFolder').addEventListener('click', async () => {
  const overrideNum = st.selectedAccountOverride;
  const num = overrideNum != null ? overrideNum : st.selectedAccountNum;
  const running = num != null && st.termRunning[num];
  if (running) {
    document.getElementById('imageFileInput').click();
    return;
  }
  if (num == null) { showNewThreadPanel(); return; }
  const acc = st.accounts.find(a => a.num === num);
  if (!acc) return;
  const folder = await api.pickFolder().catch(() => null);
  if (!folder) return;
  st.selectedAccountNum = num;
  // Grid é a única view (2026-07-10): o terminal novo entra como pane focado,
  // sem trocar para 'single'. O antigo guard (if view !== 'single' → switchView)
  // existia só pra não atropelar a view do usuário; em grid-only não há outra
  // view pra proteger. Mesmo fluxo do spawn da landing (spawn vira pane).
  const spawnId = launchTerminal(acc, { mode: 'new-folder', cwd: folder });
  if (spawnId) {
    st.spawnByThread[spawnId] = spawnId;
    addThreadToGrid(spawnId);
    if (typeof renderGrid === 'function') renderGrid();
    setGridFocus(spawnId);
  }
});

// ── Lightbox ───────────────────────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}
document.getElementById('lightboxClose').addEventListener('click', () => document.getElementById('lightbox').classList.add('hidden'));
document.getElementById('lightbox').addEventListener('click', function(e) { if (e.target === this) this.classList.add('hidden'); });

// ── Toolbar (consolidated config dropdown) ─────────────────────────────────────
function updateToolbarLabel() {
  const label = document.getElementById('tcLabel');
  if (!label) return;
  const effort = st.reasoningEffort || 'xhigh';
  const model = st.selectedModel || 'gpt-5.5';
  const fast = st.fastMode ? '· fast' : '';
  const acc = st.selectedAccountOverride;
  const accLabel = acc != null ? (st.accounts.find(a => a.num === acc)?.name || 'Acc ' + acc) : '';
  const parts = [model, effort];
  if (fast) parts.push('fast');
  if (accLabel) parts.push(accLabel);
  label.textContent = parts.join(' · ');
}

function positionPopAbove(pop, trigger) {
  pop.style.visibility = 'hidden';
  pop.classList.remove('hidden');
  // Measure after layout
  requestAnimationFrame(() => {
    const r = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.right - pw;
    if (left < 8) left = 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    let top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8; // flip below if no room above
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.visibility = '';
  });
}

function togglePop(popId, trigger) {
  const pop = document.getElementById(popId);
  if (!pop) { console.warn('togglePop: missing #' + popId); return; }
  // Reparent to document.body to escape any ancestor with transform/contain
  // (the new-thread panel has transforms during its sending animation, which
  // creates a containing block for position:fixed and breaks popovers).
  if (pop.parentNode !== document.body) {
    document.body.appendChild(pop);
  }
  // Close the other popover + clear its open class
  const otherId = popId === 'toolbarConfigPop' ? 'toolbarSlashPop' : 'toolbarConfigPop';
  const otherPop = document.getElementById(otherId);
  if (otherPop) otherPop.classList.add('hidden');
  ['btnToolbarConfig','btnSlashMenu','ntpConfigBtn','ntpSlashBtn'].forEach(tid => {
    const t = document.getElementById(tid);
    if (t && t !== trigger) t.classList.remove('popover-open');
  });
  if (pop.classList.contains('hidden')) {
    positionPopAbove(pop, trigger);
    if (trigger) trigger.classList.add('popover-open');
    console.log('togglePop OPEN', popId, 'trigger=', trigger && trigger.id);
  } else {
    pop.classList.add('hidden');
    if (trigger) trigger.classList.remove('popover-open');
    console.log('togglePop CLOSE', popId);
  }
}

document.getElementById('btnToolbarConfig').addEventListener('click', e => {
  e.stopPropagation();
  togglePop('toolbarConfigPop', e.currentTarget);
});
document.addEventListener('click', e => {
  ['toolbarConfigPop','toolbarSlashPop'].forEach(id => {
    const pop = document.getElementById(id);
    if (!pop || pop.classList.contains('hidden')) return;
    const triggerIds = ['btnToolbarConfig','btnSlashMenu','ntpConfigBtn','ntpSlashBtn'];
    if (pop.contains(e.target)) return;
    if (triggerIds.some(t => e.target.id === t || e.target.closest('#' + t))) return;
    pop.classList.add('hidden');
    // Also clear popover-open class on all triggers when closing via outside click
    triggerIds.forEach(tid => {
      const t = document.getElementById(tid);
      if (t) t.classList.remove('popover-open');
    });
  });
});

document.querySelectorAll('.tc-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    st.reasoningEffort = pill.dataset.effort;
    document.querySelectorAll('.tc-pill').forEach(p => p.classList.toggle('active', p === pill));
    updateToolbarLabel();
  });
});

// Feature toggle pills inside the prompt input box (search / fast)
function syncPiTogglesFromState() {
  document.querySelectorAll('.pi-toggle').forEach(btn => {
    const t = btn.dataset.toggle;
    let on = false;
    if (t === 'search') on = !!st.webSearch;
    else if (t === 'fast') on = !!st.fastMode;
    btn.classList.toggle('active', on);
  });
  // Sync the Full Access checkbox in the popover with state
  const fullCb = document.getElementById('toolbarFullAccess');
  if (fullCb) fullCb.checked = !!st.fullAccess;
  // Sync reasoning effort pills
  document.querySelectorAll('.tc-pill[data-effort]').forEach(p => {
    p.classList.toggle('active', p.dataset.effort === st.reasoningEffort);
  });
  updateToolbarLabel();
}

document.querySelectorAll('.pi-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.toggle;
    if (t === 'search') st.webSearch = !st.webSearch;
    else if (t === 'fast') st.fastMode = !st.fastMode;
    syncPiTogglesFromState();
  });
});

// Full Access checkbox in config popover
document.getElementById('toolbarFullAccess').addEventListener('change', function() {
  st.fullAccess = this.checked;
  syncPiTogglesFromState();
});

// ntp's own slash + config buttons open the SAME popovers but anchored to themselves
document.getElementById('ntpSlashBtn').addEventListener('click', e => {
  e.stopPropagation();
  const pop = document.getElementById('toolbarSlashPop');
  if (pop.innerHTML === '') renderSlashMenu();
  togglePop('toolbarSlashPop', e.currentTarget);
});
document.getElementById('ntpConfigBtn').addEventListener('click', e => {
  e.stopPropagation();
  togglePop('toolbarConfigPop', e.currentTarget);
});

// Slash commands menu (codex CLI slash commands)
const SLASH_COMMANDS = [
  { name: '/model',    desc: 'Switch the current model' },
  { name: '/fast',     desc: 'Use the fast service tier (priority)' },
  { name: '/init',     desc: 'Initialize an AGENTS.md for this project' },
  { name: '/compact',  desc: 'Compact conversation to free context' },
  { name: '/memory',   desc: 'Manage codex memories' },
  { name: '/status',   desc: 'Show session info & token usage' },
  { name: '/review',   desc: 'Run a code review on changes' },
  { name: '/sandbox',  desc: 'Change sandbox / approval mode' },
  { name: '/search',   desc: 'Toggle live web search' },
  { name: '/context',  desc: 'Show context window usage' },
  { name: '/verbose',  desc: 'Toggle verbose logging' },
  { name: '/continue', desc: 'Continue the previous turn' },
  { name: '/clear',    desc: 'Clear the terminal' },
  { name: '/reset',    desc: 'Reset conversation' },
  { name: '/export',   desc: 'Export current session' },
  { name: '/copy',     desc: 'Copy last response to clipboard' },
  { name: '/help',     desc: 'Show available commands' },
];

function renderSlashMenu() {
  const pop = document.getElementById('toolbarSlashPop');
  pop.innerHTML = SLASH_COMMANDS.map(c =>
    `<div class="slash-item" data-cmd="${c.name}"><span class="slash-name">${c.name}</span><span class="slash-desc">${c.desc}</span></div>`
  ).join('');
  pop.querySelectorAll('.slash-item').forEach(el => {
    el.addEventListener('click', () => {
      const cmd = el.dataset.cmd;
      pop.classList.add('hidden');
      const spawnId = st.selectedThreadId && st.spawnByThread[st.selectedThreadId];
      if (spawnId && st.termRunning[spawnId]) {
        api.sendInput(spawnId, cmd + '\r');
      } else {
        const field = document.getElementById('inputField');
        field.value = cmd + ' ';
        field.focus();
      }
    });
  });
}

document.getElementById('btnSlashMenu').addEventListener('click', e => {
  e.stopPropagation();
  const pop = document.getElementById('toolbarSlashPop');
  if (pop.innerHTML === '') renderSlashMenu();
  togglePop('toolbarSlashPop', e.currentTarget);
});

document.getElementById('toolbarModel').addEventListener('change', function() {
  st.selectedModel = this.value;
  updateToolbarLabel();
});
document.getElementById('toolbarAccount').addEventListener('change', function() {
  st.selectedAccountOverride = this.value ? parseInt(this.value) : null;
  updateToolbarLabel();
});

async function renderToolbarModels() {
  const sel = document.getElementById('toolbarModel');
  if (!sel) return;
  try {
    const list = await api.listCodexModels();
    if (!list || !list.length) return;
    sel.innerHTML = '<option value="">Default (codex picks)</option>' +
      list.map(m => `<option value="${m.slug}">${m.display_name || m.slug}</option>`).join('');
  } catch {}
}
function renderToolbarAccounts() {
  const sel = document.getElementById('toolbarAccount');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Auto (current selection)</option>' +
    st.accounts.map(a => `<option value="${a.num}">${(a.name || 'Account ' + a.num).replace(/</g,'&lt;')}</option>`).join('');
  if (prev) sel.value = prev;
}

