/**
 * renderer/browser.js — painel do navegador embutido do Norya.
 *
 * Duas IIFEs, extraídas de test-window.html em 2026-07-09 (Fase 2):
 *   1. ponte window.electronAPI.noryaBrowser → handlers ipcMain
 *   2. painel: abas <webview>, barra de endereço, bookmarks, modal de login
 *
 * Script CLÁSSICO (ver renderer/state.js). Carrega DEPOIS do markup do painel
 * (#noryaBrowserPanel) e depois de state.js/ipc.js, exatamente como o inline
 * que ele substitui. Lê `window.st`; não declara nada no escopo global.
 *
 * Sem Tor, sem proxy e sem spoofing: a <webview> roda com contextIsolation
 * padrão e sem preload. Ver browser/browser-manager.js.
 */
'use strict';

// Bridge: expose window.electronAPI.noryaBrowser mapping to ipcMain handlers.
// Uses ipcRenderer (nodeIntegration: true in this window).
(() => {
  const { ipcRenderer } = require('electron');
  const inv = (m, p) => ipcRenderer.invoke('norya-browser:' + m, p || {});
  const listeners = new Map(); // event → Set<handler>
  const ev = (chan, payload) => {
    const set = listeners.get(chan);
    if (!set) return;
    for (const h of set) { try { h(payload); } catch (e) { console.warn('nb listener err', e); } }
  };
  ipcRenderer.on('norya-browser-event', (_, { event, payload }) => ev(event, payload));
  window.electronAPI = window.electronAPI || {};
  window.electronAPI.noryaBrowser = {
    openPanel:   (pid, opts) => inv('open-panel',   { profileId: pid, opts }),
    closePanel:  (pid)       => inv('close-panel',  { profileId: pid }),
    isPanelOpen: (pid)       => inv('is-panel-open',{ profileId: pid }),
    openTab:     (pid, url, opts) => inv('open-tab', { profileId: pid, url, opts }),
    closeTab:    (pid, tid)  => inv('close-tab',    { profileId: pid, tabId: tid }),
    listTabs:    (pid)       => inv('list-tabs',    { profileId: pid }),
    setActiveTab:(pid, tid)  => inv('set-active-tab',{ profileId: pid, tabId: tid }),
    resizePanelWidth: (pid, w) => inv('resize-panel-width', { profileId: pid, width: w }),
    emulate:     (wcId, params) => inv('emulate', { webContentsId: wcId, params }),
    navigateTab: (pid, tid, action, params) => inv('navigate-tab', { profileId: pid, tabId: tid, action, params }),
    bookmarksList:  (pid)        => inv('bookmarks-list',   { profileId: pid }),
    bookmarksAdd:   (pid, u, t)  => inv('bookmarks-add',    { profileId: pid, url: u, title: t }),
    bookmarksRemove:(pid, id)    => inv('bookmarks-remove', { profileId: pid, id }),
    clearData:   (pid)       => inv('clear-data',   { profileId: pid }),
    setLoginBrowserChoice: (pid, c, r) => inv('login-set-choice', { profileId: pid, choice: c, remember: r }),
    getLoginBrowserChoice: (pid)       => inv('login-get-choice', { profileId: pid }),
    on:  (evt, h) => { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(h); },
    off: (evt, h) => { if (listeners.has(evt)) listeners.get(evt).delete(h); },
  };
})();

