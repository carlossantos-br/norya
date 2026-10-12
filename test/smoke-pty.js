#!/usr/bin/env node
/**
 * Smoke test do encanamento de PTY do Norya.
 *
 * Spawna um terminal de verdade num perfil `chatgpt` autenticado, afirma que
 * bytes chegam ao renderer pelo canal `terminal-data-<id>`, e mata o PTY.
 *
 * Por que existe: as Fases 0-2 mexem em `spawnTerminal`, `onData`, `onExit` e
 * `_dropDeadPty`. O smoke do renderer não exercita nada disso — ele passaria
 * mesmo com o terminal quebrado.
 *
 * Custo: ZERO token. Só a TUI do codex sobe; nenhum prompt é enviado. O perfil
 * precisa ter `auth.json` com access_token, senão o codex cairia no fluxo de
 * login (o teste detecta e pula, em vez de abrir um navegador).
 *
 * Uso: node test/smoke-pty.js     → exit 0 = PASS, 1 = FAIL, 0 + SKIP se não há perfil apto
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp } = require('./cdp-harness');
const { NORYA_HOME } = require('../norya-home');

const ACCOUNTS_DIR = path.join(NORYA_HOME, 'accounts');

/** Primeiro perfil chatgpt com access_token. Sem isso, o spawn abriria login. */
function pickAuthenticatedCodexProfile() {
  let dirs = [];
  try { dirs = fs.readdirSync(ACCOUNTS_DIR); } catch { return null; }
  for (const d of dirs.sort((a, b) => Number(a) - Number(b))) {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, d, 'profile.json'), 'utf8'));
      if (profile.authMode !== 'chatgpt') continue;
      const auth = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, d, '.codex', 'auth.json'), 'utf8'));
      if (auth?.tokens?.access_token) return Number(d);
    } catch { /* perfil incompleto — segue */ }
  }
  return null;
}

/**
 * Roda no renderer. Spawna, espera bytes, mata. Devolve um veredito serializável.
 * Usa ipcRenderer direto (nodeIntegration:true) para não depender da camada `api`,
 * que a Fase 2 vai mover de arquivo.
 *
 * Formatos dos canais (main.js, verificados em 2026-07-09):
 *   get-accounts           → handle, devolve array de contas
 *   spawn-terminal-checked → handle, devolve { ok, id, ... }
 *   kill-terminal          → ON, fire-and-forget (send, NÃO invoke)
 *   working-ptys           → handle, devolve { byProject, byProfile, total }
 */
const DRIVE = num => `(async () => {
  const { ipcRenderer } = require('electron');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ptyTotal = async () => (await ipcRenderer.invoke('working-ptys', {})).total;

  const accounts = await ipcRenderer.invoke('get-accounts');
  const account = accounts.find(a => a.num === ${num});
  if (!account) return { ok: false, stage: 'account', error: 'perfil ${num} não encontrado' };

  const before = await ptyTotal();

  const res = await ipcRenderer.invoke('spawn-terminal-checked', { account, cwd: '/tmp' });
  if (!res || !res.ok) return { ok: false, stage: 'spawn', error: (res && res.error) || 'sem resultado' };

  const id = res.id;
  const chan = 'terminal-data-' + id;
  const bytes = await new Promise(resolve => {
    let buf = '';
    const onData = (_e, d) => { buf += d; if (buf.length > 40) done(); };
    const timer = setTimeout(() => done(), 20000);
    function done() { clearTimeout(timer); ipcRenderer.removeListener(chan, onData); resolve(buf); }
    ipcRenderer.on(chan, onData);
  });

  const during = await ptyTotal();
  ipcRenderer.send('kill-terminal', id);   // canal .on: fire-and-forget
  await sleep(1200);
  const after = await ptyTotal();

  return {
    ok: bytes.length > 0,
    stage: 'done',
    id,
    bytes: bytes.length,
    sawLoginPrompt: /sign in|log in|\\/login|authenticate/i.test(bytes),
    before, during, after,
    killed: after < during || after === before,
  };
})()`;

(async () => {
  const num = pickAuthenticatedCodexProfile();
  if (num == null) {
    console.log('SKIP  nenhum perfil chatgpt autenticado — encanamento de PTY não exercitado');
    console.log('\nPULADO');
    process.exit(0);
  }
  console.log(`info  usando perfil ${num} (chatgpt, autenticado)`);

  const failures = [];
  let verdict = null;

  try {
    const result = await withApp(async client => {
      verdict = await client.evaluate(DRIVE(num), { timeoutMs: 40000 });
    });

    if (!verdict) {
      failures.push('sem veredito');
    } else if (!verdict.ok) {
      console.log(`FAIL  spawn de PTY (estágio: ${verdict.stage}) — ${verdict.error || 'nenhum byte recebido'}`);
      failures.push('spawn de PTY');
    } else {
      console.log(`PASS  PTY spawnou (id ${verdict.id})`);
      console.log(`PASS  bytes chegaram ao renderer (${verdict.bytes} B)`);
      if (verdict.sawLoginPrompt) {
        console.log('AVISO: saída parece pedir login — o perfil pode ter token expirado');
      }
      if (verdict.killed) {
        console.log(`PASS  kill-terminal encerrou o PTY (total ${verdict.during} → ${verdict.after})`);
      } else {
        console.log(`FAIL  PTY continuou vivo após kill-terminal (total ${verdict.during} → ${verdict.after})`);
        failures.push('kill não encerrou o PTY');
      }
    }

    if (result.exceptions.length) {
      console.log(`FAIL  sem exceções não capturadas (${result.exceptions.length})`);
      result.exceptions.slice(0, 3).forEach(e => console.log(`        ${String(e).slice(0, 200)}`));
      failures.push('exceções não capturadas');
    } else {
      console.log('PASS  sem exceções não capturadas');
    }
    if (result.leaked.length) {
      console.log(`FAIL  vazou processo Electron (PIDs ${result.leaked.join(', ')})`);
      failures.push('processo vazado');
    }
  } catch (err) {
    console.log(`FAIL  arnês: ${err.message}`);
    failures.push('arnês');
  }

  console.log(`\n${failures.length ? `FALHOU (${failures.length}): ${failures.join(', ')}` : 'TUDO PASSOU'}`);
  process.exit(failures.length ? 1 : 0);
})();
