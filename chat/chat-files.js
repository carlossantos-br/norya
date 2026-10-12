'use strict';

/**
 * chat/chat-files.js — "@arquivo" do composer do chat: lista os arquivos da
 * pasta da sessão e ranqueia pelo que foi digitado.
 *
 * Repositório git → `git ls-files` (respeita o .gitignore, rápido em repo
 * grande). Fora de git → varredura limitada (profundidade e quantidade), sem
 * abrir arquivo nenhum: só readdir — pasta do iCloud não baixa nada.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CACHE_MS = 20000;
const WALK_MAX = 6000;
const WALK_DEPTH = 6;
// Windows: AppData (cache de navegador, npm, apps — centenas de milhares de
// arquivos sob o USERPROFILE) e as pastas de sistema de uma raiz de disco.
const SKIP_DIRS = new Set(['node_modules', '.git', 'Library', 'Pictures', 'Music', 'Movies', 'Applications',
  '.Trash', 'dist', 'build', '.next', '.cache', 'venv', '.venv', '__pycache__', 'Pods', 'DerivedData',
  'AppData', 'Application Data', 'Local Settings', '$Recycle.Bin', 'System Volume Information',
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Recovery', 'PerfLogs']);

const cache = new Map();   // cwd → { at, files: Promise<string[]> }

function walk(root) {
  const out = [];
  let level = [''];
  for (let depth = 0; depth < WALK_DEPTH && level.length && out.length < WALK_MAX; depth++) {
    const next = [];
    for (const rel of level) {
      let ents;
      try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) next.push(r); }
        else if (e.isFile()) { out.push(r); if (out.length >= WALK_MAX) break; }
      }
      if (out.length >= WALK_MAX) break;
    }
    level = next;
  }
  return out;
}

function listFiles(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const files = new Promise(resolve => {
    // -z + quotepath=off: nome com acento vem cru (sem isso o git devolve
    // "relat\303\263rio.md", entre aspas). fsmonitor desligado: repo clonado
    // pode configurar um core.fsmonitor que o git executa ao ler o index.
    execFile('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-C', cwd, 'ls-files', '-z', '-co', '--exclude-standard'], { maxBuffer: 32 * 1024 * 1024, timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (!err && stdout) return resolve(stdout.split('\0').filter(Boolean).slice(0, 50000));
      try { resolve(walk(cwd)); } catch { resolve([]); }
    });
  });
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

/**
 * Ranqueia: nome do arquivo começando com a busca > nome contendo > caminho
 * contendo > letras na ordem (subsequência). Empate → caminho mais curto.
 */
function rankFiles(files, query, limit = 30) {
  const q = String(query || '').toLowerCase();
  if (!q) return files.slice().sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length).slice(0, limit);
  const scored = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    const baseName = lf.slice(lf.lastIndexOf('/') + 1);
    let score;
    if (baseName.startsWith(q)) score = 0;
    else if (baseName.includes(q)) score = 1;
    else if (lf.includes(q)) score = 2;
    else {
      let i = 0;
      for (const ch of lf) { if (ch === q[i]) i++; if (i === q.length) break; }
      if (i < q.length) continue;
      score = 3;
    }
    scored.push([score, f]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
  return scored.slice(0, limit).map(x => x[1]);
}

async function searchFiles(cwd, query, limit) {
  if (!cwd || !path.isAbsolute(cwd)) return [];
  const files = await listFiles(cwd);
  return rankFiles(files, query, limit);
}

module.exports = { searchFiles, rankFiles, walk };
