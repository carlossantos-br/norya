/**
 * renderer/settings.js — quota, modal de settings, estatísticas, merge queue.
 *
 * Script CLÁSSICO (ver renderer/state.js): fatia contígua extraída de
 * test-window.html em 2026-07-10, na ordem original. Compartilha o escopo
 * léxico global com os outros — `st`, `api`, `ipcRenderer` e as funções de
 * cada fatia enxergam-se sem import. Ordem de carga preservada = zero mudança
 * de comportamento.
 */
'use strict';

// ── Quota ─────────────────────────────────────────────────────────────────────
async function refreshAccQuota(num) {
  const dot = document.querySelector(`.acc-dot[data-dot="${num}"]`);
  if (dot) dot.classList.add('loading');
  try {
    await api.quotaRefresh(num);
    const cache = await api.quotaGet();
    if (cache) Object.assign(st.quota, cache);
    renderAccountItem(num);
  } finally {
    if (dot) dot.classList.remove('loading');
  }
}

// ── Settings modal ─────────────────────────────────────────────────────────────

function openSettings(tab) {
  if (tab === 'skills') { window.openSkills?.(); return; }
  document.getElementById('modalSettings').classList.remove('hidden');
  switchSettingsTab(tab || 'general');
}

const TAB_TITLES = { general: 'General', profiles: 'Profiles', stats: 'Estatísticas' };
const TAB_IDS = { general: 'tabGeneral', profiles: 'tabProfiles', stats: 'tabStats' };

function switchSettingsTab(tab) {
  document.querySelectorAll('.snav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.stab-pane').forEach(p => p.classList.toggle('active', p.id === TAB_IDS[tab]));
  const titleEl = document.getElementById('settingsContentTitle');
  if (titleEl) titleEl.textContent = TAB_TITLES[tab] || tab;
  if (tab === 'profiles') renderProfilesTab();
  if (tab === 'stats') loadStats();
}

function openMergeQueueModal() {
  document.getElementById('modalMergeQueue').classList.remove('hidden');
  switchMergeTab('queue');
  loadMergeQueueTab();
}
document.getElementById('btnMergeQueue').addEventListener('click', openMergeQueueModal);
document.getElementById('btnMqClose').addEventListener('click', () => {
  document.getElementById('modalMergeQueue').classList.add('hidden');
});

document.querySelectorAll('.snav-item').forEach(btn => {
  btn.addEventListener('click', () => switchSettingsTab(btn.dataset.tab));
});

// Collapse / expand the accounts section
(function() {
  const collapsedKey = 'norya-accounts-collapsed';
  const bar = document.getElementById('accountsBar');
  const header = document.getElementById('accountsHeader');
  if (localStorage.getItem(collapsedKey) === '1') bar.classList.add('collapsed');
  header.addEventListener('click', e => {
    // Ignore clicks on the + button so it can still open the add modal
    if (e.target.closest('#btnAddAcc')) return;
    bar.classList.toggle('collapsed');
    localStorage.setItem(collapsedKey, bar.classList.contains('collapsed') ? '1' : '0');
  });
})();

// O botão Settings do rodapé foi removido em 2026-07-10 (vive no rail ⚙ Config).
// openSettings é global; rail.js e a paleta ⌘K chamam direto. Nada a religar aqui.

// ── Log viewer wiring ─────────────────────────────────────────────────────────
function openLogs() {
  document.getElementById('logsDock').classList.remove('hidden');
  document.body.classList.add('logs-open');
  _norya_renderLogs();
}
function closeLogs() {
  document.getElementById('logsDock').classList.add('hidden');
  document.body.classList.remove('logs-open');
}
document.getElementById('btnLogs').addEventListener('click', openLogs);

// Tela sempre acesa (chave do header; o main guarda em norya-state.json).
(() => {
  const btn = document.getElementById('btnKeepAwake');
  if (!btn) return;
  const paint = (on) => {
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Tela sempre acesa: ligada (clique para desligar)' : 'Tela sempre acesa: desligada (clique para ligar)';
  };
  ipcRenderer.invoke('keep-awake-get').then(paint).catch(() => {});
  btn.addEventListener('click', async () => {
    paint(await ipcRenderer.invoke('keep-awake-set', !btn.classList.contains('is-on')));
  });
})();
document.getElementById('btnLogsClose').addEventListener('click', closeLogs);
document.getElementById('btnLogsClear').addEventListener('click', () => {
  _norya_logs.length = 0; _norya_renderLogs();
});
document.getElementById('btnLogsCopy').addEventListener('click', () => {
  try { navigator.clipboard.writeText(_norya_logs.join('\n')); } catch {}
});
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    const dock = document.getElementById('logsDock');
    if (dock.classList.contains('hidden')) openLogs(); else closeLogs();
  }
});
// Receive main-process logs into the in-app viewer
ipcRenderer.on('norya-log', (_, payload) => {
  _norya_pushLog('main', [`${payload.tag}:`, payload.msg]);
});

console.log(kc('Norya boot · log viewer ready (open with ⌘L or the Logs button)'));
document.getElementById('btnSettingsClose').addEventListener('click', () => {
  document.getElementById('modalSettings').classList.add('hidden');
});

// Dark mode toggle
document.getElementById('darkModeToggle').addEventListener('change', function() {
  const dark = this.checked;
  st.settings.theme = dark ? 'dark' : 'light';
  localStorage.setItem('norya-theme', st.settings.theme);
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  // O material do vidro (vibrancy/mica) é da janela e segue o nativeTheme —
  // precisa acompanhar o tema do Norya, senão a tinta fica lamacenta.
  try { api.setNativeTheme(st.settings.theme); } catch {}
  if (typeof noryaRethemeTerminals === 'function') noryaRethemeTerminals();
});
// Boot: alinha o material da janela ao tema salvo antes do primeiro pane.
try { api.setNativeTheme(st.settings.theme); } catch {}

