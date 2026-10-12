#!/usr/bin/env node
/**
 * test/chat-protocol.test.js — tradução do protocolo das CLIs para o pane de
 * chat (chat/chat-protocol.js) e o comando do modo chat (agents/commands.js).
 *
 * As mensagens abaixo têm o formato real capturado em 2026-10-11 (claude
 * 2.1.295 `-p --output-format stream-json`, codex-cli 0.160.0 `app-server`),
 * reduzidas ao que importa.
 *
 * Uso: node test/chat-protocol.test.js   → exit 0 = PASS, 1 = FAIL
 */
const assert = require('assert');
const P = require('../chat/chat-protocol');
const { buildChatCommand, CHAT_AGENTS } = require('../agents/commands');

let passed = 0;
const t = (nome, fn) => {
  try { fn(); passed++; console.log(`  ok  ${nome}`); }
  catch (e) { console.error(`  FAIL ${nome}\n       ${e.message}`); process.exitCode = 1; }
};
const feedAll = (tr, msgs) => msgs.flatMap(m => tr.feed(m));

// ── Claude ───────────────────────────────────────────────────────────────────
const SID = '32dcfdad-11bc-472c-a338-96a55ccb7722';
const claudeTurn = [
  { type: 'system', subtype: 'hook_started', session_id: SID },
  { type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-5-5' },
  { type: 'system', subtype: 'status', status: 'requesting', session_id: SID },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: '' }] } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "echo' } } },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo oi' } }] } },
  { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'oi', is_error: false }] } },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'p' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ronto' } } },
  { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'pronto' }] } },
  { type: 'result', subtype: 'success', is_error: false, duration_ms: 3021, session_id: SID },
];

t('claude: sessão, turno, tool com resultado, texto em deltas, fim', () => {
  const ev = feedAll(P.createClaudeTranslator(), claudeTurn);
  assert.deepStrictEqual(ev[0], { t: 'session', sessionId: SID, model: 'claude-haiku-5-5' });
  assert.deepStrictEqual(ev[1], { t: 'turn', state: 'start' });
  const tools = ev.filter(e => e.t === 'item' && e.item.kind === 'tool');
  assert.ok(tools.every(e => e.item.label === 'Comando executado: echo oi'), 'tool nunca sai com rótulo vazio');
  assert.strictEqual(tools[tools.length - 1].item.status, 'done');
  assert.strictEqual(tools[tools.length - 1].item.detail, 'oi');
  const text = ev.filter(e => e.t === 'delta' && e.id === 'msg_2:0').map(e => e.text).join('');
  assert.strictEqual(text, 'pronto');
  // O `assistant` completo não duplica o texto que já veio em deltas.
  assert.strictEqual(ev.filter(e => e.t === 'item' && e.item.id === 'msg_2:0').length, 1);
  const end = ev[ev.length - 1];
  assert.deepStrictEqual(end, { t: 'turn', state: 'end', durationMs: 3021, error: null, interrupted: false });
  assert.strictEqual(ev.filter(e => e.t === 'turn' && e.state === 'start').length, 1, '1 turno só, mesmo com 2 requests');
});

t('claude: sem stream parcial, o texto chega pelo assistant', () => {
  const tr = P.createClaudeTranslator();
  const ev = feedAll(tr, [
    { type: 'system', subtype: 'init', session_id: SID },
    { type: 'assistant', message: { id: 'm9', content: [{ type: 'text', text: 'olá' }] } },
  ]);
  const it = ev.find(e => e.t === 'item' && e.item.kind === 'text');
  assert.strictEqual(it.item.text, 'olá');
});

t('claude: TodoWrite não aparece (pane sem lista de tarefas)', () => {
  const ev = feedAll(P.createClaudeTranslator(), [
    { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'x', name: 'TodoWrite', input: { todos: [] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
  ]);
  assert.ok(!ev.some(e => e.t === 'item'));
});

t('claude: eventos de subagente (parent_tool_use_id) ficam de fora', () => {
  const ev = feedAll(P.createClaudeTranslator(), [
    { type: 'assistant', parent_tool_use_id: 'toolu_p', message: { id: 'm', content: [{ type: 'text', text: 'interno' }] } },
  ]);
  assert.ok(!ev.some(e => e.t === 'item'));
});

t('claude: rótulos das ferramentas', () => {
  assert.strictEqual(P.claudeToolView('Read', { file_path: '/a/b/c.md' }).label, 'Leu c.md');
  assert.strictEqual(P.claudeToolView('Edit', { file_path: '/a/x.js' }).icon, 'edit');
  assert.strictEqual(P.claudeToolView('Grep', { pattern: 'foo' }).label, 'Buscou por foo');
  assert.strictEqual(P.claudeToolView('mcp__notes__read_file', {}).label, 'Usou read_file (notes)');
});

t('claude: linha de entrada e de interrupção', () => {
  const u = JSON.parse(P.claudeUserLine('oi\nmundo'));
  assert.deepStrictEqual(u, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'oi\nmundo' }] } });
  const i = JSON.parse(P.claudeInterruptLine('r1'));
  assert.deepStrictEqual(i, { type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } });
});

