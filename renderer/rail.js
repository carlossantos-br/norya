/**
 * renderer/rail.js — nav da sidebar + painel "Uso das assinaturas".
 *
 * Script CLÁSSICO (ver renderer/state.js): lê os globais `st`, `api` e as
 * funções do script inline (`setSidebarCollapsed`, `openSettings`) sem import.
 *
 * ── Painel Uso: uma seção por CONTA, um cartão por PROVIDER (2026-09-08) ────
 *
 *   ● trabalho                                ↻
 *     Codex · Plus                            ↻
 *     conta@…
 *       Janela de 5h   0%  ▏ reseta 16:34
 *       Semanal        0%  ▏ reseta em 7d
 *       3 resets grátis disponíveis
 *   ● pessoal                                 ↻
 *     Claude · Max 5x                         ↻
 *     conta do Mac
 *       Sessão (5h)  … Semana · todos … Semana · Fable …
 *
 * Quais providers cada conta mostra vem do main.js (`acc.quotaProviders`,
 * regra em agents/providers.js). O snapshot de cada cartão mora em
 * `st.quota["<num>:<provider>"]`; a chave legada `st.quota["<num>"]` é o
 * espelho do provider padrão (health badge, pickers) e serve de fallback
 * até a primeira leitura pós-upgrade preencher as compostas.
 *
 * O painel é deliberadamente HONESTO. Estado dos números:
 *
 *   fresh     lido há < 15 min        barra em cor plena
 *   stale     mais velho              barra esmaecida, "há 2h · desatualizado"
 *   unknown   nunca observado         "sem dado" — nunca 0% inventado
 *   error     última leitura falhou   mantém as barras antigas + aviso
 *
 * A única evidência de dado real é `windows` (ou `primary`/`secondary`).
 *
 * Realidade de cada assinatura (2026-09-08):
 *   Codex   — `codex app-server` → rateLimits + account/read. Automático.
 *   Claude  — endpoint do próprio /usage (quota/claude-http.js). Automático,
 *             barato. TUI escondida só quando o token é recusado.
 *   Grok    — só o slash command /usage numa TUI. Sob demanda (↻).
 */
'use strict';

