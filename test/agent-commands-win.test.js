#!/usr/bin/env node
/**
 * Golden das CLIs com aspas de PowerShell.
 *
 * O irmão `agent-commands.test.js` congela a saída POSIX. Este congela a saída
 * do Windows — e roda no Mac, porque o quoter entra por `deps.quote`.
 *
 * Por que importa: no PowerShell a aspa simples se escapa DOBRANDO. Emitir
 * `'\''` (o jeito POSIX) não dá erro visível — o shell só passa lixo adiante, e
 * a CLI sobe com um `--model` errado. É a classe de bug que só aparece com um
 * caminho de projeto que tem apóstrofo ("Pasta do Carlos's Mac"), meses depois.
 *
 * Uso: node test/agent-commands-win.test.js
 */
const assert = require('assert');
const { buildCommand } = require('../agents/commands');
const { quotePwsh } = require('../platform');

const win = { quote: quotePwsh };
let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

t('codex: caminho Windows entra inteiro, sem escape de barra', () => {
  const cmd = buildCommand('codex', { cwd: 'C:\\Users\\x\\dev\\app' }, win);
  assert.ok(cmd.includes(`--cd 'C:\\Users\\x\\dev\\app'`), cmd);
});

t('codex: apóstrofo no caminho DOBRA (não vira barra-aspa)', () => {
  const cmd = buildCommand('codex', { cwd: "C:\\Users\\o'brien\\dev" }, win);
  assert.ok(cmd.includes(`--cd 'C:\\Users\\o''brien\\dev'`), cmd);
  assert.ok(!cmd.includes(`\\'`), 'escape POSIX vazou para o PowerShell');
});

t('codex: as flags de sempre continuam lá', () => {
  const cmd = buildCommand('codex', { model: 'gpt-5.4', reasoningEffort: 'high' }, win);
  assert.ok(cmd.startsWith('codex '));
  assert.ok(cmd.includes(`--model 'gpt-5.4'`));
  assert.ok(cmd.includes(`-c model_reasoning_effort='high'`));
  assert.ok(cmd.includes('-s workspace-write'));
});

t('claude: bypass permissions vale no Windows também', () => {
  assert.strictEqual(buildCommand('claude', {}, win), 'claude --remote-control --dangerously-skip-permissions');
});

t('claude resume: sessionId citado no estilo do PowerShell', () => {
  const cmd = buildCommand('claude', { mode: 'resume', sessionId: 'abc-123' }, win);
  assert.strictEqual(cmd, `claude --remote-control --dangerously-skip-permissions --resume 'abc-123'`);
});

t('aider: caminhos de histórico com espaço não quebram a linha', () => {
  const cmd = buildCommand('aider', {
    chatHistoryFile: 'C:\\Users\\x\\.norya\\aider threads\\a.md',
    inputHistoryFile: 'C:\\Users\\x\\.norya\\aider threads\\b.md',
  }, win);
  assert.ok(cmd.includes(`--chat-history-file 'C:\\Users\\x\\.norya\\aider threads\\a.md'`), cmd);
});

t('opencode: o diretório continua POSICIONAL', () => {
  const cmd = buildCommand('opencode', { cwd: 'C:\\dev\\x' }, win);
  assert.strictEqual(cmd, `opencode 'C:\\dev\\x'`);
});

t('grok: --cwd com caminho Windows', () => {
  const cmd = buildCommand('grok', { cwd: 'C:\\dev\\x', fullAccess: true }, win);
  assert.ok(cmd.includes(`--cwd 'C:\\dev\\x'`));
  assert.ok(cmd.includes('--always-approve'));
});

t('login vem do registry, não do builder — igual nos dois sistemas', () => {
  assert.strictEqual(buildCommand('codex', { mode: 'login' }, win), 'codex login');
  assert.strictEqual(buildCommand('claude', { mode: 'login' }, win), 'claude setup-token');
});

t('nenhum comando emite aspa DUPLA (o PowerShell interpolaria $)', () => {
  const casos = [
    buildCommand('codex', { cwd: 'C:\\a$b\\c', model: 'gpt-5.4' }, win),
    buildCommand('opencode', { cwd: 'C:\\a$b' }, win),
    buildCommand('grok', { cwd: 'C:\\a$b' }, win),
  ];
  for (const c of casos) assert.ok(!c.includes('"'), c);
});

