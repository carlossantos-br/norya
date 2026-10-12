#!/usr/bin/env node
/**
 * Dois panes de Codex no mesmo perfil chatgpt, pelo caminho REAL do grid
 * (com `projectId`, que é o único caso em que `canSpawn` roda).
 *
 * Por que existe: `canSpawn` recusava o segundo PTY de um perfil chatgpt com
 * `chatgpt-single` (main.js). Investigado em 2026-07-09: dois codex no mesmo
 * $HOME sobem limpos, não se matam e não alteram auth.json/config.toml. O cap
 * era um curativo para um bug de COLISÃO DE ID — sem `spawnId`, o id caía em
 * `String(account.num)` e o segundo spawn matava o primeiro. O id virou único;
 * o cap ficou.
 *
 * Este teste trava o comportamento: um perfil chatgpt deve sustentar 2 PTYs.
 *
 * Custo: ZERO token. Só sobe duas TUIs; nenhum prompt é enviado.
 *
 * Uso: node test/smoke-multi-codex.js   → exit 0 = PASS, 1 = FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { withApp } = require('./cdp-harness');
const { NORYA_HOME } = require('../norya-home');

const ACCOUNTS = path.join(NORYA_HOME, 'accounts');

function pickCodexProfile() {
  let dirs = [];
  try { dirs = fs.readdirSync(ACCOUNTS); } catch { return null; }
  for (const d of dirs.sort((a, b) => Number(a) - Number(b))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(ACCOUNTS, d, 'profile.json'), 'utf8'));
      if (p.authMode !== 'chatgpt') continue;
      const a = JSON.parse(fs.readFileSync(path.join(ACCOUNTS, d, '.codex', 'auth.json'), 'utf8'));
      if (a?.tokens?.access_token) return Number(d);
    } catch { /* perfil incompleto */ }
  }
  return null;
}

const sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return 'ausente'; } };
const fingerprint = num => {
  const base = path.join(ACCOUNTS, String(num), '.codex');
  return { auth: sha(path.join(base, 'auth.json')), config: sha(path.join(base, 'config.toml')) };
};

/**
 * Canal é determinístico porque passamos spawnId — escute ANTES de spawnar,
 * senão a saída inicial do primeiro PTY se perde e o teste mede um zero falso.
 */
const DRIVE = num => `(async () => {
  const { ipcRenderer } = require('electron');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const A = 'mc-a', B = 'mc-b';
  const PROJ = 'norya-test-multi-codex';

  const accounts = await ipcRenderer.invoke('get-accounts');
  const account = accounts.find(a => a.num === ${num});
  if (!account) return { ok: false, stage: 'account' };

  const buf = { [A]: '', [B]: '' }, dead = { [A]: false, [B]: false };
  for (const sid of [A, B]) {
    ipcRenderer.on('terminal-data-' + sid, (_e, d) => { buf[sid] += d; });
    ipcRenderer.on('terminal-exit-' + sid, () => { dead[sid] = true; });
  }

  // projectId presente → canSpawn É avaliado. É o caminho do grid.
  const opts = sid => ({ account, cwd: '/tmp', spawnId: sid, projectId: PROJ, profileNum: ${num} });

  const r1 = await ipcRenderer.invoke('spawn-terminal-checked', opts(A));
  if (!r1 || !r1.ok) return { ok: false, stage: 'pane1', error: r1 && r1.error, code: r1 && r1.code };
  await sleep(1500);
  const r2 = await ipcRenderer.invoke('spawn-terminal-checked', opts(B));
  if (!r2 || !r2.ok) return { ok: false, stage: 'pane2', error: r2 && r2.error, code: r2 && r2.code };

  await sleep(14000);

  // Congela o veredito ANTES de matar: as flags dead[] são escritas pelo canal
  // terminal-exit-<id>, que também dispara no nosso próprio kill. Lê-las depois
  // do kill sempre daria "morreu" e o teste acusaria um assassinato que fui eu.
  const total = (await ipcRenderer.invoke('working-ptys', {})).total;
  const morreuSozinho1 = dead[A], morreuSozinho2 = dead[B];
  const bytes1 = buf[A].length, bytes2 = buf[B].length;
  const suspeito = s => /already running|lock|EADDRINUSE|panic/i.test(s);
  const suspeito1 = suspeito(buf[A]), suspeito2 = suspeito(buf[B]);

  ipcRenderer.send('kill-terminal', A);
  ipcRenderer.send('kill-terminal', B);
  await sleep(1500);
  const after = (await ipcRenderer.invoke('working-ptys', {})).total;

  return {
    ok: true, stage: 'done',
    bytes1, bytes2,
    exited1: morreuSozinho1, exited2: morreuSozinho2,
    suspeito1, suspeito2,
    vivos: total, depoisDoKill: after,
  };
})()`;

