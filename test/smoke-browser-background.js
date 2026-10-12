#!/usr/bin/env node
/**
 * Smoke: fechar o painel do browser NÃO destrói as abas (2026-07-14).
 *
 * Abre o painel, carrega example.com, fecha o painel pelo X e afirma que:
 *   1. o painel escondeu (classe .open saiu);
 *   2. a <webview> continua no DOM com a URL carregada;
 *   3. capturePage em background devolve imagem não-vazia (painel segue
 *      compositado — é o que permite screenshot de agente escondido);
 *   4. reabrir o painel mostra a mesma aba (sem recriar webview).
 *
 * Por que existe: até 2026-07-14 fechar o painel destruía as <webview> e
 * apagava o storage do perfil — "fechar" era "esquecer tudo". Nenhum smoke
 * pegaria uma regressão porque nenhum fechava o painel no meio.
 *
 * Requer rede. Sem DNS o teste pula. Norya precisa estar FECHADO.
 * Uso: node test/smoke-browser-background.js → exit 0 PASS / 1 FAIL
 */
const dns = require('dns').promises;
const { withApp } = require('./cdp-harness');

const SCRIPT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const panel = $('noryaBrowserPanel');

  $('btnNoryaBrowser').click();
  for (let i = 0; i < 40 && !panel.classList.contains('open'); i++) await sleep(150);
  if (!panel.classList.contains('open')) return { ok:false, stage:'abrir painel' };

  const addr = $('nbAddrInput');
  addr.value = 'https://example.com';
  addr.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
  let wv = null;
  for (let i = 0; i < 60; i++) {
    wv = document.querySelector('#nbContent webview');
    try { if (wv && /example\\.com/.test(wv.getURL())) break; } catch {}
    await sleep(250);
  }
  if (!wv) return { ok:false, stage:'carregar aba' };
  await sleep(1000);

  $('nbClose').click();
  await sleep(500);
  const hidden = !panel.classList.contains('open');

  const alive = document.querySelector('#nbContent webview');
  const aliveUrl = alive ? alive.getURL() : null;

  // Screenshot pelo caminho REAL do agente (handler 'norya-browser-agent' →
  // doTabAction), emitindo o evento IPC localmente. A resposta vai pro main
  // (reqId desconhecido, ignorada com segurança); o resultado observável é o
  // arquivo em /tmp. capturePage cru penduraria: painel fora da tela não gera
  // frame — o handler reencosta o painel invisível por um instante (2026-07-14).
  const fsz = require('fs');
  const before = new Set(fsz.readdirSync('/tmp').filter(f => f.startsWith('norya-shot-')));
  require('electron').ipcRenderer.emit('norya-browser-agent', {},
    { reqId: 'smoke-bg', action: 'navigate-tab', payload: { action: 'screenshot', params: {} } });
  let shotBytes = 0;
  for (let i = 0; i < 40 && !shotBytes; i++) {
    await sleep(250);
    const novo = fsz.readdirSync('/tmp').filter(f => f.startsWith('norya-shot-') && !before.has(f));
    if (novo.length) shotBytes = fsz.statSync('/tmp/' + novo[0]).size;
  }
  const hiddenAfterShot = !panel.classList.contains('open') && (getComputedStyle(panel).opacity === '1');

  $('btnNoryaBrowser').click();
  for (let i = 0; i < 40 && !panel.classList.contains('open'); i++) await sleep(150);
  const reopened = panel.classList.contains('open');
  const stillThere = document.querySelectorAll('#nbContent webview').length;

  return { ok: hidden && !!alive && /example\\.com/.test(aliveUrl||'') && reopened && stillThere === 1,
           hidden, aliveUrl, shotBytes, hiddenAfterShot, reopened, stillThere, stage:'done' };
})()`;

(async () => {
  try { await dns.lookup('example.com'); }
  catch {
    console.log('SKIP  sem resolução DNS para example.com — não exercitado');
    console.log('\nPULADO');
    process.exit(0);
  }

  const failures = [];
  try {
    const result = await withApp(async client => {
      const r = await client.evaluate(SCRIPT, { timeoutMs: 90000 });
      if (!r || !r.ok) {
        console.log(`FAIL  background (estágio ${r && r.stage}): ${JSON.stringify(r)}`);
        failures.push('background');
      } else {
        console.log(`PASS  painel escondeu com aba viva (${r.aliveUrl})`);
        console.log(`PASS  reabrir mostra a mesma aba (${r.stillThere} webview)`);
        if (r.shotBytes > 5000) console.log(`PASS  screenshot de agente em background (${r.shotBytes} bytes)`);
        else { console.log(`FAIL  screenshot de agente em background vazio (${r.shotBytes} bytes)`); failures.push('screenshot'); }
        if (r.hiddenAfterShot) console.log('PASS  painel voltou a ficar escondido após o screenshot');
        else { console.log('FAIL  painel ficou visível/traduzido após o screenshot'); failures.push('restore'); }
      }
    }, { settleMs: 5000 });

    if (result.exceptions.length) {
      console.log(`FAIL  exceções não capturadas (${result.exceptions.length})`);
      result.exceptions.slice(0, 3).forEach(e => console.log(`        ${String(e).slice(0, 200)}`));
      failures.push('exceções');
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
