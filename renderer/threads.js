/**
 * renderer/threads.js — branches modal, working indicator, rename/delete, seleção, terminal mgmt, output.
 *
 * Script CLÁSSICO (ver renderer/state.js): fatia contígua extraída de
 * test-window.html em 2026-07-10, na ordem original. Compartilha o escopo
 * léxico global com os outros — `st`, `api`, `ipcRenderer` e as funções de
 * cada fatia enxergam-se sem import. Ordem de carga preservada = zero mudança
 * de comportamento.
 */
'use strict';

let _archivedSectionExpanded = false;

// PERF: rAF-coalesce repeated renderProjectList() calls. With 22+ call sites
// (listThreads refresh, drag/drop, archive, profile switch, …) it's common
// for 2-4 calls to fire in the same tick — each one rebuilds the entire
// sidebar DOM. We batch by skipping duplicate calls within a frame; the
// final state wins (renderProjectList is a pure function of `st.*`).
let _projectListRAF = null;
let _projectListInFlight = false;
function renderProjectList() {
  if (_projectListInFlight) return;
  if (_projectListRAF != null) return;
  _projectListRAF = requestAnimationFrame(() => {
    _projectListRAF = null;
    _projectListInFlight = true;
    try { _renderProjectListImpl(); } finally { _projectListInFlight = false; }
  });
}
// Synchronous variant for the rare caller that needs the sidebar up-to-date
// before the next frame (spawn de thread nova, expanders "N older…"/"Show all"
// e testes CDP — o rAF não roda com a janela oculta).
function renderProjectListNow() {
  if (_projectListRAF != null) { cancelAnimationFrame(_projectListRAF); _projectListRAF = null; }
  _projectListInFlight = true;
  try { _renderProjectListImpl(); } finally { _projectListInFlight = false; }
}

// ── Refresh de dados da sidebar (2026-08-04) ─────────────────────────────────
// A lista "piscava" porque QUATRO pollers independentes chamavam listThreads +
// renderProjectList em paralelo: o refresh global de 45s, o poll de latch
// (1,5s × 60 e depois indefinidamente enquanto o PTY viver) e o refresh
// agressivo do ntpSubmit (2s × 15). Cada chamada custa ~180ms SÍNCRONOS no
// processo main (um exec de sqlite3 por perfil + stat de centenas de rollouts do
// Claude) e _renderProjectListImpl reconstrói a lista inteira com
// innerHTML='' — mesmo quando o resultado era byte a byte o mesmo de antes.
// Criar uma task acendia esse ciclo a cada 1,5s pelos 90s seguintes.
//
// refreshThreads() passa a ser o ÚNICO caminho de refresh POR DADOS:
//   • coalesce — pollers concorrentes compartilham a chamada em voo;
//   • throttle — no mínimo REFRESH_MIN_MS entre dois IPCs, quantos pollers
//     existam;
//   • no-op    — só redesenha quando a assinatura do que a sidebar MOSTRA muda.
// Ações locais (colapso de seção, busca, drag-drop, rename) continuam chamando
// renderProjectList() direto: elas mudam o DOM sem mudar os dados e não devem
// passar por este gate.
const REFRESH_MIN_MS = 1200;
let _refreshInFlight = null;
let _refreshLastAt = 0;
let _sidebarDataSig = null;

// Assinatura do que a linha da sidebar de fato mostra. relDate() entra de
// propósito: é o que faz "now" virar "2m" sem nenhuma mudança nos dados — sem
// ele os horários relativos congelariam.
function _sidebarDataSignature(list) {
  const parts = [];
  for (const t of list) {
    parts.push(t.id, cleanThreadTitle(t),
               relDate(t.updated_at_ms || (t.updated_at ? t.updated_at * 1000 : 0)),
               t.cwd || '', t.git_branch || '',
               t.accountNum == null ? '' : String(t.accountNum));
  }
  return parts.join('');
}

// Invalida o memo quando st.allThreads é alterado por fora (rename, delete).
// Sem isso o próximo refreshThreads() compararia contra uma assinatura que já
// não corresponde ao DOM.
function invalidateSidebarCache() { _sidebarDataSig = null; }

async function refreshThreads() {
  if (_refreshInFlight) return _refreshInFlight;
  if (Date.now() - _refreshLastAt < REFRESH_MIN_MS) return false;
  _refreshInFlight = (async () => {
    try {
      const fresh = await api.listThreads(null, null);
      if (!Array.isArray(fresh)) return false;
      st.allThreads = fresh;
      const sig = _sidebarDataSignature(fresh);
      if (sig === _sidebarDataSig) return false;   // nada visível mudou → não redesenha
      _sidebarDataSig = sig;
      renderProjectList();
      return true;
    } catch { return false; }
    finally { _refreshLastAt = Date.now(); _refreshInFlight = null; }
  })();
  return _refreshInFlight;
}

// Provisional sidebar rows for freshly-spawned threads. Between "New Thread"
// and the first turn, codex hasn't inserted a DB row yet, so the sidebar had
// NOTHING to highlight — the user got no visual anchor that a thread exists.
// Synthesize one per live provisional spawn ("new-…" ids); it disappears on
// its own once the background latch swaps in the real threadId.
function _provisionalThreads() {
  const out = [];
  const entries = Object.entries(st.spawnByThread || {});
  // Spawns que JÁ têm uma thread real apontando para eles. O latch normalmente
  // apaga o self-mapping, mas se ele sobreviver (respawn, latch concorrente) a
  // linha provisória "New task" fica ao lado da linha real do MESMO PTY — a
  // duplicata que aparecia no topo da lista.
  const latchedSpawns = new Set(entries.filter(([tid, sid]) => tid !== sid).map(([, sid]) => sid));
  for (const [tid, spawnId] of entries) {
    if (tid !== spawnId || !String(tid).startsWith('new-')) continue;      // latched or resumed → real row exists
    if (latchedSpawns.has(spawnId)) continue;                               // já tem linha real
    if (!st.termRunning[spawnId]) continue;                                 // dead spawn → don't resurrect
    const accNum = st.spawnAccount ? st.spawnAccount[spawnId] : null;
    out.push({
      id: tid,
      accountNum: accNum,
      title: 'New task',
      first_user_message: '',
      cwd: st.spawnCwd ? st.spawnCwd[spawnId] : null,
      updated_at_ms: Date.now(),
      __provisional: true,
    });
  }
  return out;
}

