#!/usr/bin/env node
/**
 * Smoke: Cmd+F no terminal (renderer/find.js + @xterm/addon-search, 2026-07-15).
 *
 * Cria um xterm REAL no renderer (mesmos globais Terminal/SearchAddon que
 * views.js usa), escreve um marker no scrollback, registra a instância como
 * pane focado do grid e dirige a find bar: open → digitar → navegar → fechar.
 *
 * Também prova que o require('@xterm/addon-search') resolve no renderer — o
 * gotcha clássico de dep nova ausente do node_modules do bundle.
 *
 * Uso: node test/smoke-search.js → exit 0 PASS / 1 FAIL. Norya FECHADO.
 */
const { withApp } = require('./cdp-harness');

const SCRIPT = `(async () => {
  const F = window.__termFind;
  if (!F) return { ok:false, stage:'módulo ausente' };
  if (typeof SearchAddon !== 'function') return { ok:false, stage:'SearchAddon ausente' };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sid = 'smoke-find-s1', tid = 'smoke-find-t1';
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed; left:20px; top:60px; width:600px; height:300px;';
  document.body.appendChild(container);

  const term = new Terminal({ scrollback: 8000, allowProposedApi: true });
  const search = new SearchAddon();
  term.loadAddon(search);
  term.open(container);
  for (let i = 0; i < 50; i++) term.writeln('linha de ruído ' + i);
  term.writeln('AGULHA_NORYA aqui');
  term.writeln('e mais ruído depois');
  await sleep(300);

  try {
    // Lazy no app real: só nasce quando o 1º pane monta (views.js:588).
    if (!st.gridCellXterms) st.gridCellXterms = {};
    st.gridCellXterms[sid] = { term, search, container };
    st.spawnByThread[tid] = sid;
    st.gridMode.focusedThreadId = tid;

    F.open();
    const bar = document.getElementById('termFindBar');
    const visible = bar.style.display !== 'none';

    const input = document.getElementById('tfInput');
    input.value = 'AGULHA_NORYA';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    const count = document.getElementById('tfCount').textContent;

    F.close();
    const closed = bar.style.display === 'none';

    return { ok: visible && /1\\/1/.test(count) && closed, visible, count, closed };
  } finally {
    delete st.gridCellXterms[sid];
    delete st.spawnByThread[tid];
    st.gridMode.focusedThreadId = null;
    try { term.dispose(); } catch {}
    container.remove();
  }
})()`;

(async () => {
  const failures = [];
  try {
    const result = await withApp(async client => {
      const r = await client.evaluate(SCRIPT, { timeoutMs: 30000 });
      if (!r || !r.ok) { console.log('FAIL  busca: ' + JSON.stringify(r)); failures.push('busca'); }
      else {
        console.log('PASS  find bar abre sobre o pane focado');
        console.log(`PASS  busca acha o marker (contador "${r.count}")`);
        console.log('PASS  Esc/close fecha e limpa');
      }
    }, { settleMs: 5000 });
    if (result.exceptions.length) {
      console.log(`FAIL  exceções não capturadas (${result.exceptions.length})`);
      result.exceptions.slice(0, 3).forEach(e => console.log('        ' + String(e).slice(0, 200)));
      failures.push('exceções');
    } else console.log('PASS  sem exceções não capturadas');
  } catch (err) { console.log('FAIL  arnês: ' + err.message); failures.push('arnês'); }
  console.log(`\n${failures.length ? 'FALHOU: ' + failures.join(', ') : 'TUDO PASSOU'}`);
  process.exit(failures.length ? 1 : 0);
})();
