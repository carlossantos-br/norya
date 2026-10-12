#!/usr/bin/env node
/**
 * Smoke E2E: pane em modo CHAT (2026-10-11).
 *
 * Norya isolado → seletor em "Chat" → task nova de Claude → o pane monta a
 * conversa (sem xterm) → mensagem pelo composer → `claude -p` real responde →
 * confere: bolha do usuário, turno que fecha com "Trabalhou por", resposta
 * final, latch no id real da sessão, dot do pane voltando de 'working'. Depois
 * troca o pane para TUI pelo menu (mesma sessão, xterm) e de volta para chat
 * (histórico reaparece). Salva um print em $NORYA_SMOKE_SHOT (opcional).
 *
 * Custo: 2 prompts curtos no haiku. Roda com o Norya de produção aberto
 * (porta 9231, socket com sufixo próprio). Uso: node test/smoke-chat-ui.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-chat-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke-chat';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9231';
const conta = path.join(process.env.NORYA_HOME, 'accounts', '1');
fs.mkdirSync(conta, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });
fs.writeFileSync(path.join(conta, 'name.txt'), 'smoke claude');
fs.writeFileSync(path.join(conta, 'profile.json'), JSON.stringify({ authMode: 'claude', claudeModel: 'haiku' }));
// HOME: pasta já confiada — a volta pra TUI (claude --resume) abriria o
// diálogo de confiança numa pasta nova. O prompt só roda um echo.
const CWD = os.homedir();
// Alvo do teste de "@": arquivo próprio do smoke, apagado no fim.
const ARQ_AT = 'norya-smoke-at-' + process.pid + '.md';
fs.writeFileSync(path.join(CWD, ARQ_AT), 'smoke\n');
process.on('exit', () => { try { fs.unlinkSync(path.join(CWD, ARQ_AT)); } catch {} });

try { execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { stdio: 'ignore' }); }
catch { console.log('SKIP  claude não está no PATH'); process.exit(0); }

const { withApp } = require('./cdp-harness');

const SCRIPT = `(async () => {
  const espera = async (fn, ms) => { const ate = Date.now() + ms; while (Date.now() < ate) { try { if (fn()) return true; } catch {} await new Promise(r => setTimeout(r, 250)); } return false; };
  await espera(() => st.initDone && st.accounts.length, 20000);
  const acc = st.accounts.find(a => a.authMode === 'claude');
  if (!acc) return { ok: false, motivo: 'sem perfil claude' };
  st.activeProfileNum = acc.num;
  document.querySelector('#paneUiToggle button[data-ui="chat"]').click();
  const r = {};
  r.toggleAtivo = st.paneUi === 'chat' && localStorage.getItem('norya-pane-ui') === 'chat';
  const spawnId = await createThreadInFolder(${JSON.stringify(CWD)}, { skipGitPrompt: true, agentId: 'claude' });
  r.spawnUi = st.spawnUi[spawnId];
  await espera(() => document.querySelector('.grid-cell[data-spawn="' + spawnId + '"] .cm-root'), 8000);
  const cell = () => document.querySelector('.grid-cell[data-spawn="' + spawnId + '"]');
  r.semXterm = !cell().querySelector('.xterm');
  r.temComposer = !!cell().querySelector('textarea.cm-input');
  r.prontoParaDigitar = await espera(() => /O que vamos fazer/.test(cell().querySelector('.cm-empty')?.textContent || ''), 15000);

  const ta = cell().querySelector('textarea.cm-input');
  ta.value = 'Rode o comando bash: echo norya-chat-ok. Depois responda só: pronto';
  ta.dispatchEvent(new Event('input'));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
  r.bolha = cell().querySelector('.cm-user')?.textContent || '';
  r.trabalhando = !!cell().querySelector('.cm-turn.is-running .cm-shimmer');
  r.dotWorking = await espera(() => cell().querySelector('.grid-cell-dot')?.dataset.state === 'working', 15000);
  r.fechou = await espera(() => !document.querySelector('.cm-turn.is-running') && document.querySelector('.cm-worked, .cm-turn .cm-text'), 120000);
  const root = document.querySelector('.grid-cell .cm-root');
  if (!root) return { ok: false, motivo: 'pane de chat sumiu depois do turno', fechou: r.fechou, ids: st.gridMode.threadIds, cells: Array.from(document.querySelectorAll('.grid-cell')).map(e => ({ t: e.dataset.thread, s: e.dataset.spawn, ui: e.dataset.ui, html: e.innerHTML.slice(0, 300) })), spawnUi: st.spawnUi, running: st.termRunning, sessao: NoryaChat.sessionOf(spawnId), model: (() => { const m = NoryaChat._models[spawnId]; return m && { blocks: m.blocks.length, exited: m.exited, busy: m.busy }; })() };
  const c = root.closest('.grid-cell');
  r.trabalhou = c.querySelector('.cm-worked')?.textContent || '';
  r.resposta = Array.from(c.querySelectorAll('.cm-turn > .cm-text')).map(e => e.textContent).join(' | ');
  // abre o "Trabalhou por" e o grupo de ferramentas
  c.querySelector('.cm-worked')?.click();
  await new Promise(r => setTimeout(r, 120));
  c.querySelector('.cm-group-head')?.click();
  await new Promise(r => setTimeout(r, 120));
  r.grupo = c.querySelector('.cm-group-label')?.textContent || '';
  // O claude às vezes lê o catálogo de skills antes: vale a linha do echo.
  r.ferramenta = Array.from(c.querySelectorAll('.cm-tool-label')).map(e => e.textContent).find(t => t.includes('norya-chat-ok')) || c.querySelector('.cm-tool-label')?.textContent || '';
  r.sessao = NoryaChat.sessionOf(spawnId);
  r.latch = st.gridMode.threadIds.includes(r.sessao) && st.spawnByThread[r.sessao] === spawnId;
  r.threadUi = st.threadUi[r.sessao];
  r.dotDepois = c.querySelector('.grid-cell-dot')?.dataset.state;
  return { ok: true, spawnId, ...r };
})()`;

// Seletor do composer: modelo · esforço. A troca vai por control_request ao
// vivo e o rótulo final vem do get_settings do claude (confirmação real).
const SCRIPT_SELETOR = `(async () => {
  const espera = async (fn, ms) => { const ate = Date.now() + ms; while (Date.now() < ate) { try { if (fn()) return true; } catch {} await new Promise(r => setTimeout(r, 250)); } return false; };
  const r = {};
  const c = document.querySelector('.grid-cell .cm-root').closest('.grid-cell');
  const btn = c.querySelector('.cm-model');
  r.habilitado = await espera(() => !btn.disabled, 10000);
  r.rotulo = btn.textContent;
  btn.click();
  await new Promise(r => setTimeout(r, 150));
  const menu = document.querySelector('.cm-menu');
  r.titulos = Array.from(menu ? menu.querySelectorAll('.cm-menu-title') : []).map(e => e.textContent);
  r.itens = Array.from(menu ? menu.querySelectorAll('.cm-menu-label') : []).map(e => e.textContent);
  const item = txt => Array.from(document.querySelectorAll('.cm-menu .cm-menu-item')).find(e => e.querySelector('.cm-menu-label').textContent === txt);
  item('Baixo')?.click();
  r.menuFechou = !document.querySelector('.cm-menu');
  r.esforco = await espera(() => / · Baixo$/.test(btn.textContent), 5000);
  btn.click();
  await new Promise(r => setTimeout(r, 150));
  const son = Array.from(document.querySelectorAll('.cm-menu .cm-menu-item')).find(e => /^Sonnet/.test(e.querySelector('.cm-menu-label').textContent));
  r.achouSonnet = !!son;
  r.itens2 = Array.from(document.querySelectorAll('.cm-menu .cm-menu-label')).map(e => e.textContent).slice(0, 4);
  son?.click();
  r.logo = btn.textContent;
  r.modelo = await espera(() => /^Sonnet/.test(btn.textContent), 5000);
  // espera a confirmação do claude (get_settings) e confere que não voltou
  await new Promise(r => setTimeout(r, 1500));
  r.depois = btn.textContent;
  r.confirmado = /^Sonnet .* · Baixo$/.test(r.depois);
  r.acesso = getComputedStyle(c.querySelector('.cm-access')).display !== 'none' ? c.querySelector('.cm-access').textContent : '';
  btn.click();
  await new Promise(r => setTimeout(r, 150));
  return r;
})()`;

// Composer: rascunho que sobrevive à remontagem, ↑ histórico, "/" e "@",
// anexo de imagem, fila (remover + andar sozinha), uso do contexto, acesso
// "Pedir aprovação" com cartão, botão "↓" pela geometria.
const SCRIPT_COMPOSER = (spawnId, png, alvo) => `(async () => {
  const espera = async (fn, ms) => { const ate = Date.now() + ms; while (Date.now() < ate) { try { if (fn()) return true; } catch {} await new Promise(r => setTimeout(r, 200)); } return false; };
  const pausa = ms => new Promise(r => setTimeout(r, ms));
  const sid = ${JSON.stringify(spawnId)};
  const r = {};
  NoryaChat.configure(sid, { model: 'haiku' });
  const cell = () => document.querySelector('.grid-cell[data-spawn="' + sid + '"]');
  const ta = () => cell().querySelector('textarea.cm-input');
  const digita = (txt) => { const t = ta(); t.focus(); t.value = txt; t.setSelectionRange(txt.length, txt.length); t.dispatchEvent(new Event('input')); };
  const tecla = (key, extra) => ta().dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, extra || {})));
  const fimDoTurno = () => !cell().querySelector('.cm-turn.is-running') && !NoryaChat.isBusy(sid);

  // rascunho
  digita('rascunho que não pode sumir');
  NoryaChat.mount(sid, cell().querySelector('.grid-cell-chat'));
  r.rascunho = ta().value;
  digita('');
  // ↑ histórico
  tecla('ArrowUp');
  r.historico = ta().value;
  digita('');
  // "/" comandos
  digita('/comp');
  r.acCmd = await espera(() => (cell().querySelector('.cm-ac:not([hidden])')?.textContent || '').includes('/compact'), 3000);
  tecla('Tab');
  r.aceitouCmd = ta().value;
  digita('');
  // "@" arquivos (pasta da sessão = home)
  digita('olhe @' + ${JSON.stringify(ARQ_AT.slice(0, 18))});
  r.acArq = await espera(() => (cell().querySelector('.cm-ac:not([hidden])')?.textContent || '').includes(${JSON.stringify(ARQ_AT)}), 8000);
  tecla('Enter');
  r.aceitouArq = ta().value;
  digita('');

  // anexo de imagem
  NoryaChat.addAttachments(sid, [${JSON.stringify(png)}]);
  r.chip = !!cell().querySelector('.cm-attach:not([hidden]) .cm-chip.is-image img');
  digita('Qual é a cor desta imagem? Responda só a cor em português.');
  tecla('Enter');
  r.chipLimpo = !!cell().querySelector('.cm-attach[hidden]');
  r.bolhaImg = await espera(() => cell().querySelector('.cm-user-img'), 3000);
  await espera(fimDoTurno, 90000);
  const textos = () => Array.from(cell().querySelectorAll('.cm-turn > .cm-text')).map(e => e.textContent).join(' | ');
  r.cor = textos();

  // fila
  digita('Rode o comando bash: sleep 6. Depois responda só: um');
  tecla('Enter');
  await espera(() => NoryaChat.isBusy(sid), 5000);
  digita('Responda só: dois');
  tecla('Enter');
  digita('isso aqui não pode ir');
  tecla('Enter');
  await espera(() => cell().querySelectorAll('.cm-queue .cm-user-row.is-queued').length === 2, 3000);
  r.naFila = cell().querySelectorAll('.cm-queue .cm-user-row.is-queued').length;
  r.tagFila = cell().querySelector('.cm-queued-tag')?.textContent || '';
  const linhas = Array.from(cell().querySelectorAll('.cm-queue .cm-queued'));
  const rem = linhas.find(l => /não pode ir/.test(l.textContent));
  Array.from(rem ? rem.querySelectorAll('.cm-queued-btn') : []).find(b => b.textContent === 'Remover')?.click();
  await pausa(100);
  r.depoisRemover = cell().querySelectorAll('.cm-queue .cm-user-row.is-queued').length;
  r.filaAndou = await espera(() => !cell().querySelector('.cm-queue') && Array.from(cell().querySelectorAll('.cm-user')).some(e => /dois/.test(e.textContent)), 120000);
  await espera(() => fimDoTurno() && /dois/.test(textos()), 90000);
  r.respostas = textos();
  r.removidaNaoFoi = !Array.from(cell().querySelectorAll('.cm-user')).some(e => /não pode ir/.test(e.textContent));

  // "Enviar agora": manda já; a resposta sai embaixo da bolha; o comando
  // que já rodava não duplica entre os blocos.
  digita('Rode o comando bash: sleep 5. Depois responda só: tres');
  tecla('Enter');
  await espera(() => NoryaChat.isBusy(sid), 5000);
  digita('Responda também a palavra quatro.');
  tecla('Enter');
  await espera(() => cell().querySelector('.cm-queue .cm-queued-btn'), 3000);
  Array.from(cell().querySelectorAll('.cm-queue .cm-queued-btn')).find(b => b.textContent === 'Enviar agora')?.click();
  await pausa(150);
  r.steerSemFila = !cell().querySelector('.cm-queue');
  await espera(() => fimDoTurno() && /quatro/i.test(textos()), 120000);
  await pausa(1500);
  await espera(fimDoTurno, 60000);
  const bolhaQ = Array.from(cell().querySelectorAll('.cm-user-row')).find(e => /quatro/.test(e.textContent));
  let depois = bolhaQ && bolhaQ.nextElementSibling, achou = false;
  while (depois) { if (/quatro/i.test(depois.textContent)) { achou = true; break; } depois = depois.nextElementSibling; }
  r.steerOrdem = achou;
  const mm = NoryaChat._models[sid];
  const sleepIds = Array.from(mm.items.values()).filter(it => /sleep 5/.test(it.label || '')).map(it => it.id);
  r.steerSemDuplicar = sleepIds.length > 0 && sleepIds.every(id => mm.blocks.filter(b => b.type === 'turn' && b.ids.includes(id)).length === 1);
  r.steerNadaGirando = !Array.from(mm.items.values()).some(it => it.status === 'running');

  // uso do contexto
  const u = cell().querySelector('.cm-usage');
  r.uso = u && !u.hidden ? u.textContent + ' / ' + u.title.split(String.fromCharCode(10)).join(' · ') : '';

  // acesso: pedir aprovação → cartão → aprovar
  cell().querySelector('.cm-access').click();
  await pausa(150);
  r.opcoesAcesso = Array.from(document.querySelectorAll('.cm-menu .cm-menu-label')).map(e => e.textContent);
  Array.from(document.querySelectorAll('.cm-menu .cm-menu-item')).find(e => /Pedir aprovação/.test(e.textContent))?.click();
  r.rotuloAcesso = await espera(() => /Pedir aprovação/.test(cell().querySelector('.cm-access').textContent), 8000);
  digita('Use a ferramenta Bash para rodar exatamente: touch ${alvo} . Depois responda só: feito');
  tecla('Enter');
  r.cartao = await espera(() => cell().querySelector('.cm-approval'), 60000);
  r.cartaoTexto = cell().querySelector('.cm-approval')?.textContent.slice(0, 120) || '';
  cell().querySelector('.cm-approval .cm-btn-primary')?.click();
  await espera(fimDoTurno, 90000);
  r.cartaoSumiu = !cell().querySelector('.cm-approval');
  cell().querySelector('.cm-access').click();
  await pausa(150);
  Array.from(document.querySelectorAll('.cm-menu .cm-menu-item')).find(e => /Acesso total/.test(e.textContent))?.click();
  r.voltouTotal = await espera(() => /Acesso total/.test(cell().querySelector('.cm-access').textContent), 8000);

  // "↓": escondido no fim; aparece rolando pra cima (se houver rolagem)
  const sc = cell().querySelector('.cm-scroll');
  const tb = cell().querySelector('.cm-tobottom');
  sc.scrollTop = sc.scrollHeight;
  await pausa(150);
  r.setaNoFim = tb.hidden;
  r.rolavel = sc.scrollHeight > sc.clientHeight + 40;
  sc.scrollTop = 0;
  await pausa(150);
  r.setaEmCima = tb.hidden === false;
  sc.scrollTop = sc.scrollHeight;
  await pausa(150);
  return r;
})()`;

const SCRIPT_TROCA = (sessao) => `(async () => {
  const espera = async (fn, ms) => { const ate = Date.now() + ms; while (Date.now() < ate) { try { if (fn()) return true; } catch {} await new Promise(r => setTimeout(r, 250)); } return false; };
  const r = {};
  r.naLista = await espera(() => (st.allThreads || []).some(t => t.id === ${JSON.stringify(sessao)}), 8000);
  const thread = (st.allThreads || []).find(t => t.id === ${JSON.stringify(sessao)}) || { id: ${JSON.stringify(sessao)}, cwd: ${JSON.stringify(CWD)}, provider: 'claude', accountNum: null };
  r.titulo = thread.title || '';
  reopenPaneAs(thread, st.spawnByThread[thread.id], 'tui');
  const sidTui = st.spawnByThread[thread.id];
  r.tuiUi = st.spawnUi[sidTui];
  r.xterm = await espera(() => document.querySelector('.grid-cell[data-spawn="' + sidTui + '"] .xterm'), 10000);
  r.tuiResume = await espera(() => /norya-chat-ok|pronto/.test(st.termBuffers[sidTui] || ''), 30000);
  reopenPaneAs(thread, sidTui, 'chat');
  const sidChat = st.spawnByThread[thread.id];
  r.chatUi = st.spawnUi[sidChat];
  r.historico = await espera(() => /norya-chat-ok/.test(document.querySelector('.grid-cell[data-spawn="' + sidChat + '"] .cm-user')?.textContent || ''), 15000);
  r.tuiMorto = !st.termRunning[sidTui];
  return r;
})()`;

(async () => {
  const falhas = [];
  const ok = (nome, cond, extra) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + nome + (extra ? '  ' + extra : '')); if (!cond) falhas.push(nome); };
  try {
    const res = await withApp(async client => {
      const r = await client.evaluate(SCRIPT, { timeoutMs: 200000 });
      if (!r || !r.ok) { console.log('FAIL  ' + JSON.stringify(r)); falhas.push('setup'); return; }
      ok('seletor TUI|Chat grava "chat"', r.toggleAtivo);
      ok('pane nasce em chat', r.spawnUi === 'chat');
      ok('pane sem xterm, com composer', r.semXterm && r.temComposer);
      ok('estado vazio "O que vamos fazer?"', r.prontoParaDigitar);
      ok('Enter vira bolha do usuário', /norya-chat-ok/.test(r.bolha));
      ok('"Trabalhando" aparece na hora', r.trabalhando);
      ok('dot do pane vai pra working', r.dotWorking);
      ok('turno fecha', r.fechou);
      ok('"Trabalhou por …" no fim', /^Trabalhou por \d/.test(r.trabalhou), JSON.stringify(r.trabalhou));
      ok('resposta final visível', /pronto/i.test(r.resposta), JSON.stringify(r.resposta));
      ok('grupo de ferramentas rotulado', /executou um comando/i.test(r.grupo), JSON.stringify(r.grupo));
      ok('linha da ferramenta', /Comando executado: .*norya-chat-ok/.test(r.ferramenta), JSON.stringify(r.ferramenta));
      ok('latch no id real da sessão', !!r.sessao && r.latch);
      ok('task lembra que abriu em chat', r.threadUi === 'chat');
      ok('dot volta de working', r.dotDepois === 'active', r.dotDepois);

      if (process.env.NORYA_SMOKE_SHOT) {
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        if (shot.result && shot.result.data) fs.writeFileSync(process.env.NORYA_SMOKE_SHOT, Buffer.from(shot.result.data, 'base64'));
      }

      const sel = await client.evaluate(SCRIPT_SELETOR, { timeoutMs: 30000 });
      ok('seletor de modelo habilitado', sel.habilitado, JSON.stringify(sel.rotulo));
      ok('menu: Esforço + Modelo', sel.titulos.join() === 'Esforço,Modelo' && sel.itens.length >= 5, JSON.stringify(sel.itens));
      ok('esforço troca na hora', sel.menuFechou && sel.esforco);
      ok('modelo troca na hora', sel.modelo, JSON.stringify({ achou: sel.achouSonnet, itens: sel.itens2, logo: sel.logo }));
      ok('claude confirma modelo + esforço', sel.confirmado, JSON.stringify(sel.depois));
      ok('Claude mostra seletor de acesso (Acesso total)', /Acesso total/.test(sel.acesso), JSON.stringify(sel.acesso));
      if (process.env.NORYA_SMOKE_SHOT) {
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        if (shot.result && shot.result.data) fs.writeFileSync(process.env.NORYA_SMOKE_SHOT.replace(/\.png$/, '-menu.png'), Buffer.from(shot.result.data, 'base64'));
      }
      await client.evaluate(`(() => { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return !document.querySelector('.cm-menu'); })()`);

      const png = path.join(ISO, 'cor.png');
      fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64'));
      const alvo = path.join(ISO, 'ui-aprovado.txt');
      const cp = await client.evaluate(SCRIPT_COMPOSER(r.spawnId, png, alvo), { timeoutMs: 400000 });
      ok('rascunho sobrevive à remontagem', cp.rascunho === 'rascunho que não pode sumir', JSON.stringify(cp.rascunho));
      ok('↑ traz o último prompt', /norya-chat-ok/.test(cp.historico), JSON.stringify(cp.historico));
      ok('"/" lista comandos e Tab completa', cp.acCmd && cp.aceitouCmd === '/compact ', JSON.stringify(cp.aceitouCmd));
      ok('"@" lista arquivos e Enter completa', cp.acArq && (cp.aceitouArq || '').endsWith('@' + ARQ_AT + ' '), JSON.stringify(cp.aceitouArq));
      ok('anexo: chip com miniatura', cp.chip);
      ok('anexo: limpa ao enviar e vai na bolha', cp.chipLimpo && cp.bolhaImg);
      ok('claude vê a imagem anexada', /vermelh/i.test(cp.cor), JSON.stringify(cp.cor.slice(-80)));
      ok('fila: 2 mensagens "Na fila"', cp.naFila === 2 && /Na fila/.test(cp.tagFila), JSON.stringify([cp.naFila, cp.tagFila]));
      ok('fila: Remover tira da fila', cp.depoisRemover === 1);
      ok('fila anda sozinha no fim do turno', cp.filaAndou && /dois/.test(cp.respostas), JSON.stringify(cp.respostas.slice(-80)));
      ok('fila: removida não foi enviada', cp.removidaNaoFoi);
      ok('enviar agora: sai da fila na hora', cp.steerSemFila);
      ok('enviar agora: resposta embaixo da bolha', cp.steerOrdem);
      ok('enviar agora: comando não duplica, nada girando', cp.steerSemDuplicar && cp.steerNadaGirando, JSON.stringify([cp.steerSemDuplicar, cp.steerNadaGirando]));
      ok('uso do contexto no composer', /\d+%.*Contexto: .* de .* tokens.*Custo/.test(cp.uso), JSON.stringify(cp.uso));
      ok('acesso do claude: 4 modos', cp.opcoesAcesso.join() === 'Acesso total,Aceitar edições,Pedir aprovação,Planejar', JSON.stringify(cp.opcoesAcesso));
      ok('pedir aprovação → cartão com o comando', cp.rotuloAcesso && cp.cartao && /touch/.test(cp.cartaoTexto), JSON.stringify(cp.cartaoTexto));
      ok('aprovar roda o comando', cp.cartaoSumiu && fs.existsSync(alvo));
      ok('volta pra acesso total', cp.voltouTotal);
      ok('"↓" escondido no fim', cp.setaNoFim);
      ok('"↓" aparece rolando pra cima', !cp.rolavel || cp.setaEmCima, JSON.stringify({ rolavel: cp.rolavel }));
      if (process.env.NORYA_SMOKE_SHOT) {
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        if (shot.result && shot.result.data) fs.writeFileSync(process.env.NORYA_SMOKE_SHOT.replace(/\.png$/, '-composer.png'), Buffer.from(shot.result.data, 'base64'));
      }

      const t = await client.evaluate(SCRIPT_TROCA(r.sessao), { timeoutMs: 90000 });
      ok('sessão de chat aparece no list-threads', t.naLista);
      ok('título da task = 1º prompt', /norya-chat-ok/.test(t.titulo), JSON.stringify(t.titulo));
      ok('menu: reabre como TUI (xterm)', t.tuiUi === 'tui' && t.xterm);
      ok('TUI retoma a MESMA conversa', t.tuiResume);
      ok('menu: volta pra chat', t.chatUi === 'chat');
      ok('chat retomado mostra o histórico', t.historico);
      ok('processo TUI anterior encerrado', t.tuiMorto);
      if (process.env.NORYA_SMOKE_SHOT) {
        await new Promise(r => setTimeout(r, 800));
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        if (shot.result && shot.result.data) fs.writeFileSync(process.env.NORYA_SMOKE_SHOT.replace(/\.png$/, '-2.png'), Buffer.from(shot.result.data, 'base64'));
      }
    }, { settleMs: 5000 });
    if (res && res.exceptions && res.exceptions.length) {
      console.log(`FAIL  exceções não capturadas (${res.exceptions.length})`);
      res.exceptions.slice(0, 5).forEach(e => console.log('        ' + String(e).slice(0, 300)));
      falhas.push('exceções');
    }
  } catch (err) { console.log('FAIL  arnês: ' + err.message); falhas.push('arnês'); }
  console.log(`\n${falhas.length ? 'FALHOU: ' + falhas.join(', ') : 'TUDO PASSOU'}`);
  process.exit(falhas.length ? 1 : 0);
})();
