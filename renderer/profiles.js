/**
 * renderer/profiles.js — aba de perfis, render de contas, cartão de quota, lista de projetos.
 *
 * Script CLÁSSICO (ver renderer/state.js): fatia contígua extraída de
 * test-window.html em 2026-07-10, na ordem original. Compartilha o escopo
 * léxico global com os outros — `st`, `api`, `ipcRenderer` e as funções de
 * cada fatia enxergam-se sem import. Ordem de carga preservada = zero mudança
 * de comportamento.
 */
'use strict';

// ── Profile Settings tab (Fase 3) ────────────────────────────────────────────
let _profilesTabPalette = null;
const _profilesTabExpanded = new Set();

// ── Catálogo dos providers no card de perfil (2026-07-10) ────────────────────
// Um perfil configura N providers ao mesmo tempo; `authMode` é só o PADRÃO
// (o que o seletor "Automático" usa). Espelha agents/registry.js.
const PROVIDERS_UI = [
  { id: 'codex',      label: 'Codex',      statusKey: 'codex' },
  { id: 'claude',     label: 'Claude',     statusKey: 'claude' },
  { id: 'grok',       label: 'Grok',       statusKey: 'grok' },
  { id: 'opencode',   label: 'OpenCode',   statusKey: 'opencode' },
  { id: 'openrouter', label: 'OpenRouter', statusKey: 'openrouter' },
];

// authMode que "marcar como padrão" grava para cada provider. Codex tem dois
// modos (chatgpt|apikey) — escolhe pelo método que o perfil já configurou.
function defaultAuthModeFor(providerId, acc) {
  if (providerId === 'codex') {
    const via = acc.providers && acc.providers.codex && acc.providers.codex.via;
    return via === 'apikey' ? 'apikey' : 'chatgpt';
  }
  return providerId; // claude, grok, opencode, openrouter = 1:1
}

// authMode → provider da linha (pra marcar a estrela do padrão atual).
function providerIdForAuthMode(mode) {
  if (mode === 'chatgpt' || mode === 'apikey') return 'codex';
  return mode || null;
}

// Status visual de uma linha de provider.
function providerRowStatus(providerId, ps) {
  const s = ps && ps[providerId];
  if (!s) return { dot: 'off', text: 'sem dado' };
  if (providerId === 'openrouter') {
    return s.configured
      ? { dot: 'ok', text: 'chave salva' + (s.model ? ' · ' + s.model : ' · sem modelo') }
      : { dot: 'off', text: 'sem chave' };
  }
  if (providerId === 'claude' && s.connected) {
    if (s.isolated) return { dot: 'ok', text: 'conectado · conta isolada' };
    if (typeof s.expiresAt === 'number' && s.expiresAt > 0) {
      const msRestantes = s.expiresAt - Date.now();
      const diasRestantes = Math.ceil(msRestantes / 86400000);
      if (msRestantes <= 0) return { dot: 'warn', text: 'OAuth expirado' };
      if (diasRestantes < 3) return { dot: 'warn', text: `expira em ${diasRestantes}d` };
      return { dot: 'ok', text: `conectado · expira em ${diasRestantes}d` };
    }
    return { dot: 'ok', text: 'conectado (Keychain compartilhado)' };
  }
  if (providerId === 'codex' && s.connected) {
    return { dot: 'ok', text: s.via === 'apikey' ? 'API key salva' : 'conectado (ChatGPT)' };
  }
  return s.connected ? { dot: 'ok', text: 'conectado' } : { dot: 'off', text: 'sem login' };
}

async function renderProfilesTab() {
  if (!_profilesTabPalette) {
    try { _profilesTabPalette = await api.profilePalette(); }
    catch { _profilesTabPalette = []; }
  }
  try { st.accounts = await api.getAccounts(); } catch {}

  const list = document.getElementById('profileCardsList');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  st.accounts.forEach(acc => list.appendChild(makeProfileCard(acc)));

  const addBtn = document.getElementById('profileAddCardBtn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => {
      const addModal = document.getElementById('modalAdd');
      if (addModal) addModal.classList.remove('hidden');
    });
  }
}

function makeProfileCard(acc) {
  const card = document.createElement('div');
  card.className = 'profile-card' + (_profilesTabExpanded.has(acc.num) ? ' expanded' : '');
  card.dataset.num = acc.num;
  card.appendChild(makeProfileCardHeader(acc));
  card.appendChild(makeProfileCardBody(acc));
  return card;
}

function makeProfileCardHeader(acc) {
  const q = st.quota[String(acc.num)];
  const health = getProfileHealth(acc, q);
  const header = document.createElement('div');
  header.className = 'profile-card-header';

  const dot = document.createElement('div');
  dot.className = 'profile-card-dot';
  dot.style.background = acc.color || 'var(--text-faint)';
  header.appendChild(dot);

  const name = document.createElement('div');
  name.className = 'profile-card-name';
  name.textContent = acc.name || ('Profile ' + acc.num);
  header.appendChild(name);

  // Chip do provider padrão do perfil (o que o modo Automático usa).
  const defProvider = PROVIDERS_UI.find(p => p.id === providerIdForAuthMode(acc.authMode));
  if (defProvider) {
    const chip = document.createElement('span');
    chip.className = 'profile-card-chip';
    chip.textContent = defProvider.label + ' padrão';
    header.appendChild(chip);
  }

  const status = document.createElement('span');
  status.className = 'profile-card-status ' + (health.ok ? 'ok' : (health.status === 'pending' ? 'pending' : 'warn'));
  status.textContent = health.ok ? 'OK' : (health.status === 'pending' ? '…' : health.status);
  if (health.message) status.title = health.message;
  header.appendChild(status);

  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('class', 'profile-card-chev');
  chev.setAttribute('viewBox', '0 0 10 10');
  chev.setAttribute('fill', 'none');
  const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chevPath.setAttribute('d', 'M2.5 4l2.5 2.5L7.5 4');
  chevPath.setAttribute('stroke', 'currentColor');
  chevPath.setAttribute('stroke-width', '1.4');
  chevPath.setAttribute('stroke-linecap', 'round');
  chev.appendChild(chevPath);
  header.appendChild(chev);

  header.addEventListener('click', () => {
    if (_profilesTabExpanded.has(acc.num)) _profilesTabExpanded.delete(acc.num);
    else _profilesTabExpanded.add(acc.num);
    renderProfilesTab();
  });
  return header;
}

