#!/usr/bin/env node
/**
 * Os helpers de platform.js que o paridade-Windows (2026-10-12) acrescentou —
 * provados do Mac com `makePlatform({ platform: 'win32' })`, e com o macOS
 * conferido lado a lado (o comportamento de lá não pode mudar).
 *
 * O bloco de aspas simula o caminho inteiro que um argumento percorre no
 * Windows — literal do PowerShell → linha de comando montada em modo Legacy →
 * CommandLineToArgvW do programa — e exige que a CLI receba EXATAMENTE o texto
 * de origem. É a classe de bug que só aparecia com aspas duplas no argumento
 * (JSON do --settings, caminho no prompt de skills).
 *
 * Uso: node test/platform-win.test.js
 */
const assert = require('assert');
const { makePlatform, escapeWinNativeArg, quoteWinArg, PS_NATIVE_LEGACY } = require('../platform');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

const HOME_WIN = 'C:\\Users\\carlos';
const NPM = HOME_WIN + '\\AppData\\Roaming\\npm';
const mkWin = (extra = {}) => makePlatform(Object.assign({
  platform: 'win32',
  env: { USERPROFILE: HOME_WIN, SystemRoot: 'C:\\Windows', APPDATA: HOME_WIN + '\\AppData\\Roaming', USERNAME: 'carlos' },
  homedir: HOME_WIN,
  exists: () => false,
}, extra));
const win = mkWin();
const mac = makePlatform({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, homedir: '/Users/carlos', exists: () => false });

// Simulador do caminho de um argumento no Windows (literal do PowerShell →
// linha de comando em modo Legacy → CommandLineToArgvW): test/win-argv-sim.js.
const { recebido } = require('./win-argv-sim');

const HOSTIS = [
  'simples',
  'C:\\Users\\x\\.norya\\skills\\catalog.md',
  'C:\\Program Files\\x\\',
  'C:\\Program Files\\x\\\\',
  '{"hooks":{"Stop":[{"command":"\\"C:/node.exe\\" \\"C:/h.js\\""}]}}',
  'read "C:\\a b\\catalog.md" and follow',
  'termina com barra e aspas \\"',
  'a\\\\"b',
  "it's $env:PATH `n $(x) & | < > ^ %PATH%",
  'linha1\nlinha2\ttab',
  'developer_instructions="Norya ""provides"" C:\\\\x"',
  '"',
  '\\',
  ' ',
];

t('aspas no Windows: a CLI recebe EXATAMENTE o texto de origem (PowerShell Legacy → argv)', () => {
  for (const s of HOSTIS) assert.deepStrictEqual(recebido(win.quote(s)), [s], `quebrou: ${JSON.stringify(s)}`);
});

t('aspas no Windows: sem aspa dupla nem espaço, o literal é o de sempre', () => {
  assert.strictEqual(win.quote('C:\\Users\\x\\dev'), "'C:\\Users\\x\\dev'");
  assert.strictEqual(win.quote("o'brien"), "'o''brien'");
  assert.strictEqual(win.quote('$env:PATH'), "'$env:PATH'");
  assert.strictEqual(quoteWinArg('a"b'), `'a\\"b'`);
  assert.strictEqual(escapeWinNativeArg('C:\\a b\\'), 'C:\\a b\\\\', 'barra final com espaço dobra');
  assert.strictEqual(escapeWinNativeArg('C:\\ab\\'), 'C:\\ab\\', 'sem espaço o PowerShell não envolve: não dobra');
});

t('aspas no macOS: intocadas (POSIX de sempre)', () => {
  assert.strictEqual(mac.quote(`a"b c`), `'a"b c'`);
  assert.strictEqual(mac.quote("it's"), `'it'\\''s'`);
});

t('todo -Command do Windows fixa o modo Legacy; o macOS segue -l -c', () => {
  assert.strictEqual(PS_NATIVE_LEGACY, "$PSNativeCommandArgumentPassing='Legacy'");
  const a = win.shellArgs('claude --x');
  assert.strictEqual(a[a.length - 1], `${PS_NATIVE_LEGACY}; claude --x`);
  assert.deepStrictEqual(win.shellArgsNonInteractive('x').slice(-1), [`${PS_NATIVE_LEGACY}; x`]);
  assert.deepStrictEqual(mac.shellArgs('claude'), ['-l', '-c', 'claude']);
});