(() => {
  const { ipcRenderer } = require('electron');
  let _fs = null; try { _fs = require('fs'); } catch {}
  // Pasta das capturas: /tmp no macOS (de sempre), %TEMP% no Windows — onde não existe /tmp.
  let _shotDir = '/tmp'; try { _shotDir = require('./platform').scratchCwd(); } catch {}
  const _shotPath = (nome) => { try { return require('path').join(_shotDir, nome); } catch { return _shotDir + '/' + nome; } };

  let activeProfileId = null;
  let sess = null;          // { partition, profileId } vindo do main
  let tabs = [];            // [{ id, wv, url, title, loading, favicon, consoleLog }]
  let activeId = null;

  const $ = id => document.getElementById(id);
  const panel = $('noryaBrowserPanel');
  const btnBrowser = $('btnNoryaBrowser');
  const content = $('nbContent');
  const home = $('nbHome');

  function api() { return window.electronAPI && window.electronAPI.noryaBrowser; }
  function esc(s){ if(s==null)return''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  function currentProfileId() {
    const stRef = (typeof window.st === 'object' && window.st) || (typeof st === 'object' && st) || null;
    if (stRef && stRef.activeProfileNum != null) return stRef.activeProfileNum;
    const el = document.querySelector('[data-active-profile]');
    if (el) return parseInt(el.dataset.activeProfile, 10);
    return null;
  }

  function uid(){ return 't' + Math.random().toString(36).slice(2,9); }
  function isBlank(u){ return !u || u === 'about:blank'; }
  function normalizeUrl(v) {
    v = (v||'').trim(); if(!v) return null;
    if (/^[a-z]+:\/\//i.test(v)) return v;
    if (/^[^\s.]+\.[^\s]{2,}(\/.*)?$/.test(v) && !v.includes(' ')) return 'https://' + v;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
  }
  function tabById(id){ return tabs.find(t => t.id === id); }
  function activeTab(){ return tabById(activeId); }

  // ── Dock + emulação de device (2026-08-01) ─────────────────────────────────
  // O painel segue `position: fixed` + translateX de propósito: é isso que
  // mantém o "esconder ≠ destruir" e o workaround do capturePage offscreen. O
  // ESPAÇO vem de body.browser-docked, que dá padding-right ao .app — mesmo
  // padrão do painel de logs (styles.css). Ver device-presets.js para o porquê
  // de o viewport não depender da largura do painel.
  const DEV = window.NoryaDevice;
  const DOCK_MIN = 360, DOCK_DEFAULT = 560;
  let presetId = DEV.DEFAULT_PRESET_ID;
  let rotated = false;

  /** Largura ÚTIL: a área onde a página é desenhada, não a do painel. */
  function dockContentWidth() { return content.clientWidth || panel.clientWidth || DOCK_DEFAULT; }

  function setDockWidth(w) {
    panel.style.width = w + 'px';
    document.documentElement.style.setProperty('--nb-dock-w', w + 'px');
  }

  function currentParams() {
    return DEV.emulationParams(presetId, dockContentWidth(), { rotated });
  }

  /**
   * UM resize sintético DEPOIS do slide, nunca durante: o xterm refaz o cálculo
   * de colunas a cada evento, e disparar durante a animação faz as letras
   * dançarem em todos os panes do grid. Mesmo padrão de setSidebarCollapsed.
   */
  let _slideTimer = null;
  function afterDockSlide() {
    clearTimeout(_slideTimer);
    _slideTimer = setTimeout(() => {
      try { window.dispatchEvent(new Event('resize')); } catch {}
      reapplyEmulation();
    }, 240);
  }

  /** Aplica (ou desliga) a emulação numa aba. Silencioso se a webview morreu. */
  async function applyEmulation(tab, params) {
    if (!tab || !api()) return;
    let id = null;
    try { id = tab.wv.getWebContentsId(); } catch { return; }
    if (id == null) return;
    try { await api().emulate(id, params === undefined ? currentParams() : params); }
    catch (e) { console.warn('[nb] emulate falhou', e); }
  }

  function refreshScaleLabel() {
    const el = $('nbScaleLabel');
    if (!el) return;
    const p = currentParams();
    el.textContent = p
      ? `${p.viewSize.width}×${p.viewSize.height} · ${Math.round(p.scale * 100)}%`
      : '';
  }

  /** Reaplica em TODAS as abas: a emulação é por webContents, não por painel. */
  function reapplyEmulation() {
    const p = currentParams();
    tabs.forEach(t => applyEmulation(t, p));
    refreshScaleLabel();
  }

  // Create a <webview> tab in the DOM (flows with layout — no native overlay).
  // `opts.by` marca o DONO da aba: 'user' (clique, ⌘T, shim de `open <url>`)
  // ou 'agent' (MCP). Só as de agente entram na faxina automática — ver
  // sweepAgentTabs. Cada <webview> é um processo de renderer inteiro, então
  // aba esquecida aberta é CPU e RAM parados no Mac, não só sujeira na barra.
  /**
   * Monta (ou REmonta) a <webview> de uma aba e pendura os listeners.
   *
   * Separado de createTab porque agora acontece duas vezes na vida da aba: ao
   * criar e ao ACORDAR de um cochilo (ver dormirAba/acordarAba). Tudo que a
   * aba precisa lembrar entre um e outro — url, título, favicon, console —
   * mora no registro `tab`, nunca na <webview>, que é descartável.
   */
  function montarWebview(tab) {
    const id = tab.id;
    const wv = document.createElement('webview');
    wv.setAttribute('partition', sess.partition);
    wv.setAttribute('allowpopups', 'true');
    // Sem preload e com contextIsolation padrão (ON). O preload existia apenas
    // para injetar spoofing de fingerprint no world da página — removido em
    // 2026-07-09. A página segue sem acesso a Node.
    wv.setAttribute('webpreferences', 'nodeIntegration=no');
    wv.dataset.tabId = id;
    wv.src = isBlank(tab.url) ? 'about:blank' : tab.url;

    // dom-ready é o 1º ponto em que a <webview> tem webContents próprio. Também
    // dispara depois de navegações que trocam o renderer, então a emulação
    // sobrevive a elas sem precisar de bookkeeping.
    wv.addEventListener('dom-ready', () => { applyEmulation(tab); });
    wv.addEventListener('did-start-loading', () => { tab.loading = true; renderTabBar(); refreshLoading(); });
    wv.addEventListener('did-stop-loading',  () => { tab.loading = false; renderTabBar(); refreshLoading(); refreshNav(); });
    wv.addEventListener('page-title-updated',(e)=>{ tab.title = e.title || tab.title; renderTabBar(); });
    wv.addEventListener('page-favicon-updated',(e)=>{ tab.favicon = (e.favicons&&e.favicons[0])||null; renderTabBar(); });
    wv.addEventListener('did-navigate',(e)=>{ tab.url = e.url; if(id===activeId) $('nbAddrInput').value = isBlank(e.url)?'':e.url; toggleHome(); refreshNav(); });
    wv.addEventListener('did-navigate-in-page',(e)=>{ if(e.isMainFrame){ tab.url=e.url; if(id===activeId)$('nbAddrInput').value=isBlank(e.url)?'':e.url; } });
    wv.addEventListener('did-fail-load',(e)=>{ if(e.errorCode===-3)return; tab.loading=false; renderTabBar(); refreshLoading(); });
    wv.addEventListener('console-message',(e)=>{ tab.consoleLog.push({level:e.level,text:e.message,line:e.line,source:e.sourceId,ts:Date.now()}); if(tab.consoleLog.length>500)tab.consoleLog.shift(); });

    content.appendChild(wv);
    tab.wv = wv;
    return wv;
  }

  // Create a <webview> tab in the DOM (flows with layout — no native overlay).
  // `opts.by` marca o DONO da aba: 'user' (clique, ⌘T, shim de `open <url>`)
  // ou 'agent' (MCP). Só as de agente entram na faxina automática — ver
  // sweepAgentTabs. Cada <webview> é um processo de renderer inteiro, então
  // aba esquecida aberta é CPU e RAM parados no Mac, não só sujeira na barra.
  function createTab(url, opts) {
    if (!sess) { console.warn('[nb] no session prepared'); return null; }
    const by = (opts && opts.by) === 'agent' ? 'agent' : 'user';
    const id = uid();
    const tab = { id, wv: null, url: url||'', title: '', loading: false, favicon: null, consoleLog: [], by, touchedTs: Date.now(), asleep: false };
    montarWebview(tab);
    tabs.push(tab);
    setActive(id);
    return tab;
  }

  // ── Abas que cochilam (2026-09-08) ─────────────────────────────────────────
  //
  // Cada <webview> viva é um PROCESSO de renderer inteiro. Num Air de 8 GB,
  // meia dúzia de abas esquecidas em segundo plano é RAM que falta pros panes
  // — e RAM que falta liga o compressor de memória, que é CPU, que é calor.
  //
  // Aba de fundo parada há TAB_SLEEP_MS perde a <webview> e vira só o registro
  // (url, título, favicon). Na barra ela continua lá, apagadinha; clicar
  // remonta e recarrega. Mesmo contrato das "sleeping tabs" do Chrome/Edge —
  // e a razão de o registro `tab` ser a fonte da verdade, nunca a <webview>.
  //
  // Quem NUNCA cochila: a aba ativa e as de agente. Aba de agente já tem
  // destino próprio — sweepAgentTabs FECHA em vez de adormecer, porque o
  // agente não volta pra aba que abandonou e guardar o registro dele não
  // serviria pra nada.
  const TAB_SLEEP_MS = 15 * 60 * 1000;
  // Painel recolhido (2026-10-03): ninguém está olhando aba nenhuma, então o
  // relógio é bem mais curto. Medido: UMA aba de login do claude.ai esquecida
  // segurava ~320 MB em 2 processos de renderer. Conta a partir do mais
  // recente entre o último toque na aba e o momento em que o painel fechou.
  const TAB_SLEEP_HIDDEN_MS = 3 * 60 * 1000;
  let painelFechouEm = Date.now();

  function dormirAba(t) {
    if (!t || t.asleep || t.by === 'agent' || !t.wv) return false;
    // A aba ativa só é intocável enquanto o painel está ABERTO — aí o usuário
    // está de fato olhando pra ela. Com o painel recolhido não há "aba na
    // frente": todas são de fundo, e a ativa é só a que vai aparecer no
    // próximo ⌘B (que a acorda antes de mostrar).
    if (t.id === activeId && panel.classList.contains('open')) return false;
    try { t.wv.remove(); } catch {}
    t.wv = null;
    t.asleep = true;
    t.loading = false;
    return true;
  }

  function acordarAba(t) {
    if (!t || !t.asleep) return t;
    if (!sess) return t;   // sem sessão preparada não há partition pra montar
    t.asleep = false;
    montarWebview(t);
    return t;
  }

  function closeTab(id) {
    const i = tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    const [tab] = tabs.splice(i, 1);
    try { tab.wv.remove(); } catch {}
    if (activeId === id) setActive((tabs[i] || tabs[i-1] || {}).id || null);
    else renderTabBar();
  }

  // ── Encerrar navegação ─────────────────────────────────────────────────────
  //
  // Fechar aba = destruir a <webview> = matar o processo de renderer dela.
  //
  // 2026-07-14 → 2026-09-08: fechar deixou de ser a única coisa que devolve
  // recurso. Esconder o painel (⌘B) agora tira as <webview> do compositor
  // (display:none pelo CSS — ver `#noryaBrowserPanel:not(.open)` em
  // styles.css), e a faxina adormece aba parada. A diferença que sobra é de
  // grau: esconder para de PINTAR, adormecer devolve o PROCESSO, fechar
  // esquece a aba. Nada disto toca em cookie/login — wipe segue só no
  // "Limpar dados".

  /** Fecha as abas que passarem no filtro. Devolve quantas foram. */
  function closeTabsWhere(pred) {
    const doomed = tabs.filter(pred);
    doomed.forEach(t => closeTab(t.id));
    return doomed.length;
  }

  /**
   * "Finalizar navegador": fecha TODAS as abas e recolhe o painel. O perfil e o
   * storage continuam de pé — reabrir com ⌘B volta na home, logado.
   */
  function finalizarNavegador() {
    const n = closeTabsWhere(() => true);
    if (panel.classList.contains('open')) togglePanel();
    return n;
  }

  // Faxina das abas de agente. O sinal de "o agente terminou" que dá pra
  // observar daqui é o silêncio: nenhuma chamada MCP naquela aba há um tempo.
  // O agente educado chama browser_finish e não espera o timer; este é o piso
  // pra quando ele esquece (ou morre no meio).
  // 10 min e não 2: o agente às vezes abre a página, some pra editar código e
  // volta pra tirar screenshot. Varrer cedo demais faz a aba evaporar no meio
  // do trabalho dele; pra acumular calor no Mac, o que importa é não passar a
  // TARDE aberta.
  const AGENT_TAB_IDLE_MS = 10 * 60 * 1000;
  const SWEEP_MS = 30 * 1000;

  function touchTab(t) { if (t) t.touchedTs = Date.now(); }

  function sweepAgentTabs() {
    const now = Date.now();
    // Painel aberto na aba que o agente abriu = o usuário PODE estar lendo
    // aquilo (é o fluxo "abre o preview pra eu ver"). Essa não morre sozinha.
    const visivel = panel.classList.contains('open');
    return closeTabsWhere(t =>
      t.by === 'agent' &&
      !(visivel && t.id === activeId) &&
      now - (t.touchedTs || 0) >= AGENT_TAB_IDLE_MS);
  }

  /**
   * Uma passada só: fecha aba de agente abandonada, adormece aba de usuário
   * parada. Dois relógios diferentes de propósito — a de agente não volta
   * (fecha), a do usuário volta (dorme).
   */
  function faxina() {
    const fechadas = sweepAgentTabs();
    const now = Date.now();
    const aberto = panel.classList.contains('open');
    let dormiram = 0;
    tabs.forEach(t => {
      const desde = aberto ? (t.touchedTs || 0) : Math.max(t.touchedTs || 0, painelFechouEm);
      if (now - desde < (aberto ? TAB_SLEEP_MS : TAB_SLEEP_HIDDEN_MS)) return;
      if (dormirAba(t)) dormiram++;
    });
    if (dormiram) renderTabBar();
    return { fechadas, dormiram };
  }
  setInterval(faxina, SWEEP_MS);

  function setActive(id) {
    activeId = id;
    // Acorda ANTES de marcar visível: a aba escolhida pode estar cochilando e
    // não ter <webview> nenhuma pra receber a classe.
    const alvo = tabs.find(t => t.id === id);
    if (alvo) { acordarAba(alvo); alvo.touchedTs = Date.now(); }
    tabs.forEach(t => { if (t.wv) t.wv.classList.toggle('active', t.id === id); });
    toggleHome(); renderTabBar(); refreshNav(); refreshLoading();
    const t = activeTab();
    $('nbAddrInput').value = t && !isBlank(t.url) ? t.url : '';
  }

  function toggleHome() {
    const t = activeTab();
    home.classList.toggle('active', !t || isBlank(t.url));
  }

  let _pendingNav = null;
  function go(url) {
    const u = normalizeUrl(url); if(!u) return;
    if (!sess) {
      // Sessão ainda preparando — enfileira e mostra dica em vez de falhar.
      _pendingNav = u;
      $('nbStatusMsg').textContent = 'Preparando sessão… abrirá em instantes';
      return;
    }
    let t = activeTab();
    if (!t) { createTab(u); }
    else {
      acordarAba(t);
      try { t.wv.loadURL(u); } catch { try { t.wv.src = u; } catch {} }
      t.url = u;
    }
    toggleHome();
  }

  function refreshLoading() {
    const t = activeTab();
    $('nbLoading').classList.toggle('active', !!(t && t.loading));
  }

  function refreshNav() {
    const t = activeTab(); const wv = t && t.wv;
    let cb=false, cf=false;
    try { cb = wv && wv.canGoBack && wv.canGoBack(); } catch {}
    try { cf = wv && wv.canGoForward && wv.canGoForward(); } catch {}
    $('nbBack').disabled = !cb; $('nbForward').disabled = !cf; $('nbReload').disabled = !t;
  }

  function renderTabBar() {
    const bar = $('nbTabBar');
    Array.from(bar.querySelectorAll('.nb-tab')).forEach(el => el.remove());
    const frag = document.createDocumentFragment();
    tabs.forEach(t => {
      const el = document.createElement('div');
      el.className = 'nb-tab' + (t.id===activeId ? ' active' : '') + (t.asleep ? ' asleep' : '');
      el.dataset.tabId = t.id;
      const label = t.title || (isBlank(t.url) ? 'New tab' : t.url);
      const icon = t.loading ? '<span class="nb-spinner"></span>'
        : (t.favicon ? `<img class="nb-favicon" src="${esc(t.favicon)}" onerror="this.style.display='none'">` : '');
      el.innerHTML = icon + `<span class="nb-tab-title">${esc(label)}</span><span class="nb-tab-close" data-close="${esc(t.id)}">×</span>`;
      frag.appendChild(el);
    });
    bar.insertBefore(frag, $('nbNewTab'));
  }

  // Prepara a sessão do perfil sem mexer na visibilidade do painel — é o que
  // permite agentes operarem com o painel escondido. Se o perfil ativo mudou
  // com abas vivas do anterior, fecha as abas antigas de verdade: as
  // partitions são isoladas por perfil e misturar seria bug.
  async function ensureSession(pid) {
    if (activeProfileId != null && activeProfileId !== pid) {
      tabs.slice().forEach(t => closeTab(t.id));
      try { await api().closePanel(activeProfileId); } catch {}
      sess = null; activeProfileId = null;
    }
    if (sess) return sess;
    activeProfileId = pid;
    try { sess = await api().openPanel(pid, { width: parseInt(localStorage.getItem('nb-width') || String(DOCK_DEFAULT), 10) }); }
    catch (e) { sess = null; console.warn('[nb] prepare failed', e); }
    return sess;
  }

  async function togglePanel() {
    const pid = currentProfileId();
    if (pid == null) { alert('No active profile'); return; }
    if (!api()) { console.warn('noryaBrowser API unavailable'); return; }
    if (panel.classList.contains('open')) {
      // Esconder ≠ destruir (2026-07-14): o painel desliza pra fora
      // (translateX) mas as <webview> continuam vivas e compositadas — a
      // sessão de coding não se perde e o capturePage de agente em background
      // segue funcionando. display:none mataria a renderização. Abas só
      // morrem no × individual; storage, só no botão "Limpar dados".
      panel.classList.remove('open');
      painelFechouEm = Date.now();
      document.body.classList.remove('browser-docked');
      afterDockSlide();
      if (typeof window.__railSync === 'function') window.__railSync();
    } else {
      await ensureSession(pid);
      setDockWidth(parseInt(panel.style.width, 10) || parseInt(localStorage.getItem('nb-width') || '', 10) || DOCK_DEFAULT);
      panel.classList.add('open');
      // A ativa pode ter cochilado enquanto o painel estava recolhido.
      { const at = activeTab(); if (at) { acordarAba(at); at.touchedTs = Date.now(); } }
      document.body.classList.add('browser-docked');
      afterDockSlide();
      reapplyEmulation();
      if (typeof window.__railSync === 'function') window.__railSync();
      $('nbProfileName').textContent = 'Profile ' + pid;
      renderTabBar(); refreshNav();
      $('nbAddrInput').focus();
      // Descarrega uma navegação que o usuário enfileirou durante o preparo.
      if (sess && _pendingNav) { const u = _pendingNav; _pendingNav = null; go(u); }
    }
  }

  // Chrome event wiring (named buttons)
  btnBrowser.addEventListener('click', togglePanel);
  $('nbClose').addEventListener('click', togglePanel);
  $('nbFinish').addEventListener('click', () => {
    // Sem confirm quando não há nada aberto: aí "Finalizar" é só recolher.
    if (tabs.length && !window.confirm(`Fechar ${tabs.length} aba(s) e finalizar o navegador?`)) return;
    finalizarNavegador();
  });
  $('nbNewTab').addEventListener('click', () => { createTab('about:blank'); $('nbAddrInput').focus(); });
  $('nbBack').addEventListener('click', () => { const t=activeTab(); try{ t && t.wv.goBack(); }catch{} });
  $('nbForward').addEventListener('click', () => { const t=activeTab(); try{ t && t.wv.goForward(); }catch{} });
  $('nbReload').addEventListener('click', () => { const t=activeTab(); try{ t && t.wv.reload(); }catch{} });
  $('nbAddrInput').addEventListener('keydown', (ev) => { if(ev.key==='Enter') go($('nbAddrInput').value); });
  $('nbTabBar').addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-close]');
    if (c) { ev.stopPropagation(); closeTab(c.dataset.close); return; }
    const el = ev.target.closest('.nb-tab');
    if (el && el.dataset.tabId) setActive(el.dataset.tabId);
  });
  // Resize. O escudo (.nb-resize-shield) entra por cima de TUDO durante o
  // arrasto e sai ao soltar: sem ele, o cursor — que fica colado na borda do
  // painel, logo em cima da <webview> — entregava mousemove e mouseup ao guest
  // fora de processo, e nem o arrasto andava nem o `resizing` voltava a false.
  // Com o escudo no DOM do embedder, os eventos voltam a borbulhar até o window
  // e os listeners abaixo continuam valendo como sempre.
  let resizing = false;
  let escudo = null;
  function montarEscudo() {
    if (escudo) return;
    escudo = document.createElement('div');
    escudo.className = 'nb-resize-shield';
    document.body.appendChild(escudo);
    document.body.classList.add('nb-resizing');
  }
  function desmontarEscudo() {
    if (escudo) { escudo.remove(); escudo = null; }
    document.body.classList.remove('nb-resizing');
  }
  $('nbResize').addEventListener('mousedown', (ev) => {
    ev.preventDefault();          // sem isto o arrasto vira seleção de texto
    resizing = true;
    montarEscudo();
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (ev) => {
    if (!resizing) return;
    // Mínimo 480→360 (2026-08-01): com viewport escalado, 360px ainda mostra um
    // Desktop 1440 legível — 480 era piso de quando largura física = viewport.
    const w = Math.max(DOCK_MIN, Math.min(1200, window.innerWidth - ev.clientX));
    setDockWidth(w);          // move o padding do .app junto, sem esperar o soltar
    refreshScaleLabel();
  });
  window.addEventListener('mouseup', async () => {
    if (!resizing) return;
    resizing = false;
    desmontarEscudo();
    document.body.style.userSelect = '';
    const w = parseInt(panel.style.width, 10);
    localStorage.setItem('nb-width', String(w));
    reapplyEmulation();       // a escala depende da largura útil, que mudou
    try { window.dispatchEvent(new Event('resize')); } catch {}
    if (api()) await api().resizePanelWidth(activeProfileId, w);
  });

  // ── Seletor de device ──────────────────────────────────────────────────────
  (function ligarSeletorDeDevice() {
    const sel = $('nbDevice');
    if (!sel) return;
    for (const p of DEV.PRESETS) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      sel.appendChild(o);
    }
    sel.value = presetId;
    sel.addEventListener('change', () => {
      presetId = sel.value;
      rotated = false;                       // preset novo nasce na orientação natural
      reapplyEmulation();
    });
    $('nbRotate')?.addEventListener('click', () => {
      rotated = !rotated;
      reapplyEmulation();
    });
    refreshScaleLabel();
  })();

  // Settings modal
  $('nbSettings').addEventListener('click', () => { $('nbSettingsModal').style.display = 'flex'; loadSettings(); });
  $('nbSettingsClose').addEventListener('click', () => $('nbSettingsModal').style.display = 'none');
  document.querySelectorAll('.nb-settings-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.nb-settings-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelectorAll('.nb-settings-panel').forEach(p => p.style.display = 'none');
      document.querySelector('.nb-settings-panel[data-panel="' + t.dataset.tab + '"]').style.display = '';
    });
  });

  async function loadSettings() {
    if (!api() || !activeProfileId) return;
    try {
      const list = await api().bookmarksList(activeProfileId) || [];
      $('nbBmList').innerHTML = list.length === 0 ? '<em>(none)</em>' :
        list.map(b => `<div class="nb-bm-row"><strong style="flex:1">${esc(b.title)}</strong><span>${esc(b.url)}</span><button class="header-btn" data-del-bm="${esc(b.id)}">×</button></div>`).join('');
    } catch(e) { $('nbBmList').textContent = 'Error: ' + e.message; }

    $('nbAboutBody').innerHTML = `<div>Perfil ${esc(String(activeProfileId))}</div>
      <div style="color:var(--text-muted); margin-top:8px">
        Sessão isolada por perfil (cookies e storage não vazam entre perfis).<br>
        Trackers e anúncios bloqueados no nível da sessão.<br>
        Sem Tor, sem proxy e sem spoofing de fingerprint.
      </div>`;
  }

  // Limpar dados do perfil — único caminho de wipe de cookies/storage desde
  // 2026-07-14 (fechar painel/app preserva tudo).
  $('nbClearData').addEventListener('click', async () => {
    if (!api() || activeProfileId == null) return;
    const s = $('nbClearDataStatus');
    s.textContent = 'Limpando…';
    try { await api().clearData(activeProfileId); s.textContent = 'Dados limpos ✓'; }
    catch (e) { s.textContent = 'Erro: ' + e.message; }
  });

  // Settings interactions
  $('nbSettingsModal').addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.dataset.delBm) {
      await api().bookmarksRemove(activeProfileId, t.dataset.delBm);
      loadSettings();
    }
  });

  // Login choice modal
  window.noryaShowLoginChoice = async function(profileId, profileName, onPick) {
    if (api()) {
      const remembered = await api().getLoginBrowserChoice(profileId);
      if (remembered) { onPick(remembered); return; }
    }
    $('nbLoginProfileName').textContent = profileName || ('#' + profileId);
    $('nbLoginModal').style.display = 'flex';
    const cancel = () => { $('nbLoginModal').style.display = 'none'; cleanup(); };
    const cont = async () => {
      const choice = document.querySelector('input[name="nbLoginBrowser"]:checked').value;
      const remember = $('nbLoginRemember').checked;
      if (remember && api()) await api().setLoginBrowserChoice(profileId, choice, true);
      $('nbLoginModal').style.display = 'none';
      cleanup();
      onPick(choice);
    };
    $('nbLoginCancel').addEventListener('click', cancel, { once: true });
    $('nbLoginContinue').addEventListener('click', cont, { once: true });
    function cleanup() { /* no-op, once:true cleans handlers */ }
  };

  // Subscribe to main → renderer events (auth flow)
  function trySubscribe() {
    if (!api() || typeof api().on !== 'function') return false;
    api().on('auth-url', async ({ profileId, url }) => {
      // [authurl-debug] pure diagnostics — behavior below is UNCHANGED.
      const _dbg = (m, x) => { try { ipcRenderer.send('renderer-log', { level: 'authurl', args: [m, JSON.stringify(x || {})] }); } catch {} };
      let _curPid = null; try { _curPid = currentProfileId(); } catch (e) { _curPid = 'ERR:' + e.message; }
      _dbg('received', { profileId, url: String(url).slice(0, 70), panelOpen: panel.classList.contains('open'), currentProfileId: _curPid, hasSess: !!sess });
      try {
        if (!panel.classList.contains('open')) await togglePanel();
        _dbg('after-togglePanel', { panelOpen: panel.classList.contains('open'), hasSess: !!sess });
        if (sess) { createTab(url); _dbg('createTab-called', {}); }   // open OAuth URL in a fresh tab
        else _dbg('SKIPPED-createTab (sess falsy)', {});
      } catch (e) { _dbg('handler-threw', { err: String(e && e.message || e) }); }
    });
    api().on('auth-complete', () => { /* leave the tab so the user sees the result */ });
    return true;
  }
  if (!trySubscribe()) {
    let tries = 0;
    const interval = setInterval(() => { if (trySubscribe() || ++tries > 20) clearInterval(interval); }, 250);
  }

  // ── Agent control bridge (MCP/CLI → renderer webviews) ──────────────────────
  ipcRenderer.on('norya-browser-agent', async (_e, { reqId, action, payload }) => {
    const reply = (ok, result, error) => ipcRenderer.send('norya-browser-agent-reply', { reqId, ok, result, error });
    try { reply(true, await handleAgent(action, payload || {})); }
    catch (err) { reply(false, null, (err && err.message) || String(err)); }
  });
  // `tor` saiu do snapshot em 2026-07-10: o Tor foi removido e `sess.torOk` não
  // existe mais — o campo era sempre false, mentindo para o agente que lê isto.
  function tabSnap(t){ return { id:t.id, url:t.url, title:t.title, active:t.id===activeId, agentControlled:t.by==='agent', mode:'normal' }; }
  async function handleAgent(action, p) {
    if (action === 'list-tabs') return tabs.map(tabSnap);
    if (action === 'open-tab') {
      // Agente trabalha em background (decisão 2026-07-14): prepara a sessão
      // se preciso, mas NÃO mostra o painel. O usuário abre com Cmd+B quando quiser.
      const pid = currentProfileId();
      if (pid != null && !sess) await ensureSession(pid);
      // `by:'user'` chega do shim de `open <url>` no PTY (main.js): aquilo é
      // intenção do usuário — muitas vezes um login OAuth no meio — e não pode
      // evaporar na faxina de 5 min.
      const t = createTab(p.url || 'about:blank', { by: p.by === 'user' ? 'user' : 'agent' });
      return { tabId: t ? t.id : null };
    }
    if (action === 'close-tab') { closeTab(p.tabId); return { ok:true }; }
    // Fim de uso declarado pelo agente (browser_finish): fecha o que ELE abriu
    // e não encosta nas abas do usuário.
    if (action === 'finish') { return { closed: closeTabsWhere(t => t.by === 'agent') }; }
    if (action === 'set-active-tab') { touchTab(tabById(p.tabId)); setActive(p.tabId); return { ok:true }; }
    if (action === 'navigate-tab') { const t = p.tabId ? tabById(p.tabId) : activeTab(); if(!t) throw new Error('no tab'); touchTab(t); return await doTabAction(t, p.action, p.params||{}); }
    throw new Error('unknown agent action: ' + action);
  }
  function doTabAction(t, act, params) {
    // O agente pode mirar uma aba que cochilou (navigate-tab com tabId antigo).
    // Acordar aqui é o que mantém a promessa: o id da aba continua válido
    // mesmo que a <webview> por trás dele tenha sido reciclada.
    acordarAba(t);
    const wv = t.wv; const sel = params.selector;
    switch (act) {
      case 'open': go(params.url); return Promise.resolve({ ok:true });
      case 'back': try{wv.goBack();}catch{} return Promise.resolve({ ok:true });
      case 'forward': try{wv.goForward();}catch{} return Promise.resolve({ ok:true });
      case 'reload': try{wv.reload();}catch{} return Promise.resolve({ ok:true });
      case 'screenshot': {
        // Painel escondido = webview fora da tela = o compositor não produz
        // frame e o capturePage NUNCA resolve (verificado 2026-07-14 no smoke).
        // Reencosta o painel invisível (opacity 0, sem pointer events, sem
        // animação) só durante a captura — o usuário não vê nada.
        const hiddenPanel = !panel.classList.contains('open');
        if (hiddenPanel) {
          // `nb-capturando` é a ÚNICA exceção à regra de CSS que despinta as
          // <webview> com o painel recolhido. Sem ela o guest fica em
          // display:none, nunca produz frame, e o capturePage pendura pra
          // sempre — o mesmo sintoma de 2026-07-14, por outra causa.
          panel.classList.add('nb-capturando');
          panel.style.transition = 'none';
          panel.style.transform = 'translateX(0)';
          panel.style.opacity = '0';
          panel.style.pointerEvents = 'none';
        }
        const unhide = () => {
          if (!hiddenPanel) return;
          panel.classList.remove('nb-capturando');
          panel.style.transform = ''; panel.style.opacity = '';
          panel.style.pointerEvents = ''; panel.style.transition = '';
        };
        const waitFrame = hiddenPanel ? new Promise(r => setTimeout(r, 250)) : Promise.resolve();
        return waitFrame
          .then(() => Promise.race([
            wv.capturePage(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout (webview sem frame)')), 8000)),
          ]))
          // Com emulação ativa a captura sai no tamanho EMULADO, não no físico
          // do painel — por isso o tamanho vai explícito no retorno, em vez de
          // o agente ter que adivinhar o que recebeu.
          .then(img => { const fmt=params.format==='jpeg'?'jpeg':'png'; const buf=fmt==='jpeg'?img.toJPEG(90):img.toPNG(); const out=_shotPath('norya-shot-'+t.id+'-'+Date.now()+'.'+fmt); if(_fs)_fs.writeFileSync(out,buf); const sz=img.getSize(); return { path: out, width: sz.width, height: sz.height }; })
          .finally(unhide);
      }
      case 'get_dom': return wv.executeJavaScript(sel?`(document.querySelector(${JSON.stringify(sel)})||{}).outerHTML||""`:'document.documentElement.outerHTML').then(html=>({html}));
      case 'get_text': return wv.executeJavaScript(sel?`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||""`:'document.body.innerText').then(text=>({text}));
      case 'click': return wv.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('not found');e.scrollIntoView({block:'center'});e.click();return true;})()`).then(()=>({ok:true}));
      case 'type': return wv.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('not found');e.focus();e.value=${JSON.stringify(String(params.text||''))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));${params.submit?'if(e.form)e.form.requestSubmit();':''}return true;})()`).then(()=>({ok:true}));
      case 'evaluate': return wv.executeJavaScript(String(params.js||'')).then(r=>({result:r}));
      case 'wait_for': { const timeout=params.timeout_ms||10000, start=Date.now(); return new Promise((res,rej)=>{ const poll=()=>{ wv.executeJavaScript(`!!document.querySelector(${JSON.stringify(sel)})`).then(f=>{ if(f)return res({ok:true}); if(Date.now()-start>timeout)return rej(new Error('wait_for timeout: '+sel)); setTimeout(poll,200); }).catch(()=>{ if(Date.now()-start>timeout)rej(new Error('wait_for timeout')); else setTimeout(poll,200); }); }; poll(); }); }
      case 'console_logs': return Promise.resolve((t.consoleLog||[]).filter(e=>!params.since_ts||e.ts>=params.since_ts));
      case 'network_log': return Promise.resolve([]);
      // Até 2026-08-01 isto era `setZoomFactor(1)` — um no-op que ignorava
      // width/height e devolvia ok:true. Agora usa o MESMO motor do seletor
      // humano: uma implementação, dois consumidores. Sem width → responsivo.
      case 'set_viewport': {
        const p = DEV.viewportParams(params, dockContentWidth());
        return applyEmulation(t, p).then(() => ({
          ok: true,
          viewport: p ? { width: p.viewSize.width, height: p.viewSize.height } : null,
        }));
      }
      default: throw new Error('unknown action: ' + act);
    }
  }

  // Keyboard shortcuts
  window.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey || ev.ctrlKey)) return;
    if (ev.key === 'b') { ev.preventDefault(); togglePanel(); return; }
    // ⌘⇧W finaliza mesmo com o painel escondido — que é justamente quando as
    // abas de agente se acumulam sem ninguém ver. (Com shift, ev.key vem 'W'.)
    if (ev.shiftKey && (ev.key === 'w' || ev.key === 'W')) { ev.preventDefault(); finalizarNavegador(); return; }
    if (!panel.classList.contains('open')) return;
    if (ev.key === 't') { ev.preventDefault(); $('nbNewTab').click(); }
    else if (ev.key === 'l') { ev.preventDefault(); $('nbAddrInput').focus(); $('nbAddrInput').select(); }
    else if (ev.key === 'r') { ev.preventDefault(); $('nbReload').click(); }
    else if (ev.key === 'w') { ev.preventDefault(); if (activeId) closeTab(activeId); }
    else if (ev.key === '[') { $('nbBack').click(); }
    else if (ev.key === ']') { $('nbForward').click(); }
  });

})();