function makeProfileFormField(label, makeContent) {
  const row = document.createElement('div');
  row.className = 'profile-form-row';
  const lbl = document.createElement('div');
  lbl.className = 'profile-form-label';
  lbl.textContent = label;
  row.appendChild(lbl);
  row.appendChild(makeContent());
  return row;
}

// ── Login genérico por agente ────────────────────────────────────────────────
// Um botão só, que spawna `mode: 'login'` — o comando vem do registry
// (codex login / claude setup-token / grok login / opencode auth login).
// Sem isto, cada agente novo copiaria o doChatGptLogin inteiro. Lifted para o
// escopo do módulo (antes aninhado em makeProfileCardBody) pra que os builders
// por-provider abaixo o reusem; recebe `acc` como 1º parâmetro.
//
// `agentId` é OBRIGATÓRIO desde 2026-09-08. Sem ele, launchTerminal cai na
// precedência `opts.agentId || threadAgents || st.selectedAgentId || authMode`
// — ou seja, o botão "logar no Grok" da linha do Grok rodava o login do que
// estivesse no SELETOR naquele instante, ou do padrão do perfil. Num perfil
// cujo padrão é claude, clicar em qualquer linha de provider disparava
// `claude setup-token`. Cada linha loga o SEU provider, ponto.
function loginDoAgente(acc, rotulo, dica, agentId) {
  const box = document.createElement('div');
  if (dica) {
    const d = document.createElement('div');
    d.className = 'profile-auth-status';
    d.textContent = dica;
    box.appendChild(d);
  }
  const btn = document.createElement('button');
  btn.className = 'profile-btn';
  btn.textContent = rotulo;
  btn.addEventListener('click', () => {
    const spawnId = launchTerminal(acc, { mode: 'login', profileNum: acc.num, agentId });
    // Grid é a única view (2026-07-10): o login roda como pane maximizado
    // temporário. O refresh de contas pós-exit já é feito pelo openLoginPane.
    openLoginPane(spawnId);
  });
  box.appendChild(btn);
  return box;
}

// PTY de login como pane maximizado TEMPORÁRIO no grid (a única view).
// Ao sair o processo, o pane some e o grid volta ao que era.
function openLoginPane(spawnId, onExit) {
  st.spawnByThread[spawnId] = spawnId;
  addThreadToGrid(spawnId);
  if (typeof renderGrid === 'function') renderGrid();
  setGridFocus(spawnId);
  if (st.gridMode.maximizedThreadId !== spawnId) toggleGridMaximize(spawnId);
  // Não existe `closeSettings()`; o modal fecha pela classe, como o botão ✕ faz.
  const modal = document.getElementById('modalSettings');
  if (modal) modal.classList.add('hidden');
  // A landing (overlay do grid vazio, Task 7) esconde o grid-area por CSS —
  // sem fechá-la aqui o pane de login ficaria invisível quando o login parte
  // de um grid vazio (caso comum: perfil recém-criado, primeiro login).
  try { if (typeof hideNewThreadPanel === 'function') hideNewThreadPanel(); } catch {}
  ipcRenderer.once(`terminal-exit-${spawnId}`, () => {
    setTimeout(async () => {
      if (st.gridMode.maximizedThreadId === spawnId) toggleGridMaximize(spawnId);
      removeThreadFromGrid(spawnId);
      try { st.accounts = await api.getAccounts(); } catch {}
      try { renderAccountList(); renderProfileButton(); renderProfilesTab(); } catch {}
      if (typeof onExit === 'function') onExit();
    }, 600);
  });
}

// ── Corpo do cartão: identidade + providers + danger zone ─────────────
function makeProfileCardBody(acc) {
  const body = document.createElement('div');
  body.className = 'profile-card-body';

  body.appendChild(buildIdentityRow(acc));  // Nome + Cor lado a lado
  buildProviderRows(acc, body);             // N linhas de provider (★ = padrão)

  // Danger zone — uses in-app modal (#modalDelete) for confirmation, not the
  // native macOS dialog. openDeleteModal already wires Confirm → api.deleteAccount.
  const dangerZone = document.createElement('div');
  dangerZone.style.marginTop = '14px';
  dangerZone.style.paddingTop = '12px';
  dangerZone.style.borderTop = '1px solid var(--modal-border)';
  const delBtn = document.createElement('button');
  delBtn.className = 'profile-btn danger';
  delBtn.textContent = 'Delete profile';
  delBtn.addEventListener('click', () => {
    openDeleteModal(acc);
  });
  dangerZone.appendChild(delBtn);
  body.appendChild(dangerZone);

  return body;
}

// ── Identidade: Nome + Cor lado a lado (movido de makeProfileCardBody) ────────
function buildIdentityRow(acc) {
  const row = document.createElement('div');
  row.className = 'profile-identity-row';

  // Name
  row.appendChild(makeProfileFormField('Nome', () => {
    const input = document.createElement('input');
    input.className = 'profile-form-input';
    input.type = 'text';
    input.value = acc.name || '';
    input.placeholder = 'Profile ' + acc.num;
    let saveTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const newName = input.value.trim();
        if (newName && newName !== acc.name) {
          await api.renameAccount(acc.num, newName);
          acc.name = newName;
          renderAccountList();
          renderProfileButton();
          // Update card header name without full re-render
          const card = document.querySelector('.profile-card[data-num="' + acc.num + '"] .profile-card-name');
          if (card) card.textContent = newName;
        }
      }, 500);
    });
    return input;
  }));

  // Color picker
  row.appendChild(makeProfileFormField('Cor', () => {
    const grid = document.createElement('div');
    grid.className = 'profile-color-grid';
    (_profilesTabPalette || []).forEach(color => {
      const sw = document.createElement('div');
      sw.className = 'profile-color-swatch' + (color === acc.color ? ' selected' : '');
      sw.style.background = color;
      sw.title = color;
      sw.addEventListener('click', async () => {
        const r = await api.profileSetColor(acc.num, color);
        if (r && r.ok) {
          acc.color = color;
          renderProfilesTab();
          renderAccountList();
          renderProfileButton();
        }
      });
      grid.appendChild(sw);
    });
    return grid;
  }));

  return row;
}

