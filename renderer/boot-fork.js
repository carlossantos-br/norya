/**
 * renderer/boot-fork.js — listeners globais de IPC, init(), botão/dropdown de perfil, fork.
 *
 * Script CLÁSSICO (ver renderer/state.js): fatia contígua extraída de
 * test-window.html em 2026-07-10, na ordem original. Compartilha o escopo
 * léxico global com os outros — `st`, `api`, `ipcRenderer` e as funções de
 * cada fatia enxergam-se sem import. Ordem de carga preservada = zero mudança
 * de comportamento.
 */
'use strict';

// ── Global IPC listeners ───────────────────────────────────────────────────────
ipcRenderer.on('quota-updated', (_, payload) => {
  if (!payload || payload.num == null) return;
  // key = "12" (espelho do provider padrão — o que todo leitor antigo usa) ou
  // "12:codex" (um snapshot por provider, lido pelo painel Uso). Sem key
  // (caminho legado do main.js) cai no espelho.
  const key = payload.key || String(payload.num);
  st.quota[key] = { ...(st.quota[key] || {}), ...payload };
  renderAccountItem(payload.num);
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try { st.accounts = await api.getAccounts(); } catch { st.accounts = []; }
  try {
    const cache = await api.quotaGet();
    if (cache && typeof cache === 'object') Object.assign(st.quota, cache);
  } catch {}
  // Agente gravado por thread (só as escolhidas a dedo). Sem isto, reabrir uma
  // thread de Grok com o seletor em "Codex" a spawnaria na CLI errada.
  try { st.threadAgents = await api.threadAgentsAll() || {}; } catch { st.threadAgents = {}; }
  // agent/branches: load persisted branch-color overrides
  try {
    const overrides = await api.branchColorsGet();
    if (overrides && typeof overrides === 'object') Object.assign(_branchColorOverrides, overrides);
  } catch {}

  // Load all threads (cross-account)
  try {
    const all = await api.listThreads(null, null);
    st.allThreads = Array.isArray(all) ? all : []; invalidateSidebarCache();
  } catch { st.allThreads = []; }

  renderAccountList();
  renderToolbarAccounts();
  renderToolbarModels();
  // Sync new prompt-input toggle pills with default state
  syncPiTogglesFromState();
  renderProjectList();

  // Fase 2: load persisted active profile + render profile button
  try {
    const ns = await api.noryaStateGet();
    if (ns && ns.activeProfileNum != null) {
      // Validate: only restore if the profile still exists and is healthy
      const acc = st.accounts.find(a => a.num === ns.activeProfileNum);
      if (acc) {
        const q = st.quota[String(acc.num)];
        const h = getProfileHealth(acc, q);
        // Restore unless the profile is *definitively* unusable. 'pending'
        // (a chatgpt profile whose quota hasn't been checked yet — the norm at
        // cold boot, when the background quota storm hasn't finished) must still
        // restore; otherwise the saved profile was silently dropped every cold
        // start and the user landed with the composer locked. The background
        // quota check corrects the badge a moment later if it's actually dead.
        if (h.ok || h.status === 'pending') st.activeProfileNum = acc.num;
      }
    }
  } catch {}
  renderProfileButton();
  bindProfileButtonEvents();
  applyProfileEnforcement();
  if (typeof updateToolbarForActiveProfile === 'function') updateToolbarForActiveProfile();

  // Fase 6.1: detect git per project + enrich threads with real branch.
  // Runs in background (non-blocking) — re-renders sidebar when done.
  refreshGitInfoForProjects().catch(e => console.warn('refreshGitInfoForProjects', e));

  // Fase 7: load thread ownership map for visual dots in sidebar
  try {
    st.threadOwners = await api.threadOwnersAll() || {};
  } catch { st.threadOwners = {}; }
  updateForkButtonState();

  // Norya forks 2026-05-26: load fork-lineage cache (non-blocking, best-effort)
  try { await _refreshForkLineage(); } catch {}

  // Grid é a ÚNICA view (2026-07-10): o boot cai direto no grid, não mais na
  // landing single-xterm. loadGridStateFromStorage já força enabled=true;
  // enterGridMode é definido em grid.js, que carrega antes deste passo em
  // runtime (o boot roda pós-DOMContentLoaded), então a função já existe aqui.
  loadGridStateFromStorage();
  st.gridMode.enabled = true;
  updateNoryaGridButton();
  if (st.accounts.length) {
    if (typeof enterGridMode === 'function') enterGridMode();
    else document.getElementById('app').dataset.view = 'grid';
  } else {
    // Sem perfil ainda: 1ª tela do app. O grid é a única view, mas o placeholder
    // do grid ("clique numa thread") não guia quem não tem conta — e a empty-state
    // de boas-vindas (#outputEmpty, dentro de .output-area) fica escondida em grid
    // via `[data-view="grid"] .output-area { display:none }`. Marcamos body.onboarding
    // pra reexibir a empty-state por cima do grid (carve-out no CSS); showEmptyState
    // enche o texto "Welcome to Norya — adicione uma conta" e o interval de
    // onboarding (maybeShowOnboarding) troca depois pelos 3 cards. A classe sai
    // sozinha quando a 1ª conta entra (maybeHideOnboarding).
    document.getElementById('app').dataset.view = 'grid';
    document.body.classList.add('onboarding');
    showEmptyState();
  }

  // Working indicator interval — pause when window not visible to save CPU
  let _wiInterval = null;
  function startWi() { if (!_wiInterval) _wiInterval = setInterval(updateWorkingIndicators, 700); }
  function stopWi() { if (_wiInterval) { clearInterval(_wiInterval); _wiInterval = null; } }
  startWi();
  document.addEventListener('visibilitychange', () => { document.hidden ? stopWi() : startWi(); });

  // Refresh periódico da lista de threads (2026-07-22). Antes só boot/latch/
  // rename atualizavam st.allThreads — o ai-title que o Claude grava após o 1º
  // turno, os horários relativos e sessões criadas fora do Norya ficavam
  // congelados até o próximo evento. Pausado com a janela oculta, como acima.
  setInterval(() => {
    if (document.hidden) return;
    refreshThreads();   // coalesce + throttle + no-op se nada visível mudou
  }, 45000);

  // Dark mode toggle sync
  document.getElementById('darkModeToggle').checked = st.settings.theme === 'dark';

  // Boot finished — from here on New Thread creates instantly. If the user
  // clicked it during boot, honor that click now (never lose the click).
  st.initDone = true;
  if (_pendingNewThread) {
    _pendingNewThread = false;
    startNewThread();
  }
}

// ── Profile button + dropdown (Fase 2) ───────────────────────────────────────
function setActiveProfile(num, opts) {
  const persist = !opts || opts.persist !== false;
  const silent = !!(opts && opts.silent);
  const _prevActive = st.activeProfileNum;
  st.activeProfileNum = num == null ? null : parseInt(num, 10);
  // Bridge: keep legacy selectedAccountNum in sync until full refactor is done.
  st.selectedAccountNum = st.activeProfileNum;
  if (persist) {
    api.noryaStateSave({ activeProfileNum: st.activeProfileNum }).catch(() => {});
  }
  renderProfileButton();
  renderAccountList();      // legacy list mirrors selection
  applyProfileEnforcement();
  if (typeof updateToolbarForActiveProfile === 'function') updateToolbarForActiveProfile();
  if (typeof updateInputState === 'function') updateInputState();
  if (typeof updateHeader === 'function') updateHeader();
  // Feedback on a real, user-initiated switch (silent on boot/restore + the
  // automatic owner-coupling switch when opening a thread).
  if (!silent && st.activeProfileNum != null && st.activeProfileNum !== _prevActive) {
    try {
      const acc = (st.accounts || []).find(a => a.num === st.activeProfileNum);
      if (acc && typeof noryaToast === 'function') noryaToast('Switched to ' + (acc.name || ('Profile ' + acc.num)), 'info');
    } catch {}
  }
}

function renderProfileButton() {
  const btn = document.getElementById('profileButton');
  const dot = document.getElementById('profileButtonDot');
  const name = document.getElementById('profileButtonName');
  if (!btn || !dot || !name) return;
  const acc = st.activeProfileNum != null
    ? st.accounts.find(a => a.num === st.activeProfileNum)
    : null;
  if (acc) {
    btn.classList.remove('empty');
    dot.classList.remove('empty');
    dot.style.background = acc.color || 'var(--accent)';
    name.textContent = acc.name || ('Profile ' + acc.num);
    btn.title = `Active profile: ${name.textContent}`;
  } else {
    btn.classList.add('empty');
    dot.classList.add('empty');
    dot.style.background = '';
    name.textContent = 'Select a profile';
    btn.title = 'Select a profile to create tasks and send messages';
  }
}

function renderProfileDropdown() {
  const dd = document.getElementById('profileDropdown');
  if (!dd) return;
  // Clear via DOM (avoid innerHTML for safety)
  while (dd.firstChild) dd.removeChild(dd.firstChild);

  // Partition profiles: active first (has at least 1 thread running owned by it),
  // then healthy others, then unavailable
  const accs = (st.accounts || []).slice();
  const isOwning = acc => Object.values(st.termRunning || {}).some(running => {
    if (!running) return false;
    return Object.entries(st.spawnAccount || {}).some(([sid, n]) => n === acc.num && st.termRunning[sid]);
  });
  const groups = { active: [], other: [], unavailable: [] };
  for (const acc of accs) {
    const q = st.quota[String(acc.num)];
    const h = getProfileHealth(acc, q);
    // Claude profiles needing login go to "Profiles" (not Unavailable) — they
    // CAN be activated to bootstrap the login flow. Same for already-expired
    // OAuth (user needs to re-login from inside this profile's terminal).
    const claudeNeedsLogin = acc.authMode === 'claude'
      && (!acc.hasClaudeAuth || h.status === 'claude-expired');
    if (!h.ok && !claudeNeedsLogin) groups.unavailable.push({ acc, health: h });
    else if (isOwning(acc)) groups.active.push({ acc, health: h });
    else groups.other.push({ acc, health: h });
  }

  const appendSection = (title, items) => {
    if (!items.length) return;
    const t = document.createElement('div');
    t.className = 'profile-section-title';
    t.textContent = title;
    dd.appendChild(t);
    for (const { acc, health } of items) {
      dd.appendChild(makeProfileItem(acc, health, title === 'Active'));
    }
  };
  appendSection('Active', groups.active);
  appendSection('Profiles', groups.other);
  appendSection('Unavailable', groups.unavailable);

  // Divider + actions
  const div = document.createElement('div');
  div.className = 'profile-divider';
  dd.appendChild(div);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'profile-action-btn';
  settingsBtn.innerHTML = '';   // explicit empty (safer than relying on default)
  const settingsIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  settingsIcon.setAttribute('viewBox', '0 0 24 24');
  settingsIcon.setAttribute('fill', 'none');
  settingsIcon.setAttribute('stroke', 'currentColor');
  settingsIcon.setAttribute('stroke-width', '2');
  const sp1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  sp1.setAttribute('cx', '12'); sp1.setAttribute('cy', '12'); sp1.setAttribute('r', '3');
  settingsIcon.appendChild(sp1);
  settingsBtn.appendChild(settingsIcon);
  const settingsLbl = document.createElement('span');
  settingsLbl.textContent = 'Profile settings';
  settingsBtn.appendChild(settingsLbl);
  settingsBtn.addEventListener('click', () => {
    closeProfileDropdown();
    // Fase 3: open the Settings modal directly on the Profiles tab
    if (typeof openSettings === 'function') {
      openSettings('profiles');
    } else {
      const settingsModal = document.getElementById('modalSettings');
      if (settingsModal) settingsModal.classList.remove('hidden');
    }
    // Auto-expand the active profile's card so the user lands on its config
    if (st.activeProfileNum != null) {
      _profilesTabExpanded.add(st.activeProfileNum);
      setTimeout(() => renderProfilesTab(), 50);
    }
  });
  if (st.activeProfileNum == null) {
    settingsBtn.classList.add('requires-profile-disabled');
  }
  dd.appendChild(settingsBtn);

  const addBtn = document.createElement('button');
  addBtn.className = 'profile-action-btn';
  const plusIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  plusIcon.setAttribute('viewBox', '0 0 12 12');
  plusIcon.setAttribute('fill', 'none');
  plusIcon.setAttribute('stroke', 'currentColor');
  plusIcon.setAttribute('stroke-width', '1.6');
  const pPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pPath.setAttribute('d', 'M6 1v10M1 6h10');
  pPath.setAttribute('stroke-linecap', 'round');
  plusIcon.appendChild(pPath);
  addBtn.appendChild(plusIcon);
  const addLbl = document.createElement('span');
  addLbl.textContent = 'Add profile';
  addBtn.appendChild(addLbl);
  addBtn.addEventListener('click', () => {
    closeProfileDropdown();
    const addModal = document.getElementById('modalAdd');
    if (addModal) addModal.classList.remove('hidden');
  });
  dd.appendChild(addBtn);
}

function makeProfileItem(acc, health, isActive) {
  const item = document.createElement('div');
  item.className = 'profile-item'
    + (acc.num === st.activeProfileNum ? ' active' : '')
    + (!health.ok ? ' unavailable' : '');
  item.dataset.num = acc.num;
  if (!health.ok) item.title = health.message;

  const dot = document.createElement('span');
  dot.className = 'profile-item-dot';
  dot.style.background = acc.color || 'var(--text-faint)';
  item.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'profile-item-name';
  name.textContent = acc.name || ('Profile ' + acc.num);
  item.appendChild(name);

  if (isActive) {
    const badge = document.createElement('span');
    badge.className = 'profile-item-badge';
    badge.textContent = 'Active';
    item.appendChild(badge);
  }

  if (!health.ok) {
    const warn = document.createElement('span');
    warn.className = 'profile-item-warn';
    warn.textContent = health.status === 'pending' ? '?' : '!';
    warn.title = health.message;
    item.appendChild(warn);
  } else if (acc.num === st.activeProfileNum) {
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'profile-item-check');
    check.setAttribute('viewBox', '0 0 12 12');
    check.setAttribute('fill', 'none');
    check.setAttribute('stroke', 'currentColor');
    check.setAttribute('stroke-width', '2');
    const checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    checkPath.setAttribute('d', 'M2 6.5l3 3 5-6');
    checkPath.setAttribute('stroke-linecap', 'round');
    checkPath.setAttribute('stroke-linejoin', 'round');
    check.appendChild(checkPath);
    item.appendChild(check);
  }

  item.addEventListener('click', e => {
    e.stopPropagation();
    // Claude profiles can be activated even before login — the user must
    // activate first, then run `claude login` from a spawned terminal.
    // Also allow activation when the saved token expired (same rationale).
    const claudeNeedsLogin = acc.authMode === 'claude'
      && (!acc.hasClaudeAuth || health.status === 'claude-expired');
    if (!health.ok && !claudeNeedsLogin) return;
    setActiveProfile(acc.num);
    closeProfileDropdown();
  });
  return item;
}

