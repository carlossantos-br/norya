#!/usr/bin/env node
/**
 * helpers/norya-claude-event.js — o hook do Claude Code que avisa o Norya.
 *
 * (a) contagem de tarefas em background pendentes a partir de um transcript
 *     sintético (test/fixtures/claude-bg-transcript.jsonl), no formato real
 *     conferido em ~/.claude/projects em 2026-10-04: lançamento por
 *     toolUseResult.{isAsync,status:"async_launched",agentId} e
 *     (Bash em background, toolUseResult.backgroundTaskId, é ignorado de
 *     propósito); entrega por mensagem user string ou
 *     attachment queued_command com <task-notification>.
 * (b) mapeamento hook → evento (Notification idle_prompt ignorado, SubagentStop
 *     ignorado, Stop com/sem background).
 * (c) o processo de verdade: manda 1 linha no socket, exit 0 sempre, nada no
 *     stdout, no-op sem NORYA_EVENT_SOCKET.
 *
 * Sem Electron. Uso: node test/claude-event-hook.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

const HELPER = path.join(__dirname, '..', 'helpers', 'norya-claude-event.js');
const { countPendingBackground, eventFor, lastAssistantSummary, activityFor } = require(HELPER);
const FIXTURE = path.join(__dirname, 'fixtures', 'claude-bg-transcript.jsonl');
const LINHAS = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
const ate = (n) => LINHAS.slice(0, n).join('\n') + '\n';

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };
const ta = async (nome, fn) => { await fn(); console.log(`PASS  ${nome}`); n++; };

// ── (a) contagem ─────────────────────────────────────────────────────────────
t('sem background → 0', () => {
  assert.strictEqual(countPendingBackground(ate(2)), 0);
});
t('agent async lançado conta 1', () => {
  assert.strictEqual(countPendingBackground(ate(3)), 1);
});
t('bash em background (backgroundTaskId) NÃO conta: servidor de dev nunca termina', () => {
  assert.strictEqual(countPendingBackground(ate(5)), 1);
});
t('dois agents + um bash lançados, nenhum voltou → 2', () => {
  assert.strictEqual(countPendingBackground(ate(8)), 2);
});
t('queue-operation enqueue NÃO conclui (o Claude ainda vai acordar pra ler)', () => {
  assert.strictEqual(countPendingBackground(ate(10)), 2);
});
t('attachment queued_command com task-notification conclui', () => {
  assert.strictEqual(countPendingBackground(ate(11)), 1);
});
t('user string com <status>failed</status> conclui', () => {
  assert.strictEqual(countPendingBackground(ate(12)), 1);
});
t('tool_result que CITA a tag não conclui; status não-terminal também não', () => {
  assert.strictEqual(countPendingBackground(ate(14)), 1);
});
t('killed conclui', () => {
  const extra = '{"type":"user","message":{"role":"user","content":"<task-notification>\\n<task-id>agentCCC</task-id>\\n<status>killed</status>\\n</task-notification>"}}\n';
  assert.strictEqual(countPendingBackground(ate(14) + extra), 0);
});
t('aceita Buffer e ignora linha quebrada', () => {
  assert.strictEqual(countPendingBackground(Buffer.from(ate(3) + '{"toolUseResult":{"isAsync":tru')), 1);
});

// ── (b) hook → evento ────────────────────────────────────────────────────────
t('UserPromptSubmit → turn-start; PreToolUse → working', () => {
  assert.deepStrictEqual(eventFor({ hook_event_name: 'UserPromptSubmit' }, 's1'), { spawnId: 's1', kind: 'turn-start' });
  assert.deepStrictEqual(eventFor({ hook_event_name: 'PreToolUse' }, 's1'), { spawnId: 's1', kind: 'working' });
});
t('Notification: só permission_prompt vira needs-you; idle_prompt é ignorado', () => {
  assert.deepStrictEqual(eventFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, 's1'),
    { spawnId: 's1', kind: 'needs-you' });
  assert.strictEqual(eventFor({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, 's1'), null);
});
t('SubagentStop é ignorado', () => {
  assert.strictEqual(eventFor({ hook_event_name: 'SubagentStop', transcript_path: FIXTURE }, 's1'), null);
});
t('Stop com background pendente → bg-pending com a contagem', () => {
  assert.deepStrictEqual(eventFor({ hook_event_name: 'Stop', transcript_path: FIXTURE }, 's1'),
    { spawnId: 's1', kind: 'bg-pending', pending: 1 });
});
t('Stop sem background → turn-end com o tamanho do transcript (pro main conferir o que vem depois)', () => {
  const tmp = path.join(os.tmpdir(), `norya-hook-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, ate(2));
  try {
    const m = eventFor({ hook_event_name: 'Stop', transcript_path: tmp }, 's1');
    assert.deepStrictEqual(m, { spawnId: 's1', kind: 'turn-end', pending: 0, transcriptPath: tmp, transcriptSize: Buffer.byteLength(ate(2)) });
  } finally { fs.unlinkSync(tmp); }
});
t('Stop com transcript inexistente → turn-end (nunca trava o som por erro de leitura)', () => {
  const m = eventFor({ hook_event_name: 'Stop', transcript_path: '/nao/existe.jsonl' }, 's1');
  assert.strictEqual(m.kind, 'turn-end');
});

// ── (b2) atividade pro Mini/pet (2026-10-05) ────────────────────────────────
t('PreToolUse manda tool; Edit/Write/NotebookEdit/MultiEdit = 1 arquivo; WebSearch manda q', () => {
  assert.deepStrictEqual(eventFor({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, 's1'),
    { spawnId: 's1', kind: 'working', tool: 'Bash' });
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) {
    assert.deepStrictEqual(eventFor({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: '/a' } }, 's1'),
      { spawnId: 's1', kind: 'working', tool, files: 1 });
  }
  assert.deepStrictEqual(eventFor({ hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'x'.repeat(300) } }, 's1'),
    { spawnId: 's1', kind: 'working', tool: 'WebSearch', q: 'x'.repeat(120) });
  assert.deepStrictEqual(activityFor({}), {});
});
const asst = (...blocks) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } }) + '\n';
const txt = (text) => ({ type: 'text', text });
const tuse = { type: 'tool_use', id: 't', name: 'Bash', input: {} };
t('resumo: 1ª linha não vazia do ÚLTIMO texto do assistente, ≤ 140, sem markdown de ênfase', () => {
  const tr = '{"type":"user","message":{"role":"user","content":"oi"}}\n' + asst(txt('velho')) + asst(txt('\n\n**Pronto**, ajustei o arquivo.\nresto')) + asst(tuse);
  assert.strictEqual(lastAssistantSummary(tr), 'Pronto, ajustei o arquivo.');
  assert.strictEqual(lastAssistantSummary(asst(txt('a'.repeat(400)))).length, 140);
});
t('resumo: não vaza texto de um turno ANTERIOR (para no prompt do usuário); tool_result é pulado', () => {
  const tr = asst(txt('turno antigo')) + '{"type":"user","message":{"role":"user","content":"novo pedido"}}\n'
    + asst(tuse) + '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}\n';
  assert.strictEqual(lastAssistantSummary(tr), '');
  const tr2 = '{"type":"user","message":{"role":"user","content":"novo pedido"}}\n' + asst(txt('feito')) + '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}\n';
  assert.strictEqual(lastAssistantSummary(tr2), 'feito');
});
t('Stop sem background → turn-end com summary (do transcript, ou de last_assistant_message)', () => {
  const tmp = path.join(os.tmpdir(), `norya-hook-sum-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, '{"type":"user","message":{"role":"user","content":"x"}}\n' + asst(txt('Terminei a tarefa.')));
  try {
    assert.strictEqual(eventFor({ hook_event_name: 'Stop', transcript_path: tmp }, 's1').summary, 'Terminei a tarefa.');
    assert.strictEqual(eventFor({ hook_event_name: 'Stop', transcript_path: tmp, last_assistant_message: 'Direto do input\nlinha 2' }, 's1').summary, 'Direto do input');
    assert.strictEqual(eventFor({ hook_event_name: 'Stop', transcript_path: '/nao/existe.jsonl', last_assistant_message: 'ok' }, 's1').summary, 'ok');
  } finally { fs.unlinkSync(tmp); }
});

// ── (c) processo de verdade ──────────────────────────────────────────────────
function runHook(env, stdin) {
  return new Promise(res => {
    const t0 = Date.now();
    const p = execFile(process.execPath, [HELPER], { env, timeout: 5000 }, (err, stdout, stderr) => {
      res({ code: err ? (err.code ?? 1) : 0, stdout, stderr, ms: Date.now() - t0 });
    });
    p.stdin.end(stdin);
  });
}

(async () => {
  const sock = path.join(os.tmpdir(), `norya-hook-test-${process.pid}.sock`);
  try { fs.unlinkSync(sock); } catch {}
  const recebidas = [];
  const srv = net.createServer(c => {
    let b = '';
    c.on('data', d => { b += d; });
    c.on('end', () => b.split('\n').filter(Boolean).forEach(l => recebidas.push(JSON.parse(l))));
  });
  await new Promise(r => srv.listen(sock, r));
  const base = { PATH: process.env.PATH };

  await ta('processo: Stop com background manda bg-pending no socket, exit 0, stdout vazio', async () => {
    const r = await runHook({ ...base, NORYA_EVENT_SOCKET: sock, NORYA_SPAWN_ID: 'pane-7' },
      JSON.stringify({ hook_event_name: 'Stop', transcript_path: FIXTURE }));
    await new Promise(x => setTimeout(x, 50));
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stdout, '');
    assert.deepStrictEqual(recebidas.pop(), { spawnId: 'pane-7', kind: 'bg-pending', pending: 1 });
  });
  await ta('processo: sem NORYA_EVENT_SOCKET é no-op (exit 0, nada enviado)', async () => {
    const antes = recebidas.length;
    const r = await runHook({ ...base, NORYA_SPAWN_ID: 'pane-7' }, JSON.stringify({ hook_event_name: 'Stop' }));
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(recebidas.length, antes);
  });
  await ta('processo: stdin lixo e socket morto → exit 0 sem travar', async () => {
    const r1 = await runHook({ ...base, NORYA_EVENT_SOCKET: sock, NORYA_SPAWN_ID: 'p' }, 'isto não é json');
    const r2 = await runHook({ ...base, NORYA_EVENT_SOCKET: sock + '.morto', NORYA_SPAWN_ID: 'p' },
      JSON.stringify({ hook_event_name: 'UserPromptSubmit' }));
    assert.strictEqual(r1.code, 0);
    assert.strictEqual(r2.code, 0);
    assert.strictEqual(r1.stdout + r2.stdout, '');
    // Socket morto: sai na hora, sem esperar o teto de 1,5 s.
    assert.ok(r2.ms < 1400, `demorou ${r2.ms} ms`);
  });

  srv.close();
  try { fs.unlinkSync(sock); } catch {}
  console.log(`\nTUDO PASSOU (${n}/${n})`);
})().catch(e => { console.error('FALHOU:', e && e.stack || e); process.exit(1); });