// ── Linhas de provider: ★ padrão · nome · status · ação ─────────────────────
function buildProviderRows(acc, body) {
  const wrap = document.createElement('div');
  wrap.className = 'provider-rows';
  const title = document.createElement('div');
  title.className = 'profile-form-label';
  title.textContent = 'Providers';
  wrap.appendChild(title);

  const ps = acc.providers || {};
  const currentDefault = providerIdForAuthMode(acc.authMode);

  PROVIDERS_UI.forEach(p => {
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.dataset.provider = p.id;

    // Estrela: marca este provider como o PADRÃO do perfil (Automático usa).
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'provider-star' + (currentDefault === p.id ? ' is-default' : '');
    star.textContent = currentDefault === p.id ? '★' : '☆';
    star.title = currentDefault === p.id
      ? 'Provider padrão deste perfil'
      : 'Tornar padrão (o modo Automático passa a usar este)';
    star.addEventListener('click', async e => {
      e.stopPropagation();
      const r = await api.profileSetAuthMode(acc.num, defaultAuthModeFor(p.id, acc));
      if (r && r.error) { showGridBanner(r.error, 'warn'); return; }
      acc.authMode = defaultAuthModeFor(p.id, acc);
      renderProfilesTab(); renderAccountList(); renderProfileButton();
    });

    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = p.label;

    const status = providerRowStatus(p.id, ps);
    const dot = document.createElement('span');
    dot.className = 'provider-dot ' + status.dot;
    const statusEl = document.createElement('span');
    statusEl.className = 'provider-status';
    statusEl.textContent = status.text;

    const chev = document.createElement('span');
    chev.className = 'provider-chev';
    chev.textContent = '▸';

    row.append(star, name, dot, statusEl, chev);

    // Detalhe expansível (login, chave, modelo) — um aberto por vez.
    const detail = document.createElement('div');
    detail.className = 'provider-detail hidden';
    if (p.id === 'codex') buildCodexDetail(acc, detail);
    else if (p.id === 'claude') buildClaudeDetail(acc, detail);
    else if (p.id === 'openrouter') buildOpenrouterDetail(acc, detail);
    else if (p.id === 'grok') buildGrokDetail(acc, detail);
    else buildOpencodeDetail(acc, detail);

    row.addEventListener('click', e => {
      if (e.target.closest('.provider-star') || e.target.closest('.provider-detail')) return;
      const aberto = !detail.classList.contains('hidden');
      wrap.querySelectorAll('.provider-detail').forEach(d => d.classList.add('hidden'));
      wrap.querySelectorAll('.provider-chev').forEach(c => { c.textContent = '▸'; });
      if (!aberto) { detail.classList.remove('hidden'); chev.textContent = '▾'; }
    });

    const rowWrap = document.createElement('div');
    rowWrap.className = 'provider-row-wrap';
    rowWrap.append(row, detail);
    wrap.appendChild(rowWrap);
  });

  body.appendChild(wrap);
}

// ── Detalhe Grok / OpenCode: só um botão de login isolado por perfil ──────────
function buildGrokDetail(acc, detail) {
  // A credencial cai em accounts/N/.grok — cada perfil é uma conta SuperGrok.
  detail.appendChild(loginDoAgente(acc, 'Fazer login no Grok',
    'A sessão fica isolada neste perfil (accounts/' + acc.num + '/.grok).', 'grok'));
}

function buildOpencodeDetail(acc, detail) {
  detail.appendChild(loginDoAgente(acc, 'Conectar provedor no OpenCode',
    'Credencial isolada neste perfil (~/.local/share/opencode dentro dele).', 'opencode'));
}

