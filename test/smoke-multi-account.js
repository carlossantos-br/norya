#!/usr/bin/env node
/**
 * Múltiplas contas por agente.
 *
 * O Codex sempre teve: cada perfil é um $HOME, e o `codex login` grava em
 * `accounts/N/.codex/auth.json`. Este teste prova que o mesmo vale agora para
 * Grok e OpenCode, e cobre a exceção do Claude.
 *
 * Por agente, verificado no binário real (2026-07-10):
 *   grok      grava sob $HOME → trocar HOME isola. `creds: { kind: 'home' }`
 *   opencode  idem (~/.local/share/opencode/auth.json)
 *   codex     idem (~/.codex/auth.json)
 *   claude    OAuth no KEYCHAIN do macOS, chaveado pelo usuário do sistema.
 *             Trocar HOME não isola nada. O isolamento vem do token de longa
 *             duração do `claude setup-token`, injetado por perfil via
 *             CLAUDE_CODE_OAUTH_TOKEN. `creds: { kind: 'token' }`
 *
 * Cria um perfil temporário e o REMOVE ao final, inclusive se falhar.
 *
 * Custo: zero token (as TUIs só sobem). Uso: node test/smoke-multi-account.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp } = require('./cdp-harness');
const { byId } = require('../agents/registry');
const { NORYA_HOME } = require('../norya-home');

const ACCOUNTS = path.join(NORYA_HOME, 'accounts');
const NUM = 97;                       // alto o suficiente para não colidir
const DIR = path.join(ACCOUNTS, String(NUM));
const LOG = path.join(NORYA_HOME, 'panel.log');

const logDesde = pos => { try { return fs.readFileSync(LOG).subarray(pos).toString('utf8'); } catch { return ''; } };
const logTam = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function criarPerfil(authMode) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'profile.json'),
    JSON.stringify({ authMode, name: `teste-${authMode}`, color: '#7c5af0' }, null, 2), { mode: 0o600 });
}
function removerPerfil() {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
}

const SPAWN = `(async () => {
  const { ipcRenderer } = require('electron');
  const accounts = await ipcRenderer.invoke('get-accounts');
  const acc = accounts.find(a => a.num === ${NUM});
  if (!acc) return { ok: false, motivo: 'perfil não listado', modos: accounts.map(a => a.authMode) };

  let buf = '';
  ipcRenderer.on('terminal-data-ma-1', (_e, d) => { buf += d; });
  const r = await ipcRenderer.invoke('spawn-terminal-checked', { account: acc, cwd: '/tmp', spawnId: 'ma-1' });
  if (!r || !r.ok) return { ok: false, motivo: 'spawn: ' + (r && r.error) };

  await new Promise(x => setTimeout(x, 9000));
  ipcRenderer.send('kill-terminal', 'ma-1');
  const limpo = buf.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '');
  return { ok: true, authMode: acc.authMode, bytes: buf.length, naoAchou: /command not found/i.test(limpo) };
})()`;

const TOKEN = `(async () => {
  const { ipcRenderer } = require('electron');
  const set = (token) => ipcRenderer.invoke('profile-set-claude-token', { num: ${NUM}, token });
  return {
    lixo:     await set('token-qualquer'),
    apiKey:   await set('sk-ant-api03-abcdefghijklmnop'),   // prefixo errado de propósito
    valido:   await set('sk-ant-oat01-ABCdefGHIjkl0123456789'),
    limpeza:  await set(null),
  };
})()`;

(async () => {
  const falhas = [];
  let res;

  try {
    // ── Grok: perfil próprio, credencial dentro dele ─────────────────────────
    criarPerfil('grok');
    const marca = logTam();

    res = await withApp(async c => {
      const v = await c.evaluate(SPAWN, { timeoutMs: 40000 });
      await sleep(300);

      if (!v.ok) {
        console.log(`FAIL  ${v.motivo}${v.modos ? ' — listados: ' + JSON.stringify(v.modos) : ''}`);
        falhas.push('perfil grok');
      } else {
        const escolheu = /spawn: id=ma-1 cli=grok\b/.test(logDesde(marca));
        console.log(`${escolheu ? 'PASS' : 'FAIL'}  perfil authMode=grok spawna a CLI grok`);
        if (!escolheu) falhas.push('dispatch por authMode');

        console.log(`${!v.naoAchou && v.bytes > 0 ? 'PASS' : 'FAIL'}  o grok subiu (${v.bytes} B)`);
        if (v.naoAchou || !v.bytes) falhas.push('grok não subiu');
      }

      // ── Validação do token do Claude ────────────────────────────────────
      const t = await c.evaluate(TOKEN, { timeoutMs: 20000 });
      const recusaLixo = !!(t.lixo && t.lixo.error);
      const recusaApiKey = !!(t.apiKey && t.apiKey.error);
      const aceitaValido = !!(t.valido && t.valido.ok && t.valido.hasToken);
      const limpa = !!(t.limpeza && t.limpeza.ok && t.limpeza.hasToken === false);

      console.log(`${recusaLixo ? 'PASS' : 'FAIL'}  token sem prefixo é recusado`);
      console.log(`${recusaApiKey ? 'PASS' : 'FAIL'}  chave de API (sk-ant-api03) não passa por token OAuth`);
      console.log(`${aceitaValido ? 'PASS' : 'FAIL'}  token sk-ant-oat01 válido é aceito`);
      console.log(`${limpa ? 'PASS' : 'FAIL'}  token null limpa o campo`);
      if (!recusaLixo) falhas.push('aceita lixo');
      if (!recusaApiKey) falhas.push('aceita api key');
      if (!aceitaValido) falhas.push('recusa token válido');
      if (!limpa) falhas.push('não limpa');
    }, { settleMs: 4000 });

    // ── A PROVA de isolamento: o grok escreveu DENTRO do perfil ─────────────
    const isolado = fs.existsSync(path.join(DIR, '.grok'));
    console.log(`${isolado ? 'PASS' : 'FAIL'}  o grok gravou em accounts/${NUM}/.grok (credencial isolada)`);
    if (!isolado) falhas.push('sem isolamento de credencial');

    // ── O registry descreve o isolamento de cada agente ─────────────────────
    const modelo = { codex: 'home', claude: 'token', grok: 'home', opencode: 'home', aider: 'key' };
    const bate = Object.entries(modelo).every(([id, kind]) => byId[id].creds.kind === kind);
    console.log(`${bate ? 'PASS' : 'FAIL'}  registry descreve o isolamento de credencial de cada agente`);
    if (!bate) falhas.push('registry de creds');

    if (res.exceptions.length) {
      console.log(`FAIL  exceções não capturadas (${res.exceptions.length})`);
      falhas.push('exceções');
    } else console.log('PASS  sem exceções não capturadas');
    if (res.leaked.length) { console.log(`FAIL  vazou Electron`); falhas.push('vazamento'); }
  } catch (err) {
    console.log(`FAIL  arnês: ${err.message}`);
    falhas.push('arnês');
  } finally {
    removerPerfil();
    const limpo = !fs.existsSync(DIR);
    console.log(`${limpo ? 'PASS' : 'FAIL'}  perfil de teste removido`);
    if (!limpo) falhas.push('lixo em disco');
  }

  console.log(`\n${falhas.length ? `FALHOU (${falhas.length}): ${falhas.join(', ')}` : 'TUDO PASSOU'}`);
  process.exit(falhas.length ? 1 : 0);
})();
