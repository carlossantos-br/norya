/**
 * renderer/attention.js — motor de atenção (2026-07-15).
 *
 * Fecha o ciclo de atenção do uso massivo: com N agentes em paralelo, o
 * gargalo é o usuário descobrir QUAL pane parou esperando ele. Este módulo
 * observa TRANSIÇÕES do evalSpawnState() (threads.js, tick de 700ms) — a
 * detecção já existia, ninguém consumia as transições:
 *
 *   working → active sustentado (2 ticks)  → 'waiting' (terminou o turno ou
 *                                             espera input) + banner
 *   PTY morre com exitedWithError          → 'error' + banner
 *   PTY morre limpo                        → 'done'  + banner
 *   → working de novo                      → sai da fila (agente retomou)
 *   pane focado com a janela em foco       → sai da fila (você atendeu)
 *
 * Banner do macOS é SEMPRE (decisão Carlos 2026-07-14), mesmo com o pane
 * visível. Badge do Dock = tamanho da fila. Fila = #attentionQueue pinada no
 * topo da sidebar de threads (some quando vazia).
 *
 * Som (2026-08-01): 1 por entrada na fila, junto do banner e pela mesma trava
 * `item.notified` — um por tipo, em `assets/sounds/` (desde 2026-10-04 ticks
 * curtos gerados por assets/sounds/generate.js). Vale para TODOS os agentes,
 * que é o motivo de morar aqui: o hook do Claude e o rollout do Codex só dizem
 * QUANDO o turno acabou; quem decide e toca é este módulo.
 *
 * Gate de teclado (2026-08-07): a transição working→active só conta como fim de
 * turno se o usuário NÃO digitou nos últimos INPUT_GRACE_MS. evalSpawnState()
 * decide por volume de bytes, e o redraw do input box a cada tecla passa do piso
 * — sem o gate, digitar no pane e parar acendia 'waiting' sozinho (som + banner
 * pelo próprio teclado). Ver st.lastInputTime, carimbado por noteUserInput().
 *
 * Eventos do agente (2026-10-04): para Claude e Codex o som e o 'waiting'
 * vêm SÓ do IPC `agent-event` (hook do Claude / rollout do Codex, ver
 * agents/agent-events.js), nunca da heurística acima — silêncio de ~3s no meio
 * do turno (tool longa, espera de API) apitava, e o mesmo turno apitava 2×.
 *   turn-end   → item 'turn-end' + som, no máximo 1 por turnId
 *   needs-you  → item 'waiting' (pedido de permissão / pergunta ao usuário)
 *   bg-pending → nada: o Claude vai retomar quando o background voltar
 *   turn-start / working → sai da fila e rearma
 * A heurística segue valendo para grok/opencode/aider e para o dot de working.
 * PTY morto (done/error) continua igual para todos.
 *
 * Script clássico como os demais: usa os globais st, evalSpawnState,
 * onThreadClick. Carrega por último no test-window.html.
 */
'use strict';

