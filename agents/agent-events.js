'use strict';

/**
 * agents/agent-events.js — eventos de turno vindos do PRÓPRIO agente (2026-10-04).
 *
 * Por que existe: o som de "pane terminou" vinha da heurística de bytes do PTY
 * (evalSpawnState + attention.js). Silêncio no meio do turno (tool longa,
 * espera de API) apitava, o mesmo turno apitava duas vezes, e o Claude que
 * retoma sozinho por <task-notification> de background agent soava como fim.
 * Para Claude e Codex o fim de turno agora vem de quem sabe: hook do Claude
 * Code (helpers/norya-claude-event.js) e o rollout .jsonl do Codex.
 *
 * PURO (sem electron, sem fs): o main injeta timers e a verificação do
 * transcript; os testes (test/agent-events.test.js) dirigem tudo com relógio
 * falso.
 */

/** Tipos que o canal aceita. Qualquer outra coisa é descartada no parse. */
const KINDS = new Set(['turn-start', 'working', 'turn-end', 'bg-pending', 'needs-you', 'activity']);
/** Ações do `activity` do Codex (ver createCodexRolloutParser). */
const ACTS = new Set(['cmd', 'edit', 'tool', 'search', 'think', 'msg']);

/**
 * Valida UMA linha JSON do socket. Devolve a mensagem saneada ou null.
 * O socket é local e do usuário, mas um processo qualquer no PTY herda o
 * caminho — então nada de confiar em campo extra.
 */
function parseEventLine(line) {
  let m;
  try { m = JSON.parse(String(line)); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  if (typeof m.spawnId !== 'string' || !m.spawnId || m.spawnId.length > 200) return null;
  if (!KINDS.has(m.kind)) return null;
  const out = { spawnId: m.spawnId, kind: m.kind };
  if (typeof m.turnId === 'string' && m.turnId.length <= 200) out.turnId = m.turnId;
  if (Number.isFinite(m.pending)) out.pending = Math.max(0, Math.floor(m.pending));
  // Onde o transcript do Claude estava no Stop: o main confere o que veio
  // DEPOIS (Stop hook que bloqueou) antes de liberar o turn-end.
  if (typeof m.transcriptPath === 'string' && /\.jsonl$/.test(m.transcriptPath)) out.transcriptPath = m.transcriptPath;
  if (Number.isFinite(m.transcriptSize) && m.transcriptSize >= 0) out.transcriptSize = Math.floor(m.transcriptSize);
  // Atividade (Mini/pet, 2026-10-05): o que o agente está fazendo, pro subtítulo
  // da pílula. Tudo texto curto e opcional; o canal é local mas não confia.
  if (typeof m.tool === 'string' && m.tool) out.tool = m.tool.slice(0, 80);
  if (typeof m.q === 'string' && m.q) out.q = m.q.slice(0, 120);
  if (Number.isFinite(m.files) && m.files >= 0) out.files = Math.min(999, Math.floor(m.files));
  if (typeof m.summary === 'string' && m.summary) out.summary = m.summary.slice(0, 140);
  if (m.kind === 'activity') {
    if (typeof m.act === 'string' && ACTS.has(m.act)) out.act = m.act;
    if (typeof m.name === 'string' && m.name) out.name = m.name.slice(0, 80);
    if (Number.isFinite(m.n) && m.n >= 0) out.n = Math.min(999, Math.floor(m.n));
    if (typeof m.text === 'string' && m.text) out.text = m.text.slice(0, 140);
  }
  return out;
}

/**
 * O Claude CONTINUOU depois do Stop? Lê só o trecho do transcript escrito
 * depois do Stop. Dois sinais:
 *   - attachment hook_blocking_error do evento Stop: algum Stop hook (ex.: o
 *     um Stop hook do usuário) devolveu decision:block e o Claude seguiu;
 *   - uma mensagem nova do assistant: o modelo voltou a falar.
 */
function transcriptShowsContinuation(text) {
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    if (line.indexOf('hook_blocking_error') < 0 && line.indexOf('"assistant"') < 0) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'assistant') return true;
    const a = o.type === 'attachment' && o.attachment;
    if (a && a.type === 'hook_blocking_error' && (a.hookEvent === 'Stop' || /^Stop\b/.test(a.hookName || ''))) return true;
  }
  return false;
}