// ── Mini / pet (2026-10-05) ──────────────────────────────────────────────────
// Mesmo norya-state.json do vidro, mas vale NA HORA: o main repassa ao
// pet-manager no save (sem restart). "Fechar Mini" no clique direito do próprio
// pet grava `pet:false` e avisa por `pet-enabled` pra chave acompanhar.
// Chaves: pet (Mini aberto), petKind auto|codex|clawd|none, petSize 80–224,
// petVisibility always|onDemand.
(function ligarControlesDoMini() {
  const cb = document.getElementById('petToggle');
  if (!cb) return;
  const opts = document.getElementById('petOptions');
  // O Mini é um helper nativo de macOS (platform.supportsPet): fora dele a
  // chave não faria nada — some a seção inteira.
  let suporta = true;
  try { suporta = require('./platform').supportsPet !== false; } catch {}
  if (!suporta) {
    const linha = cb.closest('.setting-row');
    if (linha) linha.style.display = 'none';
    if (opts) opts.style.display = 'none';
    return;
  }
  const kindSeg = document.getElementById('petKindSeg');
  const visSeg = document.getElementById('petVisSeg');
  const size = document.getElementById('petSize');
  const reset = document.getElementById('petSizeReset');
  const visDesc = document.getElementById('petVisDesc');
  const VIS_DESC = {
    always: 'Keep your Mini on your desktop',
    onDemand: 'Show with ⌃⌥Space. Hide when you click away.',
  };
  const PADRAO = { petKind: 'auto', petSize: 112, petVisibility: 'always' };

  const marcar = (seg, v) => {
    if (!seg) return;
    for (const b of seg.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.dataset.v === v);
  };
  const aplicar = (e) => {
    e = e || {};
    cb.checked = e.pet !== false;
    if (opts) opts.hidden = !cb.checked;
    const kind = ['auto', 'codex', 'clawd', 'none'].includes(e.petKind) ? e.petKind : PADRAO.petKind;
    const vis = e.petVisibility === 'onDemand' ? 'onDemand' : 'always';
    const sz = Number.isFinite(e.petSize) ? Math.min(224, Math.max(80, Math.round(e.petSize))) : PADRAO.petSize;
    marcar(kindSeg, kind); marcar(visSeg, vis);
    if (size) size.value = String(sz);
    if (visDesc) visDesc.textContent = VIS_DESC[vis];
  };
  const salvar = (patch, desfazer) => api.noryaStateSave(patch)
    .then(r => { if (r && r.error) throw new Error(r.error); return r; })
    .catch(e => {
      if (desfazer) desfazer();
      if (typeof window.noryaToast === 'function') {
        window.noryaToast('Não deu pra salvar a preferência: ' + (e.message || e), 'error');
      }
    });
  const recarregar = () => api.noryaStateGet().then(aplicar).catch(() => aplicar({}));

  recarregar();
  require('electron').ipcRenderer.on('pet-enabled', (_, on) => { cb.checked = on !== false; if (opts) opts.hidden = !cb.checked; });
  cb.addEventListener('change', function () {
    const ligado = this.checked;
    if (opts) opts.hidden = !ligado;
    salvar({ pet: ligado }, () => { this.checked = !ligado; if (opts) opts.hidden = ligado; });
  });
  if (kindSeg) kindSeg.addEventListener('click', (ev) => {
    const b = ev.target.closest('.seg-btn'); if (!b) return;
    marcar(kindSeg, b.dataset.v);
    salvar({ petKind: b.dataset.v }, recarregar);
  });
  if (visSeg) visSeg.addEventListener('click', (ev) => {
    const b = ev.target.closest('.seg-btn'); if (!b) return;
    marcar(visSeg, b.dataset.v);
    if (visDesc) visDesc.textContent = VIS_DESC[b.dataset.v];
    salvar({ petVisibility: b.dataset.v }, recarregar);
  });
  if (size) {
    // `input` dispara a cada pixel do arrasto: grava só ao soltar (`change`).
    size.addEventListener('change', () => salvar({ petSize: Number(size.value) }, recarregar));
  }
  if (reset) reset.addEventListener('click', () => {
    if (size) size.value = String(PADRAO.petSize);
    salvar({ petSize: PADRAO.petSize }, recarregar);
  });
})();

// ── Vidro da janela (2026-09-08) ─────────────────────────────────────────────
//
// Vive em norya-state.json, não em localStorage: quem decide o vidro é o
// `new BrowserWindow` do processo main, que não enxerga localStorage. Ver
// ui-prefs.js — inclusive para a medição que fez o padrão ser DESLIGADO.
//
// Não oferecemos "reiniciar agora": reiniciar o Norya mata todos os PTYs, ou
// seja, todas as sessões de agente abertas. A troca vale no próximo boot, no
// momento que o usuário escolher.
(function ligarToggleDoVidro() {
  const cb = document.getElementById('glassToggle');
  if (!cb) return;
  api.noryaStateGet()
    .then(estado => { cb.checked = !(estado && estado.glass === false); })
    .catch(() => { cb.checked = true; });
  cb.addEventListener('change', function () {
    const ligado = this.checked;
    api.noryaStateSave({ glass: ligado })
      .then(r => {
        if (r && r.error) throw new Error(r.error);
        if (typeof window.noryaToast === 'function') {
          window.noryaToast(
            ligado
              ? 'Vidro ligado — vale no próximo boot do Norya.'
              : 'Vidro desligado — vale no próximo boot do Norya.',
            'info');
        }
      })
      .catch(e => {
        this.checked = !ligado;   // não mente pro usuário: não gravou, não marca
        if (typeof window.noryaToast === 'function') {
          window.noryaToast('Não deu pra salvar a preferência: ' + (e.message || e), 'error');
        }
      });
  });
})();