// ── Detalhe Codex: ChatGPT login | API key (movido, com mini-toggle) ──────────
function buildCodexDetail(acc, detail) {
  // Codex aceita dois métodos que convivem no disco (login ChatGPT em
  // .codex/auth.json e OPENAI_API_KEY no profile.json). Antes eram radios
  // exclusivos; agora um mini-toggle troca o painel visível — começa pelo
  // método que o perfil já configurou.
  const via = acc.providers && acc.providers.codex && acc.providers.codex.via;
  let mode = via === 'apikey' ? 'apikey' : 'chatgpt';

  const toggle = document.createElement('div');
  toggle.style.cssText = 'display:flex; gap:6px; margin-bottom:10px;';
  const btnChat = document.createElement('button');
  btnChat.type = 'button';
  btnChat.textContent = 'Entrar com ChatGPT';
  const btnKey = document.createElement('button');
  btnKey.type = 'button';
  btnKey.textContent = 'Usar API key';
  toggle.append(btnChat, btnKey);

  const chatgptPanel = document.createElement('div');
  const apikeyPanel = document.createElement('div');
  fillChatgpt(chatgptPanel);
  fillApikey(apikeyPanel);
  detail.append(toggle, chatgptPanel, apikeyPanel);

  function sync() {
    chatgptPanel.style.display = mode === 'chatgpt' ? '' : 'none';
    apikeyPanel.style.display = mode === 'apikey' ? '' : 'none';
    btnChat.className = 'profile-btn' + (mode === 'chatgpt' ? '' : ' secondary');
    btnKey.className = 'profile-btn' + (mode === 'apikey' ? '' : ' secondary');
  }
  btnChat.addEventListener('click', () => { mode = 'chatgpt'; sync(); });
  btnKey.addEventListener('click', () => { mode = 'apikey'; sync(); });
  sync();

  // ── Painel ChatGPT (movido de authMode==='chatgpt') ──
  function fillChatgpt(detail) {
    const q = st.quota[String(acc.num)];
    const health = getProfileHealth(acc, q);
    const status = document.createElement('div');
    status.className = 'profile-auth-status ' + (health.ok ? 'ok' : 'warn');
    status.textContent = health.ok ? 'ChatGPT session active' : (health.message || 'Unknown status');
    detail.appendChild(status);

    const reloginBtn = document.createElement('button');
    reloginBtn.className = 'profile-btn';
    reloginBtn.textContent = health.ok ? 'Re-login ChatGPT' : 'Fazer login ChatGPT';
    reloginBtn.addEventListener('click', () => {
      // Ask which browser to use for the OAuth flow. noryaShowLoginChoice
      // shows the modal (or skips it if the user previously chose "remember"
      // for this profile) and calls back with 'norya' | 'system'. We pass the
      // choice through to the spawn so the one-shot works even without remember.
      const startLogin = (loginBrowser) => doChatGptLogin(loginBrowser);
      if (typeof window.noryaShowLoginChoice === 'function') {
        window.noryaShowLoginChoice(acc.num, acc.name, startLogin);
      } else {
        startLogin('system');
      }
    });
    function doChatGptLogin(loginBrowser) {
      // Spawna um `codex login` avulso neste perfil. HOME=accounts/N vem do
      // buildAccountEnv no backend → auth.json cai em accounts/N/.codex/auth.json.
      // mode='login' emite `codex login` puro em vez da TUI. loginBrowser diz
      // ao main.js se roteia a URL OAuth pro navegador do Norya (MAX_ANON).
      const spawnId = launchTerminal(acc, {
        mode: 'login',
        profileNum: acc.num,
        // agentId FIXO: esta é a linha do Codex, então roda `codex login`
        // mesmo num perfil cujo padrão é outro (ex.: authMode 'claude'). Sem
        // isto, um perfil Claude nunca conseguia logar no Codex — o
        // botão disparava `claude setup-token` e o auth.json do Codex nunca
        // nascia, então o cartão de Uso do Codex jamais aparecia ali.
        agentId: 'codex',
        loginBrowser: loginBrowser || 'system',
      });
      // Pane maximizado temporário no grid — não há mais view pra restaurar.
      // O refresh de contas (getAccounts é superconjunto do profileList) e o
      // re-render das listas já são do openLoginPane; aqui fica só o que é
      // específico do login ChatGPT.
      openLoginPane(spawnId, () => {
        // 1) Limpa otimisticamente as flags de falha de auth do cache local de
        //    quota. getProfileHealth() é gated nelas — sem limpar, a UI diria
        //    "expirou" até o próximo quota-refresh completar (vários segundos).
        const qkey = String(acc.num);
        if (st.quota[qkey]) {
          delete st.quota[qkey].loggedOut;
          delete st.quota[qkey].noCredit;
          delete st.quota[qkey].errorKind;
        }
        // 2) openLoginPane re-renderizou ANTES deste callback (ainda com as
        //    flags sujas) — re-renderiza pra o badge refletir a limpeza já.
        try { renderAccountList(); renderProfileButton(); renderProfilesTab(); } catch {}
        // 3) Dispara um quota-refresh real em background. No sucesso persiste
        //    a quota fresca (sem loggedOut) e emite 'quota-updated' → o
        //    renderer re-renderiza sozinho. Se o login falhou de verdade, o
        //    refresh re-marca loggedOut e o badge volta a "expirado" — UX
        //    honesta nos dois casos.
        api.quotaRefresh(acc.num).catch(() => {});
      });
    }
    detail.appendChild(reloginBtn);
  }

  // ── Painel API key (movido de authMode==='apikey') ──
  function fillApikey(detail) {
    const lbl = document.createElement('div');
    lbl.className = 'profile-form-label';
    lbl.textContent = 'OPENAI_API_KEY';
    detail.appendChild(lbl);

    const input = document.createElement('input');
    input.className = 'profile-form-input';
    input.type = 'password';
    input.placeholder = acc.hasApiKey ? '••••••••••• (existente)' : 'sk-...';
    input.style.marginTop = '6px';
    detail.appendChild(input);

    const hint = document.createElement('div');
    hint.className = 'profile-form-hint';
    hint.style.marginTop = '6px';
    hint.textContent = 'Saved locally in profile.json and injected as env into the PTY when this profile is active.';
    detail.appendChild(hint);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.marginTop = '10px';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'profile-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return;
      const r = await api.profileSetApiKey(acc.num, key);
      if (r && r.ok) {
        acc.hasApiKey = true;
        input.value = '';
        input.placeholder = '••••••••••• (existente)';
        renderProfilesTab();
      } else if (r && r.error) {
        showGridBanner(r.error, 'warn');
      }
    });
    actions.appendChild(saveBtn);

    if (acc.hasApiKey) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'profile-btn danger';
      clearBtn.textContent = 'Remove';
      clearBtn.addEventListener('click', async () => {
        if (!(await noryaConfirm('Remove the API key from this profile?', { danger: true, okLabel: 'Remove' }))) return;
        await api.profileSetApiKey(acc.num, null);
        acc.hasApiKey = false;
        renderProfilesTab();
      });
      actions.appendChild(clearBtn);
    }
    detail.appendChild(actions);
  }
}