/**
 * Portão do turn-end do Claude.
 *
 * O Stop hook roda em PARALELO com os Stop hooks do usuário; se um deles
 * bloquear, o Claude continua o turno — e o nosso hook já avisou "terminou".
 * Então seguramos o turn-end por `holdMs` e cancelamos se, nesse intervalo,
 * chegar UserPromptSubmit/PreToolUse do mesmo spawn, ou se `verify()` achar no
 * transcript sinal de que o Claude seguiu.
 *
 * Também numera os turnos: o hook não tem id de turno, e o renderer precisa de
 * um para tocar no máximo 1 som por turno. Cada UserPromptSubmit (inclusive o
 * de uma <task-notification> que o Claude processa sozinho) abre um turno novo;
 * um Stop que se repete depois de um bloqueio cai no MESMO turno.
 *
 * @param {object} o
 * @param {(msg:object)=>void} o.deliver        manda ao renderer
 * @param {number} [o.holdMs=1500]
 * @param {(msg:object)=>boolean} [o.verify]    true = Claude continuou, descarta
 * @param {Function} [o.setTimeout] [o.clearTimeout]  injetáveis pros testes
 */
function createClaudeTurnGate(o) {
  const deliver = o.deliver;
  const holdMs = o.holdMs == null ? 1500 : o.holdMs;
  const verify = o.verify || (() => false);
  const setT = o.setTimeout || setTimeout;
  const clearT = o.clearTimeout || clearTimeout;
  /** @type {Map<string, {seq:number, timer:any}>} */
  const spawns = new Map();

  function state(id) {
    let s = spawns.get(id);
    if (!s) { s = { seq: 0, timer: null }; spawns.set(id, s); }
    return s;
  }
  function cancel(s) { if (s.timer) { clearT(s.timer); s.timer = null; } }

  function handle(msg) {
    const s = state(msg.spawnId);
    const turnId = () => 'c' + s.seq;
    switch (msg.kind) {
      case 'turn-start':
        cancel(s);
        s.seq++;
        deliver({ spawnId: msg.spawnId, kind: 'turn-start', turnId: turnId() });
        return;
      case 'working':
        cancel(s);
        {
          const w = { spawnId: msg.spawnId, kind: 'working', turnId: turnId() };
          if (msg.tool) w.tool = msg.tool;
          if (msg.files != null) w.files = msg.files;
          if (msg.q) w.q = msg.q;
          deliver(w);
        }
        return;
      case 'turn-end': {
        cancel(s);
        const held = Object.assign({}, msg, { turnId: turnId() });
        s.timer = setT(() => {
          s.timer = null;
          let continuou = false;
          try { continuou = !!verify(held); } catch { continuou = false; }
          if (continuou) return;
          const e = { spawnId: held.spawnId, kind: 'turn-end', turnId: held.turnId };
          if (held.summary) e.summary = held.summary;
          deliver(e);
        }, holdMs);
        return;
      }
      case 'bg-pending':
        // Turno acabou mas há agente/bash em background: o Claude vai retomar
        // sozinho quando ele terminar. Sem som — e um turn-end segurado do
        // mesmo turno perde o sentido.
        cancel(s);
        deliver({ spawnId: msg.spawnId, kind: 'bg-pending', turnId: turnId(), pending: msg.pending || 0 });
        return;
      case 'needs-you':
        deliver({ spawnId: msg.spawnId, kind: 'needs-you', turnId: turnId() });
        return;
    }
  }

  function forget(id) {
    const s = spawns.get(id);
    if (s) cancel(s);
    spawns.delete(id);
  }

  return { handle, forget, _spawns: spawns };
}

/**
 * Parser incremental do rollout .jsonl do Codex.
 *
 * `feed(texto)` recebe bytes novos (já decodificados) e devolve os eventos de
 * turno daquele trecho. Linha partida no fim do chunk fica guardada até o
 * próximo feed — o Codex escreve linha a linha, mas o fs.watch acorda no meio.
 *
 *   event_msg task_started                 → turn-start (turn_id)
 *   event_msg task_complete                → turn-end   (1 por turn_id)
 *   event_msg turn_aborted                 → nada (Esc do usuário: ele está ali)
 *   function_call request_user_input_async → needs-you
 *   function_call/custom_tool_call, web_search_call, agent_reasoning,
 *   agent_message                          → activity (act: cmd|edit|tool|search|think|msg;
 *                                            subtítulo da pílula do Mini, 2026-10-05)
 *   session_meta com source.subagent       → `subagent = true` (o chamador ignora)
 */
