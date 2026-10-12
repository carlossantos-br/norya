/**
 * Smoke: coerência da lista de Tasks (2026-09-09).
 *
 * Roda numa instância ISOLADA (NORYA_HOME temp + userData próprio + socket com
 * sufixo) — pode rodar com o Norya de produção aberto, sem tocar nele.
 *
 * Cobre as três mudanças de UI da leva:
 *   1. o dot da direita carrega SÓ o estado da sessão — a cor do dono saiu dele
 *      (era o "bolinha branca e vazia que não sei o que é");
 *   2. o dono virou chip de TEXTO na linha 2, e é ele quem abre o seletor;
 *   3. "retomar aqui" aparece quando o dono da task ≠ perfil selecionado, e
 *      some quando são o mesmo;
 *   4. o × do pane ENCERRA a task (mata o PTY); ⌥+clique só esconde o pane.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolamento — TEM que vir antes do require do harness (DEFAULT_PORT lê env).
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-tasks-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9227';
fs.mkdirSync(process.env.NORYA_HOME, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });

const { withApp } = require('./cdp-harness');

function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✓ ' + msg); }

// Duas contas, duas tasks: uma da conta ativa (1), outra da conta 2.
const SETUP = `
(async () => {
  api.resize = async () => {};
  api.sendInput = async () => {};
  api.killTerminal = () => { window.__killed = window.__killed || []; };
  st.accounts = [
    { num: 1, name: 'Conta A', color: '#7c5cff', authMode: 'codex' },
    { num: 2, name: 'Conta B', color: '#22c1a4', authMode: 'codex' },
  ];
  st.activeProfileNum = 1;
  const agora = Date.now();
  st.allThreads = [
    { id: 'minha', title: 'Task da conta A', cwd: '', accountNum: 1, provider: 'codex', updated_at_ms: agora },
    { id: 'alheia', title: 'Task da conta B', cwd: '', accountNum: 2, provider: 'codex', updated_at_ms: agora - 1000 },
  ];
  st.threadOwners = { minha: 1, alheia: 2 };
  // Desde 2026-10-10 a sidebar lista só os panes abertos no grid.
  st.gridMode.threadIds = ['minha', 'alheia'];
  document.body.classList.remove('onboarding', 'landing');
  document.getElementById('app').classList.remove('landing');
  renderProjectListNow();
  return { linhas: document.querySelectorAll('.thread-item[data-thread-id]').length };
})()
`;

(async () => {
  const res = await withApp(async ({ evaluate, exceptions }) => {
    const s = await evaluate(SETUP);
    if (s.linhas < 2) { fail(`setup: esperava >=2 linhas de task, veio ${s.linhas}`); return; }
    ok('setup: duas tasks de contas diferentes na sidebar');

    // ── 1+2: dono é texto; dot não tem cor de dono nem é botão ──
    const dono = await evaluate(`(() => {
      const row = document.querySelector('.thread-item[data-thread-id="alheia"]');
      const chip = row.querySelector('.th-owner');
      const dot  = row.querySelector('.th-dot');
      // PTY vivo: é justamente quando o código antigo pintava o dot com a cor do dono.
      st.spawnByThread['alheia'] = 'sp-alheia';
      st.termRunning['sp-alheia'] = true;
      updateWorkingIndicators();
      return {
        temChip: !!chip,
        textoChip: chip ? chip.textContent.trim() : null,
        corDoChip: chip ? chip.querySelector('.th-owner-dot').style.background : null,
        sub: row.querySelector('.th-acc').textContent,
        dotBg: dot.style.background,
        dotTitle: dot.title,
        dotCursor: getComputedStyle(dot).cursor,
      };
    })()`);
    if (!dono.temChip) fail('linha 2 deveria ter o chip .th-owner com a conta dona');
    else if (!/Conta B/.test(dono.textoChip)) fail(`chip deveria nomear a conta dona, veio "${dono.textoChip}"`);
    else if (!dono.corDoChip) fail('o ponto do chip deveria usar a cor da conta');
    else if (!/Codex/.test(dono.sub) || !/Conta B/.test(dono.sub)) fail(`linha 2 deveria ser "provider · conta", veio "${dono.sub}"`);
    else ok('dono da task aparece como texto na linha 2, com a cor da conta');

    if (dono.dotBg) fail(`REGRESSÃO: o dot voltou a carregar a cor do dono (background="${dono.dotBg}")`);
    else if (dono.dotCursor === 'pointer') fail('o dot não deveria mais parecer clicável — ele só informa estado');
    else if (!dono.dotTitle) fail('o dot precisa de tooltip: é a única legenda que ele tem');
    else ok('dot da direita carrega só o estado, com legenda no tooltip');

    // ── legenda muda com o estado ──
    const legenda = await evaluate(`(() => {
      const dot = document.querySelector('.thread-item[data-thread-id="alheia"] .th-dot');
      const visto = {};
      for (const [estado, spawnState] of [['idle', null], ['working', 'working'], ['error', 'error']]) {
        window.evalSpawnState = () => spawnState || 'idle';
        updateWorkingIndicators();
        visto[estado] = { state: dot.dataset.state, title: dot.title };
      }
      return visto;
    })()`);
    const distintos = new Set(Object.values(legenda).map(v => v.title));
    if (distintos.size < 3) fail(`cada estado precisa de legenda própria, veio ${JSON.stringify(legenda)}`);
    else ok('idle / working / error têm legendas distintas no tooltip');

    // ── 3: botão "retomar aqui" só na task de outra conta ──
    await evaluate(`(() => { delete window.evalSpawnState; })()`);   // desfaz o stub acima
    const botao = await evaluate(`(() => {
      const q = id => document.querySelector('.thread-item[data-thread-id="' + id + '"] .th-adopt');
      return { naAlheia: !!q('alheia'), naMinha: !!q('minha'),
               titulo: q('alheia') ? q('alheia').title : null };
    })()`);
    if (!botao.naAlheia) fail('task de OUTRA conta deveria mostrar o botão de retomar aqui');
    else if (botao.naMinha) fail('task da conta ATIVA não deveria mostrar o botão (não há o que adotar)');
    else if (!/Conta A/.test(botao.titulo)) fail(`o tooltip deveria nomear a conta destino, veio "${botao.titulo}"`);
    else ok('"retomar aqui" aparece só quando o dono ≠ perfil selecionado');

    // ── trocar o perfil ativo inverte quem mostra o botão ──
    const invertido = await evaluate(`(() => {
      st.activeProfileNum = 2;
      renderProjectListNow();
      const q = id => document.querySelector('.thread-item[data-thread-id="' + id + '"] .th-adopt');
      return { naAlheia: !!q('alheia'), naMinha: !!q('minha') };
    })()`);
    if (invertido.naAlheia || !invertido.naMinha) {
      fail(`ao ativar a Conta B o botão deveria migrar para a task da Conta A, veio ${JSON.stringify(invertido)}`);
    } else ok('trocar o perfil ativo move o botão para a outra task');

    // ── 4: × do pane encerra a task; ⌥+clique só esconde ──
    const fechar = await evaluate(`(async () => {
      st.activeProfileNum = 1;
      const matou = [];
      window.killTerminalForSpawn = (sid) => { matou.push(sid); st.termRunning[sid] = false; };
      st.spawnByThread['minha'] = 'sp-minha';  st.termRunning['sp-minha'] = true;
      st.spawnByThread['alheia'] = 'sp-alheia'; st.termRunning['sp-alheia'] = true;
      st.gridMode.enabled = true;
      st.gridMode.threadIds = ['minha', 'alheia'];
      document.getElementById('app').dataset.view = 'grid';
      renderGrid();
      await new Promise(r => setTimeout(r, 40));

      const x = t => document.querySelector('.grid-cell[data-thread="' + t + '"] .grid-cell-header .grid-cell-iconbtn:last-child');
      const alvoAlt = x('alheia');
      alvoAlt.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
      await new Promise(r => setTimeout(r, 40));
      const depoisAlt = { matou: matou.slice(), roster: st.gridMode.threadIds.slice() };

      const alvo = x('minha');
      alvo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 40));
      return { depoisAlt, matou, roster: st.gridMode.threadIds.slice(), titulo: alvo.title };
    })()`);
    if (depoisAltFalhou(fechar.depoisAlt)) {
      fail(`⌥+clique deveria só esconder o pane, veio ${JSON.stringify(fechar.depoisAlt)}`);
    } else ok('⌥+clique no × só esconde o pane — a sessão segue viva');

    if (!fechar.matou.includes('sp-minha')) {
      fail(`REGRESSÃO: o × não encerrou a sessão (mataram: ${JSON.stringify(fechar.matou)})`);
    } else if (fechar.roster.includes('minha')) {
      fail('o × matou a sessão mas deixou o pane no grid');
    } else if (!/End task/i.test(fechar.titulo)) {
      fail(`o tooltip do × ainda promete "remove from grid": "${fechar.titulo}"`);
    } else ok('× encerra a task: mata o PTY e tira o pane do grid');

    if (exceptions.length) fail('exceções não capturadas: ' + JSON.stringify(exceptions));
    else ok('sem exceções não capturadas');
  });
  void res;
  console.log(process.exitCode ? '\nSMOKE TASKS UX: FALHOU' : '\nSMOKE TASKS UX: OK');
})();

/** ⌥+clique não pode ter matado nada, e tem que ter tirado o pane do roster. */
function depoisAltFalhou(d) {
  return d.matou.length !== 0 || d.roster.includes('alheia');
}
