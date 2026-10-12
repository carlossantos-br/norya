#!/usr/bin/env node
/**
 * Unitário de platform.js — a camada que separa macOS de Windows.
 *
 * O valor deste teste é rodar no MAC e ainda assim provar o comportamento
 * WINDOWS: `makePlatform({ platform: 'win32', ... })` constrói a camada inteira
 * sem tocar no processo real. Sem isso, o port só seria verificável na máquina
 * de destino — e um erro de PATH ou de aspas só apareceria depois de instalado.
 *
 * O outro trabalho aqui é PARIDADE: as strings que o macOS gera hoje não podem
 * mudar. Prelúdio de shell, argv do PTY e caminhos de socket estão congelados
 * abaixo em literais. Se alguém "melhorar" um deles, este teste cai.
 *
 * Uso: node test/platform.test.js
 */
const assert = require('assert');
const path = require('path');
const { makePlatform, quotePosix, quotePwsh } = require('../platform');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

const HOME_MAC = '/Users/x';
const HOME_WIN = 'C:\\Users\\x';

const mac = makePlatform({
  platform: 'darwin',
  env: { SHELL: '/bin/zsh' },
  homedir: HOME_MAC,
  exists: () => false,
});
const win = makePlatform({
  platform: 'win32',
  env: { USERPROFILE: HOME_WIN, SystemRoot: 'C:\\Windows', APPDATA: HOME_WIN + '\\AppData\\Roaming', USERNAME: 'carlos' },
  homedir: HOME_WIN,
  exists: () => false,
});

// ── Identidade ───────────────────────────────────────────────────────────────
t('flags de plataforma não se sobrepõem', () => {
  assert.strictEqual(mac.isMac, true);
  assert.strictEqual(mac.isWin, false);
  assert.strictEqual(win.isWin, true);
  assert.strictEqual(win.isMac, false);
});

// ── Shell e argv ─────────────────────────────────────────────────────────────
t('macOS: shell e argv do PTY continuam zsh -l -c', () => {
  assert.strictEqual(mac.shellBin(), '/bin/zsh');
  assert.deepStrictEqual(mac.shellArgs('codex'), ['-l', '-c', 'codex']);
  assert.deepStrictEqual(mac.shellArgsNonInteractive('codex'), ['-lc', 'codex']);
});

t('macOS: $SHELL do usuário vence o default', () => {
  const bash = makePlatform({ platform: 'darwin', env: { SHELL: '/bin/bash' }, homedir: HOME_MAC });
  assert.strictEqual(bash.shellBin(), '/bin/bash');
});