// Rótulo de seção da sidebar.
function _sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'sidebar-section-label';
  el.textContent = text;
  return el;
}

// Rótulo curto do provider na linha 2 da task (2026-09-07). Espelha os ids de
// agents/registry.js; um id desconhecido aparece cru em vez de sumir.
const _PROVIDER_LABELS = { codex: 'Codex', claude: 'Claude', aider: 'Aider', grok: 'Grok', opencode: 'OpenCode', openrouter: 'OpenRouter' };
function _providerLabel(id) { return _PROVIDER_LABELS[id] || (id ? String(id) : ''); }

// ── Posição de scroll da sidebar ─────────────────────────────────────────────
// #projectList é reconstruído INTEIRO (innerHTML='') a cada render. Um rebuild
// com o mesmo conteúdo preserva scrollTop, mas um render transitoriamente mais
// CURTO faz o Chromium clampar scrollTop pro máximo que a lista curta permite —
// e o render seguinte, já com a lista inteira de volta, herda esse zero.
//
// Era isso que rebobinava a barra lateral a cada clique: `list-threads`
// (main.js) devolve a lista INCOMPLETA quando o sqlite de um perfil está
// travado por uma CLI viva — o erro por perfil é engolido num `catch {}` —, e
// clicar numa task é exatamente o que acorda o PTY que trava o banco.
//
// Guardamos a posição QUERIDA pelo usuário e a reaplicamos depois de cada
// rebuild. Uma posição que só existe porque a lista encolheu (está grudada no
// fim rolável) NÃO vira alvo novo: senão o clamp de um render ruim viraria a
// verdade e a informação original se perderia.
let _sidebarScrollWanted = 0;

function _sidebarScrollCapture(list) {
  const atual = list.scrollTop;
  const max = Math.max(0, list.scrollHeight - list.clientHeight);
  if (atual >= max - 1 && _sidebarScrollWanted > atual) return;   // clamp: mantém o alvo
  _sidebarScrollWanted = atual;
}

function _sidebarScrollRestore(list) {
  if (list.scrollTop !== _sidebarScrollWanted) list.scrollTop = _sidebarScrollWanted;
}

function _renderProjectListImpl() {
  const container = document.getElementById('projectList');
  if (!container) return;
  _sidebarScrollCapture(container);
  try { _renderProjectListBody(); }
  finally { _sidebarScrollRestore(container); }
}

// 2026-10-10: a sidebar mostra SÓ as sessões abertas (os panes do grid). O
// Carlos não retoma sessões antigas, então a lista de Projects/Tasks saiu da
// tela. st.allThreads continua sendo carregado: é de lá que os panes tiram o
// nome. Um clique foca o pane (onThreadClick).
function _renderProjectListBody() {
  const container = document.getElementById('projectList');
  container.innerHTML = '';
  const byId = new Map(_provisionalThreads().concat(st.allThreads || []).map(t => [t.id, t]));
  const ids = typeof computeVisibleGridIds === 'function' ? computeVisibleGridIds() : (st.gridMode.threadIds || []);
  const open = ids.map(id => byId.get(id)).filter(Boolean);
  if (!open.length) {
    const empty = document.createElement('div');
    empty.className = 'proj-empty';
    empty.textContent = kc('Nenhuma sessão aberta. ⌘N cria uma.');
    container.appendChild(empty);
    return;
  }
  container.appendChild(_sectionLabel('Sessões abertas'));
  const section = document.createElement('div');
  section.className = 'proj-section flat-section';
  const tc = document.createElement('div');
  tc.className = 'proj-threads';
  open.forEach(t => tc.appendChild(buildThreadRow(t)));
  section.append(tc);
  container.appendChild(section);
}

// Ícone do "retomar aqui": uma seta entrando numa caixa. Inline em vez de
// arquivo porque toda a sidebar desenha assim (ver renameBtn/delBtn).
function _svgAdopt() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '11'); svg.setAttribute('height', '11');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ['M9 2h4a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9', 'M2 8h7', 'M6.5 5L9.5 8l-3 3']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Continuar ESTA conversa na conta que está selecionada agora.
 *
 * O caso real: a conta dona estourou a quota no meio do trabalho. Trocar o dono
 * sozinho não resolveria — `codex resume <id>` procura a sessão dentro do
 * $CODEX_HOME do perfil, então a conta nova não a acharia. O main copia o
 * rollout e manda o codex ingerir (ver agents/rollout-adopt.js); no Claude não
 * há o que mover, porque o HOME é o real e compartilhado.
 *
 * Depois da adoção o pane é respawnado NA CONTA NOVA: matar o PTY antigo é
 * parte do gesto — deixá-lo vivo manteria a task consumindo a quota que acabou.
 */