// ── Statistics ─────────────────────────────────────────────────────────────────
// Contadores locais exatos (token-stats.js) + custo equivalente de API
// (pricing.js, calculado no worker). Datas são as de cada resposta, nunca o
// updated_at da thread. Custo = preço público de tabela; NÃO é fatura.
const exactTokens = n => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(n);
const compactTokens = n => {
  const abs = Math.abs(n);
  const f = (v, d) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);
  if (abs >= 1e9) return f(n / 1e9, 2) + ' bi';
  if (abs >= 1e6) return f(n / 1e6, abs >= 1e8 ? 0 : 1) + ' mi';
  if (abs >= 1e3) return f(n / 1e3, abs >= 1e5 ? 0 : 1) + ' mil';
  return exactTokens(n);
};
const usd = (n, digits) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD',
  maximumFractionDigits: digits ?? (Math.abs(n) >= 1000 ? 0 : 2), minimumFractionDigits: digits ?? (Math.abs(n) >= 1000 ? 0 : 2) }).format(n);
const brl = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(n);
const DAY = 86400000;
const PROVIDER_COLORS = { claude: '#d97757', codex: '#10a37f', opencode: '#6e8eff' };

function statsRange(filter, customStart, customEnd) {
  const now = Date.now();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (filter === 'today') return [today.getTime(), now];
  if (filter === 'week') return [now - 7 * DAY, now];
  if (filter === 'month') return [now - 30 * DAY, now];
  if (filter === 'cal') return [new Date(today.getFullYear(), today.getMonth(), 1).getTime(), now];
  if (filter === 'custom') {
    // Date inputs are local calendar dates, not UTC midnight.
    return [customStart ? new Date(customStart + 'T00:00:00').getTime() : 0,
      customEnd ? new Date(customEnd + 'T23:59:59.999').getTime() : now];
  }
  return null;
}
function filterRowsByDate(rows, filter, customStart, customEnd) {
  const range = statsRange(filter, customStart, customEnd);
  if (!range) return rows;
  return rows.filter(r => r.timestamp != null && r.timestamp >= range[0] && r.timestamp <= range[1]);
}
let _allStatsRows = null;
let _statsSnapshot = null;
let _statsFilter = 'all';
let _statsProvider = 'all';
let _statsLoading = false;
let _statsFx = null;

async function loadStats(force = false) {
  if (_statsLoading) return;
  _statsLoading = true;
  const container = document.getElementById('statsContent');
  const refresh = document.getElementById('statsRefresh');
  if (refresh) { refresh.disabled = true; refresh.classList.add('is-busy'); }
  if (!_statsSnapshot) {
    container.replaceChildren();
    const p = document.createElement('p'); p.className = 'stats-loading';
    p.textContent = 'Lendo o histórico local de consumo… a primeira leitura pode levar até um minuto.';
    container.appendChild(p);
  }
  if (!_statsFx) api.getFxUsdBrl?.().then(fx => { if (fx && fx.rate) { _statsFx = fx; if (_allStatsRows) renderStats(_allStatsRows); } }).catch(() => {});
  try {
    const snapshot = await api.getTokenStats({ force });
    if (!snapshot || !Array.isArray(snapshot.rows)) throw new Error('Reinicie o Norya para carregar o novo coletor de tokens.');
    _statsSnapshot = snapshot;
    _allStatsRows = snapshot.rows;
    renderStats(_allStatsRows);
  } catch (err) {
    container.querySelector('.stats-error')?.remove();
    const message = document.createElement('div');
    message.className = 'stats-note stats-error';
    message.setAttribute('role', 'alert');
    message.textContent = 'Falha na atualização: ' + err.message + (_statsSnapshot ? ' Os números abaixo são da última leitura.' : ' Use Atualizar para tentar novamente.');
    container.prepend(message);
  } finally {
    _statsLoading = false;
    if (refresh) { refresh.disabled = false; refresh.classList.remove('is-busy'); }
  }
}

// Uma passada só sobre as linhas filtradas: tudo que a tela mostra sai daqui.
function statsAggregate(rows) {
  const a = { tokens: 0, responses: 0, sessions: new Set(), usd: 0, saved: 0, unpricedTokens: 0, unpricedModels: new Set(),
    comp: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, webSearch: 0 }, tok: { input: 0, read: 0, write: 0, output: 0 },
    byModel: new Map(), byProfile: new Map(), byDay: new Map(), first: Infinity, last: 0, fast: 0, preserved: 0 };
  for (const r of rows) {
    a.tokens += r.tokens_used; a.responses++; a.sessions.add(r.provider + ':' + r.id);
    const b = r._breakdown, c = r.cost;
    if (b) { a.tok.input += b.input_tokens - b.cached_input_tokens - b.cache_write_input_tokens; a.tok.read += b.cached_input_tokens; a.tok.write += b.cache_write_input_tokens; a.tok.output += b.output_tokens; }
    const mk = r.provider + '\u0000' + r.model;
    const m = a.byModel.get(mk) || { provider: r.provider, model: r.model, tokens: 0, usd: 0, priced: false, unpriced: 0 };
    m.tokens += r.tokens_used;
    if (c) {
      a.usd += c.total; a.saved += c.saved || 0; m.usd += c.total; m.priced = true;
      for (const k in a.comp) a.comp[k] += c[k] || 0;
      if (c.fast) a.fast++;
    } else { a.unpricedTokens += r.tokens_used; m.unpriced += r.tokens_used; a.unpricedModels.add(r.model); }
    a.byModel.set(mk, m);
    const pk = r.provider + '\u0000' + (r.accountNum ?? 'g');
    const p = a.byProfile.get(pk) || { provider: r.provider, accountNum: r.accountNum, tokens: 0, usd: 0 };
    p.tokens += r.tokens_used; p.usd += c ? c.total : 0; a.byProfile.set(pk, p);
    if (r.preserved) a.preserved += r.tokens_used;
    if (r.timestamp) {
      a.first = Math.min(a.first, r.timestamp); a.last = Math.max(a.last, r.timestamp);
      const d = new Date(r.timestamp); d.setHours(0, 0, 0, 0);
      const day = a.byDay.get(d.getTime()) || { usd: 0, tokens: 0, by: {} };
      day.usd += c ? c.total : 0; day.tokens += r.tokens_used;
      day.by[r.provider] = (day.by[r.provider] || 0) + (c ? c.total : 0);
      a.byDay.set(d.getTime(), day);
    }
  }
  return a;
}

