/**
 * Smoke: adotar uma task de Codex em OUTRA conta (2026-09-09).
 *
 * Prova o caminho inteiro do IPC `thread-adopt-profile`, com o `codex` REAL:
 * copiar o rollout para o $CODEX_HOME do perfil destino e mandar o codex
 * ingerir (`migrate-rollouts --apply --thread`). É a peça arriscada da feature
 * — o resto (o plano) é puro e vive em test/rollout-adopt.test.js.
 *
 * Roda numa instância ISOLADA (NORYA_HOME temp) com DOIS perfis fabricados: o
 * rollout começa só no perfil 1, e o teste exige que ele passe a existir na
 * `state_5.sqlite` do perfil 2 — que é exatamente o que faz `codex resume <id>`
 * funcionar lá. Nada é lido nem escrito no ~/.norya real além de UMA cópia de
 * leitura de um rollout existente (para ter um arquivo de sessão de verdade).
 *
 * Custo: zero token — `migrate-rollouts` é local, não fala com a API.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-adopt-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9228';
fs.mkdirSync(process.env.NORYA_HOME, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });

const { withApp } = require('./cdp-harness');

function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✓ ' + msg); }

const ACCOUNTS = path.join(process.env.NORYA_HOME, 'accounts');

/** Um rollout de verdade do ~/.norya real — o menor que existir, para ser rápido. */
function acharRolloutReal() {
  const real = path.join(os.homedir(), '.norya', 'accounts');
  if (!fs.existsSync(real)) return null;
  let melhor = null;
  const walk = d => {
    let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) walk(p);
      else if (x.name.endsWith('.jsonl')) {
        const size = fs.statSync(p).size;
        if (size > 2048 && (!melhor || size < melhor.size)) melhor = { path: p, size };
      }
    }
  };
  for (const n of fs.readdirSync(real).filter(x => !isNaN(x))) {
    walk(path.join(real, n, '.codex', 'sessions'));
  }
  return melhor;
}

function criarPerfil(num) {
  const dir = path.join(ACCOUNTS, String(num));
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'),
    JSON.stringify({ authMode: 'chatgpt', name: `adopt-${num}`, color: '#7c5af0' }, null, 2), { mode: 0o600 });
  return dir;
}

/** A thread existe na thread-history daquele perfil? É o que o `resume` consulta. */
function threadNaSqlite(codexHome, threadId) {
  const db = path.join(codexHome, 'state_5.sqlite');
  if (!fs.existsSync(db)) return false;
  try {
    const out = execFileSync('sqlite3', ['-json', db,
      `SELECT id FROM threads WHERE id='${threadId}'`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out || '[]').length > 0;
  } catch { return false; }
}

(async () => {
  const fonte = acharRolloutReal();
  if (!fonte) {
    console.log('SKIP: nenhum rollout de Codex no ~/.norya para usar de fixture.');
    return;
  }

  const dir1 = criarPerfil(1);
  const dir2 = criarPerfil(2);
  const nome = path.basename(fonte.path);
  const threadId = nome.replace(/\.jsonl$/, '').replace(/^rollout-[0-9T-]*?-(?=[0-9a-f]{8}-)/, '');
  const rel = path.join('2026', '01', '01', nome);
  const origem = path.join(dir1, '.codex', 'sessions', rel);
  fs.mkdirSync(path.dirname(origem), { recursive: true });
  fs.copyFileSync(fonte.path, origem);
  console.log(`  fixture: ${nome} (${fonte.size} B) → perfil 1, thread ${threadId}`);

  const destCodex = path.join(dir2, '.codex');
  if (threadNaSqlite(destCodex, threadId)) { fail('setup: a thread já existia no perfil 2'); return; }
  ok('antes: o perfil 2 não conhece a thread (é o "No saved session found" do resume)');

  await withApp(async ({ evaluate, exceptions }) => {
    const res = await evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('thread-adopt-profile', {
        sessionId: ${JSON.stringify(threadId)},
        provider: 'codex', fromAccount: 1, toAccount: 2,
      });
    })()`, { timeoutMs: 180000 });

    if (!res || res.error) { fail(`adoção falhou: ${res && res.error}`); return; }
    if (!res.moved) { fail(`esperava moved:true para Codex entre contas, veio ${JSON.stringify(res)}`); return; }
    ok(`IPC devolveu ok (status do codex: ${res.status})`);

    if (!fs.existsSync(path.join(destCodex, 'sessions', rel))) fail('o rollout não foi copiado para o perfil 2');
    else ok('o rollout está no sessions/ do perfil 2');

    if (!threadNaSqlite(destCodex, threadId)) {
      fail('o codex não materializou a thread na state_5.sqlite do perfil 2 — o resume ainda falharia lá');
    } else ok('a thread existe na thread-history do perfil 2: `codex resume` funciona ali');

    // Dono gravado — sem isso a UI reabriria a task na conta velha.
    const dono = await evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('thread-owner-get', ${JSON.stringify(threadId)});
    })()`);
    if (!dono || dono.profileNum !== 2) fail(`dono deveria ser 2, veio ${JSON.stringify(dono)}`);
    else ok('thread-owners.json aponta para a conta nova');

    // Idempotência: repetir não pode quebrar nem reprocessar do zero.
    const de_novo = await evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('thread-adopt-profile', {
        sessionId: ${JSON.stringify(threadId)},
        provider: 'codex', fromAccount: 1, toAccount: 2,
      });
    })()`, { timeoutMs: 180000 });
    if (!de_novo || de_novo.error) fail(`adotar duas vezes deveria ser inofensivo, veio ${JSON.stringify(de_novo)}`);
    else ok('adotar de novo é inofensivo (idempotente)');

    // Provider sem caminho de adoção recusa explicando, não em silêncio.
    const recusa = await evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('thread-adopt-profile', {
        sessionId: 'seja-o-que-for', provider: 'grok', fromAccount: 1, toAccount: 2,
      });
    })()`);
    if (!recusa || !recusa.error || !/grok/.test(recusa.error)) {
      fail(`grok deveria ser recusado nomeando o provider, veio ${JSON.stringify(recusa)}`);
    } else ok('provider sem caminho de adoção é recusado com motivo');

    if (exceptions.length) fail('exceções não capturadas: ' + JSON.stringify(exceptions));
    else ok('sem exceções não capturadas');
  });

  if (process.env.NORYA_SMOKE_KEEP) console.log('  (mantido) ' + ISO);
  else try { fs.rmSync(ISO, { recursive: true, force: true }); } catch {}
  console.log(process.exitCode ? '\nSMOKE ADOPT: FALHOU' : '\nSMOKE ADOPT: OK');
})();
