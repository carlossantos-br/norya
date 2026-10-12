/**
 * Smoke: arrastar a borda do dock do navegador (2026-08-07).
 *
 * Por que existe separado do smoke-browser-dock: o passo 4 de lá arrasta com
 * `dispatchEvent(new MouseEvent(...))`, que entrega o evento direto no alvo e
 * PULA o hit-test do Chromium. Passava com o arrasto real quebrado.
 *
 * Aqui o mouse é injetado por CDP (`Input.dispatchMouseEvent`), que percorre o
 * mesmo roteamento de um mouse de verdade — inclusive a decisão de mandar o
 * evento pro guest da <webview> em vez do embedder. É o único jeito de provar
 * o bug: como setDockWidth mantém a borda do painel EXATAMENTE sob o cursor, o
 * ponteiro passa o arrasto inteiro em cima da <webview>, cujos mousemove/mouseup
 * nunca chegam ao window do renderer.
 *
 * Roda numa instância ISOLADA — pode rodar com o Norya de produção aberto.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolamento — TEM que vir antes do require do harness (DEFAULT_PORT lê env).
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-resize-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke-resize';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9228';
fs.mkdirSync(process.env.NORYA_HOME, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });

const { withApp, sleep } = require('./cdp-harness');

function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✓ ' + msg); }

// Página local com conteúdo opaco: a <webview> tem que estar VIVA e pintando,
// senão o guest nem entra no hit-test e o bug não aparece.
const ARQ = path.join(ISO, 'alvo.html');
fs.writeFileSync(ARQ, `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>alvo</title>
<body style="margin:0;background:#c00;height:100vh">alvo</body>`);
const PAGINA = 'file://' + ARQ;

const espera = ms => `new Promise(r => setTimeout(r, ${ms}))`;

(async () => {
  await withApp(async ({ evaluate, send }) => {
    const mouse = (type, x, y, arrastando) => send('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y),
      button: 'left', clickCount: 1, buttons: arrastando ? 1 : 0,
    });

    /** Arrasto de verdade: pressiona, move em passos, solta. */
    async function arrastar(de, para, y) {
      await mouse('mousePressed', de, y, true);
      const passos = 8;
      for (let i = 1; i <= passos; i++) {
        await mouse('mouseMoved', de + (para - de) * (i / passos), y, true);
        await sleep(25);
      }
      await mouse('mouseReleased', para, y, true);
      await sleep(250);
    }

    const largura = () => evaluate(
      `Math.round(document.getElementById('noryaBrowserPanel').getBoundingClientRect().width)`);

    // ── 1. dock aberto com uma <webview> viva ──────────────────────────────
    const cena = await evaluate(`(async () => {
      st.accounts = [{ num: 1, name: 'Smoke', color: '#7c5cff', authMode: 'codex' }];
      st.activeProfileNum = 1;
      document.body.classList.remove('onboarding', 'landing');
      document.getElementById('app').classList.remove('landing');

      document.getElementById('btnNoryaBrowser').click();
      const panel = document.getElementById('noryaBrowserPanel');
      for (let i = 0; i < 60 && !panel.classList.contains('open'); i++) await ${espera(100)};

      document.getElementById('nbAddrInput').value = ${JSON.stringify(PAGINA)};
      document.getElementById('nbAddrInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 60 && !document.querySelector('#nbContent webview'); i++) await ${espera(100)};
      await ${espera(1200)};

      const wv = document.querySelector('#nbContent webview');
      if (!wv) return { erro: 'nenhuma webview criada' };
      const r = panel.getBoundingClientRect(), w = wv.getBoundingClientRect();
      return {
        aberto: panel.classList.contains('open'),
        borda: r.left, largura: Math.round(r.width),
        // y NO MEIO DA WEBVIEW: é a faixa onde o guest come o mouse. Arrastar na
        // altura da barra de endereço funcionaria mesmo com o bug.
        y: w.top + w.height / 2,
        webviewTopo: w.top,
        janela: window.innerWidth,
      };
    })()`);

    if (cena.erro || !cena.aberto) return fail(cena.erro || 'painel não abriu');
    ok(`dock aberto (${cena.largura}px) com webview viva a partir de y=${Math.round(cena.webviewTopo)}`);

    // ── 2. agarrar a alça DENTRO do painel (a webview pinta por cima dela) ──
    // A alça é `left:-3px; width:6px`: metade fica sobre o painel. Sem z-index,
    // a <webview> — irmã posterior no DOM — pinta em cima dessa metade e sobram
    // 3px agarráveis, do lado de fora. Este passo mira 2px pra DENTRO.
    const alvoLargo = cena.largura + 220;
    await arrastar(cena.borda + 2, cena.janela - alvoLargo, cena.y);
    const depoisDentro = await largura();
    if (Math.abs(depoisDentro - alvoLargo) > 6) {
      fail(`agarrar a alça 2px dentro do painel deveria alargar pra ~${alvoLargo}px, ficou ${depoisDentro}px`);
    } else ok(`alça agarrável na metade de dentro (${cena.largura} → ${depoisDentro}px)`);

    // ── 3. arrastar ESTREITANDO: o cursor entra na área da webview ─────────
    const base = await largura();
    const alvoEstreito = base - 180;
    await arrastar(cena.janela - base, cena.janela - alvoEstreito, cena.y);
    const depoisEstreito = await largura();
    if (Math.abs(depoisEstreito - alvoEstreito) > 6) {
      fail(`estreitar deveria chegar a ~${alvoEstreito}px, parou em ${depoisEstreito}px `
         + `(o mousemove morreu ao entrar na webview)`);
    } else ok(`arrasto atravessa a webview inteiro (${base} → ${depoisEstreito}px)`);

    // ── 4. soltar em cima da webview encerra o arrasto ─────────────────────
    // Sem escudo, o mouseup se perdia no guest e `resizing` ficava true: o
    // painel continuava colado no cursor DEPOIS de soltar.
    const antesDoFantasma = await largura();
    await mouse('mouseMoved', cena.janela - antesDoFantasma - 250, cena.y, false);
    await sleep(200);
    const depoisDoFantasma = await largura();
    if (antesDoFantasma !== depoisDoFantasma) {
      fail(`arrasto fantasma: mover o mouse SEM botão mudou a largura (${antesDoFantasma} → ${depoisDoFantasma})`);
    } else ok('mouseup foi capturado — mouse solto não arrasta mais');

    // ── 5. o estado persistido acompanha ───────────────────────────────────
    const gravado = await evaluate(`parseInt(localStorage.getItem('nb-width'), 10)`);
    if (Math.abs(gravado - depoisDoFantasma) > 2) {
      fail(`largura gravada (${gravado}) não bate com a do painel (${depoisDoFantasma})`);
    } else ok(`largura persistida em nb-width (${gravado}px)`);

    // ── 6. nenhum escudo sobrevive ao arrasto ──────────────────────────────
    const escudos = await evaluate(`document.querySelectorAll('.nb-resize-shield').length`);
    if (escudos > 0) fail(`${escudos} escudo(s) de arrasto ficaram no DOM comendo cliques`);
    else ok('nenhum escudo vazado no DOM');
  }, { settleMs: 5000 });

  console.log(process.exitCode ? '\nFALHOU' : '\nTUDO PASSOU');
})();