async function adoptThreadHere(thread, destAcc) {
  const nome = destAcc.name || ('Profile ' + destAcc.num);
  const ownerNum = getThreadEffectiveOwner(thread);
  const provider = thread.provider || 'codex';

  if (typeof showGridBanner === 'function') showGridBanner(`Moving this task to ${nome}…`);
  const res = await api.threadAdoptProfile({
    sessionId: thread.id, provider, fromAccount: ownerNum, toAccount: destAcc.num,
  }).catch(err => ({ error: String(err && err.message || err) }));

  if (!res || res.error) {
    const msg = `Could not resume in ${nome}: ${(res && res.error) || 'unknown error'}`;
    if (typeof showGridBanner === 'function') showGridBanner(msg, 'warn'); else alert(msg);
    return;
  }

  st.threadOwners[thread.id] = destAcc.num;

  // O PTY antigo roda com as credenciais da conta velha — é ele que está sem
  // quota. Derruba e sobe de novo, agora sob a conta nova.
  const oldSpawn = st.spawnByThread[thread.id];
  if (oldSpawn && st.termRunning[oldSpawn]) {
    killTerminalForSpawn(oldSpawn);
    delete st.spawnByThread[thread.id];
  }
  if (typeof setActiveProfile === 'function') setActiveProfile(destAcc.num, { silent: true });
  renderProjectList();
  onThreadClick(thread);
  if (typeof showGridBanner === 'function') {
    showGridBanner(res.moved
      ? `Resumed in ${nome} — the conversation picks up where it left off.`
      : `Task now belongs to ${nome}.`);
  }
}

// Legenda do dot de estado da sidebar. Fonte ÚNICA dos rótulos: o dot é um
// círculo de 8px sem texto, então o tooltip é a única explicação que existe —
// e era o que faltava ("bolinha branca e vazia que não sei o que é",
// 2026-09-09). Os estados vêm de evalSpawnState() (core.js).
const THREAD_STATE_LABEL = {
  idle:    'No live session — click to resume',
  active:  'Session open, waiting on you',
  working: 'Working right now',
  done:    'Finished',
  error:   'Exited with error',
};

// Linha de thread da sidebar — compartilhada pelas seções de projeto, Recent,
// busca e lista única. Mantém as classes/datasets que updateWorkingIndicators
// e onThreadClick esperam (.thread-item[data-thread-id], .th-dot[data-acc]).
function buildThreadRow(thread) {
      const isWorktree = thread.git_branch && thread.git_branch !== 'main' && thread.git_branch !== 'master';
      const isSelected = thread.id === st.selectedThreadId;

      const item = document.createElement('div');
      item.className = 'thread-item' +
        (isWorktree ? ' worktree' : '') +
        (isSelected ? ' active' : '');
      item.dataset.threadId = thread.id;
      item.dataset.acc = thread.accountNum;

      // Branch icon only when this thread's cwd has git. Threads in non-git
      // projects (like $HOME) show no icon at all — git/branch concepts
      // don't apply there.
      const icon = document.createElement('span');
      icon.className = 'th-icon';
      const _gitForThread = thread.cwd ? _gitInfoByCwd[thread.cwd] : null;
      if (_gitForThread && _gitForThread.hasGit) {
        icon.appendChild(makeBranchIcon(thread.git_branch));
      }

      // Provider da thread (codex/claude/aider…): o <img> por linha morreu —
      // a linha fica enxuta e o provider vai pro tooltip (dataset.fullTitle).
      const _provider = thread.provider
        || (thread.accountNum != null
            ? ((st.accounts.find(a => a.num === thread.accountNum) || {}).authMode === 'openrouter' ? 'aider'
              : (st.accounts.find(a => a.num === thread.accountNum) || {}).authMode === 'claude' ? 'claude'
              : 'codex')
            : 'codex');

      const info = document.createElement('div');
      info.className = 'th-info';

      const text = document.createElement('span');
      text.className = 'th-text';
      const _fullTitle = cleanThreadTitle(thread);
      text.textContent = _fullTitle;
      // Full name on hover (rail truncates aggressively) via the custom tooltip
      // delegated on #projectList — stash the untruncated title on the row.
      item.dataset.fullTitle = _fullTitle;
      // Provider no tooltip (o tooltip renderiza via textContent — seguro).
      item.dataset.fullTitle += '  ·  ' + _provider;

      // Linha 2 da task: "Agente · CONTA · branch" (2026-09-09).
      //
      // Até aqui o dono existia SÓ como a cor do dot da direita, e o dot também
      // codificava o estado da sessão e ainda era o botão de trocar dono: três
      // significados num círculo de 8px, sem legenda. O print do Carlos ("bolinha
      // branca e vazia que não sei o que é") é exatamente esse acúmulo. Agora o
      // dono é TEXTO, com o ponto colorido da conta ao lado, e é ele quem abre o
      // seletor de dono; o dot da direita ficou só com o estado.
      const subtitle = document.createElement('span');
      subtitle.className = 'th-acc';
      const _branchTxt = (_gitForThread && _gitForThread.hasGit)
        ? (thread.git_branch || _gitForThread.branch || '')
        : '';
      const _ownerNum = getThreadEffectiveOwner(thread);
      const _ownerAcc = _ownerNum != null ? st.accounts.find(a => a.num === _ownerNum) : null;
      subtitle.append(_providerLabel(_provider));
      if (_ownerAcc) {
        subtitle.append(' · ');
        const ownerChip = document.createElement('span');
        ownerChip.className = 'th-owner';
        ownerChip.title = 'Task owner — click to change';
        const ochip = document.createElement('span');
        ochip.className = 'th-owner-dot';
        if (_ownerAcc.color) ochip.style.background = _ownerAcc.color;
        ownerChip.append(ochip, _ownerAcc.name || ('Perfil ' + _ownerAcc.num));
        ownerChip.addEventListener('click', e => { e.stopPropagation(); openOwnerPicker(thread, ownerChip); });
        subtitle.append(ownerChip);
      }
      if (_branchTxt) subtitle.append(' · ' + _branchTxt);

      const textWrap = document.createElement('span');
      textWrap.className = 'th-text-wrap';
      textWrap.append(text);
      info.append(textWrap);
      if (subtitle.textContent) info.append(subtitle);

      const right = document.createElement('div');
      right.className = 'th-right';

      const date = document.createElement('span');
      date.className = 'th-date';
      date.textContent = relDate(thread.updated_at_ms || thread.updated_at * 1000);

      // Dot da direita = ESTADO DA SESSÃO, e só isso (2026-09-09). O dono
      // mudou-se para o chip de texto da linha 2; a cor da conta não pinta mais
      // este círculo, senão "que cor é essa" volta a valer por dois eixos.
      const wdot = document.createElement('div');
      wdot.className = 'th-dot';
      wdot.dataset.acc = thread.accountNum;
      wdot.dataset.threadId = thread.id;
      wdot.dataset.state = 'idle';
      wdot.title = THREAD_STATE_LABEL.idle;

      const actions = document.createElement('div');
      actions.className = 'th-actions';
      const renameBtn = document.createElement('button');
      renameBtn.className = 'th-action-btn';
      renameBtn.title = 'Rename';
      renameBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 1l4 4-9 9H2v-4z"/></svg>';
      renameBtn.addEventListener('click', e => { e.stopPropagation(); renameThreadInline(thread, item); });
      const delBtn = document.createElement('button');
      delBtn.className = 'th-action-btn th-action-del';
      delBtn.title = 'Delete';
      delBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V2h4v2M5 4l1 10h4l1-10"/></svg>';
      delBtn.addEventListener('click', e => { e.stopPropagation(); deleteThreadConfirm(thread); });
      // Norya Grid "+" button removed (per user preference 2026-05-25).
      // Thread clicks add to grid via onThreadClick when in grid mode.
      actions.append(renameBtn, delBtn);

      // "Retomar aqui" (2026-09-09) — continuar ESTA conversa na conta que está
      // selecionada agora. É o gesto de quando a conta dona estoura a quota.
      // Fica FORA de .th-actions porque aquele bloco só aparece no hover, e este
      // botão precisa ser visível para ser descoberto. Ver openOwnerPicker para
      // a troca de dono "seca" (sem mover a sessão), que continua existindo.
      const _activeAcc = st.accounts.find(a => a.num === st.activeProfileNum);
      let adoptBtn = null;
      if (_activeAcc && _ownerNum != null && _ownerNum !== _activeAcc.num) {
        adoptBtn = document.createElement('button');
        adoptBtn.className = 'th-adopt';
        adoptBtn.title = `Resume this task in "${_activeAcc.name || ('Profile ' + _activeAcc.num)}"`
                       + ' — same conversation, different account';
        adoptBtn.appendChild(_svgAdopt());
        adoptBtn.addEventListener('click', e => { e.stopPropagation(); adoptThreadHere(thread, _activeAcc); });
      }

      right.append(date);
      if (adoptBtn) right.append(adoptBtn);
      right.append(wdot, actions);
      item.append(icon, info, right);
      item.addEventListener('click', () => onThreadClick(thread));
      return item;
}