t('claude: histórico do transcript vira user → turno → itens → fim', () => {
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-12T02:00:00Z', message: { role: 'user', content: 'liste os arquivos' } },
    { type: 'assistant', timestamp: '2026-10-12T02:00:02Z', message: { id: 'a1', content: [{ type: 'tool_use', id: 'tl', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', timestamp: '2026-10-12T02:00:03Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tl', content: 'a\nb' }] } },
    { type: 'assistant', timestamp: '2026-10-12T02:00:05Z', message: { id: 'a2', content: [{ type: 'text', text: 'a e b' }] } },
    { type: 'user', uuid: 'meta', isMeta: true, message: { content: 'ignorar' } },
    { type: 'user', uuid: 'u2', message: { content: '<command-name>/clear</command-name>' } },
  ].map(o => JSON.stringify(o));
  const ev = P.claudeHistoryEvents(lines);
  assert.deepStrictEqual(ev.map(e => e.t === 'item' ? e.item.kind : e.t + ':' + e.state),
    ['user', 'turn:start', 'tool', 'tool', 'text', 'turn:end']);
  assert.strictEqual(ev[ev.length - 1].durationMs, 5000);
  assert.strictEqual(ev[3].item.detail, 'a\nb');
});

// ── Codex ────────────────────────────────────────────────────────────────────
const TID = '01a12dfa-6e09-7d12-b41a-5a53f2230e71';
const n = (method, params) => ({ method, params: Object.assign({ threadId: TID }, params || {}) });
const codexTurn = [
  { method: 'thread/started', params: { thread: { id: TID, model: 'gpt-6-astra' } } },
  n('turn/started', { turn: { id: 'turn1' } }),
  n('item/started', { item: { type: 'userMessage', id: 'um', content: [{ type: 'text', text: 'rode ls' }] } }),
  n('item/started', { item: { type: 'agentMessage', id: 'am1', text: '', phase: 'commentary' } }),
  n('item/agentMessage/delta', { itemId: 'am1', delta: 'Vou' }),
  n('item/completed', { item: { type: 'agentMessage', id: 'am1', text: 'Vou rodar.', phase: 'commentary' } }),
  n('item/started', { item: { type: 'commandExecution', id: 'ex1', command: '/bin/zsh -lc ls', status: 'inProgress', commandActions: [{ type: 'listFiles', command: 'ls', path: null }] } }),
  n('item/completed', { item: { type: 'commandExecution', id: 'ex1', command: '/bin/zsh -lc ls', status: 'completed', aggregatedOutput: 'a\n', commandActions: [{ type: 'listFiles', command: 'ls', path: null }] } }),
  n('item/completed', { item: { type: 'commandExecution', id: 'ex2', command: "/bin/zsh -lc 'cat README.md'", status: 'completed', commandActions: [{ type: 'read', command: 'cat README.md', name: 'README.md', path: '/x/README.md' }] } }),
  n('item/completed', { item: { type: 'commandExecution', id: 'ex3', command: "/bin/zsh -lc \"date '+%H'\"", status: 'failed', commandActions: [{ type: 'unknown', command: 'date' }] } }),
  n('item/completed', { item: { type: 'plan', id: 'p1', text: '- passo' } }),
  n('item/completed', { item: { type: 'agentMessage', id: 'am2', text: 'pronto', phase: 'final_answer' } }),
  { method: 'item/agentMessage/delta', params: { threadId: 'outra-thread', itemId: 'zz', delta: 'subagente' } },
  n('turn/completed', { turn: { id: 'turn1', status: 'completed', durationMs: 15645 } }),
];

t('codex: sessão, turno, itens, sem eco do usuário, sem plano, sem outra thread', () => {
  const tr = P.createCodexTranslator();
  const ev = feedAll(tr, codexTurn);
  assert.deepStrictEqual(ev[0], { t: 'session', sessionId: TID, model: 'gpt-6-astra' });
  assert.ok(!ev.some(e => e.t === 'item' && e.item.kind === 'user'), 'eco do prompt não entra');
  assert.ok(!ev.some(e => e.t === 'item' && e.item.id === 'p1'), 'plano não entra');
  assert.ok(!ev.some(e => e.t === 'delta' && e.id === 'zz'), 'outra thread não entra');
  const byId = {};
  for (const e of ev) if (e.t === 'item') byId[e.item.id] = e.item;
  assert.strictEqual(byId.ex1.icon, 'list');
  assert.strictEqual(byId.ex1.status, 'done');
  assert.strictEqual(byId.ex2.label, 'Leu README.md');
  assert.strictEqual(byId.ex3.label, "Comando executado: date '+%H'");
  assert.strictEqual(byId.ex3.status, 'error');
  assert.strictEqual(byId.am2.final, true);
  assert.deepStrictEqual(ev[ev.length - 1], { t: 'turn', state: 'end', durationMs: 15645, error: null, interrupted: false });
});

t('codex: comando em andamento diz "Executando"', () => {
  const v = P.codexItemView({ type: 'commandExecution', id: 'x', command: '/bin/zsh -lc npm test', status: 'inProgress', commandActions: [] }, false);
  assert.strictEqual(v.label, 'Executando: npm test');
  assert.strictEqual(v.status, 'running');
});

t('codex: turno interrompido e com falha', () => {
  const tr = P.createCodexTranslator();
  tr.setThread(TID);
  const [a] = tr.feed(n('turn/completed', { turn: { status: 'interrupted', durationMs: 10 } }));
  assert.strictEqual(a.interrupted, true);
  const [b] = tr.feed(n('turn/completed', { turn: { status: 'failed', error: { message: 'limite' }, durationMs: 10 } }));
  assert.strictEqual(b.error, 'limite');
});

t('codex: histórico de turns/list', () => {
  const ev = P.codexHistoryEvents([{
    id: 't1', status: 'completed', durationMs: 4000, items: [
      { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'oi' }] },
      { type: 'reasoning', id: 'r', summary: ['pensando'] },
      { type: 'agentMessage', id: 'a', text: 'olá', phase: 'final_answer' },
    ],
  }]);
  assert.deepStrictEqual(ev.map(e => e.t === 'item' ? e.item.kind : e.t + ':' + e.state),
    ['user', 'turn:start', 'reasoning', 'text', 'turn:end']);
  assert.strictEqual(ev[ev.length - 1].durationMs, 4000);
});

t('codex: pedido de aprovação de comando', () => {
  const v = P.codexApprovalView('item/commandExecution/requestApproval', { command: '/bin/zsh -lc rm -rf build', reason: 'limpar' });
  assert.strictEqual(v.kind, 'cmd');
  assert.ok(v.detail.startsWith('rm -rf build'));
  assert.strictEqual(P.codexApprovalView('item/tool/call', {}), null);
});

// ── Comando ──────────────────────────────────────────────────────────────────
t('comando do chat: claude com resume e modelo, exec no POSIX', () => {
  const c = buildChatCommand('claude', { model: 'opus', mode: 'resume', sessionId: SID }, { isWin: false, quote: s => `'${s}'` });
  assert.ok(c.startsWith('exec claude -p --input-format stream-json --output-format stream-json'));
  assert.ok(c.includes(`--resume '${SID}'`));
  assert.ok(c.includes("--model 'opus'"));
  assert.ok(!c.includes('--remote-control'), 'RC é da TUI');
});

t('comando do chat: sessionId com metacaractere não vira --resume', () => {
  const c = buildChatCommand('claude', { mode: 'resume', sessionId: 'x; rm -rf ~' }, { isWin: false });
  assert.ok(!c.includes('--resume'));
});

t('comando do chat: codex app-server com esforço e sem exec no Windows', () => {
  const c = buildChatCommand('codex', { reasoningEffort: 'high' }, { isWin: true, quote: s => `'${s}'` });
  assert.ok(c.startsWith('codex app-server'));
  assert.ok(c.includes("model_reasoning_effort='high'"));
});

t('comando do chat: só claude e codex', () => {
  assert.deepStrictEqual([...CHAT_AGENTS].sort(), ['claude', 'codex']);
  assert.throws(() => buildChatCommand('grok', {}));
});

// ── Seletor de modelo / esforço / acesso ───────────────────────────────────
t('seletor: modelos do initialize do claude (sem o apelido "default")', () => {
  const o = P.claudeModelOptions([
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: ['low'] },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', supportsEffort: false },
  ]);
  assert.deepStrictEqual(o.map(m => m.value), ['opus', 'haiku']);
  assert.strictEqual(o[0].resolved, 'claude-opus-5-5');
  assert.deepStrictEqual(o[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(o[1].efforts, []);
  assert.deepStrictEqual(P.claudeModelOptions(undefined), []);
});

t('seletor: modelos do model/list do codex (sem os escondidos)', () => {
  const o = P.codexModelOptions([
    { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true, defaultReasoningEffort: 'xhigh',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'xhigh', description: '' }] },
    { id: 'velho', model: 'velho', hidden: true, supportedReasoningEfforts: [] },
  ]);
  assert.strictEqual(o.length, 1);
  assert.deepStrictEqual(o[0].efforts, ['low', 'xhigh']);
  assert.strictEqual(o[0].defaultEffort, 'xhigh');
  assert.strictEqual(o[0].isDefault, true);
});

