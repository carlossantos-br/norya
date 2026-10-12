#!/usr/bin/env node
/**
 * Golden test de agents/commands.js.
 *
 * Os builders de codex, claude e aider foram MOVIDOS de main.js. As strings
 * esperadas abaixo são o que aquele código produzia. Qualquer divergência é
 * regressão, não "melhoria" — o objetivo do movimento era comportamento zero-delta.
 *
 * OpenCode e Grok são novos; suas flags saíram de fonte primária
 * (opencode.ai/docs/cli e docs.x.ai/build/cli/reference, 2026-07-09).
 *
 * Sem Electron. Uso: node test/agent-commands.test.js
 */
const assert = require('assert');
const { buildCommand, shellQuote } = require('../agents/commands');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };
const cmd = (id, opts, deps) => buildCommand(id, opts, deps);

// ── shellQuote ───────────────────────────────────────────────────────────────
t('shellQuote envolve em aspas simples', () => {
  assert.strictEqual(shellQuote('/tmp/x'), "'/tmp/x'");
});
t('shellQuote escapa aspa simples (injeção de shell)', () => {
  assert.strictEqual(shellQuote("a'b"), "'a'\\''b'");
  // Um cwd hostil não escapa das aspas:
  assert.strictEqual(shellQuote("'; rm -rf /; '"), "''\\''; rm -rf /; '\\'''");
});

// ── Codex ────────────────────────────────────────────────────────────────────
const CODEX_TAIL = "-c service_tier=default -s workspace-write -a on-request -c features.rmcp_client=false -c check_for_update_on_startup=false " +
                   "-c model_reasoning_summary=detailed -c show_raw_agent_reasoning=true";

t('codex default', () => {
  assert.strictEqual(cmd('codex', {}), `codex ${CODEX_TAIL}`);
});
t('codex com cwd usa --cd', () => {
  assert.strictEqual(cmd('codex', { cwd: '/p' }), `codex ${CODEX_TAIL} --cd '/p'`);
});
t('login vem do registry e ignora todas as flags', () => {
  assert.strictEqual(cmd('codex', { mode: 'login', model: 'x', fullAccess: true }), 'codex login');
  assert.strictEqual(cmd('claude', { mode: 'login', model: 'x' }), 'claude setup-token');
  assert.strictEqual(cmd('grok', { mode: 'login', cwd: '/p' }), 'grok login');
  assert.strictEqual(cmd('opencode', { mode: 'login', cwd: '/p' }), 'opencode auth login');
});
t('agente sem fluxo de login lança em vez de spawnar a TUI', () => {
  // Aider autentica por chave. Pedir login dele spawnaria `aider` normal e o
  // usuário ficaria olhando uma TUI achando que estava logando.
  assert.throws(() => cmd('aider', { mode: 'login' }), /não tem fluxo de login/);
});
t('codex resume sem cwd', () => {
  assert.strictEqual(cmd('codex', { mode: 'resume', sessionId: 'abc-1' }), `codex ${CODEX_TAIL} resume 'abc-1'`);
});
t('codex resume com cwd', () => {
  assert.strictEqual(cmd('codex', { mode: 'resume', sessionId: 'abc-1', cwd: '/p' }),
    `codex ${CODEX_TAIL} --cd '/p' resume 'abc-1'`);
});
t('codex fullAccess troca sandbox por bypass', () => {
  const c = cmd('codex', { fullAccess: true });
  assert.ok(c.includes('--dangerously-bypass-approvals-and-sandbox'), c);
  assert.ok(!c.includes('-s workspace-write'), c);
});
t('codex com model, effort, fast e search', () => {
  assert.strictEqual(
    cmd('codex', { model: 'gpt-5', reasoningEffort: 'high', fastMode: true, webSearch: true }),
    "codex --model 'gpt-5' -c model_reasoning_effort='high' -c service_tier=fast " +
    "-s workspace-write -a on-request --search -c features.rmcp_client=false -c check_for_update_on_startup=false " +
    "-c model_reasoning_summary=detailed -c show_raw_agent_reasoning=true");
});
t('codex via openrouter omite as flags só-OpenAI', () => {
  const c = cmd('codex', { authMode: 'openrouter', reasoningEffort: 'high', fastMode: true, webSearch: true });
  assert.ok(!c.includes('model_reasoning_effort'), c);
  assert.ok(!c.includes('service_tier'), c);
  assert.ok(!c.includes('--search'), c);
  assert.ok(!c.includes('model_reasoning_summary'), c);
  assert.ok(c.includes('features.rmcp_client=false'), c);
});

// ── Claude ───────────────────────────────────────────────────────────────────
// DELTA INTENCIONAL 2026-08-25: toda sessão de Claude do painel sobe em bypass
// permissions (ver comentário em agents/commands.js). É a única divergência
// consciente do comportamento herdado do main.js.
const CLAUDE_BYPASS = '--remote-control --dangerously-skip-permissions';

