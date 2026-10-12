#!/usr/bin/env node
/**
 * Smoke: single-instance lock (main.js, 2026-07-15).
 *
 * Sobe o app pelo harness e tenta uma SEGUNDA instância do mesmo binário:
 * ela deve sair sozinha (requestSingleInstanceLock falha → app.quit) e a
 * primeira deve continuar viva. Antes do lock, duas instâncias disputavam os
 * sockets de /tmp e os JSONs de estado em ~/.norya.
 *
 * Uso: node test/smoke-single-instance.js → exit 0 PASS / 1 FAIL. Norya FECHADO.
 */
const { spawn } = require('child_process');
const path = require('path');
const { withApp } = require('./cdp-harness');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON = require('electron');

(async () => {
  const failures = [];
  try {
    const result = await withApp(async client => {
      // Primeira instância viva (o próprio harness). Agora a segunda:
      const second = spawn(ELECTRON, ['.'], { cwd: APP_DIR, stdio: 'ignore' });
      const exited = await new Promise(resolve => {
        const t = setTimeout(() => resolve(false), 15000);
        second.on('exit', () => { clearTimeout(t); resolve(true); });
      });
      if (!exited) {
        try { second.kill('SIGKILL'); } catch {}
        console.log('FAIL  segunda instância não saiu sozinha em 15s');
        failures.push('lock');
      } else {
        console.log('PASS  segunda instância saiu sozinha (lock funcionou)');
      }

      // Primeira segue respondendo?
      const alive = await client.evaluate('1 + 1', { timeoutMs: 5000 });
      if (alive === 2) console.log('PASS  primeira instância segue viva e responsiva');
      else { console.log('FAIL  primeira instância parou de responder'); failures.push('primeira morreu'); }
    }, { settleMs: 5000 });
    if (result.exceptions.length) {
      console.log(`FAIL  exceções não capturadas (${result.exceptions.length})`);
      failures.push('exceções');
    } else console.log('PASS  sem exceções não capturadas');
  } catch (err) { console.log('FAIL  arnês: ' + err.message); failures.push('arnês'); }
  console.log(`\n${failures.length ? 'FALHOU: ' + failures.join(', ') : 'TUDO PASSOU'}`);
  process.exit(failures.length ? 1 : 0);
})();
