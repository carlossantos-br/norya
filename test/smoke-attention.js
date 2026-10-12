#!/usr/bin/env node
/**
 * Smoke: motor de atenção (renderer/attention.js, 2026-07-15).
 *
 * Injeta um spawn FAKE no estado do renderer e dirige o tick manualmente:
 *   1. working (output volumoso recente) → nada na fila;
 *   2. silêncio sustentado (working→active 2+ ticks) → item 'waiting' + fila visível;
 *   3. morte com exitedWithError → item vira 'error';
 *   4. limpeza do fake → fila esvazia e some;
 *   5. som (2026-08-01): src certo por tipo + o .wav carrega mesmo do bundle e
 *      o autoplay do Electron deixa tocar sem gesto do usuário.
 *   6. claude/codex (2026-10-04): silêncio prolongado NÃO toca; turn-end vindo
 *      do IPC agent-event toca exatamente 1 vez por turno; bg-pending não toca;
 *      turno novo rearma; Claude sem hook (events:false) fica na heurística.
 * Banners e Audio são stubados (contados, não disparados) — só o passo 5 toca
 * de verdade, com volume 0.
 *
 * Uso: node test/smoke-attention.js → exit 0 PASS / 1 FAIL.
 *
 * Roda numa instância ISOLADA (NORYA_HOME temp + userData próprio + socket com
 * sufixo) — pode rodar com o Norya de produção aberto, sem tocar nele.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolamento — TEM que vir antes do require do harness (DEFAULT_PORT lê env).
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-att-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke-att';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9227';
fs.mkdirSync(process.env.NORYA_HOME, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });

const { withApp } = require('./cdp-harness');

const SCRIPT = `(async () => {
  const A = window.__attention;
  if (!A) return { ok:false, stage:'módulo ausente' };

  // Stub do banner: conta em vez de notificar.
  let banners = 0;
  const RealNotification = window.Notification;
  window.Notification = function(){ banners++; return { set onclick(_){} }; };

  // Stub do Audio: registra o src em vez de tocar — rodar o smoke não faz
  // barulho. O áudio DE VERDADE é exercitado no passo 5, com volume 0.
  const sounds = [];
  const RealAudio = window.Audio;
  window.Audio = function(src){
    return { src, currentTime: 0, play(){ sounds.push(src); return Promise.resolve(); } };
  };

  const sid = 'smoke-att-s1', tid = 'smoke-att-t1';
  const now = () => Date.now();
  const paneRoster = st.gridMode.threadIds;
  const rosterBackup = paneRoster.slice();
  try {
    st.spawnByThread[tid] = sid;
    st.termRunning[sid] = true;
    st.exitedWithError[sid] = false;
    // O spawn precisa de um PANE ABERTO para virar pendência de atenção
    // (2026-08-04): sem isso, PTYs internos sem pane — o pre-spawn do painel de
    // nova task — enfileiravam e tocavam som sozinhos.
    if (!paneRoster.includes(tid)) paneRoster.push(tid);

    // 1. working: volume recente alto.
    st.outputWindow[sid] = [{ ts: now(), bytes: 5000 }];
    st.lastOutputTime[sid] = now();
    A.tick();
    const afterWorking = A.queue.has(sid);

    // 2. silêncio: janela de output velha → evalSpawnState = 'active'.
    st.outputWindow[sid] = [{ ts: now() - 60000, bytes: 5000 }];
    st.termBuffers[sid] = 'plain prompt, no spinner';
    st.lastOutputTime[sid] = now() - 60000;
    A.tick(); A.tick(); A.tick();
    const waiting = A.queue.get(sid);
    const queueVisible = document.getElementById('attentionQueue').style.display !== 'none';
    const bannersAfterWaiting = banners;
    const soundWaiting = sounds[sounds.length - 1] || null;

    // 3. morte com erro.
    st.termRunning[sid] = false;
    st.exitedWithError[sid] = true;
    st.exitedAt[sid] = now();
    A.tick();
    const errored = A.queue.get(sid);
    const soundError = sounds[sounds.length - 1] || null;

    // 4. render() é no-op quando nada visível mudou (2026-08-04). tick() chama
    // render() a cada 700ms só pelo "há Xs"; sem o gate o bloco era destruído e
    // remontado 1,4×/s — o pisca-pisca do "Needs attention".
    const rowBefore = document.querySelector('#attentionQueue .att-row');
    A.render(); A.render(); A.render();
    const rowAfter = document.querySelector('#attentionQueue .att-row');
    const domEstavel = !!rowBefore && rowBefore === rowAfter;

    // 5. latch: o threadId provisório vira real DEPOIS do enfileiramento. O item
    // tem de reapontar sozinho — antes o rótulo degradava para o genérico "Task".
    const realTid = 'smoke-att-real';
    delete st.spawnByThread[tid];
    st.spawnByThread[realTid] = sid;
    const ri = paneRoster.indexOf(tid);
    if (ri >= 0) paneRoster[ri] = realTid;
    st.allThreads.push({ id: realTid, title: 'Task de verdade', updated_at_ms: now() });
    A.tick();
    const item = A.queue.get(sid);
    const relatchado = !!item && item.threadId === realTid;
    const rotuloOk = (document.querySelector('#attentionQueue .att-label') || {}).textContent === 'Task de verdade';

    // 6. pane fechado = assunto encerrado. O PTY segue vivo em segundo plano
    // (contrato do ×), mas a pendência de ATENÇÃO sai da fila.
    const rj = paneRoster.indexOf(realTid);
    if (rj >= 0) paneRoster.splice(rj, 1);
    A.tick();
    const saiuAoFechar = !A.queue.has(sid);

    // 7. limpeza: spawn some de spawnByThread → órfão removido.
    delete st.spawnByThread[realTid];
    A.tick();
    const cleaned = !A.queue.has(sid);
    const hiddenAgain = A.queue.size === 0
      ? document.getElementById('attentionQueue').style.display === 'none' : true;

    // 8. DIGITAR NÃO É UM TURNO TERMINANDO (2026-08-07). A TUI redesenha o input
    // box a cada tecla: medido num PTY real, digitar a ~8 teclas/s emite ~560
    // bytes por janela de 1,5s — quase o dobro do piso de 300 que
    // evalSpawnState() usa pra chamar de 'working'. Sem o gate de teclado, parar
    // de digitar acendia 'waiting' ~2s depois: apito e banner por causa do
    // PRÓPRIO teclado do usuário, e o item sumia no tick seguinte (pane focado),
    // deixando só o som órfão.
    const sid2 = 'smoke-att-s2', tid2 = 'smoke-att-t2';
    st.spawnByThread[tid2] = sid2;
    st.termRunning[sid2] = true;
    st.exitedWithError[sid2] = false;
    st.termBuffers[sid2] = 'prompt sem spinner';
    paneRoster.push(tid2);
    const somAntesDeDigitar = sounds.length;

    st.outputWindow[sid2] = [{ ts: now(), bytes: 600 }];   // eco do teclado
    st.lastOutputTime[sid2] = now();
    st.lastInputTime[sid2] = now();
    A.tick();                                             // parece 'working'
    st.outputWindow[sid2] = [{ ts: now() - 60000, bytes: 600 }];
    st.lastOutputTime[sid2] = now() - 60000;
    A.tick(); A.tick(); A.tick();                          // parou de digitar
    const digitarCalado = !A.queue.has(sid2) && sounds.length === somAntesDeDigitar;

    // Controle positivo, MESMO pane: trabalho de verdade (última tecla velha)
    // continua apitando — o gate não pode calar o fim de turno.
    st.outputWindow[sid2] = [{ ts: now(), bytes: 5000 }];
    st.lastOutputTime[sid2] = now();
    st.lastInputTime[sid2] = now() - 60000;
    A.tick();                                             // agente trabalhando
    st.outputWindow[sid2] = [{ ts: now() - 60000, bytes: 5000 }];
    st.lastOutputTime[sid2] = now() - 60000;
    A.tick(); A.tick(); A.tick();                          // agente terminou
    const turnoApita = A.queue.has(sid2) && sounds.length > somAntesDeDigitar;

    // 9. CLAUDE/CODEX: SOM SÓ POR EVENTO DO AGENTE (2026-10-04). Silêncio no
    // meio do turno (tool longa, espera de API) apitava pela heurística de
    // bytes. Para panes de claude/codex a fila e o som vêm só do IPC
    // agent-event — entregue aqui pelo PRÓPRIO listener do ipcRenderer.
    const { ipcRenderer } = require('electron');
    const ev = (m) => ipcRenderer.emit('agent-event', {}, Object.assign({ spawnId: 'smoke-att-s3' }, m));
    const sid3 = 'smoke-att-s3', tid3 = 'smoke-att-t3';
    st.spawnByThread[tid3] = sid3;
    st.termRunning[sid3] = true;
    st.exitedWithError[sid3] = false;
    st.termBuffers[sid3] = 'prompt do claude';
    paneRoster.push(tid3);
    // Claude sem hook (Windows) continua na heurística — não pode ficar mudo.
    ev({ kind: 'spawned', agent: 'claude', events: false });
    const semHookHeuristica = !A.eventDriven(sid3);
    ev({ kind: 'spawned', agent: 'claude', events: true });
    const claudePorEvento = A.eventDriven(sid3) && semHookHeuristica;
    ev({ kind: 'turn-start', turnId: 'c1' });
    const somAntesClaude = sounds.length;

    st.outputWindow[sid3] = [{ ts: now(), bytes: 5000 }];   // trabalhando
    st.lastOutputTime[sid3] = now();
    st.lastInputTime[sid3] = now() - 60000;
    A.tick();
    st.outputWindow[sid3] = [{ ts: now() - 60000, bytes: 5000 }];   // silêncio longo
    st.lastOutputTime[sid3] = now() - 60000;
    for (let i = 0; i < 8; i++) A.tick();
    const silencioCalado = !A.queue.has(sid3) && sounds.length === somAntesClaude;

    ev({ kind: 'turn-end', turnId: 'c1' });
    ev({ kind: 'turn-end', turnId: 'c1' });   // Stop repetido (hook bloqueou): mesmo turno
    A.tick(); A.tick();                        // heurística não mexe no item
    const somTurnEnd = sounds.slice(somAntesClaude);
    const itemTurnEnd = A.queue.get(sid3);
    const turnEndUmaVez = somTurnEnd.length === 1 && somTurnEnd[0] === 'assets/sounds/task-done.wav'
      && !!itemTurnEnd && itemTurnEnd.kind === 'turn-end';

    ev({ kind: 'turn-start', turnId: 'c2' });  // usuário mandou outro prompt
    const saiuNoTurnStart = !A.queue.has(sid3);
    const somAntesBg = sounds.length;
    ev({ kind: 'bg-pending', turnId: 'c2', pending: 2 });
    A.tick(); A.tick(); A.tick();
    const bgCalado = sounds.length === somAntesBg && !A.queue.has(sid3);

    ev({ kind: 'turn-start', turnId: 'c3' });  // <task-notification> retomou
    ev({ kind: 'turn-end', turnId: 'c3' });
    const rearmou = sounds.length === somAntesBg + 1;

    ev({ kind: 'turn-start', turnId: 'c4' });
    ev({ kind: 'needs-you', turnId: 'c4' });
    const pedeVoce = (A.queue.get(sid3) || {}).kind === 'waiting'
      && sounds[sounds.length - 1] === 'assets/sounds/needs-you.wav';

    // 5. Áudio real: o .wav resolve a partir do bundle E o autoplay do Electron
    // deixa tocar sem gesto do usuário? Volume 0 pra não fazer barulho no teste.
    window.Audio = RealAudio;
    const probe = await (async () => {
      try {
        const el = new Audio('assets/sounds/' + A.SOUND.waiting);
        await new Promise((res, rej) => {
          el.addEventListener('canplaythrough', res, { once: true });
          el.addEventListener('error', () => rej(new Error('falhou ao carregar')), { once: true });
          setTimeout(() => rej(new Error('timeout de carga')), 8000);
        });
        el.volume = 0;
        await el.play();
        el.pause();
        return { ok: el.duration > 0, dur: Math.round(el.duration * 1000) / 1000 };
      } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
    })();

    const mapaOk = A.SOUND.waiting === 'needs-you.wav'
                && A.SOUND.done === 'task-done.wav'
                && A.SOUND.error === 'task-error.wav';

    return {
      ok: !afterWorking && waiting && waiting.kind === 'waiting' && queueVisible
          && bannersAfterWaiting >= 1 && errored && errored.kind === 'error'
          && domEstavel && relatchado && rotuloOk && saiuAoFechar
          && cleaned && hiddenAgain && digitarCalado && turnoApita
          && claudePorEvento && silencioCalado && turnEndUmaVez && saiuNoTurnStart
          && bgCalado && rearmou && pedeVoce
          && mapaOk && soundWaiting === 'assets/sounds/needs-you.wav'
          && soundError === 'assets/sounds/task-error.wav' && probe.ok,
      afterWorking, waitingKind: waiting && waiting.kind, queueVisible,
      banners: bannersAfterWaiting, erroredKind: errored && errored.kind,
      domEstavel, relatchado, rotuloOk, saiuAoFechar,
      cleaned, hiddenAgain, digitarCalado, turnoApita, mapaOk, soundWaiting, soundError, probe,
      claudePorEvento, silencioCalado, turnEndUmaVez, somTurnEnd, saiuNoTurnStart, bgCalado, rearmou, pedeVoce,
    };
  } finally {
    window.Notification = RealNotification;
    window.Audio = RealAudio;
    st.gridMode.threadIds.length = 0;
    rosterBackup.forEach(x => st.gridMode.threadIds.push(x));
    st.allThreads = (st.allThreads || []).filter(t => t.id !== 'smoke-att-real');
    delete st.spawnByThread['smoke-att-real'];
    delete st.spawnByThread[tid];
    delete st.termRunning[sid]; delete st.exitedWithError[sid];
    delete st.exitedAt[sid]; delete st.outputWindow[sid];
    delete st.termBuffers[sid]; delete st.lastOutputTime[sid];
    delete st.spawnByThread['smoke-att-t2'];
    delete st.termRunning['smoke-att-s2']; delete st.exitedWithError['smoke-att-s2'];
    delete st.outputWindow['smoke-att-s2']; delete st.termBuffers['smoke-att-s2'];
    delete st.lastOutputTime['smoke-att-s2']; delete st.lastInputTime['smoke-att-s2'];
    delete st.spawnByThread['smoke-att-t3'];
    delete st.termRunning['smoke-att-s3']; delete st.exitedWithError['smoke-att-s3'];
    delete st.outputWindow['smoke-att-s3']; delete st.termBuffers['smoke-att-s3'];
    delete st.lastOutputTime['smoke-att-s3']; delete st.lastInputTime['smoke-att-s3'];
    A.spawnAgents.delete('smoke-att-s3');
    A.tick();
  }
})()`;

(async () => {
  const failures = [];
  try {
    const result = await withApp(async client => {
      // O socket de eventos do agente nasce com o sufixo do smoke — nunca o do app vivo.
      const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
      const sockIso = path.join('/tmp', `norya-events-${uid}-smoke-att.sock`);
      if (fs.existsSync(sockIso)) console.log(`PASS  socket de eventos isolado em ${sockIso}`);
      else { console.log(`FAIL  socket de eventos isolado ausente (${sockIso})`); failures.push('socket'); }
      const r = await client.evaluate(SCRIPT, { timeoutMs: 30000 });
      if (!r || !r.ok) { console.log('FAIL  atenção: ' + JSON.stringify(r)); failures.push('atenção'); }
      else {
        console.log('PASS  working não entra na fila');
        console.log(`PASS  silêncio sustentado vira 'waiting' com fila visível (${r.banners} banner)`);
        console.log("PASS  morte com erro vira 'error'");
        console.log('PASS  render() é no-op sem mudança visível (fila não pisca)');
        console.log('PASS  item reaponta pro threadId real após o latch (rótulo certo)');
        console.log('PASS  fechar o pane tira a task da fila de atenção');
        console.log('PASS  órfão limpo e fila esconde');
        console.log('PASS  digitar no pane não enfileira nem apita');
        console.log('PASS  fim de turno de verdade continua apitando');
        console.log('PASS  claude: silêncio prolongado no meio do turno NÃO enfileira nem toca');
        console.log(`PASS  claude: turn-end toca exatamente 1 vez (Stop repetido no mesmo turno calado) ${JSON.stringify(r.somTurnEnd)}`);
        console.log('PASS  claude: turn-start tira da fila; bg-pending não toca');
        console.log('PASS  claude: turno novo (task-notification) rearma o som; needs-you toca o duplo');
        console.log(`PASS  som disparado junto do banner (waiting=${r.soundWaiting}, error=${r.soundError})`);
        console.log(`PASS  .wav carrega do bundle e o autoplay permite (${r.probe.dur}s)`);
      }
    }, { settleMs: 5000 });
    if (result.exceptions.length) {
      console.log(`FAIL  exceções não capturadas (${result.exceptions.length})`);
      result.exceptions.slice(0, 3).forEach(e => console.log('        ' + String(e).slice(0, 200)));
      failures.push('exceções');
    } else console.log('PASS  sem exceções não capturadas');
  } catch (err) { console.log('FAIL  arnês: ' + err.message); failures.push('arnês'); }
  console.log(`\n${failures.length ? 'FALHOU: ' + failures.join(', ') : 'TUDO PASSOU'}`);
  process.exit(failures.length ? 1 : 0);
})();