(() => {
  const FRESH_MS = 15 * 60 * 1000;
  const STALE_ON_OPEN_MS = 2 * 60 * 1000;     // ao abrir o painel, relê o que passou disto
  const OPEN_REFRESH_GAP_MS = 60 * 1000;      // …mas não a cada clique
  const $ = id => document.getElementById(id);

  // Espelha agents/registry.js (id → rótulo curto do painel) e o mapa
  // authMode → provider do QuotaManager. Some quando a Fase 3 migrar para agentId.
  const PROVIDER_LABEL = { codex: 'Codex', claude: 'Claude', grok: 'Grok' };
  const PROVIDER_BY_AUTH = { chatgpt: 'codex', apikey: 'codex', claude: 'claude', grok: 'grok' };

  // ── Formatação ───────────────────────────────────────────────────────────
  const pct = n => `${Math.round(n)}%`;

  function idade(ms) {
    if (!ms) return 'sem dado';
    const s = Math.max(0, Date.now() - ms) / 1000;
    if (s < 90) return 'agora';
    if (s < 3600) return `há ${Math.round(s / 60)}min`;
    if (s < 86400) return `há ${Math.round(s / 3600)}h`;
    return `há ${Math.round(s / 86400)}d`;
  }

  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  function resetEm(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const falta = ms - Date.now();
    if (falta <= 0) return 'reseta a qualquer momento';
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (falta < 12 * 3600e3) return `reseta ${hhmm}`;
    // Data curta com hora: "reseta 9 set 16:00" — é o que a API dá, sem arredondar em dias.
    return `reseta ${d.getDate()} ${MESES[d.getMonth()]} ${hhmm}`;
  }

  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;   // textContent: nome de perfil e e-mail são dados do usuário
    return n;
  };

  function dinheiro(v, currency, decimals) {
    if (v == null) return null;
    const dec = typeof decimals === 'number' ? decimals : 2;
    const num = Number(v) / Math.pow(10, dec);
    return `${currency || ''} ${num.toFixed(dec)}`.trim();
  }

  // ── Estado honesto de um snapshot ────────────────────────────────────────
  function janelas(q) {
    if (!q) return [];
    if (Array.isArray(q.windows) && q.windows.length) return q.windows;
    // Snapshot antigo (pré-2026-09-08) só tem primary/secondary.
    return [
      q.primary && { ...q.primary, id: 'session', label: q.cli === 'claude' ? 'Sessão (5h)' : 'Janela de 5h' },
      q.secondary && { ...q.secondary, id: 'weekly', label: q.cli === 'claude' ? 'Semana · todos os modelos' : 'Semanal' },
    ].filter(Boolean);
  }

  function lidoEm(q) { return q ? (q.readAt || q.updatedAt || 0) : 0; }

  function estado(q) {
    if (!q) return 'unknown';
    if (q.loggedOut) return 'logged-out';
    if (q.noCredit) return 'no-credit';
    if (!janelas(q).length) return q.errorKind ? 'error' : 'unknown';
    return (Date.now() - lidoEm(q)) < FRESH_MS ? 'fresh' : 'stale';
  }

  function snapshotDe(acc, provider) {
    const composta = st.quota[`${acc.num}:${provider}`];
    if (composta) return composta;
    // Fallback: espelho legado, só se for o provider padrão da conta.
    if (PROVIDER_BY_AUTH[acc.authMode] === provider) return st.quota[String(acc.num)] || null;
    return null;
  }

  function barra(w) {
    const wrap = el('div', 'uso-window');
    const head = el('div', 'uso-window-label');
    head.appendChild(el('span', null, w.label || w.id || 'Janela'));
    head.appendChild(el('b', null, pct(w.used_percent)));
    wrap.appendChild(head);

    const bar = el('div', 'uso-bar');
    const fill = document.createElement('i');
    const u = w.used_percent;
    fill.style.width = `${Math.min(100, Math.max(0, u))}%`;
    // A severidade da API (Claude) manda; senão, o percentual.
    if (w.severity === 'critical' || u >= 90) fill.className = 'danger';
    else if (w.severity === 'warning' || u >= 70) fill.className = 'warn';
    bar.appendChild(fill);
    wrap.appendChild(bar);

    const r = resetEm(w.resets_at_ms);
    if (r) wrap.appendChild(el('div', 'uso-sub', r));
    return wrap;
  }

  function botaoRefresh(title, onClick) {
    const btn = el('button', 'uso-refresh', '↻');
    btn.type = 'button';
    btn.title = title;
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      btn.classList.add('spinning');
      try { await onClick(); } catch (e) { console.warn('uso refresh', e); }
      btn.classList.remove('spinning');
      render();
    });
    return btn;
  }

  // ── Cartão de um provider dentro da conta ────────────────────────────────
  function cartaoProvider(acc, provider) {
    const q = snapshotDe(acc, provider);
    const s = estado(q);
    const agente = agentesDetectados.find(a => a.id === provider);

    const card = el('div', 'uso-card' + (s === 'unknown' ? ' is-unknown' : ''));
    const head = el('div', 'uso-head');
    const titulo = [PROVIDER_LABEL[provider] || provider];
    if (q && q.planLabel) titulo.push(q.planLabel);
    head.appendChild(el('span', 'uso-agent', titulo.join(' · ')));
    head.appendChild(botaoRefresh(
      provider === 'grok' ? 'Ler o uso agora (abre uma sessão escondida do grok)' : 'Ler o uso agora',
      () => api.quotaRefresh(acc.num, provider)));
    card.appendChild(head);
    // Identidade em linha própria: e-mail não cabe no título de 228px.
    if (q && q.identity) card.appendChild(el('div', 'uso-meta', q.identity));

    if (agente && agente.installed === false) {
      card.appendChild(el('div', 'uso-empty', 'CLI não instalada.'));
      if (agente.install) card.appendChild(el('div', 'uso-install', agente.install));
      return card;
    }
    if (s === 'logged-out') {
      card.appendChild(el('div', 'uso-empty', 'Sessão expirada — faça login neste perfil.'));
      if (provider === 'claude' && !acc.hasClaudeToken) {
        card.appendChild(el('div', 'uso-empty', 'Abra um pane do Claude e rode /login.'));
      } else if (agente && agente.login) {
        card.appendChild(el('div', 'uso-install', agente.login));
      }
      return card;
    }
    if (s === 'no-credit') {
      card.appendChild(el('div', 'uso-empty', 'Sem crédito nesta conta.'));
      return card;
    }
    if (s === 'unknown') {
      card.appendChild(el('div', 'uso-empty', provider === 'grok'
        ? 'Sem dado. Clique em ↻ — o Grok só responde pelo /usage de uma sessão.'
        : 'Ainda não lido. Atualiza sozinho em instantes.'));
      return card;
    }
    if (s === 'error') {
      card.appendChild(el('div', 'uso-empty', 'Falhou: ' + (q.errorDetail || q.errorKind || 'erro desconhecido') + '. Sem dado.'));
      return card;
    }

    // fresh / stale — com barras. Falha recente NÃO apaga a última leitura boa.
    const sub = [idade(lidoEm(q))];
    if (s === 'stale') sub.push('desatualizado');
    if (q.errorKind && q.errorKind !== 'auth') sub.push('última tentativa falhou (' + (q.errorDetail || q.errorKind) + ')');
    card.appendChild(el('div', 'uso-sub' + (s === 'stale' ? ' is-stale' : ''), sub.join(' · ')));
    for (const w of janelas(q)) card.appendChild(barra(w));

    // Extras que a API dá e valem dinheiro/tempo:
    if (provider === 'codex') {
      if (typeof q.resetCredits === 'number' && q.resetCredits > 0) {
        card.appendChild(el('div', 'uso-line good',
          `${q.resetCredits} reset${q.resetCredits > 1 ? 's' : ''} grátis disponíve${q.resetCredits > 1 ? 'is' : 'l'} (semanal + 5h)`));
      }
      if (q.credits && q.credits.hasCredits) {
        card.appendChild(el('div', 'uso-line', q.credits.unlimited ? 'Créditos: ilimitados' : `Créditos: ${q.credits.balance}`));
      }
    }
    if (provider === 'claude' && q.extraUsage && q.extraUsage.enabled) {
      const usado = dinheiro(q.extraUsage.used, q.extraUsage.currency, q.extraUsage.decimals);
      const limite = dinheiro(q.extraUsage.limit, q.extraUsage.currency, q.extraUsage.decimals);
      card.appendChild(el('div', 'uso-line', `Uso extra: ${usado || '?'}${limite ? ' de ' + limite : ''} no mês`));
    }
    return card;
  }

  // ── Seção de uma conta ───────────────────────────────────────────────────
  function secaoConta(acc) {
    const sec = el('div', 'uso-account');
    const head = el('div', 'uso-account-head');
    const dot = el('span', 'uso-dot');
    if (acc.color) dot.style.background = acc.color;
    head.appendChild(dot);
    head.appendChild(el('span', 'uso-account-name', acc.name || `Perfil ${acc.num}`));
    head.appendChild(botaoRefresh('Ler o uso de todos os providers desta conta', () => api.quotaRefresh(acc.num)));
    sec.appendChild(head);
    for (const p of acc.quotaProviders) sec.appendChild(cartaoProvider(acc, p));
    return sec;
  }

  // ── Cartão de agente sem perfil / não instalado ──────────────────────────
  function cartaoAusente(agente) {
    const card = el('div', 'uso-card is-missing');
    const head = el('div', 'uso-head');
    head.appendChild(el('span', 'uso-dot'));
    head.appendChild(el('span', 'uso-agent', `${agente.label}${agente.subscription ? ' · ' + agente.subscription : ''}`));
    card.appendChild(head);
    card.appendChild(el('div', 'uso-empty', agente.installed
      ? 'CLI instalada, mas nenhum perfil está conectado a este agente.'
      : 'CLI não instalada.'));
    if (!agente.installed && agente.install) card.appendChild(el('div', 'uso-install', agente.install));
    return card;
  }

  // ── Render do painel ─────────────────────────────────────────────────────
  let agentesDetectados = [];

  function contasMedidas() {
    return (st.accounts || []).filter(acc => Array.isArray(acc.quotaProviders) && acc.quotaProviders.length);
  }

  function render() {
    const lista = $('usoList');
    if (!lista) return;
    lista.textContent = '';

    lista.appendChild(el('div', 'uso-note',
      'Codex e Claude atualizam sozinhos. Grok só pelo ↻ (abre uma sessão escondida).'));

    const usados = new Set();
    for (const acc of contasMedidas()) {
      acc.quotaProviders.forEach(p => usados.add(p));
      lista.appendChild(secaoConta(acc));
    }

    for (const a of agentesDetectados) {
      if (!a.subscription || usados.has(a.id)) continue;   // Aider/OpenCode: sem assinatura a medir
      lista.appendChild(cartaoAusente(a));
    }

    atualizarPontoDeAlerta();
  }

  // Ao abrir o painel: relê o que está velho (Codex/Claude são baratos; Grok
  // não — fica no ↻). Os eventos 'quota-updated' re-renderizam sozinhos.
  let ultimoRefreshAoAbrir = 0;
  function atualizarVelhosAoAbrir() {
    if (Date.now() - ultimoRefreshAoAbrir < OPEN_REFRESH_GAP_MS) return;
    ultimoRefreshAoAbrir = Date.now();
    for (const acc of contasMedidas()) {
      for (const p of acc.quotaProviders) {
        if (p === 'grok') continue;
        const q = snapshotDe(acc, p);
        if (q && q.loggedOut) continue;   // breaker do main cuida; não martelar login
        if (!q || (Date.now() - lidoEm(q)) > STALE_ON_OPEN_MS) {
          api.quotaRefresh(acc.num, p).catch(() => {});
        }
      }
    }
  }

  function atualizarPontoDeAlerta() {
    const dot = $('railUsoDot');
    if (!dot) return;
    const alerta = contasMedidas().some(acc => acc.quotaProviders.some(p => {
      const q = snapshotDe(acc, p);
      if (!q) return false;
      if (q.loggedOut || q.noCredit) return true;
      const js = janelas(q);
      return js.length > 0 && Math.max(...js.map(w => w.used_percent)) >= 90;
    }));
    dot.hidden = !alerta;
  }

  // ── Rail ─────────────────────────────────────────────────────────────────
  const PAINEIS = { threads: 'panelThreads', uso: 'panelUso' };
  let painelAtual = 'threads';

  function abrirPainel(nome) {
    const recolhida = document.body.classList.contains('sidebar-collapsed');
    // Clicar no painel JÁ ativo não recolhe mais (2026-09-07): a nav mora
    // DENTRO da sidebar — recolher por aqui sumiria com o próprio botão. O
    // toggle é #sidebarToggle na barra da sidebar (e ⌘.).
    if (nome === painelAtual) {
      if (recolhida) setSidebarCollapsed(false);
      sincronizarRail();
      return;
    }
    painelAtual = nome;
    for (const [k, id] of Object.entries(PAINEIS)) {
      const p = $(id);
      if (p) p.hidden = (k !== nome);
    }
    if (recolhida) setSidebarCollapsed(false);
    if (nome === 'uso') { render(); atualizarVelhosAoAbrir(); }
    sincronizarRail();
  }

  /**
   * Active-state do rail. Há dois tipos de botão:
   *   • PAINÉIS (Threads, Uso) — um ativo por vez; reflete `painelAtual`.
   *   • MODO Browser — liga/desliga; reflete o estado REAL do painel, não o
   *     último clique (fechar o navegador fora do rail também apaga o anel).
   *   • Config é ação momentânea (abre o modal), nunca fica "ativo".
   * (O botão Grid saiu em 2026-07-10: a grid virou a única view.)
   * browser.js chama window.__railSync ao mudar de estado.
   */
  function sincronizarRail() {
    const browserOn = !!$('noryaBrowserPanel')?.classList.contains('open');
    document.querySelectorAll('.rail-btn[data-rail]').forEach(b => {
      const r = b.dataset.rail;
      let on = false;
      if (r === 'threads' || r === 'uso') on = (r === painelAtual);
      else if (r === 'browser') on = browserOn;
      else if (r === 'skills') on = !!$('skillsDialog')?.open;
      b.classList.toggle('active', on);
    });
  }

  function ligarRail() {
    $('railThreads')?.addEventListener('click', () => abrirPainel('threads'));
    $('railUso')?.addEventListener('click', () => abrirPainel('uso'));

    // Navegador: o handler vive em browser.js, preso a #btnNoryaBrowser (agora
    // hidden, só como âncora). Clicá-lo é o caminho de menor risco; o painel
    // anima ~220 ms até ganhar `.open`, daí o sync atrasado.
    $('railBrowser')?.addEventListener('click', () => {
      $('btnNoryaBrowser')?.click();
      setTimeout(sincronizarRail, 280);
    });
    // Config abre o modal direto — openSettings é global.
    $('railConfig')?.addEventListener('click', () => {
      if (typeof openSettings === 'function') openSettings('general');
    });

    $('usoRefreshAll')?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      b.classList.add('spinning');
      try { await api.quotaRefreshAll(); } catch (e) { console.warn('quotaRefreshAll', e); }
      b.classList.remove('spinning');
      render();
    });

    // Boot ≠ clique do usuário: abrirPainel('threads') cairia no branch de
    // toggle (painelAtual já nasce 'threads') e inverteria o colapso que o
    // modals.js acabou de restaurar em silêncio — animação no primeiro frame
    // e localStorage sobrescrito, alternando a cada launch. Aqui só se mostra
    // o painel inicial, sem tocar na sidebar nem persistir nada.
    for (const [k, id] of Object.entries(PAINEIS)) {
      const p = $(id);
      if (p) p.hidden = (k !== painelAtual);
    }
    sincronizarRail();
  }

  async function boot() {
    ligarRail();
    // Observador: grid.js e browser.js chamam isto ao mudar de estado, para o
    // anel do rail refletir grid/browser mesmo quando alternados fora do rail
    // (⌘G, clicar numa thread para sair do grid, fechar o painel do navegador).
    window.__railSync = sincronizarRail;
    sincronizarRail();
    try { agentesDetectados = await api.detectAgents(); } catch (e) { console.warn('detectAgents', e); }
    // Um segundo listener de 'quota-updated' é seguro: o inline tem o seu.
    require('electron').ipcRenderer.on('quota-updated', () => {
      atualizarPontoDeAlerta();
      if (painelAtual === 'uso') render();
    });
    atualizarPontoDeAlerta();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
