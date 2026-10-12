#!/usr/bin/env node
/**
 * Smoke E2E: evento de fim de turno do Claude Code chega ao renderer (2026-10-04).
 *
 * Caminho inteiro, sem atalho: Norya isolado → PTY com o `claude` REAL (TUI) →
 * hook do `--settings` (helpers/norya-claude-event.js) → socket de eventos do
 * main → portão de 1,5 s → IPC `agent-event` → renderer. Manda UM prompt curto
 * e confere: 'spawned' com agent claude, 'turn-start', exatamente 1 'turn-end',
 * nenhum 'bg-pending'.
 *
 * O perfil isolado é um perfil claude SEM token: usa o login do Keychain e o
 * ~/.claude real — então os hooks do usuário (Stop hooks etc.) rodam
 * junto, que é justamente a convivência que importa provar.
 *
 * Custo: 1 prompt curto ("responda apenas: ok"). Pula sozinho se não houver
 * `claude` no PATH. Roda com o Norya de produção ABERTO (porta 9229, socket
 * com sufixo próprio). Uso: node test/smoke-agent-events-claude.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-evc-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke-evc';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9229';
const conta = path.join(process.env.NORYA_HOME, 'accounts', '1');
fs.mkdirSync(conta, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });
fs.writeFileSync(path.join(conta, 'name.txt'), 'smoke claude');
fs.writeFileSync(path.join(conta, 'profile.json'), JSON.stringify({ authMode: 'claude' }));
// Pasta JÁ confiada: numa pasta nova o claude abre o diálogo de confiança, e
// aceitar gravaria no ~/.claude.json do usuário. A confiança não é herdada por
// subpasta (a worktree sob ~/.norya, confiado, ainda pergunta) — o padrão é o
// HOME. Só leitura: o prompt não pede nada além de responder.
const CWD = process.env.NORYA_SMOKE_CLAUDE_CWD || os.homedir();

try { execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { stdio: 'ignore' }); }
catch { console.log('SKIP  claude não está no PATH'); process.exit(0); }

const { withApp } = require('./cdp-harness');

const SCRIPT = `(async () => {
  const { ipcRenderer } = require('electron');
  const sid = 'smoke-evc-1';
  const eventos = [];
  let tela = '';
  ipcRenderer.on('agent-event', (_e, m) => { if (m.spawnId === sid) eventos.push(Object.assign({ t: Date.now() }, m)); });
  ipcRenderer.on('terminal-data-' + sid, (_e, d) => { tela += d; if (tela.length > 200000) tela = tela.slice(-100000); });
  const limpa = () => tela.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '').replace(/\\x1b\\][^\\x07]*\\x07/g, '');
  const espera = async (fn, ms) => { const ate = Date.now() + ms; while (Date.now() < ate) { if (fn()) return true; await new Promise(r => setTimeout(r, 250)); } return false; };

  const accounts = await ipcRenderer.invoke('get-accounts');
  const account = accounts.find(a => a.authMode === 'claude');
  if (!account) return { ok: false, motivo: 'perfil claude isolado não listado' };
  const r = await ipcRenderer.invoke('spawn-terminal-checked', { account, cwd: ${JSON.stringify(CWD)}, spawnId: sid, agentId: 'claude' });
  if (!r || !r.ok) return { ok: false, motivo: 'spawn falhou: ' + (r && r.error) };

  await espera(() => /trustthisfolder|trust this folder|bypass ?permissions/i.test(limpa()), 30000);
  if (/trustthisfolder|trust this folder/i.test(limpa())) {
    ipcRenderer.send('kill-terminal', sid);
    return { ok: false, motivo: 'diálogo de confiança na pasta ' + ${JSON.stringify(CWD)} + ' — não aceito pelo teste' };
  }
  await new Promise(r => setTimeout(r, 1500));
  ipcRenderer.send('terminal-input', { id: sid, data: 'responda apenas: ok' });
  await new Promise(r => setTimeout(r, 400));
  ipcRenderer.send('terminal-input', { id: sid, data: '\\r' });

  const chegou = await espera(() => eventos.some(e => e.kind === 'turn-end'), 90000);
  // Janela extra: um 2º turn-end (som dobrado) apareceria aqui.
  await new Promise(r => setTimeout(r, 4000));
  ipcRenderer.send('kill-terminal', sid);
  return {
    ok: true, chegou,
    eventos: eventos.map(e => ({ kind: e.kind, agent: e.agent, turnId: e.turnId, pending: e.pending })),
    cauda: limpa().slice(-600),
  };
})()`;

(async () => {
  const falhas = [];
  try {
    const res = await withApp(async client => {
      const r = await client.evaluate(SCRIPT, { timeoutMs: 180000 });
      if (!r || !r.ok) { console.log('FAIL  ' + JSON.stringify(r)); falhas.push('spawn'); return; }
      const kinds = r.eventos.map(e => e.kind);
      console.log('      eventos: ' + JSON.stringify(r.eventos));
      const spawned = r.eventos.find(e => e.kind === 'spawned');
      const ok = (nome, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + nome); if (!cond) falhas.push(nome); };
      ok("main anuncia o agente resolvido ('spawned' agent=claude)", !!spawned && spawned.agent === 'claude');
      ok('UserPromptSubmit chega como turn-start', kinds.includes('turn-start'));
      ok('Stop chega como turn-end (depois do portão de 1,5 s)', r.chegou);
      ok('exatamente 1 turn-end no turno', kinds.filter(k => k === 'turn-end').length === 1);
      ok('nenhum bg-pending (não houve background)', !kinds.includes('bg-pending'));
      const te = r.eventos.find(e => e.kind === 'turn-end'), ts = r.eventos.find(e => e.kind === 'turn-start');
      ok('turn-end carrega o turnId do turn-start', !!te && !!ts && te.turnId === ts.turnId);
      if (!r.chegou) console.log('      tela: ' + JSON.stringify(r.cauda));
    }, { settleMs: 5000 });
    if (res && res.exceptions && res.exceptions.length) {
      console.log(`FAIL  exceções não capturadas (${res.exceptions.length})`);
      res.exceptions.slice(0, 3).forEach(e => console.log('        ' + String(e).slice(0, 200)));
      falhas.push('exceções');
    }
  } catch (err) { console.log('FAIL  arnês: ' + err.message); falhas.push('arnês'); }
  console.log(`\n${falhas.length ? 'FALHOU: ' + falhas.join(', ') : 'TUDO PASSOU'}`);
  process.exit(falhas.length ? 1 : 0);
})();