const RX_ACTIVITY = /"type":"(?:function_call|custom_tool_call|web_search_call|agent_reasoning|agent_message)"/;

/** 1ª linha não vazia, sem marcação de negrito/cabeçalho, truncada. */
function firstLine(text, max) {
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/^[#>\s*-]+/, '').replace(/\*\*/g, '').trim();
    if (l) return l.length > max ? l.slice(0, max - 1) + '…' : l;
  }
  return '';
}
/** Título do raciocínio do Codex: o `**Título**` do início, senão a 1ª linha (≤ 60). */
function reasoningTitle(text) {
  const m = /^\s*\*\*([^*\n]+)\*\*/.exec(String(text || ''));
  const t = m ? m[1].trim() : firstLine(text, 60);
  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

function createCodexRolloutParser() {
  let pending = '';
  let currentTurn = null;
  const ended = new Set();
  const st = { subagent: false, sessionId: null, cwd: null };

  function onLine(line, out) {
    if (!line.trim()) return;
    // Filtro barato antes do JSON.parse: rollouts têm milhares de linhas de
    // token_count/reasoning que não interessam.
    if (line.indexOf('session_meta') < 0 && line.indexOf('task_') < 0
        && line.indexOf('turn_aborted') < 0 && line.indexOf('request_user_input') < 0
        && !RX_ACTIVITY.test(line)) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const p = o && o.payload;
    if (!p || typeof p !== 'object') return;
    if (o.type === 'session_meta') {
      st.sessionId = p.id || p.session_id || null;
      st.cwd = p.cwd || null;
      st.subagent = !!(p.source && typeof p.source === 'object' && p.source.subagent);
      return;
    }
    if (o.type === 'event_msg') {
      if (p.type === 'agent_reasoning' && typeof p.text === 'string') {
        const t = reasoningTitle(p.text);
        if (t) out.push({ kind: 'activity', act: 'think', text: t, turnId: currentTurn || undefined });
        return;
      }
      if (p.type === 'agent_message' && typeof p.message === 'string') {
        const t = firstLine(p.message, 140);
        if (t) out.push({ kind: 'activity', act: 'msg', text: t, turnId: currentTurn || undefined });
        return;
      }
      if (p.type === 'task_started') {
        currentTurn = p.turn_id || null;
        out.push({ kind: 'turn-start', turnId: currentTurn || undefined });
      } else if (p.type === 'task_complete') {
        const id = p.turn_id || currentTurn;
        if (id && ended.has(id)) return;
        if (id) ended.add(id);
        out.push({ kind: 'turn-end', turnId: id || undefined });
      }
      // turn_aborted: de propósito nada — quem abortou foi o usuário.
      return;
    }
    if (o.type !== 'response_item') return;
    if (p.type === 'function_call' && typeof p.name === 'string' && p.name.indexOf('request_user_input') === 0) {
      out.push({ kind: 'needs-you', turnId: currentTurn || undefined });
      return;
    }
    const turnId = currentTurn || undefined;
    if (p.type === 'web_search_call') {
      const a = p.action || {};
      const q = typeof a.query === 'string' ? a.query : (Array.isArray(a.queries) && typeof a.queries[0] === 'string' ? a.queries[0] : '');
      out.push(q ? { kind: 'activity', act: 'search', q: q.slice(0, 120), turnId } : { kind: 'activity', act: 'search', turnId });
    } else if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.name === 'string') {
      const n = p.name;
      if (n === 'exec_command' || n === 'shell' || n === 'local_shell' || n === 'exec') {
        out.push({ kind: 'activity', act: 'cmd', turnId });
      } else if (n === 'apply_patch') {
        const body = typeof p.input === 'string' ? p.input : (typeof p.arguments === 'string' ? p.arguments : '');
        const cnt = (body.match(/\*\*\* (?:Update|Add|Delete) File:/g) || []).length;
        out.push({ kind: 'activity', act: 'edit', n: cnt || 1, turnId });
      } else {
        out.push({ kind: 'activity', act: 'tool', name: n.slice(0, 80), turnId });
      }
    }
  }

  function feed(text) {
    const out = [];
    const data = pending + String(text || '');
    const lines = data.split('\n');
    pending = lines.pop();
    for (const l of lines) onLine(l, out);
    return out;
  }

  return { feed, state: st };
}

module.exports = {
  KINDS, ACTS, firstLine, parseEventLine, transcriptShowsContinuation,
  createClaudeTurnGate, createCodexRolloutParser,
};
