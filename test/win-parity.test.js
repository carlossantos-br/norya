#!/usr/bin/env node
/**
 * Paridade Windows (2026-10-12) nos módulos que NÃO são o platform.js — cada
 * um recebe um `makePlatform({ platform: 'win32' })` injetado e é exercitado
 * do Mac, sem processo de verdade:
 *
 *   • chat/chat-session.js   — spawn sem `detached`, com windowsHide; o kill
 *                              leva a ÁRVORE (taskkill /T /F), não só o pai;
 *   • agents/updates.js      — `--version` de um shim do npm vai por
 *                              node.exe + cli.js; nunca spawna .ps1/.cmd cru;
 *   • agents/rollout-adopt.js— caminhos com `\sessions\`; Claude por perfil
 *                              é COPIADO no Windows, compartilhado no Mac;
 *   • agents/codex-turn-watch.js — cwd sem diferenciar maiúsculas;
 *   • agents/claude-hook.js  — o hook liga no Windows (node.exe, aspas duplas).
 *
 * Uso: node test/win-parity.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { makePlatform } = require('../platform');

let n = 0;
const t = async (nome, fn) => { await fn(); console.log(`PASS  ${nome}`); n++; };

const HOME_WIN = 'C:\\Users\\carlos';
const NPM = HOME_WIN + '\\AppData\\Roaming\\npm';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
function mkWin(extra = {}) {
  return makePlatform(Object.assign({
    platform: 'win32',
    env: { USERPROFILE: HOME_WIN, SystemRoot: 'C:\\Windows', APPDATA: HOME_WIN + '\\AppData\\Roaming', USERNAME: 'carlos',
      PATH: [NPM, 'C:\\Program Files\\nodejs'].join(';') },
    homedir: HOME_WIN,
    exists: () => false,
  }, extra));
}

function fakeProc() {
  const p = new EventEmitter();
  p.pid = 4242;
  p.stdin = Object.assign(new EventEmitter(), { written: [], write(s) { this.written.push(s); }, end() { this.ended = true; } });
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kills = [];
  p.kill = (sig) => { p.kills.push(sig || 'SIGTERM'); };
  return p;
}

(async () => {
  const { createChatSession } = require('../chat/chat-session');

  await t('chat-session no Windows: sem detached, windowsHide, e kill = taskkill /T /F da árvore', async () => {
    const taskkills = [];
    const W = mkWin({ execFile: (f, a, o, cb) => { taskkills.push([f, a, o]); cb && cb(); } });
    let spawned;
    const proc = fakeProc();
    const s = createChatSession({
      agentId: 'codex', shell: NODE, shellArgs: ['C:\\x\\codex.js', 'app-server'], spawnCwd: 'C:\\dev', workCwd: 'C:\\dev',
      env: {}, codex: {}, emit: () => {}, onExit: () => {}, platform: W,
      spawn: (file, args, opts) => { spawned = { file, args, opts }; return proc; },
    });
    assert.strictEqual(spawned.file, NODE);
    assert.deepStrictEqual(spawned.args, ['C:\\x\\codex.js', 'app-server']);
    assert.strictEqual(spawned.opts.detached, false, 'detached no Windows abre um console novo');
    assert.strictEqual(spawned.opts.windowsHide, true);
    s.kill();
    assert.strictEqual(taskkills.length, 1);
    assert.deepStrictEqual(taskkills[0][1], ['/PID', '4242', '/T', '/F']);
    assert.ok(taskkills[0][0].toLowerCase().endsWith('taskkill.exe'));
    assert.deepStrictEqual(proc.kills, [], 'proc.kill() derrubaria só o pai e deixaria órfãos');
    proc.emit('exit', 1);
  });

  await t('chat-session no macOS: grupo próprio e kill(-pid) — o de sempre', async () => {
    const kills = [];
    const mac = makePlatform({ platform: 'darwin', env: {}, homedir: '/Users/c', exists: () => false });
    const M = Object.assign({}, mac, { killTree: (pid, sig) => kills.push([pid, sig]) });
    let spawned;
    const proc = fakeProc();
    const s = createChatSession({
      agentId: 'codex', shell: '/bin/zsh', shellArgs: ['-l', '-c', 'exec codex app-server'], spawnCwd: '/tmp', workCwd: '/tmp',
      env: {}, codex: {}, emit: () => {}, onExit: () => {}, platform: M,
      spawn: (file, args, opts) => { spawned = { file, args, opts }; return proc; },
    });
    assert.strictEqual(spawned.opts.detached, true);
    s.kill();
    assert.deepStrictEqual(kills, [[4242, 'SIGTERM']]);
    proc.emit('exit', 0);
  });

  // ── updates.js ─────────────────────────────────────────────────────────────
  const { ProviderUpdates } = require('../agents/updates');
  const { AGENTS } = require('../agents/registry');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-winparity-'));
  const claude = AGENTS.find(a => a.id === 'claude');
  const CMD = `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;

  await t('updates no Windows: --version do shim do npm vai por node.exe + cli.js, e a linha sai "unsupported"', async () => {
    const files = new Map([[NPM + '\\claude.cmd', CMD], [NPM + '\\claude.ps1', ''], [NODE, '']]);
    const W = mkWin({ exists: f => files.has(f), readFile: f => files.get(f) });
    const runs = [];
    const u = new ProviderUpdates({ platform: W, realpath: x => x, home: HOME_WIN, stateDir: tmp,
      run: async (file, args) => { runs.push([file, args]); return 'claude 2.1.300 (Claude Code)'; } });
    const { row, plan } = await u.inspect(claude, { claude: NPM + '\\claude.ps1' }, { PATH: [NPM, 'C:\\Program Files\\nodejs'].join(';') });
    assert.deepStrictEqual(runs, [[NODE, [NPM + '\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '--version']]]);
    assert.strictEqual(row.current, '2.1.300');
    assert.strictEqual(row.status, 'unsupported');
    assert.strictEqual(plan, undefined);
  });

  await t('updates no Windows: shim irresolvível NÃO é spawnado (antes: EINVAL derrubava a linha)', async () => {
    const W = mkWin({ exists: () => false });
    const runs = [];
    const u = new ProviderUpdates({ platform: W, realpath: x => x, home: HOME_WIN, stateDir: tmp,
      run: async (file, args) => { runs.push([file, args]); throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }); } });
    const { row } = await u.inspect(claude, { claude: NPM + '\\claude.ps1' }, { PATH: NPM });
    assert.deepStrictEqual(runs, []);
    assert.strictEqual(row.status, 'unsupported');
  });

  await t('updates no macOS: o próprio binário com --version (ordem de sempre)', async () => {
    const mac = makePlatform({ platform: 'darwin', env: {}, homedir: '/Users/c', exists: () => false });
    const runs = [];
    const u = new ProviderUpdates({ platform: mac, realpath: x => x, home: '/Users/c', stateDir: tmp,
      run: async (file, args) => { runs.push([file, args]); return '2.1.300'; } });
    const { row } = await u.inspect(claude, { claude: '/opt/x/bin/claude' }, { PATH: '/usr/bin' });
    assert.deepStrictEqual(runs, [['/opt/x/bin/claude', ['--version']]]);
    assert.strictEqual(row.status, 'unsupported', 'instalação não reconhecida continua sem plano');
  });

  // ── rollout-adopt.js ───────────────────────────────────────────────────────
  const { sessionsRelPath, codexHomeOf, planAdoption } = require('../agents/rollout-adopt');

  await t('rollout-adopt: caminho do Windows com \\sessions\\', async () => {
    const p = 'C:\\Users\\carlos\\.norya\\accounts\\3\\.codex\\sessions\\2026\\10\\12\\rollout-x.jsonl';
    assert.strictEqual(sessionsRelPath(p), '2026\\10\\12\\rollout-x.jsonl');
    assert.strictEqual(codexHomeOf(p), 'C:\\Users\\carlos\\.norya\\accounts\\3\\.codex');
    assert.deepStrictEqual(planAdoption({ provider: 'codex', fromAccount: 3, toAccount: 4, rolloutPath: p }),
      { action: 'copy-and-migrate', relPath: '2026\\10\\12\\rollout-x.jsonl' });
    // POSIX intocado
    assert.strictEqual(sessionsRelPath('/a/.codex/sessions/2026/x.jsonl'), '2026/x.jsonl');
    assert.strictEqual(codexHomeOf('/a/.codex/sessions/2026/x.jsonl'), '/a/.codex');
    assert.strictEqual(codexHomeOf('/a/.codex/x.jsonl'), null);
  });

  await t('rollout-adopt: Claude compartilha o HOME no Mac, é COPIADO no Windows', async () => {
    assert.strictEqual(planAdoption({ provider: 'claude', fromAccount: 1, toAccount: 2 }).action, 'none');
    assert.strictEqual(planAdoption({ provider: 'claude', fromAccount: 1, toAccount: 2, claudeSharedHome: false }).action, 'copy-claude');
    assert.strictEqual(planAdoption({ provider: 'claude', fromAccount: 2, toAccount: 2, claudeSharedHome: false }).action, 'none');
    assert.strictEqual(mkWin().claudeCredStore === 'keychain', false, 'main.js passa claudeSharedHome = (store === keychain)');
  });

  // ── codex-turn-watch.js samePath ───────────────────────────────────────────
  const { samePath } = require('../agents/codex-turn-watch');
  await t('codex-turn-watch: cwd do Windows sem diferenciar maiúsculas nem barra', async () => {
    const W = mkWin();
    const semFs = { realpathSync: () => { throw new Error('ENOENT'); } };
    assert.ok(samePath('C:\\Dev\\App', 'c:\\dev\\app\\', path.win32, semFs, W));
    assert.ok(samePath('C:/Dev/App', 'C:\\Dev\\App', path.win32, semFs, W));
    assert.ok(!samePath('C:\\Dev\\App2', 'C:\\Dev\\App', path.win32, semFs, W));
    const mac = makePlatform({ platform: 'darwin', env: {}, homedir: '/Users/c', exists: () => false });
    assert.ok(!samePath('/Dev/App', '/dev/app', path.posix, semFs, mac), 'macOS segue sensível');
    assert.ok(samePath('/dev/app/', '/dev/app', path.posix, semFs, mac));
  });

  // ── claude-hook.js ─────────────────────────────────────────────────────────
  const { resolveClaudeHookCmd } = require('../agents/claude-hook');
  const HELPER = 'C:\\Users\\carlos\\AppData\\Local\\Programs\\Norya\\resources\\app\\helpers\\norya-claude-event.js';
  const fakeFs = (files) => ({
    existsSync: f => files.has(f),
    statSync: f => { if (!files.has(f)) throw new Error('ENOENT'); return { isFile: () => true }; },
    accessSync: f => { if (!files.has(f)) throw new Error('EACCES'); },
    readdirSync: () => { throw new Error('ENOENT'); },
    constants: fs.constants,
  });

  await t('hook do Claude LIGA no Windows: node.exe do PATH, aspas duplas, barras normais', async () => {
    const W = mkWin();
    const cmd = resolveClaudeHookCmd({ plat: W, helper: HELPER, envPath: 'C:\\Windows;C:\\Program Files\\nodejs',
      fsImpl: fakeFs(new Set([HELPER, NODE])) });
    assert.strictEqual(cmd, `"C:/Program Files/nodejs/node.exe" "${HELPER.replace(/\\/g, '/')}"`);
    assert.ok(!cmd.includes('ELECTRON_RUN_AS_NODE'), 'prefixo VAR=1 é sintaxe de sh');
    assert.ok(!cmd.includes("'"), 'aspas simples não existem no cmd');
  });

  await t('hook do Claude no Windows sem node.exe: desligado (heurística de bytes), sem comando quebrado', async () => {
    assert.strictEqual(resolveClaudeHookCmd({ plat: mkWin(), helper: HELPER, envPath: 'C:\\Windows', fsImpl: fakeFs(new Set([HELPER])) }), null);
    assert.strictEqual(resolveClaudeHookCmd({ plat: mkWin(), helper: HELPER, envPath: '', fsImpl: fakeFs(new Set([NODE])) }), null, 'sem helper empacotado');
  });

  await t('hook do Claude no macOS: node com X_OK ou Electron em modo node — idêntico ao de antes', async () => {
    const mac = makePlatform({ platform: 'darwin', env: {}, homedir: '/Users/c', exists: () => false });
    const H = '/Applications/Norya.app/Contents/Resources/app/helpers/norya-claude-event.js';
    assert.strictEqual(resolveClaudeHookCmd({ plat: mac, helper: H, nvmDir: '/Users/c/.nvm', execPath: '/E', fsImpl: fakeFs(new Set([H, '/opt/homebrew/bin/node'])) }),
      `'/opt/homebrew/bin/node' '${H}'`);
    assert.strictEqual(resolveClaudeHookCmd({ plat: mac, helper: H, nvmDir: '/Users/c/.nvm', execPath: '/Applications/Norya.app/Contents/MacOS/Norya', fsImpl: fakeFs(new Set([H])) }),
      `ELECTRON_RUN_AS_NODE=1 '/Applications/Norya.app/Contents/MacOS/Norya' '${H}'`);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nTUDO PASSOU (${n}/${n})`);
})().catch(e => { console.error(e); process.exit(1); });
