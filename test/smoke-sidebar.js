/**
 * Smoke: sidebar "Sessões abertas" (2026-10-10) — lista só os panes do grid.
 * Sem Projects/Tasks, sem busca; clique foca o pane; ⌘N-vazio mostra o aviso.
 *
 * Roda numa instância ISOLADA (NORYA_HOME temp + userData próprio + socket com
 * sufixo) — pode rodar com o Norya de produção aberto, sem tocar nele.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolamento — TEM que vir antes do require do harness (DEFAULT_PORT lê env).
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-sidebar-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke-sidebar';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9224';
fs.mkdirSync(process.env.NORYA_HOME, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });

const { withApp, sleep } = require('./cdp-harness');

// 30 threads no histórico, 2 delas abertas no grid.
const SETUP = `
(async () => {
  api.resize = async () => {};
  api.sendInput = async () => {};
  api.spawnTerminal = async () => ({ ok: true });
  st.accounts = [{ num: 1, name: 'Smoke', color: '#7c5cff', authMode: 'codex' }];
  const now = Date.now();
  st.allThreads = Array.from({ length: 30 }, (_, i) => ({
    id: 't' + i, title: 'Task ' + i, cwd: '/dev/p' + (i % 5), accountNum: 1, updated_at_ms: now - i * 1000 }));
  document.body.classList.remove('onboarding', 'landing');
  document.getElementById('app').classList.remove('landing');
  st.gridMode.threadIds = [];
  renderProjectListNow();
  const empty = (document.querySelector('#projectList .proj-empty') || {}).textContent || '';
  st.gridMode.threadIds = ['t7', 't3'];
  renderProjectListNow();
  return {
    empty,
    labels: [...document.querySelectorAll('#projectList .sidebar-section-label')].map(e => e.textContent),
    rows: [...document.querySelectorAll('#projectList .thread-item')].map(e => e.dataset.threadId),
    search: !!document.getElementById('searchInput'),
    rail: document.querySelector('#railThreads .rail-label').textContent,
  };
})()
`;

function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✓ ' + msg); }

(async () => {
  await withApp(async ({ evaluate }) => {
    const s = await evaluate(SETUP);
    /Nenhuma sessão aberta/.test(s.empty) ? ok('grid vazio: aviso') : fail('aviso vazio: ' + JSON.stringify(s.empty));
    JSON.stringify(s.labels) === '["Sessões abertas"]' ? ok('só a seção Sessões abertas') : fail('seções: ' + JSON.stringify(s.labels));
    JSON.stringify(s.rows) === '["t7","t3"]' ? ok('lista = panes do grid, na ordem do grid') : fail('linhas: ' + JSON.stringify(s.rows));
    !s.search ? ok('sem busca') : fail('busca ainda existe');
    s.rail === 'Sessões' ? ok('rail diz Sessões') : fail('rail: ' + s.rail);

    // Fechar um pane some da lista (renderGrid agenda o redesenho da sidebar).
    await evaluate(`(() => { removeThreadFromGrid('t7'); if (typeof renderGrid === 'function') renderGrid(); renderProjectListNow(); })()`);
    await sleep(200);
    const after = await evaluate(`[...document.querySelectorAll('#projectList .thread-item')].map(e => e.dataset.threadId)`);
    JSON.stringify(after) === '["t3"]' ? ok('pane fechado sai da lista') : fail('depois de fechar: ' + JSON.stringify(after));
  }, { port: Number(process.env.NORYA_SMOKE_PORT) });
  try { fs.rmSync(ISO, { recursive: true, force: true }); } catch {}
})().catch(e => { console.error(e); process.exit(1); });
