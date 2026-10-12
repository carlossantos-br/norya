#!/usr/bin/env node
/**
 * Fim de turno do Codex lido do rollout .jsonl (2026-10-04).
 *
 * (1) createCodexRolloutParser — formato real conferido em rollouts do
 *     codex 0.160 (event_msg task_started/task_complete/turn_aborted com
 *     turn_id; function_call request_user_input_async; session_meta.source
 *     .subagent nos rollouts de subagente).
 * (2) createCodexTurnWatcher contra um CODEX_HOME temporário: qual rollout é
 *     de qual pane, leitura incremental, resume a partir do fim, subagente
 *     ignorado, remove() solta tudo.
 *
 * Sem Electron. Uso: node test/codex-turn-events.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodexRolloutParser } = require('../agents/agent-events');
const { createCodexTurnWatcher, dayDirs } = require('../agents/codex-turn-watch');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

const L = o => JSON.stringify(o) + '\n';
const meta = (id, cwd, extra) => L({ timestamp: new Date().toISOString(), type: 'session_meta', payload: Object.assign({ id, session_id: id, timestamp: new Date().toISOString(), cwd, source: 'cli', originator: 'codex-tui', cli_version: '0.160.0' }, extra || {}) });
const started = tid => L({ type: 'event_msg', payload: { type: 'task_started', turn_id: tid, started_at: 1 } });
const complete = tid => L({ type: 'event_msg', payload: { type: 'task_complete', turn_id: tid, last_agent_message: 'feito; task_complete citado no texto' } });
const aborted = tid => L({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: tid, reason: 'interrupted' } });
const ask = () => L({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', arguments: '{"questions":[]}', call_id: 'c1' } });
const ruido = () => L({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + L({ type: 'response_item', payload: { type: 'reasoning', summary: [] } });

// ── (1) parser ───────────────────────────────────────────────────────────────
t('task_started → turn-start; task_complete → turn-end com o turn_id', () => {
  const p = createCodexRolloutParser();
  const ev = p.feed(meta('s1', '/p') + started('T1') + ruido() + complete('T1'));
  assert.deepStrictEqual(ev, [{ kind: 'turn-start', turnId: 'T1' }, { kind: 'turn-end', turnId: 'T1' }]);
  assert.strictEqual(p.state.sessionId, 's1');
  assert.strictEqual(p.state.subagent, false);
});
t('task_complete repetido do mesmo turno sai 1 vez só', () => {
  const p = createCodexRolloutParser();
  assert.strictEqual(p.feed(started('T1') + complete('T1') + complete('T1')).filter(e => e.kind === 'turn-end').length, 1);
  assert.strictEqual(p.feed(complete('T1')).length, 0);
});
t('turn_aborted (Esc do usuário) não vira evento', () => {
  const p = createCodexRolloutParser();
  assert.deepStrictEqual(p.feed(started('T2') + aborted('T2')), [{ kind: 'turn-start', turnId: 'T2' }]);
});
t('request_user_input_async → needs-you no turno corrente', () => {
  const p = createCodexRolloutParser();
  const ev = p.feed(started('T3') + ask());
  assert.deepStrictEqual(ev[1], { kind: 'needs-you', turnId: 'T3' });
});
t('linha partida entre dois chunks é montada no próximo feed', () => {
  const p = createCodexRolloutParser();
  const s = started('T4') + complete('T4');
  const corte = s.length - 20;
  const a = p.feed(s.slice(0, corte));
  const b = p.feed(s.slice(corte));
  assert.deepStrictEqual(a.concat(b).map(e => e.kind), ['turn-start', 'turn-end']);
});
t('session_meta de subagente marca o parser', () => {
  const p = createCodexRolloutParser();
  p.feed(meta('sub', '/p', { source: { subagent: { thread_spawn: { parent_thread_id: 'x', depth: 1 } } } }));
  assert.strictEqual(p.state.subagent, true);
});

// ── (1b) atividade (Mini/pet, 2026-10-05) ───────────────────────────────────
const fcall = (name, args) => L({ type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args || {}), call_id: 'c' } });
const ccall = (name, input) => L({ type: 'response_item', payload: { type: 'custom_tool_call', name, input, call_id: 'c' } });
t('activity: exec_command/shell/local_shell/exec → cmd', () => {
  const p = createCodexRolloutParser();
  const ev = p.feed(started('A1') + fcall('exec_command', { cmd: 'ls' }) + fcall('shell') + fcall('local_shell') + ccall('exec', 'tools.exec_command({})'));
  assert.deepStrictEqual(ev.slice(1).map(e => [e.kind, e.act]), [['activity', 'cmd'], ['activity', 'cmd'], ['activity', 'cmd'], ['activity', 'cmd']]);
});
t('activity: apply_patch conta Update/Add/Delete File; mcp/outra function → tool + name', () => {
  const p = createCodexRolloutParser();
  const patch = '*** Begin Patch\n*** Update File: a.js\n@@\n*** Add File: b.js\n+x\n*** Delete File: c.js\n*** End Patch';
  const ev = p.feed(started('A2') + ccall('apply_patch', patch) + ccall('apply_patch', '*** Update File: z') + fcall('mcp__x__buscar'));
  assert.deepStrictEqual(ev[1], { kind: 'activity', act: 'edit', n: 3, turnId: 'A2' });
  assert.strictEqual(ev[2].n, 1);
  assert.deepStrictEqual(ev[3], { kind: 'activity', act: 'tool', name: 'mcp__x__buscar', turnId: 'A2' });
});
t('activity: web_search_call → search + q; reasoning → think (título ≤ 60); agent_message → msg (1ª linha ≤ 140)', () => {
  const p = createCodexRolloutParser();
  const ev = p.feed(started('A3')
    + L({ type: 'response_item', payload: { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'icp brasil', queries: ['x'] } } })
    + L({ type: 'response_item', payload: { type: 'web_search_call', action: { type: 'open_page' } } })
    + L({ type: 'event_msg', payload: { type: 'agent_reasoning', text: '**Analisando o pedido**\n\nvou ver' } })
    + L({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'sem titulo ' + 'x'.repeat(100) } })
    + L({ type: 'event_msg', payload: { type: 'agent_message', message: '\nVou levantar o estado.\nSegunda linha', phase: 'commentary' } }));
  assert.deepStrictEqual(ev[1], { kind: 'activity', act: 'search', q: 'icp brasil', turnId: 'A3' });
  assert.strictEqual(ev[2].q, undefined);
  assert.deepStrictEqual(ev[3], { kind: 'activity', act: 'think', text: 'Analisando o pedido', turnId: 'A3' });
  assert.ok(ev[4].text.length <= 60);
  assert.deepStrictEqual(ev[5], { kind: 'activity', act: 'msg', text: 'Vou levantar o estado.', turnId: 'A3' });
});
t('activity: *_output grande é ignorado sem parse e não vira evento', () => {
  const p = createCodexRolloutParser();
  assert.deepStrictEqual(p.feed(L({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(5000) } })
    + L({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'y' } })), []);
});

// ── (2) watcher ──────────────────────────────────────────────────────────────
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-codex-watch-'));
const DAY = dayDirs(path.join(HOME, 'sessions'), Date.now())[0];
fs.mkdirSync(DAY, { recursive: true });
const rollout = (id) => path.join(DAY, `rollout-2026-10-04T10-00-00-${id}.jsonl`);

function montar() {
  const saida = [];
  const w = createCodexTurnWatcher({ emit: e => saida.push(e), pollMs: 0 });
  return { w, saida };
}

try {
  // Rollout velho, de antes de qualquer spawn: nunca pode ser adotado.
  const velho = rollout('velho');
  fs.writeFileSync(velho, meta('velho', '/proj/a') + started('V1') + complete('V1'));
  const antigo = (Date.now() - 3600e3) / 1000;
  fs.utimesSync(velho, antigo, antigo);

  t('task nova: rollout que nasce depois do spawn é casado pelo cwd', () => {
    const { w, saida } = montar();
    w.add('paneA', { codexHome: HOME, cwd: '/proj/a' });
    w.add('paneB', { codexHome: HOME, cwd: '/proj/b' });
    fs.writeFileSync(rollout('sB'), meta('sB', '/proj/b') + started('B1'));
    w.pump();
    assert.deepStrictEqual(saida, [{ spawnId: 'paneB', kind: 'turn-start', turnId: 'B1' }]);
    // Leitura incremental: só o que foi acrescentado.
    fs.appendFileSync(rollout('sB'), ruido() + complete('B1'));
    w.pump();
    assert.deepStrictEqual(saida.slice(1), [{ spawnId: 'paneB', kind: 'turn-end', turnId: 'B1' }]);
    w.pump();
    assert.strictEqual(saida.length, 2, 'pump sem bytes novos não repete');
    assert.strictEqual(w._spawns.get('paneA').file, null, 'o rollout velho não foi adotado');
    w.stop();
  });

  t('rollout de subagente nunca é adotado', () => {
    const { w, saida } = montar();
    w.add('paneC', { codexHome: HOME, cwd: '/proj/c' });
    fs.writeFileSync(rollout('subC'), meta('subC', '/proj/c', { source: { subagent: { thread_spawn: { parent_thread_id: 'x' } } } }) + started('S1') + complete('S1'));
    w.pump();
    assert.deepStrictEqual(saida, []);
    assert.strictEqual(w._spawns.get('paneC').file, null);
    // O rollout do pane de verdade chega depois e é ele que conta.
    fs.writeFileSync(rollout('realC'), meta('realC', '/proj/c') + started('C1') + complete('C1'));
    w.pump();
    assert.deepStrictEqual(saida.map(e => e.kind), ['turn-start', 'turn-end']);
    w.stop();
  });

  t('empate (dois panes novos na mesma pasta): vai pro que recebeu tecla por último', () => {
    const { w, saida } = montar();
    w.add('d1', { codexHome: HOME, cwd: '/proj/d' });
    w.add('d2', { codexHome: HOME, cwd: '/proj/d' });
    w.noteInput('d2');
    fs.writeFileSync(rollout('sD'), meta('sD', '/proj/d') + started('D1'));
    w.pump();
    assert.deepStrictEqual(saida, [{ spawnId: 'd2', kind: 'turn-start', turnId: 'D1' }]);
    w.stop();
  });

  t('resume: acha o rollout pelo id e começa do FIM (histórico não vira som)', () => {
    const { w, saida } = montar();
    const f = rollout('sResume');
    fs.writeFileSync(f, meta('sResume', '/proj/e') + started('E1') + complete('E1'));
    w.add('paneE', { codexHome: HOME, cwd: '/proj/e', sessionId: 'sResume' });
    w.pump();
    assert.deepStrictEqual(saida, []);
    fs.appendFileSync(f, started('E2') + complete('E2'));
    w.pump();
    assert.deepStrictEqual(saida.map(e => `${e.spawnId}:${e.kind}:${e.turnId}`), ['paneE:turn-start:E2', 'paneE:turn-end:E2']);
    w.stop();
  });

  t('resume: entre "<pai>_<filho>.jsonl" e o próprio, fica com o que TERMINA no id', () => {
    const { w } = montar();
    const proprio = rollout('sFork');
    const filho = path.join(DAY, 'rollout-2026-10-04T11-00-00-sFork_sNeto.jsonl');
    fs.writeFileSync(proprio, meta('sFork', '/proj/h'));
    fs.writeFileSync(filho, meta('sNeto', '/proj/h'));
    w.add('paneH', { codexHome: HOME, cwd: '/proj/h', sessionId: 'sFork' });
    w.pump();
    assert.strictEqual(w._spawns.get('paneH').file, proprio);
    w.stop();
  });

  t('resume que abre arquivo NOVO para a mesma sessão troca o acompanhado', () => {
    const { w, saida } = montar();
    const antigo = rollout('sTroca');
    fs.writeFileSync(antigo, meta('sTroca', '/proj/i') + started('I1') + complete('I1'));
    w.add('paneI', { codexHome: HOME, cwd: '/proj/i', sessionId: 'sTroca' });
    w.pump();
    const novo = path.join(DAY, 'rollout-2026-10-04T12-00-00-sTroca-v2.jsonl');
    fs.writeFileSync(novo, meta('sTroca', '/proj/i') + started('I2') + complete('I2'));
    w.pump();
    assert.strictEqual(w._spawns.get('paneI').file, novo);
    assert.deepStrictEqual(saida.map(e => e.turnId), ['I2', 'I2']);
    w.stop();
  });

  t('remove() (PTY morreu) para de acompanhar e solta o watcher', () => {
    const { w, saida } = montar();
    w.add('paneF', { codexHome: HOME, cwd: '/proj/f' });
    fs.writeFileSync(rollout('sF'), meta('sF', '/proj/f') + started('F1'));
    w.pump();
    w.remove('paneF');
    fs.appendFileSync(rollout('sF'), complete('F1'));
    w.pump();
    assert.deepStrictEqual(saida.map(e => e.kind), ['turn-start']);
    assert.strictEqual(w._homes.size, 0);
    w.stop();
  });
} catch (e) {
  fs.rmSync(HOME, { recursive: true, force: true });
  throw e;
}

// fs.watch de verdade: sem pump manual, o watcher tem que acordar sozinho.
(async () => {
  const saida = [];
  const w = createCodexTurnWatcher({ emit: e => saida.push(e), pollMs: 0 });
  w.add('paneG', { codexHome: HOME, cwd: '/proj/g' });
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync(rollout('sG'), meta('sG', '/proj/g') + started('G1'));
  await new Promise(r => setTimeout(r, 300));
  fs.appendFileSync(rollout('sG'), complete('G1'));
  const ate = Date.now() + 4000;
  while (Date.now() < ate && saida.length < 2) await new Promise(r => setTimeout(r, 50));
  w.stop();
  fs.rmSync(HOME, { recursive: true, force: true });
  assert.deepStrictEqual(saida.map(e => e.kind), ['turn-start', 'turn-end'], 'fs.watch não entregou: ' + JSON.stringify(saida));
  console.log('PASS  fs.watch entrega turn-start e turn-end sem pump manual');
  n++;
  console.log(`\nTUDO PASSOU (${n}/${n})`);
})().catch(e => { console.error('FALHOU:', e && e.stack || e); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} process.exit(1); });
