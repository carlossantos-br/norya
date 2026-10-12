#!/usr/bin/env node
/**
 * agents/agent-events.js — portão do turn-end do Claude + parse do socket.
 *
 * O Stop hook do Norya roda em paralelo com os do usuário; se um deles
 * bloquear (decision:block) o Claude continua. O main segura o turn-end por
 * 1,5 s e cancela se, nesse intervalo, chegar UserPromptSubmit/PreToolUse do
 * mesmo spawn — ou se o transcript mostrar que o Claude seguiu.
 *
 * Relógio falso: nada aqui espera de verdade. Uso: node test/claude-turn-gate.test.js
 */
const assert = require('assert');
const {
  parseEventLine, transcriptShowsContinuation, createClaudeTurnGate,
} = require('../agents/agent-events');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

// Timers falsos: `avancar(ms)` dispara o que venceu.
function relogio() {
  let agora = 0, seq = 0;
  const fila = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; fila.set(id, { fn, at: agora + ms }); return id; },
    clearTimeout: (id) => { fila.delete(id); },
    avancar(ms) {
      agora += ms;
      for (const [id, x] of [...fila].sort((a, b) => a[1].at - b[1].at)) {
        if (x.at <= agora) { fila.delete(id); x.fn(); }
      }
    },
  };
}

function montar(verify) {
  const r = relogio();
  const saida = [];
  const gate = createClaudeTurnGate({ deliver: m => saida.push(m), holdMs: 1500, verify, setTimeout: r.setTimeout, clearTimeout: r.clearTimeout });
  return { r, saida, gate, ev: (kind, extra) => gate.handle(Object.assign({ spawnId: 'p1', kind }, extra || {})) };
}
const kinds = s => s.map(m => m.kind);

// ── parseEventLine ───────────────────────────────────────────────────────────
t('parse aceita a linha do helper e descarta campo estranho', () => {
  const m = parseEventLine(JSON.stringify({ spawnId: 'p1', kind: 'turn-end', pending: 0, transcriptPath: '/x/a.jsonl', transcriptSize: 10, lixo: 1 }));
  assert.deepStrictEqual(m, { spawnId: 'p1', kind: 'turn-end', pending: 0, transcriptPath: '/x/a.jsonl', transcriptSize: 10 });
});
t('parse recusa kind desconhecido, JSON quebrado, spawnId ausente e transcript que não é .jsonl', () => {
  assert.strictEqual(parseEventLine('{"spawnId":"p","kind":"rm -rf"}'), null);
  assert.strictEqual(parseEventLine('{"spawnId":'), null);
  assert.strictEqual(parseEventLine('{"kind":"turn-end"}'), null);
  assert.strictEqual(parseEventLine('{"spawnId":"p","kind":"turn-end","transcriptPath":"/etc/passwd"}').transcriptPath, undefined);
});

