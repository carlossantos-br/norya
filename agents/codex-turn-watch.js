'use strict';

/**
 * agents/codex-turn-watch.js — fim de turno do Codex lido do rollout (2026-10-04).
 *
 * O Codex não tem hook confiável aqui (os hooks.json dos perfis estão
 * "untrusted"), mas grava TUDO no rollout <CODEX_HOME>/sessions/AAAA/MM/DD/
 * rollout-*.jsonl: task_started / task_complete com turn_id. Este módulo
 * acompanha o rollout de cada pane (fs.watch + leitura incremental por offset)
 * e emite turn-start / turn-end / needs-you pelo parser de agent-events.js.
 *
 * Qual rollout é de qual pane:
 *   - resume: o sessionId está no NOME do arquivo — exato;
 *   - task nova: o arquivo nasce depois do spawn. Casa pelo cwd do
 *     session_meta entre os panes de Codex ainda sem rollout no mesmo
 *     CODEX_HOME; empate (dois panes novos na mesma pasta e perfil) vai pro
 *     pane que recebeu tecla por último — quem apertou Enter criou a sessão.
 * Rollout de subagente (session_meta.source.subagent) é ignorado: o turno dele
 * não é o turno do pane.
 *
 * O fs.watch acorda rápido; um poll de segurança cobre o que ele perder
 * (FSEvents coalesce eventos, e o diretório do dia pode nem existir no spawn).
 */

const nodeFs = require('fs');
const nodePath = require('path');
const { createCodexRolloutParser } = require('./agent-events');
const defaultPlatform = require('../platform');

const READ_CAP = 8 * 1024 * 1024;   // por pump; o resto vem no próximo

function pad(n) { return String(n).padStart(2, '0'); }