function openProfileDropdown() {
  const dd = document.getElementById('profileDropdown');
  const btn = document.getElementById('profileButton');
  if (!dd || !btn) return;
  renderProfileDropdown();
  dd.classList.remove('hidden');
  btn.classList.add('open');
  st.profileDropdownOpen = true;
}

function closeProfileDropdown() {
  const dd = document.getElementById('profileDropdown');
  const btn = document.getElementById('profileButton');
  if (!dd || !btn) return;
  dd.classList.add('hidden');
  btn.classList.remove('open');
  st.profileDropdownOpen = false;
}

function toggleProfileDropdown() {
  if (st.profileDropdownOpen) closeProfileDropdown();
  else openProfileDropdown();
}

function bindProfileButtonEvents() {
  const btn = document.getElementById('profileButton');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', e => { e.stopPropagation(); toggleProfileDropdown(); });
  }
  if (!document._profileDropdownGlobalBound) {
    document._profileDropdownGlobalBound = true;
    document.addEventListener('click', e => {
      if (!st.profileDropdownOpen) return;
      const dd = document.getElementById('profileDropdown');
      const btn = document.getElementById('profileButton');
      if (dd && (dd.contains(e.target) || (btn && btn.contains(e.target)))) return;
      closeProfileDropdown();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && st.profileDropdownOpen) closeProfileDropdown();
    });
  }
}