// ── Working indicator ─────────────────────────────────────────────────────────
// Heurística pra decidir se uma PTY está realmente trabalhando vs idle.
// Antes a gente usava só "there was output in the last 2s" — mas claude/codex
// TUIs piscam cursor + refrescam input box mesmo idle (sai <50 bytes por seg).
// Agora exige VOLUME: pelo menos 300 bytes nos últimos 1.5s OU keywords de
// thinking no buffer recente.
const _SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\bThinking\b|\bConcocting\b|\bGenerating\b|Esc to interrupt/i;
function evalSpawnState(spawnId) {
  if (!spawnId) return 'idle';
  const now = Date.now();
  if (!st.termRunning[spawnId]) {
    if (st.exitedWithError[spawnId] && st.exitedAt[spawnId] && (now - st.exitedAt[spawnId] < 120000)) return 'error';
    return st.exitedAt[spawnId] ? 'done' : 'idle';
  }
  // Chat: o estado vem do protocolo (turno aberto), não de bytes de terminal.
  if (st.spawnUi[spawnId] === 'chat') return NoryaChat.isBusy(spawnId) ? 'working' : 'active';
  const win = st.outputWindow[spawnId] || [];
  let recentBytes = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    if (now - win[i].ts > 1500) break;
    recentBytes += win[i].bytes;
  }
  if (recentBytes >= 300) return 'working';
  // Buffer tail check — catches the "Thinking..." / spinner case where the
  // agent has been streaming a single-line indicator for a while.
  const buf = st.termBuffers[spawnId] || '';
  if (buf.length) {
    const tail = buf.length > 1500 ? buf.slice(-1500) : buf;
    if (_SPINNER_RE.test(tail) && (now - (st.lastOutputTime[spawnId] || 0)) < 2500) return 'working';
  }
  return 'active';
}

