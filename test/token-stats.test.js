'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { normalize, consume, newState, parseFile, Collector, createTokenStatsService } = require('../token-stats');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-tokens-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const u = (input, output, cached = 0, reasoning = 0) => ({ input_tokens: input, output_tokens: output,
  cached_input_tokens: cached, reasoning_output_tokens: reasoning, total_tokens: input + output });
const meta = id => ({ type: 'session_meta', payload: { id } });
const model = name => ({ type: 'turn_context', payload: { model: name, turn_id: 'turn' } });
const count = (total, last = total, timestamp = '2026-09-10T14:00:00Z') => ({ type: 'event_msg', timestamp,
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const record = (id, usage, cumulative = usage, timestamp = '2026-09-10T14:00:00Z') => ({ type: 'token_usage_record', timestamp,
  payload: { response_id: id, thread_id: 's1', usage, thread_token_usage: cumulative } });
const claude = (id, output, timestamp = '2026-09-10T14:00:00Z') => ({ type: 'assistant', timestamp,
  sessionId: 'parent', requestId: 'req-' + id, message: { id, model: 'claude-opus-5', usage: {
    input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: output,
    output_tokens_details: { thinking_tokens: 3 } } } });
const write = (file, objects) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, objects.map(o => JSON.stringify(o)).join('\n') + '\n'); };
const parse = objects => { const s = newState('s1.jsonl', 'codex', 12); for (const o of objects) consume(s, o); return Object.values(s.events); };
const total = rows => rows.reduce((sum, r) => sum + r.tokens_used, 0);

test('Codex: cache and reasoning are already included; exact integer validation', () => {
  const b = normalize(u(100, 20, 80, 10), 'codex');
  assert.equal(b.total_tokens, 120); assert.equal(b.output_tokens, 20);
  assert.equal(normalize(u(-1, 20), 'codex'), null);
  assert.equal(normalize(u(1.5, 20), 'codex'), null);
  assert.equal(normalize(u(10, 20, 11), 'codex'), null);
});
test('Claude: streamed copies and final usage count once, with both cache types', () => {
  const s = newState('session.jsonl', 'claude', null);
  [claude('m1', 5), claude('m1', 25), claude('m1', 25), claude('m1', 5)].forEach(o => consume(s, o));
  assert.equal(total(Object.values(s.events)), 177);
  assert.equal(Object.values(s.events)[0]._breakdown.output_tokens, 25);
});
test('Claude: recover zeroed aggregate from iterations without doubling normal aggregate', () => {
  const part = { input_tokens: 32, output_tokens: 1443, cache_read_input_tokens: 477854, cache_creation_input_tokens: 5056 };
  const b = normalize({ input_tokens: 0, output_tokens: 0, output_tokens_details: { thinking_tokens: 950 }, iterations: [part] }, 'claude');
  assert.equal(b.total_tokens, 484385);
  assert.equal(normalize({ ...part, iterations: [part] }, 'claude').total_tokens, 484385);
});
test('Codex: repeated cumulative snapshots, model switch and date retain only deltas', () => {
  const rows = parse([meta('s1'), model('old'), count(u(100, 10)), count(u(100, 10)), model('new'), count(u(300, 30), u(200, 20), '2026-09-11T14:00:00Z')]);
  assert.equal(total(rows), 330); assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => [r.model, r.tokens_used]), [['old', 110], ['new', 220]]);
  assert.notEqual(rows[0].timestamp, rows[1].timestamp);
});
test('Codex: request records before OR after token_count are not doubled', () => {
  for (const pair of [[record('r1', u(100, 10)), count(u(100, 10))], [count(u(100, 10)), record('r1', u(100, 10))]]) {
    const rows = parse([meta('s1'), ...pair]); assert.equal(total(rows), 110); assert.equal(rows.length, 1);
  }
});
test('Codex: compaction changes context counter but keeps accurate request ledger', () => {
  const rows = parse([meta('s1'), record('r1', u(100, 10)), count(u(100, 10)),
    record('compact', u(30, 5), u(130, 15)), count(u(100, 10), { ...u(0, 0), total_tokens: 20 }),
    record('r2', u(50, 5), u(180, 20)), count(u(150, 15), u(50, 5), '2026-09-10T14:01:00Z'),
    record('r3', u(60, 6), u(240, 26)), count(u(210, 21), u(60, 6), '2026-09-10T14:02:00Z')]);
  assert.equal(total(rows), 266); assert.equal(rows.length, 4);
});
test('Codex: truncated beginning has an undated baseline, not all tokens today', () => {
  const rows = parse([meta('s1'), count(u(1000, 100), u(100, 10))]);
  assert.equal(total(rows), 1100);
  assert.equal(total(rows.filter(r => r.timestamp)), 110);
});
test('Parser: incremental UTF-8 / CRLF / partial final line and truncation', async () => {
  const file = path.join(tmp, 'incremental.jsonl');
  const first = JSON.stringify({ ...claude('a', 5), ignored: 'ação' });
  const second = JSON.stringify(claude('b', 10));
  fs.writeFileSync(file, first + '\r\n' + second.slice(0, 30));
  let s = await parseFile(file, 'claude', null);
  assert.equal(total(Object.values(s.events)), 157);
  fs.appendFileSync(file, second.slice(30) + '\r\n');
  s = await parseFile(file, 'claude', null, s);
  assert.equal(total(Object.values(s.events)), 319);
  assert.equal(s.offset, fs.statSync(file).size);
  write(file, [claude('c', 20)]);
  s = await parseFile(file, 'claude', null, s);
  assert.equal(total(Object.values(s.events)), 172);
});