function renderStats(allRows) {
  const container = document.getElementById('statsContent');
  const scoped = allRows.filter(r => _statsProvider === 'all' || r.provider === _statsProvider);
  const rows = filterRowsByDate(scoped, _statsFilter,
    document.getElementById('statsDateFrom')?.value, document.getElementById('statsDateTo')?.value);
  const a = statsAggregate(rows);
  const snap = _statsSnapshot;
  const make = (tag, cls, value) => {
    const e = document.createElement(tag); if (cls) e.className = cls;
    if (value != null) e.textContent = value;
    return e;
  };
  const frag = document.createDocumentFragment();
  const providerLabel = id => snap.providers.find(p => p.id === id)?.label || id;

  // ── Destaque: custo equivalente em API ──
  const hero = make('section', 'stats-hero');
  const heroMain = make('div', 'stats-hero-main');
  heroMain.append(make('div', 'stats-eyebrow', 'Se fosse pela API'));
  const big = make('div', 'stats-hero-value', usd(a.usd)); big.title = usd(a.usd, 2);
  heroMain.append(big);
  const sub = make('div', 'stats-hero-sub');
  if (_statsFx && _statsFx.rate) {
    const b = make('span', 'stats-hero-brl', '≈ ' + brl(a.usd * _statsFx.rate));
    b.title = `PTAX de venda ${_statsFx.date.split('-').reverse().join('/')} · R$ ${_statsFx.rate.toFixed(4).replace('.', ',')}${_statsFx.stale ? ' (última cotação conhecida)' : ''}`;
    sub.append(b, document.createTextNode(' · '));
  }
  sub.append(document.createTextNode('preço de tabela, sem descontos'));
  heroMain.append(sub);
  hero.append(heroMain);
  // Composição do custo: onde o dinheiro iria.
  const parts = [['output', 'Saída', a.comp.output], ['cacheRead', 'Cache lido', a.comp.cacheRead],
    ['cacheWrite', 'Cache gravado', a.comp.cacheWrite], ['input', 'Entrada', a.comp.input]];
  if (a.comp.webSearch > 0) parts.push(['webSearch', 'Busca web', a.comp.webSearch]);
  const bar = make('div', 'stats-comp-bar'); bar.setAttribute('role', 'img');
  const legend = make('div', 'stats-comp-legend');
  bar.setAttribute('aria-label', parts.map(([, l, v]) => `${l} ${usd(v)}`).join(', '));
  for (const [k, label, v] of parts) {
    if (!(v > 0)) continue;
    const seg = make('i', 'seg-' + k); seg.style.flexGrow = String(v); seg.title = `${label}: ${usd(v, 2)}`;
    bar.append(seg);
    const li = make('span'); li.append(make('i', 'seg-' + k), document.createTextNode(`${label} `), make('b', '', usd(v, a.usd >= 1000 ? 0 : 2)));
    legend.append(li);
  }
  if (a.usd > 0) hero.append(bar, legend);
  frag.append(hero);

  // ── Números de apoio ──
  const kpis = make('div', 'stats-kpis');
  const kpi = (value, label, title) => { const k = make('div', 'stats-kpi'); const v = make('div', 'stats-kpi-val', value); if (title) v.title = title; k.append(v, make('div', 'stats-kpi-label', label)); kpis.append(k); };
  kpi(compactTokens(a.tokens), 'tokens', exactTokens(a.tokens) + ' tokens');
  kpi(exactTokens(a.responses), `respostas · ${exactTokens(a.sessions.size)} sessões`);
  const inTok = a.tok.input + a.tok.read + a.tok.write;
  kpi(usd(a.saved), `economizados pelo cache (${inTok ? Math.round(a.tok.read / inTok * 100) : 0}% da entrada)`);
  const days = a.byDay.size;
  kpi(days ? usd(a.usd / days) : '—', `por dia com uso · ${exactTokens(days)} dias`);
  frag.append(kpis);

  // ── Custo por dia (ou por semana em períodos longos) ──
  if (a.byDay.size > 1) {
    const span = (a.last - a.first) / DAY;
    const weekly = span > 75;
    const buckets = new Map();
    const start = new Date(a.first); start.setHours(0, 0, 0, 0);
    if (weekly) start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(a.last); end.setHours(0, 0, 0, 0);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + (weekly ? 7 : 1))) buckets.set(d.getTime(), { usd: 0, by: {} });
    for (const [t, v] of a.byDay) {
      let key = t;
      if (weekly) { const d = new Date(t); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); key = d.getTime(); }
      const bk = buckets.get(key); if (!bk) continue;
      bk.usd += v.usd; for (const p in v.by) bk.by[p] = (bk.by[p] || 0) + v.by[p];
    }
    const max = Math.max(...[...buckets.values()].map(b => b.usd), 0.01);
    const card = make('section', 'stats-card');
    const head = make('div', 'stats-card-head');
    head.append(make('h3', '', weekly ? 'Custo por semana' : 'Custo por dia'), make('span', 'stats-card-meta', 'pico ' + usd(max)));
    const chart = make('div', 'stats-chart');
    const fmtDay = t => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    for (const [t, b] of buckets) {
      const col = make('div', 'stats-chart-col');
      col.title = `${weekly ? 'Semana de ' : ''}${fmtDay(t)}: ${usd(b.usd, 2)}` +
        Object.entries(b.by).filter(([, v]) => v > 0).map(([p, v]) => `\n${providerLabel(p)}: ${usd(v, 2)}`).join('');
      const stack = make('div', 'stats-chart-stack'); stack.style.height = (b.usd / max * 100) + '%';
      for (const p of ['claude', 'codex', 'opencode']) {
        if (!(b.by[p] > 0)) continue;
        const s = make('i'); s.style.flexGrow = String(b.by[p]); s.style.background = PROVIDER_COLORS[p]; stack.append(s);
      }
      col.append(stack); chart.append(col);
    }
    const axis = make('div', 'stats-chart-axis');
    axis.append(make('span', '', fmtDay([...buckets.keys()][0])), make('span', '', fmtDay([...buckets.keys()].pop())));
    const keyRow = make('div', 'stats-chart-key');
    for (const p of ['claude', 'codex', 'opencode']) {
      if (![...buckets.values()].some(b => b.by[p] > 0)) continue;
      const k = make('span'); const dot = make('i'); dot.style.background = PROVIDER_COLORS[p];
      k.append(dot, document.createTextNode(providerLabel(p))); keyRow.append(k);
    }
    card.append(head, chart, axis, keyRow);
    frag.append(card);
  }

  // ── Por modelo ──
  const models = [...a.byModel.values()].sort((x, y) => y.usd - x.usd || y.tokens - x.tokens);
  if (models.length) {
    const card = make('section', 'stats-card');
    const head = make('div', 'stats-card-head'); head.append(make('h3', '', 'Por modelo'), make('span', 'stats-card-meta', `${models.length} modelos`));
    const wrap = make('div', 'stats-table-wrap');
    const table = make('table', 'stats-model-table');
    const thead = make('thead'); const hr = make('tr');
    for (const [label, cls] of [['Modelo', ''], ['Tokens', 'num'], ['Custo API', 'num'], ['', 'share']]) { const th = make('th', cls, label); th.scope = 'col'; hr.append(th); }
    thead.append(hr); table.append(thead);
    const tbody = make('tbody');
    const maxUsd = Math.max(...models.map(m => m.usd), 0.01);
    for (const m of models) {
      const tr = make('tr'); tr.dataset.provider = m.provider;
      const name = make('th', 'model'); name.scope = 'row';
      const dot = make('i', 'prov-dot'); dot.style.background = PROVIDER_COLORS[m.provider] || 'var(--text-faint)';
      name.append(dot, document.createTextNode(m.model));
      const tokens = make('td', 'num', compactTokens(m.tokens)); tokens.title = exactTokens(m.tokens) + ' tokens';
      const cost = make('td', 'num');
      if (m.priced) {
        cost.textContent = usd(m.usd);
        if (m.unpriced) cost.title = `${compactTokens(m.unpriced)} tokens sem detalhamento ficaram fora do custo`;
      } else { cost.textContent = 'sem preço'; cost.className = 'num muted'; cost.title = 'Modelo sem preço público de API — não entra no custo'; }
      const share = make('td', 'share'); const track = make('div', 'stats-share'); const fill = make('i');
      fill.style.width = (m.usd / maxUsd * 100) + '%'; fill.style.background = PROVIDER_COLORS[m.provider] || 'var(--accent)';
      track.append(fill); share.append(track);
      share.title = a.usd ? Math.round(m.usd / a.usd * 1000) / 10 + '% do custo' : '';
      tr.append(name, tokens, cost, share); tbody.append(tr);
    }
    table.append(tbody); wrap.append(table); card.append(head, wrap);
    frag.append(card);
  }

  // ── Por perfil de armazenamento ──
  const profiles = [...a.byProfile.values()].sort((x, y) => y.usd - x.usd || y.tokens - x.tokens);
  if (profiles.length > 1) {
    const card = make('section', 'stats-card');
    const head = make('div', 'stats-card-head'); head.append(make('h3', '', 'Por perfil'));
    const list = make('div', 'stats-profile-list');
    for (const p of profiles) {
      const account = st.accounts.find(x => x.num === p.accountNum);
      const label = p.accountNum == null ? 'Global / compartilhado' : account?.name || 'Perfil ' + p.accountNum;
      const row = make('div', 'stats-profile-row');
      const dot = make('i', 'prov-dot'); dot.style.background = PROVIDER_COLORS[p.provider] || 'var(--text-faint)';
      const name = make('span', 'name'); name.append(dot, document.createTextNode(`${providerLabel(p.provider)} · ${label}`));
      const t = make('span', 'tok', compactTokens(p.tokens)); t.title = exactTokens(p.tokens) + ' tokens';
      row.append(name, t, make('span', 'usd', usd(p.usd)));
      list.append(row);
    }
    card.append(head, list);
    frag.append(card);
  }

  // ── Cobertura e método (letra miúda, mas presente) ──
  const notes = make('section', 'stats-notes');
  const note = text => notes.append(make('p', 'stats-note', text));
  if (!rows.length) note('Nenhum consumo registrado neste período e provider. Isso não comprova uso zero fora dos registros disponíveis.');
  if (a.unpricedTokens) note(`${compactTokens(a.unpricedTokens)} tokens ficaram fora do custo: modelos sem preço público (${[...a.unpricedModels].filter(Boolean).slice(0, 4).join(', ')}) ou histórico só com total, sem separar entrada e saída.`);
  const undated = scoped.filter(r => !r.timestamp).reduce((s, r) => s + r.tokens_used, 0);
  if (undated && _statsFilter !== 'all') note(`${compactTokens(undated)} tokens sem data ficam fora de períodos e aparecem só em Tudo.`);
  if (a.preserved) note(`${compactTokens(a.preserved)} tokens vêm de arquivos que não existem mais (perfil apagado ou limpeza do CLI) e foram preservados pelo Norya.`);
  if (a.fast) note(`${exactTokens(a.fast)} respostas em modo Fast, cobradas na tabela Fast.`);
  const cov = snap.coverage;
  if (cov.issues || cov.errors.length) note(`Cobertura parcial: ${cov.issues} registros inconsistentes; ${cov.errors.length} fontes com falha de leitura.`);
  note(`Custo = preço público de API por modelo (Anthropic e OpenAI, conferidos em ${snap.pricing ? snap.pricing.verifiedAt.split('-').reverse().join('/') : '—'}), aplicado a cada resposta: entrada, cache lido, cache gravado (5 min e 1 h), saída e contexto longo acima de 272 mil tokens. Assinaturas não cobram assim; é quanto esse uso custaria via API.`);
  note(`Histórico local · ${exactTokens(cov.files)} arquivos · atualizado ${new Date(snap.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. Grok e Aider não registram tokens por resposta.`);
  frag.append(notes);

  container.replaceChildren(frag);
}