t('seletor: control_request do claude', () => {
  const j = JSON.parse(P.claudeControlLine('c1', { subtype: 'set_model', model: 'sonnet' }));
  assert.deepStrictEqual(j, { type: 'control_request', request_id: 'c1', request: { subtype: 'set_model', model: 'sonnet' } });
});

t('seletor: acesso do codex (ida e volta)', () => {
  assert.strictEqual(P.CODEX_ACCESS.full.approvalPolicy, 'never');
  assert.strictEqual(P.CODEX_ACCESS.full.sandboxPolicy.type, 'dangerFullAccess');
  assert.strictEqual(P.codexAccessOf('never', { type: 'dangerFullAccess' }), 'full');
  assert.strictEqual(P.codexAccessOf('on-request', { type: 'workspaceWrite' }), 'ask');
  assert.strictEqual(P.codexAccessOf('on-request', { type: 'readOnly' }), 'readonly');
  assert.strictEqual(P.codexAccessOf('never', null), 'full');
});

// ── Composer: anexos, uso, permissão, comandos (2026-10-11) ─────────────────
t('anexo: imagem vai antes do texto; só imagem não manda texto vazio', () => {
  const j = JSON.parse(P.claudeUserLine('que cor?', [{ mediaType: 'image/png', data: 'QUJD' }]));
  assert.deepStrictEqual(j.message.content.map(c => c.type), ['image', 'text']);
  assert.strictEqual(j.message.content[0].source.media_type, 'image/png');
  const so = JSON.parse(P.claudeUserLine('', [{ mediaType: 'image/png', data: 'QUJD' }]));
  assert.deepStrictEqual(so.message.content.map(c => c.type), ['image']);
  assert.deepStrictEqual(JSON.parse(P.claudeUserLine('oi')).message.content, [{ type: 'text', text: 'oi' }]);
});

