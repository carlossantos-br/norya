/**
 * Smoke: dock do navegador com viewport escalado (2026-08-01).
 *
 * Prova o que os unitários não alcançam: que a página DENTRO da <webview>
 * enxerga o viewport emulado, enquanto o painel continua com sua largura
 * física — que é a razão de existir do dock (ver browser/device-presets.js).
 *
 * Roda numa instância ISOLADA (NORYA_HOME temp + userData próprio + socket com
 * sufixo) — pode rodar com o Norya de produção aberto, sem tocar nele.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolamento — TEM que vir antes do require do harness (DEFAULT_PORT lê env).
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-dock-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke-dock';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9226';
fs.mkdirSync(process.env.NORYA_HOME, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });

const { withApp } = require('./cdp-harness');

function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✓ ' + msg); }

/**
 * Página de teste COM meta viewport — produto real tem; sem ela o Chromium cai
 * no fallback móvel de 980px (fiel ao aparelho, mas não é o que se quer medir).
 *
 * Precisa ser `file://` e não `data:`: `normalizeUrl` (browser.js) só reconhece
 * esquemas com `//`, então um `data:text/html,…` vira busca no DuckDuckGo e o
 * smoke passa a medir o site deles — foi o que aconteceu na 1ª execução.
 */
const ARQ = path.join(ISO, 'alvo.html');
fs.writeFileSync(ARQ, `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>alvo</title><body>ok</body>`);
const PAGINA = 'file://' + ARQ;

const espera = ms => `new Promise(r => setTimeout(r, ${ms}))`;