// Refresh only while visible, so a statistics tab does not create background I/O.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('statsRefresh')?.addEventListener('click', () => loadStats(true));
  document.querySelectorAll('.stats-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _statsFilter = btn.dataset.filter;
      document.querySelectorAll('.stats-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('statsCustomDates')?.classList.toggle('hidden', _statsFilter !== 'custom');
      if (_allStatsRows) renderStats(_allStatsRows);
    });
  });
  document.querySelectorAll('.stats-provider-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _statsProvider = btn.dataset.provider;
      document.querySelectorAll('.stats-provider-btn').forEach(b => b.classList.toggle('active', b === btn));
      if (_allStatsRows) renderStats(_allStatsRows);
    });
  });
  ['statsDateFrom', 'statsDateTo'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => { if (_allStatsRows) renderStats(_allStatsRows); });
  });
  setInterval(() => {
    if (!document.hidden && !document.getElementById('modalSettings').classList.contains('hidden') &&
        document.getElementById('tabStats').classList.contains('active')) loadStats();
  }, 30000);
});

// Projetos (cwd das threads) — usado pelo Merge Queue.
function listProjects() {
  const projects = new Map();
  st.allThreads.forEach(t => {
    if (!t.cwd) return;
    const key = t.cwd;
    if (!projects.has(key)) {
      projects.set(key, { dir: key, name: (t.cwd.split(/[\\/]/).pop() || 'project'), branch: t.git_branch });
    }
  });
  return Array.from(projects.values());
}

