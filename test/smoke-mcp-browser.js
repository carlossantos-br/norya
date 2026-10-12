#!/usr/bin/env node
/**
 * Automação do navegador por agente (MCP), ponta a ponta.
 *
 * Sobe um PTY (o que inicia o MCPServer daquele perfil), abre o painel, e usa o
 * CLI `bin/norya-browser` — exatamente o caminho que um agente percorre — para
 * abrir uma aba e listá-la.
 *
 * Este caminho NUNCA funcionou até 2026-07-10, e dois bugs o mantinham morto:
 *
 *   1. `main.js` injetava `/tmp/norya-browser-N.sock` no PTY enquanto o servidor
 *      escutava em `os.tmpdir()` — no macOS, `/var/folders/…`. ENOENT silencioso.
 *   2. O servidor usava `allowHalfOpen: false` (padrão). O CLI faz half-close após
 *      escrever, o Node encerrava o lado gravável, e a resposta do handler async
 *      era escrita num socket fechado. A aba ABRIA e o agente recebia zero bytes.
 *
 * Nenhum teste pegava porque nenhum exercitava a ponte. Este exercita.
 *
 * Custo: zero token. Uso: node test/smoke-mcp-browser.js
 */
const { execFile } = require('child_process');
const path = require('path');
const { withApp, APP_DIR } = require('./cdp-harness');

const CLI = path.join(APP_DIR, 'bin', 'norya-browser');
const rodar = (sock, args) => new Promise(res => {
  execFile(CLI, args, { env: { ...process.env, NORYA_BROWSER_MCP_SOCKET: sock }, timeout: 15000 },
    (err, out, errOut) => res({ code: err ? (err.code ?? -1) : 0, out: String(out).trim(), err: String(errOut).trim() }));
});

const PREP = `(async () => {
  const { ipcRenderer } = require('electron');
  const accs = await ipcRenderer.invoke('get-accounts');
  const acc = accs.find(a => a.authMode === 'chatgpt') || accs[0];
  // Spawnar um PTY inicia o MCPServer daquele perfil (lazy).
  await ipcRenderer.invoke('spawn-terminal-checked', { account: acc, cwd: '/tmp', spawnId: 'mcp-1' });
  document.getElementById('btnNoryaBrowser').click();
  await new Promise(r => setTimeout(r, 2500));
  return { num: acc.num, abas: document.querySelectorAll('#nbContent webview').length };
})()`;
const CONTAR = `Array.from(document.querySelectorAll('#nbContent webview')).map(w => w.getAttribute('src') || '')`;
const MATAR = `(() => { require('electron').ipcRenderer.send('kill-terminal','mcp-1'); return true; })()`;

(async () => {
  await withApp(async c => {
    const p = await c.evaluate(PREP, { timeoutMs: 30000 });
    const sock = require('../browser/mcp-server').socketPathFor(p.num);
    console.log(`perfil ${p.num} · abas antes: ${p.abas} · socket ${sock}`);
    await new Promise(r => setTimeout(r, 1500));

    const abrir = await rodar(sock, ['browser_open', '--url=http://127.0.0.1:57399/mcp-teste', '--new_tab=true']);
    console.log('browser_open  → code=' + abrir.code, abrir.out.slice(0, 120) || abrir.err.slice(0, 120));
    await new Promise(r => setTimeout(r, 2500));

    const urls = await c.evaluate(CONTAR);
    console.log('abas depois   →', JSON.stringify(urls));

    const listar = await rodar(sock, ['browser_list_tabs']);
    console.log('list_tabs     → code=' + listar.code, listar.out.slice(0, 160) || listar.err.slice(0, 160));

    await c.evaluate(MATAR).catch(() => {});
    const falhas = [];
    if (abrir.code !== 0) { console.log('FAIL  browser_open não retornou 0'); falhas.push('open'); }
    else console.log('PASS  browser_open respondeu com tabId');

    if (!urls.some(u => u.includes('57399'))) { console.log('FAIL  a aba não nasceu na engine <webview>'); falhas.push('aba'); }
    else console.log('PASS  a aba nasceu na engine <webview>');

    if (listar.code !== 0 || !listar.out.includes('57399')) { console.log('FAIL  browser_list_tabs não listou a aba'); falhas.push('list'); }
    else console.log('PASS  browser_list_tabs listou a aba');

    if (/\btor\b/.test(listar.out)) { console.log('FAIL  o snapshot ainda expõe o campo morto `tor`'); falhas.push('campo tor'); }
    else console.log('PASS  snapshot sem o campo `tor` (removido com o Tor)');

    console.log('\n' + (falhas.length ? `FALHOU (${falhas.length}): ${falhas.join(', ')}` : 'TUDO PASSOU'));
    if (falhas.length) process.exitCode = 1;
  }, { settleMs: 4000 });
})();