(() => {
  const { ipcRenderer } = require('electron');

  const TICK_MS = 700;
  // 2 ticks de silêncio antes de virar 'waiting' — evita falso-positivo quando
  // a TUI só respirou entre dois blocos de output.
  const WAIT_SUSTAIN_TICKS = 2;

  // Janela em que uma tecla do usuário invalida a transição working→active
  // (2026-08-07). evalSpawnState() decide 'working' por VOLUME de bytes (300 em
  // 1,5s) e a TUI redesenha o input box a cada tecla: medido num PTY real,
  // digitar a ~8 teclas/s emite ~560 bytes na pior janela — o dobro do piso. Sem
  // este gate, digitar e parar acendia 'waiting' ~2s depois: apito e banner
  // disparados pelo PRÓPRIO teclado do usuário, e como o pane focado sai da fila
  // no tick seguinte, sobrava só o som, sem nada na sidebar pra explicar.
  //
  // 3s é o pior caso entre a última tecla e o 2º tick 'active': 1,5s até os
  // bytes saírem da janela de output + 2 ticks de 700ms. O preço é conhecido e
  // aceito: um turno que termina em menos de ~3s depois da última tecla não
  // notifica — nesse caso o usuário acabou de apertar Enter e está no teclado.
  const INPUT_GRACE_MS = 3000;

  /** @type {Map<string, {kind:string, ts:number, threadId:string, notified:boolean}>} */
  const queue = new Map();          // spawnId → item
  /** @type {Map<string, {state:string, running:boolean, quiet:number}>} */
  const seen = new Map();           // spawnId → última observação

  const $q = () => document.getElementById('attentionQueue');

  // Inclui as PROVISÓRIAS (2026-09-09): entre o spawn e o latch a thread não
  // existe em st.allThreads, e threadById devolvia null — a fila caía no rótulo
  // genérico "Task" justamente na janela em que o agente mais notifica.
  function threadById(tid) {
    const provisorias = (typeof _provisionalThreads === 'function') ? _provisionalThreads() : [];
    return (st.allThreads || []).find(t => t.id === tid)
        || provisorias.find(t => t.id === tid)
        || null;
  }

  // O threadId de um spawn MUDA: uma task nova nasce com o id provisório
  // ("new-…") e o latch o troca pelo id real minutos depois. A fila guardava o
  // id do momento do enfileiramento e nunca reavaliava — depois do latch,
  // threadById() devolvia null e a linha virava o rótulo genérico "Task", sem
  // agente e sem levar a lugar nenhum ao ser clicada. Este índice reverso
  // devolve o threadId ATUAL do spawn.
  function threadIdForSpawn(sid) {
    for (const [tid, s] of Object.entries(st.spawnByThread || {})) {
      if (s === sid) return tid;
    }
    return null;
  }

  // MESMO título que a sidebar mostra (2026-09-09). Antes esta função lia
  // `t.title || t.first_user_message` cru, enquanto a lista passa tudo por
  // cleanThreadTitle() — que remove blocos <command-name>, "[Image #1]",
  // linhas "Caveat:" e ids soltos. O resultado é que a mesma task aparecia com
  // dois nomes diferentes, e o da fila costumava ser lixo de prompt: era o
  // "needs attention nada a ver" do print.
  function threadLabel(tid) {
    const t = threadById(tid);
    let raw = '';
    if (t) {
      raw = (typeof cleanThreadTitle === 'function')
        ? cleanThreadTitle(t)
        : (t.title || t.first_user_message || '');
    }
    if (!raw) raw = 'Task';
    return raw.length > 48 ? raw.slice(0, 45) + '…' : raw;
  }

  function agentLabel(tid) {
    return (st.threadAgents && st.threadAgents[tid]) || '';
  }

  const BODY = {
    waiting: 'Waiting for your input',
    'turn-end': 'Turn finished',
    done: 'Finished',
    error: 'Exited with error',
  };

  // NORYA_SOUND_V1 — marcador de capacidade. O hook-ponte do Claude Code
  // (~/.claude/hooks/norya_sound.py) procura esta string no attention.js JÁ
  // DEPLOYADO: enquanto o Norya em execução não tiver este código, quem toca é o
  // hook; depois do restart, é este módulo. Renomear o marcador quebra a ponte.
  // Timbres em assets/sounds/generate.js (2026-10-04: ticks curtos e discretos).
  const SOUND = {
    waiting: 'needs-you.wav',     // espera input                 → 2 ticks subindo
    'turn-end': 'task-done.wav',  // agente fechou o turno         → 1 tick
    done: 'task-done.wav',        // PTY saiu limpo                → 1 tick
    error: 'task-error.wav',      // PTY saiu com erro             → tick grave
  };
  /** @type {Map<string, HTMLAudioElement>} */
  const audio = new Map();

  function playSound(kind) {
    const file = SOUND[kind];
    if (!file) return;
    try {
      let a = audio.get(file);
      if (!a) { a = new Audio('assets/sounds/' + file); audio.set(file, a); }
      // Reusar o MESMO elemento por arquivo é proposital: N panes entrando na
      // fila no mesmo tick reiniciam um som só, em vez de virar cacofonia.
      a.currentTime = 0;
      const p = a.play();
      if (p && p.catch) p.catch(e => console.warn('[attention] som falhou', e));
    } catch (e) { console.warn('[attention] som falhou', e); }
  }

  function notifyBanner(item, spawnId) {
    // Banner SEMPRE (decisão 2026-07-14) — 1 por entrada na fila.
    if (item.notified) return;
    item.notified = true;
    // Som antes do banner: falha do Notification não pode calar o áudio.
    playSound(item.kind);
    try {
      const agent = agentLabel(item.threadId);
      const n = new Notification(threadLabel(item.threadId) + (agent ? ' — ' + agent : ''), {
        body: BODY[item.kind] || item.kind,
      });
      n.onclick = () => {
        ipcRenderer.send('attention-focus-app');
        attend(spawnId);
      };
    } catch (e) { console.warn('[attention] banner failed', e); }
  }

  // "Atender" = abrir/focar o pane e tirar da fila.
  function attend(spawnId) {
    const item = queue.get(spawnId);
    if (!item) return;
    queue.delete(spawnId);
    const t = threadById(item.threadId);
    if (t && typeof onThreadClick === 'function') {
      try { onThreadClick(t); } catch (e) { console.warn('[attention] open failed', e); }
    }
    render();
  }

  function dismiss(spawnId) {
    queue.delete(spawnId);
    render();
  }

  function timeAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    const m = Math.round(s / 60);
    return m < 60 ? m + 'm' : Math.round(m / 60) + 'h';
  }

  // Assinatura do que a fila MOSTRA. tick() chama render() a cada 700ms só para
  // atualizar o "há Xs", então sem este gate o bloco inteiro era destruído e
  // remontado 1,4×/s — a origem do pisca-pisca do "Needs attention" (e a razão
  // de o × e o hover escaparem do cursor).
  let _renderSig = null;
  function renderSignature() {
    const parts = [];
    for (const [sid, item] of queue) {
      parts.push(sid, item.kind, timeAgo(item.ts), threadLabel(item.threadId), agentLabel(item.threadId));
    }
    return parts.join('');
  }

  function render() {
    const el = $q();
    if (!el) return;
    const sig = renderSignature();
    if (sig === _renderSig) return;    // nada visível mudou → não remonta o DOM
    _renderSig = sig;
    ipcRenderer.send('attention-badge', { count: queue.size });
    if (!queue.size) { el.style.display = 'none'; el.textContent = ''; return; }

    el.style.display = '';
    el.textContent = '';
    const head = document.createElement('div');
    head.className = 'att-head';
    head.textContent = `Needs attention (${queue.size})`;
    el.appendChild(head);

    for (const [sid, item] of queue) {
      const row = document.createElement('div');
      row.className = 'att-row att-' + item.kind;
      row.title = BODY[item.kind];

      const dot = document.createElement('span');
      dot.className = 'att-dot';
      const label = document.createElement('span');
      label.className = 'att-label';
      label.textContent = threadLabel(item.threadId);
      const meta = document.createElement('span');
      meta.className = 'att-meta';
      const agent = agentLabel(item.threadId);
      meta.textContent = (agent ? agent + ' · ' : '') + timeAgo(item.ts);
      const x = document.createElement('button');
      x.className = 'att-x';
      x.textContent = '×';
      x.title = 'Dismiss';
      x.addEventListener('click', (ev) => { ev.stopPropagation(); dismiss(sid); });

      row.append(dot, label, meta, x);
      row.addEventListener('click', () => attend(sid));
      el.appendChild(row);
    }
  }

  function tick() {
    if (typeof st === 'undefined' || typeof evalSpawnState !== 'function') return;
    const now = Date.now();
    let changed = false;

    // Threads focadas com a janela em foco contam como "atendidas".
    const focusedTid = st.gridMode && st.gridMode.focusedThreadId;
    if (focusedTid && document.hasFocus()) {
      for (const [sid, item] of queue) {
        if (item.threadId === focusedTid) { queue.delete(sid); changed = true; }
      }
    }

    // Panes abertos AGORA. Um spawn sem pane no grid não é uma pendência de
    // atenção: ou o usuário fechou o pane (o PTY segue vivo em segundo plano por
    // contrato do ×), ou é um PTY interno que nunca teve pane — o pre-spawn do
    // painel de nova task, por exemplo, que enfileirava e tocava som sozinho.
    const openPanes = new Set((st.gridMode && st.gridMode.threadIds) || []);

    for (const [tid, sid] of Object.entries(st.spawnByThread || {})) {
      if (!sid) continue;
      const state = evalSpawnState(sid);
      const running = !!st.termRunning[sid];
      const prev = seen.get(sid) || { state: 'idle', running: false, quiet: 0 };
      const hasPane = openPanes.has(tid);

      // PTY morreu neste tick → done/error (transição, não estado absoluto:
      // um 'done' antigo não re-notifica a cada tick).
      if (prev.running && !running && hasPane) {
        const kind = st.exitedWithError && st.exitedWithError[sid] ? 'error' : 'done';
        const item = { kind, ts: Date.now(), threadId: tid, notified: false };
        queue.set(sid, item);
        notifyBanner(item, sid);
        changed = true;
      }

      // Claude/Codex: fila e som só pelos eventos do agente (onAgentEvent).
      // O byte do PTY ainda pinta o dot, mas não decide fim de turno — o
      // redraw da TUI depois do Stop apagaria o item recém-chegado.
      if (eventDriven(sid)) {
        seen.set(sid, { state, running, quiet: 0 });
        continue;
      }

      // Voltou a trabalhar → some da fila.
      if (state === 'working' && queue.has(sid)) {
        queue.delete(sid);
        changed = true;
      }

      // working → active sustentado = terminou o turno / espera input.
      // Tecla recente ZERA a contagem (não adia): o eco do teclado não abre um
      // turno, e como a série só recomeça a partir de um tick 'working' novo,
      // parar de digitar no meio de uma frase não vira apito 3s depois.
      const typedRecently = now - (st.lastInputTime[sid] || 0) < INPUT_GRACE_MS;
      let quiet = 0;
      if (running && state === 'active' && !typedRecently) {
        quiet = (prev.state === 'working' || prev.quiet > 0) ? prev.quiet + 1 : 0;
        if (quiet >= WAIT_SUSTAIN_TICKS && !queue.has(sid) && hasPane) {
          const item = { kind: 'waiting', ts: Date.now(), threadId: tid, notified: false };
          queue.set(sid, item);
          notifyBanner(item, sid);
          changed = true;
          quiet = 0;
        }
      }

      seen.set(sid, { state, running, quiet });
    }

    // Reconciliação da fila (2026-08-04). Antes um item só saía daqui ao voltar
    // a trabalhar, ao ser focado ou pelo × — nenhuma dessas cobre "terminou e eu
    // fechei o pane". Como st.spawnByThread NUNCA é apagado no onExit (ver o
    // gotcha "pane em branco": onExit só marca termRunning=false), a limpeza de
    // órfãos abaixo jamais disparava e itens 'done'/'error' ficavam eternos —
    // "Needs attention (1)" grudado na sidebar marcando "3m", "1h", "2d".
    const liveSids = new Set(Object.values(st.spawnByThread || {}));
    for (const [sid, item] of queue) {
      // Órfão: spawn sumiu do mapa (thread apagada).
      if (!liveSids.has(sid)) { queue.delete(sid); changed = true; continue; }
      // O latch pode ter trocado o id provisório pelo real desde o enfileiramento
      // — sem isto o rótulo degrada para o genérico "Task" e o clique não abre nada.
      const curTid = threadIdForSpawn(sid);
      if (curTid && curTid !== item.threadId) { item.threadId = curTid; changed = true; }
      // Pane fechado = o usuário já deu o assunto por encerrado. O PTY segue
      // vivo em segundo plano (é o contrato do × desde 2026-07-21), mas a
      // pendência de ATENÇÃO morreu junto com o pane.
      if (!openPanes.has(item.threadId)) { queue.delete(sid); changed = true; }
    }

    if (changed) render();
    else if (queue.size) render();   // atualiza "há Xs" barato (≤ dezenas de linhas)
  }

  // ── Eventos do agente (2026-10-04) ─────────────────────────────────────────
  const EVENT_AGENTS = new Set(['claude', 'codex']);
  /** @type {Map<string, {agent:string, events:boolean}>} spawnId → o que o main resolveu */
  const spawnAgents = new Map();
  /** @type {Map<string, {endTurn:(string|null), askedTurn:(string|null), busy:(boolean|null)}>} */
  const turns = new Map();

  // O main avisa no spawn ('spawned') qual agente subiu e se ele manda
  // eventos (Claude sem hook — Windows, helper ausente — não manda e fica na
  // heurística). Antes do aviso, vale o agente fixado na thread.
  function eventDriven(sid) {
    const r = spawnAgents.get(sid);
    if (r) return r.events && EVENT_AGENTS.has(r.agent);
    return EVENT_AGENTS.has(st.spawnAgent && st.spawnAgent[sid]);
  }

  function turnState(sid) {
    let t = turns.get(sid);
    if (!t) { t = { endTurn: null, askedTurn: null, busy: null }; turns.set(sid, t); }
    return t;
  }

  // Turno em andamento segundo o PRÓPRIO agente: true entre turn-start e
  // turn-end/needs-you; null = ainda sem evento (vale a heurística de bytes).
  // A heurística chama de parado qualquer silêncio — Bash longo, pensando —,
  // e o celular mostrava "Idle" com o agente trabalhando.
  function inTurn(sid) {
    if (!eventDriven(sid)) return null;
    const t = turns.get(sid);
    return t ? t.busy : null;
  }

  function enqueueFromEvent(sid, kind, turnId) {
    const tid = threadIdForSpawn(sid);
    const openPanes = new Set((st.gridMode && st.gridMode.threadIds) || []);
    // Mesma regra da heurística: spawn sem pane aberto não é pendência.
    if (!tid || !openPanes.has(tid)) return;
    const item = { kind, ts: Date.now(), threadId: tid, notified: false, turnId };
    queue.set(sid, item);
    notifyBanner(item, sid);
    render();
  }

  function onAgentEvent(msg) {
    if (!msg || typeof msg.spawnId !== 'string') return;
    const sid = msg.spawnId;
    if (msg.kind === 'spawned') {
      if (msg.agent) spawnAgents.set(sid, { agent: msg.agent, events: msg.events !== false });
      turns.delete(sid);   // PTY novo: turnos recomeçam
      return;
    }
    const t = turnState(sid);
    const tirarDaFila = () => {
      const item = queue.get(sid);
      if (item && (item.kind === 'waiting' || item.kind === 'turn-end')) { queue.delete(sid); render(); }
    };
    switch (msg.kind) {
      case 'turn-start':
        t.endTurn = null; t.askedTurn = null; t.busy = true;
        tirarDaFila();
        break;
      case 'working':
        // Permissão respondida / Claude seguiu: um pedido novo pode apitar.
        t.askedTurn = null; t.busy = true;
        tirarDaFila();
        break;
      case 'turn-end': {
        t.busy = false;
        // No máximo 1 som por turno: Stop repetido depois de um Stop hook que
        // bloqueou cai no MESMO turnId.
        const turnId = msg.turnId || ('t' + Date.now());
        if (t.endTurn === turnId) return;
        t.endTurn = turnId;
        enqueueFromEvent(sid, 'turn-end', turnId);
        break;
      }
      case 'needs-you': {
        t.busy = false;
        const turnId = msg.turnId || ('t' + Date.now());
        if (t.askedTurn === turnId) return;
        t.askedTurn = turnId;
        enqueueFromEvent(sid, 'waiting', turnId);
        break;
      }
      case 'bg-pending':
        // De propósito sem som: o turno acabou, o pane não (o subagente segue
        // e o Claude retoma sozinho) — pro estado, continua trabalhando.
        t.busy = true;
        break;
    }
  }

  ipcRenderer.on('agent-event', (_, msg) => {
    try { onAgentEvent(msg); } catch (e) { console.warn('[attention] agent-event', e); }
  });

  setInterval(tick, TICK_MS);

  // Exposto pros smokes (CDP) — não é API de produto.
  window.__attention = { queue, tick, attend, dismiss, render, playSound, SOUND, onAgentEvent, eventDriven, spawnAgents, inTurn };
})();
