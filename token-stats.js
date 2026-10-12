'use strict';

// Local usage ledger. Provider logs are authoritative for recorded token counts;
// subscription percentages, text length and price tables are never token sources.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 test runner: sqlite3 fallback */ }
const { Worker, isMainThread, parentPort } = require('worker_threads');
const pricing = require('./pricing');
// v3 (2026-10-04): escrita de cache 1 h do Claude, tier fast e buscas web por
// resposta (para o custo de API) + histórico de arquivos apagados preservado.
const VERSION = 3;
const FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const integer = n => Number.isSafeInteger(n) && n >= 0;
const zero = () => Object.fromEntries(FIELDS.map(k => [k, 0]));
const hash = value => createHash('sha256').update(value).digest('hex');

function normalize(usage, provider) {
  if (!usage || !integer(usage.input_tokens) || !integer(usage.output_tokens)) return null;
  // Some Claude transcripts zero the outer counters after server-side work,
  // while retaining the measured per-iteration usage. Recover only this explicit
  // all-zero case; never add iterations on top of the outer aggregate.
  if (provider === 'claude' && usage.input_tokens === 0 && usage.output_tokens === 0 &&
      !usage.cache_read_input_tokens && !usage.cache_creation_input_tokens && usage.iterations?.length) {
    const parts = usage.iterations.map(part => normalize(part, 'claude'));
    if (parts.every(Boolean)) {
      usage = { ...usage, input_tokens: parts.reduce((s, p) => s + p.input_tokens - p.cached_input_tokens - p.cache_write_input_tokens, 0),
        output_tokens: parts.reduce((s, p) => s + p.output_tokens, 0),
        cache_read_input_tokens: parts.reduce((s, p) => s + p.cached_input_tokens, 0),
        cache_creation_input_tokens: parts.reduce((s, p) => s + p.cache_write_input_tokens, 0),
        cache_creation: { ephemeral_1h_input_tokens: parts.reduce((s, p) => s + (p.cache_write_1h_input_tokens || 0), 0) } };
    }
  }
  const out = zero();
  for (const k of FIELDS) {
    if (usage[k] != null && !integer(usage[k])) return null;
    out[k] = usage[k] || 0;
  }
  if (provider === 'claude') {
    for (const k of ['cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (usage[k] != null && !integer(usage[k])) return null;
    }
    out.cached_input_tokens = usage.cache_read_input_tokens || 0;
    out.cache_write_input_tokens = usage.cache_creation_input_tokens || 0;
    out.input_tokens += out.cached_input_tokens + out.cache_write_input_tokens;
    out.reasoning_output_tokens = usage.output_tokens_details?.thinking_tokens || 0;
  }
  if (usage.total_tokens == null || provider === 'claude') out.total_tokens = out.input_tokens + out.output_tokens;
  // Cache is a subset of input; reasoning is a subset of output.
  if (out.total_tokens !== out.input_tokens + out.output_tokens ||
      out.cached_input_tokens + out.cache_write_input_tokens > out.input_tokens ||
      !integer(out.reasoning_output_tokens) || out.reasoning_output_tokens > out.output_tokens ||
      FIELDS.some(k => !integer(out[k]))) return null;
  // Escrita de cache de 1 h custa 2× a entrada (5 min: 1,25×); o total acima não
  // muda. Campo extra só no Claude: o Codex compara breakdowns por JSON.
  const w1h = provider === 'claude' ? usage.cache_creation?.ephemeral_1h_input_tokens : null;
  if (integer(w1h) && w1h > 0) out.cache_write_1h_input_tokens = Math.min(w1h, out.cache_write_input_tokens);
  return out;
}

function newState(file, provider, accountNum) {
  return { provider, accountNum, session: path.basename(file, '.jsonl'), model: null, turn: null,
    previous: null, events: {}, issues: 0, offset: 0, lastCountKey: null, lastRecordKey: null };
}
function stamp(value) {
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function event(state, key, usage, timestamp, extra = {}) {
  return { key, id: state.session, provider: state.provider, accountNum: state.accountNum,
    model: state.model || 'Modelo não informado', timestamp: stamp(timestamp),
    tokens_used: usage.total_tokens, _breakdown: usage,
    ...(state.tier === 'fast' ? { tier: 'fast' } : {}), ...extra };
}
function consume(state, obj) {
  const p = obj.payload || {};
  if (state.provider === 'claude') {
    if (obj.type !== 'assistant' || !obj.message?.usage || obj.message.model === '<synthetic>') return;
    const m = obj.message;
    const u = normalize(m.usage, 'claude');
    if (!u || !m.id) { state.issues++; return; }
    state.model = m.model;
    // Subagents have their own transcript even when sessionId is their parent's.
    const key = `claude:${m.id}:${obj.requestId || ''}`;
    const prev = state.events[key];
    if (!prev || u.total_tokens >= prev.tokens_used) {
      const extra = {};
      if (m.usage.speed === 'fast') extra.tier = 'fast';
      const searches = m.usage.server_tool_use?.web_search_requests;
      if (integer(searches) && searches > 0) extra.web_search_requests = searches;
      state.events[key] = event(state, key, u, prev?.timestamp || obj.timestamp, extra);
    }
    return;
  }
  if (obj.type === 'session_meta') { state.session = p.id || state.session; return; }
  if (obj.type === 'turn_context') { state.model = p.model || state.model; state.turn = p.turn_id || null; return; }
  // Fast mode do Codex (service_tier "priority") só aparece aqui, valendo dali
  // em diante. Sessões anteriores a esse evento ficam no tier padrão.
  if (obj.type === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings) {
    if (p.thread_settings.service_tier) state.tier = p.thread_settings.service_tier === 'priority' ? 'fast' : null;
    return;
  }
  if (obj.type === 'token_usage_record' && p.usage) {
    const u = normalize(p.usage, 'codex');
    if (!u || !p.response_id) { state.issues++; return; }
    const cumulative = normalize(p.thread_token_usage, 'codex');
    const last = state.events[state.lastCountKey];
    // New CLI emits both token_count and token_usage_record for one response.
    if (last && cumulative && last.cumulative === JSON.stringify(cumulative)) delete state.events[state.lastCountKey];
    const key = `codex:response:${p.response_id}`;
    state.events[key] = event(state, key, u, obj.timestamp, { id: p.thread_id || state.session,
      countKey: last && cumulative && last.cumulative === JSON.stringify(cumulative) ? last.key : null });
    state.lastCountKey = null;
    state.lastRecordKey = key;
    return;
  }
  if (obj.type !== 'event_msg' || p.type !== 'token_count' || !p.info) return;
  const total = normalize(p.info.total_token_usage, 'codex');
  const lastUsage = normalize(p.info.last_token_usage, 'codex');
  if (!total) { state.issues++; return; }
  const prev = state.previous;
  state.previous = total;
  if (prev && FIELDS.every(k => total[k] === prev[k])) return; // quota-only repeat
  const countKey = 'codex:count:' + hash(JSON.stringify([obj.timestamp, state.turn, total]));
  const record = state.events[state.lastRecordKey];
  if (record && lastUsage && JSON.stringify(record._breakdown) === JSON.stringify(lastUsage)) {
    // Request ledger and context counters diverge after compaction. They must
    // have independent cumulative baselines; match the actual request usage.
    record.countKey = countKey;
    state.lastRecordKey = null;
    state.lastCountKey = null;
    return;
  }
  let delta = zero();
  if (!prev) {
    // A transcript can start after earlier usage. Its baseline has no known date.
    if (lastUsage && total.total_tokens > lastUsage.total_tokens) {
      const baseline = Object.fromEntries(FIELDS.map(k => [k, total[k] - lastUsage[k]]));
      const b = normalize(baseline, 'codex');
      if (b) {
        const key = `codex:baseline:${state.session}`;
        state.events[key] = event(state, key, b, null, { model: 'Modelo não informado (histórico)' });
        delta = lastUsage;
      } else { state.issues++; delta = total; }
    } else delta = total;
  } else if (FIELDS.some(k => total[k] < prev[k])) {
    // Compaction/resume can reset cumulative counters. Preserve prior requests.
    if (!lastUsage) { state.issues++; return; }
    delta = lastUsage;
    state.issues++;
  } else delta = Object.fromEntries(FIELDS.map(k => [k, total[k] - prev[k]]));
  const u = normalize(delta, 'codex');
  if (!u) { state.issues++; return; }
  if (!u.total_tokens) return;
  // Copied/adopted/forked histories preserve timestamps and counters. Do not count
  // them twice, even if their containing file's session/account has changed.
  const key = countKey;
  state.events[key] = event(state, key, u, obj.timestamp, { cumulative: JSON.stringify(total) });
  state.lastCountKey = key;
}

async function parseFile(file, provider, accountNum, cached) {
  const stat = await fs.promises.stat(file);
  if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs && cached.ino === stat.ino) return cached;
  // Append-only logs: reread from the last complete newline. An incomplete final
  // JSON record is retried on the next refresh, never permanently dropped.
  const append = cached && cached.ino === stat.ino && stat.size > cached.size;
  const state = append ? cached : newState(file, provider, accountNum);
  const start = state.offset;
  if (stat.size > start) {
    const input = fs.createReadStream(file, { start, end: stat.size - 1, encoding: 'utf8' });
    let pendingLine = '';
    try {
      for await (const chunk of input) {
        pendingLine += chunk;
        let newline;
        while ((newline = pendingLine.indexOf('\n')) !== -1) {
          const line = pendingLine.slice(0, newline);
          pendingLine = pendingLine.slice(newline + 1);
          try { if (line.trim()) consume(state, JSON.parse(line)); } catch { state.issues++; }
          state.offset += Buffer.byteLength(line) + 1;
        }
      }
    } finally { input.destroy(); }
  }
  state.size = stat.size; state.mtime = stat.mtimeMs; state.ino = stat.ino;
  return state;
}

async function walk(root, visit, errors) {
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch (e) { if (e.code !== 'ENOENT') errors.push({ source: root, kind: e.code || 'read' }); return; }
  for (const ent of entries) {
    const file = path.join(root, ent.name);
    if (ent.isDirectory()) await walk(file, visit, errors);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) await visit(file);
  }
}
function sqlite(file, sql) {
  if (DatabaseSync) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout=2500'); return db.prepare(sql).all(); }
    finally { db.close(); }
  }
  return JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', file, sql], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }) || '[]');
}