// ── Detalhe OpenRouter: chave + modelo (movido de authMode==='openrouter') ────
function buildOpenrouterDetail(acc, detail) {
  // Intro + link
  const intro = document.createElement('div');
  intro.style.fontSize = '11.5px';
  intro.style.color = 'var(--text-muted)';
  intro.style.marginBottom = '10px';
  intro.textContent = 'OpenRouter gives access to hundreds of models (Xiaomi, Anthropic, Mistral, etc) with a single API key. ';
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = 'Get your key at openrouter.ai/keys ↗';
  link.style.color = 'var(--accent)';
  link.addEventListener('click', e => {
    e.preventDefault();
    require('electron').shell.openExternal('https://openrouter.ai/keys');
  });
  intro.appendChild(link);
  detail.appendChild(intro);

  // API key field
  const keyLbl = document.createElement('div');
  keyLbl.className = 'profile-form-label';
  keyLbl.textContent = 'OpenRouter API key';
  detail.appendChild(keyLbl);
  const keyIn = document.createElement('input');
  keyIn.className = 'profile-form-input';
  keyIn.type = 'password';
  keyIn.placeholder = acc.hasOpenrouterKey ? '••••••••••• (existente)' : 'sk-or-v1-...';
  keyIn.style.marginTop = '4px';
  detail.appendChild(keyIn);

  // Model field
  const modelLbl = document.createElement('div');
  modelLbl.className = 'profile-form-label';
  modelLbl.style.marginTop = '12px';
  modelLbl.textContent = 'Modelo';
  detail.appendChild(modelLbl);
  const modelIn = document.createElement('input');
  modelIn.className = 'profile-form-input';
  modelIn.type = 'text';
  modelIn.placeholder = 'xiaomi/mimo-v2.5-pro';
  modelIn.value = acc.openrouterModel || '';
  modelIn.style.marginTop = '4px';
  detail.appendChild(modelIn);

  const modelHint = document.createElement('div');
  modelHint.className = 'profile-form-hint';
  modelHint.style.marginTop = '6px';
  modelHint.innerHTML = '';  // build via DOM
  const hintTxt1 = document.createTextNode('Formato: ');
  const hintCode = document.createElement('code');
  hintCode.style.cssText = 'background:var(--input-bg);padding:1px 5px;border-radius:3px;font-size: 11px';
  hintCode.textContent = 'provider/model-name';
  const hintTxt2 = document.createTextNode('. Suggestions: ');
  const suggestions = ['xiaomi/mimo-v2.5-pro', 'anthropic/claude-opus-4.7', 'openai/gpt-5.5', 'meta-llama/llama-4-70b-instruct'];
  modelHint.append(hintTxt1, hintCode, hintTxt2);
  suggestions.forEach((s, i) => {
    if (i > 0) modelHint.append(', ');
    const sLink = document.createElement('a');
    sLink.href = '#';
    sLink.textContent = s;
    sLink.style.color = 'var(--accent)';
    sLink.addEventListener('click', e => { e.preventDefault(); modelIn.value = s; });
    modelHint.append(sLink);
  });
  const modelHint2 = document.createElement('div');
  modelHint2.className = 'profile-form-hint';
  modelHint2.style.marginTop = '4px';
  modelHint2.innerHTML = '';
  const browseLink = document.createElement('a');
  browseLink.href = '#';
  browseLink.textContent = 'Ver lista completa em openrouter.ai/models ↗';
  browseLink.style.color = 'var(--accent)';
  browseLink.addEventListener('click', e => {
    e.preventDefault();
    require('electron').shell.openExternal('https://openrouter.ai/models');
  });
  modelHint2.appendChild(browseLink);
  detail.appendChild(modelHint);
  detail.appendChild(modelHint2);

  // Save buttons
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.marginTop = '12px';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'profile-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const newKey = keyIn.value.trim();
    const newModel = modelIn.value.trim();
    if (newKey) {
      const r = await api.profileSetOpenrouterKey(acc.num, newKey);
      if (r && r.error) { showGridBanner(r.error, 'warn'); return; }
      acc.hasOpenrouterKey = true;
      keyIn.value = '';
      keyIn.placeholder = '••••••••••• (existente)';
    }
    if (newModel) {
      const r = await api.profileSetOpenrouterModel(acc.num, newModel);
      if (r && r.error) { showGridBanner(r.error, 'warn'); return; }
      acc.openrouterModel = newModel;
    }
    renderProfilesTab();
    renderAccountList();
    renderProfileButton();
  });
  actions.appendChild(saveBtn);

  if (acc.hasOpenrouterKey) {
    const clearKey = document.createElement('button');
    clearKey.className = 'profile-btn secondary';
    clearKey.textContent = 'Remove key';
    clearKey.addEventListener('click', async () => {
      if (!(await noryaConfirm('Remove the OpenRouter key from this profile?', { danger: true, okLabel: 'Remove' }))) return;
      await api.profileSetOpenrouterKey(acc.num, null);
      acc.hasOpenrouterKey = false;
      renderProfilesTab();
    });
    actions.appendChild(clearKey);
  }
  detail.appendChild(actions);
}