// Adapt toolbar pop + pi-toggles to the active profile's provider. OpenAI-only
// features (Reasoning effort, Fast tier, Web Search, model picker) are hidden
// when the active profile uses OpenRouter — those flags don't apply or aren't
// universally supported across third-party models.
function updateToolbarForActiveProfile() {
  const acc = st.activeProfileNum != null ? st.accounts.find(a => a.num === st.activeProfileNum) : null;
  const mode = acc ? acc.authMode : null;
  const isOR = mode === 'openrouter';

  // pi-toggles in both main toolbar and new-thread panel
  document.querySelectorAll('.pi-toggle[data-toggle="fast"]').forEach(b => { b.style.display = isOR ? 'none' : ''; });
  document.querySelectorAll('.pi-toggle[data-toggle="search"]').forEach(b => { b.style.display = isOR ? 'none' : ''; });

  // Config popover sections
  const reasoning = document.querySelector('[data-tc-section="reasoning"]');
  const account = document.querySelector('[data-tc-section="account"]');
  if (reasoning) reasoning.style.display = isOR ? 'none' : '';
  if (account) account.style.display = isOR ? 'none' : '';

  // Model picker: locked to the profile's openrouter model when OR
  const modelSel = document.getElementById('toolbarModel');
  const modelTitle = document.getElementById('toolbarModelTitle');
  const modelHint = document.getElementById('toolbarModelHint');
  if (modelSel && modelTitle) {
    if (isOR) {
      modelTitle.textContent = 'Model (from profile)';
      // Replace options with just the configured model
      while (modelSel.firstChild) modelSel.removeChild(modelSel.firstChild);
      const o = document.createElement('option');
      o.value = acc && acc.openrouterModel ? acc.openrouterModel : '';
      o.textContent = acc && acc.openrouterModel ? acc.openrouterModel : '(model not configured)';
      modelSel.appendChild(o);
      modelSel.disabled = true;
      modelSel.style.opacity = '0.7';
      if (modelHint) {
        modelHint.style.display = '';
        modelHint.textContent = 'Model set in Profile settings. To change it, edit the profile.';
      }
    } else {
      modelTitle.textContent = 'Model';
      modelSel.disabled = false;
      modelSel.style.opacity = '';
      if (modelHint) modelHint.style.display = 'none';
      // Re-populate with OpenAI models on next renderToolbarModels() call
      if (typeof renderToolbarModels === 'function') renderToolbarModels();
    }
  }
}