/** Diretórios de dia que podem receber um rollout novo (hoje e ontem, hora local). */
function dayDirs(sessionsDir, now, path = nodePath) {
  const out = [];
  for (const delta of [0, -1]) {
    const d = new Date(now + delta * 86400000);
    out.push(path.join(sessionsDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  }
  return out;
}

/** Primeira linha do arquivo (session_meta), ou null se ainda não terminou de ser escrita. */
function readFirstLine(fs, file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl < 0) return null;
    return buf.toString('utf8', 0, nl);
  } catch { return null; }
  finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

// `plat` (platform.js) decide a comparação: no Windows sem diferenciar
// maiúsculas e aceitando as duas barras — o codex grava o cwd como o Windows
// devolve (`C:\Dev\app`), o Norya pode ter recebido `c:\dev\app` do seletor.
function samePath(a, b, path, fs, plat = defaultPlatform) {
  if (!a || !b) return false;
  const norm = p => plat.pathKey(path.resolve(p));
  if (norm(a) === norm(b)) return true;
  // /tmp vs /private/tmp e afins: o Codex grava o cwd já resolvido.
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

/**
 * @param {object} o
 * @param {(ev:{spawnId:string, kind:string, turnId?:string})=>void} o.emit
 * @param {Function} [o.log]
 * @param {number} [o.pollMs=1500]
 */
function createCodexTurnWatcher(o) {
  const fs = o.fs || nodeFs;
  const path = o.path || nodePath;
  const plat = o.platform || defaultPlatform;
  const emit = o.emit;
  const log = o.log || (() => {});
  const now = o.now || Date.now;
  const pollMs = o.pollMs == null ? 1500 : o.pollMs;

  /** @type {Map<string, {home:string, cwd:string|null, sessionId:string|null, startedAt:number, lastInputAt:number, file:string|null, offset:number, parser:any, resumeLookup:boolean}>} */
  const spawns = new Map();
  /** @type {Map<string, {watcher:any, known:Map<string,string>}>} */
  const homes = new Map();
  let pollTimer = null;
  let pumpTimer = null;

  function sessionsDir(home) { return path.join(home, 'sessions'); }

  function ensureHome(home) {
    let h = homes.get(home);
    if (!h) { h = { watcher: null, known: new Map() }; homes.set(home, h); }
    if (!h.watcher) {
      try {
        h.watcher = fs.watch(sessionsDir(home), { recursive: true }, () => schedulePump());
        h.watcher.on('error', () => { try { h.watcher.close(); } catch {} h.watcher = null; });
      } catch { h.watcher = null; }   // sessions/ ainda não existe: o poll tenta de novo
    }
    return h;
  }

  function schedulePump() {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, 80);
  }

  function add(id, info) {
    remove(id);
    const s = {
      home: info.codexHome, cwd: info.cwd || null, sessionId: info.sessionId || null,
      startedAt: now(), lastInputAt: 0, file: null, offset: 0,
      parser: createCodexRolloutParser(), resumeLookup: !!info.sessionId,
    };
    spawns.set(id, s);
    ensureHome(s.home);
    if (!pollTimer && pollMs > 0) {
      pollTimer = setInterval(pump, pollMs);
      if (pollTimer.unref) pollTimer.unref();
    }
    schedulePump();
  }

  function remove(id) {
    const s = spawns.get(id);
    if (!s) return;
    spawns.delete(id);
    const h = homes.get(s.home);
    if (h && s.file) h.known.set(s.file, 'gone');
    // Ninguém mais acompanha este CODEX_HOME: solta o watcher.
    if (h && ![...spawns.values()].some(x => x.home === s.home)) {
      try { h.watcher && h.watcher.close(); } catch {}
      homes.delete(s.home);
    }
    if (!spawns.size && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function noteInput(id) {
    const s = spawns.get(id);
    if (s) s.lastInputAt = now();
  }

  function bind(id, s, file, offset) {
    s.file = file;
    s.offset = offset;
    const h = ensureHome(s.home);
    h.known.set(file, id);
    log('codex-turn', `spawn=${id} rollout=${path.basename(file)} offset=${offset}`);
  }

  // Resume: o sessionId está no nome do arquivo. Começa do FIM — o histórico
  // já aconteceu, não pode virar som.
  function lookupResume(id, s) {
    s.resumeLookup = false;
    const alvo = String(s.sessionId).toLowerCase();
    const achados = [];
    const walk = (d, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.toLowerCase().includes(alvo)) achados.push(p);
      }
    };
    walk(sessionsDir(s.home), 0);
    if (!achados.length) return;
    // Fork/compactação nomeia "rollout-…-<pai>_<filho>.jsonl": o id no FIM do
    // nome é o desta sessão; entre iguais, o mais recente.
    const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
    achados.sort((a, b) => (Number(b.toLowerCase().endsWith(alvo + '.jsonl')) - Number(a.toLowerCase().endsWith(alvo + '.jsonl')))
      || (mtime(b) - mtime(a)));
    const file = achados[0];
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    bind(id, s, file, size);
  }

  // Arquivo novo num CODEX_HOME acompanhado: de quem é?
  function claim(home, file) {
    const h = homes.get(home);
    if (!h || h.known.has(file)) return;
    const first = readFirstLine(fs, file);
    if (first == null) return;   // session_meta ainda sendo escrito: próximo pump
    let meta = null;
    try { const o = JSON.parse(first); if (o.type === 'session_meta') meta = o.payload || {}; } catch {}
    if (!meta) { h.known.set(file, 'other'); return; }
    if (meta.source && typeof meta.source === 'object' && meta.source.subagent) { h.known.set(file, 'subagent'); return; }

    // 1) id exato: resume cujo rollout ainda não existia, ou um resume que
    //    abriu arquivo novo para a mesma sessão (troca o acompanhado).
    const mesmaSessao = [...spawns.entries()].find(([, s]) => s.home === home && s.sessionId && meta.id
      && String(meta.id).toLowerCase() === String(s.sessionId).toLowerCase());
    if (mesmaSessao) {
      if (mesmaSessao[1].file) h.known.set(mesmaSessao[1].file, 'gone');
      mesmaSessao[1].parser = createCodexRolloutParser();
      bind(mesmaSessao[0], mesmaSessao[1], file, 0);
      return;
    }
    // 2) task nova: mesma pasta, ainda sem rollout; empate → última tecla,
    //    depois o spawn mais antigo.
    const metaTs = Date.parse(meta.timestamp || '') || now();
    const cands = [...spawns.entries()].filter(([, s]) => s.home === home && !s.file && !s.sessionId
      && samePath(s.cwd, meta.cwd, path, fs, plat) && s.startedAt <= metaTs + 5000);
    cands.sort((a, b) => (b[1].lastInputAt - a[1].lastInputAt) || (a[1].startedAt - b[1].startedAt));
    const alvo = cands[0];
    if (!alvo) { h.known.set(file, 'other'); return; }
    bind(alvo[0], alvo[1], file, 0);
  }

  function discover(home) {
    const h = homes.get(home);
    if (!h) return;
    // Só procura arquivo novo enquanto há pane esperando um: task nova sem
    // rollout ou resume (que pode ganhar arquivo novo para a mesma sessão).
    const esperando = [...spawns.values()].filter(s => s.home === home && (!s.file || s.sessionId));
    if (!esperando.length) return;
    const desde = Math.min(...esperando.map(s => s.startedAt)) - 5000;
    for (const dir of dayDirs(sessionsDir(home), now(), path)) {
      let nomes = [];
      try { nomes = fs.readdirSync(dir); } catch { continue; }
      for (const n of nomes) {
        if (!/^rollout-.*\.jsonl$/.test(n)) continue;
        const file = path.join(dir, n);
        if (h.known.has(file)) continue;
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        // Anterior a todos os spawns livres: é de outra sessão, decide uma vez só.
        if (st.mtimeMs < desde) { h.known.set(file, 'old'); continue; }
        claim(home, file);
      }
    }
  }

  function readNew(id, s) {
    let size;
    try { size = fs.statSync(s.file).size; } catch { return; }
    if (size < s.offset) s.offset = 0;              // truncado/recriado
    if (size <= s.offset) return;
    const len = Math.min(size - s.offset, READ_CAP);
    let fd;
    let buf;
    try {
      fd = fs.openSync(s.file, 'r');
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, s.offset);
    } catch { return; }
    finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
    // Só linhas completas: corta no último \n para não partir UTF-8 nem JSON.
    const nl = buf.lastIndexOf(0x0a);
    if (nl < 0) return;
    s.offset += nl + 1;
    const evs = s.parser.feed(buf.toString('utf8', 0, nl + 1));
    if (s.parser.state.subagent) return;
    for (const ev of evs) emit(Object.assign({ spawnId: id }, ev));
  }

  function pump() {
    for (const [id, s] of spawns) {
      if (s.resumeLookup && !s.file) lookupResume(id, s);
    }
    for (const home of homes.keys()) {
      ensureHome(home);   // re-tenta o fs.watch se sessions/ nasceu depois
      discover(home);
    }
    for (const [id, s] of spawns) if (s.file) readNew(id, s);
  }

  function stop() {
    for (const id of [...spawns.keys()]) remove(id);
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  }

  return { add, remove, noteInput, pump, stop, _spawns: spawns, _homes: homes };
}

module.exports = { createCodexTurnWatcher, dayDirs, samePath };