(async () => {
  await withApp(async ({ evaluate }) => {

    // ── 1. abrir o dock ────────────────────────────────────────────────────
    const aberto = await evaluate(`(async () => {
      st.accounts = [{ num: 1, name: 'Smoke', color: '#7c5cff', authMode: 'codex' }];
      st.activeProfileNum = 1;
      document.body.classList.remove('onboarding', 'landing');
      document.getElementById('app').classList.remove('landing');

      document.getElementById('btnNoryaBrowser').click();
      const panel = document.getElementById('noryaBrowserPanel');
      for (let i = 0; i < 60 && !panel.classList.contains('open'); i++) await ${espera(100)};
      await ${espera(400)};

      const app = document.getElementById('app');
      return {
        open: panel.classList.contains('open'),
        docked: document.body.classList.contains('browser-docked'),
        padding: parseInt(getComputedStyle(app).paddingRight, 10) || 0,
        panelWidth: panel.getBoundingClientRect().width,
      };
    })()`);

    if (!aberto.open) return fail('painel não abriu — resto do smoke não faz sentido');
    ok('painel do navegador abriu');
    if (!aberto.docked) fail('body deveria ganhar a classe browser-docked');
    else if (aberto.padding <= 0) fail(`.app deveria reservar espaço, padding-right veio ${aberto.padding}`);
    else ok(`dock reserva espaço de verdade (.app padding-right = ${aberto.padding}px)`);
    if (Math.abs(aberto.padding - aberto.panelWidth) > 2) {
      fail(`espaço reservado (${aberto.padding}) não bate com a largura do painel (${aberto.panelWidth})`);
    } else ok('espaço reservado acompanha a largura do painel');

    // ── 2. abrir uma aba e emular Desktop 1440 ─────────────────────────────
    const desktop = await evaluate(`(async () => {
      document.getElementById('nbAddrInput').value = ${JSON.stringify(PAGINA)};
      document.getElementById('nbAddrInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 60 && !document.querySelector('#nbContent webview'); i++) await ${espera(100)};
      const wv = document.querySelector('#nbContent webview');
      if (!wv) return { erro: 'nenhuma webview criada' };
      await ${espera(1200)};

      const sel = document.getElementById('nbDevice');
      sel.value = 'desktop-1440';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await ${espera(900)};

      return {
        innerWidth:  await wv.executeJavaScript('innerWidth'),
        innerHeight: await wv.executeJavaScript('innerHeight'),
        mqDesktop:   await wv.executeJavaScript('matchMedia("(min-width: 1200px)").matches'),
        fisico:      Math.round(wv.getBoundingClientRect().width),
        rotulo:      document.getElementById('nbScaleLabel').textContent,
      };
    })()`);

    if (desktop.erro) return fail(desktop.erro);
    if (desktop.innerWidth !== 1440) fail(`Desktop 1440 deveria dar innerWidth 1440, veio ${desktop.innerWidth}`);
    else ok(`página vê 1440px de viewport dentro de ${desktop.fisico}px físicos`);
    if (desktop.innerHeight !== 900) fail(`esperava innerHeight 900, veio ${desktop.innerHeight}`);
    else ok('altura emulada também vale (900)');
    if (!desktop.mqDesktop) fail('media query (min-width:1200px) deveria casar no viewport emulado');
    else ok('media query responde ao viewport emulado — breakpoints de verdade');
    if (!/1440×900/.test(desktop.rotulo || '')) fail(`rótulo de escala deveria citar 1440×900, veio "${desktop.rotulo}"`);
    else ok(`rótulo honesto na UI: "${desktop.rotulo}"`);

    // ── 3. trocar pra iPhone não muda o espaço ocupado ─────────────────────
    const iphone = await evaluate(`(async () => {
      const antes = parseInt(getComputedStyle(document.getElementById('app')).paddingRight, 10);
      const sel = document.getElementById('nbDevice');
      sel.value = 'iphone-15-pro';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await ${espera(900)};
      const wv = document.querySelector('#nbContent webview');
      return {
        innerWidth: await wv.executeJavaScript('innerWidth'),
        dpr:        await wv.executeJavaScript('devicePixelRatio'),
        depois:     parseInt(getComputedStyle(document.getElementById('app')).paddingRight, 10),
        antes,
      };
    })()`);

    if (iphone.innerWidth !== 393) fail(`iPhone deveria dar innerWidth 393, veio ${iphone.innerWidth}`);
    else ok('iPhone 15 Pro emula 393px de viewport');
    if (iphone.dpr !== 3) fail(`deviceScaleFactor do iPhone deveria ser 3, veio ${iphone.dpr}`);
    else ok('devicePixelRatio 3 chega na página');
    if (iphone.antes !== iphone.depois) {
      fail(`TESE CENTRAL QUEBRADA: trocar de device mudou o espaço dos panes (${iphone.antes} → ${iphone.depois})`);
    } else ok(`Desktop e iPhone custam a MESMA largura de tela (${iphone.depois}px) — panes intocados`);

    // ── 4. arrastar a alça recalcula a escala ──────────────────────────────
    const arrasto = await evaluate(`(async () => {
      const sel = document.getElementById('nbDevice');
      sel.value = 'desktop-1440';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await ${espera(600)};
      const antes = document.getElementById('nbScaleLabel').textContent;

      const alvo = 420;
      document.getElementById('nbResize').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: window.innerWidth - alvo }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await ${espera(600)};

      return {
        antes,
        depois:  document.getElementById('nbScaleLabel').textContent,
        largura: Math.round(document.getElementById('noryaBrowserPanel').getBoundingClientRect().width),
        padding: parseInt(getComputedStyle(document.getElementById('app')).paddingRight, 10),
        gravado: localStorage.getItem('nb-width'),
      };
    })()`);

    if (Math.abs(arrasto.largura - 420) > 3) fail(`arrastar deveria deixar o painel em ~420px, veio ${arrasto.largura}`);
    else ok('alça de arrasto redimensiona o dock');
    if (Math.abs(arrasto.padding - arrasto.largura) > 3) fail(`padding (${arrasto.padding}) não seguiu a largura (${arrasto.largura})`);
    else ok('espaço reservado segue o arrasto ao vivo');
    if (arrasto.antes === arrasto.depois) fail(`escala não foi recalculada após o arrasto (segue "${arrasto.depois}")`);
    else ok(`escala recalculada: "${arrasto.antes}" → "${arrasto.depois}"`);
    if (arrasto.gravado !== '420') fail(`nb-width deveria persistir 420, veio ${arrasto.gravado}`);
    else ok('nb-width segue persistindo (comportamento pré-existente preservado)');

    // ── 5. set_viewport do MCP deixou de ser no-op ─────────────────────────
    const mcp = await evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      const wv = document.querySelector('#nbContent webview');
      const reqId = 'smoke-' + Date.now();
      // A resposta vai por ipcRenderer.SEND (renderer → main), não volta como
      // evento aqui. Para ler o veredito do handler sem subir o socket MCP,
      // intercepta-se o send durante a chamada e restaura-se em seguida.
      const sendOriginal = ipcRenderer.send.bind(ipcRenderer);
      const resposta = new Promise(res => {
        ipcRenderer.send = (canal, payload) => {
          if (canal === 'norya-browser-agent-reply' && payload && payload.reqId === reqId) {
            ipcRenderer.send = sendOriginal;
            res(payload);
          } else sendOriginal(canal, payload);
        };
      });
      ipcRenderer.emit('norya-browser-agent', {}, {
        reqId, action: 'navigate-tab',
        payload: { action: 'set_viewport', params: { width: 375, height: 812 } },
      });
      const r = await Promise.race([resposta, ${espera(4000)}.then(() => ({ timeout: true }))]);
      ipcRenderer.send = sendOriginal;
      await ${espera(600)};
      return { r, innerWidth: await wv.executeJavaScript('innerWidth') };
    })()`);

    if (mcp.r && mcp.r.timeout) fail('set_viewport não respondeu em 4s');
    else if (!mcp.r.ok) fail(`set_viewport respondeu erro: ${JSON.stringify(mcp.r)}`);
    else if (!mcp.r.result || mcp.r.result.viewport?.width !== 375) fail(`retorno deveria informar o viewport aplicado, veio ${JSON.stringify(mcp.r.result)}`);
    else if (mcp.innerWidth !== 375) fail(`browser_set_viewport deveria levar innerWidth a 375, veio ${mcp.innerWidth}`);
    else ok('browser_set_viewport do MCP muda o viewport de verdade (era no-op)');

    // ── 6. fechar devolve o espaço sem destruir as abas ────────────────────
    const fechado = await evaluate(`(async () => {
      const abasAntes = document.querySelectorAll('#nbContent webview').length;
      document.getElementById('nbClose').click();
      await ${espera(700)};
      return {
        abasAntes,
        abasDepois: document.querySelectorAll('#nbContent webview').length,
        docked: document.body.classList.contains('browser-docked'),
        padding: parseInt(getComputedStyle(document.getElementById('app')).paddingRight, 10) || 0,
      };
    })()`);

    if (fechado.docked) fail('fechar deveria remover body.browser-docked');
    else if (fechado.padding !== 0) fail(`fechar deveria devolver o espaço, padding-right veio ${fechado.padding}`);
    else ok('fechar devolve o espaço aos panes');
    if (fechado.abasDepois !== fechado.abasAntes || fechado.abasDepois === 0) {
      fail(`esconder ≠ destruir: abas caíram de ${fechado.abasAntes} para ${fechado.abasDepois}`);
    } else ok('abas seguem vivas com o dock fechado (esconder ≠ destruir preservado)');
  });

  try { fs.rmSync(ISO, { recursive: true, force: true }); } catch {}
  console.log(process.exitCode ? '\nSMOKE FALHOU' : '\nSMOKE OK');
})();