// Apply visual disabled state to actions that require an active profile.
// Currently: New Thread, send button, ntp send button.
function applyProfileEnforcement() {
  const noProfile = st.activeProfileNum == null;
  // Header buttons: set the "need a profile" tooltip when blocked, and CLEAR it
  // back to the real label when a profile is active (it used to stay stale).
  const defaults = { btnNewThread: 'New thread', sendBtn: 'Send (Enter)' };
  for (const id of ['btnNewThread', 'sendBtn']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle('requires-profile-disabled', noProfile);
    el.title = noProfile ? 'Select an active profile (bottom-left) first.' : defaults[id];
  }
  // ntpSendBtn keeps the class in sync, but its tooltip is owned by
  // updateNtpSendState (finer reasons: profile / project / text).
  const ntp = document.getElementById('ntpSendBtn');
  if (ntp) ntp.classList.toggle('requires-profile-disabled', noProfile);
  if (typeof updateNtpSendState === 'function') { try { updateNtpSendState(); } catch {} }
}

// ── Fase 7: Fork + Owner picker ──────────────────────────────────────────────
function updateForkButtonState() {
  const btn = document.getElementById('btnFork');
  if (!btn) return;
  const threadId = st.selectedThreadId;
  const spawnId = threadId && st.spawnByThread[threadId];
  const working = !!(spawnId && st.termRunning[spawnId]);
  const thread = (st.allThreads || []).find(t => t.id === threadId);
  const cwd = thread && thread.cwd;
  const gitInfo = cwd ? _gitInfoByCwd[cwd] : null;
  const hasGit = gitInfo && gitInfo.hasGit;

  let reason = null;
  if (!threadId) reason = 'Open a thread first';
  else if (!hasGit) reason = 'Enable Norya Workspaces for this project (git) to use fork';
  else if (working) reason = 'Wait for the agent to finish before forking';

  if (reason) {
    btn.classList.add('disabled');
    btn.title = reason;
  } else {
    btn.classList.remove('disabled');
    btn.title = 'Fork: creates a new worktree from ' + (thread.git_branch || 'main');
  }
}

