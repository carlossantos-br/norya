#!/usr/bin/env node
/**
 * Smoke: helper nativo do Mini (helpers/norya-pet, 2026-10-05).
 *
 * Spawna o binário compilado, manda config/state/show com 3 pílulas variadas, espera
 * {ev:'ready'}, mede footprint (`footprint -p`, < 40 MB) e CPU em idle (delta de tempo de
 * CPU do `ps` numa janela de 6 s, ~0%), pede hide/show, e fecha o stdin (o helper TEM que
 * sair sozinho). Precisa do binário: `bash helpers/norya-pet/build.sh`.
 *
 * O painel aparece de verdade (canto inferior direito) por alguns segundos.
 * Uso: node test/smoke-pet-helper.js → exit 0 PASS / 1 FAIL.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'helpers', 'norya-pet', 'build', 'norya-pet');
const ASSETS = path.join(ROOT, 'assets', 'pet');
const MAX_MB = 40;
const MAX_CPU_PCT = 2;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failed = 0;
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
}

// `ps -o time=` → "m:ss.cc" (tempo de CPU acumulado) em segundos.
function cpuSeconds(pid) {
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString().trim();
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

function footprintMB(pid) {
  const out = execFileSync('footprint', ['-p', String(pid)]).toString();
  const m = /phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(out);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  return m[2] === 'KB' ? v / 1024 : m[2] === 'GB' ? v * 1024 : v;
}

(async () => {
  if (!fs.existsSync(BIN)) { console.log(`FAIL binário ausente: ${BIN} (rode helpers/norya-pet/build.sh)`); process.exit(1); }
  check('manifest.json existe', fs.existsSync(path.join(ASSETS, 'manifest.json')));

  const p = spawn(BIN, [ASSETS], { stdio: ['pipe', 'pipe', 'inherit'] });
  const events = [];
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { events.push(JSON.parse(line)); } catch {}
    }
  });
  let exited = null;
  p.on('exit', (code, sig) => { exited = { code, sig }; });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');

  const t0 = Date.now();
  while (!events.some(e => e.ev === 'ready') && Date.now() - t0 < 5000) await sleep(50);
  check('ready em < 5 s', events.some(e => e.ev === 'ready'), `${Date.now() - t0} ms`);

  send({ op: 'config', petKind: 'auto', size: 112, visibility: 'always', badgeCorner: 'top-end',
         pillsVisible: true, greeted: ['codex', 'clawd'], positions: {} });
  send({ op: 'state', pet: 'codex', sprite: 'idle', pills: [
    { id: 't1', status: 'running', title: 'Refatorar o login', subtitle: 'Executando o comando', canReply: true, canStop: true },
    { id: 't2', status: 'waiting', title: 'Corrigir testes do parser', subtitle: 'Requer input', canReply: true, canStop: true },
    { id: 't3', status: 'review', title: 'Atualizar README', subtitle: 'Pronto', canReply: false, canStop: false },
  ] });
  send({ op: 'show' });
  await sleep(2500);          // sprite decodificado, janela composta

  check('helper vivo após config/state/show', exited === null);
  const mb = footprintMB(p.pid);
  check(`footprint < ${MAX_MB} MB`, mb < MAX_MB, `${mb.toFixed(1)} MB`);

  const c0 = cpuSeconds(p.pid);
  await sleep(6000);
  const c1 = cpuSeconds(p.pid);
  const pct = (c1 - c0) / 6 * 100;
  check(`CPU idle ~0% (< ${MAX_CPU_PCT}%)`, pct < MAX_CPU_PCT, `${pct.toFixed(2)}%`);

  // Vai e volta de visibilidade e troca de estado não podem derrubar nem inflar o helper.
  send({ op: 'hide' });
  await sleep(500);
  send({ op: 'state', pet: 'clawd', sprite: 'running', pills: [] });
  send({ op: 'show' });
  await sleep(1500);
  check('helper vivo após hide/show/troca de pet', exited === null);
  const mb2 = footprintMB(p.pid);
  check(`footprint após ciclo < ${MAX_MB} MB`, mb2 < MAX_MB, `${mb2.toFixed(1)} MB`);

  p.stdin.end();              // EOF = o helper tem que sair
  const t1 = Date.now();
  while (exited === null && Date.now() - t1 < 3000) await sleep(50);
  check('helper sai ao fechar o stdin', exited !== null && exited.code === 0, exited ? `code=${exited.code}` : 'ainda vivo');
  if (exited === null) { try { p.kill('SIGKILL'); } catch {} }

  console.log(failed ? `\n${failed} falha(s)` : '\nOK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