// ── Detalhe Claude (Anthropic) — OAuth-only (movido de authMode==='claude') ───
function buildClaudeDetail(acc, detail) {
  const intro = document.createElement('div');
  intro.style.fontSize = '11.5px';
  intro.style.color = 'var(--text-muted)';
  intro.style.marginBottom = '10px';
  intro.textContent = 'Anthropic Claude CLI. OAuth (browser) auth. Allows multiple open xterms for the same account.';
  detail.appendChild(intro);

  // Auth status badge — colored dot + label + tooltip with expiry detail.
  const authState = classifyClaudeAuth(acc);
  const statusRow = document.createElement('div');
  statusRow.style.display = 'flex';
  statusRow.style.alignItems = 'center';
  statusRow.style.gap = '8px';

  const status = document.createElement('div');
  // Map badge level → existing CSS class (.ok green, .warn red); yellow
  // re-uses .warn color but we tweak inline for clarity.
  const cssLevel = authState.level === 'green' ? 'ok' : 'warn';
  status.className = 'profile-auth-status ' + cssLevel;
  status.style.marginBottom = '0';
  if (authState.level === 'yellow') status.style.color = '#f9a825';
  status.textContent = `${authState.dot} ${authState.label}`;
  status.title = authState.detail;
  statusRow.appendChild(status);

  // Lightweight refresh — re-reads the Keychain/credentials.json without
  // re-running the full profile-list scan. Useful right after a /login
  // PTY finishes in another tab.
  const refreshStatusBtn = document.createElement('button');
  refreshStatusBtn.className = 'profile-btn';
  refreshStatusBtn.textContent = 'Refresh status';
  refreshStatusBtn.style.fontSize = '11px';
  refreshStatusBtn.style.padding = '2px 8px';
  refreshStatusBtn.addEventListener('click', async () => {
    try {
      const meta = await api.claudeAuthMeta();
      if (!meta || meta.hasAuth === false) {
        acc.hasClaudeAuth = false;
        acc.claudeAuthExpiresAt = null;
        acc.claudeAuthSubscription = null;
      } else {
        acc.hasClaudeAuth = true;
        acc.claudeAuthExpiresAt = meta.expiresAt || null;
        acc.claudeAuthSubscription = meta.subscriptionType || null;
        acc.claudeAuthRateLimitTier = meta.rateLimitTier || null;
      }
      renderAccountList();
      renderProfileButton();
    } catch (err) {
      showGridBanner('Failed to refresh status: ' + (err && err.message || err), 'warn');
    }
  });
  statusRow.appendChild(refreshStatusBtn);

  detail.appendChild(statusRow);

  // Login button (opens an xterm with `claude login`)
  const loginActions = document.createElement('div');
  loginActions.style.display = 'flex';
  loginActions.style.gap = '8px';
  loginActions.style.marginTop = '10px';

  const loginBtn = document.createElement('button');
  loginBtn.className = 'profile-btn';
  loginBtn.textContent = acc.hasClaudeAuth ? 'Re-login Claude' : 'Fazer login Claude';
  loginBtn.addEventListener('click', () => {
    // Spawna um `claude` avulso nesta conta — reusa launchTerminal; o PTY
    // herda HOME=account.dir, então as credenciais caem em
    // account.dir/.claude/.credentials.json.
    const spawnId = launchTerminal(acc, {
      mode: 'default',
      profileNum: acc.num,
      agentId: 'claude',   // a TUI que recebe o "/login" abaixo tem que ser a do Claude
    });
    // Pane maximizado temporário no grid; o refresh de contas pós-exit já é
    // do openLoginPane (o badge exato ainda pode pedir "Refresh status").
    openLoginPane(spawnId);
    // Depois de um instante, manda "/login\r" pra iniciar o fluxo de auth —
    // isto acontece no SPAWN (dar tempo da TUI subir), não no exit.
    setTimeout(() => { try { api.sendInput(spawnId, '/login\r'); } catch {} }, 2500);
  });
  loginActions.appendChild(loginBtn);
  detail.appendChild(loginActions);

  // Model picker — dropdown of well-known Claude ids + "custom" free-text.
  // Saving sends the cleaned id (or null for "automatic") via IPC; the
  // backend validator accepts the [\w.-]+ chars we use here.
  const CLAUDE_MODEL_PRESETS = [
    { id: '',                    label: 'Automatic (Claude CLI chooses)' },
    { id: 'claude-opus-4-7',     label: 'Opus 4.7  — maximum reasoning' },
    { id: 'claude-sonnet-4-6',   label: 'Sonnet 4.6 — balanced' },
    { id: 'claude-haiku-4-5',    label: 'Haiku 4.5 — fast / cheap' },
    { id: '__custom__',          label: 'Outro / customizado…' },
  ];
  const modelLbl = document.createElement('div');
  modelLbl.className = 'profile-form-label';
  modelLbl.style.marginTop = '14px';
  modelLbl.textContent = 'Modelo Claude';
  detail.appendChild(modelLbl);

  const modelSel = document.createElement('select');
  modelSel.className = 'profile-form-input';
  modelSel.style.marginTop = '4px';
  const presetIds = CLAUDE_MODEL_PRESETS.map(p => p.id).filter(id => id && id !== '__custom__');
  const currentModel = acc.claudeModel || '';
  const matchesPreset = !currentModel || presetIds.includes(currentModel);
  CLAUDE_MODEL_PRESETS.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.id;
    o.textContent = opt.label;
    modelSel.appendChild(o);
  });
  modelSel.value = matchesPreset ? currentModel : '__custom__';
  detail.appendChild(modelSel);

  // Free-text fallback shown only when "Outro" is selected. Pre-fills
  // with the saved custom id so saving without retyping still works.
  const customIn = document.createElement('input');
  customIn.className = 'profile-form-input';
  customIn.type = 'text';
  customIn.style.marginTop = '6px';
  customIn.placeholder = 'ex: claude-opus-4-7-20260108';
  customIn.value = matchesPreset ? '' : currentModel;
  customIn.style.display = modelSel.value === '__custom__' ? '' : 'none';
  detail.appendChild(customIn);

  modelSel.addEventListener('change', () => {
    customIn.style.display = modelSel.value === '__custom__' ? '' : 'none';
    if (modelSel.value === '__custom__') customIn.focus();
  });

  const modelHint = document.createElement('div');
  modelHint.className = 'profile-form-hint';
  modelHint.style.marginTop = '6px';
  modelHint.textContent = 'Automatic lets the Claude CLI choose. Custom IDs only with letters/numbers/./_/-.';
  detail.appendChild(modelHint);

  const modelActions = document.createElement('div');
  modelActions.style.display = 'flex';
  modelActions.style.gap = '8px';
  modelActions.style.marginTop = '10px';

  const saveModelBtn = document.createElement('button');
  saveModelBtn.className = 'profile-btn';
  saveModelBtn.textContent = 'Save model';
  saveModelBtn.addEventListener('click', async () => {
    let m;
    if (modelSel.value === '__custom__') {
      m = customIn.value.trim() || null;
    } else {
      m = modelSel.value.trim() || null;
    }
    const r = await api.profileSetClaudeModel(acc.num, m);
    if (r && r.error) { showGridBanner(r.error, 'warn'); return; }
    acc.claudeModel = m;
    renderAccountList();
    renderProfileButton();
  });
  modelActions.appendChild(saveModelBtn);
  detail.appendChild(modelActions);
}

// ── Account rendering ─────────────────────────────────────────────────────────
// Classify Claude OAuth state into a colored badge for the profile card.
// Reads acc.claudeAuthExpiresAt (millis) populated by loadAccounts in main.js.
// Returns:
//   { level: 'green'  } → token valid for ≥ 3 days
//   { level: 'yellow' } → token expires in < 3 days (or expiresAt unknown but logged in)
//   { level: 'red'    } → no auth or already-expired token
// Each result also carries { dot, label, detail } for direct UI consumption.
function classifyClaudeAuth(acc) {
  if (!acc || !acc.hasClaudeAuth) {
    return {
      level: 'red',
      dot: '\u{1F534}',           // red circle
      label: 'No Claude login',
      detail: 'Click "Log in to Claude" to authenticate via OAuth in the browser.',
    };
  }
  const exp = acc.claudeAuthExpiresAt;
  const sub = acc.claudeAuthSubscription
    ? ` · plano: ${acc.claudeAuthSubscription}`
    : '';
  if (typeof exp !== 'number' || !isFinite(exp)) {
    return {
      level: 'yellow',
      dot: '\u{1F7E1}',           // yellow circle
      label: 'OAuth active (unknown expiry)',
      detail: 'Credentials found, but no expiresAt field' + sub + '.',
    };
  }
  const now = Date.now();
  const msLeft = exp - now;
  const dayMs = 24 * 60 * 60 * 1000;
  const fmtDate = new Date(exp).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  if (msLeft <= 0) {
    return {
      level: 'red',
      dot: '\u{1F534}',
      label: 'OAuth expired',
      detail: `Token venceu em ${fmtDate}. Rode "Re-login Claude" para renovar` + sub + '.',
    };
  }
  if (msLeft < 3 * dayMs) {
    const hoursLeft = Math.max(1, Math.round(msLeft / (60 * 60 * 1000)));
    return {
      level: 'yellow',
      dot: '\u{1F7E1}',
      label: `OAuth expira em ~${hoursLeft}h`,
      detail: `Token vence em ${fmtDate}` + sub + '. Re-login when you can.',
    };
  }
  const daysLeft = Math.round(msLeft / dayMs);
  return {
    level: 'green',
    dot: '\u{1F7E2}',             // green circle
    label: `OAuth active (${daysLeft}d remaining)`,
    detail: `Valid until ${fmtDate}` + sub + '.',
  };
}