t('Windows sem pwsh 7: cai no powershell.exe de fábrica', () => {
  assert.strictEqual(win.shellBin(),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

t('Windows com pwsh 7 instalado: prefere o pwsh', () => {
  const alvo = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const comPwsh = makePlatform({
    platform: 'win32',
    env: { USERPROFILE: HOME_WIN, SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    homedir: HOME_WIN,
    exists: p => p === alvo,
  });
  assert.strictEqual(comPwsh.shellBin(), alvo);
});

t('Windows: -NoProfile para o banner do perfil não sujar a TUI', () => {
  const args = win.shellArgs('claude');
  assert.ok(args.includes('-NoProfile'), 'precisa de -NoProfile');
  assert.strictEqual(args[args.length - 2], '-Command');
  // O modo Legacy de passagem de argumentos vem na frente (ver PS_NATIVE_LEGACY).
  assert.strictEqual(args[args.length - 1], "$PSNativeCommandArgumentPassing='Legacy'; claude");
});

// ── Aspas ────────────────────────────────────────────────────────────────────
t('aspas POSIX: fecha, escapa, reabre', () => {
  assert.strictEqual(quotePosix("it's"), `'it'\\''s'`);
  assert.strictEqual(mac.quote('/tmp/a b'), `'/tmp/a b'`);
});

t('aspas PowerShell: a aspa se DOBRA (nunca com barra)', () => {
  assert.strictEqual(quotePwsh("it's"), "'it''s'");
  assert.strictEqual(win.quote('C:\\Users\\x\\a b'), "'C:\\Users\\x\\a b'");
});

t('aspas PowerShell tornam $ literal (nada de expansão de variável)', () => {
  // Aspas SIMPLES no PowerShell não interpolam. Se algum dia isto virar `"`,
  // um caminho com $ (ou um prompt do usuário) viraria execução de variável.
  const q = win.quote('$env:PATH');
  assert.strictEqual(q, "'$env:PATH'");
  assert.ok(!q.includes('"'));
});

// ── PATH ─────────────────────────────────────────────────────────────────────
t('macOS: prelúdio de shell byte-a-byte igual ao histórico', () => {
  const esperado =
    '[ -s "/Users/x/.nvm/nvm.sh" ] && source "/Users/x/.nvm/nvm.sh"; ' +
    'eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null; ' +
    'export PATH="/Users/x/.local/bin:/Users/x/.grok/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
  assert.strictEqual(mac.agentShellPrelude({ nvmDir: '/Users/x/.nvm' }), esperado);
});

t('macOS: prelúdio das SONDAS não mexe na ordem do PATH', () => {
  // Prepender diretórios aqui mudaria QUAL binário `codex` é medido quando há
  // mais de um instalado (nvm e brew). Congelado de propósito.
  const esperado =
    '[ -s "/Users/x/.nvm/nvm.sh" ] && . "/Users/x/.nvm/nvm.sh"; ' +
    'eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null';
  assert.strictEqual(mac.probePrelude({ nvmDir: '/Users/x/.nvm' }), esperado);
  assert.ok(!mac.probePrelude({ nvmDir: '/Users/x/.nvm' }).includes('export PATH'));
});

t('Windows: não existe prelúdio — o PATH vai pelo env', () => {
  assert.strictEqual(win.agentShellPrelude(), '');
  assert.strictEqual(win.probePrelude(), '');
});

t('Windows: os diretórios cobrem npm -g, nvm-windows, scoop e o claude nativo', () => {
  const dirs = win.agentPathDirs();
  assert.ok(dirs.includes('C:\\Users\\x\\AppData\\Roaming\\npm'), 'npm global');
  assert.ok(dirs.includes('C:\\Program Files\\nodejs'), 'nvm-windows aponta aqui');
  assert.ok(dirs.includes('C:\\Users\\x\\scoop\\shims'), 'scoop');
  assert.ok(dirs.includes('C:\\Users\\x\\.local\\bin'), 'instalador nativo do claude');
});

t('prependPath usa o separador certo em cada sistema', () => {
  const e1 = mac.prependPath({ PATH: '/usr/bin' }, '/opt/a', '/opt/b');
  assert.strictEqual(e1.PATH, '/opt/a:/opt/b:/usr/bin');
  const e2 = win.prependPath({ PATH: 'C:\\bin' }, 'C:\\a');
  assert.strictEqual(e2.PATH, 'C:\\a;C:\\bin');
});

t('Windows: Path e PATH duplicados colapsam numa chave só', () => {
  // O env do Windows é case-insensitive, mas o OBJETO que vai pro node-pty não
  // é: sobrando os dois, o filho enxerga um deles e não dá pra prever qual.
  const env = { Path: 'C:\\um', PATH: 'C:\\dois' };
  win.prependPath(env, 'C:\\novo');
  assert.strictEqual(Object.keys(env).filter(k => k.toLowerCase() === 'path').length, 1);
  assert.ok(env.PATH.startsWith('C:\\novo;'));
  assert.ok(env.PATH.includes('C:\\um') && env.PATH.includes('C:\\dois'));
});

t('prependPath aceita array (é como o agentPathDirs entra)', () => {
  const env = { PATH: 'C:\\bin' };
  win.prependPath(env, win.agentPathDirs());
  assert.ok(env.PATH.endsWith(';C:\\bin'));
  assert.ok(env.PATH.split(';').length > 5);
});

// ── IPC ──────────────────────────────────────────────────────────────────────
t('macOS: caminhos de socket idênticos aos de hoje', () => {
  assert.strictEqual(mac.ipcEndpoint('auth-999'), '/tmp/norya-auth-999.sock');
  assert.strictEqual(mac.ipcEndpoint('browser-3', { dir: '/var/folders/tmp' }),
    '/var/folders/tmp/norya-browser-3.sock');
});

t('Windows: named pipe, e o dir é ignorado', () => {
  // Com o usuário no nome: o namespace de pipes é da máquina (ver userTag).
  assert.strictEqual(win.ipcEndpoint('auth-999'), '\\\\.\\pipe\\norya-carlos-auth-999');
  assert.strictEqual(win.ipcEndpoint('browser-3', { dir: 'C:\\Temp' }), '\\\\.\\pipe\\norya-carlos-browser-3');
  assert.ok(win.isPipe(win.ipcEndpoint('x')));
  assert.ok(!mac.isPipe(mac.ipcEndpoint('x')));
});

t('unlinkEndpoint nunca tenta apagar um named pipe', () => {
  let chamou = false;
  const fsFake = { unlinkSync: () => { chamou = true; } };
  win.unlinkEndpoint('\\\\.\\pipe\\norya-x', fsFake);
  assert.strictEqual(chamou, false, 'pipe não tem inode para remover');
  mac.unlinkEndpoint('/tmp/norya-x.sock', fsFake);
  assert.strictEqual(chamou, true, 'socket Unix deixa arquivo órfão');
});

t('restrict (chmod) é no-op no Windows e real no macOS', () => {
  let modo = null;
  const fsFake = { chmodSync: (_p, m) => { modo = m; } };
  assert.strictEqual(win.restrict('x', 0o600, fsFake), false);
  assert.strictEqual(modo, null);
  assert.strictEqual(mac.restrict('x', 0o600, fsFake), true);
  assert.strictEqual(modo, 0o600);
});

// ── Isolamento de perfil ─────────────────────────────────────────────────────
t('macOS: isolar perfil é trocar HOME', () => {
  assert.deepStrictEqual(mac.profileHomeEnv('/Users/x/.norya/accounts/3'),
    { HOME: '/Users/x/.norya/accounts/3' });
});

t('Windows: isolar perfil exige USERPROFILE (é o que o Node e as CLIs leem)', () => {
  const dir = 'C:\\Users\\x\\.norya\\accounts\\3';
  const e = win.profileHomeEnv(dir);
  assert.strictEqual(e.USERPROFILE, dir, 'sem isto, todos os perfis viram a mesma conta');
  assert.strictEqual(e.HOME, dir);
  assert.strictEqual(e.HOMEDRIVE, 'C:');
  assert.strictEqual(e.HOMEPATH, '\\Users\\x\\.norya\\accounts\\3');
});

// ── Detecção de CLIs ─────────────────────────────────────────────────────────
t('macOS: a sonda continua `command -v`', () => {
  assert.strictEqual(mac.probeCommand('codex', 'codex'),
    `p=$(command -v codex 2>/dev/null) && printf '%s\\t%s\\n' codex "$p"`);
});

t('Windows: a sonda usa Get-Command e imprime id<TAB>caminho', () => {
  const cmd = win.probeCommand('claude', 'claude');
  assert.ok(cmd.includes('Get-Command claude'));
  assert.ok(cmd.includes('-ExpandProperty Source'), 'precisa do caminho, não do objeto');
  assert.ok(cmd.includes('`t'), 'o separador tem que ser TAB (crase-t no PowerShell)');
});

t('joinCmds descarta vazios (é o que faz o prelúdio ausente sumir)', () => {
  // `${prelude}; claude` com prelude vazio vira "; claude" — erro de sintaxe
  // no PowerShell. Este filtro é o que evita isso em todos os chamadores.
  assert.strictEqual(win.joinCmds(['', 'claude']), 'claude');
  assert.strictEqual(mac.joinCmds(['a', '', 'b']), 'a; b');
});

t('exec só existe no shell POSIX', () => {
  assert.strictEqual(mac.execPrefix, 'exec ');
  assert.strictEqual(win.execPrefix, '');
});


t('cwd descartável existe nos dois', () => {
  assert.strictEqual(mac.scratchCwd(), '/tmp');
  const w = makePlatform({ platform: 'win32', env: { USERPROFILE: HOME_WIN, TEMP: 'C:\\Temp' }, homedir: HOME_WIN });
  assert.strictEqual(w.scratchCwd(), 'C:\\Temp');
});

t('nomes dos shims batem com os arquivos que existem no repo', () => {
  const fs = require('fs');
  const raiz = path.join(__dirname, '..');
  for (const p of [
    path.join(raiz, 'bin', mac.openShimDirName(), mac.openShimBinName()),
    path.join(raiz, 'bin', win.openShimDirName(), win.openShimBinName()),
    path.join(raiz, 'bin', mac.authOpenBinName()),
    path.join(raiz, 'bin', win.authOpenBinName()),
  ]) {
    assert.ok(fs.existsSync(p), `shim ausente: ${p}`);
  }
});

t('vidro da janela: vibrancy no macOS, mica só no Windows 11+', () => {
  assert.strictEqual(mac.glass, 'vibrancy');
  const w11 = makePlatform({ platform: 'win32', env: { USERPROFILE: HOME_WIN }, homedir: HOME_WIN, release: '10.0.22631' });
  const w10 = makePlatform({ platform: 'win32', env: { USERPROFILE: HOME_WIN }, homedir: HOME_WIN, release: '10.0.19045' });
  assert.strictEqual(w11.glass, 'mica');
  assert.strictEqual(w10.glass, null);
  assert.strictEqual(makePlatform({ platform: 'linux' }).glass, null);
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
