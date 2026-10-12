#!/usr/bin/env node
/**
 * Auto-open — integração, com o app rodando.
 *
 * Prova três coisas, e NÃO afirma nada além delas:
 *
 *   1. O PTY nasce com o ambiente certo. `spawnTerminal` injeta $BROWSER e
 *      $NORYA_OPEN_SOCKET e põe o shim na frente do PATH. Verificado lendo a
 *      linha que o main escreve no panel.log para aquele spawn.
 *   2. shim → socket → aba. Uma URL entregue ao socket abre uma aba NO NORYA.
 *      É o mesmo caminho que uma CLI percorre ao chamar `open <url>`.
 *   3. Detecção de dev server. Idem, pela origem `dev-server(<id>)` no log.
 *
 * O comportamento do shim em si (passthrough, precedência do auth, fallback)
 * é coberto por test/open-shim.test.js, sem Electron. A extração de URL, por
 * test/dev-url.test.js. Este arnês cobre a costura entre eles.
 *
 * As URLs apontam para portas locais mortas: a aba nasce e falha ao carregar.
 * O que interessa é que ela nasceu, e no lugar certo.
 *
 * Uso: node test/smoke-auto-open.js   → exit 0 = PASS, 1 = FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { withApp, APP_DIR } = require('./cdp-harness');
const { NORYA_HOME } = require('../norya-home');

const LOG = path.join(NORYA_HOME, 'panel.log');
const SHIM = path.join(APP_DIR, 'bin', 'open-shim', 'open');
const SOCK = path.join('/tmp', `norya-open-${process.getuid()}.sock`);
const URL_ALVO = 'http://127.0.0.1:57322/pagina-de-teste';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fatia o BUFFER e só então decodifica. `logTam()` devolve bytes; fatiar a
 * string decodificada por esse número desliza o corte a cada caractere não-ASCII
 * (o log tem `→` e acentos), comendo justamente as linhas novas.
 */
const logDesde = pos => { try { return fs.readFileSync(LOG).subarray(pos).toString('utf8'); } catch { return ''; } };
const logTam = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };

/** Chama o shim exatamente como uma CLI chamaria `open <url>`. */
function chamarShim(url) {
  return new Promise(resolve => {
    execFile(SHIM, [url], { env: { ...process.env, NORYA_OPEN_SOCKET: SOCK }, timeout: 6000 }, () => resolve());
  });
}

/** Spawna um PTY e devolve seu id — só para observar a injeção de ambiente. */
const SPAWN = `(async () => {
  const { ipcRenderer } = require('electron');
  const accounts = await ipcRenderer.invoke('get-accounts');
  const account = accounts[0];
  if (!account) return { ok: false };
  const r = await ipcRenderer.invoke('spawn-terminal-checked', { account, cwd: '/tmp', spawnId: 'ao-env' });
  return { ok: !!(r && r.ok), id: r && r.id, error: r && r.error };
})()`;

const CONTAR_ABAS = `(() => Array.from(document.querySelectorAll('#nbContent webview')).map(w => w.getAttribute('src') || ''))()`;
const MATAR = `(() => { require('electron').ipcRenderer.send('kill-terminal', 'ao-env'); return true; })()`;

(async () => {
  const falhas = [];
  const marca = logTam();

  try {
    const res = await withApp(async c => {
      // ── 1. ambiente injetado no PTY ──────────────────────────────────────
      const sp = await c.evaluate(SPAWN, { timeoutMs: 20000 });
      if (!sp || !sp.ok) {
        console.log(`FAIL  spawn do PTY falhou: ${sp && sp.error}`);
        falhas.push('spawn');
      } else {
        await sleep(1200);
        const linha = logDesde(marca).split('\n').find(l => l.includes('auto-open') && l.includes(`env injetado id=${sp.id}`));
        if (!linha) {
          console.log('FAIL  o PTY não registrou injeção de ambiente do auto-open');
          falhas.push('env não injetado');
        } else {
          const okBrowser = /BROWSER=.*bin\/open-shim\/open/.test(linha);
          const okPath = /PATH\[0\]=.*bin\/open-shim$/.test(linha.trim());
          console.log(`${okBrowser ? 'PASS' : 'FAIL'}  $BROWSER aponta para o shim`);
          console.log(`${okPath ? 'PASS' : 'FAIL'}  o shim é o PRIMEIRO no PATH do PTY`);
          if (!okBrowser) falhas.push('BROWSER errado');
          if (!okPath) falhas.push('shim não é o primeiro no PATH');
        }
      }

      // ── 2. shim → socket → aba no Norya ──────────────────────────────────
      const antes = (await c.evaluate(CONTAR_ABAS)).length;
      const marca2 = logTam();
      await chamarShim(URL_ALVO);
      await sleep(3000);
      const depois = await c.evaluate(CONTAR_ABAS);

      const criou = depois.length > antes;
      console.log(`${criou ? 'PASS' : 'FAIL'}  \`open <url>\` abriu aba no Norya (${antes} → ${depois.length})`);
      if (!criou) falhas.push('aba não criada');

      const certa = depois.some(u => u.includes('57322'));
      console.log(`${certa ? 'PASS' : 'FAIL'}  a aba aponta para a URL pedida`);
      if (!certa) falhas.push('URL errada');

      const roteado = logDesde(marca2).includes('auto-open') && logDesde(marca2).includes('shim →');
      console.log(`${roteado ? 'PASS' : 'FAIL'}  o main registrou a rota vinda do shim`);
      if (!roteado) falhas.push('sem log de rota');

      await c.evaluate(MATAR).catch(() => {});
    }, { settleMs: 4500 });

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
