/**
 * Smoke: comportamento do grid pós fix-wave 2026-07-21.
 *
 * Roda numa instância ISOLADA (NORYA_HOME temp + userData próprio + socket com
 * sufixo) — pode rodar com o Norya de produção aberto, sem tocar nele.
 *
 * Cobre os bugs corrigidos:
 *   1. fechar o último pane NÃO re-popula o grid com PTYs vivos;
 *   2. template do grid segue o roster visível (1 pane = 1x1), inclusive após
 *      window.resize com sessões em background fora do grid;
 *   3. renderGrid é incremental: mesma célula DOM sobrevive a re-render
 *      (sem dispose/replay do xterm) e ao re-key do latch (spawnId→threadId);
 *   4. foco segue o pane re-chaveado pelo latch.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolamento — TEM que vir antes do require do harness (DEFAULT_PORT lê env).
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-grid-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9223';
fs.mkdirSync(process.env.NORYA_HOME, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });

const { withApp } = require('./cdp-harness');

const SETUP = `
(async () => {
  // Estado fabricado — sem PTY real por trás; stubs nos IPCs de I/O de terminal.
  api.resize = async () => {};
  api.sendInput = async () => {};
  st.accounts = [{ num: 1, name: 'Smoke', color: '#7c5cff', authMode: 'codex' }];
  st.allThreads = [
    { id: 't1', title: 'Thread 1', cwd: '', accountNum: 1, updated_at_ms: Date.now() },
    { id: 't2', title: 'Thread 2', cwd: '', accountNum: 1, updated_at_ms: Date.now() },
    { id: 't3', title: 'Thread 3', cwd: '', accountNum: 1, updated_at_ms: Date.now() },
    { id: 't4', title: 'Thread 4', cwd: '', accountNum: 1, updated_at_ms: Date.now() },
  ];
  document.body.classList.remove('onboarding', 'landing');
  document.getElementById('app').classList.remove('landing');
  document.getElementById('app').dataset.view = 'grid';
  st.gridMode.enabled = true;
  st.gridMode.threadIds = ['t1', 't2', 't3', 't4'];
  st.gridMode.focusedThreadId = 't1';
  st.gridMode.maximizedThreadId = null;
  renderGrid();
  return { cells: document.querySelectorAll('#gridArea > .grid-cell').length,
           cols: document.getElementById('gridArea').style.gridTemplateColumns };
})()
`;

function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✓ ' + msg); }

(async () => {
  const res = await withApp(async ({ evaluate }) => {
    // ── 4 panes = 2×2 ──
    const s = await evaluate(SETUP);
    if (s.cells !== 4) fail(`setup: esperava 4 células, veio ${s.cells}`);
    else if (!/repeat\(2/.test(s.cols)) fail(`setup: template 4 panes deveria ser 2 col, veio "${s.cols}"`);
    else ok('4 panes → template 2×2');

    // ── layout dinâmico (2026-10-04): nunca sobra célula vazia ──
    const dyn = await evaluate(`(async () => {
      const L = (n, w, h) => computeGridLayout(n - 1, w, h, 8).rowSizes.join('+');
      const rules = { three: L(3, 1230, 795), four: L(4, 1230, 795), five: L(5, 1230, 795),
                      seven: L(7, 1230, 795), twoPortrait: L(2, 300, 795), one: L(1, 1230, 795) };
      const holes = [];
      for (const n of [3, 5, 6, 7]) {
        st.gridMode.threadIds = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'].slice(0, n);
        st.allThreads = st.gridMode.threadIds.map(id => ({ id, title: id, cwd: '', accountNum: 1, updated_at_ms: Date.now() }));
        renderGrid();
        await new Promise(r => setTimeout(r, 30));
        const a = document.getElementById('gridArea');
        const cs = getComputedStyle(a), ar = a.getBoundingClientRect();
        const right = ar.right - parseFloat(cs.paddingRight);
        const cells = [...a.querySelectorAll(':scope > .grid-cell')].map(c => c.getBoundingClientRect());
        const rows = new Map();
        for (const c of cells) rows.set(Math.round(c.top), Math.max(rows.get(Math.round(c.top)) || 0, c.right));
        for (const [top, r] of rows) if (Math.abs(r - right) > 2) holes.push(n + ' panes: linha y=' + top + ' termina em ' + Math.round(r) + ' (borda ' + Math.round(right) + ')');
      }
      st.gridMode.threadIds = ['t1', 't2', 't3', 't4'];
      st.allThreads = st.gridMode.threadIds.map(id => ({ id, title: 'Thread ' + id.slice(1), cwd: '', accountNum: 1, updated_at_ms: Date.now() }));
      renderGrid();
      return { rules, holes };
    })()`);
    const want = { three: '3', four: '2+2', five: '3+2', seven: '3+2+2', twoPortrait: '1+1', one: '1' };
    const bad = Object.entries(want).filter(([k, v]) => dyn.rules[k] !== v);
    if (bad.length) fail('layout dinâmico: ' + bad.map(([k, v]) => `${k} esperava ${v}, veio ${dyn.rules[k]}`).join('; '));
    else ok('layout dinâmico: 3→3 colunas, 4→2×2, 5→3+2, 7→3+2+2, retrato→empilha');
    if (dyn.holes.length) fail('células vazias no grid: ' + dyn.holes.join('; '));
    else ok('3/5/6/7 panes: toda linha vai até a borda (sem célula vazia)');

    // ── roster encolhe pra 1 → template 1×1, mesmo com "sessões" vivas fora do grid ──
    const one = await evaluate(`(async () => {
      st.spawnByThread['bg1'] = 'bg1'; st.termRunning['bg1'] = true;  // fora do roster
      st.spawnByThread['bg2'] = 'bg2'; st.termRunning['bg2'] = true;
      st.gridMode.threadIds = ['t1'];
      renderGrid();
      window.dispatchEvent(new Event('resize'));
      await new Promise(r => setTimeout(r, 50));
      const a = document.getElementById('gridArea');
      return { cells: document.querySelectorAll('#gridArea > .grid-cell').length,
               cols: a.style.gridTemplateColumns, rows: a.style.gridTemplateRows };
    })()`);
    if (one.cells !== 1) fail(`1 pane: esperava 1 célula, veio ${one.cells}`);
    else if (!/repeat\(1|^1fr$/.test(one.cols) || !/repeat\(1|^1fr$/.test(one.rows)) {
      fail(`1 pane: template deveria ser 1×1 mesmo após resize c/ PTYs em background, veio cols="${one.cols}" rows="${one.rows}"`);
    } else ok('1 pane + PTYs em background + resize → template continua 1×1');

    // ── fechar o último pane: grid fica vazio de verdade ──
    const closed = await evaluate(`(async () => {
      removeThreadFromGrid('t1');
      await new Promise(r => setTimeout(r, 30));
      return { cells: document.querySelectorAll('#gridArea > .grid-cell').length,
               empty: !!document.querySelector('#gridArea > .grid-empty'),
               roster: st.gridMode.threadIds.length };
    })()`);
    if (closed.cells !== 0 || !closed.empty || closed.roster !== 0) {
      fail(`fechar último pane: esperado grid vazio, veio ${JSON.stringify(closed)}`);
    } else ok('fechar o último pane esvazia o grid (não re-popula com PTYs vivos)');

    // ── incremental: mesma célula DOM sobrevive a re-render ──
    const inc = await evaluate(`(async () => {
      st.gridMode.threadIds = ['t1', 't2'];
      st.gridMode.focusedThreadId = 't1';
      if (typeof hideNewThreadPanel === 'function') hideNewThreadPanel();
      document.body.classList.remove('landing');
      document.getElementById('app').classList.remove('landing');
      renderGrid();
      const c1 = document.querySelector('.grid-cell[data-thread="t1"]');
      c1.__smokeMarker = 'alive';
      st.allThreads.find(t => t.id === 't1').title = 'Thread 1 renamed';
      renderGrid();
      const c2 = document.querySelector('.grid-cell[data-thread="t1"]');
      return { sameNode: c1 === c2, marker: c2 && c2.__smokeMarker,
               title: c2 && c2.querySelector('.grid-cell-title').textContent };
    })()`);
    if (!inc.sameNode || inc.marker !== 'alive') fail('incremental: célula foi reconstruída num re-render sem mudança de spawn');
    else if (inc.title !== 'Thread 1 renamed') fail(`incremental: título não atualizou in place ("${inc.title}")`);
    else ok('re-render reutiliza a célula e atualiza o título in place');

    // ── latch re-key: pane provisório vira thread real sem rebuild + foco segue ──
    const latch = await evaluate(`(async () => {
      st.spawnByThread['prov1'] = 'prov1'; st.termRunning['prov1'] = true;
      st.gridMode.threadIds = ['t1', 'prov1'];
      st.gridMode.focusedThreadId = 'prov1';
      renderGrid();
      const before = document.querySelector('.grid-cell[data-thread="prov1"]');
      before.__smokeMarker = 'latch';
      // simula o latch: linha real chega no DB, mapeamento re-chaveia
      st.allThreads.push({ id: 'real1', title: 'Latched', cwd: '', accountNum: 1, updated_at_ms: Date.now() });
      delete st.spawnByThread['prov1'];
      st.spawnByThread['real1'] = 'prov1';
      st.gridMode.threadIds = ['t1', 'real1'];
      st.gridMode.focusedThreadId = 'real1';
      renderGrid();
      const after = document.querySelector('.grid-cell[data-thread="real1"]');
      return { sameNode: before === after, marker: after && after.__smokeMarker,
               focused: after && after.classList.contains('gc-focused'),
               title: after && after.querySelector('.grid-cell-title').textContent,
               spawn: after && after.dataset.spawn };
    })()`);
    if (!latch.sameNode || latch.marker !== 'latch') fail('latch: célula foi reconstruída no re-key spawnId→threadId');
    else if (!latch.focused) fail('latch: foco não seguiu o pane re-chaveado');
    else if (latch.title !== 'Latched') fail(`latch: título não atualizou ("${latch.title}")`);
    else if (latch.spawn !== 'prov1') fail(`latch: dataset.spawn deveria seguir o PTY vivo ("${latch.spawn}")`);
    else ok('latch re-chaveia a célula in place, com foco e título certos');

    // ── área do grid muda de tamanho (sem window.resize) → template re-decide ──
    // 2 panes em área paisagem = 2 col × 1 linha; espremendo a área pra um
    // retrato (~300px de largura), o layout deve TRANSPOR pra 1 col × 2 linhas.
    const reflow = await evaluate(`(async () => {
      const area = document.getElementById('gridArea');
      const before = area.style.gridTemplateColumns;
      // Só a LARGURA: num container column-flex, mexer no flex-basis mudaria a
      // altura e a área viraria um quadrado (ar=1.0), que não transpõe.
      area.style.width = '300px';
      await new Promise(r => setTimeout(r, 350));   // debounce do observer = 120ms
      const squeezed = { cols: area.style.gridTemplateColumns, rows: area.style.gridTemplateRows };
      area.style.width = '';
      await new Promise(r => setTimeout(r, 350));
      const restored = { cols: area.style.gridTemplateColumns };
      return { before, squeezed, restored,
               areaH: area.getBoundingClientRect().height };
    })()`);
    if (!/repeat\(2/.test(reflow.before)) fail(`reflow: baseline deveria ser 2 colunas, veio "${reflow.before}"`);
    else if (!/repeat\(1/.test(reflow.squeezed.cols) || !/repeat\(2/.test(reflow.squeezed.rows)) {
      fail(`reflow: área retrato deveria transpor pra 1×2, veio cols="${reflow.squeezed.cols}" rows="${reflow.squeezed.rows}"`);
    } else if (!/repeat\(2/.test(reflow.restored.cols)) {
      fail(`reflow: restaurar a área deveria voltar pra 2 colunas, veio "${reflow.restored.cols}"`);
    } else ok('área do grid mudou de tamanho (sem window.resize) → layout re-decidido e restaurado');
  }, { port: Number(process.env.NORYA_SMOKE_PORT) });

  if (res.exceptions.length) fail('exceções no renderer:\n  ' + res.exceptions.join('\n  '));
  if (res.leaked.length) fail('processos Electron vazados: ' + res.leaked.join(', '));
  try { fs.rmSync(ISO, { recursive: true, force: true }); } catch {}
  if (process.exitCode) { console.error('SMOKE GRID UX: FALHOU'); process.exit(1); }
  console.log('SMOKE GRID UX: OK');
})().catch(err => { console.error('harness:', err.message); process.exit(1); });