// Um perfil "tem" um provider quando a credencial existe no accounts/N/.
// agentId usa os ids do registry (aider = OpenRouter).
function profileHasProvider(acc, agentId) {
  const p = acc && acc.providers;
  if (!p) return false;
  if (agentId === 'aider' || agentId === 'openrouter') {
    return !!(p.openrouter && p.openrouter.configured);
  }
  return !!(p[agentId] && p[agentId].connected);
}

// Derive profile health from authMode + apiKey presence + quota cache.
// Returns { ok, status, message }. Status values:
//   'ok'              — usable
//   'unconfigured'    — no authMode chosen yet
//   'missing-apikey'  — authMode=apikey but no key saved
//   'logged-out'      — authMode=chatgpt and quota check found auth failure
//   'pending'         — authMode=chatgpt and quota never checked (revalidating)
function getProfileHealth(acc, q) {
  if (!acc) return { ok: false, status: 'unconfigured', message: 'Invalid profile' };
  // Multi-provider (2026-07-10): o perfil é utilizável se QUALQUER provider
  // estiver conectado. Um Codex expirado não pode bloquear um Claude saudável.
  const algumConectado = ['codex', 'claude', 'grok', 'opencode', 'aider']
    .some(id => profileHasProvider(acc, id));
  if (acc.authMode == null) {
    return { ok: false, status: 'unconfigured', message: 'Configure ChatGPT or an API key in Profile settings' };
  }
  if (acc.authMode === 'apikey') {
    return acc.hasApiKey
      ? { ok: true, status: 'ok' }
      : { ok: algumConectado, status: 'missing-apikey', message: 'API key not configured' };
  }
  if (acc.authMode === 'openrouter') {
    if (!acc.hasOpenrouterKey) {
      return { ok: algumConectado, status: 'missing-openrouter-key', message: 'OpenRouter key not configured' };
    }
    if (!acc.openrouterModel) {
      return { ok: algumConectado, status: 'missing-openrouter-model', message: 'OpenRouter model not chosen' };
    }
    return { ok: true, status: 'ok' };
  }
  if (acc.authMode === 'chatgpt') {
    if (q && q.loggedOut === true) {
      return { ok: algumConectado, status: 'logged-out', message: 'ChatGPT session expired — please log in again' };
    }
    if (q && q.noCredit === true) {
      return { ok: algumConectado, status: 'no-credit', message: 'No credits (billing) — check the OpenAI dashboard' };
    }
    if (!q) {
      return { ok: false, status: 'pending', message: 'Checking session…' };
    }
    return { ok: true, status: 'ok' };
  }
  if (acc.authMode === 'claude') {
    if (!acc.hasClaudeAuth) {
      return { ok: algumConectado, status: 'claude-not-logged-in', message: 'Not logged in to Claude — click "Log in to Claude" in Profile settings' };
    }
    // Treat *already expired* OAuth as broken; <3d warning is still ok=true
    // so the profile is usable until the user re-logs.
    const exp = acc.claudeAuthExpiresAt;
    if (typeof exp === 'number' && exp > 0 && exp < Date.now()) {
      return { ok: algumConectado, status: 'claude-expired', message: 'Claude token expired — re-login in Profile settings' };
    }
    return { ok: true, status: 'ok' };
  }
  return { ok: false, status: 'unconfigured', message: 'Unknown authentication mode' };
}

function renderAccountList() {
  const list = document.getElementById('accountList');
  list.innerHTML = '';
  st.accounts.forEach(acc => list.appendChild(makeAccountItem(acc)));
  const count = document.getElementById('accCount');
  if (count) count.textContent = st.accounts.length;
}

function makeAccountItem(acc) {
  const item = document.createElement('div');
  const q = st.quota[String(acc.num)];
  const health = getProfileHealth(acc, q);
  const isLoggedOut = health.status === 'logged-out';

  item.className = 'acc-item'
    + (acc.num === st.selectedAccountNum ? ' selected' : '')
    + (isLoggedOut ? ' inactive' : '')
    + (!health.ok ? ' unavailable' : '');
  item.dataset.num = acc.num;
  if (!health.ok) item.title = health.message;

  const dot = document.createElement('span');
  dot.className = 'acc-dot'
    + (anyThreadRunningForAccount(acc.num) ? ' running' : '')
    + (isLoggedOut ? ' inactive' : '');
  dot.dataset.dot = acc.num;

  const name = document.createElement('span');
  name.className = 'acc-name';
  name.textContent = acc.name || ('Account ' + acc.num);

  item.appendChild(dot);
  item.appendChild(name);

  // Health warning badge: red ! for problems, gray ? while quota still checking
  if (!health.ok) {
    const warn = document.createElement('span');
    warn.className = 'acc-warn' + (health.status === 'pending' ? ' pending' : '');
    warn.textContent = health.status === 'pending' ? '?' : '!';
    warn.title = health.message;
    item.appendChild(warn);
  }

  const menuBtn = document.createElement('button');
  menuBtn.className = 'acc-menu-btn';
  menuBtn.textContent = '···';
  menuBtn.addEventListener('click', e => { e.stopPropagation(); showAccountMenu(acc, menuBtn); });
  item.appendChild(menuBtn);

  item.addEventListener('mouseenter', () => showQuotaCard(acc, item));
  item.addEventListener('mouseleave', hideQuotaCard);
  item.addEventListener('click', () => {
    // Block selection when account isn't usable — except Claude profiles
    // that just need a login (selection is required to spawn the login PTY).
    // Expired Claude tokens also count: user needs the profile selected so
    // the re-login PTY inherits the right HOME/USER override.
    const claudeNeedsLogin = acc.authMode === 'claude'
      && (!acc.hasClaudeAuth || health.status === 'claude-expired');
    if (!health.ok && !claudeNeedsLogin) return;
    st.selectedAccountNum = acc.num;
    document.querySelectorAll('.acc-item').forEach(el => el.classList.toggle('selected', parseInt(el.dataset.num) === acc.num));
    showOutputFor(acc.num);
    updateHeader();
    updateInputState();
  });
  return item;
}