// ── Merge Queue ────────────────────────────────────────────────────────────────
let mqLast = null;
let _mqLastConflictResolve = null; // { projectDir, conflictBranch, baseBranch, conflictFiles, historyTs }

// Local HTML escape used in modal rendering; defined before first use.
function _mqEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function loadMergeQueueTab() {
  const sel = document.getElementById('mqProjectSel');
  const content = document.getElementById('mqContent');
  const projects = listProjects();
  sel.innerHTML = projects.length
    ? projects.map(p => `<option value="${p.dir.replace(/"/g,'&quot;')}">${_mqEscapeHtml(p.name)}</option>`).join('')
    : '<option value="">(no projects yet)</option>';
  if (!projects.length) { content.textContent = ''; return; }
  content.innerHTML = '<div style="color:var(--text-faint);padding:14px 0">Click "Analyze branches" to start.</div>';
}

// Tab switcher (Queue / History) — same modal, two panes.
function switchMergeTab(tab) {
  document.querySelectorAll('.mq-tab').forEach(b => b.classList.toggle('active', b.dataset.mqtab === tab));
  document.querySelectorAll('.mq-tab-pane').forEach(p => {
    const active = p.dataset.mqpane === tab;
    p.classList.toggle('active', active);
    p.style.display = active ? 'flex' : 'none';
  });
  if (tab === 'history') loadMergeHistoryTab();
}
(function bindMqTabs() {
  const tabs = document.getElementById('mqTabs');
  if (!tabs) return;
  tabs.addEventListener('click', e => {
    const btn = e.target.closest('.mq-tab');
    if (!btn) return;
    switchMergeTab(btn.dataset.mqtab);
  });
})();

// Merge history tab — reads persisted records via IPC and renders rows.
async function loadMergeHistoryTab() {
  const box = document.getElementById('mqHistoryContent');
  if (!box) return;
  box.textContent = 'Loading…';
  let res;
  try { res = await api.mergeHistoryList(); } catch { res = { records: [] }; }
  const rows = (res && res.records) || [];
  // Render into a detached fragment to avoid setting innerHTML with mixed content.
  box.textContent = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'mq-history-empty';
    empty.textContent = 'No merges yet. They will appear here after the first run.';
    box.appendChild(empty);
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'mq-history-row ' + (r.ok ? 'ok' : 'fail');
    row.dataset.ts = String(r.ts);
    const dot = document.createElement('div');
    dot.className = 'mq-history-dot';
    const mid = document.createElement('div');
    const projShort = (r.projectDir || '').split(/[\\/]/).slice(-2).join('/');
    const mergedCount = (r.mergedBranches || []).length;
    const headline = document.createElement('div');
    headline.className = 'mq-history-branches';
    headline.textContent = projShort + ' — ' + (mergedCount
      ? (mergedCount + ' branch(es) merged into ' + (r.baseBranch || 'main'))
      : 'No branches merged');
    const meta = document.createElement('div');
    meta.className = 'mq-history-meta';
    const when = new Date(r.ts).toLocaleString();
    const stoppedText = r.stoppedAt ? ' · stopped at ' + r.stoppedAt : '';
    const agentText = r.agentUsed ? ' · agent: ' + (r.agentProfile || 'used') : '';
    const safetyText = r.safetyBranch ? ' · backup ' + r.safetyBranch : '';
    meta.textContent = when + stoppedText + agentText + safetyText;
    mid.appendChild(headline);
    mid.appendChild(meta);
    if (r.conflictFiles && r.conflictFiles.length) {
      const cf = document.createElement('div');
      cf.className = 'mq-history-meta';
      cf.style.marginTop = '4px';
      cf.textContent = 'Conflicts: ' + r.conflictFiles.slice(0, 5).join(', ')
        + (r.conflictFiles.length > 5 ? ' +' + (r.conflictFiles.length - 5) + ' more' : '');
      mid.appendChild(cf);
    }
    const btn = document.createElement('button');
    btn.className = 'mq-history-action';
    btn.textContent = 'Details';
    btn.addEventListener('click', () => alert(JSON.stringify(r, null, 2)));
    row.appendChild(dot);
    row.appendChild(mid);
    row.appendChild(btn);
    box.appendChild(row);
  }
}