async function forkCurrentThread() {
  const btn = document.getElementById('btnFork');
  if (!btn || btn.classList.contains('disabled')) return;
  const threadId = st.selectedThreadId;
  const thread = (st.allThreads || []).find(t => t.id === threadId);
  if (!thread || !thread.cwd) { window.alert('Thread has no cwd — fork unavailable'); return; }
  return forkThreadByObject(thread);
}

// ── Fork lineage cache (parent→children + child→parent) ───────────────────
// In-memory mirror of fork-lineage.json. Loaded once at init; updated locally
// on each successful fork to avoid round-trip latency for breadcrumb render.
window._forkLineage = window._forkLineage || { byChild: {}, byParent: {} };
async function _refreshForkLineage() {
  try {
    const all = await api.forkLineageAll();
    if (all && typeof all === 'object') {
      window._forkLineage.byChild = all;
      window._forkLineage.byParent = {};
      for (const [child, info] of Object.entries(all)) {
        if (info && info.parentId) {
          (window._forkLineage.byParent[info.parentId] = window._forkLineage.byParent[info.parentId] || []).push({ childId: child, ...info });
        }
      }
    }
  } catch {}
}
function _recordForkLineageLocal(childId, parentThread, slug, branch) {
  if (!childId || !parentThread) return;
  const entry = {
    parentId: parentThread.id,
    parentTitle: (parentThread.title || parentThread.first_user_message || '').slice(0, 80),
    slug, branch, createdAt: Date.now(),
  };
  window._forkLineage.byChild[childId] = entry;
  const arr = window._forkLineage.byParent[parentThread.id] = window._forkLineage.byParent[parentThread.id] || [];
  arr.push({ childId, ...entry });
  api.forkLineageSet({ childId, ...entry }).catch(() => {});
}