t('claude default', () => {
  assert.strictEqual(cmd('claude', {}), `claude ${CLAUDE_BYPASS}`);
});
t('claude com model', () => {
  assert.strictEqual(cmd('claude', { model: 'claude-opus-4-8' }),
    `claude --model 'claude-opus-4-8' ${CLAUDE_BYPASS}`);
});
t('claude supports 1m aliases and keeps built-in slash commands with skills', () => {
  const command=cmd('claude', {model:'opus[1m]',skillsPrompt:'Use catalog'});
  assert.ok(command.includes("--model 'opus[1m]'"));
  assert.ok(command.includes('--disallowedTools Skill'));
  assert.ok(!command.includes('--disable-slash-commands'));
});
t('claude rejeita model com caractere estranho', () => {
  assert.strictEqual(cmd('claude', { model: 'a b; rm -rf /' }), `claude ${CLAUDE_BYPASS}`);
});
t('claude resume com sessionId válido', () => {
  assert.strictEqual(cmd('claude', { mode: 'resume', sessionId: 'a1b2-c3' }),
    `claude ${CLAUDE_BYPASS} --resume 'a1b2-c3'`);
});
t('claude resume com sessionId inválido cai para sessão nova, e AVISA', () => {
  const avisos = [];
  const c = cmd('claude', { mode: 'resume', sessionId: 'x; rm -rf /' }, { log: (tag, m) => avisos.push(tag) });
  assert.strictEqual(c, `claude ${CLAUDE_BYPASS}`);
  assert.deepStrictEqual(avisos, ['claude-cmd']);
});
t('claude não recebe --cd (pega cwd do processo)', () => {
  assert.ok(!cmd('claude', { cwd: '/p' }).includes('--cd'));
});
t('bypass vale para TODA sessão de claude, com ou sem fullAccess', () => {
  // O checkbox "Full access" liga/desliga o sandbox do codex e do grok. No
  // claude o painel não oferece meio-termo: sessão de agente sobe sem aprovação.
  for (const opts of [{}, { fullAccess: false }, { fullAccess: true },
                      { mode: 'resume', sessionId: 'a1' }, { model: 'opus' }]) {
    assert.ok(cmd('claude', opts).includes(CLAUDE_BYPASS), JSON.stringify(opts));
  }
});
t('login do claude NÃO leva a flag de bypass (setup-token não aceita)', () => {
  assert.strictEqual(cmd('claude', { mode: 'login', fullAccess: true }), 'claude setup-token');
});

// ── Aider ────────────────────────────────────────────────────────────────────
const AIDER_TAIL = '--no-auto-commits --no-show-model-warnings --no-show-release-notes ' +
                   '--no-check-update --no-gitignore --no-suggest-shell-commands';

t('aider default', () => {
  assert.strictEqual(cmd('aider', {}), `aider ${AIDER_TAIL}`);
});
t('aider prefixa openrouter/ em model com barra', () => {
  assert.ok(cmd('aider', { model: 'xiaomi/mimo' }).startsWith("aider --model 'openrouter/xiaomi/mimo'"));
});
t('aider NÃO prefixa duas vezes', () => {
  assert.ok(cmd('aider', { model: 'openrouter/x/y' }).startsWith("aider --model 'openrouter/x/y'"));
});
t('aider não prefixa model sem barra', () => {
  assert.ok(cmd('aider', { model: 'gpt-4' }).startsWith("aider --model 'gpt-4'"));
});
t('aider com histórico por thread', () => {
  const c = cmd('aider', { chatHistoryFile: '/h/c.md', inputHistoryFile: '/h/i.hist' });
  assert.ok(c.includes("--chat-history-file '/h/c.md'"), c);
  assert.ok(c.includes("--input-history-file '/h/i.hist'"), c);
  assert.ok(c.includes('--restore-chat-history'), c);
});
t('aider fullAccess troca --no-suggest-shell-commands por --yes-always', () => {
  const c = cmd('aider', { fullAccess: true });
  assert.ok(c.includes('--yes-always'), c);
  assert.ok(!c.includes('--no-suggest-shell-commands'), c);
});

// ── OpenCode (novo) ──────────────────────────────────────────────────────────
t('opencode default', () => {
  assert.strictEqual(cmd('opencode', {}), 'opencode');
});
t('opencode recebe o diretório como POSICIONAL, não flag', () => {
  assert.strictEqual(cmd('opencode', { cwd: '/p' }), "opencode '/p'");
  assert.ok(!cmd('opencode', { cwd: '/p' }).includes('--cwd'));
});
t('opencode com model provider/model', () => {
  assert.strictEqual(cmd('opencode', { model: 'xai/grok-4.5', cwd: '/p' }),
    "opencode --model 'xai/grok-4.5' '/p'");
});
t('opencode resume usa --session', () => {
  assert.ok(cmd('opencode', { mode: 'resume', sessionId: 'ses1' }).includes("--session 'ses1'"));
});
t('opencode ignora sessionId hostil', () => {
  assert.strictEqual(cmd('opencode', { mode: 'resume', sessionId: 'a; rm -rf /' }), 'opencode');
});