(async () => {
  const num = pickCodexProfile();
  if (num == null) {
    console.log('SKIP  nenhum perfil chatgpt autenticado');
    console.log('\nPULADO');
    process.exit(0);
  }
  console.log(`info  perfil ${num} (chatgpt, autenticado)`);

  const before = fingerprint(num);
  const failures = [];
  let v = null;

  try {
    const result = await withApp(async c => { v = await c.evaluate(DRIVE(num), { timeoutMs: 60000 }); }, { settleMs: 3500 });

    if (!v || !v.ok) {
      const code = v && v.code ? ` (code: ${v.code})` : '';
      console.log(`FAIL  segundo pane de Codex recusado no estágio "${v && v.stage}"${code}`);
      if (v && v.error) console.log(`        ${v.error}`);
      failures.push('segundo pane recusado');
    } else {
      const both = v.bytes1 > 0 && v.bytes2 > 0;
      console.log(`${both ? 'PASS' : 'FAIL'}  ambos os panes produziram saída (${v.bytes1} B / ${v.bytes2} B)`);
      if (!both) failures.push('um pane ficou mudo');

      const alive = !v.exited1 && !v.exited2;
      console.log(`${alive ? 'PASS' : 'FAIL'}  nenhum pane foi morto pelo outro`);
      if (!alive) failures.push('um pane matou o outro');

      const two = v.vivos >= 2;
      console.log(`${two ? 'PASS' : 'FAIL'}  dois PTYs coexistiram (working-ptys total = ${v.vivos})`);
      if (!two) failures.push('não coexistiram');

      const clean = !v.suspeito1 && !v.suspeito2;
      console.log(`${clean ? 'PASS' : 'FAIL'}  saída sem lock/already-running/panic`);
      if (!clean) failures.push('saída suspeita');

      const killed = v.depoisDoKill === 0;
      console.log(`${killed ? 'PASS' : 'FAIL'}  kill encerrou os dois (total = ${v.depoisDoKill})`);
      if (!killed) failures.push('kill não encerrou');
    }

    if (result.exceptions.length) {
      console.log(`FAIL  sem exceções não capturadas (${result.exceptions.length})`);
      failures.push('exceções');
    } else {
      console.log('PASS  sem exceções não capturadas');
    }
    if (result.leaked.length) { console.log(`FAIL  vazou Electron (${result.leaked.join(', ')})`); failures.push('processo vazado'); }
  } catch (err) {
    console.log(`FAIL  arnês: ${err.message}`);
    failures.push('arnês');
  }

  const after = fingerprint(num);
  const intact = before.auth === after.auth && before.config === after.config;
  console.log(`${intact ? 'PASS' : 'FAIL'}  estado do perfil intacto (auth.json + config.toml)`);
  if (!intact) failures.push('estado do perfil alterado');

  console.log(`\n${failures.length ? `FALHOU (${failures.length}): ${failures.join(', ')}` : 'TUDO PASSOU'}`);
  process.exit(failures.length ? 1 : 0);
})();