// Rate-limit detector: warn when user forks 4+ times in 30s.
window._forkTimestamps = window._forkTimestamps || [];
function _checkForkRateLimit() {
  const now = Date.now();
  window._forkTimestamps = window._forkTimestamps.filter(ts => now - ts < 30000);
  window._forkTimestamps.push(now);
  if (window._forkTimestamps.length >= 4) {
    showForkToast({
      kind: 'warn',
      title: 'Too many forks too fast',
      msg: 'You created ' + window._forkTimestamps.length + ' worktrees in 30s. Each one takes disk — consider removing old ones via "git worktree remove".',
    });
  }
}

// Tiny toast — auto-dismiss after ~5s. Single instance in DOM.
function showForkToast({ kind = 'ok', title, msg, duration = 4500 } = {}) {
  let toast = document.getElementById('forkToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'forkToast';
    toast.className = 'fork-toast';
    const tEl = document.createElement('div');
    tEl.className = 'fork-toast-title';
    const mEl = document.createElement('div');
    mEl.className = 'fork-toast-msg';
    toast.appendChild(tEl);
    toast.appendChild(mEl);
    document.body.appendChild(toast);
  }
  toast.className = 'fork-toast ' + (kind || 'ok');
  toast.querySelector('.fork-toast-title').textContent = title || '';
  toast.querySelector('.fork-toast-msg').textContent = msg || '';
  // force reflow so transition fires
  void toast.offsetWidth;
  toast.classList.add('visible');
  if (toast._timer) clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), duration);
}

// ── Fork modal state ──────────────────────────────────────────────────────
let _forkModalThread = null;
let _forkModalSlugManuallyEdited = false;

async function _populateForkModal(thread) {
  _forkModalThread = thread;
  _forkModalSlugManuallyEdited = false;
  const gitInfo = thread.cwd ? _gitInfoByCwd[thread.cwd] : null;
  const sourceBranch = thread.git_branch || (gitInfo && gitInfo.branch) || 'main';
  const projectId = folderToProjectId(thread.cwd);
  const title = (thread.title || thread.first_user_message || 'fork').slice(0, 80);
  const slugRes = await api.deriveSlug('fork ' + title, projectId).catch(() => null);
  const slug = slugRes && slugRes.slug ? slugRes.slug : 'fork';

  document.getElementById('forkSlugInput').value = slug;
  document.getElementById('forkTitleInput').value = '';
  document.getElementById('forkTitleInput').placeholder = title.length ? title : '(uses the original task title)';
  document.getElementById('forkModalErr').classList.remove('visible');

  // Working warning + "wait until done" checkbox
  const warn = document.getElementById('forkModalWarn');
  const waitRow = document.getElementById('forkWaitRow');
  const waitChk = document.getElementById('forkWaitChk');
  const spawnId = st.spawnByThread[thread.id];
  const isWorking = spawnId && evalSpawnState(spawnId) === 'working';
  if (isWorking) {
    warn.style.display = 'block';
    warn.textContent = '⚠ The agent appears to be working right now. Forking now copies the current branch (uncommitted changes are left out).';
    waitRow.style.display = 'flex';
    waitChk.checked = false;
  } else {
    warn.style.display = 'none';
    waitRow.style.display = 'none';
    waitChk.checked = false;
  }

  // Grid checkbox (default on if grid mode active)
  const gridRow = document.getElementById('forkOpenGridRow');
  const gridChk = document.getElementById('forkOpenGridChk');
  if (st.gridMode && st.gridMode.enabled) {
    gridRow.style.display = 'flex';
    gridChk.checked = true;
  } else {
    gridRow.style.display = 'flex';
    gridChk.checked = false;
  }

  _updateForkPreview();
}

function _updateForkPreview() {
  if (!_forkModalThread) return;
  const slugInput = document.getElementById('forkSlugInput');
  const slug = (slugInput.value || 'fork').trim() || 'fork';
  const projectId = folderToProjectId(_forkModalThread.cwd);
  const gitInfo = _forkModalThread.cwd ? _gitInfoByCwd[_forkModalThread.cwd] : null;
  const sourceBranch = _forkModalThread.git_branch || (gitInfo && gitInfo.branch) || 'main';
  document.getElementById('forkPreviewBranch').textContent = 'wt/' + slug;
  document.getElementById('forkPreviewPath').textContent = '~/.codex-panel/worktrees/' + projectId + '/' + slug;
  document.getElementById('forkPreviewSource').textContent = sourceBranch;
}