t('uso: contexto da última chamada + janela do modelUsage no fim do turno', () => {
  const tr = P.createClaudeTranslator();
  tr.feed({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-haiku-5-5' });
  tr.feed({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'oi' }],
    usage: { input_tokens: 2, cache_read_input_tokens: 34310, cache_creation_input_tokens: 6135, output_tokens: 4 } } });
  const evs = tr.feed({ type: 'result', subtype: 'success', duration_ms: 10, total_cost_usd: 0.0062,
    modelUsage: { 'claude-haiku-5-5': { contextWindow: 1000000 } } });
  const u = evs.find(e => e.t === 'usage');
  assert.deepStrictEqual(u, { t: 'usage', used: 40451, window: 1000000, costUsd: 0.0062 });
  assert.ok(evs.findIndex(e => e.t === 'usage') < evs.findIndex(e => e.t === 'turn'), 'usage antes do fim do turno');
});

t('uso: codex thread/tokenUsage/updated', () => {
  const tr = P.createCodexTranslator();
  tr.setThread('th');
  const evs = tr.feed({ method: 'thread/tokenUsage/updated', params: { threadId: 'th', turnId: 't',
    tokenUsage: { last: { totalTokens: 5000 }, total: { totalTokens: 9000 }, modelContextWindow: 200000 } } });
  assert.deepStrictEqual(evs, [{ t: 'usage', used: 5000, window: 200000, costUsd: null }]);
});