// ── IPC por usuário ──────────────────────────────────────────────────────────
t('named pipe leva o usuário; dois usuários não colidem', () => {
  const outro = mkWin({ env: { USERNAME: 'ana maria' } });
  assert.strictEqual(win.ipcEndpoint('open-u'), '\\\\.\\pipe\\norya-carlos-open-u');
  assert.strictEqual(outro.ipcEndpoint('open-u'), '\\\\.\\pipe\\norya-ana_maria-open-u');
  assert.notStrictEqual(win.ipcEndpoint('events-u'), outro.ipcEndpoint('events-u'));
  assert.strictEqual(win.uidTag(), 'u');
  assert.strictEqual(mac.uidTag(), String(process.getuid()));
  assert.ok(mac.ipcEndpoint('auth-1').endsWith(`/norya-${process.getuid()}/norya-auth-1.sock`), 'macOS: pasta privada');
});

// ── Processos filhos ─────────────────────────────────────────────────────────
t('spawnOpts: windowsHide por padrão, quem chama pode sobrescrever', () => {
  assert.deepStrictEqual(win.spawnOpts({ cwd: 'C:\\' }), { windowsHide: true, cwd: 'C:\\' });
  assert.deepStrictEqual(win.spawnOpts({ windowsHide: false }), { windowsHide: false });
  assert.deepStrictEqual(win.spawnOpts(), { windowsHide: true });
});

t('windowless: injeta windowsHide em toda forma de chamada (Windows); macOS = o próprio módulo', () => {
  const calls = [];
  const rec = k => (...a) => { calls.push([k, a]); return k; };
  const cp = { spawn: rec('spawn'), execFile: rec('execFile'), execFileSync: rec('execFileSync'), exec: rec('exec'), fork: rec('fork') };
  const w = win.windowless(cp);
  const cb = () => {};
  w.execFileSync('git', ['status'], { stdio: 'pipe' });
  w.execFileSync('git', ['status']);
  w.execFile('git', ['x'], cb);
  w.execFile('git', cb);
  w.spawn('pwsh', ['-c', 'x'], { env: {} });
  w.spawn('pwsh');
  w.exec('dir', cb);
  w.execFileSync('git', ['x'], undefined);
  const opt = c => c[1].find(x => x && typeof x === 'object' && !Array.isArray(x));
  for (const c of calls) assert.strictEqual(opt(c).windowsHide, true, JSON.stringify(c));
  assert.deepStrictEqual(calls[0][1], ['git', ['status'], { windowsHide: true, stdio: 'pipe' }]);
  assert.strictEqual(calls[2][1][3], cb, 'callback continua no fim');
  assert.strictEqual(calls[3][1][2], cb);
  assert.strictEqual(w.fork, cp.fork, 'o resto do módulo passa reto');
  assert.strictEqual(mac.windowless(cp), cp);
});

t('detachGroup: grupo no POSIX; no Windows não (detached abriria um console)', () => {
  assert.strictEqual(mac.detachGroup, true);
  assert.strictEqual(win.detachGroup, false);
});

t('killTree: taskkill /T /F no Windows; kill(-pid) no POSIX', () => {
  const runs = [];
  const w = mkWin({ execFile: (f, a, o, cb) => { runs.push({ f, a, o }); cb && cb(); } });
  assert.strictEqual(w.killTree(4321, 'SIGTERM'), true);
  assert.deepStrictEqual(runs[0].f, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepStrictEqual(runs[0].a, ['/PID', '4321', '/T', '/F']);
  assert.strictEqual(runs[0].o.windowsHide, true);
  assert.deepStrictEqual(win.killTreeCommand(9), { file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '9', '/T', '/F'] });
  const kills = [];
  mac.killTree(55, 'SIGKILL', { kill: (p, s) => kills.push([p, s]) });
  assert.deepStrictEqual(kills, [[-55, 'SIGKILL']]);
  assert.strictEqual(mac.killTreeCommand(55), null);
  assert.strictEqual(win.killTree(0), false, 'sem pid não mata nada');
});

// ── Resolver CLI sem shell ───────────────────────────────────────────────────
const CMD_NPM7 = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;
const CMD_NPM6 = `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n)`;
const PS1 = `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) { $exe=".exe" }\n$ret=0\nif (Test-Path "$basedir/node$exe") {\n  & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args\n} else {\n  & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args\n}\nexit $ret\n`;
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const ENV_PATH = [HOME_WIN + '\\.local\\bin', NPM, 'C:\\Program Files\\nodejs'].join(';');

