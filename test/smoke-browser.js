#!/usr/bin/env node
/**
 * Smoke test do browser embutido do Norya.
 *
 * Abre o painel, navega até uma página real e afirma que ela carregou.
 *
 * Por que existe: a remoção de Tor, proxy SOCKS, spoofing de fingerprint, vault
 * e loader de extensões mexeu em `prepareSession`, no constructor do
 * BrowserManager e na criação da <webview>. Nem o smoke do renderer nem o do PTY
 * exercitam nada disso — ambos passariam com o navegador completamente quebrado.
 *
 * Requer rede. Sem rede, o teste avisa e pula em vez de reprovar.
 *
 * Uso: node test/smoke-browser.js    → exit 0 = PASS, 1 = FAIL
 */
const dns = require('dns').promises;
const { withApp } = require('./cdp-harness');

const TARGET = 'https://example.com';

/** prepareSession direto pelo IPC: prova que o main monta a sessão sem Tor. */
const PREPARE = `(async () => {
  const { ipcRenderer } = require('electron');
  const accounts = await ipcRenderer.invoke('get-accounts');
  if (!accounts.length) return { ok: false, error: 'nenhum perfil' };
  const profileId = String(accounts[0].num);
  const sess = await ipcRenderer.invoke('norya-browser:open-panel', { profileId, opts: {} });
  return {
    ok: !!(sess && sess.partition),
    profileId,
    partition: sess && sess.partition,
    // Estes campos morreram com o Tor/hardener. Se voltarem, algo foi revertido.
    leakedPreload: !!(sess && sess.preloadPath),
    leakedTor: !!(sess && ('torOk' in sess || 'socksPort' in sess)),
  };
})()`;

/** Abre o painel pela UI e carrega a página, como o usuário faria. */
const NAVIGATE = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const btn = document.getElementById('btnNoryaBrowser');
  if (!btn) return { ok: false, stage: 'botão', error: '#btnNoryaBrowser não existe' };
  btn.click();

  const panel = document.getElementById('noryaBrowserPanel');
  for (let i = 0; i < 40 && !panel.classList.contains('open'); i++) await sleep(150);
  if (!panel.classList.contains('open')) return { ok: false, stage: 'painel', error: 'painel não abriu' };

  const addr = document.getElementById('nbAddrInput');
  if (!addr) return { ok: false, stage: 'barra', error: '#nbAddrInput não existe' };
  addr.focus();
  addr.value = ${JSON.stringify(TARGET)};
  addr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  let wv = null;
  for (let i = 0; i < 60; i++) {
    wv = document.querySelector('#nbContent webview');
    if (wv && typeof wv.getURL === 'function') { try { if (wv.getURL()) break; } catch {} }
    await sleep(250);
  }
  if (!wv) return { ok: false, stage: 'webview', error: 'nenhuma <webview> foi criada' };

  // Espera o carregamento assentar.
  let url = '', title = '';
  for (let i = 0; i < 60; i++) {
    try {
      url = wv.getURL() || '';
      title = (typeof wv.getTitle === 'function' ? wv.getTitle() : '') || '';
    } catch {}
    if (title && !/^about:/.test(url)) break;
    await sleep(250);
  }

  const prefs = wv.getAttribute('webpreferences') || '';
  return {
    ok: /example\\.com/.test(url) && title.length > 0,
    stage: 'done',
    url, title,
    hasPreload: wv.hasAttribute('preload'),      // deve ser false
    prefs,                                        // não deve conter contextIsolation=no
  };
})()`;

async function hasNetwork() {
  try { await dns.lookup('example.com'); return true; } catch { return false; }
}

(async () => {
  if (!(await hasNetwork())) {
    console.log('SKIP  sem resolução DNS para example.com — navegador não exercitado');
    console.log('\nPULADO');
    process.exit(0);
  }

  const failures = [];
  try {
    const result = await withApp(async client => {
      const prep = await client.evaluate(PREPARE, { timeoutMs: 20000 });
      if (!prep || !prep.ok) {
        console.log(`FAIL  prepareSession — ${(prep && prep.error) || 'sem retorno'}`);
        failures.push('prepareSession');
      } else {
        console.log(`PASS  prepareSession devolveu partition (${prep.partition})`);
        if (prep.leakedPreload) { console.log('FAIL  prepareSession ainda devolve preloadPath'); failures.push('preloadPath vazou'); }
        else console.log('PASS  sem preloadPath (spoofing removido)');
        if (prep.leakedTor) { console.log('FAIL  prepareSession ainda devolve torOk/socksPort'); failures.push('campos de Tor vazaram'); }
        else console.log('PASS  sem torOk/socksPort (Tor removido)');
      }

      const nav = await client.evaluate(NAVIGATE, { timeoutMs: 60000 });
      if (!nav || !nav.ok) {
        console.log(`FAIL  navegação (estágio: ${nav && nav.stage}) — ${(nav && nav.error) || `url=${nav && nav.url} title=${nav && nav.title}`}`);
        failures.push('navegação');
      } else {
        console.log(`PASS  página carregou (${nav.url} — "${nav.title}")`);
        if (nav.hasPreload) { console.log('FAIL  <webview> ainda tem preload'); failures.push('webview com preload'); }
        else console.log('PASS  <webview> sem preload');
        if (/contextIsolation=no/.test(nav.prefs)) { console.log('FAIL  <webview> ainda usa contextIsolation=no'); failures.push('contextIsolation=no'); }
        else console.log('PASS  <webview> com contextIsolation padrão');
      }
    }, { settleMs: 5000 });

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