t('permissão do claude: can_use_tool → cartão; resposta allow/deny', () => {
  const v = P.claudeApprovalView({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' }, description: 'Cria x' });
  assert.strictEqual(v.kind, 'cmd');
  assert.ok(/touch x/.test(v.detail));
  const e = P.claudeApprovalView({ tool_name: 'Edit', input: { file_path: '/a/b.js', old_string: 'a', new_string: 'b' } });
  assert.strictEqual(e.label, 'Editar b.js?');
  const ok = JSON.parse(P.claudePermissionLine('r1', true, { command: 'touch x' }));
  assert.deepStrictEqual(ok, { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'touch x' } } } });
  const no = JSON.parse(P.claudePermissionLine('r2', false));
  assert.strictEqual(no.response.response.behavior, 'deny');
  assert.ok(P.CLAUDE_ACCESS.find(a => a.value === 'bypassPermissions').full);
});

t('comandos: lista do initialize sem duplicados nem internos', () => {
  const c = P.claudeCommandOptions([{ name: 'compact', description: 'Resume', argumentHint: '<instr>' },
    { name: 'compact', description: 'dup' }, { name: '__remote-workflow', description: 'x' }, { name: 'context', description: '' }]);
  assert.deepStrictEqual(c.map(x => x.name), ['compact', 'context']);
  assert.strictEqual(c[0].hint, '<instr>');
  assert.deepStrictEqual(P.CODEX_COMMANDS.map(x => x.name), ['compact', 'review']);
});

t('histórico: prompt com imagem (claude e codex) guarda as imagens', () => {
  const ev = P.claudeHistoryEvents([{ type: 'user', uuid: 'u1', timestamp: '2026-10-11T00:00:00Z',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] } }]);
  const u = ev.find(e => e.t === 'item');
  assert.strictEqual(u.item.text, '');
  assert.deepStrictEqual(u.item.images, [{ label: 'Imagem' }]);
  const cx = P.codexItemView({ type: 'userMessage', id: 'i', content: [{ type: 'localImage', path: '/tmp/a.png' }, { type: 'text', text: 'oi' }] }, true);
  assert.deepStrictEqual(cx.images, [{ path: '/tmp/a.png' }]);
  assert.strictEqual(cx.text, 'oi');
});

t('comando chat do claude pergunta permissão pelo stdio', () => {
  const c = buildChatCommand('claude', {}, { isWin: false });
  assert.ok(c.includes('--permission-prompt-tool stdio'));
  assert.ok(c.includes('--dangerously-skip-permissions'));
});

t('@arquivo: ranking nome > caminho > subsequência', () => {
  const { rankFiles } = require('../chat/chat-files');
  const files = ['renderer/chat.js', 'chat/chat-session.js', 'docs/notes-chat.md', 'src/c_h_a_t.txt', 'main.js'];
  assert.deepStrictEqual(rankFiles(files, 'chat').slice(0, 3), ['renderer/chat.js', 'chat/chat-session.js', 'docs/notes-chat.md']);
  assert.ok(rankFiles(files, 'cht').includes('src/c_h_a_t.txt'));
  assert.ok(!rankFiles(files, 'zzz').length);
  assert.strictEqual(rankFiles(files, '')[0], 'main.js');
});

t('uso: /compact sem chamada própria usa o result, não o tamanho antigo', () => {
  const tr = P.createClaudeTranslator();
  tr.feed({ type: 'system', subtype: 'status', status: 'requesting' });
  tr.feed({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 900000, output_tokens: 10 } } });
  tr.feed({ type: 'result', subtype: 'success', modelUsage: { a: { contextWindow: 1000000 } } });
  tr.feed({ type: 'system', subtype: 'status', status: 'requesting' });
  tr.feed({ type: 'system', subtype: 'compact_boundary' });
  const evs = tr.feed({ type: 'result', subtype: 'success', modelUsage: { a: { contextWindow: 1000000 } },
    usage: { iterations: [{ input_tokens: 12000, output_tokens: 300 }] } });
  assert.strictEqual(evs.find(e => e.t === 'usage').used, 12300);
});

console.log(process.exitCode ? '\nFALHOU' : `\nTUDO PASSOU (${passed}/${passed})`);