function fakeWin(files) {
  const set = new Map(Object.entries(files));
  return mkWin({ exists: f => set.has(f), readFile: f => { if (!set.has(f)) throw new Error('ENOENT'); return set.get(f); } });
}

t('which: .exe ganha do shim do npm; ordem do PATH respeitada', () => {
  const w = fakeWin({ [NPM + '\\claude.cmd']: CMD_NPM7, [NPM + '\\claude.ps1']: PS1, [HOME_WIN + '\\.local\\bin\\claude.exe']: '' });
  assert.strictEqual(w.which('claude', ENV_PATH), HOME_WIN + '\\.local\\bin\\claude.exe');
  const w2 = fakeWin({ [NPM + '\\codex.cmd']: CMD_NPM7, [NPM + '\\codex.ps1']: PS1 });
  assert.strictEqual(w2.which('codex', ENV_PATH), NPM + '\\codex.cmd');
  assert.strictEqual(w2.which('nada', ENV_PATH), null);
});

t('runnable: shim .cmd do npm 7+ vira node.exe + cli.js', () => {
  const w = fakeWin({ [NPM + '\\claude.cmd']: CMD_NPM7, [NODE]: '' });
  assert.deepStrictEqual(w.runnable(NPM + '\\claude.cmd', { envPath: ENV_PATH }),
    { file: NODE, args: [NPM + '\\node_modules\\@anthropic-ai\\claude-code\\cli.js'] });
});

t('runnable: shim .cmd do npm 6 e o .ps1 (Get-Command devolve o .ps1)', () => {
  const w = fakeWin({ [NPM + '\\codex.cmd']: CMD_NPM6, [NODE]: '' });
  assert.deepStrictEqual(w.runnable(NPM + '\\codex.cmd', { envPath: ENV_PATH }).args, [NPM + '\\node_modules\\@openai\\codex\\bin\\codex.js']);
  const w2 = fakeWin({ [NPM + '\\codex.ps1']: PS1, [NODE]: '' });
  assert.deepStrictEqual(w2.runnable(NPM + '\\codex.ps1', { envPath: ENV_PATH }),
    { file: NODE, args: [NPM + '\\node_modules\\@openai\\codex\\bin\\codex.js'] });
});

t('runnable: node.exe ao lado do shim tem precedência (como o próprio shim faz)', () => {
  const w = fakeWin({ [NPM + '\\codex.cmd']: CMD_NPM7, [NPM + '\\node.exe']: '', [NODE]: '' });
  assert.strictEqual(w.runnable(NPM + '\\codex.cmd', { envPath: ENV_PATH }).file, NPM + '\\node.exe');
});

t('runnable: .exe direto; sem alvo nem node → null; POSIX = o próprio binário', () => {
  assert.deepStrictEqual(win.runnable('C:\\x\\claude.exe'), { file: 'C:\\x\\claude.exe', args: [] });
  const semNode = fakeWin({ [NPM + '\\codex.cmd']: CMD_NPM7 });
  assert.strictEqual(semNode.runnable(NPM + '\\codex.cmd', { envPath: ENV_PATH }), null);
  const lixo = fakeWin({ [NPM + '\\x.cmd']: '@echo off\r\nfoo.exe %*' });
  assert.strictEqual(lixo.runnable(NPM + '\\x.cmd', { envPath: ENV_PATH }), null);
  assert.deepStrictEqual(mac.runnable('/opt/homebrew/bin/codex'), { file: '/opt/homebrew/bin/codex', args: [] });
});

t('chatLaunch: Windows sobe a CLI direto, args em array, sem PowerShell', () => {
  const w = fakeWin({ [NPM + '\\claude.cmd']: CMD_NPM7, [NODE]: '' });
  const argv = { bin: 'claude', args: ['-p', '--append-system-prompt', 'leia "C:\\a b\\c.md"'] };
  const l = w.chatLaunch({ shell: 'C:\\pwsh.exe', initCmd: 'claude -p', argv, envPath: ENV_PATH });
  assert.strictEqual(l.direct, true);
  assert.strictEqual(l.file, NODE);
  assert.deepStrictEqual(l.args, [NPM + '\\node_modules\\@anthropic-ai\\claude-code\\cli.js', ...argv.args]);
});

