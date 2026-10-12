/**
 * renderer/pet.js — estado do Mini/pet (reescrito 2026-10-05).
 *
 * Só CALCULA; quem mostra é o helper nativo, via main (pet/pet-manager.js).
 * Spec: a spec interna do Mini (2026-10-05).
 *
 * Uma pílula por sessão relevante:
 *   running  = `__attention.inTurn(sid) === true` (só Claude/Codex; a heurística
 *              de bytes acenderia a cada redraw da TUI)
 *   waiting / failed / review = itens da fila de atenção (`__attention.queue`:
 *              waiting → waiting, error → failed, turn-end/done → review). A fila
 *              já some quando o usuário abre o pane ("lido").
 * Ordenadas pelo início do turno mais recente; o sprite segue a pílula do topo.
 * Subtítulo = atividade, vinda dos eventos que JÁ chegam (hook do Claude /
 * rollout do Codex): ação corrente, nº de arquivos editados no turno, resumo.
 *
 * Também executa o que o helper pede (`pet-action`): abrir task, dispensar,
 * silenciar, responder (colagem + Enter), parar (Esc) e abrir sessão nova.
 *
 * Leveza: nenhum timer novo — o setInterval de 2 s de sempre (reserva pra PTY
 * morto no meio do turno + expiração das pílulas) e o `agent-event`. Manda
 * `pet-state` só quando o conteúdo muda.
 *
 * Script clássico; carrega depois de attention.js (usa window.__attention).
 */
'use strict';