// ── O que a CLI RECEBE (2026-10-12) ──────────────────────────────────────────
// Os casos acima conferem o TEXTO do comando. Estes passam o comando pelo
// caminho do Windows (PowerShell em modo Legacy → linha de comando →
// CommandLineToArgvW, test/win-argv-sim.js) e conferem o argv que chega à CLI.
// Antes do fix, o JSON do --settings e o caminho entre aspas no prompt de
// skills chegavam picados em vários argumentos.
const { makePlatform } = require('../platform');
const { buildChatArgv, buildChatCommand, claudeHookSettings } = require('../agents/commands');
const { nativeArgv } = require('./win-argv-sim');
const W = makePlatform({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\x', USERNAME: 'x' }, homedir: 'C:\\Users\\x', exists: () => false });
const wdeps = { quote: W.quote, isWin: true };
const CATALOGO = 'C:\\Users\\Ana Lima\\.norya\\skills\\catalog.md';
const PROMPT = `Before working, read \`${CATALOGO}\` and follow "matching" skills. It's fine.`;

t('claude TUI no Windows: prompt de skills e --settings <arquivo> chegam inteiros', () => {
  const file = 'C:\\Users\\Ana Lima\\.norya\\claude-hook-settings.json';
  const cmd = buildCommand('claude', { skillsPrompt: PROMPT, noryaHookCmd: '"C:/node.exe" "C:/h.js"', noryaHookSettingsFile: file, mode: 'resume', sessionId: 'abc-1' }, wdeps);
  const { prog, argv } = nativeArgv(cmd);
  assert.strictEqual(prog, 'claude');
  assert.deepStrictEqual(argv, ['--remote-control', '--dangerously-skip-permissions',
    '--append-system-prompt', PROMPT, '--system-prompt-snapshot', 'off', '--disallowedTools', 'Skill',
    '--settings', file, '--resume', 'abc-1']);
  assert.ok(!cmd.includes('{'), 'com arquivo, nada de JSON inline');
});

t('claude: sem arquivo, o JSON inline TAMBÉM chega inteiro (fallback)', () => {
  const hook = '"C:/Program Files/nodejs/node.exe" "C:/Users/x/AppData/Local/Programs/Norya/resources/app/helpers/norya-claude-event.js"';
  const { argv } = nativeArgv(buildCommand('claude', { noryaHookCmd: hook }, wdeps));
  const i = argv.indexOf('--settings');
  assert.ok(i > 0);
  assert.strictEqual(argv[i + 1], claudeHookSettings(hook));
  assert.strictEqual(JSON.parse(argv[i + 1]).hooks.Stop[0].hooks[0].command, hook);
});

t('codex no Windows: developer_instructions e skills.config chegam como TOML válido', () => {
  const desab = ['C:\\Users\\x\\.codex\\skills\\a b\\SKILL.md'];
  const { argv } = nativeArgv(buildCommand('codex', { skillsPrompt: PROMPT, disabledSkillPaths: desab, cwd: 'C:\\dev\\meu app\\' }, wdeps));
  assert.ok(argv.includes('developer_instructions=' + JSON.stringify(PROMPT)), argv.join(' | '));
  assert.ok(argv.includes('skills.config=[{path=' + JSON.stringify(desab[0]) + ',enabled=false}]'));
  assert.strictEqual(argv[argv.indexOf('--cd') + 1], 'C:\\dev\\meu app\\', 'barra final com espaço não come a aspa');
});

t('prompt inicial no Windows: o `--` vai entre aspas (o PowerShell engole o nu) e o texto chega', () => {
  const hostil = '-rm "tudo" & echo $env:X';
  const cmd = buildCommand('claude', { initialPrompt: hostil }, wdeps);
  assert.ok(cmd.includes(` '--' `), cmd);
  const { argv } = nativeArgv(cmd);
  assert.deepStrictEqual(argv.slice(-2), ['--', hostil]);
  // macOS intocado: `--` nu.
  assert.ok(buildCommand('claude', { initialPrompt: 'oi' }, { isWin: false }).endsWith(` -- 'oi'`));
});

t('modo chat: argv (Windows, sem shell) e comando (macOS) saem dos MESMOS tokens', () => {
  const opts = { model: 'opus', skillsPrompt: PROMPT, mode: 'resume', sessionId: 's-1' };
  const a = buildChatArgv('claude', opts);
  assert.strictEqual(a.bin, 'claude');
  assert.deepStrictEqual(a.args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--model', 'opus', '--append-system-prompt', PROMPT, '--disallowedTools', 'Skill', '--resume', 's-1']);
  // O comando de shell do Windows (fallback) tem que dar o MESMO argv.
  assert.deepStrictEqual(nativeArgv(buildChatCommand('claude', opts, wdeps)).argv, a.args);
  const c = buildChatArgv('codex', { reasoningEffort: 'high', skillsPrompt: PROMPT, disabledSkillPaths: ['C:\\a b\\x'] });
  assert.strictEqual(c.bin, 'codex');
  assert.deepStrictEqual(c.args.slice(0, 3), ['app-server', '-c', 'model_reasoning_effort=high']);
  assert.ok(c.args.includes('developer_instructions=' + JSON.stringify(PROMPT)));
  assert.deepStrictEqual(nativeArgv(buildChatCommand('codex', { reasoningEffort: 'high', skillsPrompt: PROMPT, disabledSkillPaths: ['C:\\a b\\x'] }, wdeps)).argv, c.args);
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