t('chatLaunch: sem binário resolvível cai no PowerShell com console em UTF-8', () => {
  const l = win.chatLaunch({ shell: 'C:\\pwsh.exe', initCmd: "claude -p", argv: { bin: 'claude', args: ['-p'] }, envPath: ENV_PATH });
  assert.strictEqual(l.direct, false);
  assert.strictEqual(l.file, 'C:\\pwsh.exe');
  assert.ok(/UTF8Encoding/.test(l.args[l.args.length - 1]) && l.args[l.args.length - 1].endsWith('; claude -p'));
});

t('chatLaunch: macOS = o shell de login de sempre (byte a byte)', () => {
  const l = mac.chatLaunch({ shell: '/bin/zsh', initCmd: 'exec claude -p', argv: { bin: 'claude', args: ['-p'] }, envPath: '/usr/bin' });
  assert.deepStrictEqual(l, { file: '/bin/zsh', args: ['-l', '-c', 'exec claude -p'], direct: false });
});

// ── Hook do Claude ───────────────────────────────────────────────────────────
t('hookCommand: aspas duplas e barras normais no Windows; POSIX como sempre', () => {
  assert.strictEqual(win.hookCommand(NODE, 'C:\\Users\\carlos\\AppData\\Local\\Programs\\Norya\\resources\\app\\helpers\\norya-claude-event.js'),
    '"C:/Program Files/nodejs/node.exe" "C:/Users/carlos/AppData/Local/Programs/Norya/resources/app/helpers/norya-claude-event.js"');
  assert.strictEqual(mac.hookCommand('/opt/homebrew/bin/node', '/Applications/Norya.app/x.js'),
    `'/opt/homebrew/bin/node' '/Applications/Norya.app/x.js'`);
  assert.strictEqual(win.nodeBinName, 'node.exe');
  assert.strictEqual(win.hookSettingsViaFile, true);
  assert.strictEqual(mac.hookSettingsViaFile, false);
});

// ── Claude: credencial e histórico ───────────────────────────────────────────
t('claude no Windows: credencial e histórico POR PERFIL; no macOS, o HOME real', () => {
  const perfil = HOME_WIN + '\\.norya\\accounts\\7';
  assert.strictEqual(win.claudeCredStore, 'profile-file');
  assert.strictEqual(win.claudeConfigDir(perfil), perfil + '\\.claude');
  assert.strictEqual(win.claudeCredFile(perfil), perfil + '\\.claude\\.credentials.json');
  assert.strictEqual(win.claudeConfigDir(perfil, { CLAUDE_CONFIG_DIR: 'D:\\cc' }), 'D:\\cc', 'CLAUDE_CONFIG_DIR manda');
  assert.strictEqual(mac.claudeCredStore, 'keychain');
  assert.strictEqual(mac.claudeConfigDir('/Users/carlos/.norya/accounts/7'), '/Users/carlos/.claude');
  assert.strictEqual(mac.claudeCredFile('/Users/carlos/.norya/accounts/7'), '/Users/carlos/.claude/.credentials.json');
  assert.strictEqual(mac.claudeConfigDir('/x', { CLAUDE_CONFIG_DIR: '/x/.claude' }), '/x/.claude');
});

// ── Caminhos ─────────────────────────────────────────────────────────────────
t('pathKey/isSameOrInside: Windows sem diferenciar maiúsculas e com as duas barras', () => {
  assert.strictEqual(win.pathKey('C:\\Dev\\App\\'), win.pathKey('c:/dev/app'));
  assert.ok(win.isSameOrInside('c:\\dev\\app\\src', 'C:\\Dev\\App'));
  assert.ok(win.isSameOrInside('C:/Dev/App', 'C:\\Dev\\App\\'));
  assert.ok(!win.isSameOrInside('C:\\Dev\\Application', 'C:\\Dev\\App'));
  assert.ok(mac.isSameOrInside('/a/b/c', '/a/b/'));
  assert.ok(!mac.isSameOrInside('/A/b', '/a/b'), 'macOS segue sensível como antes');
  assert.ok(!mac.isSameOrInside('/a/bc', '/a/b'));
});

t('baseName aceita \\ no Windows', () => {
  assert.strictEqual(win.baseName('C:\\dev\\app\\'), 'app');
  assert.strictEqual(win.baseName('C:/dev/x.js'), 'x.js');
  assert.strictEqual(mac.baseName('/a/b/'), 'b');
});

t('Mini/pet só no macOS', () => {
  assert.strictEqual(mac.supportsPet, true);
  assert.strictEqual(win.supportsPet, false);
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