class Collector {
  constructor() { this.files = {}; this.loaded = false; }
  async collect({ realHome, accountsDir, cachePath }) {
    const errors = [];
    let dirty = false;
    if (!this.loaded && cachePath) {
      try { const saved = JSON.parse(await fs.promises.readFile(cachePath, 'utf8')); if (saved.version === VERSION) this.files = saved.files; } catch {}
      this.loaded = true;
    }
    const homes = [{ dir: realHome, accountNum: null }];
    try {
      for (const n of (await fs.promises.readdir(accountsDir)).sort((a, b) => Number(a) - Number(b))) {
        if (/^\d+$/.test(n)) homes.push({ dir: path.join(accountsDir, n), accountNum: Number(n) });
      }
    } catch (e) { if (e.code !== 'ENOENT') errors.push({ source: accountsDir, kind: e.code }); }
    const found = new Set();
    const events = new Map();
    const sessions = new Set();
    const measuredSessions = new Set();
    let issues = 0, duplicates = 0;
    const add = e => {
      const prev = events.get(e.key);
      if (prev) {
        duplicates++;
        const best = e.tokens_used > prev.tokens_used ? e : prev;
        // Files show storage location, not historical billing ownership. Copies
        // across homes are explicitly unassigned, never attributed to current owner.
        events.set(e.key, { ...best, accountNum: prev.accountNum === e.accountNum ? e.accountNum : null });
      } else events.set(e.key, e);
    };
    for (const home of homes) {
      for (const [provider, roots] of [
        ['codex', ['.codex/sessions', '.codex/archived_sessions']],
        ['claude', ['.claude/projects']],
      ]) {
        for (const rel of roots) await walk(path.join(home.dir, rel), async file => {
          try {
            const canonical = await fs.promises.realpath(file);
            if (found.has(canonical)) return;
            found.add(canonical);
            const before = this.files[canonical];
            const beforeSignature = before && `${before.size}:${before.mtime}:${before.ino}`;
            const parsed = await parseFile(canonical, provider, home.accountNum, this.files[canonical]);
            this.files[canonical] = parsed;
            if (beforeSignature !== `${parsed.size}:${parsed.mtime}:${parsed.ino}`) dirty = true;
            sessions.add(`${provider}:${parsed.session}`);
            issues += parsed.issues;
            if (Object.keys(parsed.events).length) measuredSessions.add(`${provider}:${parsed.session}`);
            for (const e of Object.values(parsed.events)) add(e);
          } catch (e) { errors.push({ source: file, kind: e.code || 'parse' }); }
        }, errors);
      }
      // OpenCode records providerID alongside modelID: retain it in the UI.
      const db = path.join(home.dir, '.local/share/opencode/opencode.db');
      if (fs.existsSync(db)) try {
        for (const row of sqlite(db, 'SELECT id,session_id,data FROM message')) {
          const data = JSON.parse(row.data);
          if (data.role !== 'assistant' || !data.tokens) continue;
          const t = data.tokens;
          const input = t.input + (t.cache?.read || 0) + (t.cache?.write || 0);
          const u = normalize({ input_tokens: input, cached_input_tokens: t.cache?.read || 0,
            cache_write_input_tokens: t.cache?.write || 0, output_tokens: t.output + (t.reasoning || 0),
            reasoning_output_tokens: t.reasoning || 0 }, 'opencode');
          if (!u) { issues++; continue; }
          const state = { provider: 'opencode', accountNum: home.accountNum, session: row.session_id,
            model: [data.providerID, data.modelID].filter(Boolean).join(' / ') };
          add(event(state, `opencode:${row.id}`, u, data.time?.completed || data.time?.created));
        }
      } catch (e) { errors.push({ source: db, kind: 'sqlite' }); }
    }
    // Arquivo que sumiu (perfil apagado, limpeza do CLI) leva junto um consumo
    // que aconteceu. Guarda só os eventos e continua contando; se o conteúdo
    // apenas mudou de lugar (Codex arquivando), as chaves coincidem e o evento
    // não entra duas vezes.
    let preservedFiles = 0;
    for (const [file, entry] of Object.entries(this.files)) {
      if (found.has(file)) continue;
      if (!entry.gone) {
        if (!Object.keys(entry.events || {}).length) { delete this.files[file]; dirty = true; continue; }
        this.files[file] = { gone: true, provider: entry.provider, session: entry.session, events: entry.events };
        dirty = true;
      }
      let used = false;
      for (const e of Object.values(this.files[file].events)) {
        if (events.has(e.key)) continue;
        events.set(e.key, { ...e, preserved: true });
        used = true;
      }
      if (used) preservedFiles++;
    }
    // A copied older log may contain only token_count while a newer copy has
    // the response ledger too. Collapse their aliases across file boundaries.
    for (const e of [...events.values()]) {
      if (!e.countKey || !events.has(e.countKey)) continue;
      const old = events.get(e.countKey);
      events.delete(e.countKey);
      if (old.accountNum !== e.accountNum) e.accountNum = null;
      duplicates++;
    }
    // DB-only history is useful, but cannot be allocated to a day or decomposed.
    // Never add a DB total on top of a session's request-level records.
    const dbRows = new Map();
    const measured = new Set([...events.values()].filter(e => e.provider === 'codex').map(e => e.id));
    for (const home of homes) {
      const db = path.join(home.dir, '.codex/state_5.sqlite');
      if (!fs.existsSync(db)) continue;
      try {
        for (const r of sqlite(db, 'SELECT id,model,tokens_used FROM threads WHERE tokens_used>0')) {
          if (measured.has(r.id) || measuredSessions.has(`codex:${r.id}`)) continue;
          const prev = dbRows.get(r.id);
          if (!prev) dbRows.set(r.id, { ...r, accountNum: home.accountNum });
          else dbRows.set(r.id, { ...(r.tokens_used > prev.tokens_used ? r : prev),
            accountNum: prev.accountNum === home.accountNum ? home.accountNum : null });
        }
      } catch { errors.push({ source: db, kind: 'sqlite' }); }
    }
    for (const r of dbRows.values()) {
      if (!integer(r.tokens_used)) { issues++; continue; }
      add({ ...r, key: `codex:db:${r.id}`, provider: 'codex', timestamp: null, _breakdown: null, source: 'database-only' });
    }
    if (cachePath && dirty) try {
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify({ version: VERSION, files: this.files }), { mode: 0o600 });
      await fs.promises.rename(tmp, cachePath);
    } catch { errors.push({ source: 'usage-index', kind: 'cache-write' }); }
    return { version: VERSION, rows: [...events.values()].map(({ cumulative, countKey, ...e }) => ({ ...e, cost: pricing.priceEvent(e) })),
      updatedAt: Date.now(), coverage: { files: found.size, sessions: sessions.size, duplicates, issues, errors,
        undated: [...events.values()].filter(e => !e.timestamp).length, preservedFiles },
      pricing: { verifiedAt: pricing.VERIFIED_AT, sources: pricing.SOURCES, longContext: pricing.LONG_CONTEXT, table: pricing.priceTable() },
      providers: [
        { id: 'codex', label: 'Codex', supported: true },
        { id: 'claude', label: 'Claude Code', supported: true },
        { id: 'opencode', label: 'OpenCode', supported: true },
        { id: 'grok', label: 'Grok Build', supported: false, reason: 'Sem coletor de tokens verificável nesta versão.' },
        { id: 'aider', label: 'OpenRouter / Aider', supported: false, reason: 'O histórico atual não registra contadores exatos por resposta.' },
      ] };
  }
}