(() => {
  const { ipcRenderer } = require('electron');

  const EXPIRE_MS = { failed: 3600e3, waiting: 24 * 3600e3, review: 7 * 24 * 3600e3 };
  const START_TIMEOUT_MS = 60000;   // "Iniciando sua tarefa" → erro
  const ERROR_SHOW_MS = 15000;      // pílula de erro some sozinha
  const STEER_MS = 3000;            // "Direcionando" depois de responder a uma tarefa rodando
  const PET_OF_AGENT = { claude: 'clawd', codex: 'codex' };
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

  const since = new Map();       // spawnId → quando o vimos entrar em turno
  /** @type {Map<string, {seq:number, act:(object|null), files:number, summary:string, msg:string}>} */
  const turns = new Map();       // spawnId → atividade do turno corrente
  const dismissed = new Map();   // id da pílula → assinatura do turno dispensado
  const muted = new Set();       // threadIds silenciados (persistidos no main, pet.json)
  const steering = new Map();    // id → até quando mostrar "Direcionando"
  /** @type {Array<{key:string, spawnId:(string|null), text:string, ts:number, errAt:number}>} */
  let starts = [];
  let startSeq = 0;
  let lastPet = 'clawd';
  let last = '';

  // ── atividade ──────────────────────────────────────────────────────────────
  function turnOf(sid) {
    let t = turns.get(sid);
    if (!t) { t = { seq: 0, act: null, files: 0, summary: '', msg: '' }; turns.set(sid, t); }
    return t;
  }

  function onEvent(msg) {
    if (!msg || typeof msg.spawnId !== 'string') return;
    const sid = msg.spawnId;
    if (msg.kind === 'spawned') { turns.delete(sid); return; }
    const t = turnOf(sid);
    switch (msg.kind) {
      case 'turn-start':
        t.seq++; t.act = null; t.files = 0; t.summary = ''; t.msg = '';
        break;
      case 'working': {   // Claude (PreToolUse)
        if (!msg.tool) break;
        if (msg.tool === 'Bash') t.act = { type: 'cmd' };
        else if (EDIT_TOOLS.has(msg.tool)) { t.files += (msg.files || 1); t.act = { type: 'edit' }; }
        else if (msg.tool === 'WebSearch') t.act = { type: 'search', q: msg.q || '' };
        else if (msg.tool === 'WebFetch') t.act = { type: 'search', q: '' };
        else t.act = { type: 'tool', name: String(msg.tool).split('__').pop() };
        break;
      }
      case 'activity': {  // Codex (rollout)
        if (msg.act === 'cmd') t.act = { type: 'cmd' };
        else if (msg.act === 'edit') { t.files += (msg.n || 1); t.act = { type: 'edit' }; }
        else if (msg.act === 'tool') t.act = { type: 'tool', name: msg.name || 'ferramenta' };
        else if (msg.act === 'search') t.act = { type: 'search', q: msg.q || '' };
        else if (msg.act === 'think') t.act = { type: 'think', text: msg.text || '' };
        else if (msg.act === 'msg') t.msg = msg.text || '';
        break;
      }
      case 'turn-end':
        if (msg.summary) t.summary = msg.summary;
        break;
    }
  }

  const plural = (n, um, varios) => (n === 1 ? um : varios.replace('{n}', n));

  function runningSubtitle(sid) {
    const t = turns.get(sid);
    const a = t && t.act;
    if (!a) return 'Pensando';
    switch (a.type) {
      case 'cmd': return 'Executando o comando';
      case 'edit': return plural(t.files, 'Editando 1 arquivo', 'Editando {n} arquivos');
      case 'tool': return `Executando ${a.name}`;
      case 'search': return a.q ? `Pesquisou "${a.q}"` : 'Pesquisou na web';
      case 'think': return a.text ? (a.text.length > 60 ? a.text.slice(0, 59) + '…' : a.text) : 'Pensando';
      default: return 'Pensando';
    }
  }

  function reviewSubtitle(sid) {
    const t = turns.get(sid);
    if (!t) return 'Pronto';
    const resumo = t.summary || t.msg;
    if (resumo) return resumo.length > 140 ? resumo.slice(0, 139) + '…' : resumo;
    const a = t.act;
    if (!a) return 'Pronto';
    switch (a.type) {
      case 'cmd': return 'Executou o comando';
      case 'edit': return plural(t.files, '1 arquivo editado', '{n} arquivos editados');
      case 'tool': return `Executou ${a.name}`;
      case 'search': return a.q ? `Pesquisou "${a.q}"` : 'Pesquisou na web';
      default: return 'Pronto';
    }
  }

  // ── pílulas ────────────────────────────────────────────────────────────────
  function agentOf(sid) {
    const a = window.__attention;
    const r = a && a.spawnAgents && a.spawnAgents.get(sid);
    return (r && r.agent) || (st.spawnAgent && st.spawnAgent[sid]) || null;
  }

  function threadById(tid) {
    const provisorias = (typeof _provisionalThreads === 'function') ? _provisionalThreads() : [];
    return (st.allThreads || []).find(x => x.id === tid) || provisorias.find(x => x.id === tid) || null;
  }

  function titleOf(tid) {
    const t = threadById(tid);
    let s = (t && !t.__provisional) ? ((typeof cleanThreadTitle === 'function') ? cleanThreadTitle(t) : (t.title || '')) : '';
    if (!s || s === '(new task)') s = 'Novo chat';   // provisória ("New task") = Novo chat, como no Codex
    return s;
  }

  function sigOf(sid) { return `${sid}:${turns.get(sid) ? turns.get(sid).seq : 0}`; }

  const QUEUE_STATUS = { waiting: 'waiting', error: 'failed', 'turn-end': 'review', done: 'review' };

  function compute() {
    const a = window.__attention;
    if (!a || typeof a.inTurn !== 'function') return null;
    const now = Date.now();
    const pills = [];
    const alive = new Set();
    const runningSids = new Set();

    // Self-mapping provisório que sobreviveu ao latch (mesmo caso de
    // _provisionalThreads): sem isto o mesmo PTY virava 2 pílulas.
    const entries = Object.entries(st.spawnByThread || {});
    const latched = new Set(entries.filter(([tid, sid]) => tid !== sid).map(([, sid]) => sid));
    for (const [tid, sid] of entries) {
      if (!sid || !st.termRunning[sid] || a.inTurn(sid) !== true) continue;
      if (tid === sid && latched.has(sid)) continue;
      const agent = agentOf(sid);
      if (agent !== 'claude' && agent !== 'codex') continue;
      alive.add(sid);
      if (!since.has(sid)) since.set(sid, now);
      runningSids.add(sid);
      pills.push({ id: tid, sid, agent, status: 'running', t: since.get(sid), subtitle: runningSubtitle(sid) });
    }
    for (const sid of since.keys()) if (!alive.has(sid)) since.delete(sid);

    for (const [sid, item] of a.queue) {
      const status = QUEUE_STATUS[item.kind];
      if (!status || runningSids.has(sid) || !item.threadId) continue;
      if (now - item.ts > EXPIRE_MS[status]) continue;
      pills.push({
        id: item.threadId, sid, agent: agentOf(sid), status, t: item.ts,
        subtitle: status === 'review' ? reviewSubtitle(sid) : (status === 'waiting' ? 'Requer input' : 'Bloqueada'),
      });
    }

    // Sessão nova aberta pela barra de chat (sem abrir o Norya).
    starts = starts.filter(s => !(s.errAt && now - s.errAt > ERROR_SHOW_MS));
    for (const s of starts) {
      if (!s.errAt) {
        if (s.spawnId && a.inTurn(s.spawnId) === true) { s.done = true; continue; }
        if (now - s.ts > START_TIMEOUT_MS || (s.spawnId && !st.termRunning[s.spawnId])) s.errAt = now;
      }
      pills.push({
        id: s.key, sid: s.spawnId, agent: s.agent || null, t: s.ts,
        status: s.errAt ? 'error' : 'starting',
        title: s.errAt ? 'Não foi possível iniciar o chat' : 'Iniciando sua tarefa',
        subtitle: s.text,
      });
    }
    starts = starts.filter(s => !s.done);

    const out = [];
    for (const p of pills) {
      if (muted.has(p.id)) continue;
      if (p.sid && p.status !== 'starting' && p.status !== 'error') {
        if (dismissed.get(p.id) === sigOf(p.sid)) continue;
      } else if (dismissed.has(p.id)) continue;
      const aliveTerm = !!(p.sid && st.termRunning[p.sid]);
      const steer = steering.get(p.id);
      if (steer && now >= steer) steering.delete(p.id);
      out.push({
        id: p.id, sid: p.sid || null, status: p.status,
        title: p.title || titleOf(p.id),
        subtitle: (p.status === 'running' && steer && now < steer) ? 'Direcionando' : p.subtitle,
        agent: p.agent || null, t: p.t,
        canReply: aliveTerm && (p.status === 'running' || p.status === 'waiting' || p.status === 'review'),
        canStop: aliveTerm && p.status === 'running',
      });
    }
    out.sort((x, y) => y.t - x.t);   // início do turno mais recente primeiro

    // Poda a atividade de PTY que já morreu e não tem mais pílula.
    for (const sid of turns.keys()) if (!st.termRunning[sid] && !a.queue.has(sid)) turns.delete(sid);

    const top = out[0];
    if (top && PET_OF_AGENT[top.agent]) lastPet = PET_OF_AGENT[top.agent];   // idle mantém o último
    const SPRITE = { running: 'running', starting: 'running', waiting: 'waiting', failed: 'failed', error: 'failed', review: 'review' };
    return { pet: lastPet, sprite: top ? (SPRITE[top.status] || 'idle') : 'idle', pills: out };
  }

  function update() {
    let s;
    try { s = compute(); } catch (e) { console.warn('[pet]', e); return; }
    if (!s) return;
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    ipcRenderer.send('pet-state', s);
  }

  // ── ações do helper (via main) ─────────────────────────────────────────────
  function pillError(id, text) { ipcRenderer.send('pet-pill-error', { id, text }); }

  function spawnOf(id) {
    const s = starts.find(x => x.key === id);
    if (s) return s.spawnId;
    return (st.spawnByThread || {})[id] || null;
  }

  function openPill(id) {
    let tid = id;
    const s = starts.find(x => x.key === id);
    if (s && s.spawnId) {
      // Depois do latch o self-mapping some: acha a thread real que aponta pro spawn.
      const real = Object.entries(st.spawnByThread || {}).find(([t2, sid]) => sid === s.spawnId && t2 !== sid);
      tid = real ? real[0] : s.spawnId;
    } else if (s) tid = null;
    const t = tid && threadById(tid);
    if (t && typeof onThreadClick === 'function') {
      try { onThreadClick(t); } catch (e) { console.warn('[pet] open', e); }
    }
  }

  function reply(id, text) {
    const sid = spawnOf(id);
    if (!sid || !st.termRunning[sid]) return pillError(id, 'Não foi possível enviar a resposta');
    try {
      // Colagem (respeita o bracketed paste da TUI) e o Enter DEPOIS: Claude/Codex
      // tratam Enter colado no fim de uma rajada como quebra de linha, não envio
      const inst = (typeof xtermInstances !== 'undefined') ? xtermInstances[sid] : null;
      if (inst && inst.term && typeof inst.term.paste === 'function') inst.term.paste(text);
      else api.sendInput(sid, '\x1b[200~' + text + '\x1b[201~');
      setTimeout(() => { try { api.sendInput(sid, '\r'); } catch (e) { pillError(id, 'Não foi possível enviar a resposta'); } }, 180);
      const p = last && JSON.parse(last).pills.find(x => x.id === id);
      if (p && p.status === 'running') { steering.set(id, Date.now() + STEER_MS); update(); }
    } catch (e) { console.warn('[pet] reply', e); pillError(id, 'Não foi possível enviar a resposta'); }
  }

  function stop(id) {
    const sid = spawnOf(id);
    if (!sid || !st.termRunning[sid]) return pillError(id, 'Não foi possível parar a atividade');
    // Esc interrompe o turno no Claude e no Codex.
    try { api.sendInput(sid, '\x1b'); } catch (e) { pillError(id, 'Não foi possível parar a atividade'); }
  }

  /** Perfil logado cujo agente aceita prompt inicial: o ativo primeiro. */
  function pickProfile() {
    let reg = null;
    try { reg = require('./agents/registry'); } catch {}
    const logged = (st.accounts || []).filter(a => !(st.quota && st.quota[String(a.num)] && st.quota[String(a.num)].loggedOut === true));
    logged.sort((x, y) => (y.num === st.activeProfileNum) - (x.num === st.activeProfileNum));
    for (const acc of logged) {
      const agentId = reg ? reg.resolveAgentId(acc.authMode || null, null) : 'codex';
      if (agentId === 'claude' || agentId === 'codex') return { acc, agentId };
    }
    return null;
  }

  async function newChat(text) {
    const key = 'start-' + (++startSeq);
    const entry = { key, spawnId: null, text: text.length > 140 ? text.slice(0, 139) + '…' : text, ts: Date.now(), errAt: 0, agent: null };
    starts.push(entry);
    try {
      const pick = pickProfile();
      if (!pick) throw new Error('sem perfil de Claude/Codex logado');
      entry.agent = pick.agentId;
      const sid = await createThreadInFolder(require('os').homedir(), {
        profileNum: pick.acc.num, agentId: pick.agentId, skipGitPrompt: true, initialPrompt: text,
      });
      if (!sid) throw new Error('spawn falhou');
      entry.spawnId = sid;
    } catch (e) {
      console.warn('[pet] newChat', e);
      entry.errAt = Date.now();
    }
    update();
  }

  ipcRenderer.on('pet-action', (_, a) => {
    if (!a || typeof a.kind !== 'string') return;
    try {
      switch (a.kind) {
        case 'open': openPill(a.id); break;
        case 'dismiss': {
          const s = starts.find(x => x.key === a.id);
          if (s) starts = starts.filter(x => x !== s);
          else { const sid = spawnOf(a.id); dismissed.set(a.id, sid ? sigOf(sid) : '1'); }
          update(); break;
        }
        case 'mute': muted.add(a.id); update(); break;
        case 'reply': reply(a.id, String(a.text || '')); break;
        case 'stop': stop(a.id); break;
        case 'newChat': newChat(String(a.text || '')); break;
        case 'settings': if (typeof openSettings === 'function') openSettings('general'); break;
      }
    } catch (e) { console.warn('[pet] action', a.kind, e); }
  });

  // Depois do listener do attention.js (registrado antes), então inTurn já
  // reflete o evento.
  ipcRenderer.on('agent-event', (_, msg) => { onEvent(msg); update(); });
  ipcRenderer.invoke('pet-muted-get').then(ids => { for (const id of ids || []) muted.add(id); update(); }).catch(() => {});
  setInterval(update, 2000);

  window.__pet = { compute, update, onEvent, newChat, reply, stop, _turns: turns };
})();
