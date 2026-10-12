#!/usr/bin/env node
/**
 * Agente por thread.
 *
 * Regra: uma thread NÃO troca de CLI depois de criada. Reabrir uma thread de
 * Grok com o seletor em "Codex" a spawnaria na CLI errada — formato de sessão e
 * `--resume` diferem, e o histórico se perderia.
 *
 * Prova:
 *   1. `thread-agent-set` grava, `thread-agents-all` lê de volta.
 *   2. Um agentId desconhecido é RECUSADO na porta (gravado, voltaria a cada
 *      spawn daquela thread, para sempre).
 *   3. Com um agente gravado, o spawn daquela thread usa ele — mesmo com o
 *      seletor global apontando para outro.
 *   4. Sem registro ("Automático"), o seletor global manda.
 *
 * Limpa o que grava. Custo: zero token (as TUIs só sobem).
 *
 * Uso: node test/smoke-thread-agent.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp } = require('./cdp-harness');
const { NORYA_HOME } = require('../norya-home');

const LOG = path.join(NORYA_HOME, 'panel.log');
const AGENTS_JSON = path.join(NORYA_HOME, 'thread-agents.json');
const logDesde = pos => { try { return fs.readFileSync(LOG).subarray(pos).toString('utf8'); } catch { return ''; } };
const logTam = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TID = 'teste-thread-agente';

const DRIVE = `(async () => {
  const { ipcRenderer } = require('electron');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};

  // 1) grava e lê de volta
  out.set = await ipcRenderer.invoke('thread-agent-set', { sessionId: '${TID}', agentId: 'grok' });
  const todos = await ipcRenderer.invoke('thread-agents-all');
  out.leu = todos['${TID}'];

  // 2) agentId inválido recusado
  out.invalido = await ipcRenderer.invoke('thread-agent-set', { sessionId: '${TID}-x', agentId: 'nao-existe' });
  const todos2 = await ipcRenderer.invoke('thread-agents-all');
  out.naoGravou = todos2['${TID}-x'] === undefined;

  // 3) spawn de uma thread COM agente gravado, seletor global em outro
  st.threadAgents['${TID}'] = 'grok';
  st.selectedAgentId = 'claude';        // o seletor discorda de propósito
  st.spawnAgent = st.spawnAgent || {};

  const accounts = await ipcRenderer.invoke('get-accounts');
  const account = accounts.find(a => a.authMode === 'chatgpt') || accounts[0];

  // launchTerminal injeta o agente; chamamos o mesmo caminho do resume.
  launchTerminal(account, { mode: 'resume', sessionId: '${TID}', spawnId: '${TID}', cwd: '/tmp', profileNum: account.num });
  await sleep(5000);
  ipcRenderer.send('kill-terminal', '${TID}');

  // 4) sem registro → o seletor global manda
  delete st.threadAgents['auto-1'];
  st.selectedAgentId = 'claude';
  launchTerminal(account, { spawnId: 'auto-1', cwd: '/tmp', profileNum: account.num });
  await sleep(4000);
  ipcRenderer.send('kill-terminal', 'auto-1');

  // limpeza do registro de teste
  await ipcRenderer.invoke('thread-agent-set', { sessionId: '${TID}', agentId: null });
  st.selectedAgentId = null;
  return out;
})()`;

(async () => {
  const falhas = [];
  const marca = logTam();

  try {
    const res = await withApp(async c => {
      const v = await c.evaluate(DRIVE, { timeoutMs: 45000 });
      await sleep(400);
      const log = logDesde(marca);

      const gravou = v.set && v.set.ok && v.leu === 'grok';
      console.log(`${gravou ? 'PASS' : 'FAIL'}  thread-agent-set grava e thread-agents-all lê de volta`);
      if (!gravou) falhas.push('persistência');

      const recusou = v.invalido && v.invalido.error && v.naoGravou;
      console.log(`${recusou ? 'PASS' : 'FAIL'}  agentId desconhecido é recusado e não vai pro disco`);
      if (!recusou) falhas.push('validação');

      const usouGravado = new RegExp(`spawn: id=${TID} cli=grok\\b`).test(log);
      console.log(`${usouGravado ? 'PASS' : 'FAIL'}  thread com agente gravado abre no Grok, ignorando o seletor`);
      if (!usouGravado) falhas.push('agente gravado ignorado');

      const usouSeletor = /spawn: id=auto-1 cli=claude\b/.test(log);
      console.log(`${usouSeletor ? 'PASS' : 'FAIL'}  thread sem registro segue o seletor global (claude)`);
      if (!usouSeletor) falhas.push('seletor global ignorado');
    }, { settleMs: 4000 });

    if (res.exceptions.length) {
      console.log(`FAIL  exceções não capturadas (${res.exceptions.length})`);
      res.exceptions.slice(0, 3).forEach(e => console.log(`        ${String(e).slice(0, 180)}`));
      falhas.push('exceções');
    } else console.log('PASS  sem exceções não capturadas');
    if (res.leaked.length) { console.log(`FAIL  vazou Electron (${res.leaked.join(', ')})`); falhas.push('vazamento'); }
  } catch (err) {
    console.log(`FAIL  arnês: ${err.message}`);
    falhas.push('arnês');
  }

  // Garante que o teste não deixou lixo no disco do usuário.
  try {
    const disco = JSON.parse(fs.readFileSync(AGENTS_JSON, 'utf8'));
    const sujo = Object.keys(disco).some(k => k.startsWith(TID));
    console.log(`${sujo ? 'FAIL' : 'PASS'}  o teste não deixou registro de teste em thread-agents.json`);
    if (sujo) falhas.push('lixo em disco');
  } catch { console.log('PASS  thread-agents.json ausente ou vazio'); }

  console.log(`\n${falhas.length ? `FALHOU (${falhas.length}): ${falhas.join(', ')}` : 'TUDO PASSOU'}`);
  process.exit(falhas.length ? 1 : 0);
})();