// Leveza (2026-10-03): o worker segura o índice inteiro parseado (o JSON tem
// ~16 MB em disco, várias vezes isso em heap) e o resultado fica em `cached`.
// Antes os dois viviam até o quit depois de UMA visita à aba de estatísticas.
// Agora morrem após IDLE_MS sem leitura; a próxima visita relê o índice do
// disco (centenas de ms) — trocar isso por dezenas de MB parados é barato.
const IDLE_MS = 90 * 1000;

function createTokenStatsService(options) {
  let worker = null, pending = null, cached = null, cachedAt = 0, idle = null;
  const invalidate = () => { cachedAt = 0; };
  const release = () => {
    if (pending) { idle = setTimeout(release, IDLE_MS); idle.unref?.(); return; }
    idle = null; worker?.terminate(); worker = null; cached = null;
  };
  const read = ({ force = false } = {}) => {
    clearTimeout(idle);
    idle = setTimeout(release, IDLE_MS);
    idle.unref?.();
    if (pending) return pending;
    if (!force && cached && Date.now() - cachedAt < 15000) return Promise.resolve(cached);
    if (!worker) { worker = new Worker(__filename); worker.unref(); }
    pending = new Promise((resolve, reject) => {
      const active = worker;
      const cleanup = () => { clearTimeout(timer); active.removeListener('message', message); active.removeListener('error', fail); active.removeListener('exit', exited); pending = null; };
      const fail = e => { cleanup(); worker = null; active.terminate(); reject(e); };
      const exited = code => fail(new Error(`Coletor de tokens encerrou (${code})`));
      const message = msg => {
        cleanup();
        if (msg.error) { reject(new Error(msg.error)); return; }
        cached = msg; cachedAt = Date.now(); resolve(msg);
      };
      const timer = setTimeout(() => fail(new Error('A leitura do histórico excedeu 120 segundos. Tente atualizar novamente.')), 120000);
      active.once('message', message); active.once('error', fail); active.once('exit', exited);
      active.postMessage(options);
    });
    return pending;
  };
  return { read, invalidate, close: () => { clearTimeout(idle); worker?.terminate(); } };
}
if (!isMainThread) {
  const collector = new Collector();
  parentPort.on('message', async options => {
    try { parentPort.postMessage(await collector.collect(options)); }
    catch (e) { parentPort.postMessage({ error: e.message }); }
  });
}
module.exports = { normalize, consume, newState, parseFile, Collector, createTokenStatsService };