// ── Grok Build (novo) ────────────────────────────────────────────────────────
t('grok default', () => {
  assert.strictEqual(cmd('grok', {}), 'grok');
});
t('grok usa --cwd (diferente do opencode)', () => {
  assert.strictEqual(cmd('grok', { cwd: '/p' }), "grok --cwd '/p'");
});
t('grok com model e effort', () => {
  assert.strictEqual(cmd('grok', { model: 'grok-build-0.1', reasoningEffort: 'high' }),
    "grok --model 'grok-build-0.1' --effort 'high'");
});
t('grok fullAccess usa --always-approve', () => {
  assert.ok(cmd('grok', { fullAccess: true }).includes('--always-approve'));
});
t('grok resume', () => {
  assert.ok(cmd('grok', { mode: 'resume', sessionId: 's-1' }).includes("--resume 's-1'"));
});

// ── Claude: hooks de evento do Norya (2026-10-04) ────────────────────────────
t('claude sem noryaHookCmd não ganha --settings (golden intacto)', () => {
  assert.ok(!cmd('claude', {}).includes('--settings'));
});
t('claude com noryaHookCmd: --settings passa pelo shell e vira JSON com os 4 hooks', () => {
  const hook = "'/usr/local/bin/node' '/App Dir/helpers/norya-claude-event.js'";
  const c = cmd('claude', { noryaHookCmd: hook, mode: 'resume', sessionId: 'abc' });
  assert.ok(/--settings '.*' --resume 'abc'$/.test(c), c);
  // O shell de verdade desfaz as aspas: o argumento tem que chegar como JSON
  // válido, com o comando do hook (e suas próprias aspas) intacto.
  const arg = require('child_process').execFileSync('/bin/sh',
    ['-c', 'printf %s ' + c.match(/--settings ('(?:[^']|'\\'')*')/)[1]], { encoding: 'utf8' });
  const s = JSON.parse(arg);
  assert.deepStrictEqual(Object.keys(s.hooks).sort(), ['Notification', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.strictEqual(s.hooks.Stop[0].hooks[0].command, hook);
  assert.strictEqual(s.hooks.PreToolUse[0].hooks[0].async, true);
  assert.strictEqual(s.hooks.Notification[0].matcher, 'permission_prompt');
  assert.ok(!s.hooks.SubagentStop, 'SubagentStop não é fim de turno do pane');
});

// ── Prompt inicial (Mini/pet, 2026-10-05) ────────────────────────────────────
t('initialPrompt: argumento posicional quoted depois de `--`, só em sessão NOVA (claude e codex)', () => {
  const c0 = cmd('claude', {});
  assert.strictEqual(cmd('claude', { initialPrompt: 'oi' }), `${c0} -- 'oi'`);
  assert.strictEqual(cmd('codex', { initialPrompt: 'oi', cwd: '/p' }), `${cmd('codex', { cwd: '/p' })} -- 'oi'`);
  assert.strictEqual(cmd('codex', { initialPrompt: 'oi' }), `${cmd('codex', {})} -- 'oi'`);
  // resume nunca leva prompt
  assert.strictEqual(cmd('claude', { mode: 'resume', sessionId: 'abc', initialPrompt: 'oi' }), cmd('claude', { mode: 'resume', sessionId: 'abc' }));
  assert.strictEqual(cmd('codex', { mode: 'resume', sessionId: 'abc', initialPrompt: 'oi' }), cmd('codex', { mode: 'resume', sessionId: 'abc' }));
  // vazio / só espaço / não-string = comando idêntico ao golden
  for (const v of ['', '   \n', null, 42]) assert.strictEqual(cmd('claude', { initialPrompt: v }), c0);
});
t('initialPrompt: aspas, $(), crase e quebra de linha ficam dentro das aspas; "-x" não vira opção', () => {
  const hostil = "a'b $(rm -rf /) `x`\nlinha2";
  assert.strictEqual(cmd('claude', { initialPrompt: hostil }), `${cmd('claude', {})} -- ${shellQuote(hostil)}`);
  assert.ok(cmd('codex', { initialPrompt: '--help' }).endsWith(" -- '--help'"));
  // prova no shell de verdade: o argumento chega inteiro e único
  const out = require('child_process').execFileSync('sh', ['-c', 'printf "%s" ' + shellQuote(hostil)], { encoding: 'utf8' });
  assert.strictEqual(out, hostil);
});
t('initialPrompt: aider/grok/opencode ignoram; Windows (PowerShell) usa o quoter injetado', () => {
  assert.strictEqual(cmd('grok', { initialPrompt: 'oi' }), cmd('grok', {}));
  assert.strictEqual(cmd('claude', { initialPrompt: "it's" }, { quote: (x) => `"${x.replace(/"/g, '""')}"` }), `${cmd('claude', {})} -- "it's"`);
});
t('initialPrompt: truncado em 8000 chars', () => {
  assert.strictEqual(cmd('claude', { initialPrompt: 'x'.repeat(9000) }), `${cmd('claude', {})} -- '${'x'.repeat(8000)}'`);
});

// ── Dispatch ─────────────────────────────────────────────────────────────────
t('agente desconhecido lança em vez de spawnar lixo', () => {
  assert.throws(() => cmd('nao-existe', {}), /agente desconhecido/);
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
