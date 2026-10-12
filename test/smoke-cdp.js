#!/usr/bin/env node
/**
 * Smoke test do renderer do Norya.
 *
 * Teste de CARACTERIZAÇÃO: prova que uma deleção ou extração não mudou o
 * comportamento observável do renderer. Rode antes E depois de cada mudança.
 *
 * Exceção não capturada reprova. `console.error` é aviso — o app emite alguns
 * em condição normal, e tratá-los como falha tornaria o arnês inútil.
 *
 * Uso: node test/smoke-cdp.js     → exit 0 = PASS, 1 = FAIL
 */
const { withApp } = require('./cdp-harness');

/**
 * Símbolos reais do renderer, verificados em 2026-07-09:
 *   `st`  → const global, test-window.html:4075
 *   `api` → const global, test-window.html:4125
 *   .sidebar :2611 · #projectList :2639 · #inputField :2869
 * A janela roda com nodeIntegration:true, então `require` existe no renderer.
 */
const CHECKS = [
  ['objeto de estado global (st)', `typeof st === 'object' && st !== null`],
  ['st.allThreads inicializado',   `Array.isArray(st.allThreads)`],
  ['camada de IPC global (api)',   `typeof api === 'object' && api !== null`],
  ['nodeIntegration ativo',        `typeof require === 'function'`],
  ['sidebar renderizada',          `!!document.querySelector('.sidebar')`],
  ['lista de projetos no DOM',     `!!document.getElementById('projectList')`],
  ['composer no DOM',              `!!document.getElementById('inputField')`],
  // A folha de estilo é um arquivo separado desde a Fase 2. Sem estes dois
  // checks, um <link> quebrado passaria despercebido: os elementos acima
  // existiriam do mesmo jeito, só que sem estilo nenhum.
  ['CSS carregado (custom property)',
   `getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim().length > 0`],
  // Largura padrão da sidebar = --sidebar-w (2026-09-07: 228px, ref 217).
  // Instância isolada = sem largura persistida em localStorage.
  ['CSS aplicado (sidebar 228px)',
   `getComputedStyle(document.querySelector('.sidebar')).width === '228px'`],
  // Nav da sidebar (ex-rail, 2026-09-07): Sessões/Uso/Navegador/Skills no
  // #rail e Settings no rodapé — 5 botões com data-rail no documento inteiro.
  // Grid deixou de ser um botão do rail na Task 11; a grid é a única view.
  ['nav com 5 botões (4 no #rail + Settings no rodapé)',
   `document.querySelectorAll('.rail-btn[data-rail]').length === 5
    && document.querySelectorAll('#rail .rail-btn[data-rail]').length === 4`],
  // Sem rail sobrevivente: recolher a sidebar zera a largura e o botão de
  // expandir aparece no header principal (é o caminho de volta, além de ⌘.).
  // A largura anima 0.24s — ler depois da transição, senão pega o meio.
  ['colapso da sidebar mostra o botão de expandir no header',
   `(async () => { document.body.classList.add('sidebar-collapsed');
                   await new Promise(r => setTimeout(r, 400));
                   const w = getComputedStyle(document.getElementById('sidebar')).width;
                   const btn = getComputedStyle(document.getElementById('sidebarExpand')).display;
                   document.body.classList.remove('sidebar-collapsed');
                   await new Promise(r => setTimeout(r, 300));
                   return w === '0px' && btn !== 'none'; })()`],
  ['painel Threads é o inicial',
   `!document.getElementById('panelThreads').hidden && document.getElementById('panelUso').hidden`],
  ['painel Uso abre pelo rail e lista cartões',
   `(async () => { document.getElementById('railUso').click();
                   await new Promise(r => setTimeout(r, 900));
                   return document.querySelectorAll('#usoList .uso-card').length > 0; })()`],
  // Seletor de agente (Fase 3).
  ['seletor de agente existe e abre',
   `(async () => { document.getElementById('railThreads').click();
                   document.getElementById('agentPickerBtn').click();
                   await new Promise(r => setTimeout(r, 500));
                   return document.querySelectorAll('#agentMenu .agent-item').length >= 4; })()`],
  // Regra dura: escolher uma CLI ausente spawnaria um PTY que morre em
  // "command not found". Toda ausente precisa estar `disabled`, não só esmaecida.
  //
  // Verdadeiro por vacuidade quando TODAS estão instaladas — e isso é correto.
  // A versão anterior exigia `itens.length > 0` e passou a reprovar no momento
  // em que o Grok e o OpenCode foram instalados: o teste presumia o ambiente.
  ['toda CLI ausente está desabilitada no seletor',
   `Array.from(document.querySelectorAll('#agentMenu .agent-item.is-missing')).every(i => i.disabled)`],
  // O par complementar: o que está instalado precisa ser escolhível. Sem este,
  // um bug que desabilitasse tudo passaria pelo check acima sem ser notado.
  ['CLI instalada é escolhível no seletor',
   `(() => { const ok = Array.from(document.querySelectorAll('#agentMenu .agent-item:not(.is-missing)'));
             return ok.length >= 2 && ok.every(i => !i.disabled); })()`],
  // Limpeza de 2026-07-10: o rail é a única superfície de navegação global.
  // Estes checks impedem que os controles duplicados voltem ao header/rodapé.
  ['navegador não está visível no header (vive no rail)',
   `(() => { const b = document.getElementById('btnNoryaBrowser');
             return !b || getComputedStyle(b).display === 'none'; })()`],
  ['dropdown de view-mode "Xterm ▾" foi removido do header',
   `!document.getElementById('viewModeWrap')`],
  ['botão Settings do rodapé foi removido (vive no rail)',
   `!document.querySelector('.sidebar .footer-btn')`],
  ['rail Config abre as configurações',
   `(async () => { document.getElementById('railConfig').click();
                   await new Promise(r => setTimeout(r, 500));
                   const aberto = !document.getElementById('modalSettings').classList.contains('hidden');
                   document.getElementById('btnSettingsClose')?.click();
                   return aberto; })()`],
];

(async () => {
  const failures = [];
  let result;

  try {
    result = await withApp(async client => {
      for (const [label, expr] of CHECKS) {
        let ok = false;
        try { ok = (await client.evaluate(expr)) === true; } catch { ok = false; }
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
        if (!ok) failures.push(label);
      }
    });
  } catch (err) {
    console.log(`FAIL  arnês: ${err.message}`);
    console.log(`\nFALHOU (1): arnês`);
    process.exit(1);
  }

  if (result.exceptions.length) {
    console.log(`FAIL  sem exceções não capturadas (${result.exceptions.length})`);
    result.exceptions.slice(0, 5).forEach(e => console.log(`        ${String(e).slice(0, 200)}`));
    failures.push('exceções não capturadas');
  } else {
    console.log('PASS  sem exceções não capturadas');
  }

  if (result.consoleErrors.length) {
    console.log(`\nAVISO: ${result.consoleErrors.length} console.error (não reprova):`);
    result.consoleErrors.slice(0, 5).forEach(e => console.log(`   • ${String(e).slice(0, 160)}`));
  }
  if (result.leaked.length) {
    console.log(`\nFAIL  vazou processo Electron (PIDs ${result.leaked.join(', ')})`);
    failures.push('processo vazado');
  }

  console.log(`\n${failures.length ? `FALHOU (${failures.length}): ${failures.join(', ')}` : 'TUDO PASSOU'}`);
  process.exit(failures.length ? 1 : 0);
})();