function updateWorkingIndicators() {
  // Roda a cada 700 ms com a janela visível, então TODA escrita aqui é paga
  // 1,4×/s por dot. Desde 2026-09-08 só escreve o que MUDOU: reatribuir o
  // mesmo dataset/textContent/background invalida o estilo do elemento do
  // mesmo jeito e obriga o recálculo, mesmo quando o valor é idêntico.
  // Sidebar thread dots. A linha nasce 'idle' e é ESTE tick quem vê o PTY
  // ligar: no caminho comum o usuário clica a thread depois do build da lista,
  // e nada a reconstrói. Desde 2026-09-09 o dot só carrega estado, então o
  // índice por id (que existia para achar o dono e pintar a cor) saiu junto.
  document.querySelectorAll('.th-dot[data-thread-id]').forEach(dot => {
    const tid = dot.dataset.threadId;
    const spawnId = st.spawnByThread[tid];
    const state = evalSpawnState(spawnId);
    if (dot.dataset.state !== state) dot.dataset.state = state;
    const marca = state === 'error' ? '!' : '';
    if (dot.textContent !== marca) dot.textContent = marca;
    // Legenda do estado no tooltip. O dot não carrega mais a cor do dono
    // (2026-09-09) — quem diz de quem é a task é o chip da linha 2.
    const rotulo = THREAD_STATE_LABEL[state] || THREAD_STATE_LABEL.idle;
    if (dot.title !== rotulo) dot.title = rotulo;
  });
  // Grid cell state dots
  document.querySelectorAll('.grid-cell[data-thread]').forEach(cell => {
    const tid = cell.dataset.thread;
    const spawnId = st.spawnByThread[tid];
    const stateDot = cell.querySelector('.grid-cell-dot');
    if (!stateDot) return;
    const state = evalSpawnState(spawnId);
    if (stateDot.dataset.state !== state) stateDot.dataset.state = state;
  });
}

// ── Thread rename / delete ────────────────────────────────────────────────────
function renameThreadInline(thread, itemEl) {
  const textEl = itemEl.querySelector('.th-text');
  if (!textEl) return;
  const original = textEl.textContent;
  textEl.contentEditable = 'true';
  textEl.classList.add('editing');
  textEl.focus();
  const range = document.createRange(); range.selectNodeContents(textEl);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const finish = async (commit) => {
    textEl.contentEditable = 'false';
    textEl.classList.remove('editing');
    const newTitle = textEl.textContent.trim();
    if (!commit || !newTitle || newTitle === original) {
      textEl.textContent = original;
      return;
    }
    const res = await api.renameThread(thread.accountNum, thread.id, newTitle);
    if (res && res.error) {
      alert('Rename failed: ' + res.error);
      textEl.textContent = original;
      return;
    }
    thread.title = newTitle;
    try { st.allThreads = await api.listThreads(null, null) || []; invalidateSidebarCache(); renderProjectList(); } catch {}
  };
  textEl.addEventListener('blur', () => finish(true), { once: true });
  textEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

async function deleteThreadConfirm(thread) {
  const title = thread.title || thread.first_user_message || 'this session';
  if (!confirm(`Delete "${title}"?\n\nThis removes it from Norya and deletes the codex session file. Cannot be undone.`)) return;
  const res = await api.deleteThread(thread.accountNum, thread.id);
  if (res && res.error) { alert('Delete failed: ' + res.error); return; }
  try { st.allThreads = await api.listThreads(null, null) || []; invalidateSidebarCache(); renderProjectList(); } catch {}
  if (st.selectedThreadId === thread.id) {
    st.selectedThreadId = null;
    showEmptyState();
    updateHeader();
  }
}

// ── Thread selection ──────────────────────────────────────────────────────────
// A trava de "1 PTY codex por conta no grid" morreu em 2026-07-10. O backend
// já tinha liberado (2476f7c: dois codex no mesmo HOME sobem limpos, ver
// test/smoke-multi-codex.js); esta era a metade renderer, órfã. Os tetos que
// restam são MAX_WORKING_PER_PROJECT (main.js) e GRID_MAX_PANES.

// Sidebar display title: strip the harness command wrappers and a
// leading Caveat: line that sometimes get captured as a threads first message,
// and collapse a bare session UUID to a friendly label. Cosmetic only.
function cleanThreadTitle(thread) {
  let raw = (thread && (thread.title || thread.first_user_message)) || "";
  raw = String(raw)
    // Blocos pareados primeiro (senão o CONTEÚDO do wrapper sobrevive ao strip
    // de tags e vira "título") — mesma lógica do claude-meta.js no main.
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, " ")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, " ")
    .replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/gi, " ")
    .replace(/<\/?(?:local-command-[a-z-]*|command-name|command-message|command-args)>/gi, " ")
    .replace(/\[Image #\d+\]/gi, " ")
    .replace(/\[Image: source: [^\]]*\]/gi, " ")
    .replace(/^\s*Caveat:\s.*$/im, " ")
    .replace(/\s+/g, " ").trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{8,}$/i.test(raw)) raw = "";
  if (raw) return raw;
  // Untitled fallback: stamp the time so two untitled threads are
  // distinguishable in the list (plain "Session" twice told the user nothing).
  const ts = thread && (thread.updated_at_ms || (thread.updated_at ? thread.updated_at * 1000 : 0));
  if (ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return 'Session · ' + hh + ':' + mm;
  }
  return "Session";
}