function openForkModal(thread) {
  if (!thread || !thread.cwd) { window.alert('Thread has no cwd — fork unavailable'); return; }
  const gitInfo = _gitInfoByCwd[thread.cwd];
  if (!gitInfo || !gitInfo.hasGit) { window.alert('Project without git — enable Workspaces first'); return; }
  _populateForkModal(thread).then(() => {
    document.getElementById('modalFork').classList.remove('hidden');
    const inp = document.getElementById('forkSlugInput');
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}

function closeForkModal() {
  document.getElementById('modalFork').classList.add('hidden');
  _forkModalThread = null;
}

// Backward-compat entry point: now routes through the modal so callers
// (Grid cells, PIP IPC, Cmd+Shift+F) automatically benefit from the new UX.
async function forkThreadByObject(thread) {
  return openForkModal(thread);
}

// Quick fork — no modal, uses defaults. Bound to Cmd+Alt+F.
async function quickForkThread(thread) {
  if (!thread || !thread.cwd) { window.alert('Thread has no cwd — fork unavailable'); return; }
  const gitInfo = _gitInfoByCwd[thread.cwd];
  if (!gitInfo || !gitInfo.hasGit) { window.alert('Project without git — enable Workspaces first'); return; }
  const projectId = folderToProjectId(thread.cwd);
  const title = (thread.title || thread.first_user_message || 'fork').slice(0, 80);
  const slugRes = await api.deriveSlug('fork ' + title, projectId).catch(() => null);
  const slug = slugRes && slugRes.slug ? slugRes.slug : 'fork';
  return _executeFork(thread, {
    slug, customTitle: null,
    openInGrid: !!(st.gridMode && st.gridMode.enabled),
    waitForIdle: false,
  });
}

// Actual fork execution — extracted from old forkThreadByObject so both the
// modal and quick-fork can share the same backend+spawn+latch logic.
async function _executeFork(thread, opts) {
  const { slug, customTitle, openInGrid, waitForIdle } = opts;
  const gitInfo = _gitInfoByCwd[thread.cwd];
  const projectDir = thread.cwd;
  const projectId = folderToProjectId(thread.cwd);
  const sourceBranch = thread.git_branch || (gitInfo && gitInfo.branch) || 'main';

  // If user asked to wait until the agent finishes, poll evalSpawnState until
  // !== 'working' (max ~5 min) before launching.
  if (waitForIdle) {
    const spawnId = st.spawnByThread[thread.id];
    if (spawnId && evalSpawnState(spawnId) === 'working') {
      showForkToast({ kind: 'ok', title: 'Waiting for agent',
        msg: 'Will fork "' + slug + '" as soon as the original task finishes.', duration: 3500 });
      const deadline = Date.now() + 5 * 60 * 1000;
      await new Promise(resolve => {
        const t = setInterval(() => {
          if (Date.now() > deadline) { clearInterval(t); resolve(); return; }
          if (evalSpawnState(spawnId) !== 'working') { clearInterval(t); resolve(); }
        }, 1200);
      });
    }
  }

  const res = await api.threadFork({
    sourceWorktreePath: thread.cwd,
    sourceBranch, projectDir, projectId, slug,
  });
  if (!res || res.error) {
    showForkToast({ kind: 'warn', title: 'Fork failed',
      msg: (res && res.error) || 'unknown error', duration: 6000 });
    return;
  }
  _checkForkRateLimit();
  const acc = st.accounts.find(a => a.num === (st.threadOwners[thread.id] || st.activeProfileNum));
  if (!acc) { window.alert('No profile available to spawn the fork'); return; }
  const newSpawn = launchTerminal(acc, {
    mode: 'new-folder', cwd: res.path, projectId, profileNum: acc.num,
  });

  // Latch newly-created session + record lineage + optional grid add
  const sinceMs = Date.now() - 500;
  let latched = false;
  async function poll(tries) {
    if (latched) return;
    try {
      const r = await api.findLatestSession(acc.num, sinceMs);
      if (r && r.sessionId) {
        latched = true;
        st.spawnByThread[r.sessionId] = newSpawn;
        api.threadOwnerSet(r.sessionId, acc.num).catch(() => {});
        st.threadOwners[r.sessionId] = acc.num;
        // Persist lineage so the breadcrumb survives reloads
        _recordForkLineageLocal(r.sessionId, thread, res.slug || slug, res.branch || ('wt/' + slug));
        // Optional: apply custom title via thread-rename
        if (customTitle && customTitle.trim()) {
          api.renameThread(acc.num, r.sessionId, customTitle.trim()).catch(() => {});
        }
        try { st.allThreads = await api.listThreads(null, null) || []; invalidateSidebarCache(); renderProjectList(); } catch {}
        if (openInGrid && st.gridMode.enabled) addThreadToGrid(r.sessionId);
        if (typeof updateHeader === 'function') updateHeader();
        showForkToast({ kind: 'ok', title: 'Fork ready',
          msg: 'wt/' + (res.slug || slug) + ' created from ' + sourceBranch, duration: 3000 });
        return;
      }
    } catch {}
    if (tries > 0) setTimeout(() => poll(tries - 1), 600);
  }
  setTimeout(() => poll(30), 600);
}

async function _confirmForkModal() {
  if (!_forkModalThread) return;
  const errEl = document.getElementById('forkModalErr');
  const rawSlug = (document.getElementById('forkSlugInput').value || '').trim();
  if (!rawSlug || !/^[a-z0-9][a-z0-9-]*$/i.test(rawSlug)) {
    errEl.textContent = 'Invalid slug. Use letters, numbers and hyphens (e.g. fix-auth).';
    errEl.classList.add('visible');
    return;
  }
  const slug = rawSlug.toLowerCase();
  const customTitle = (document.getElementById('forkTitleInput').value || '').trim();
  const openInGrid = document.getElementById('forkOpenGridChk').checked;
  const waitForIdle = document.getElementById('forkWaitChk').checked;
  const thread = _forkModalThread;
  closeForkModal();
  return _executeFork(thread, { slug, customTitle, openInGrid, waitForIdle });
}

// Owner picker — shared popover when clicking the owner dot
let _ownerPickerOpen = null;
function openOwnerPicker(thread, anchor) {
  closeOwnerPicker();
  const pop = document.createElement('div');
  pop.className = 'owner-pop';

  const title = document.createElement('div');
  title.className = 'owner-pop-title';
  title.textContent = 'Switch task owner';
  pop.appendChild(title);

  (st.accounts || []).forEach(acc => {
    const q = st.quota[String(acc.num)];
    const h = (typeof getProfileHealth === 'function') ? getProfileHealth(acc, q) : { ok: true };
    const item = document.createElement('div');
    const isCurrent = getThreadEffectiveOwner(thread) === acc.num;
    item.className = 'owner-pop-item'
      + (isCurrent ? ' active' : '')
      + (!h.ok ? ' unavailable' : '');
    if (!h.ok) item.title = h.message || '';
    const dot = document.createElement('span');
    dot.className = 'owner-pop-item-dot';
    dot.style.background = acc.color || 'var(--text-faint)';
    item.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = acc.name || ('Profile ' + acc.num);
    item.appendChild(name);
    item.addEventListener('click', async e => {
      e.stopPropagation();
      if (!h.ok) return;
      await api.threadOwnerSet(thread.id, acc.num).catch(() => {});
      st.threadOwners[thread.id] = acc.num;
      closeOwnerPicker();
      renderProjectList();
      // If this is the currently selected thread, also switch active profile
      if (st.selectedThreadId === thread.id && typeof setActiveProfile === 'function') {
        setActiveProfile(acc.num);
      }
    });
    pop.appendChild(item);
  });

  // Position: prefer above the anchor; clamp to viewport on both axes.
  // Append first so we can measure dimensions, then refine.
  document.body.appendChild(pop);
  _ownerPickerOpen = pop;
  requestAnimationFrame(() => {
    const rect = anchor.getBoundingClientRect();
    const popW = pop.offsetWidth || 220;
    const popH = pop.offsetHeight || 200;
    let left = rect.left;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    if (left < 8) left = 8;
    let top = rect.top - popH - 6;
    if (top < 8) top = rect.bottom + 6;
    if (top + popH > window.innerHeight - 8) top = window.innerHeight - popH - 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  });

  // Close on outside click
  setTimeout(() => {
    const closer = (ev) => {
      if (pop.contains(ev.target) || anchor.contains(ev.target)) return;
      closeOwnerPicker();
      document.removeEventListener('click', closer);
    };
    document.addEventListener('click', closer);
  }, 0);
}
function closeOwnerPicker() {
  if (_ownerPickerOpen && _ownerPickerOpen.parentNode) {
    _ownerPickerOpen.parentNode.removeChild(_ownerPickerOpen);
  }
  _ownerPickerOpen = null;
}

