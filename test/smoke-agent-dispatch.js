#!/usr/bin/env node
/**
 * Dispatch de agente pelo registry (Fase 3).
 *
 * Prova que `opts.agentId` escolhe a CLI e que ela REALMENTE sobe dentro do
 * Norya — não só que o comando foi montado.
 *
 * Cada agente é exercitado apenas se `detect-agents` disser que está instalado;
 * os ausentes são pulados com aviso, em vez de reprovar a suíte na máquina de
 * outra pessoa.
 *
 * Também trava o comportamento seguro: um `agentId` desconhecido NÃO pode cair
 * em codex silenciosamente (spawnaria a CLI errada com as flags erradas).
 *
 * Nota de tempo: o OpenCode leva ~5 s até o primeiro byte em cold start (cria
 * config e busca o registry de providers). Uma janela curta demais mede zero e
 * acusa um bug que não existe — foi o que aconteceu na primeira medição.
 *
 * Custo: zero token. Uso: node test/smoke-agent-dispatch.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp } = require('./cdp-harness');
const { NORYA_HOME } = require('../norya-home');

const LOG = path.join(NORYA_HOME, 'panel.log');
const logDesde = pos => { try { return fs.readFileSync(LOG).subarray(pos).toString('utf8'); } catch { return ''; } };
const logTam = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DETECT = `require('electron').ipcRenderer.invoke('detect-agents', {})`;

/** Spawna com agentId e devolve bytes + se o shell reclamou do binário. */
const SPAWN = (spawnId, agentId, esperaMs) => `(async () => {
  const { ipcRenderer } = require('electron');
  let buf = '';
  ipcRenderer.on('terminal-data-${spawnId}', (_e, d) => { buf += d; });

  const accounts = await ipcRenderer.invoke('get-accounts');
  const account = accounts.find(a => a.authMode === 'chatgpt') || accounts[0];
  if (!account) return { ok: false, motivo: 'sem perfil' };

  const r = await ipcRenderer.invoke('spawn-terminal-checked', {
    account, cwd: '/tmp', spawnId: '${spawnId}',
    ${agentId ? `agentId: ${JSON.stringify(agentId)},` : ''}
  });
  if (!r || !r.ok) return { ok: false, motivo: 'spawn falhou: ' + (r && r.error) };

  await new Promise(res => setTimeout(res, ${esperaMs}));
  ipcRenderer.send('kill-terminal', '${spawnId}');
  const limpo = buf.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '');
  return { ok: true, bytes: buf.length, naoAchou: /command not found/i.test(limpo) };
})()`;

(async () => {
  const falhas = [];

  try {
    const res = await withApp(async c => {
      const agentes = await c.evaluate(DETECT, { timeoutMs: 25000 });
      const instalado = id => (agentes.find(a => a.id === id) || {}).installed;
      console.log(`info  detectados: ${agentes.filter(a => a.installed).map(a => a.id).join(', ') || '(nenhum)'}`);

      // ── 1. cada CLI instalada sobe quando escolhida por agentId ──────────
      // OpenCode leva ~5s até o primeiro byte; grok é rápido.
      for (const [id, espera] of [['grok', 9000], ['opencode', 16000]]) {
        if (!instalado(id)) { console.log(`SKIP  ${id} não instalado`); continue; }

        const marca = logTam();
        const v = await c.evaluate(SPAWN(`ag-${id}`, id, espera), { timeoutMs: espera + 25000 });
        await sleep(300);
        const log = logDesde(marca);

        if (!v || !v.ok) { console.log(`FAIL  ${id}: ${v && v.motivo}`); falhas.push(`spawn ${id}`); continue; }

        const escolheu = new RegExp(`spawn: id=ag-${id} cli=${id}\\b`).test(log);
        console.log(`${escolheu ? 'PASS' : 'FAIL'}  agentId="${id}" fez o spawn usar a CLI ${id}`);
        if (!escolheu) falhas.push(`dispatch ${id}`);

        if (v.naoAchou) { console.log(`FAIL  o shell não encontrou o binário ${id}`); falhas.push(`${id} ausente no PATH do PTY`); }
        else console.log(`PASS  ${id} não reclamou de binário ausente`);

        const subiu = v.bytes > 0;
        console.log(`${subiu ? 'PASS' : 'FAIL'}  ${id} escreveu na TUI (${v.bytes} B)`);
        if (!subiu) falhas.push(`${id} mudo`);
      }

      // ── 2. sem agentId, o authMode do perfil manda ───────────────────────
      const m2 = logTam();
      const v2 = await c.evaluate(SPAWN('ag-auto', null, 5000), { timeoutMs: 30000 });
      await sleep(300);
      const auto = /spawn: id=ag-auto cli=codex\b/.test(logDesde(m2));
      console.log(`${auto ? 'PASS' : 'FAIL'}  sem agentId, perfil chatgpt → codex`);
      if (!auto) falhas.push('fallback por authMode');
      if (!v2 || !v2.ok) falhas.push('spawn auto');

      // ── 3. agentId inválido NÃO vira codex em silêncio ───────────────────
      const m3 = logTam();
      const v3 = await c.evaluate(SPAWN('ag-bad', 'nao-existe', 4000), { timeoutMs: 30000 });
      await sleep(300);
      const log3 = logDesde(m3);
      const avisou = /registry: agentId desconhecido "nao-existe"/.test(log3);
      const caiuNoAuth = /spawn: id=ag-bad cli=codex\b/.test(log3);
      console.log(`${avisou ? 'PASS' : 'FAIL'}  agentId inválido gera aviso no log`);
      console.log(`${caiuNoAuth ? 'PASS' : 'FAIL'}  e então cai no authMode do perfil (não em lixo)`);
      if (!avisou) falhas.push('sem aviso de agentId inválido');
      if (!caiuNoAuth) falhas.push('fallback errado');
      if (!v3 || !v3.ok) falhas.push('spawn bad');
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

  console.log(`\n${falhas.length ? `FALHOU (${falhas.length}): ${falhas.join(', ')}` : 'TUDO PASSOU'}`);
  process.exit(falhas.length ? 1 : 0);
})();