// ── portão ───────────────────────────────────────────────────────────────────
t('turn-end sai depois de 1,5 s, não antes', () => {
  const { r, saida, ev } = montar();
  ev('turn-start'); ev('turn-end');
  r.avancar(1499);
  assert.deepStrictEqual(kinds(saida), ['turn-start']);
  r.avancar(1);
  assert.deepStrictEqual(kinds(saida), ['turn-start', 'turn-end']);
  assert.strictEqual(saida[1].turnId, saida[0].turnId, 'turn-end carrega o id do turno aberto');
});
t('PreToolUse dentro da janela cancela (Stop hook bloqueou e o Claude seguiu)', () => {
  const { r, saida, ev } = montar();
  ev('turn-start'); ev('turn-end');
  r.avancar(800); ev('working');
  r.avancar(5000);
  assert.deepStrictEqual(kinds(saida), ['turn-start', 'working']);
});
t('UserPromptSubmit dentro da janela cancela e abre turno novo', () => {
  const { r, saida, ev } = montar();
  ev('turn-start'); ev('turn-end');
  r.avancar(300); ev('turn-start');
  r.avancar(5000);
  assert.deepStrictEqual(kinds(saida), ['turn-start', 'turn-start']);
  assert.notStrictEqual(saida[0].turnId, saida[1].turnId);
});
t('verify (transcript mostra continuação) descarta o turn-end', () => {
  const { r, saida, ev } = montar(() => true);
  ev('turn-start'); ev('turn-end');
  r.avancar(2000);
  assert.deepStrictEqual(kinds(saida), ['turn-start']);
});
t('verify que lança não cala o som (falha de leitura ≠ continuação)', () => {
  const { r, saida, ev } = montar(() => { throw new Error('EACCES'); });
  ev('turn-start'); ev('turn-end');
  r.avancar(2000);
  assert.deepStrictEqual(kinds(saida), ['turn-start', 'turn-end']);
});
t('Stop repetido depois de um bloqueio cai no MESMO turnId (o renderer toca 1 vez só)', () => {
  const { r, saida, ev } = montar();
  ev('turn-start'); ev('turn-end'); r.avancar(1500);   // 1º Stop (hook bloqueou, mas tarde demais)
  ev('turn-end'); r.avancar(1500);                      // Stop final
  const ends = saida.filter(m => m.kind === 'turn-end');
  assert.strictEqual(ends.length, 2);
  assert.strictEqual(ends[0].turnId, ends[1].turnId);
});
t('bg-pending sai na hora, sem segurar, e cancela turn-end segurado', () => {
  const { r, saida, ev } = montar();
  ev('turn-start'); ev('turn-end'); ev('bg-pending', { pending: 2 });
  r.avancar(5000);
  assert.deepStrictEqual(kinds(saida), ['turn-start', 'bg-pending']);
  assert.strictEqual(saida[1].pending, 2);
});
t('<task-notification> retomada: UserPromptSubmit novo → turn-end do turno novo', () => {
  const { r, saida, ev } = montar();
  ev('turn-start'); ev('bg-pending', { pending: 1 });
  ev('turn-start'); ev('turn-end'); r.avancar(1500);
  assert.deepStrictEqual(kinds(saida), ['turn-start', 'bg-pending', 'turn-start', 'turn-end']);
  assert.strictEqual(saida[3].turnId, saida[2].turnId);
});
t('spawns não se misturam e forget() cancela o pendente', () => {
  const { r, saida, gate } = montar();
  gate.handle({ spawnId: 'a', kind: 'turn-end' });
  gate.handle({ spawnId: 'b', kind: 'turn-end' });
  gate.handle({ spawnId: 'a', kind: 'working' });   // só cancela o de 'a'
  gate.forget('x');                                  // inexistente: no-op
  r.avancar(1500);
  assert.deepStrictEqual(saida.filter(m => m.kind === 'turn-end').map(m => m.spawnId), ['b']);
  gate.handle({ spawnId: 'b', kind: 'turn-end' });
  gate.forget('b');
  r.avancar(5000);
  assert.strictEqual(saida.filter(m => m.kind === 'turn-end').length, 1);
});

// ── transcriptShowsContinuation ──────────────────────────────────────────────
t('continuação: hook_blocking_error do Stop ou assistant novo; hook_success não', () => {
  const ok = '{"type":"attachment","attachment":{"type":"hook_success","hookName":"Stop","hookEvent":"Stop"}}\n{"type":"last-prompt"}\n';
  const bloqueou = '{"type":"attachment","attachment":{"type":"hook_blocking_error","hookName":"Stop","hookEvent":"Stop","blockingError":"registre a sessão"}}\n';
  const falou = '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n';
  const outroBloqueio = '{"type":"attachment","attachment":{"type":"hook_blocking_error","hookName":"PreToolUse:Bash","hookEvent":"PreToolUse"}}\n';
  assert.strictEqual(transcriptShowsContinuation(ok), false);
  assert.strictEqual(transcriptShowsContinuation(ok + bloqueou), true);
  assert.strictEqual(transcriptShowsContinuation(falou), true);
  assert.strictEqual(transcriptShowsContinuation(outroBloqueio), false);
  assert.strictEqual(transcriptShowsContinuation(''), false);
});

t('atividade: working leva tool/files/q e turn-end leva summary (sem campo estranho)', () => {
  const { saida, ev, r } = montar();
  ev('turn-start');
  ev('working', { tool: 'Edit', files: 1, q: 'abc', lixo: 1 });
  ev('turn-end', { summary: 'Pronto.' });
  r.avancar(1500);
  assert.deepStrictEqual(saida[1], { spawnId: 'p1', kind: 'working', turnId: 'c1', tool: 'Edit', files: 1, q: 'abc' });
  assert.deepStrictEqual(saida[2], { spawnId: 'p1', kind: 'turn-end', turnId: 'c1', summary: 'Pronto.' });
});
t('parse: campos de atividade saneados; act inválido descartado; summary ≤ 140', () => {
  const m = parseEventLine(JSON.stringify({ spawnId: 'p', kind: 'working', tool: 'Bash', files: 1.7, q: 'q', summary: 's'.repeat(300) }));
  assert.deepStrictEqual([m.tool, m.files, m.q, m.summary.length], ['Bash', 1, 'q', 140]);
  const a = parseEventLine(JSON.stringify({ spawnId: 'p', kind: 'activity', act: 'edit', n: 3, text: 't', name: 'x' }));
  assert.deepStrictEqual([a.kind, a.act, a.n, a.text, a.name], ['activity', 'edit', 3, 't', 'x']);
  assert.strictEqual(parseEventLine(JSON.stringify({ spawnId: 'p', kind: 'activity', act: 'rm' })).act, undefined);
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