function renderAccountItem(num) {
  const list = document.getElementById('accountList');
  const existing = list.querySelector(`.acc-item[data-num="${num}"]`);
  const acc = st.accounts.find(a => a.num === num);
  if (!acc) return;
  const fresh = makeAccountItem(acc);
  if (existing) list.replaceChild(fresh, existing);
  else list.appendChild(fresh);
}

// ── Quota card ────────────────────────────────────────────────────────────────
function showQuotaCard(acc, anchor) {
  const card = document.getElementById('quotaCard');
  const q = st.quota[String(acc.num)];
  card.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'quota-card-name';
  title.textContent = acc.name || ('Account ' + acc.num);
  card.appendChild(title);

  function addWindow(label, pct, resetsAt) {
    const win = document.createElement('div');
    win.className = 'quota-window';

    const lbl = document.createElement('div');
    lbl.className = 'quota-window-label';
    lbl.textContent = label;

    const track = document.createElement('div');
    track.className = 'quota-bar-track';
    const fill = document.createElement('div');
    fill.className = 'quota-bar-fill' + (pct <= 5 ? ' exhausted' : pct < 20 ? ' low' : '');
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    track.appendChild(fill);

    const row = document.createElement('div');
    row.className = 'quota-window-row';
    const pctEl = document.createElement('span');
    pctEl.className = 'quota-pct';
    pctEl.textContent = Math.round(pct) + '% left';
    const resetEl = document.createElement('span');
    resetEl.className = 'quota-reset';
    if (resetsAt) {
      const remaining = resetsAt - Date.now();
      resetEl.textContent = 'resets in ' + formatDuration(remaining);
    }

    row.appendChild(pctEl);
    row.appendChild(resetEl);
    win.append(lbl, track, row);
    card.appendChild(win);
  }

  if (q && q.primary) {
    addWindow('Primary (5h window)', q.primary.percent_left || 0, q.primary.resets_at_ms);
    if (q.secondary) {
      const sep = document.createElement('div');
      sep.className = 'quota-sep';
      card.appendChild(sep);
      addWindow('Secondary', q.secondary.percent_left || 0, q.secondary.resets_at_ms);
    }
  } else if (q) {
    addWindow('Quota', q.percentLeft || 0, q.resetsAt);
  } else {
    const na = document.createElement('div');
    na.style.cssText = 'font-size:12px;color:var(--text-muted);padding:4px 0';
    na.textContent = 'Quota data unavailable. Hover again after refresh.';
    card.appendChild(na);
  }


  card.style.visibility = 'hidden';
  card.classList.remove('hidden');
  requestAnimationFrame(() => {
    const r = anchor.getBoundingClientRect();
    const cardW = card.offsetWidth || 240;
    const cardH = card.offsetHeight || 180;
    let left = r.right + 10;
    let top = r.top;
    if (left + cardW > window.innerWidth - 8) left = r.left - cardW - 10;
    if (top + cardH > window.innerHeight - 8) top = window.innerHeight - cardH - 8;
    top = Math.max(8, top);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    card.style.visibility = '';
  });
}

function hideQuotaCard() {
  document.getElementById('quotaCard').classList.add('hidden');
}

// ── Project list rendering ────────────────────────────────────────────────────
// Group threads by cwd (the folder where codex was opened) — matches how
// Cursor / Codex CLI / Conductor organize. Each distinct folder becomes its
// own project, even if multiple folders share the same git repo. Names are
// disambiguated by including parent when basenames collide.
function buildProjectMap(threads) {
  const map = new Map(); // key → { name, cwd, threads[] }
  // First pass: group by cwd
  threads.forEach(t => {
    const cwd = (t.cwd || '').replace(/\/+$/, '');
    const key = cwd || 'unknown';
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: projectName(cwd, null),  // ignore origin URL — group by folder, not by repo
        cwd: cwd || null,
        threads: [],
      });
    }
    map.get(key).threads.push(t);
  });

  // Second pass: disambiguate names when basenames collide
  const byName = new Map();
  for (const proj of map.values()) {
    if (!byName.has(proj.name)) byName.set(proj.name, []);
    byName.get(proj.name).push(proj);
  }
  for (const [name, projs] of byName) {
    if (projs.length <= 1) continue;
    // Multiple projects share basename — append parent dir to each
    for (const proj of projs) {
      if (!proj.cwd) continue;
      const parts = proj.cwd.split(/[\\/]/).filter(Boolean);
      const parent = parts[parts.length - 2] || '';
      proj.name = parent ? `${parent}/${name}` : name;
    }
  }

  // Apply user-defined order from localStorage
  const order = getProjectOrder();
  if (order.length) {
    const sorted = new Map();
    const remaining = new Map(map);
    for (const key of order) {
      if (remaining.has(key)) {
        sorted.set(key, remaining.get(key));
        remaining.delete(key);
      }
    }
    for (const [k, v] of remaining) sorted.set(k, v);
    return sorted;
  }
  return map;
}

function getProjectOrder() {
  try { return JSON.parse(localStorage.getItem('norya-project-order') || '[]'); } catch { return []; }
}

// Fase 5: workspace-enabled projects (localStorage; Fase 6 will sync to projects.json)
function getWorkspaceEnabledKeys() {
  try { return JSON.parse(localStorage.getItem('norya-workspace-enabled') || '[]'); }
  catch { return []; }
}

// Fase 4: archived projects state (localStorage like project order)
function getArchivedProjectKeys() {
  try { return JSON.parse(localStorage.getItem('norya-archived-projects') || '[]'); }
  catch { return []; }
}
function setArchivedProjectKeys(keys) {
  try { localStorage.setItem('norya-archived-projects', JSON.stringify(keys)); } catch {}
}
function archiveProject(key) {
  const keys = getArchivedProjectKeys();
  if (!keys.includes(key)) {
    keys.push(key);
    setArchivedProjectKeys(keys);
    renderProjectList();
  }
}
function unarchiveProject(key) {
  setArchivedProjectKeys(getArchivedProjectKeys().filter(k => k !== key));
  renderProjectList();
}