async function onThreadClick(thread) {
  hideNewThreadPanel();

  // Troca silenciosa pro dono da thread (invariante: ver thread ⇒ perfil ativo = dono).
  const _ownerNum = getThreadEffectiveOwner(thread);
  if (_ownerNum != null && _ownerNum !== st.activeProfileNum) {
    const ownerAcc = st.accounts.find(a => a.num === _ownerNum);
    if (ownerAcc) setActiveProfile(_ownerNum, { silent: true });
  }
  noteThreadInteraction(thread.id);
  st.selectedThreadId = thread.id;
  if (thread.accountNum != null) st.selectedAccountNum = thread.accountNum;
  document.querySelectorAll('.thread-item').forEach(el =>
    el.classList.toggle('active', el.dataset.threadId === thread.id));

  // Grid é a única view: clicar = garantir pane + PTY + foco.
  if (!st.gridMode.threadIds.includes(thread.id)) addThreadToGrid(thread.id);
  const sid = st.spawnByThread[thread.id];
  if (!(sid && st.termRunning[sid])) {
    gridSpawnThread(thread);           // resolve perfil pelo provider da thread
  }
  if (typeof renderGrid === 'function') renderGrid();
  setGridFocus(thread.id);
  updateHeader();
  updateInputState();
  setTimeout(() => {
    const cell = document.querySelector(`.grid-cell[data-thread="${thread.id}"]`);
    if (cell) cell.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 80);
}

// ── Terminal management ───────────────────────────────────────────────────────
// launchTerminal now spawns a PTY identified by a per-thread spawnId, so the
// same account can have multiple PTYs running in parallel — one per thread.
// opts.spawnId: required for new threads (generated by caller).
//               For resume mode, defaults to opts.sessionId.
/**
 * Grava o agente desta thread, agora que o id real existe (o latch acabou de
 * trocar o id provisório pelo definitivo).
 *
 * Só grava escolha EXPLÍCITA. Em "Automático" não há registro, e a thread segue
 * o authMode do perfil — que é como tudo funcionava antes do seletor existir.
 */
function persistThreadAgent(threadId, spawnId) {
  const agente = st.spawnAgent[spawnId];
  if (!agente || !threadId) return;
  st.threadAgents[threadId] = agente;
  api.threadAgentSet(threadId, agente).catch(e => console.warn('thread-agent-set', e));
}

function launchTerminal(acc, opts) {
  opts = Object.assign({}, opts || {});

  // Qual CLI roda este spawn. Ponto ÚNICO de injeção: os call-sites herdam.
  //
  // Precedência:
  //   1. agentId explícito do chamador;
  //   2. o agente GRAVADO desta thread — uma thread não troca de CLI depois de
  //      criada; reabrir uma thread de Codex com o Claude perderia o histórico;
  //   3. a escolha atual do seletor (para threads novas);
  //   4. nada → o main resolve pelo authMode do perfil ("Automático").
  //
  // No resume, `opts.spawnId` é o próprio id da thread — daí a consulta direta.
  const agenteGravado = opts.spawnId ? st.threadAgents[opts.spawnId] : null;
  const agente = opts.agentId || agenteGravado || st.selectedAgentId || null;
  if (agente) opts.agentId = agente;
  // O id real da thread só chega no latch; guardamos por spawnId até lá.
  if (opts.spawnId) st.spawnAgent[opts.spawnId] = agente;

  // Validate cwd for new-folder mode. If the project dir was deleted/moved,
  // codex would spawn but fail with "No such file or directory (os error 2)"
  // before printing anything useful — looks like a Norya bug. Catch it here:
  // alert the user, prune the stale entry from recent-folders, and open a
  // sync folder picker so they can pick a replacement in one shot.
  if (opts.mode === 'new-folder' && opts.cwd) {
    let cwdExists = false;
    try { cwdExists = require('fs').existsSync(opts.cwd); } catch {}
    if (!cwdExists) {
      const missing = opts.cwd;
      // Prune the stale path from the recents list so this doesn't re-trigger.
      try {
        const recents = JSON.parse(localStorage.getItem('norya-recent-folders') || '[]');
        const cleaned = recents.filter(p => p !== missing);
        if (cleaned.length !== recents.length) {
          localStorage.setItem('norya-recent-folders', JSON.stringify(cleaned));
        }
      } catch {}
      window.alert(
        `The project folder no longer exists:\n\n${missing}\n\n` +
        `I will open the picker so you can choose another folder.`
      );
      const folder = ipcRenderer.sendSync('pick-folder-sync');
      if (!folder) return null;  // user cancelled the picker
      opts.cwd = folder;
      opts.projectId = (typeof folderToProjectId === 'function') ? folderToProjectId(folder) : opts.projectId;
      try { rememberFolder && rememberFolder(folder); } catch {}
    }
  }

  // TUI ou chat. Precedência: pedido explícito → como a thread foi aberta da
  // última vez → o seletor da sidebar. Chat só existe pra Claude e Codex; o
  // "Automático" resolve pelo authMode do perfil (espelho de agents.js).
  const agenteEfetivo = agente || (acc.authMode === 'claude' ? 'claude'
    : (acc.authMode === 'openrouter' ? 'aider' : 'codex'));
  let ui = opts.ui || (opts.sessionId && st.threadUi[opts.sessionId]) || st.paneUi || 'tui';
  if (ui === 'chat' && agenteEfetivo !== 'claude' && agenteEfetivo !== 'codex') ui = 'tui';
  opts.ui = ui;

  if (st.selectedModel && !opts.model) opts.model = st.selectedModel;
  if (st.reasoningEffort && !opts.reasoningEffort) opts.reasoningEffort = st.reasoningEffort;
  if (opts.fastMode == null) opts.fastMode = !!st.fastMode;
  if (opts.fullAccess == null) opts.fullAccess = !!st.fullAccess;
  if (opts.webSearch == null) opts.webSearch = !!st.webSearch;

  // Resolve spawnId: prefer explicit, then sessionId (resume), then a fresh one
  const spawnId = opts.spawnId
    || (opts.mode === 'resume' && opts.sessionId)
    || ('new-' + acc.num + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  opts.spawnId = spawnId;
  st.spawnAccount[spawnId] = acc.num;
  // Track cwd so the input bar folder pill can display + change it.
  if (opts.cwd) st.spawnCwd[spawnId] = opts.cwd;
  // If we know a threadId for this PTY, remember it too
  if (opts.sessionId) st.spawnByThread[opts.sessionId] = spawnId;

  // Tear down any old listener for this spawnId (re-launch case)
  if (st.termListeners[spawnId]) { st.termListeners[spawnId](); delete st.termListeners[spawnId]; }
  delete st.releaseOnExit[spawnId]; // spawn novo (resume reaproveita o spawnId): nada a liberar
  st.termBuffers[spawnId] = '';
  delete st.termSizes[spawnId];
  st.termHistory[spawnId] = NoryaTermReplay.createHistory();
  st.termRunning[spawnId] = true;
  delete st.exitedAt[spawnId];
  delete st.exitedWithError[spawnId];
  st.spawnUi[spawnId] = ui;
  if (ui === 'chat') NoryaChat.attach(spawnId, agenteEfetivo);
  else NoryaChat.detach(spawnId);

  const TERM_TAIL_MAX = 4000;

  let _onDataCallCount = 0;
  const onData = (_, data) => {
    st.termHistory[spawnId].write(data);
    // st.termBuffers NÃO é mais o stream inteiro (o replay vem de termHistory,
    // acima): é só a CAUDA, para as heurísticas de estado (spinner slice(-1500),
    // prompt slice(-500/-400), "tem saída" length>0, "pronto" length>=800). Antes
    // duplicava ~256K chars por pane. Corte amortizado: passa de 5000 e volta a 4000.
    const cur = (st.termBuffers[spawnId] || '') + data;
    st.termBuffers[spawnId] = cur.length > TERM_TAIL_MAX * 1.25 ? cur.slice(-TERM_TAIL_MAX) : cur;
    const now = Date.now();
    st.lastOutputTime[spawnId] = now;
    // Track output volume in a rolling 3s window — used by evalSpawnState to
    // distinguish "agent thinking/producing" from "TUI cursor blink".
    if (!st.outputWindow[spawnId]) st.outputWindow[spawnId] = [];
    st.outputWindow[spawnId].push({ ts: now, bytes: data.length });
    // Prune entries older than 3s
    while (st.outputWindow[spawnId].length && now - st.outputWindow[spawnId][0].ts > 3000) {
      st.outputWindow[spawnId].shift();
    }
    _onDataCallCount++;
    // Debug-only: this logs through wrapConsole → main IPC → panel.log on a hot
    // per-chunk path. Gate it so a chatty agent doesn't spam the log/IPC.
    if (window.__noryaDebug && (_onDataCallCount <= 3 || _onDataCallCount % 10 === 0)) {
      console.log(`[onData ${spawnId}] call #${_onDataCallCount}, buf=${st.termBuffers[spawnId].length}b, sample:`,
        st.termBuffers[spawnId].slice(-180).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
    }
    // Keep existing single views current, but never create one behind the grid.
    if (xtermInstances[spawnId] || (document.getElementById('app').dataset.view !== 'grid' && st.selectedThreadId && st.spawnByThread[st.selectedThreadId] === spawnId)) {
      try {
        const existing = xtermInstances[spawnId];
        const inst = existing || getOrCreateXterm(spawnId);
        // xterm follows output only when the user was already at the tail.
        // `rows` é a régua: subida >= rows só acontece quando o frame do agente
        // não coube na tela, e daí todo remendo dele erra (tui-redraw.js).
        // A newly created view already replayed this chunk from history.
        const rows = st.termSizes[spawnId]?.rows || inst.term.rows;
        if (existing) inst.stream.write(data, () => inst.guardaRepintura?.aposEscrita({ data, rows }));
        if (document.getElementById('app').dataset.view !== 'grid' && st.spawnByThread[st.selectedThreadId] === spawnId) {
          // Only re-mount/hide on an ACTUAL active-spawn change, not every chunk.
          if (st._activeXtermSpawn !== spawnId) {
            showXtermFor(spawnId);
            document.getElementById('outputEmpty').classList.add('hidden');
            st._activeXtermSpawn = spawnId;
          }
        }
      } catch {}
    }
    updateGridCellById(spawnId);
  };

  const ERROR_PATTERNS = /error|failed|exception|crash|exit code [^0]/i;
  const onExit = () => {
    if (window.__noryaDebug) console.log(`[onExit ${spawnId}] PTY exited. buf tail:`,
      (st.termBuffers[spawnId] || '').slice(-400).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
    st.termRunning[spawnId] = false;
    st.exitedAt[spawnId] = Date.now();
    const lastOut = (st.termBuffers[spawnId] || '').slice(-500);
    st.exitedWithError[spawnId] = ERROR_PATTERNS.test(lastOut) && !st.userKilled[spawnId];
    delete st.userKilled[spawnId];
    if (st.releaseOnExit[spawnId]) releaseSpawnBuffers(spawnId);
    ipcRenderer.removeListener(`terminal-data-${spawnId}`, onData);
    delete st.termListeners[spawnId];
    updateDotForAccount(acc.num);
    renderAccountItem(acc.num);
    updateHeader();
    updateInputState();
    if (document.getElementById('app').dataset.view === 'grid') renderGrid();
  };

  const dataCh = `terminal-data-${spawnId}`;
  const exitCh = `terminal-exit-${spawnId}`;
  ipcRenderer.on(dataCh, onData);
  ipcRenderer.once(exitCh, onExit);
  st.termListeners[spawnId] = () => {
    ipcRenderer.removeListener(dataCh, onData);
    ipcRenderer.removeAllListeners(exitCh);
  };

  updateDotForAccount(acc.num);
  renderAccountItem(acc.num);
  updateHeader();
  updateInputState();
  api.spawnTerminal(acc, opts);
  return spawnId;
}

function updateDotForAccount(num) {
  // Legacy account dot at the bottom — show "running" if ANY PTY for this acc is running
  const dot = document.querySelector(`.acc-dot[data-dot="${num}"]`);
  if (!dot) return;
  dot.className = 'acc-dot' + (anyThreadRunningForAccount(num) ? ' running' : '');
}

// Per-spawnId grid cell updater (replaces old per-account one)
function updateGridCellById(spawnId) {
  // Hot path: called on every PTY data chunk. Skip the O(n) spawnByThread scan
  // entirely when the grid isn't even visible (the common case).
  if (document.getElementById('app').dataset.view !== 'grid') return;
  const threadId = Object.entries(st.spawnByThread).find(([, sid]) => sid === spawnId)?.[0];
  if (!threadId) return;
  const dot = document.querySelector(`.grid-cell[data-thread="${threadId}"] .grid-cell-dot`);
  if (!dot) return;
  dot.dataset.state = evalSpawnState(spawnId);
}

// Task encerrada pelo ×: os buffers do PTY (history + cauda + janela de saída +
// tamanho) não servem mais — retomar a task sobe um spawn novo que os zera em
// launchTerminal. Sem isto ficava ~1,3 MB retido por task encerrada até reiniciar.
function releaseSpawnBuffers(spawnId) {
  delete st.releaseOnExit[spawnId];
  delete st.termBuffers[spawnId];
  delete st.termHistory[spawnId];
  delete st.outputWindow[spawnId];
  delete st.termSizes[spawnId];
}

function killTerminalForSpawn(spawnId) {
  if (!st.termRunning[spawnId]) return;
  st.userKilled[spawnId] = true;
  api.killTerminal(spawnId);
  // Flip UI to "stopped" immediately so the dot/header/input don't lag behind the
  // click; onExit later confirms the same state (these calls are idempotent).
  st.termRunning[spawnId] = false;
  try { updateInputState(); } catch {}
  try { if (typeof updateDotForAccount === 'function') updateDotForAccount(st.selectedAccountNum); } catch {}
  try { if (typeof updateHeader === 'function') updateHeader(); } catch {}
}

// Legacy alias used by some buttons — finds the current thread's spawn and kills it
function killTerminalForNum(num) {
  const spawnId = st.selectedThreadId && st.spawnByThread[st.selectedThreadId];
  if (spawnId) { killTerminalForSpawn(spawnId); return; }
  if (!st.termRunning[num]) return;
  st.userKilled[num] = true;
  api.killTerminal(num);
}

// ── Output display ────────────────────────────────────────────────────────────





// ⌘\ "show terminal": garante o xterm visível e refaz o fit.
function toggleRawTerminal() {
  forceXtermView();
  Object.values(xtermInstances || {}).forEach(inst => { try { inst.resize.fitAndResize(); } catch {} });
}

function showOutputFor(num) {
  const empty = document.getElementById('outputEmpty');
  const ntpPanel = document.getElementById('newThreadPanel');
  const xtermHost = document.getElementById('xtermHost');
  const buf = st.termBuffers[num] || '';
  if (buf || st.termRunning[num]) {
    if (ntpPanel) ntpPanel.classList.add('hidden');
    if (xtermHost) xtermHost.style.display = '';
    showXtermFor(num);
    empty.classList.add('hidden');
  } else {
    document.querySelectorAll('.xterm-pane').forEach(p => p.classList.remove('active'));
    if (st.accounts.length) showNewThreadPanel();
    else showEmptyState();
  }
}

function showEmptyState() {
  const empty = document.getElementById('outputEmpty');
  const phrase = document.getElementById('emptyPhrase');
  const sub = document.getElementById('emptySub');

  if (!st.accounts.length) {
    if (phrase) phrase.textContent = 'Welcome to Norya';
    if (sub) sub.textContent = 'Add an account using the + button below.';
  } else {
    // Norya welcome phrase (same arena-spirit pool as the old landing).
    if (phrase) {
      phrase.textContent = (typeof INTRO_PHRASES !== 'undefined' && INTRO_PHRASES.length)
        ? INTRO_PHRASES[Math.floor(Math.random() * INTRO_PHRASES.length)]
        : 'Build something that matters.';
    }
    // New Thread is instant now (sidebar button + ⌘N) — no landing button.
    if (sub) sub.textContent = kc('Select a task, or press ⌘N for a new one.');
  }
  empty.classList.remove('hidden');
  syncInputAreaVisibility();
}

// Close the currently-open thread → back to the landing/empty state. The PTY is
// NOT killed: the session keeps running and the thread stays in the sidebar, so
// clicking it again reopens the live terminal (Stop is for actually ending it).
function closeOpenThread() {
  if (st.gridMode && st.gridMode.enabled) return;  // grid has its own per-pane controls
  st.selectedThreadId = null;
  // Deselect in the sidebar + hide every xterm pane.
  document.querySelectorAll('.thread-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.xterm-pane').forEach(p => p.classList.remove('active'));
  const xtermHost = document.getElementById('xtermHost');
  if (xtermHost) xtermHost.style.display = 'none';
  document.getElementById('app').dataset.view = 'single';
  showEmptyState();
  updateHeader();
  updateInputState();
}

// The bottom input bar is removed entirely (2026-06-22) — Norya is terminal-
// driven, so this keeps it hidden across every view transition (CSS enforces it
// too via .input-area { display:none !important }).
function syncInputAreaVisibility() {
  const inputArea = document.querySelector('.input-area');
  if (inputArea) inputArea.style.display = 'none';
}