const realHome = path.join(tmp, 'home');
const accountsDir = path.join(tmp, 'accounts');
const cachePath = path.join(tmp, 'index.json');
const options = { realHome, accountsDir, cachePath };
test('Collector: global, archived, isolated Claude, subagents, fork/adoption and cross-format aliases', async () => {
  const old = [meta('s1'), model('m'), count(u(100, 10))];
  write(path.join(realHome, '.codex/sessions/old.jsonl'), old);
  write(path.join(accountsDir, '12/.codex/archived_sessions/new.jsonl'), [...old, record('r1', u(100, 10))]);
  write(path.join(accountsDir, '14/.codex/sessions/fork.jsonl'), [meta('fork'), ...old.slice(1), count(u(200, 20), u(100, 10), '2026-09-11T14:00:00Z')]);
  write(path.join(realHome, '.claude/projects/p/parent.jsonl'), [claude('parent', 10)]);
  write(path.join(realHome, '.claude/projects/p/parent/subagents/agent-1.jsonl'), [claude('child', 20)]);
  write(path.join(accountsDir, '14/.claude/projects/p/copy.jsonl'), [claude('parent', 10)]);
  const r = await new Collector().collect(options);
  assert.equal(total(r.rows.filter(r => r.provider === 'codex')), 220);
  assert.equal(total(r.rows.filter(r => r.provider === 'claude')), 334);
  assert.equal(r.rows.find(r => r.key.includes('r1')).accountNum, null);
  assert.equal(r.coverage.errors.length, 0);
  const beforeMtime = fs.statSync(cachePath).mtimeMs;
  const warm = await new Collector().collect(options);
  assert.equal(fs.statSync(cachePath).mtimeMs, beforeMtime, 'unchanged logs must not rewrite a large index');
  assert.equal(total(warm.rows), total(r.rows));
  assert.ok(!fs.readFileSync(cachePath, 'utf8').includes('ignored'));
});
test('Custo: cache 1 h do Claude, fast do Codex/Claude e busca web chegam ao evento', () => {
  const st = newState('c.jsonl', 'claude', null);
  consume(st, { type: 'assistant', timestamp: '2026-10-04T01:00:00Z', requestId: 'q', message: { id: 'm', model: 'claude-opus-5', usage: {
    input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: 5, speed: 'fast',
    server_tool_use: { web_search_requests: 2 }, cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 } } } });
  const [c] = Object.values(st.events);
  assert.equal(c._breakdown.cache_write_1h_input_tokens, 40);
  assert.equal(c._breakdown.total_tokens, 116, '1 h é parte da gravação, não soma de novo');
  assert.equal(c.tier, 'fast'); assert.equal(c.web_search_requests, 2);
  const ev = parse([meta('s1'), model('gpt-6-astra'), record('a', u(10, 1)),
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } } },
    record('b', u(10, 1), u(20, 2)),
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'default' } } },
    record('c', u(10, 1), u(30, 3))]);
  assert.deepEqual(ev.map(e => e.tier || 'std'), ['std', 'fast', 'std']);
  assert.equal(normalize(u(10, 1), 'codex').cache_write_1h_input_tokens, undefined, 'Codex não ganha campo extra');
});
test('Collector: custo anexado e histórico de arquivo apagado preservado sem duplicar', async () => {
  const home = path.join(tmp, 'gone-home'), acc = path.join(tmp, 'gone-acc'), cache = path.join(tmp, 'gone.json');
  const f = path.join(acc, '9/.codex/sessions/x.jsonl');
  write(f, [meta('g1'), model('gpt-5.4'), record('g', u(1000, 100))]);
  const opts = { realHome: home, accountsDir: acc, cachePath: cache };
  const first = await new Collector().collect(opts);
  assert.equal(total(first.rows), 1100);
  assert.ok(first.rows[0].cost && first.rows[0].cost.total > 0, 'custo anexado');
  assert.equal(first.pricing.verifiedAt.length, 10);
  // Arquivo movido (arquivamento): mesmo conteúdo em outro lugar não duplica.
  const moved = path.join(acc, '9/.codex/archived_sessions/x.jsonl');
  fs.mkdirSync(path.dirname(moved), { recursive: true }); fs.renameSync(f, moved);
  const afterMove = await new Collector().collect(opts);
  assert.equal(total(afterMove.rows), 1100);
  // Perfil apagado: o consumo continua contado, marcado como preservado.
  fs.rmSync(path.join(acc, '9'), { recursive: true, force: true });
  const afterDelete = await new Collector().collect(opts);
  assert.equal(total(afterDelete.rows), 1100);
  assert.equal(afterDelete.rows[0].preserved, true);
  assert.equal(afterDelete.coverage.preservedFiles >= 1, true);
});
test('Collector: no 500-row/archive cap; DB-only tokens are undated and deduplicated', async () => {
  const db = path.join(realHome, '.codex/state_5.sqlite');
  const sql = 'CREATE TABLE threads (id TEXT, model TEXT, tokens_used INTEGER, archived INTEGER);' +
    Array.from({ length: 501 }, (_, i) => `INSERT INTO threads VALUES ('db-${i}','m',1,1);`).join('') +
    "INSERT INTO threads VALUES ('s1','m',110,0); INSERT INTO threads VALUES ('fork','m',220,0);";
  execFileSync('sqlite3', [db, sql]);
  const r = await new Collector().collect(options);
  const undated = r.rows.filter(r => r.source === 'database-only');
  assert.equal(undated.length, 501); assert.ok(undated.every(r => r.timestamp === null && r._breakdown === null));
  assert.equal(total(r.rows.filter(r => r.provider === 'codex')), 721);
});
test('OpenCode: provider/model retained; output plus separate reasoning counted once', async () => {
  const db = path.join(realHome, '.local/share/opencode/opencode.db'); fs.mkdirSync(path.dirname(db), { recursive: true });
  const data = { role: 'assistant', providerID: 'anthropic', modelID: 'claude', time: { completed: 1789060000000 }, tokens: {
    input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 50 } } };
  execFileSync('sqlite3', [db, `CREATE TABLE message (id TEXT,session_id TEXT,data TEXT); INSERT INTO message VALUES ('msg','session','${JSON.stringify(data)}');`]);
  const r = await new Collector().collect(options);
  const row = r.rows.find(r => r.provider === 'opencode');
  assert.equal(row.tokens_used, 185); assert.equal(row._breakdown.output_tokens, 25);
  assert.equal(row.model, 'anthropic / claude');
});
test('Worker: concurrent reads share one scan; manual refresh sees new live usage', async () => {
  const service = createTokenStatsService(options);
  try {
    const first = service.read(); assert.strictEqual(service.read({ force: true }), first);
    const r = await first;
    write(path.join(accountsDir, '14/.claude/projects/p/extra.jsonl'), [claude('extra', 30)]);
    const next = await service.read({ force: true }); assert.equal(total(next.rows) - total(r.rows), 182);
  } finally { await service.close(); }
});
(async () => {
  try { for (const [name, fn] of tests) { await fn(); console.log('PASS ' + name); } console.log(`${tests.length} tests passed`); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
