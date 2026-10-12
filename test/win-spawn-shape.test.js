#!/usr/bin/env node
/**
 * Forma da linha de spawn no Windows — verificada A PARTIR DO MAC.
 *
 * O que se prova aqui é a COMPOSIÇÃO: prelúdio + shim + comando da CLI, do
 * jeito exato que o `spawnTerminal` monta, mais o argv que vai para o node-pty.
 * É o ponto onde os erros de port são silenciosos: um `;` sobrando é erro de
 * sintaxe do PowerShell (o pane abre e morre em 1 segundo), e uma aspa dupla
 * transforma `C:\$recycle` em expansão de variável.
 *
 * Não substitui rodar no Windows. Substitui DESCOBRIR isso no Windows.
 *
 * Uso: node test/win-spawn-shape.test.js
 */
const assert = require('assert');
const { makePlatform } = require('../platform');
const { buildCommand } = require('../agents/commands');

const win = makePlatform({
  platform: 'win32',
  env: { USERPROFILE: 'C:\\Users\\x', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
  homedir: 'C:\\Users\\x',
  exists: () => false,
});

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

/** Espelha o que o main.js faz em spawnTerminal. */
function linhaDeSpawn(agentId, opts) {
  const cliCmd = buildCommand(agentId, opts, { quote: win.quote });
  const shimFirst = win.isWin ? '' : 'export PATH=...';
  const initCmd = win.joinCmds([win.agentShellPrelude(), shimFirst, cliCmd]);
  return { initCmd, argv: win.shellArgs(initCmd), shell: win.shellBin() };
}

t('claude: a linha é só o comando — sem prelúdio, sem ponto-e-vírgula solto', () => {
  const { initCmd } = linhaDeSpawn('claude', {});
  assert.strictEqual(initCmd, 'claude --remote-control --dangerously-skip-permissions');
  assert.ok(!initCmd.startsWith(';'), 'PowerShell não aceita `;` inicial');
  assert.ok(!initCmd.includes(';;'));
});

t('codex com projeto: caminho Windows chega inteiro', () => {
  const { initCmd, argv, shell } = linhaDeSpawn('codex', { cwd: 'C:\\Users\\x\\dev\\meu app' });
  assert.ok(initCmd.startsWith('codex '), initCmd);
  assert.ok(initCmd.includes(`--cd 'C:\\Users\\x\\dev\\meu app'`), initCmd);
  assert.strictEqual(argv[argv.length - 1], `$PSNativeCommandArgumentPassing='Legacy'; ${initCmd}`,
    'o comando é o ÚLTIMO argumento de -Command, depois do modo Legacy');
  assert.ok(shell.endsWith('powershell.exe') || shell.endsWith('pwsh.exe'));
});

t('nada de sintaxe POSIX vazando para o PowerShell', () => {
  for (const agente of ['codex', 'claude', 'grok', 'opencode', 'aider']) {
    const { initCmd } = linhaDeSpawn(agente, { cwd: 'C:\\dev\\x', model: 'm-1' });
    for (const proibido of ['export ', 'source ', 'eval "', '$(', '&&', '2>/dev/null', '/bin/']) {
      assert.ok(!initCmd.includes(proibido), `${agente}: "${proibido}" na linha → ${initCmd}`);
    }
    assert.ok(!initCmd.includes('"'), `${agente}: aspa dupla interpola no PowerShell → ${initCmd}`);
  }
});

t('caminho com $ não vira variável', () => {
  const { initCmd } = linhaDeSpawn('codex', { cwd: 'C:\\$Recycle.Bin\\dev' });
  assert.ok(initCmd.includes(`'C:\\$Recycle.Bin\\dev'`), initCmd);
  assert.ok(!initCmd.includes('"'));
});

t('argv do PowerShell tem a ordem que o node-pty precisa', () => {
  const { argv } = linhaDeSpawn('claude', {});
  assert.deepStrictEqual(argv.slice(0, 4), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass']);
  assert.strictEqual(argv[4], '-Command');
  assert.strictEqual(argv.length, 6, '-Command tem que receber UMA string só');
});

t('env do PTY: PATH único, shims na frente, isolamento por perfil', () => {
  // Mesma sequência do spawnTerminal: buildAccountEnv → bin do Norya → shim.
  const dirPerfil = 'C:\\Users\\x\\.norya\\accounts\\7';
  const env = {
    Path: 'C:\\Windows\\System32',                    // como o Windows entrega
    ...win.profileHomeEnv(dirPerfil),
  };
  win.prependPath(env, win.agentPathDirs());
  win.prependPath(env, 'C:\\Program Files\\Norya\\resources\\app\\bin');
  win.prependPath(env, 'C:\\Program Files\\Norya\\resources\\app\\bin\\open-shim-win');

  const chavesPath = Object.keys(env).filter(k => k.toLowerCase() === 'path');
  assert.deepStrictEqual(chavesPath, ['PATH'], 'não pode sobrar Path E PATH');
  const dirs = env.PATH.split(';');
  assert.ok(dirs[0].endsWith('open-shim-win'), 'o shim de open precisa vir primeiro');
  assert.ok(dirs[1].endsWith('bin'), 'depois o bin do Norya (norya-browser)');
  assert.ok(dirs.includes('C:\\Users\\x\\AppData\\Roaming\\npm'), 'npm global no PATH');
  assert.ok(dirs.includes('C:\\Windows\\System32'), 'o PATH herdado não pode sumir');
  assert.strictEqual(env.USERPROFILE, dirPerfil, 'é o USERPROFILE que isola a conta');
});

t('sockets do perfil viram named pipes distintos', () => {
  const a = win.ipcEndpoint('auth-7');
  const b = win.ipcEndpoint('browser-7');
  const c = win.ipcEndpoint('open-u');
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(b, c);
  for (const p of [a, b, c]) assert.ok(p.startsWith('\\\\.\\pipe\\'), p);
});

t('sonda de agentes: um comando PowerShell por CLI, sem `true` de POSIX', () => {
  const probes = ['codex', 'claude'].map(id => win.probeCommand(id, id)).join('; ');
  const cmd = win.joinCmds([win.agentShellPrelude(), probes, '']);
  assert.ok(!cmd.startsWith(';'));
  assert.ok(!/;\s*true$/.test(cmd), '`true` não é comando no PowerShell');
  assert.ok(cmd.includes('Get-Command codex') && cmd.includes('Get-Command claude'));
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