(function bindMqHistoryClear() {
  const btn = document.getElementById('btnMqHistoryClear');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm('Clear all merge history? This cannot be undone.')) return;
    try { await api.mergeHistoryClear(); } catch {}
    loadMergeHistoryTab();
  });
})();

document.getElementById('btnMqAnalyze').addEventListener('click', async () => {
  const sel = document.getElementById('mqProjectSel');
  const content = document.getElementById('mqContent');
  const dir = sel.value;
  if (!dir) return;
  content.innerHTML = '<div style="padding:14px 0">Analyzing branches with git merge-tree…</div>';
  const res = await api.gitAnalyzeBranches(dir, null);
  if (res.error) { content.innerHTML = '<div style="color:#f66;padding:14px 0">✗ ' + _mqEscapeHtml(res.error) + '</div>'; return; }
  mqLast = res;
  renderMQResult(res);
});

function renderMQResult(res) {
  const content = document.getElementById('mqContent');
  if (!res.branches || !res.branches.length) {
    content.innerHTML = `<div style="padding:14px 0">No branches to merge into <code>${_mqEscapeHtml(res.base)}</code>.</div>`;
    return;
  }
  const cleanCount = res.branches.filter(b => !(b.conflicts && b.conflicts.length)).length;
  const conflictCount = res.branches.length - cleanCount;
  const badge = conflictCount === 0
    ? `<span class="mq-precheck-badge clean">🟢 ${cleanCount} clean</span>`
    : `<span class="mq-precheck-badge conflict">🔴 ${conflictCount} conflict(s) · ${cleanCount} clean</span>`;
  const rows = res.branches.map((b) => {
    const hasConflicts = b.conflicts && b.conflicts.length > 0;
    const conflictsCell = hasConflicts
      ? `<span style="color:#ffae3a">${b.conflicts.length} conflict(s)</span>`
      : `<span style="color:#5fbf6b">clean</span>`;
    const branchSafe = _mqEscapeHtml(b.branch);
    return `<tr>
      <td><input type="checkbox" class="mq-pick" data-branch="${branchSafe}" ${hasConflicts ? '' : 'checked'}></td>
      <td><code>${branchSafe}</code></td>
      <td>${b.ahead} ahead · ${b.behind} behind</td>
      <td>${b.changedFiles.length} files</td>
      <td>${conflictsCell}</td>
      <td style="color:var(--text-faint);font-size:11px">${_mqEscapeHtml((b.lastCommit || '').slice(0, 50))}</td>
    </tr>`;
  }).join('');
  content.innerHTML = `
    <div style="padding:6px 0 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--text-muted);font-size: 12px">
      <span>Base branch: <code>${_mqEscapeHtml(res.base)}</code> · ${res.branches.length} branch(es) analyzed.</span>
      ${badge}
    </div>
    <table class="mq-table">
      <thead><tr><th></th><th>Branch</th><th>Position</th><th>Changes</th><th>Conflicts</th><th>Last commit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

document.getElementById('btnMqMerge').addEventListener('click', async () => {
  const sel = document.getElementById('mqProjectSel');
  const content = document.getElementById('mqContent');
  const dir = sel.value;
  if (!dir || !mqLast) return;
  const picks = Array.from(document.querySelectorAll('.mq-pick:checked')).map(cb => cb.dataset.branch);
  if (!picks.length) { alert('Pick at least one branch.'); return; }
  // Smart order: branches with fewer changes go first
  const order = picks.slice().sort((a, b) => {
    const ba = mqLast.branches.find(x => x.branch === a) || { changedFiles: [] };
    const bb = mqLast.branches.find(x => x.branch === b) || { changedFiles: [] };
    return ba.changedFiles.length - bb.changedFiles.length;
  });
  const failStop = !!document.getElementById('mqFailStop').checked;
  const modeText = failStop ? 'Fail-stop at first conflict.' : 'Skip conflicted branches and continue.';
  if (!confirm(`Merge into ${mqLast.base} in this order?\n\n${order.join('\n')}\n\n${modeText}\nA backup branch will be created automatically.`)) return;
  content.innerHTML = '<div style="padding:14px 0">Running queued merges…</div>';
  const res = await api.gitQueueMerge(dir, mqLast.base, order, { failStop });
  if (res.error) {
    content.innerHTML = `<div style="color:#f66;padding:14px 0">✗ ${_mqEscapeHtml(res.error)}</div>`;
    return;
  }
  const ok = res.ok;
  const logHtml = (res.log || []).map(l => `<div>${_mqEscapeHtml(l)}</div>`).join('');
  // Fase 8: when a conflict halts the queue, offer the agent resolver
  const conflictBranch = !ok ? (res.stoppedAt || order[order.length - 1] || null) : null;
  const conflictFiles = res.conflictFiles || [];
  const resolverBlockId = 'mqConflictResolver-' + Date.now();

  let headerHtml;
  if (ok) {
    headerHtml = `<div style="padding:10px 0;color:#5fbf6b">✓ All merges succeeded.</div>`;
  } else {
    headerHtml = `<div style="padding:10px 0;color:#ffae3a">⚠ Stopped at conflict on <code>${_mqEscapeHtml(conflictBranch || 'branch')}</code> — backup at <code>${_mqEscapeHtml(res.safetyBranch || '')}</code></div>`;
  }

  const resolverHtml = ok ? '' : `
    <div class="merge-conflict-resolver" id="${resolverBlockId}">
      <div class="merge-conflict-resolver-title">
        ⚠ Conflito em "${_mqEscapeHtml(conflictBranch || 'branch')}"
      </div>
      <div class="merge-conflict-resolver-desc">
        ${conflictFiles.length
          ? `${conflictFiles.length} file(s) affected. You can inspect below or ask the agent to resolve.`
          : 'No file list available (the merge was aborted).'}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="merge-agent-btn" id="${resolverBlockId}-btn">🤖 Resolve with agent</button>
        ${conflictFiles.length ? `<button class="merge-agent-btn" id="${resolverBlockId}-inline" style="background:transparent;border:1px solid #e8a82e;color:#e8a82e">Preview inline</button>` : ''}
      </div>
      <div id="${resolverBlockId}-inline-host" style="margin-top:8px"></div>
    </div>
  `;

  content.innerHTML = headerHtml
    + `<pre style="font-size: 12px;color:var(--text-muted)">${logHtml}</pre>`
    + resolverHtml;

  if (!ok) {
    _mqLastConflictResolve = {
      projectDir: dir,
      baseBranch: mqLast.base,
      conflictBranch,
      conflictFiles,
    };
    const btn = document.getElementById(resolverBlockId + '-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        spawnMergeAgent({
          projectDir: dir,
          baseBranch: mqLast.base,
          conflictBranch,
          conflictFiles,
        });
      });
    }
    const btnInline = document.getElementById(resolverBlockId + '-inline');
    if (btnInline) {
      btnInline.addEventListener('click', async () => {
        await renderInlineConflictPreview(resolverBlockId + '-inline-host', dir, conflictFiles);
      });
    }
  }
});

// Inline preview of conflict markers. Shows ours / theirs side-by-side.
// Read-only by design — the agent (or the user via terminal) is still the
// resolver. Provides "copy ours" / "copy theirs" affordances for quick triage.
async function renderInlineConflictPreview(hostId, projectDir, files) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.textContent = 'Loading conflict preview…';
  const blocks = [];
  for (const f of files.slice(0, 20)) {
    const r = await api.gitConflictFileRead(projectDir, f).catch(e => ({ error: String(e) }));
    blocks.push({ file: f, result: r });
  }
  host.textContent = '';
  for (const b of blocks) {
    const wrap = document.createElement('div');
    wrap.className = 'mq-conflict-file';
    const header = document.createElement('div');
    header.className = 'mq-conflict-file-header';
    const code = document.createElement('code');
    code.textContent = b.file;
    header.appendChild(code);
    const meta = document.createElement('span');
    meta.style.color = 'var(--text-faint)';
    meta.style.fontSize = '10.5px';
    if (b.result && b.result.error) {
      meta.textContent = 'error: ' + b.result.error;
    } else if (b.result && b.result.hunks) {
      meta.textContent = b.result.hunks.length + ' hunk(s)';
    }
    header.appendChild(meta);
    wrap.appendChild(header);
    if (b.result && b.result.hunks) {
      for (const h of b.result.hunks) {
        const hunk = document.createElement('div');
        hunk.className = 'mq-conflict-hunk';
        const ours = document.createElement('div');
        ours.className = 'mq-conflict-side ours';
        const oursLabel = document.createElement('div');
        oursLabel.className = 'mq-conflict-side-label';
        const oursTitle = document.createElement('span');
        oursTitle.textContent = 'Ours' + (h.ourLabel ? ' (' + h.ourLabel + ')' : '');
        const oursPick = document.createElement('button');
        oursPick.className = 'mq-conflict-side-pick';
        oursPick.textContent = 'Copy';
        oursPick.addEventListener('click', () => {
          try { navigator.clipboard.writeText(h.ours.join('\n')); } catch {}
        });
        oursLabel.appendChild(oursTitle); oursLabel.appendChild(oursPick);
        ours.appendChild(oursLabel);
        const oursPre = document.createElement('pre');
        oursPre.style.margin = '0';
        oursPre.style.background = 'transparent';
        oursPre.textContent = h.ours.join('\n');
        ours.appendChild(oursPre);

        const theirs = document.createElement('div');
        theirs.className = 'mq-conflict-side theirs';
        const theirsLabel = document.createElement('div');
        theirsLabel.className = 'mq-conflict-side-label';
        const theirsTitle = document.createElement('span');
        theirsTitle.textContent = 'Theirs' + (h.theirLabel ? ' (' + h.theirLabel + ')' : '');
        const theirsPick = document.createElement('button');
        theirsPick.className = 'mq-conflict-side-pick';
        theirsPick.textContent = 'Copy';
        theirsPick.addEventListener('click', () => {
          try { navigator.clipboard.writeText(h.theirs.join('\n')); } catch {}
        });
        theirsLabel.appendChild(theirsTitle); theirsLabel.appendChild(theirsPick);
        theirs.appendChild(theirsLabel);
        const theirsPre = document.createElement('pre');
        theirsPre.style.margin = '0';
        theirsPre.style.background = 'transparent';
        theirsPre.textContent = h.theirs.join('\n');
        theirs.appendChild(theirsPre);

        hunk.appendChild(ours);
        hunk.appendChild(theirs);
        wrap.appendChild(hunk);
      }
    }
    host.appendChild(wrap);
  }
  if (!blocks.length) {
    host.textContent = 'No conflict files available.';
  }
}
