const { app, BrowserWindow, ipcMain, dialog, Menu, shell, powerSaveBlocker, nativeImage, globalShortcut, session: electronSession } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
// `windowless`: no Windows todo filho (git, powershell, taskkill) nasce sem
// janela de console; no macOS é o próprio módulo.
const { spawn: childSpawn, execFileSync, execFile } = require('./platform').windowless(require('child_process'));

// Onde ficam os dados (accounts/, threads, quota…). UMA fonte da verdade.
const { NORYA_HOME } = require('./norya-home');
const uiPrefs = require('./ui-prefs');
// A ÚNICA camada que sabe se estamos no macOS ou no Windows: shell do PTY,
// PATH das CLIs, aspas, sockets, isolamento de perfil. Nenhum `=== 'win32'`
// deve aparecer neste arquivo — se aparecer, é bug de arquitetura.
const platform = require('./platform');
// Scanner puro de rollouts do Claude (títulos da sidebar) — testável sem Electron.
const { scanClaudeRollout } = require('./claude-meta');
const { badgePng } = require('./helpers/badge-icon');

/** Disco numerado para o overlay icon da taskbar (Windows). null = sem badge. */
function badgeOverlayIcon(count) {
  const png = badgePng(count);
  return png ? nativeImage.createFromBuffer(png) : null;
}

// ── Norya Browser modules ─────────────────────────────────────────────────────
const BrowserManager   = require('./browser/browser-manager');
const AuthFlowRouter   = require('./browser/auth-flow-router');
const MCPServer        = require('./browser/mcp-server');
const { socketPathFor: mcpSocketPath } = MCPServer;

// ── Registry de agentes (semente da Fase 3) ───────────────────────────────────
const { AGENTS, byId: AGENT_BY_ID, resolveAgentId } = require('./agents/registry');
const { buildCommand, buildChatCommand, buildChatArgv, CHAT_AGENTS, claudeHookSettings } = require('./agents/commands');
const { resolveClaudeHookCmd } = require('./agents/claude-hook');
const { createChatSession } = require('./chat/chat-session');
const chatFiles = require('./chat/chat-files');
const { claudeHistoryEvents } = require('./chat/chat-protocol');
const { SkillsLibrary } = require('./agents/skills');
const { providersStatusFor, quotaProvidersFor } = require('./agents/providers');
const { findRollout, planAdoption, buildMetadataInsert, codexHomeOf } = require('./agents/rollout-adopt');
const { parseEventLine, transcriptShowsContinuation, createClaudeTurnGate } = require('./agents/agent-events');
const { createCodexTurnWatcher } = require('./agents/codex-turn-watch');

// Todos os authModes que o registry conhece. Usado para listar perfis e para
// validar `profile-set-auth-mode`. Listas escritas à mão nesses dois lugares já
// deixaram grok e opencode invisíveis uma vez.
const AUTH_MODES_CONHECIDOS = new Set(AGENTS.flatMap(a => a.authModes));

const net = require('net');

// ── Ambiente herdado de um agente (2026-10-04) ──────────────────────────────
// Reiniciar o Norya de dentro de um pane (restart-job, `open -a Norya` num
// Bash do Claude) faz o app herdar o ambiente DAQUELA sessão, e todo PTY repassa
// pros filhos. Com CLAUDECODE/CLAUDE_CODE_CHILD_SESSION/CLAUDE_CODE_SESSION_ID,
// cada Claude novo se via sessão-filha e não gravava transcript: sem ai-title
// (tudo "New task", inclusive no celular), latch sem achar a thread, estado errado.
// As variáveis por pane (NORYA_*) são recolocadas no spawn quando cabem.
for (const key of Object.keys(process.env)) {
  if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT' || key === 'AI_AGENT'
    || /^CLAUDE_CODE_(SESSION_ID|SESSION_ATTENDED|CHILD_SESSION|ENTRYPOINT|EXECPATH|MESSAGING_\w+)$/.test(key)
    || /^CODEX_(THREAD_ID|SANDBOX\w*|CI|MANAGED_BY_\w+)$/.test(key)
    || /^NORYA_(SPAWN_ID|PROFILE_ID|BROWSER_MCP_SOCKET|EVENT_SOCKET|OPEN_SOCKET)$/.test(key)) {
    delete process.env[key];
  }
}

// ── Isolamento para testes (2026-07-21) ─────────────────────────────────────
// NORYA_USER_DATA: userData próprio ⇒ lock de instância única separado do app
// de produção — os smokes conseguem subir uma instância isolada (NORYA_HOME
// temp + NORYA_SOCKET_SUFFIX) SEM derrubar nem roubar sockets do Norya vivo.
// Sem essas envs, nada muda.
if (process.env.NORYA_USER_DATA) {
  try { app.setPath('userData', process.env.NORYA_USER_DATA); } catch {}
}

// ── Leveza do Chromium (2026-10-03) ─────────────────────────────────────────
// - AudioServiceOutOfProcess: o único som do Norya é a marimba da fila de
//   atenção, e por ele o Chromium mantinha um processo utilitário de áudio
//   (~45 MB medidos) vivo até o quit. Em processo, custa quase nada.
// - SpareRendererForSitePerProcess: não deixa um renderer "de reserva" pronto
//   para a próxima navegação de <webview> — economiza um processo inteiro.
// - BackForwardCache: páginas anteriores das abas não ficam congeladas em RAM.
// NORYA_KEEP_CHROMIUM_DEFAULTS=1 desliga tudo isto (diagnóstico).
if (!process.env.NORYA_KEEP_CHROMIUM_DEFAULTS) {
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,SpareRendererForSitePerProcess,BackForwardCache');
  // Teto da geração jovem do V8 nos renderers (2026-10-05). O DOM renderer do
  // xterm gera ~4 MB/s de lixo; sem teto o new space chegava a 50 MB com 2,7 MB
  // vivos e as páginas ficavam "sujas" no footprint. Medido (4 panes, 6 min):
  // renderer 190 → 155 MB. Vale para os renderers, não para o main (já nasceu).
  app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=8');
}

// ── Single-instance lock (2026-07-15) ────────────────────────────────────────
// Duas instâncias do Norya disputam os sockets em /tmp (MCP, auth, open-url) e
// os 18 JSONs de estado em ~/.norya — a segunda corrompia a primeira em
// silêncio. A segunda instância agora foca a primeira e sai.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (typeof testWindow !== 'undefined' && testWindow && !testWindow.isDestroyed()) {
      try {
        if (testWindow.isMinimized()) testWindow.restore();
        testWindow.show();
        testWindow.focus();
      } catch {}
    }
  });
}

// Os switches globais do Chromium para anti-fingerprint saíram em 2026-07-09,
// junto com o privacy-hardener. Eram aplicados ao APP INTEIRO, não só ao
// navegador: `disable-quic` desligava HTTP/3 em toda navegação,
// `webrtc-ip-handling-policy` quebrava WebRTC, e `disable-features` com
// AudioServiceOutOfProcess trazia o serviço de áudio para dentro do processo
// principal. Custo permanente, benefício de privacidade nenhum.

// Singletons — instantiated lazily in app.whenReady once REAL_HOME / ACCOUNTS_DIR are known.
let browserManager   = null;
let authFlowRouter   = null;
let mcpServer        = null;
const mcpStartedProfiles = new Set();   // profileNum → MCPServer.start() already called
const authActiveProfiles = new Set();   // profileNum → AuthFlowRouter active for login flow

// ── Real-time quota subsystem ───────────────────────────────────────────────
const QuotaManager = require('./quota');
let quotaManager = null;
let providerUpdates = null;

// Profile whose browser panel is currently prepared (for webview hardening params).
let _activeBrowserProfile = null;

const LOG_FILE = path.join(NORYA_HOME, 'panel.log');
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}
function logLine(tag, msg) {
  const line = `[${new Date().toISOString()}] ${tag}: ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.error(line.trim());
  try {
    const { BrowserWindow } = require('electron');
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('norya-log', { tag, msg: String(msg) });
    });
  } catch {}
}
// Renderer-side console messages are forwarded here and appended to panel.log
// so the agent (me) can read them via `tail panel.log` without you copy/pasting.
try {
  const { ipcMain } = require('electron');
  ipcMain.on('renderer-log', (_, { level, args }) => {
    try {
      const line = `[${new Date().toISOString()}] renderer.${level || 'log'}: ${(args || []).join(' ')}\n`;
      fs.appendFileSync(LOG_FILE, line);
    } catch {}
  });
} catch {}
function logError(tag, err) {
  logLine(tag, (err && err.stack) || String(err));
}
logLine('boot', `pid=${process.pid} electron=${process.versions.electron} argv=${JSON.stringify(process.argv)}`);
process.on('uncaughtException', err => {
  logError('uncaughtException', err);
  try { dialog.showErrorBox('Erro no Norya', String(err && err.stack || err)); } catch {}
});
process.on('unhandledRejection', err => logError('unhandledRejection', err));

let pty;
try { pty = require('node-pty'); }
catch (err) { logError('node-pty require failed', err); }

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (err) { logError('node:sqlite require failed', err); }

const REAL_HOME = os.homedir();
const ACCOUNTS_DIR = path.join(NORYA_HOME, 'accounts');
const NVM_DIR = path.join(REAL_HOME, '.nvm');
const skillsLibrary = new SkillsLibrary({
  // O HOME de um pane pode ser de perfil. Skills globais pertencem ao usuário.
  home: process.env.NORYA_SKILLS_TEST_HOME && process.env.NORYA_SMOKE === '1'
    ? process.env.NORYA_SKILLS_TEST_HOME : os.userInfo().homedir,
  stateDir: NORYA_HOME,
  projectDirs: () => readProjects().projects.map(p => p.path || p.cwd).filter(Boolean),
});

// ── Profile system (introduced 2026-05-25) ────────────────────────────────
// 20 saturated colors for profile identity (distinct from BRANCH_PALETTE in
// test-window.html which is for git branch visualization). Material-Design
// inspired; tested for contrast in both light and dark themes.
const PROFILE_PALETTE = [
  '#E74C3C', '#E91E63', '#9C27B0', '#673AB7',
  '#3F51B5', '#2196F3', '#03A9F4', '#00BCD4',
  '#009688', '#4CAF50', '#8BC34A', '#CDDC39',
  '#FFC107', '#FF9800', '#FF5722', '#795548',
  '#607D8B', '#FF4081', '#7C4DFF', '#1ABC9C',
];
const THREAD_OWNERS_PATH = path.join(NORYA_HOME, 'thread-owners.json');
const NORYA_STATE_PATH = path.join(NORYA_HOME, 'norya-state.json');
// Norya forks 2026-05-26: persistent map childSessionId → { parentId, parentTitle, slug, branch, createdAt }
const FORK_LINEAGE_PATH = path.join(NORYA_HOME, 'fork-lineage.json');
// Aider doesn't write to state_5.sqlite/sessions/ like codex. Norya keeps its
// own registry of aider threads and gives each one a dedicated chat history
// file (passed via --chat-history-file).
const AIDER_THREADS_DIR = path.join(NORYA_HOME, 'aider-threads');
const AIDER_THREADS_INDEX = path.join(NORYA_HOME, 'aider-threads.json');

// Atomic file write: write to a temp sibling then rename (rename is atomic on the
// same filesystem), so a crash / power loss mid-write can never leave a truncated
// or zero-byte state file (which would reset projects/owners/profiles on reboot).
// `content` is the already-serialized string so output stays byte-identical to the
// previous direct writeFileSync. `mode` (default undefined) is set to 0o600 for
// secret-bearing files (API keys, tokens).
function writeFileAtomic(p, content, opts = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, opts.mode ? { mode: opts.mode } : undefined);
    fs.renameSync(tmp, p);
    if (opts.mode) { try { fs.chmodSync(p, opts.mode); } catch {} }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function readAiderThreads() {
  try { return JSON.parse(fs.readFileSync(AIDER_THREADS_INDEX, 'utf8')) || []; }
  catch { return []; }
}
function aiderHistoryFile(threadId) {
  fs.mkdirSync(AIDER_THREADS_DIR, { recursive: true });
  return path.join(AIDER_THREADS_DIR, `${threadId}.history.md`);
}
function aiderInputFile(threadId) {
  fs.mkdirSync(AIDER_THREADS_DIR, { recursive: true });
  return path.join(AIDER_THREADS_DIR, `${threadId}.input.history`);
}

const DEFAULT_CONFIG_TOML = [
  'model = "gpt-5.5"',
  'model_reasoning_effort = "xhigh"',
  'personality = "pragmatic"',
  'service_tier = "default"',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  // A pasta pessoal do usuário (JSON.stringify = string TOML válida, inclusive
  // com as barras invertidas do Windows).
  `[projects.${JSON.stringify(REAL_HOME)}]`,
  'trust_level = "trusted"',
  '',
  '[notice]',
  'hide_rate_limit_model_nudge = true',
  'hide_full_access_warning = true',
  '',
  '[features]',
  'multi_agent = true',
  '',
].join('\n');

function ensureConfig(dir) {
  const cfgDir = path.join(dir, '.codex');
  const cfg = path.join(cfgDir, 'config.toml');
  fs.mkdirSync(cfgDir, { recursive: true });
  let current = '';
  try { current = fs.readFileSync(cfg, 'utf8'); } catch {}
  if (current.includes('approvals_reviewer = "full-auto"') || current.includes('model = "gpt-5.4"') || current.includes('model = "codex-5.5"') || !current.trim()) {
    fs.writeFileSync(cfg, DEFAULT_CONFIG_TOML);
  }
  // Ensure skills dir is a symlink to the shared skills directory.
  //
  // Windows: symlink comum exige privilégio (ou Modo Desenvolvedor); JUNCTION
  // de diretório não exige nada e resolve igual. E junction para alvo que não
  // existe falha na hora — então só ligamos quando o alvo está lá. Sem isso,
  // uma instalação nova no Windows (sem ~/.codex/skills) quebrava o
  // ensureConfig inteiro, e com ele a criação de qualquer perfil.
  const skillsLink = path.join(cfgDir, 'skills');
  const skillsTarget = path.join(REAL_HOME, '.codex', 'skills');
  const tipoLink = platform.isWin ? 'junction' : undefined;
  const alvoExiste = (() => { try { return fs.existsSync(skillsTarget); } catch { return false; } })();
  if (alvoExiste || !platform.isWin) {
    try {
      fs.lstatSync(skillsLink);
      // Um perfil pode ter skills próprias. O catálogo universal já as lê;
      // substituir a pasta por symlink apagaria essas instalações.
    } catch {
      try { fs.symlinkSync(skillsTarget, skillsLink, tipoLink); }
      catch (err) { logError('ensureConfig skills link', err); }
    }
  }
  // Keep the user's global AGENTS.md and lifecycle hooks available in future profiles.
  // Preserve profile-specific files; Windows may need a regular copy instead.
  for (const name of ['AGENTS.md', 'hooks.json']) {
    const target = path.join(REAL_HOME, '.codex', name);
    const link = path.join(cfgDir, name);
    if (!fs.existsSync(target)) continue;
    try { fs.lstatSync(link); continue; } catch (err) {
      if (err.code !== 'ENOENT') { logError(`ensureConfig ${name}`, err); continue; }
    }
    try { fs.symlinkSync(target, link); } catch (err) {
      if (platform.isWin && ['EPERM', 'EACCES'].includes(err.code)) {
        try { fs.copyFileSync(target, link, fs.constants.COPYFILE_EXCL); }
        catch (copyError) { logError(`ensureConfig ${name} copy`, copyError); }
      } else { logError(`ensureConfig ${name} link`, err); }
    }
  }
}

const terminals = {};
// Panes em modo CHAT (2026-10-11): id → sessão de chat/chat-session.js. Mesmo
// espaço de ids dos PTYs (o renderer não distingue até montar o pane), e os
// mesmos canais de saída (`terminal-exit-${id}`); a conversa vai por
// `chat-event-${id}`. Nunca há PTY e chat com o mesmo id ao mesmo tempo.
const chats = {};
// Parallel to `terminals`: tracks { projectId, profileNum, sessionId } per PTY
// id so the concurrency engine can enforce per-project and per-profile caps.
const terminalMeta = {};
// mainWindow + overlayWindow + pipAccounts removidos junto com o Painel Operacional.


const https = require('https');

const termBuffers = {};
// A view can finish fitting while spawnTerminal is still awaiting skills/auth.
// Retain its latest size so the PTY starts with the geometry already on screen.
const terminalSizes = new Map();
const TERM_BUF_MAX = 50 * 1024;



function listRolloutFilesInDir(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return [];
  const out = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { out.push({ path: p, mtime: fs.statSync(p).mtimeMs }); } catch {}
      }
    }
  };
  walk(sessionsDir);
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Cache for Claude session metadata (title/cwd/sidechain/internal), keyed by
// sessionId and invalidated by file mtime. Persisted to disk so cold boots stay
// fast — the title is Claude Code's `ai-title` line, which can sit hundreds of
// KB into a large rollout, so resolving it is expensive to repeat every launch.
const CLAUDE_META_CACHE_PATH = path.join(NORYA_HOME, '.claude-title-cache.json');
const CLAUDE_META_CACHE_VERSION = 3; // bump when the meta shape/filters change
const claudeMetaCache = new Map();
let claudeMetaLoaded = false, claudeMetaDirty = false;
function loadClaudeMetaCache() {
  if (claudeMetaLoaded) return;
  try {
    const obj = JSON.parse(fs.readFileSync(CLAUDE_META_CACHE_PATH, 'utf8'));
    if (obj && obj.v === CLAUDE_META_CACHE_VERSION && obj.m) {
      for (const [k, v] of Object.entries(obj.m)) claudeMetaCache.set(k, v);
    }
    claudeMetaLoaded = true;
  } catch (err) {
    if (err && err.code === 'ENOENT') { claudeMetaLoaded = true; return; } // no cache yet — fine
    // Corrupt cache: delete it so it rebuilds cleanly, log once, and allow retry
    // on transient read errors (don't latch loaded=true on a non-ENOENT failure).
    logError('loadClaudeMetaCache (corrupt — rebuilding)', err);
    try { fs.unlinkSync(CLAUDE_META_CACHE_PATH); claudeMetaLoaded = true; } catch {}
  }
}
function saveClaudeMetaCache() {
  if (!claudeMetaDirty) return;
  claudeMetaDirty = false;
  try {
    fs.mkdirSync(path.dirname(CLAUDE_META_CACHE_PATH), { recursive: true });
    writeFileAtomic(CLAUDE_META_CACHE_PATH, JSON.stringify({ v: CLAUDE_META_CACHE_VERSION, m: Object.fromEntries(claudeMetaCache) }));
  } catch {}
}
// scanClaudeRollout mora em claude-meta.js (módulo puro, testado em
// test/claude-meta.test.js) — extraído daqui em 2026-07-22 quando o scanner
// ganhou tratamento de wrappers de comando local e content em array.

// Cache por arquivo de rollout (list-threads rodava a cada ~1,2 s relendo e
// parseando 64 KB de até 60 rollouts por pasta; ~10 MB de lixo por chamada).
// Rollout é append-only: depois que passa de 64 KB a cabeça é imutável, então
// só uma troca de arquivo (ino) ou encolhimento invalida. Abaixo disso, relê
// quando size ou mtime mudam. Entradas não vistas na última varredura caem.
// Linhas do sqlite por banco: um `sqlite3` por perfil a cada chamada. Vale
// enquanto mtime/size do .sqlite e do -wal não mudam (e no máx. 10 min, como
// rede de segurança); thread-rename/delete também invalidam explicitamente.
const THREADS_DB_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const threadsDbCache = new Map(); // dbPath -> { sig, at, rows }
function threadsDbSig(dbPath) {
  let sig = '';
  for (const f of [dbPath, dbPath + '-wal']) {
    try { const st = fs.statSync(f); sig += `${st.mtimeMs}:${st.size}:${st.ino}|`; } catch { sig += 'x|'; }
  }
  return sig;
}
function lerThreadsCached(dbPath, loader) {
  const sig = threadsDbSig(dbPath);
  const c = threadsDbCache.get(dbPath);
  if (c && c.sig === sig && Date.now() - c.at < THREADS_DB_CACHE_MAX_AGE_MS) return c.rows.map(r => ({ ...r }));
  const rows = loader(dbPath); // erro (DB travado) propaga e não é cacheado
  threadsDbCache.set(dbPath, { sig, at: Date.now(), rows });
  return rows.map(r => ({ ...r }));
}
function threadsDbCacheSweep(livePaths) {
  const live = new Set(livePaths);
  for (const k of threadsDbCache.keys()) if (!live.has(k)) threadsDbCache.delete(k);
}
const ROLLOUT_HEAD_BYTES = 64 * 1024;
const rolloutMetaCache = new Map(); // path -> { ino, size, mtimeMs, gen, meta }
let rolloutMetaGen = 0;
function beginRolloutMetaSweep() { return ++rolloutMetaGen; }
function endRolloutMetaSweep(gen) {
  for (const [k, v] of rolloutMetaCache) if (v.gen < gen) rolloutMetaCache.delete(k);
}
function readRolloutMeta(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { rolloutMetaCache.delete(filePath); return null; }
  const c = rolloutMetaCache.get(filePath);
  if (c && c.ino === stat.ino) {
    const headFrozen = c.size >= ROLLOUT_HEAD_BYTES && stat.size >= c.size;
    if (headFrozen || (c.size === stat.size && c.mtimeMs === stat.mtimeMs)) {
      c.gen = rolloutMetaGen;
      return c.meta;
    }
  }
  const meta = readRolloutMetaUncached(filePath);
  rolloutMetaCache.set(filePath, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, gen: rolloutMetaGen, meta });
  return meta;
}

function readRolloutMetaUncached(filePath) {
  // Extract sessionId, cwd, first user message and a short title from a rollout JSONL.
  // Reads a HEAD window (~64 KB) where session_meta and the first user prompt live.
  try {
    const stat = fs.statSync(filePath);
    if (!stat.size) return null;
    const headSize = Math.min(stat.size, 64 * 1024);
    const buf = Buffer.alloc(headSize);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buf, 0, headSize, 0); }
    finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    let sessionId = null, cwd = null, firstUser = null, title = null;
    for (const ln of lines) {
      if (!ln) continue;
      let obj; try { obj = JSON.parse(ln); } catch { continue; }
      if (!obj) continue;
      // session_meta envelopes we've seen:
      //   v0 legacy top-level:  {type:'session_meta', id, cwd, ...}
      //   v1 nested payload:     {payload:{type:'session_meta', id, cwd, ...}}
      //   v2 envelope+payload:   {type:'session_meta', timestamp, payload:{id, cwd, ...}}  <- codex 0.122
      if (obj.type === 'session_meta') {
        const src = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
        sessionId = sessionId || src.id || src.session_id;
        cwd = cwd || src.cwd || src.working_dir;
      } else if (obj.payload && obj.payload.type === 'session_meta') {
        sessionId = sessionId || obj.payload.id || obj.payload.session_id;
        cwd = cwd || obj.payload.cwd || obj.payload.working_dir;
      }
      // Extra fallbacks for cwd (turn_context events carry it too)
      if (!cwd) {
        if (obj.cwd) cwd = obj.cwd;
        else if (obj.payload && obj.payload.cwd) cwd = obj.payload.cwd;
      }
      if (!sessionId && obj.session_id) sessionId = obj.session_id;
      // First user message — prefer real event_msg.user_message; skip synthetic <environment_context>
      if (!firstUser) {
        if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'user_message') {
          const msg = typeof obj.payload.message === 'string' ? obj.payload.message : null;
          if (msg && !msg.startsWith('<environment_context>')) firstUser = msg;
        } else {
          const role = (obj.payload && obj.payload.role) || obj.role;
          if (role === 'user') {
            const content = (obj.payload && obj.payload.content) || obj.content;
            let txt = null;
            if (typeof content === 'string') txt = content;
            else if (Array.isArray(content)) {
              for (const c of content) {
                if (c && typeof c.text === 'string') { txt = c.text; break; }
                if (typeof c === 'string') { txt = c; break; }
              }
            }
            if (txt && !txt.startsWith('<environment_context>')) firstUser = txt;
          }
        }
        if (firstUser) title = firstUser.split('\n')[0].slice(0, 80);
      }
      if (sessionId && cwd && firstUser) break;
    }
    if (!sessionId) {
      const m = path.basename(filePath).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) sessionId = m[0];
    }
    return sessionId ? { sessionId, cwd, firstUser, title } : null;
  } catch {
    return null;
  }
}

function trackedSystemSessionFile(num) {
  return path.join(ACCOUNTS_DIR, String(num), 'system-session.txt');
}

function findAllRolloutsForSession(sessionId) {
  if (!sessionId) return [];
  const roots = [path.join(REAL_HOME, '.codex', 'sessions')];
  for (const base of [ACCOUNTS_DIR, ARCHIVED_ACCOUNTS_DIR]) {
    if (!fs.existsSync(base)) continue;
    for (const n of fs.readdirSync(base)) {
      const p = path.join(base, n, '.codex', 'sessions');
      if (fs.existsSync(p)) roots.push(p);
    }
  }
  const hits = [];
  const walk = (root, d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(root, p);
      else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) {
        try { hits.push({ root, path: p, rel: path.relative(root, p), mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size }); } catch {}
      }
    }
  };
  for (const r of roots) walk(r, r);
  // Maior conteúdo primeiro (rollout é append-only, maior = mais histórico).
  // Tiebreak por mtime para caso improvável de empate em tamanho.
  return hits.sort((a, b) => (b.size - a.size) || (b.mtime - a.mtime));
}

function syncedSidecarPath(rolloutPath) { return rolloutPath + '.synced'; }

function markRolloutSynced(rolloutPath, refMtime) {
  try { fs.writeFileSync(syncedSidecarPath(rolloutPath), String(refMtime || Date.now())); } catch {}
}

function syncThreadLatest(accountNum, sessionId) {
  const hits = findAllRolloutsForSession(sessionId);
  logLine('syncThreadLatest', `account=${accountNum} sessionId=${sessionId} hits=${hits.length}` +
    (hits.length ? ' ' + hits.map(h => `${h.path}=${h.size}b@${Math.floor(h.mtime)}`).join(' | ') : ''));
  if (!hits.length) return { error: `rollout ${sessionId} not found` };
  const best = hits[0]; // maior conteúdo
  const accountRoot = path.join(ACCOUNTS_DIR, String(accountNum), '.codex', 'sessions');
  const current = hits.find(h => h.root === accountRoot);
  if (current && current.path === best.path) {
    return { unchanged: true, source: 'account', size: current.size, mtime: current.mtime };
  }
  // Se o atual já é >= o melhor em bytes, não regredimos
  if (current && current.size >= best.size) {
    return { unchanged: true, source: 'account', reason: 'current-larger', size: current.size, bestSize: best.size };
  }
  const dst = path.join(accountRoot, best.rel);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(best.path, dst);
    try { fs.utimesSync(dst, new Date(best.mtime), new Date(best.mtime)); } catch {}
    markRolloutSynced(dst, best.mtime);
    return {
      updated: true,
      from: best.path,
      to: dst,
      newSize: best.size,
      prevSize: current ? current.size : 0,
      newestMtime: best.mtime,
      prevMtime: current ? current.mtime : null,
    };
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
}

function buildAccountEnv(account) {
  // O que isola uma conta da outra é o HOME por perfil. No Windows quem manda
  // é USERPROFILE (é ele que o os.homedir() do Node lê, e sob ele que `codex`
  // grava .codex e `claude` grava .claude) — daí o mapeamento vir do platform.
  const env = {
    ...process.env,
    ...platform.profileHomeEnv(account.dir),
    NVM_DIR,
    TERM: 'xterm-256color',
    CODEX_HOME: path.join(account.dir, '.codex'),
  };

  // Credentials/config overrides inherited from the launching pane must not
  // escape into another profile. Provider-specific auth is injected below.
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
    'OPENAI_API_BASE', 'OPENAI_BASE_URL']) delete env[key];

  // Windows não tem prelúdio de shell: o PATH das CLIs é montado aqui, no
  // ÚNICO funil por onde passam spawn de PTY, sondas de quota e grok-usage.
  // Fazer isso em cada chamador seria repetir o erro que o prelúdio já resolveu
  // no macOS — detectar com um PATH e spawnar com outro.
  if (platform.isWin) platform.prependPath(env, platform.agentPathDirs());

  return { env };
}

// ── Profile data (per-account) ────────────────────────────────────────────
function profilePath(num) {
  return path.join(ACCOUNTS_DIR, String(num), 'profile.json');
}
function readProfile(num) {
  try { return JSON.parse(fs.readFileSync(profilePath(num), 'utf8')) || {}; }
  catch { return {}; }
}
function writeProfile(num, data) {
  const dir = path.join(ACCOUNTS_DIR, String(num));
  if (!fs.existsSync(dir)) throw new Error(`profile ${num}: account dir missing`);
  const current = readProfile(num);
  const next = { ...current, ...data };
  writeFileAtomic(profilePath(num), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
// Round-robin color assignment based on how many profiles already have colors.
// Skips colors already taken to maximize visual distinction.
function pickProfileColor(excludeNums = []) {
  if (!fs.existsSync(ACCOUNTS_DIR)) return PROFILE_PALETTE[0];
  const taken = new Set();
  for (const n of fs.readdirSync(ACCOUNTS_DIR)) {
    if (isNaN(n)) continue;
    if (excludeNums.includes(parseInt(n))) continue;
    const p = readProfile(n);
    if (p.color) taken.add(p.color);
  }
  const free = PROFILE_PALETTE.filter(c => !taken.has(c));
  if (free.length) return free[0];
  return PROFILE_PALETTE[taken.size % PROFILE_PALETTE.length];
}
// Lazy migration: ensure each account has a profile.json with defaults.
// Called by loadAccounts() on every read — idempotent and cheap.
function ensureProfile(num, accountDir) {
  const p = readProfile(num);
  let changed = false;
  if (!p.color) { p.color = pickProfileColor([num]); changed = true; }
  if (p.authMode === undefined) {
    // If auth.json exists, account was using ChatGPT login → default to chatgpt
    const authJson = path.join(accountDir, '.codex', 'auth.json');
    p.authMode = fs.existsSync(authJson) ? 'chatgpt' : null;
    changed = true;
  }
  if (p.apiKey === undefined) { p.apiKey = null; changed = true; }
  // OpenRouter support (added 2026-05-25)
  if (p.openrouterKey === undefined) { p.openrouterKey = null; changed = true; }
  if (p.openrouterModel === undefined) { p.openrouterModel = null; changed = true; }
  // Claude support (added 2026-05-25): OAuth-only, auth lives in account.dir/.claude/
  if (p.claudeModel === undefined) { p.claudeModel = null; changed = true; }
  if (changed) {
    try { writeFileAtomic(profilePath(num), JSON.stringify(p, null, 2), { mode: 0o600 }); }
    catch (err) { logError(`ensureProfile(${num})`, err); }
  }
  return p;
}

// Claude OAuth is GLOBAL (one macOS-Keychain / ~/.claude entry for the user),
// not per-profile. loadAccounts() used to run TWO synchronous Keychain execs PER
// ACCOUNT PER CALL (existence probe + metadata read) — up to 14 blocking execs
// for 7 profiles, on a path hit from ~18 call sites. Memoize the single global
// result with a short TTL; invalidate explicitly on login/logout/auth-mode change.
// No Windows a credencial é POR PERFIL (<perfil>\.claude\.credentials.json):
// o memo vira um por pasta de perfil. No macOS a chave é sempre '' — o mesmo
// memo global de antes.
const _claudeAuthMemo = new Map(); // chave → { has, meta, at }
const CLAUDE_AUTH_MEMO_MS = 30000;
function getClaudeAuthGlobal(accountDir) {
  const key = platform.claudeCredStore === 'profile-file' ? String(accountDir || '') : '';
  const now = Date.now();
  const memo = _claudeAuthMemo.get(key);
  if (memo && (now - memo.at) < CLAUDE_AUTH_MEMO_MS) return memo;
  const dir = key || undefined;
  const meta = readClaudeAuthMeta(dir); // null when logged out; covers keychain + file fallback
  const has = !!meta || fs.existsSync(platform.claudeCredFile(dir));
  const out = { has, meta, at: now };
  _claudeAuthMemo.set(key, out);
  return out;
}
function invalidateClaudeAuthMemo() { _claudeAuthMemo.clear(); }

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  // Accept accounts that have EITHER auth.json (ChatGPT login) OR a configured
  // profile.json with apikey/openrouter mode — that way OpenRouter-only
  // profiles don't require a stale auth.json to be listed.
  return fs.readdirSync(ACCOUNTS_DIR)
    .filter(n => !isNaN(n))
    .sort((a, b) => Number(a) - Number(b))
    .filter(n => {
      const dir = path.join(ACCOUNTS_DIR, n);
      // Soft-deleted profiles are skipped from the active list (but their
      // sessions/sqlite stay on disk so threads remain accessible).
      const p = readProfile(n);
      if (p && p.deleted) return false;
      // Listed if ANY of: has auth.json (ChatGPT logged), has api/openrouter
      // auth configured, OR has name.txt (just created via Add Profile and
      // pending user config).
      if (fs.existsSync(path.join(dir, '.codex', 'auth.json'))) return true;
      if (fs.existsSync(path.join(dir, 'name.txt'))) return true;
      // Derivado do REGISTRY. A lista à mão que estava aqui não conhecia grok
      // nem opencode, e perfis desses agentes simplesmente não apareciam.
      return AUTH_MODES_CONHECIDOS.has(p.authMode);
    })
    .map(n => {
      const dir = path.join(ACCOUNTS_DIR, n);
      ensureConfig(dir);
      let name = `Profile ${n}`;
      try { name = fs.readFileSync(path.join(dir, 'name.txt'), 'utf8').trim() || name; } catch {}
      const profile = ensureProfile(parseInt(n, 10), dir);
      // O OAuth do Keychain é GLOBAL (um por usuário do Mac) — lido uma vez via
      // helper memoizado. Um perfil com token próprio (`claude setup-token`) NÃO
      // depende dele: é isolado. `hasClaudeToken` distingue os dois casos.
      const _ca = getClaudeAuthGlobal(dir);
      const hasClaudeAuth = _ca.has;
      const claudeAuthMeta = _ca.meta;
      const providers = providersStatusFor(dir, profile, _ca);
      return {
        num: parseInt(n, 10),
        name,
        dir,
        color: profile.color,
        authMode: profile.authMode,
        hasApiKey: !!profile.apiKey,
        hasOpenrouterKey: !!profile.openrouterKey,
        openrouterModel: profile.openrouterModel || null,
        claudeModel: profile.claudeModel || null,
        hasClaudeToken: !!profile.claudeOauthToken,   // conta Claude isolada
        hasClaudeAuth,
        claudeAuthExpiresAt: claudeAuthMeta && claudeAuthMeta.expiresAt || null,
        claudeAuthSubscription: claudeAuthMeta && claudeAuthMeta.subscriptionType || null,
        claudeAuthRateLimitTier: claudeAuthMeta && claudeAuthMeta.rateLimitTier || null,
        // Status por provider (2026-07-10): um perfil pode ter Codex, Claude,
        // Grok etc. conectados AO MESMO TEMPO. authMode virou só o "padrão".
        providers,
        // Providers que o painel Uso mede neste perfil (agents/providers.js):
        // o padrão sempre; os outros só com credencial própria do perfil.
        quotaProviders: quotaProvidersFor(profile, providers),
      };
    });
}

// ── Agente por thread ────────────────────────────────────────────────────────
// Espelha o arquivo de owners. Gravado SOMENTE quando o usuário escolheu um
// agente explicitamente no seletor. Em "Automático" não há registro, e a thread
// segue o authMode do perfil — a semântica de sempre.
//
// Uma thread NUNCA troca de CLI depois de criada: o formato de sessão e o
// `--resume` diferem entre elas, e reabrir uma thread de Codex com o Claude
// significaria perder o histórico.
const THREAD_AGENTS_PATH = path.join(NORYA_HOME, 'thread-agents.json');

function readThreadAgents() {
  try { return JSON.parse(fs.readFileSync(THREAD_AGENTS_PATH, 'utf8')) || {}; }
  catch { return {}; }
}
function setThreadAgent(sessionId, agentId) {
  const all = readThreadAgents();
  if (agentId == null) delete all[sessionId];
  else all[sessionId] = agentId;
  fs.mkdirSync(path.dirname(THREAD_AGENTS_PATH), { recursive: true });
  writeFileAtomic(THREAD_AGENTS_PATH, JSON.stringify(all, null, 2));
}

// ── Thread ownership (which profile "claimed" each thread by sending a msg) ─
function readThreadOwners() {
  try { return JSON.parse(fs.readFileSync(THREAD_OWNERS_PATH, 'utf8')) || {}; }
  catch { return {}; }
}
function writeThreadOwners(data) {
  fs.mkdirSync(path.dirname(THREAD_OWNERS_PATH), { recursive: true });
  writeFileAtomic(THREAD_OWNERS_PATH, JSON.stringify(data, null, 2));
}
function getThreadOwner(sessionId) {
  if (!sessionId) return null;
  const all = readThreadOwners();
  return all[sessionId] != null ? all[sessionId] : null;
}
function setThreadOwner(sessionId, profileNum) {
  if (!sessionId) return;
  const all = readThreadOwners();
  if (profileNum == null) delete all[sessionId];
  else all[sessionId] = parseInt(profileNum, 10);
  writeThreadOwners(all);
}

// ── Fork lineage (Norya forks 2026-05-26) ─────────────────────────────────
function readForkLineage() {
  try { return JSON.parse(fs.readFileSync(FORK_LINEAGE_PATH, 'utf8')) || {}; }
  catch { return {}; }
}
function writeForkLineage(data) {
  fs.mkdirSync(path.dirname(FORK_LINEAGE_PATH), { recursive: true });
  writeFileAtomic(FORK_LINEAGE_PATH, JSON.stringify(data, null, 2));
}
function setForkLineageEntry(entry) {
  if (!entry || !entry.childId || !entry.parentId) return null;
  const all = readForkLineage();
  all[entry.childId] = {
    parentId: String(entry.parentId),
    parentTitle: String(entry.parentTitle || '').slice(0, 200),
    slug: String(entry.slug || ''),
    branch: String(entry.branch || ''),
    createdAt: entry.createdAt || Date.now(),
  };
  writeForkLineage(all);
  return all[entry.childId];
}


// Read the Claude OAuth blob (claudeAiOauth) — Keychain first (macOS), then
// ~/.claude/.credentials.json (Linux/Windows, older CLIs). PRIVADO ao main.js:
// carrega access/refresh token. Quem precisa só de metadados usa
// readClaudeAuthMeta(); quem precisa do token, getClaudeCredential() — e nada
// disso pode ir para log ou para o renderer.
//
// `accountDir`: no Windows (platform.claudeCredStore === 'profile-file') cada
// perfil tem o SEU USERPROFILE, e o claude grava <perfil>\.claude\
// .credentials.json — ler o do HOME real mediria a conta errada. No macOS o
// argumento é ignorado (Keychain + ~/.claude do HOME real, como sempre).
function readClaudeOauthRaw(accountDir) {
  let raw = null;
  // 1) Try keychain (macOS default storage for `claude login`). `security` é
  //    binário do macOS — fora dele nem tentamos: seriam spawns que só falham.
  if (platform.isMac) {
    try {
      raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { /* not found */ }
  }
  // 2) Fall back to file (Linux/Windows, or older claude CLI versions).
  if (!raw) {
    const credPath = platform.claudeCredFile(accountDir);
    try {
      if (fs.existsSync(credPath)) raw = fs.readFileSync(credPath, 'utf8');
    } catch { /* unreadable */ }
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return (data && data.claudeAiOauth) || null;
  } catch (err) {
    logError('readClaudeOauthRaw', err);
    return null;
  }
}

// Metadados SEM token (expiresAt, subscriptionType, rateLimitTier, scopes).
// Used by loadAccounts() so the UI can show "🟢 OAuth ativo até <date>" and
// "🟡 expira em <2 dias>" badges without re-asking each render.
function claudeMetaFrom(oauth) {
  if (!oauth) return null;
  return {
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    subscriptionType: oauth.subscriptionType || null,
    rateLimitTier: oauth.rateLimitTier || null,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.slice() : null,
  };
}
function readClaudeAuthMeta(accountDir) {
  return claudeMetaFrom(readClaudeOauthRaw(accountDir));
}

// Credencial do Claude para a leitura de uso por HTTP (quota/claude-http.js).
// Perfil com token próprio (`claude setup-token`) → isolado; senão o accessToken
// do OAuth global (Keychain no Mac). Leitura FRESCA a cada chamada: o
// accessToken roda, e o memo de 30 s do getClaudeAuthGlobal só guarda
// metadados. O token nunca é logado nem sai do processo principal.
function getClaudeCredential(profileNum) {
  let prof = null;
  try { prof = readProfile(profileNum); } catch {}
  if (prof && prof.claudeOauthToken) {
    return { token: prof.claudeOauthToken, kind: 'isolated', identity: 'token isolado', meta: null };
  }
  const porPerfil = platform.claudeCredStore === 'profile-file';
  const oauth = readClaudeOauthRaw(porPerfil ? path.join(ACCOUNTS_DIR, String(profileNum)) : undefined);
  if (!oauth || !oauth.accessToken) return null;
  return {
    token: oauth.accessToken,
    kind: porPerfil ? 'profile' : 'keychain',
    identity: porPerfil ? 'conta deste perfil' : 'conta do Mac',
    meta: claudeMetaFrom(oauth),
  };
}



// ── Concurrency engine: 16 working PTYs por projeto, e só isso ───────────────
// O "1 PTY por perfil chatgpt" saiu em 2026-07-09 (ver canSpawn) e o título
// desta seção ficou mentindo desde então. Perfis diferentes têm HOME diferente,
// logo .codex diferente: dois (ou mais) perfis Codex rodam simultâneos sem se
// atrapalhar. O único teto é o de 16 abaixo, e Claude é isento dele.
const MAX_WORKING_PER_PROJECT = 16;
/**
 * Projeta um registro de terminalMeta para algo que ATRAVESSA o IPC.
 *
 * NUNCA use `{ id, ...meta }` aqui. terminalMeta já guardou um objeto Timeout do
 * Node (o intervalo da extinta Black Box). O IPC do Electron serializa por
 * structured clone, e Timeout não é clonável: a resposta do `invoke` simplesmente
 * nunca é enviada.
 * O renderer fica pendurado para sempre — sem exceção, sem rejeição, sem log.
 *
 * Foi exatamente isso que fazia o segundo pane de Codex "não fazer nada": o erro
 * do gate era gerado corretamente e morria ao tentar cruzar o IPC (2026-07-09).
 * Whitelist explícita: campo novo em terminalMeta não vaza sozinho.
 */
function serializablePty(id, meta) {
  return {
    id,
    projectId: meta.projectId ?? null,
    profileNum: meta.profileNum ?? null,
    sessionId: meta.sessionId ?? null,
  };
}
function workingPtysForProject(projectId) {
  if (!projectId) return [];
  return Object.entries(terminalMeta)
    .filter(([id, meta]) => meta && meta.projectId === projectId && terminals[id])
    .map(([id, meta]) => serializablePty(id, meta));
}
function workingPtysForProfile(profileNum) {
  if (profileNum == null) return [];
  const n = parseInt(profileNum, 10);
  return Object.entries(terminalMeta)
    .filter(([id, meta]) => meta && meta.profileNum === n && terminals[id])
    .map(([id, meta]) => serializablePty(id, meta));
}
// ─────────────────────────────────────────────────────────────────────────────
// Auto-open: URLs que as CLIs abrem vão para o navegador do Norya
//
// Duas fontes, ambas automáticas:
//   1. `open <url>` / $BROWSER  → bin/open-shim/open escreve neste socket.
//   2. dev server no output do PTY → regex + dedupe por origem.
//
// Se o navegador do Norya não puder abrir (janela fechada, painel travado), a
// URL NÃO é engolida: cai no navegador do sistema.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Prelúdio de shell que torna as CLIs de agente encontráveis.
 *
 * UMA fonte só, consumida pelo spawn (initCmd) E pela detecção (`detect-agents`).
 * Detectar com um PATH e spawnar com outro é como testar num ambiente e rodar em
 * outro: funciona até o dia em que não funciona.
 *
 * Por que `zsh -lc` não basta: um login shell NÃO-interativo lê `.zshenv`,
 * `.zprofile` e `.zlogin` — nunca o `.zshrc`, que é onde a maioria dos
 * instaladores (o do Grok inclusive) escreve o PATH. E o app aberto pelo Finder
 * herda um PATH mínimo do launchd. Então construímos o PATH nós mesmos.
 *
 * Ordem dos diretórios:
 *   ~/.local/bin    claude, e os symlinks que o instalador do grok cria
 *   ~/.grok/bin     grok, caso aquele symlink não exista
 *   /opt/homebrew   opencode, aider
 *   /usr/local/bin  —
 *   nvm             codex
 */
function agentShellPrelude() {
  return platform.agentShellPrelude({ nvmDir: NVM_DIR });
}

const OPEN_SHIM_DIR   = path.join(__dirname, 'bin', platform.openShimDirName());
const OPEN_SHIM_BIN   = path.join(OPEN_SHIM_DIR, platform.openShimBinName());
// NORYA_SOCKET_SUFFIX (testes): instância isolada usa outro socket em vez de
// dar unlink no socket do app de produção e roubar o roteamento de `open <url>`.
const OPEN_SOCKET_PATH = platform.ipcEndpoint(
  `open-${platform.uidTag()}${process.env.NORYA_SOCKET_SUFFIX || ''}`);

let openTabInNorya = null;   // (url) => Promise  — ligado no app.whenReady
let _openServer = null;

function routeUrlToNorya(url, origem) {
  const curto = String(url).slice(0, 120);
  if (!openTabInNorya) {
    logLine('auto-open', `sem bridge (${origem}) → sistema: ${curto}`);
    shell.openExternal(url).catch(() => {});
    return;
  }
  openTabInNorya(url)
    .then(() => logLine('auto-open', `${origem} → ${curto}`))
    .catch(err => {
      logLine('auto-open', `falhou (${origem}: ${err.message}) → sistema: ${curto}`);
      shell.openExternal(url).catch(() => {});
    });
}

// ── Mini / pet (2026-10-05) ────────────────────────────────────────────────
// Paridade com o Mini do Codex (a spec interna do Mini (2026-10-05)).
// O renderer calcula o estado (renderer/pet.js), pet/pet-manager.js fala com o
// helper nativo e o main só REPASSA: ações do helper viram `pet-action` pro
// renderer. O helper só existe com o Mini aberto (chave `pet`). NORYA_PET=0
// desliga tudo. Atalho global ⌃⌥Space (o do Codex, ⌥Space, colidiria com o app
// dele aberto nesta máquina).
let petManager = null;
const PET_HOTKEY = 'Control+Alt+Space';

function petHelperBin() {
  const bundled = path.join(__dirname, 'helpers', 'runtime', 'norya-pet');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(__dirname, 'helpers', 'norya-pet', 'build', 'norya-pet');
}

// Grava chaves no norya-state.json (mesmo arquivo do Settings) e avisa a chave
// do Settings, que pode estar aberta.
function petPersistState(patch) {
  try {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(NORYA_STATE_PATH, 'utf8')) || {}; } catch {}
    writeFileAtomic(NORYA_STATE_PATH, JSON.stringify({ ...cur, ...patch }, null, 2));
  } catch (e) { logError('pet state', e); }
  if ('pet' in patch && testWindow && !testWindow.isDestroyed()) testWindow.webContents.send('pet-enabled', patch.pet !== false);
}

function petShowMainWindow() {
  if (!testWindow || testWindow.isDestroyed()) return false;
  if (testWindow.isMinimized()) testWindow.restore();
  testWindow.show();
  testWindow.focus();
  app.focus({ steal: true });
  return true;
}

function petSendAction(a) {
  if (testWindow && !testWindow.isDestroyed()) testWindow.webContents.send('pet-action', a);
}

function setupPet() {
  if (!platform.supportsPet || process.env.NORYA_PET === '0') return;
  const { PetManager } = require('./pet/pet-manager');
  petManager = new PetManager({
    binPath: petHelperBin(),
    assetsDir: path.join(__dirname, 'assets', 'pet'),
    statePath: path.join(NORYA_HOME, 'pet.json'),
    log: (m) => logLine('pet', m),
    // Clique no mascote: traz o Norya pra frente.
    onOpenApp: () => { petShowMainWindow(); },
    // Clique numa pílula: traz o Norya e abre a task (o renderer resolve id → thread).
    onOpenPill: (id) => { petShowMainWindow(); petSendAction({ kind: 'open', id }); },
    // dismiss | mute | reply | stop | newChat | settings — quem sabe fazer é o renderer.
    onAction: (a) => {
      if (a.kind === 'settings') petShowMainWindow();
      petSendAction(a);
    },
    // "Fechar Mini" (era "Desligar mascote"): mesma chave do Settings.
    onClose: () => petPersistState({ pet: false }),
    // Atalho com o Mini fechado: abre.
    onOpen: () => petPersistState({ pet: true }),
  });
  petManager.setPrefs(uiPrefs.lerPetPrefs());
  ipcMain.on('pet-state', (_, s) => { try { petManager.setState(s); } catch (e) { logError('pet-state', e); } });
  ipcMain.on('pet-pill-error', (_, e) => {
    try { if (e && typeof e.id === 'string') petManager.pillError(e.id, e.text); } catch (err) { logError('pet-pill-error', err); }
  });
  ipcMain.handle('pet-muted-get', () => (petManager ? petManager.getMuted() : []));
  try {
    const ok = globalShortcut.register(PET_HOTKEY, () => {
      try { petManager.hotkey(); } catch (e) { logError('pet hotkey', e); }
    });
    if (!ok) logLine('pet', `atalho ${PET_HOTKEY} já em uso — Mini sem atalho global`);
  } catch (e) { logLine('pet', `atalho ${PET_HOTKEY}: ${e.message}`); }
}

function startOpenUrlServer() {
  // Named pipe morre com o processo dono; só o socket Unix deixa arquivo órfão.
  platform.unlinkEndpoint(OPEN_SOCKET_PATH, fs);
  _openServer = net.createServer(conn => {
    let buf = '';
    conn.on('data', d => { buf += d; if (buf.length > 8192) conn.destroy(); });
    conn.on('end', () => {
      let msg;
      try { msg = JSON.parse(buf); } catch { return; }
      if (msg && typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) {
        routeUrlToNorya(msg.url, 'shim');
      }
    });
    conn.on('error', () => {});
  });
  _openServer.on('error', err => logError('open-url-server', err));
  _openServer.listen(OPEN_SOCKET_PATH, () => logLine('auto-open', `socket em ${OPEN_SOCKET_PATH}`));
}

function stopOpenUrlServer() {
  try { _openServer && _openServer.close(); } catch {}
  platform.unlinkEndpoint(OPEN_SOCKET_PATH, fs);
}

// ── Eventos de turno agente → Norya (2026-10-04) ────────────────────────────
// O som de "pane terminou" vinha da heurística de bytes do PTY e apitava em
// silêncio no meio do turno. Para Claude e Codex o fim de turno agora vem do
// próprio agente: o hook do Claude (helpers/norya-claude-event.js) escreve
// neste socket; o rollout do Codex é lido por codexTurnWatch. Tudo chega ao
// renderer pelo IPC `agent-event` (renderer/attention.js decide o som).
// Mesmo sufixo do socket de `open`: a instância isolada dos smokes não rouba
// o socket do app vivo.
const EVENT_SOCKET_PATH = platform.ipcEndpoint(
  `events-${platform.uidTag()}${process.env.NORYA_SOCKET_SUFFIX || ''}`);
const CLAUDE_EVENT_HELPER = path.join(__dirname, 'helpers', 'norya-claude-event.js');
let _eventServer = null;

function deliverAgentEvent(msg) {
  if (msg.kind !== 'working' && msg.kind !== 'activity') logLine('agent-event', `${msg.spawnId} ${msg.kind}${msg.turnId ? ' ' + msg.turnId : ''}${msg.pending ? ' pending=' + msg.pending : ''}`);
  if (testWindow && !testWindow.isDestroyed()) testWindow.webContents.send('agent-event', msg);
}

// O Claude seguiu depois do Stop? Lê só o que o transcript ganhou desde o
// Stop (o helper manda o tamanho daquele momento). Teto de 2 MB: o que importa
// são as primeiras linhas depois do Stop.
function claudeContinuedAfterStop(msg) {
  if (!msg.transcriptPath || msg.transcriptSize == null) return false;
  let fd;
  try {
    fd = fs.openSync(msg.transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(Math.max(0, size - msg.transcriptSize), 2 * 1024 * 1024);
    if (!len) return false;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, msg.transcriptSize);
    return transcriptShowsContinuation(buf.toString('utf8'));
  } catch { return false; }
  finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

// Stop hook roda em paralelo com os do usuário: se um deles bloquear
// (decision:block), o Claude continua. 1,5 s de espera + a checagem do
// transcript evitam o som no meio do turno — ver createClaudeTurnGate.
const claudeTurnGate = createClaudeTurnGate({
  deliver: deliverAgentEvent,
  verify: claudeContinuedAfterStop,
  holdMs: 1500,
});

const codexTurnWatch = createCodexTurnWatcher({
  emit: deliverAgentEvent,
  log: logLine,
});

function startAgentEventServer() {
  platform.unlinkEndpoint(EVENT_SOCKET_PATH, fs);
  _eventServer = net.createServer(conn => {
    let buf = '';
    const consumir = (fim) => {
      const linhas = buf.split('\n');
      buf = fim ? '' : linhas.pop();
      for (const l of linhas) {
        if (!l.trim()) continue;
        const msg = parseEventLine(l);
        // Só spawns vivos e de Claude: outro processo no PTY herda o caminho
        // do socket, e evento de Codex vem do rollout, não daqui.
        const meta = msg && terminalMeta[msg.spawnId];
        if (!meta || meta.agentId !== 'claude') continue;
        claudeTurnGate.handle(msg);
      }
    };
    conn.on('data', d => { buf += d; if (buf.length > 65536) { conn.destroy(); return; } consumir(false); });
    conn.on('end', () => consumir(true));
    conn.on('error', () => {});
  });
  _eventServer.on('error', err => logError('agent-event-server', err));
  _eventServer.listen(EVENT_SOCKET_PATH, () => {
    platform.restrict(EVENT_SOCKET_PATH, 0o600);
    logLine('agent-event', `socket em ${EVENT_SOCKET_PATH}`);
  });
}

function stopAgentEventServer() {
  try { _eventServer && _eventServer.close(); } catch {}
  platform.unlinkEndpoint(EVENT_SOCKET_PATH, fs);
  try { codexTurnWatch.stop(); } catch {}
}

// Interpretador do hook do Claude — node de verdade, ou o Electron em modo
// node como reserva (só POSIX). A lógica das duas plataformas mora em
// agents/claude-hook.js (testada do Mac). Resolvido uma vez.
let _claudeHookCmd;
function claudeEventHookCmd() {
  if (_claudeHookCmd !== undefined) return _claudeHookCmd;
  _claudeHookCmd = resolveClaudeHookCmd({
    plat: platform, helper: CLAUDE_EVENT_HELPER, nvmDir: NVM_DIR,
    execPath: process.execPath, envPath: process.env.PATH || process.env.Path || '',
  });
  if (!_claudeHookCmd) logLine('agent-event', 'hook do Claude desligado (sem helper ou sem node) — fim de turno pela heurística');
  return _claudeHookCmd;
}

// Windows (platform.hookSettingsViaFile): o JSON dos hooks vai num arquivo e
// o claude recebe `--settings <arquivo>`. O conteúdo é o mesmo para todo pane
// (o pane vem de NORYA_SPAWN_ID no env), então um arquivo só basta. null =
// não deu para gravar → o chamador cai no JSON inline.
const CLAUDE_HOOK_SETTINGS_FILE = path.join(NORYA_HOME, 'claude-hook-settings.json');
function claudeHookSettingsFile(hookCmd) {
  const json = claudeHookSettings(hookCmd);
  try {
    let atual = null;
    try { atual = fs.readFileSync(CLAUDE_HOOK_SETTINGS_FILE, 'utf8'); } catch {}
    if (atual !== json) writeFileAtomic(CLAUDE_HOOK_SETTINGS_FILE, json);
    return CLAUDE_HOOK_SETTINGS_FILE;
  } catch (err) { logError('claude hook settings file', err); return null; }
}

// Extração pura em browser/dev-url.js (testada em test/dev-url.test.js).
// Aqui só o estado: dedupe por PTY e debounce.
const { findDevUrls } = require('./browser/dev-url');
const _devUrlSeen = new Map();    // ptyId → Set<origin>
const _devUrlTimer = new Map();   // ptyId → Timeout

/** Chamado a cada chunk de stdout do PTY. Barato: regex + Set. */
function detectDevServer(ptyId, chunk) {
  const achados = findDevUrls(chunk);
  if (!achados.length) return;

  let seen = _devUrlSeen.get(ptyId);
  if (!seen) { seen = new Set(); _devUrlSeen.set(ptyId, seen); }

  for (const { url, origin } of achados) {
    if (seen.has(origin)) continue;   // já abrimos esta origem neste PTY
    seen.add(origin);

    // Debounce: um `npm run dev` cospe Local + Network + preview em milissegundos.
    clearTimeout(_devUrlTimer.get(ptyId));
    _devUrlTimer.set(ptyId, setTimeout(() => {
      _devUrlTimer.delete(ptyId);
      routeUrlToNorya(url, `dev-server(${ptyId})`);
    }, 800));
  }
}

function forgetDevServer(ptyId) {
  _devUrlSeen.delete(ptyId);
  const t = _devUrlTimer.get(ptyId);
  if (t) { clearTimeout(t); _devUrlTimer.delete(ptyId); }
}

function canSpawn({ projectId, profileNum }) {
  let authMode = null;
  if (profileNum != null) { try { authMode = readProfile(profileNum).authMode; } catch {} }
  // Claude profiles are built for many parallel PTYs (the grid view) — exempt
  // them from the per-project working cap so the user can open as many Claude
  // threads in the grid as they want. Codex/chatgpt stay capped to keep load sane.
  if (projectId && authMode !== 'claude') {
    const projPtys = workingPtysForProject(projectId);
    if (projPtys.length >= MAX_WORKING_PER_PROJECT) {
      return {
        ok: false,
        reason: 'project-cap',
        message: `Reached the limit of ${MAX_WORKING_PER_PROJECT} agents working simultaneously in this project.`,
        running: projPtys,
      };
    }
  }
  // Não há mais cap de "1 PTY por perfil chatgpt". Ele existia como curativo de
  // um bug de COLISÃO DE ID: sem `spawnId`, o id do PTY caía em
  // `String(account.num)`, e o segundo spawn matava o primeiro (ver o comentário
  // ARCH FIX em spawnTerminal). O id passou a ser único e o cap ficou órfão.
  //
  // Medido em 2026-07-09: dois `codex` no MESMO $HOME/perfil sobem limpos, nenhum
  // mata o outro, a saída não traz lock/already-running, e auth.json + config.toml
  // ficam byte-a-byte idênticos. Travado por test/smoke-multi-codex.js.
  //
  // O teto de sanidade continua sendo MAX_WORKING_PER_PROJECT (16), acima.
  return { ok: true };
}

/**
 * Captura o token que o `claude setup-token` imprime no PTY e grava no perfil.
 *
 * Sem isto, ter uma segunda conta Claude exigiria copiar um segredo da tela e
 * colar num campo — o tipo de passo que as pessoas erram ou pulam.
 *
 * Rigor: só age em `mode === 'login'` de um perfil claude, exige o prefixo do
 * registry, e grava uma vez só. A TUI reimprime a tela inteira a cada redraw;
 * sem o guard, gravaríamos o mesmo token dezenas de vezes.
 */
const _tokenCapturado = new Set();   // ptyId

function capturarTokenClaude(ptyId, profileNum, chunk) {
  if (_tokenCapturado.has(ptyId)) return;
  const { prefix } = AGENT_BY_ID.claude.creds;
  const re = new RegExp(`${prefix}[\\w.-]{16,}`);
  const m = String(chunk).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').match(re);
  if (!m) return;
  _tokenCapturado.add(ptyId);
  try {
    writeProfile(profileNum, { claudeOauthToken: m[0] });
    logLine('claude-auth', `perfil ${profileNum}: token capturado do setup-token (${m[0].slice(0, 16)}…)`);
  } catch (err) {
    logError(`capturarTokenClaude(${profileNum})`, err);
  }
}

// ── Pane em modo chat (2026-10-11) ──────────────────────────────────────────
// Sobe a sessão de chat com o MESMO env/comando montado por spawnTerminal e liga
// os eventos dela ao renderer (`chat-event-${id}`) e ao som/pet (`agent-event`).
function startChatSession(id, c) {
  const send = (ch, payload) => {
    if (testWindow && !testWindow.isDestroyed()) testWindow.webContents.send(ch, payload);
  };
  let turnSeq = 0;
  let turnKey = null;
  let session = null;
  // macOS: o shell de login de sempre. Windows: a CLI direto, sem PowerShell no
  // meio do stdio JSON (platform.chatLaunch).
  const launch = platform.chatLaunch({ shell: c.shell, initCmd: c.initCmd, argv: c.chatArgv, envPath: c.env.PATH });
  if (platform.isWin) logLine('chat', `${id} ${launch.direct ? 'direto' : 'via PowerShell'}: ${launch.file}`);
  session = createChatSession({
    agentId: c.agentId,
    shell: launch.file,
    shellArgs: launch.args,
    spawnCwd: c.ptyCwd,
    workCwd: c.workCwd,
    env: c.env,
    resumeId: c.opts.mode === 'resume' ? c.opts.sessionId : null,
    codex: {
      approvalPolicy: c.opts.fullAccess === false ? 'on-request' : 'never',
      sandbox: c.opts.fullAccess === false ? 'workspace-write' : 'danger-full-access',
      model: c.opts.model || null,
      effort: c.opts.reasoningEffort || null,
    },
    loadClaudeHistory: sid => loadClaudeTranscriptEvents(sid, platform.claudeConfigDir(c.accountDir, c.env)),
    log: logLine,
    emit: ev => {
      if (chats[id] !== session) return;   // sessão substituída: eventos velhos não vazam
      send(`chat-event-${id}`, ev);
      if (ev.t === 'session' && ev.sessionId) {
        if (terminalMeta[id]) terminalMeta[id].sessionId = ev.sessionId;
        if (!ev.resumed) rememberChatSession(ev.sessionId);
      } else if (ev.t === 'turn' && ev.state === 'start' && !ev.history) {
        turnKey = `chat-${id}-${++turnSeq}`;
        deliverAgentEvent({ spawnId: id, kind: 'turn-start', turnId: turnKey });
      } else if (ev.t === 'turn' && ev.state === 'end' && !ev.history) {
        deliverAgentEvent({ spawnId: id, kind: 'turn-end', turnId: turnKey || undefined });
        turnKey = null;
      } else if (ev.t === 'approval') {
        deliverAgentEvent({ spawnId: id, kind: 'needs-you', turnId: turnKey || undefined });
      } else if (ev.t === 'item' && ev.item && ev.item.kind === 'tool' && ev.item.status === 'running' && turnKey) {
        const act = ev.item.icon === 'edit' ? 'edit' : (ev.item.icon === 'search' ? 'search' : (ev.item.icon === 'cmd' ? 'cmd' : 'tool'));
        deliverAgentEvent({ spawnId: id, kind: 'activity', act, name: String(ev.item.label || '').slice(0, 80), turnId: turnKey });
      }
    },
    onExit: ({ code, stderr }) => {
      // Como no PTY: processo morto não manda turn-end (seria som de "pronto"
      // ao fechar o pane pelo ×).
      turnKey = null;
      if (chats[id] !== session) return;
      delete chats[id];
      delete terminalMeta[id];
      terminalSizes.delete(id);
      if (code && stderr) {
        logLine('chat-exit', `id=${id} code=${code} stderr=${stderr.slice(-600).replace(/\s+/g, ' ')}`);
        send(`chat-event-${id}`, { t: 'notice', level: 'error', text: stderr.trim().split('\n').slice(-6).join('\n') });
      }
      try { if (global.__invalidateTokenStats) global.__invalidateTokenStats(); } catch {}
      send(`terminal-exit-${id}`);
    },
  });
  chats[id] = session;
  terminalMeta[id] = {
    agentId: c.agentId,
    projectId: c.projectId || null,
    profileNum: c.profileNum,
    sessionId: (c.opts && c.opts.sessionId) || null,
    ui: 'chat',
    cwd: c.workCwd || c.ptyCwd || null,
  };
  send('agent-event', { spawnId: id, kind: 'spawned', agent: c.agentId, events: true, ui: 'chat' });
}

// Sessões do Claude abertas em chat: o `claude -p` grava o transcript com
// entrypoint sdk-cli, que o list-threads esconde (é como ele reconhece sessão
// interna). Estas são do usuário — ficam numa lista própria e aparecem.
const CHAT_SESSIONS_PATH = path.join(NORYA_HOME, 'chat-sessions.json');
let _chatSessionIds = null;
function chatSessionIds() {
  if (_chatSessionIds) return _chatSessionIds;
  try { _chatSessionIds = new Set(JSON.parse(fs.readFileSync(CHAT_SESSIONS_PATH, 'utf8'))); }
  catch { _chatSessionIds = new Set(); }
  return _chatSessionIds;
}
function rememberChatSession(sid) {
  const ids = chatSessionIds();
  if (ids.has(sid)) return;
  ids.add(sid);
  // Teto: as sessões somem do disco em 30 dias (limpeza do Claude) — 500 sobra.
  const arr = Array.from(ids).slice(-500);
  _chatSessionIds = new Set(arr);
  try { writeFileAtomic(CHAT_SESSIONS_PATH, JSON.stringify(arr)); } catch (e) { logError('chat-sessions save', e); }
}

// Onde ficam os `projects/` do Claude que a sidebar varre. macOS: o ~/.claude
// do HOME real (perfis sem token usam o Keychain com o HOME real). Windows
// (claudeCredStore 'profile-file'): também o <perfil>\.claude de cada perfil,
// com o número do perfil — é ele que sabe retomar aquela sessão.
function claudeProjectRoots() {
  const roots = [{ dir: path.join(REAL_HOME, '.claude', 'projects'), accountNum: null }];
  if (platform.claudeCredStore !== 'profile-file') return roots;
  try {
    for (const n of fs.readdirSync(ACCOUNTS_DIR)) {
      if (isNaN(n)) continue;
      roots.push({ dir: path.join(platform.claudeConfigDir(path.join(ACCOUNTS_DIR, n)), 'projects'), accountNum: parseInt(n, 10) });
    }
  } catch {}
  return roots;
}

// <root>/<pasta-do-projeto>/<sessionId>.jsonl, no primeiro root que tiver.
function findClaudeTranscript(sessionId, roots) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(sessionId || ''))) return null;
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const f = path.join(root, d, sessionId + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

// Transcript do Claude → eventos do chat (histórico ao reabrir uma task).
function loadClaudeTranscriptEvents(sessionId, configDir) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(sessionId || ''))) return [];
  const roots = [];
  if (configDir) roots.push(path.join(configDir, 'projects'));
  const real = path.join(REAL_HOME, '.claude', 'projects');
  if (!roots.includes(real)) roots.push(real);
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const f = path.join(root, d, sessionId + '.jsonl');
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      // Teto de 8 MB: só a cauda de sessões gigantes (o começo é o mais velho).
      const max = 8 * 1024 * 1024;
      let text;
      if (st.size <= max) text = fs.readFileSync(f, 'utf8');
      else {
        const fd = fs.openSync(f, 'r');
        try {
          const buf = Buffer.alloc(max);
          fs.readSync(fd, buf, 0, max, st.size - max);
          text = buf.toString('utf8');
          text = text.slice(text.indexOf('\n') + 1);
        } finally { fs.closeSync(fd); }
      }
      return claudeHistoryEvents(text.split('\n')).slice(-1500);
    }
  }
  return [];
}

async function spawnTerminal(account, opts) {
  // ARCH FIX (create-thread reliability): resolve the PTY id (= per-thread
  // channel key) BEFORE the try so the catch block can report errors on the
  // SAME channel the renderer is listening on. Previously the catch reported
  // failures on terminal-data-${account.num}, but a new thread listens on
  // terminal-data-${spawnId}; spawn failures (e.g. the concurrency cap from
  // canSpawn) therefore vanished and the thread tile hung with no exit signal.
  //
  // spawnId is the unique key for this PTY instance. Lets ONE account run MANY
  // PTYs in parallel (one per thread).
  //
  // The legacy id fallback was always String(account.num). That meant if the
  // renderer ever spawned a Norya thread WITHOUT a spawnId (e.g. a create-thread
  // path that forgot to pass one, or a fork before the id was assigned), the new
  // PTY collided with the account's existing PTY and KILLED it (see the
  // terminals[id].kill() below) — so creating a second thread on a busy account
  // intermittently nuked the first. Fallback id convention now matches the
  // renderer's launchTerminal(): explicit spawnId → sessionId (resume reuses the
  // same PTY key) → a minted unique id. account.num is reserved for the TRUE
  // legacy single-PTY path only (no spawnId, no sessionId, no projectId).
  let id;
  if (opts && opts.spawnId) {
    id = String(opts.spawnId);
  } else if (opts && opts.sessionId) {
    id = String(opts.sessionId);
  } else if (opts && opts.projectId) {
    id = `p-${(account && account.num)}-${crypto.randomUUID()}`;
  } else {
    id = String(account && account.num);
  }
  const initialSize = { cols: 120, rows: 35 };
  terminalSizes.set(id, initialSize);
  try {
    if (!pty) throw new Error(`node-pty failed to load (run: cd ${NORYA_HOME}/app && npx electron-rebuild -f -w node-pty)`);
    const skillsAgent = resolveAgentId(readProfile(opts?.profileNum ?? account.num).authMode, opts?.agentId, logLine);
    // Antes do gate e do kill: falha ao preparar skills preserva o PTY atual;
    // a verificação de concorrência continua atômica até o spawn.
    const skillRuntime = opts?.mode === 'login' ? null : await skillsLibrary.prepare(skillsAgent, {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env || {}), CODEX_HOME: path.join(account.dir, '.codex') },
    });
    if (terminalSizes.get(id) !== initialSize) {
      return { ok: false, id, error: 'Terminal launch cancelled.', code: 'cancelled' };
    }

    // Concurrency check (only enforced when caller provides projectId — keeps
    // the legacy Painel Operacional spawn path unchanged).
    const projectId = opts && opts.projectId;
    const profileNum = (opts && opts.profileNum != null) ? parseInt(opts.profileNum, 10) : account.num;
    if (projectId) {
      const gate = canSpawn({ projectId, profileNum });
      if (!gate.ok) {
        const err = new Error(gate.message);
        err.code = gate.reason;
        err.details = gate;
        throw err;
      }
    }

    if (terminals[id]) {
      try { terminals[id].kill(); } catch {}
      delete terminals[id];
    }
    if (chats[id]) {
      const velho = chats[id];
      delete chats[id];
      try { velho.kill(); } catch {}
    }

    const globalState = path.join(account.dir, '.codex-global-state.json');
    if (!fs.existsSync(globalState)) {
      try { fs.writeFileSync(globalState, '{}'); } catch {}
    }

    const shell = platform.shellBin();

    if (opts && opts.mode === 'resume' && opts.sessionId) {
      const sync = syncThreadLatest(account.num, opts.sessionId);
      if (sync.error) logLine('syncThreadLatest', sync.error);
      else if (sync.updated) logLine('syncThreadLatest', `updated ${opts.sessionId} from ${sync.from}`);
    }
    try { fs.unlinkSync(trackedSystemSessionFile(account.num)); } catch {}

    const { env } = buildAccountEnv(account);

    // Profile env injection — one per profile:
    //   chatgpt    → codex CLI + auth.json
    //   apikey     → codex CLI + OPENAI_API_KEY (api.openai.com)
    //   openrouter → aider CLI + OPENAI_API_KEY + OPENAI_API_BASE (openrouter)
    //   claude     → claude CLI (Anthropic OAuth in account.dir/.claude/)
    // O agente é resolvido pelo registry: agentId explícito da thread → authMode
    // do perfil → codex. Antes isto eram dois booleanos e três `if` espalhados.
    let agentId = 'codex';
    let projectCwd = null;
    try {
      const prof = readProfile(profileNum);
      opts = Object.assign({}, opts || {}, { authMode: prof.authMode });
      agentId = resolveAgentId(prof.authMode, opts.agentId, logLine);
      if (agentId === 'codex' && prof.authMode === 'apikey' && prof.apiKey) {
        env.OPENAI_API_KEY = prof.apiKey;
      } else if (agentId === 'aider' && prof.authMode === 'openrouter' && prof.openrouterKey) {
        // Aider looks for OPENROUTER_API_KEY when the model is `openrouter/...`.
        // Setting OPENAI_API_KEY alone triggers aider's OAuth flow (opens a
        // browser tab) — not what we want. Set BOTH for safety.
        env.OPENROUTER_API_KEY = prof.openrouterKey;
        env.OPENAI_API_KEY = prof.openrouterKey;
        env.OPENAI_API_BASE = 'https://openrouter.ai/api/v1';
        env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
        if (prof.openrouterModel && !opts.model) {
          opts.model = prof.openrouterModel;
        }
      } else if (agentId === 'claude') {
        // ── Isolamento de conta do Claude ────────────────────────────────────
        //
        // O OAuth do claude vive no KEYCHAIN do macOS, chaveado pelo usuário do
        // sistema. Trocar HOME (como fazemos com codex e grok) NÃO isola nada:
        // todos os perfis leem o mesmo item e viram a mesma conta Anthropic.
        //
        // O caminho oficial para várias contas é o token de longa duração do
        // `claude setup-token`, injetado por perfil. Verificado no binário
        // 2.1.206: CLAUDE_CODE_OAUTH_TOKEN é forma de auth aceita, e o
        // CLAUDE_CONFIG_DIR relocaliza o ~/.claude (histórico, settings).
        //
        // Perfil COM token → isolado de verdade (HOME próprio, sem Keychain).
        // Perfil SEM token → comportamento antigo (Keychain + HOME real), para
        // que o perfil que já funciona hoje continue funcionando.
        if (prof.claudeOauthToken) {
          env[AGENT_BY_ID.claude.creds.env] = prof.claudeOauthToken;
          env.CLAUDE_CONFIG_DIR = path.join(account.dir, '.claude');
          try { fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true }); } catch {}
          delete env.ANTHROPIC_API_KEY;   // o token manda; não misturar
          logLine('claude-auth', `perfil ${profileNum} usando token próprio (isolado)`);
        } else if (platform.isMac) {
          // Legado: o OAuth do Keychain é lido com o HOME real.
          env.HOME = process.env.HOME || REAL_HOME;
          delete env.ANTHROPIC_API_KEY;
        } else {
          // Fora do macOS não existe Keychain: o `claude` grava a credencial em
          // <HOME>/.claude/.credentials.json. Trocar o HOME já isola de verdade,
          // então NÃO desfazemos o isolamento — devolver o HOME real aqui
          // faria todos os perfis compartilharem a mesma conta Anthropic.
          delete env.ANTHROPIC_API_KEY;
        }
        if (prof.claudeModel && !opts.model) {
          opts.model = prof.claudeModel;
        }
      }

      // Merge de env vindo do chamador (ex.: CLAUDE_LOG_LEVEL=debug num re-login).
      // Chaves saneadas para [A-Z_][A-Z0-9_]* — nada de shell-meta.
      if (opts.env && typeof opts.env === 'object') {
        for (const [k, v] of Object.entries(opts.env)) {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) continue;
          env[k] = String(v);
        }
      }
    } catch (err) { logError(`profile env(${profileNum})`, err); }

    if (providerUpdates?.isLocked(agentId)) {
      throw new Error('Este provider está sendo atualizado. Aguarde a validação para abrir outra sessão.');
    }
    // Atualizações manuais são gerenciadas fora do HOME isolado dos panes.
    if (agentId === 'claude') env.DISABLE_AUTOUPDATER = '1';

    // Validação de cwd, uma vez só, para QUALQUER agente. Uma pasta que sumiu do
    // disco fazia o codex morrer em `--cd <inexistente>` e o PTY do claude morrer
    // com ENOENT antes de a CLI aparecer na tela. Antes eram dois blocos quase
    // iguais; agora é um.
    const desiredCwd = opts.cwd || account.dir;
    let cwdOk = false;
    try { cwdOk = fs.existsSync(desiredCwd); } catch { cwdOk = false; }
    if (!cwdOk) {
      logLine('spawn', `cwd ${desiredCwd} sumiu — caindo para account.dir`);
      opts = Object.assign({}, opts, { cwd: null });
    }
    projectCwd = cwdOk ? desiredCwd : account.dir;

    // O aider guarda histórico por thread. Os caminhos são resolvidos aqui —
    // agents/commands.js é puro e não conhece disco.
    const cmdOpts = (agentId === 'aider' && opts.aiderThreadId)
      ? Object.assign({}, opts, {
          chatHistoryFile:  aiderHistoryFile(opts.aiderThreadId),
          inputHistoryFile: aiderInputFile(opts.aiderThreadId),
        })
      : opts;
    if (skillRuntime) Object.assign(env, skillRuntime.env);
    // Modo chat: só Claude e Codex falam um protocolo que o pane sabe desenhar.
    // Pedido de chat para outra CLI cai na TUI (o renderer descobre pelo 'spawned').
    const chatMode = opts.ui === 'chat' && opts.mode !== 'login' && CHAT_AGENTS.has(agentId);
    // Hooks de evento do Claude (som de fim de turno) — fora do login, que é
    // outro comando (setup-token) e não tem turno.
    const noryaHookCmd = (agentId === 'claude' && opts.mode !== 'login' && !chatMode) ? claudeEventHookCmd() : null;
    // Windows: o JSON dos hooks vai por arquivo (`--settings <arquivo>`).
    const noryaHookSettingsFile = (noryaHookCmd && platform.hookSettingsViaFile) ? claudeHookSettingsFile(noryaHookCmd) : null;
    const cliCmd = chatMode
      ? buildChatCommand(agentId, { ...cmdOpts, ...skillRuntime?.options })
      : buildCommand(agentId, { ...cmdOpts, ...skillRuntime?.options, noryaHookCmd, noryaHookSettingsFile }, { log: logLine });
    // O mesmo comando de chat em argv: no Windows o chat sobe a CLI sem shell.
    const chatArgv = chatMode ? buildChatArgv(agentId, { ...cmdOpts, ...skillRuntime?.options }) : null;
    // O diretório do shim de `open` vai na FRENTE do PATH, e DEPOIS do
    // prelúdio acima — senão aquele o empurraria para trás e o /usr/bin/open
    // venceria. Vale para TODO spawn, não só para o login: é o que faz a CLI
    // abrir páginas dentro do Norya em vez do Chrome.
    //
    // No Windows o shim entra pelo `env.PATH` (abaixo), não por linha de shell:
    // PowerShell não tem `export`, e mexer no PATH em Node é mais confiável.
    const shimFirst = platform.isWin ? '' : `export PATH="${OPEN_SHIM_DIR}:$PATH"`;
    const initCmd = platform.joinCmds([
      agentShellPrelude(),   // nvm + brew + os bin dirs das CLIs (uma fonte só)
      shimFirst,             // o shim de `open` precisa vencer o /usr/bin/open
      cliCmd,
    ]);

    // Onde o PTY nasce é dado do registry, não mais um ternário aninhado.
    // 'account': a CLI acha o auth em account.dir e recebe o projeto por flag.
    // 'project': a CLI pega a pasta do próprio processo.
    const ptyCwd = (AGENT_BY_ID[agentId].ptyCwd === 'account') ? account.dir : projectCwd;
    const cliName = agentId;

    // Norya Browser env injection — agents inside this PTY can drive the
    // profile's browser via MCP (stdio) or the `norya-browser` CLI helper.
    try {
      if (mcpServer && !mcpStartedProfiles.has(profileNum)) {
        // Start lazily, non-blocking. If it fails (no port, etc.) we log and continue.
        mcpServer.start(profileNum).catch(e => logLine('mcp-start', `profile=${profileNum} err=${e.message}`));
        mcpStartedProfiles.add(profileNum);
      }
      // O caminho vem do PRÓPRIO servidor. Antes era '/tmp' cravado aqui, enquanto
      // o mcp-server escutava em os.tmpdir() (no macOS, /var/folders/...). As duas
      // pontas nunca se encontraram: `norya-browser` respondia ENOENT e a
      // automação do navegador por agente jamais funcionou. Corrigido 2026-07-10.
      env.NORYA_BROWSER_MCP_SOCKET = mcpSocketPath(profileNum);
      env.NORYA_PROFILE_ID         = String(profileNum);
      // Make `norya-browser` CLI discoverable.
      const noryaBinDir = path.join(__dirname, 'bin');
      platform.prependPath(env, noryaBinDir);
    } catch (e) { logError('norya-browser env inject', e); }

    // Auto-open: toda página que a CLI abrir cai no navegador do Norya.
    // $BROWSER cobre `python -m webbrowser` e afins; o shim de `open` cobre o
    // macOS, onde codex e claude chamam `open <url>` direto, ignorando $BROWSER.
    // O shim vem ANTES na PATH para vencer o /usr/bin/open.
    try {
      env.NORYA_OPEN_SOCKET = OPEN_SOCKET_PATH;
      env.BROWSER = OPEN_SHIM_BIN;
      platform.prependPath(env, OPEN_SHIM_DIR);
      // Observável: é o único jeito de um teste (ou você, depurando) confirmar
      // que o PTY realmente nasceu com o shim na frente do PATH.
      logLine('auto-open', `env injetado id=${id} BROWSER=${env.BROWSER} PATH[0]=${env.PATH.split(platform.pathSep)[0]}`);
    } catch (e) { logError('auto-open env inject', e); }

    // Canal de eventos de turno: o hook do Claude diz de QUAL pane é o evento
    // por NORYA_SPAWN_ID. Vale pra todo PTY (barato); só o Claude usa.
    env.NORYA_SPAWN_ID = id;
    env.NORYA_EVENT_SOCKET = EVENT_SOCKET_PATH;

    // Codex login flow: if user picked "Norya" as login browser, inject BROWSER
    // env so codex calls `norya-auth-open` which forwards the OAuth URL to us.
    // Paths are deterministic — auth router starts async; socket lives by the
    // time codex prints the URL (login takes seconds, socket creation is ms).
    if (opts && opts.mode === 'login' && authFlowRouter) {
      try {
        // Prefer the per-spawn choice from the login modal (works even when the
        // user didn't tick "remember"); fall back to the persisted preference.
        const loginBrowserChoice = opts.loginBrowser || readLoginBrowserChoice(profileNum);
        if (loginBrowserChoice === 'norya') {
          // O caminho vem do PRÓPRIO roteador (mesma lição do mcp-server): duas
          // pontas calculando o mesmo socket em lugares diferentes é como o
          // fluxo de auth ficou quebrado por meses.
          env.NORYA_AUTH_SOCKET = AuthFlowRouter.socketPathFor(profileNum);
          env.BROWSER           = path.join(__dirname, 'bin', platform.authOpenBinName());
          // macOS codex/claude ignore $BROWSER and call `open <url>` directly.
          // O shim de `open` já está na PATH (injetado acima para todo PTY) e
          // dá precedência ao NORYA_AUTH_SOCKET.
          authFlowRouter.start(profileNum).catch(e => logError(`auth-router start p=${profileNum}`, e));
          authActiveProfiles.add(profileNum);
          logLine('auth-flow', `profile=${profileNum} routing via Norya (open-shim + BROWSER)`);
        } else {
          logLine('auth-flow', `profile=${profileNum} using system browser`);
        }
      } catch (e) { logError('auth-flow start', e); }
    }

    logLine('spawn', `id=${id} cli=${cliName}${chatMode ? ' ui=chat' : ''} cwd=${ptyCwd}`);
    if (chatMode) {
      startChatSession(id, {
        agentId, shell, initCmd, chatArgv, ptyCwd, env, opts, projectId, profileNum, initialSize,
        workCwd: opts.cwd || projectCwd, accountDir: account.dir,
      });
      return { ok: true, id, cwd: ptyCwd, ui: 'chat' };
    }
    const ptyProcess = pty.spawn(shell, platform.shellArgs(initCmd), {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: ptyCwd,
      env,
    });

    ptyProcess.onData(data => {
      // Corte amortizado (2026-10-03): `slice` copia o buffer inteiro; a cada
      // chunk de PTY (dezenas/s por pane) era cópia e GC à toa no main.
      const buf = (termBuffers[id] || '') + data;
      termBuffers[id] = buf.length > TERM_BUF_MAX * 1.25 ? buf.slice(-TERM_BUF_MAX) : buf;
      notePtyOutput();   // segura o sleep só enquanto há agente falando
      if (testWindow && !testWindow.isDestroyed()) {
        testWindow.webContents.send(`terminal-data-${id}`, data);
      }
      // Auto-open: `npm run dev` imprime a URL; abrimos a aba sozinhos.
      try { detectDevServer(id, data); } catch (e) { logError(`detectDevServer(${id})`, e); }
      // `claude setup-token` imprime o token: capturamos e gravamos no perfil.
      if (agentId === 'claude' && opts && opts.mode === 'login') {
        try { capturarTokenClaude(id, profileNum, data); } catch (e) { logError(`token-capture(${id})`, e); }
      }
      // Norya auth flow: fallback URL scraping from PTY stdout when codex
      // ignores BROWSER env. Router dedupes between socket and PTY paths.
      if (authFlowRouter && authActiveProfiles.has(profileNum)) {
        try { authFlowRouter.feedPtyChunk(profileNum, data); } catch {}
      }
      // Real-time quota (Strategy C): feed live CLI output to the parser so the
      // quota badge updates instantly as codex/claude print usage info. Cheap +
      // throttled internally. Skip aider (no quota concept) and login PTYs.
      if (quotaManager && (cliName === 'codex' || cliName === 'claude') && !(opts && opts.mode === 'login')) {
        try { quotaManager.feedPty(profileNum, cliName, data); } catch {}
      }
    });

    ptyProcess.onExit(() => {
      // An old process may finish after a replacement reused the same id.
      // Its exit must not blank the replacement pane or remove its resize state.
      if (terminalSizes.has(id) && terminalSizes.get(id) !== initialSize) return;
      // PTY morto não tem mais turno: solta o rollout e o turn-end segurado.
      // Fora do `terminals[id] === ptyProcess` abaixo de propósito: o
      // kill-terminal e o _dropDeadPty já apagaram terminals[id] antes daqui.
      claudeTurnGate.forget(id);
      codexTurnWatch.remove(id);
      // Invalidate token stats cache — a thread finished, totals likely changed
      try { if (global.__invalidateTokenStats) global.__invalidateTokenStats(); } catch {}

      if (testWindow && !testWindow.isDestroyed()) {
        testWindow.webContents.send(`terminal-exit-${id}`);
      }
      // Norya auth flow: signal completion so router closes the auth tab + wipes
      // the ephemeral MAX_ANON partition. No-op if router wasn't active.
      if (authFlowRouter && authActiveProfiles.has(profileNum) && opts && opts.mode === 'login') {
        try { authFlowRouter.markComplete(profileNum); } catch {}
        authActiveProfiles.delete(profileNum);
      }
      if (terminals[id] === ptyProcess) {
        delete terminals[id];
        delete termBuffers[id];
        delete terminalMeta[id];
        terminalSizes.delete(id);
      }
    });

    terminals[id] = ptyProcess;
    terminalMeta[id] = {
      agentId,
      projectId: projectId || null,
      profileNum,
      sessionId: (opts && opts.sessionId) || null,
    };
    // Quem é o agente deste pane — o renderer só sabe quando a thread foi
    // fixada; no "Automático" quem resolve é o authMode, aqui no main.
    claudeTurnGate.forget(id);
    codexTurnWatch.remove(id);
    if (testWindow && !testWindow.isDestroyed()) {
      // `events`: este pane VAI mandar eventos de turno? Claude sem hook
      // (Windows, helper ausente) fica na heurística em vez de ficar mudo.
      const events = opts.mode !== 'login' && (agentId === 'codex' || (agentId === 'claude' && !!noryaHookCmd));
      testWindow.webContents.send('agent-event', { spawnId: id, kind: 'spawned', agent: agentId, events, ui: 'tui' });
    }
    if (agentId === 'codex' && opts.mode !== 'login') {
      codexTurnWatch.add(id, {
        codexHome: env.CODEX_HOME,
        // codex sobe em account.dir e recebe a pasta por --cd (opts.cwd).
        cwd: opts.cwd || ptyCwd,
        sessionId: opts.mode === 'resume' ? opts.sessionId : null,
      });
    }

    // Return a result so callers that CAN observe it (the additive
    // spawn-terminal-checked invoke channel) know creation succeeded and on
    // which id/cwd. Fire-and-forget ipcMain.on callers simply ignore this.
    return { ok: true, id, cwd: ptyCwd };
  } catch (err) {
    if (terminalSizes.get(id) === initialSize) terminalSizes.delete(id);
    logError(`spawnTerminal(${account && account.num}/id=${id})`, err);
    // Report on the per-thread channel (id), not account.num — that's what the
    // renderer's thread tile subscribes to. Emit BOTH an error line and an exit
    // so the tile shows the failure and unsticks instead of hanging forever.
    if (testWindow && !testWindow.isDestroyed()) {
      testWindow.webContents.send(`terminal-data-${id}`,
        `\r\n\x1b[31m[failed to open terminal: ${err.message}]\x1b[0m\r\n`);
      testWindow.webContents.send(`terminal-exit-${id}`);
    }
    return { ok: false, id, error: String(err && err.message || err), code: err && err.code, details: err && err.details };
  }
}

// ── Crash-safe PTY I/O ──────────────────────────────────────────────────────
// A pty whose child already died but whose onExit hasn't fired yet still sits in
// `terminals[id]`. Calling .write()/.resize() on it throws synchronously and,
// unhandled, crashes the ENTIRE main process with "uncaughtException: write
// EPIPE" (observed in panel.log). These wrappers tear the dead entry down and
// notify every surface the terminal is gone, instead of taking the app with it.
function _dropDeadPty(id, err) {
  try { if (terminals[id]) terminals[id].kill(); } catch {}
  delete terminals[id];
  delete termBuffers[id];
  delete terminalMeta[id];
  terminalSizes.delete(id);
  forgetDevServer(id);
  _tokenCapturado.delete(id);
  try { if (testWindow && !testWindow.isDestroyed()) testWindow.webContents.send(`terminal-exit-${id}`); } catch {}
  if (err) logError(`pty-io(${id})`, err);
}
function safePtyWrite(id, data) {
  const t = terminals[id];
  if (!t) return;
  try { t.write(data); } catch (err) { _dropDeadPty(id, err); }
}
function safePtyResize(id, cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) return;
  const size = terminalSizes.get(id);
  // Mesmo tamanho: nada. Resize vira SIGWINCH e o Claude reimprime a conversa.
  if (size && size.cols === cols && size.rows === rows && terminals[id]) return;
  if (size) Object.assign(size, { cols, rows });
  const t = terminals[id];
  if (!t) return;
  try { t.resize(cols, rows); } catch (err) { _dropDeadPty(id, err); }
}

const QUOTA_CACHE_PATH      = path.join(NORYA_HOME, 'quota-cache.json');
const PROJECTS_PATH         = path.join(NORYA_HOME, 'projects.json');
const ARCHIVED_ACCOUNTS_DIR = path.join(NORYA_HOME, 'archived-accounts');

// Manter a máquina acordada enquanto há PTY trabalhando.
//
// `caffeinate` é binário do macOS. Fora dele o equivalente é o powerSaveBlocker
// do próprio Electron — mesma intenção, sem processo externo. Não usamos o
// powerSaveBlocker nos dois porque `caffeinate -s -i` é o comportamento
// verificado em produção há meses no Mac e não há motivo para mexer.
let caffeinateProc = null;
let powerBlockerId = null;
function startCaffeinate() {
  if (platform.isMac) {
    if (caffeinateProc) return;
    try {
      caffeinateProc = childSpawn('caffeinate', ['-s', '-i'], { detached: false, stdio: 'ignore' });
      caffeinateProc.on('exit', () => { caffeinateProc = null; });
    } catch (err) { logError('startCaffeinate', err); }
    return;
  }
  if (powerBlockerId != null) return;
  try { powerBlockerId = powerSaveBlocker.start('prevent-app-suspension'); }
  catch (err) { logError('startCaffeinate', err); }
}
function stopCaffeinate() {
  if (caffeinateProc) {
    try { caffeinateProc.kill(); } catch {}
    caffeinateProc = null;
  }
  if (powerBlockerId != null) {
    try { powerSaveBlocker.stop(powerBlockerId); } catch {}
    powerBlockerId = null;
  }
}

// ── Quando a máquina PODE dormir (2026-09-08) ────────────────────────────────
//
// O comentário acima sempre disse "enquanto há PTY trabalhando", mas o código
// não fazia isso: startCaffeinate() rodava UMA vez no boot e stopCaffeinate()
// só no quit. Medido em `pmset -g assertions`: com o Norya aberto — a tarde
// inteira, com tudo parado — o Mac segurava PreventUserIdleSystemSleep
// "asserting forever" e NUNCA entrava em idle sleep. Num Air na bateria, isso
// é o dia todo acordado sem ninguém usando.
//
// O sinal certo de "tem agente trabalhando" não é "existe PTY" (um PTY parado
// no prompt existe o dia inteiro), é SAÍDA RECENTE: enquanto o agente cospe
// texto ele está pensando/rodando e não pode levar um sleep no meio. Passados
// CAFFEINATE_IDLE_MS de silêncio total a asserção cai e o macOS volta a mandar
// na energia; qualquer byte novo de qualquer PTY reacende na hora.
const CAFFEINATE_IDLE_MS = 3 * 60 * 1000;
let _lastPtyOutputTs = 0;
let _caffeineTick = null;
function notePtyOutput() {
  _lastPtyOutputTs = Date.now();
  startCaffeinate();
  if (_caffeineTick) return;
  _caffeineTick = setInterval(() => {
    if (Date.now() - _lastPtyOutputTs < CAFFEINATE_IDLE_MS) return;
    stopCaffeinate();
    clearInterval(_caffeineTick); _caffeineTick = null;
  }, 30000);
}

// ── Tela sempre acesa: chave no topo do app (2026-10-10) ────────────────────
//
// É a chave ☀ do header, lembrada em norya-state.json (`keepAwake`, padrão
// desligada). É uma asserção NoDisplaySleep do macOS (a mesma de um vídeo
// tocando), que também segura o protetor de tela; cai sozinha quando o processo
// sai. Não mexe na política acima: o idle sleep do SISTEMA continua dependendo
// de saída recente de PTY, mas com a tela acesa o powerd também não dorme.
// Fechar a tampa ainda dorme.
let displayBlockerId = null;
function setDisplayAwake(on) {
  if (on && displayBlockerId == null) {
    try { displayBlockerId = powerSaveBlocker.start('prevent-display-sleep'); }
    catch (err) { logError('setDisplayAwake', err); }
  } else if (!on && displayBlockerId != null) {
    try { powerSaveBlocker.stop(displayBlockerId); } catch {}
    displayBlockerId = null;
  }
  return displayBlockerId != null;
}
function readKeepAwakePref() {
  try { return JSON.parse(fs.readFileSync(NORYA_STATE_PATH, 'utf8')).keepAwake === true; }
  catch { return false; }
}
ipcMain.handle('keep-awake-get', () => displayBlockerId != null);
ipcMain.handle('keep-awake-set', (_, on) => {
  const now = setDisplayAwake(on === true);
  try {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(NORYA_STATE_PATH, 'utf8')) || {}; } catch {}
    writeFileAtomic(NORYA_STATE_PATH, JSON.stringify({ ...cur, keepAwake: now }, null, 2));
  } catch (e) { logError('keep-awake state', e); }
  return now;
});

function readProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8')) || { projects: [] }; }
  catch { return { projects: [] }; }
}

// SSH stack (SSH_CONNECTIONS_PATH, sftpClients, readSSHConnections,
// writeSSHConnections, parseSSHConfig) removido junto com o Painel Operacional.

let _quotaCacheCorruptLogged = false;
function readQuotaCache() {
  try {
    return JSON.parse(fs.readFileSync(QUOTA_CACHE_PATH, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {}; // no cache yet — fine
    // Corrupt cache: log once, delete so QuotaManager's store rebuilds it cleanly.
    if (!_quotaCacheCorruptLogged) { _quotaCacheCorruptLogged = true; logError('readQuotaCache (corrupt — rebuilding)', err); }
    try { fs.unlinkSync(QUOTA_CACHE_PATH); } catch {}
    return {};
  }
}

function writeQuotaCache(cache) {
  try {
    fs.mkdirSync(path.dirname(QUOTA_CACHE_PATH), { recursive: true });
    writeFileAtomic(QUOTA_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    logError('writeQuotaCache', err);
  }
}

function parseRateLimitsResponse(result) {
  const snap = result && result.rateLimits;
  if (!snap) return null;
  const buildWindow = w => {
    if (!w) return null;
    const usedPct = typeof w.usedPercent === 'number' ? w.usedPercent : 0;
    const resetsAtMs = w.resetsAt ? w.resetsAt * 1000 : null;
    return {
      used_percent: usedPct,
      percent_left: 100 - usedPct,
      resets_at: w.resetsAt || null,
      resets_at_ms: resetsAtMs,
    };
  };
  let primary = null;
  let secondary = null;
  if (snap.primary && snap.secondary) {
    const short = (snap.primary.windowDurationMins || 0) <= 360 ? snap.primary : snap.secondary;
    const long  = (snap.primary.windowDurationMins || 0) <= 360 ? snap.secondary : snap.primary;
    primary   = buildWindow(short);
    secondary = buildWindow(long);
  } else if (snap.primary) {
    const w = snap.primary;
    if ((w.windowDurationMins || 0) <= 360) primary = buildWindow(w);
    else secondary = buildWindow(w);
  }
  const lefts = [primary, secondary].filter(Boolean).map(w => w.percent_left);
  const percentLeft = lefts.length ? Math.min(...lefts) : 0;
  const usedPercents = [primary, secondary].filter(Boolean).map(w => w.used_percent);
  const usedPercent = usedPercents.length ? Math.max(...usedPercents) : 0;
  return {
    primary,
    secondary,
    usedPercent,
    percentLeft,
    window: primary && secondary ? 'both' : (primary ? '5h' : 'weekly'),
    resetsAt: primary ? primary.resets_at_ms : (secondary ? secondary.resets_at_ms : null),
    used: null,
    total: null,
  };
}

const quotaRunning = {};
const quotaProcs = {};
const quotaErrorKinds = {}; // { [accountNum]: 'auth'|'timeout'|'exit'|'error' }

async function runQuotaBackground(account, opts) {
  if (!account) return null;
  const force = opts && opts.force;

  // QuotaManager is the single owner of the quota cache + real-time updates.
  // Delegate to it; the legacy app-server body below is kept only as a fallback
  // for the brief window before QuotaManager initializes (and for easy revert).
  if (quotaManager) {
    try { return await quotaManager.refresh(account.num, { force, provider: opts && opts.provider }); }
    catch (e) { logError('runQuotaBackground->QuotaManager', e); return null; }
  }

  if (quotaRunning[account.num] && !force) return null;

  // Kill existing proc when forcing a fresh run.
  if (force && quotaProcs[account.num]) {
    try { quotaProcs[account.num].kill(); } catch {}
    delete quotaProcs[account.num];
  }

  quotaRunning[account.num] = true;
  const { env } = buildAccountEnv(account);
  const nvmScript = path.join(NVM_DIR, 'nvm.sh');
  const shell = platform.shellBin();
  // No Windows o PATH já vem pronto no env (buildAccountEnv) e não há `exec`.
  const initCmd = platform.isWin
    ? 'codex app-server --listen stdio://'
    : [
        `[ -s "${nvmScript}" ] && . "${nvmScript}"`,
        'eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null',
        'exec codex app-server --listen stdio://',
      ].join('; ');
  return new Promise(resolve => {
    let buf = '';
    let stderrBuf = '';
    let done = false;
    let apiErrorObj = null;
    let proc;
    const finish = (parsed, reason) => {
      if (done) return;
      done = true;
      delete quotaRunning[account.num];
      delete quotaProcs[account.num];
      try { proc.kill(); } catch {}
      if (parsed) {
        delete quotaErrorKinds[account.num];
        const pLog = parsed.primary   ? `5h ${parsed.primary.percent_left}%`   : '5h —';
        const sLog = parsed.secondary ? `7d ${parsed.secondary.percent_left}%` : '7d —';
        logLine('quota', `#${account.num} parsed ${pLog} · ${sLog} via ${reason || 'unknown'}`);
        const cache = readQuotaCache();
        const prev = cache[String(account.num)] || {};
        cache[String(account.num)] = {
          ...parsed,
          manualReset: prev.manualReset || null,
          updatedAt: Date.now(),
        };
        writeQuotaCache(cache);
        if (testWindow && !testWindow.isDestroyed()) {
          testWindow.webContents.send('quota-updated', {
            num: account.num,
            ...parsed,
            updatedAt: Date.now(),
          });
        }
      } else {
        // Derive error kind from reason + stderr content for auth detection.
        let kind = reason === 'timeout' ? 'timeout' : 'error';
        if (kind !== 'timeout') {
          const hay = (stderrBuf + JSON.stringify(apiErrorObj || '')).toLowerCase();
          if (/auth|token|unauthorized|401|api.?key|invalid.?key|credentials/.test(hay)) kind = 'auth';
          else if (reason === 'exit') kind = 'timeout';
        }
        quotaErrorKinds[account.num] = kind;
        logLine('quota', `#${account.num} gave up (${reason || 'unknown'}, kind=${kind}) — buf length ${buf.length} stderr length ${stderrBuf.length}`);
        // Fallback: when the app-server gives no useful output, verify the
        // access_token directly via HTTP. ChatGPT-issued tokens can be revoked
        // server-side even before their exp time, so a clock check isn't enough.
        const verifyTokenAndMark = async () => {
          let isLoggedOut = kind === 'auth';
          let isNoCredit = false;
          if (!isLoggedOut) {
            try {
              const authPath = path.join(account.dir, '.codex', 'auth.json');
              const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
              const token = auth && auth.tokens && auth.tokens.access_token;
              if (token) {
                const code = await new Promise(res => {
                  try {
                    const u = new URL('https://chatgpt.com/backend-api/codex/models?client_version=0.133.0');
                    const req = https.request({
                      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
                      headers: { Authorization: 'Bearer ' + token },
                      timeout: 4000,
                    }, r => { res(r.statusCode || 0); r.resume(); });
                    req.on('error', () => res(0));
                    req.on('timeout', () => { try { req.destroy(); } catch {} res(0); });
                    req.end();
                  } catch { res(0); }
                });
                if (code === 401) isLoggedOut = true;
                else if (code === 402) isNoCredit = true; // payment required — billing issue
                const tag = isLoggedOut ? ' (logged out)' : isNoCredit ? ' (no credit)' : '';
                logLine('quota', `#${account.num} token verify → HTTP ${code}${tag}`);
              } else {
                isLoggedOut = true; // no token at all
              }
            } catch (e) { /* auth.json missing → treat as logged out */ isLoggedOut = true; }
          }
          if (isLoggedOut || isNoCredit) {
            try {
              const cache = readQuotaCache();
              const prev = cache[String(account.num)] || {};
              const next = { ...prev, updatedAt: Date.now() };
              if (isLoggedOut) { next.loggedOut = true; next.errorKind = 'auth'; delete next.noCredit; }
              if (isNoCredit) { next.noCredit = true; next.errorKind = 'no-credit'; delete next.loggedOut; }
              cache[String(account.num)] = next;
              writeQuotaCache(cache);
              const payload = { num: account.num, ...next };
              if (testWindow && !testWindow.isDestroyed()) testWindow.webContents.send('quota-updated', payload);
            } catch {}
          }
        };
        verifyTokenAndMark().catch(() => {});
      }
      resolve(parsed || null);
    };
    try {
      proc = childSpawn(shell, platform.shellArgs(initCmd), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: account.dir,
        env,
      });
      quotaProcs[account.num] = proc;
      logLine('quota', `#${account.num} spawned app-server`);
    } catch (err) {
      logError(`runQuotaBackground spawn(${account.num})`, err);
      delete quotaRunning[account.num];
      quotaErrorKinds[account.num] = 'timeout';
      resolve(null);
      return;
    }
    // Guard stdin against EPIPE: if the app-server exits before/while we write,
    // an unhandled stream 'error' crashes the whole app. Mirror codex-http.js.
    try { proc.stdin.on('error', () => {}); } catch {}
    const safeW = (s) => { try { if (proc.stdin && proc.stdin.writable !== false && !done) proc.stdin.write(s); } catch {} };
    proc.stderr.on('data', d => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 3000) stderrBuf = stderrBuf.slice(-3000);
    });
    proc.stdout.on('data', data => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let msg;
        try { msg = JSON.parse(t); } catch { continue; }
        if (msg.id === 1 && !msg.error) {
          safeW(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n');
        } else if (msg.id === 2) {
          if (msg.error) apiErrorObj = msg.error;
          finish(msg.error ? null : parseRateLimitsResponse(msg.result), 'api');
        }
      }
    });
    proc.on('exit', () => { if (!done) finish(null, 'exit'); });
    proc.on('error', err => { logError(`runQuotaBackground proc(${account.num})`, err); finish(null, 'error'); });
    setTimeout(() => {
      if (!done) {
        safeW(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-panel', version: '1.0' } } }) + '\n');
        logLine('quota', `#${account.num} initialize sent`);
      }
    }, 500);
    setTimeout(() => finish(null, 'timeout'), 20000);
  });
}

let testWindow = null;
function createTestWindow() {
  if (testWindow && !testWindow.isDestroyed()) {
    testWindow.focus();
    return;
  }
  const glassAtivo = uiPrefs.glassLigado() ? platform.glass : null;
  testWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    // `hiddenInset` (semáforo embutido na barra) só existe no macOS. No Windows
    // deixamos a barra nativa: um titleBarOverlay exigiria redesenhar os
    // controles de janela dentro do HTML, e o app não tem essa área hoje.
    ...(platform.isMac ? { titleBarStyle: 'hiddenInset' } : {}),
    // Vidro (2026-09-07, liquid glass): o desfoque do desktop é da JANELA
    // (NSVisualEffectView / Mica), não do CSS — backdrop-filter só desfoca o
    // que está dentro da página. A cor de fundo precisa ser transparente
    // para o material aparecer; a tinta escura/clara é pintada pelo body.
    // Material 'hud' e não 'sidebar': o sidebar do macOS tem tinta própria
    // pesada (quase opaco no escuro); o hud é o mais transparente e segue a
    // aparência (claro no tema claro). NORYA_VIBRANCY troca pra experimentar.
    // 2026-09-08: o vidro virou OPCIONAL e nasce desligado. platform.glass diz
    // o que a plataforma SABE fazer; ui-prefs diz o que o usuário PEDIU. Só
    // quando os dois concordam a janela nasce translúcida — ver ui-prefs.js
    // para a medição que motivou o padrão (≈25% de CPU a mais em tudo que
    // repinta, mais o xterm fora do caminho rápido).
    ...(glassAtivo === 'vibrancy'
      ? { vibrancy: process.env.NORYA_VIBRANCY || 'hud', visualEffectState: 'active', backgroundColor: '#00000000' }
      : glassAtivo === 'mica'
        ? { backgroundMaterial: 'mica', backgroundColor: '#00000000' }
        : { backgroundColor: '#ffffff' }),
    title: 'Norya',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      webviewTag: true,   // Norya browser renders tabs as <webview> in the DOM
    },
  });
  testWindow.loadFile('test-window.html');
  testWindow.on('closed', () => { testWindow = null; });
}

// ---------------------------------------------------------------------------
// Popup (window.open) hardening for the Norya browser.
//
// The browser renders tabs as <webview> elements. Each webview is hardened
// per-tab via its `preload` (browser-preload.js → canvas/WebGL/navigator/
// timezone overrides) and `webpreferences` (contextIsolation=no). But a page
// that calls window.open() — e.g. Microsoft/Outlook OAuth, Google sign-in —
// does NOT create a <webview>: with no window-open handler, Electron spawns a
// DEFAULT native BrowserWindow. That popup:
//   • inherits the opener's session/partition (cookies still apply)
//   • but gets NONE of the page-world fingerprint hardening (no preload)
//   • defaults to contextIsolation=true (webview uses false) and has no parent
//     → orphaned floating window + a fragile window.opener bridge, which is why
//       OAuth logins (Outlook) open a popup but never complete the sign-in.
//
// This handler intercepts window.open from any <webview> (and recursively from
// the popups it spawns, for nested OAuth) and re-creates the popup MIRRORING
// the opener webview: same session (→ mesmos cookies), e parented à janela do
// Norya, para ficar contido em vez de flutuar solto na mesa.
//
// 2026-07-09: o popup carregava `browser-preload.js` (deletado com o spoofing de
// fingerprint) e forçava contextIsolation:false para sustentá-lo. Um preload
// inexistente não derruba a janela no Electron — falha calado. Agora espelha a
// <webview> de verdade: sem preload, contextIsolation padrão (ON).

function installPopupHardening(contents, sessionRef) {
  if (!contents || contents.isDestroyed()) return;
  contents.setWindowOpenHandler(({ url }) => {
    // Allow real web popups AND the blank/empty bootstrap popups that OAuth
    // libraries (e.g. Microsoft MSAL.js) open first via window.open('about:blank')
    // before navigating them to the auth URL. Deny only exotic schemes
    // (file:, javascript:, data:, custom app schemes) — those have no business
    // being a popup and are a phishing / local-file-access surface.
    let ok = false;
    if (!url || url === 'about:blank') {
      ok = true;
    } else {
      try {
        const u = new URL(url);
        ok = u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'about:';
      } catch {
        ok = true; // relative/empty target — popup inherits the tab's session anyway
      }
    }
    if (!ok) {
      logLine('popup', `denied non-web window.open → ${String(url).slice(0, 120)}`);
      return { action: 'deny' };
    }
    logLine('popup', `hardened popup → ${String(url).slice(0, 120)}`);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: (testWindow && !testWindow.isDestroyed()) ? testWindow : undefined,
        width: 520,
        height: 680,
        autoHideMenuBar: true,
        title: 'Norya — login',
        webPreferences: {
          session: sessionRef,      // mesma sessão + cookies da aba que abriu
          contextIsolation: true,   // espelha a <webview>
          sandbox: true,
          nodeIntegration: false,
        },
      },
    };
  });
  // Cover nested popups (popup → another window.open during an OAuth chain).
  contents.on('did-create-window', (win) => {
    try { installPopupHardening(win.webContents, sessionRef); } catch {}
  });
}

app.on('web-contents-created', (_event, contents) => {
  try {
    if (contents.getType() === 'webview') {
      // Capture the webview's own session so popups share its Tor circuit/cookies.
      installPopupHardening(contents, contents.session);
    }
  } catch (err) {
    logError('web-contents-created popup hardening', err);
  }
});

// Persist the full PIP window bounds (size + position) between sessions, so
// the user keeps the layout they like. Clamped to a visible display on load.



// Persist mini-pill position between sessions so it stays where the user
// dragged it. Falls back to top-right corner of the primary display.

// Tiny always-on-top floating pill that appears when the user hides the PIP.
// Lets them bring it back without going to the main window. Draggable by the
// left half (handle); right side is a click button that restores the PIP.


function buildAppMenu() {
  const isMac = platform.isMac;
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Norya Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click() { createTestWindow(); },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

// Read/write the user's preferred login browser per profile.
// Stored inside the existing profile.json as `loginBrowser: 'norya'|'system'|null`.
function readLoginBrowserChoice(profileNum) {
  try {
    const p = path.join(ACCOUNTS_DIR, String(profileNum), 'profile.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j.loginBrowser || null;
  } catch { return null; }
}
function writeLoginBrowserChoice(profileNum, choice) {
  try {
    const p = path.join(ACCOUNTS_DIR, String(profileNum), 'profile.json');
    let j = {};
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    j.loginBrowser = choice;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
    return true;
  } catch (e) { logError('writeLoginBrowserChoice', e); return false; }
}

// Bookmarks per profile (simple JSON list).
function bookmarksPath(profileNum) {
  return path.join(ACCOUNTS_DIR, String(profileNum), 'browser', 'bookmarks.json');
}
function readBookmarks(profileNum) {
  try { return JSON.parse(fs.readFileSync(bookmarksPath(profileNum), 'utf8')); } catch { return []; }
}
function writeBookmarks(profileNum, list) {
  const p = bookmarksPath(profileNum);
  // 0o700 dir + 0o600 file so only the owning OS user can read bookmarks
  // (avoids leaking browsing intent on multi-user machines).
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(p), 0o700); } catch {}
  fs.writeFileSync(p, JSON.stringify(list, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
}

// Uso da assinatura SuperGrok de UM perfil: sobe a TUI escondida com o env do
// perfil (HOME=accounts/N, onde `grok login` guardou a credencial — é lá que
// providersStatusFor procura `.grok`). Caro (~10 s) → só sob demanda, pelo ↻
// do painel. Injetado no QuotaManager como `grokFetch`.
function grokUsageFor(profileNum) {
  const GrokUsageFetcher = require('./quota/grok-usage');
  const account = loadAccounts().find(a => a.num === profileNum)
    || { num: profileNum, dir: path.join(ACCOUNTS_DIR, String(profileNum)) };
  const { env } = buildAccountEnv(account);
  const fetcher = new GrokUsageFetcher({
    pty,
    shellPrelude: agentShellPrelude,   // mesmo PATH do spawn
    shell: platform.shellBin(),
    shellArgs: cmd => platform.shellArgs(cmd),
    cwd: platform.scratchCwd(),
    execPrefix: platform.execPrefix,
    env,
    logFn: logLine,
  });
  return fetcher.fetch();
}

// Account context for the quota subsystem — everything the fetchers need to
// spawn a CLI for a profile, without coupling them to main.js internals.
// `provider` (opcional) diz QUAL CLI vai ser sondada: a sonda do Claude pode
// rodar num perfil cujo padrão é Codex (token isolado), e aí o env é o do Claude.
function getAccountContext(profileNum, provider) {
  const account = loadAccounts().find(a => a.num === profileNum)
    || { num: profileNum, dir: path.join(ACCOUNTS_DIR, String(profileNum)) };
  const { env } = buildAccountEnv(account);
  let profile = null;
  try { profile = readProfile(profileNum); } catch {}
  const authMode = profile ? profile.authMode : null;
  const quotaProviders = Array.isArray(account.quotaProviders)
    ? account.quotaProviders
    : quotaProvidersFor(profile, providersStatusFor(account.dir, profile, getClaudeAuthGlobal(account.dir)));
  const defaultProvider = QuotaManager.PROVIDER_BY_AUTH[authMode] || null;
  const claudeProbe = (provider || defaultProvider) === 'claude';

  // claude reads OAuth from the macOS Keychain keyed by the REAL OS user, so its
  // quota probe (claude-status /status) must run with the real USER/LOGNAME/HOME
  // — exactly like spawnTerminal does for claude profiles. Without this the
  // hidden claude PTY can't read the Keychain and falsely reports "logged out".
  // Só no macOS: fora dele não há Keychain e desfazer o HOME do perfil faria a
  // sonda medir a quota da conta errada (a mesma para todos os perfis).
  if (claudeProbe && profile && profile.claudeOauthToken) {
    // Perfil isolado: o token manda (espelha spawnTerminal). Sem isto a sonda
    // leria o Keychain e mediria a conta ERRADA.
    env[AGENT_BY_ID.claude.creds.env] = profile.claudeOauthToken;
    env.CLAUDE_CONFIG_DIR = path.join(account.dir, '.claude');
    delete env.ANTHROPIC_API_KEY;
  } else if (claudeProbe && platform.isMac) {
    env.HOME = process.env.HOME || REAL_HOME;
    delete env.ANTHROPIC_API_KEY;
  } else if (claudeProbe) {
    delete env.ANTHROPIC_API_KEY;
  }

  return {
    num: profileNum,
    dir: account.dir,
    env,
    authMode,
    quotaProviders,
    defaultProvider,
    shell: platform.shellBin(),
    shellArgs: cmd => platform.shellArgs(cmd),
    prelude: agentShellPrelude(), // mesma instalação que a TUI e o atualizador
    execPrefix: platform.execPrefix,
    nvmScript: path.join(NVM_DIR, 'nvm.sh'),
  };
}

// Forward BrowserManager events to the renderer so the UI auto-refreshes.
function _forwardBrowserEvent(eventName) {
  return (payload) => {
    if (testWindow && !testWindow.isDestroyed()) {
      testWindow.webContents.send('norya-browser-event', { event: eventName, payload });
    }
  };
}

app.whenReady().then(() => {
  logLine('whenReady', `HOME=${REAL_HOME} ACCOUNTS_DIR=${ACCOUNTS_DIR}`);
  setDisplayAwake(readKeepAwakePref());

  try {
    // We don't have a single mainWindow at this point — pass a thunk that
    // resolves to testWindow each time BrowserManager needs it.
    browserManager  = new BrowserManager({
      mainWindow: { get: () => testWindow, getBounds: () => (testWindow && !testWindow.isDestroyed() ? testWindow.getBounds() : { x:0, y:0, width:1100, height:720 }),
                    get contentView() { return testWindow && !testWindow.isDestroyed() ? testWindow.contentView : null; } },
    });
    authFlowRouter  = new AuthFlowRouter({ browserManager });

    // Agent bridge: MCP/CLI agent tab operations are forwarded to the renderer,
    // which owns the <webview> tabs. Request/response over IPC with a reqId.
    const _agentPending = new Map();
    function _agentExec(action, payload) {
      return new Promise((resolve, reject) => {
        if (!testWindow || testWindow.isDestroyed()) return reject(new Error('browser window not open'));
        const reqId = crypto.randomBytes(6).toString('hex');
        const timer = setTimeout(() => {
          if (_agentPending.has(reqId)) { _agentPending.delete(reqId); reject(new Error('agent op timeout')); }
        }, 30000);
        _agentPending.set(reqId, { resolve, reject, timer });
        testWindow.webContents.send('norya-browser-agent', { reqId, action, payload });
      });
    }
    // Auto-open usa a MESMA ponte do MCP: abre o painel se preciso e cria a aba.
    // Só o `url` importa aqui; o perfil é o ativo do painel. `by:'user'` porque
    // isto vem de um `open <url>` disparado no PTY — intenção do usuário (login
    // OAuth, preview) — e não pode entrar na faxina de abas de agente.
    openTabInNorya = (url) => _agentExec('open-tab', { url, by: 'user' });

    ipcMain.on('norya-browser-agent-reply', (_, { reqId, ok, result, error }) => {
      const p = _agentPending.get(reqId);
      if (!p) return;
      clearTimeout(p.timer); _agentPending.delete(reqId);
      ok ? p.resolve(result) : p.reject(new Error(error || 'agent op failed'));
    });
    // Object with the surface mcp-server expects (forwards to renderer webviews).
    const agentBrowser = {
      openTab:      (profileId, url, opts) => _agentExec('open-tab', { profileId, url, opts }),
      listTabs:     (profileId)            => _agentExec('list-tabs', { profileId }),
      closeTab:     (profileId, tabId)     => _agentExec('close-tab', { profileId, tabId }),
      setActiveTab: (profileId, tabId)     => _agentExec('set-active-tab', { profileId, tabId }),
      navigateTab:  (profileId, tabId, action, params) => _agentExec('navigate-tab', { profileId, tabId, action, params }),
      finishAgent:  (profileId)            => _agentExec('finish', { profileId }),
    };
    mcpServer       = new MCPServer({ browserManager: agentBrowser });

    // Wire event forwarding to renderer
    // Só panel-open/panel-close: os eventos tab-* eram emitidos pelo caminho
    // WebContentsView, removido em 2026-07-10. As abas vivem no renderer.
    ['panel-open', 'panel-close'].forEach(e =>
      browserManager.on(e, _forwardBrowserEvent(e)));
    // Auth flow router → tell the renderer to open the OAuth URL in a fresh tab,
    // and bring Norya to the FRONT so the user sees the Norya login tab (the
    // system browser also opens — codex uses macOS LaunchServices — but Norya
    // pops over it so the user logs in here).
    authFlowRouter.on('auth-url', ({ profileId, url }) => {
      logLine('auth-url', `profile=${profileId} url=${url.slice(0, 80)}`);
      if (testWindow && !testWindow.isDestroyed()) {
        testWindow.webContents.send('norya-browser-event', { event: 'auth-url', payload: { profileId, url } });
        try { if (testWindow.isMinimized()) testWindow.restore(); testWindow.show(); testWindow.focus(); } catch {}
        try { app.focus({ steal: true }); } catch {}
      }
    });
    authFlowRouter.on('auth-complete', ({ profileId }) => {
      logLine('auth-complete', `profile=${profileId}`);
      // Renderer closes the auth tab + shows the "login done" toast.
      if (testWindow && !testWindow.isDestroyed()) {
        testWindow.webContents.send('norya-browser-event', { event: 'auth-complete', payload: { profileId } });
      }
    });
    authFlowRouter.on('auth-timeout', ({ profileId }) => logLine('auth-timeout', `profile=${profileId}`));
    logLine('norya-browser', 'modules initialized');
  } catch (e) { logError('norya-browser init', e); }

  // ── Real-time quota: instantiate QuotaManager (owns the cache going forward) ──
  try {
    quotaManager = new QuotaManager({
      getAccountContext,
      getClaudeCredential,      // Claude por HTTP (endpoint do /usage)
      grokFetch: grokUsageFor,  // Grok por perfil, sob demanda
      cachePath: QUOTA_CACHE_PATH,
      childSpawn,
      https,
      pty,
      fs,
      shellPrelude: agentShellPrelude,   // mesmo PATH do spawn (fix exit 127 do probe Claude)
      logFn: (msg) => logLine('quota', msg),
    });
    quotaManager.start();   // loads existing cache into memory
    // Live updates → renderer (same event the UI already listens to) + WS clients.
    // `key` = "12" (espelho do padrão) ou "12:codex" (por provider). O renderer
    // guarda em st.quota[key]; leitores antigos seguem em st.quota["12"].
    quotaManager.on('quota', ({ key, num, snapshot }) => {
      const payload = { key, num, ...snapshot };
      if (testWindow && !testWindow.isDestroyed()) testWindow.webContents.send('quota-updated', payload);
    });
    logLine('quota', 'QuotaManager initialized');
    // Boot fetch: pull every profile's quota in parallel right away so the UI
    // shows fresh numbers at startup instead of stale cache.
    setTimeout(() => {
      try {
        const profiles = loadAccounts().map(a => ({ num: a.num, authMode: a.authMode }));
        quotaManager.refreshAll(profiles).catch(e => logError('quota boot refreshAll', e));
      } catch (e) { logError('quota boot', e); }
    }, 1200);
    // Periodic refresh — LIGHT. Só perfis com PTY VIVO, a cada 120 s (um codex
    // app-server por perfil). Claude entra aqui também desde 2026-09-08: virou
    // um GET (quota/claude-http.js); a TUI escondida só sobe se o token for
    // recusado, e nesse caso o breaker de auth segura repetições.
    setInterval(() => {
      if (!quotaManager) return;
      try {
        const liveProfiles = new Set();
        for (const id in terminalMeta) {
          if (terminals[id] && terminalMeta[id] && terminalMeta[id].profileNum != null) {
            liveProfiles.add(terminalMeta[id].profileNum);
          }
        }
        const profiles = loadAccounts()
          .filter(a => liveProfiles.has(a.num))
          .map(a => ({ num: a.num }));
        if (profiles.length) quotaManager.refreshAll(profiles).catch(() => {});
      } catch {}
    }, 120000);
    // Claude por HTTP é barato: a cada 5 min, todo perfil que mostra o cartão do
    // Claude no painel Uso — com ou sem PTY vivo (o uso vem de outros lugares
    // também: claude.ai, outro Mac).
    setInterval(() => {
      if (!quotaManager) return;
      try {
        for (const a of loadAccounts()) {
          if ((a.quotaProviders || []).includes('claude')) {
            quotaManager.refresh(a.num, { provider: 'claude' }).catch(() => {});
          }
        }
      } catch {}
    }, 5 * 60 * 1000);
  } catch (e) { logError('quota init', e); }

  createTestWindow();
  Menu.setApplicationMenu(buildAppMenu());
  // Não acende mais no boot: quem acende é notePtyOutput(), no 1º byte de PTY.
  // App aberto e parado = Mac livre pra dormir.
  startOpenUrlServer();
  startAgentEventServer();
  setupPet();

  // ── Norya Browser IPC handlers ─────────────────────────────────────────────
  function _bm() {
    if (!browserManager) throw new Error('browserManager not initialized');
    return browserManager;
  }
  // Panel open/close now = session prep/teardown (renderer renders <webview>s).
  ipcMain.handle('norya-browser:open-panel',        (_, { profileId, opts }) => { _activeBrowserProfile = profileId; return _bm().prepareSession(profileId, opts || {}); });
  ipcMain.handle('norya-browser:close-panel',       (_, { profileId })       => { if (_activeBrowserProfile === profileId) _activeBrowserProfile = null; return _bm().teardownSession(profileId); });
  ipcMain.handle('norya-browser:is-panel-open',     (_, { profileId })       => _bm().isPanelOpen(profileId));
  // Wipe explícito de cookies/storage do perfil (botão nas settings do browser).
  // Desde 2026-07-14 é o ÚNICO caminho de limpeza — fechar painel/app preserva.
  ipcMain.handle('norya-browser:clear-data',        (_, { profileId })       => _bm().clearData(profileId));

  // Emulação de device do dock (2026-08-01). O renderer manda o id do
  // webContents da <webview> (wv.getWebContentsId()) + os params montados por
  // browser/device-presets.js; aqui só se aplica.
  //
  // GUARDA: só `getType() === 'webview'`. Sem isso, um id errado — 1 é a
  // própria janela do app — emularia o Norya inteiro em 1440×900 escalado, e
  // não haveria como sair pela UI, já que a UI é o que estaria deformado.
  ipcMain.handle('norya-browser:emulate', (_, { webContentsId, params }) => {
    const { webContents } = require('electron');
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return { ok: false, reason: 'gone' };
    if (wc.getType() !== 'webview') return { ok: false, reason: 'not-a-webview' };
    if (params) wc.enableDeviceEmulation(params);
    else wc.disableDeviceEmulation();
    return { ok: true };
  });

  // ── Motor de atenção (2026-07-15) ────────────────────────────────────────
  // Badge do Dock com o nº de panes aguardando o usuário; clique no banner
  // traz o app pra frente (o renderer foca o pane certo em seguida).
  ipcMain.on('attention-badge', (_, { count }) => {
    try {
      if (app.dock) { app.dock.setBadge(count ? String(count) : ''); return; }
      // Windows não tem badge no ícone: o equivalente é o overlay icon na
      // taskbar. Desenhamos um disco com o número — sem arquivo de imagem,
      // porque o ícone muda a cada contagem.
      if (testWindow && !testWindow.isDestroyed()) {
        testWindow.setOverlayIcon(count ? badgeOverlayIcon(count) : null,
          count ? `${count} pane(s) aguardando` : '');
      }
    } catch (e) { logError('attention-badge', e); }
  });
  ipcMain.on('attention-focus-app', () => {
    try {
      if (testWindow && !testWindow.isDestroyed()) {
        if (testWindow.isMinimized()) testWindow.restore();
        testWindow.show();
        testWindow.focus();
      }
      app.focus({ steal: true });
    } catch {}
  });

  // Fingerprint-hardening params for <webview> preloads (which can't receive


  // Bookmarks
  ipcMain.handle('norya-browser:bookmarks-list',   (_, { profileId }) => readBookmarks(profileId));
  ipcMain.handle('norya-browser:bookmarks-add',    (_, { profileId, url, title }) => {
    const list = readBookmarks(profileId);
    const id = crypto.randomBytes(4).toString('hex');
    list.push({ id, url, title, addedAt: new Date().toISOString() });
    writeBookmarks(profileId, list);
    return { id };
  });
  ipcMain.handle('norya-browser:bookmarks-remove', (_, { profileId, id }) => {
    writeBookmarks(profileId, readBookmarks(profileId).filter(b => b.id !== id));
    return true;
  });


  // Login browser choice
  ipcMain.handle('norya-browser:login-set-choice', (_, { profileId, choice, remember }) => {
    if (remember) writeLoginBrowserChoice(profileId, choice);
    return { ok: true };
  });
  ipcMain.handle('norya-browser:login-get-choice', (_, { profileId }) => readLoginBrowserChoice(profileId));

  ipcMain.handle('get-accounts', () => {
    const accs = loadAccounts();
    logLine('get-accounts', `returning ${accs.length} accounts`);
    return accs;
  });

  // ── Grid state persistence (disk mirror of localStorage) ────────────────
  // Renderer keeps state in localStorage as source of truth; this disk file
  // exists so users can inspect / back up / migrate it. Writes are throttled
  // by the renderer (called when grid changes).
  const GRID_STATE_PATH = path.join(NORYA_HOME, 'grid-state.json');
  ipcMain.handle('grid-state-save', (_, data) => {
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
      writeFileAtomic(GRID_STATE_PATH, JSON.stringify(data, null, 2));
      return true;
    } catch (err) { logError('grid-state-save', err); return false; }
  });

  ipcMain.on('terminal-input', (_, { id, data }) => {
    safePtyWrite(id, data);
    // Desempate do rollout do Codex: quem apertou Enter criou a sessão.
    codexTurnWatch.noteInput(id);
  });

  // Pane em modo chat: mensagem, parar o turno, responder aprovação.
  // attachments = [{ path, image }] (caminhos absolutos); steer = "enviar
  // agora" com turno rodando (Codex: turn/steer; Claude: entra na fila da CLI).
  ipcMain.on('chat-send', (_, { id, text, attachments, steer } = {}) => {
    const c = chats[id];
    const att = Array.isArray(attachments) ? attachments.filter(a => a && typeof a.path === 'string').slice(0, 20) : [];
    if (c && typeof text === 'string' && (text.trim() || att.length)) c.send(text, att, { steer: !!steer });
  });
  // "@arquivo" do composer: arquivos da pasta da sessão ranqueados pela busca.
  ipcMain.handle('chat-files', async (_, { id, query } = {}) => {
    const meta = terminalMeta[id];
    try { return await chatFiles.searchFiles(meta && meta.cwd, String(query || '').slice(0, 200), 30); }
    catch (e) { logError('chat-files', e); return []; }
  });
  // Imagem colada (print, cópia do navegador): vira arquivo pra CLI ler.
  // ~/.norya/chat-uploads/<dia>/, 0600, apagada depois de 7 dias.
  ipcMain.handle('chat-save-attachment', async (_, { name, data } = {}) => {
    try {
      const buf = Buffer.from(data || []);
      if (!buf.length || buf.length > 50 * 1024 * 1024) return null;
      const root = path.join(NORYA_HOME, 'chat-uploads');
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(root, day);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const safe = String(name || 'imagem.png').replace(/[^\w.\-]+/g, '_').slice(-80) || 'imagem.png';
      const file = path.join(dir, `${Date.now().toString(36)}-${safe}`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      try {
        const limite = Date.now() - 7 * 864e5;
        for (const d of fs.readdirSync(root)) {
          const t = Date.parse(d);
          if (t && t < limite) fs.rmSync(path.join(root, d), { recursive: true, force: true });
        }
      } catch {}
      return file;
    } catch (e) { logError('chat-save-attachment', e); return null; }
  });
  ipcMain.handle('chat-pick-files', async (_, { id } = {}) => {
    const meta = terminalMeta[id];
    const r = await dialog.showOpenDialog(testWindow, {
      properties: ['openFile', 'multiSelections'],
      defaultPath: (meta && meta.cwd) || os.homedir(),
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.on('chat-interrupt', (_, id) => { const c = chats[id]; if (c) c.interrupt(); });
  // Seletor do composer: modelo / esforço / acesso (este só no Codex).
  ipcMain.on('chat-config', (_, { id, model, effort, access } = {}) => {
    const c = chats[id];
    if (c && c.configure) c.configure({ model, effort, access });
  });
  // Link clicado na conversa: mesmo destino do `open` das CLIs (navegador do Norya).
  ipcMain.on('chat-open-url', (_, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) routeUrlToNorya(url, 'chat');
  });
  ipcMain.on('chat-approve', (_, { id, reqId, ok }) => { const c = chats[id]; if (c) c.approve(reqId, !!ok); });

  ipcMain.on('terminal-resize', (_, { id, cols, rows }) => {
    safePtyResize(id, cols, rows);
  });

  ipcMain.on('spawn-terminal', async (_, payload) => {
    const account = payload && payload.account ? payload.account : payload;
    const opts = payload && payload.account ? payload : {};
    await spawnTerminal(account, opts);
    runQuotaBackground(account).catch(err => logError('quota on spawn', err));
  });

  // ── NEW ADDITIVE CHANNEL (arch fix 2026-05-28): spawn-terminal-checked ──────
  // Identical payload shape to the fire-and-forget 'spawn-terminal' above
  // ({ account, ...opts } OR a bare account), but invoke-based so the renderer
  // can AWAIT the spawn result instead of guessing. This makes create-thread
  // reliable: the caller learns immediately whether the PTY started and on
  // which id/cwd, or why it failed (e.g. concurrency cap, missing cwd).
  //   Returns: { ok:true, id, cwd } | { ok:false, id, error, code?, details? }
  // The existing 'spawn-terminal' on-channel is UNCHANGED — old callers keep
  // working. Renderer should pass opts.spawnId (per-thread id) and opts.cwd
  // (the chosen folder); the spawn path honors both.
  ipcMain.handle('spawn-terminal-checked', async (_, payload) => {
    const account = payload && payload.account ? payload.account : payload;
    const opts = payload && payload.account ? payload : {};
    if (!account || account.num == null) {
      return { ok: false, error: 'spawn-terminal-checked: missing account' };
    }
    let result;
    try {
      result = await spawnTerminal(account, opts);
    } catch (err) {
      // spawnTerminal handles its own errors and returns a result, but guard
      // against an unexpected synchronous throw so the renderer always gets a
      // structured response instead of a rejected invoke.
      result = { ok: false, error: String(err && err.message || err) };
    }
    runQuotaBackground(account).catch(err => logError('quota on spawn', err));
    return result || { ok: false, error: 'spawn returned no result' };
  });

  // ── Norya PIP (grid mirror) ──────────────────────────────────────────────
  // The test-window asks main to open the PIP and registers which spawns to
  // mirror. Main creates the always-on-top window and pushes init/state.
  // Closing the PIP window keeps all PTYs alive.

  // Sync = update existing PIP, NEVER create. Used by test-window when threads
  // are added/removed from the grid. If the PIP isn't open, this is a no-op.




  // Mini ▶/⏸ toggle: show/hide the PIP grid window. Mini stays alive.

  // Mini ✕: kill the mini AND the PIP entirely

  // Header-of-PIP ✕ button (inside the grid window) — closes the PIP but
  // leaves the mini alive so the user can reopen.

  // Header-of-PIP Hide button — same as toggle (hide window, keep mini)

  // Ghost mode — make the PIP click-through so the user can interact with
  // apps underneath. Renderer also dims opacity via CSS. The floating
  // "Restaurar" button uses forward:true so its clicks still register.

  // Pane removed from PIP (user clicked ✕). PTY keeps running — only mirror is dropped.

  // PIP asks main window to spawn a new thread / fork / change-folder on its behalf.




  // PIP asks for the current buffer to redraw (e.g. after a big resize that
  // could leave stale wrapped lines visible).

  ipcMain.handle('list-threads', (_, payload) => {
    const folder = typeof payload === 'object' && payload !== null ? payload.folder : null;

    // Collect ALL sqlite paths: active accounts + archived (deleted) accounts + system db.
    // Each entry tracks accountNum so threads can be attributed to their account.
    const dbEntries = []; // { path, accountNum }
    for (const base of [ACCOUNTS_DIR, ARCHIVED_ACCOUNTS_DIR]) {
      if (!fs.existsSync(base)) continue;
      for (const n of fs.readdirSync(base)) {
        if (isNaN(n)) continue;
        const p = path.join(base, n, '.codex', 'state_5.sqlite');
        if (fs.existsSync(p)) dbEntries.push({ path: p, accountNum: parseInt(n) });
      }
    }
    const systemDb = path.join(REAL_HOME, '.codex', 'state_5.sqlite');
    if (fs.existsSync(systemDb)) dbEntries.push({ path: systemDb, accountNum: 0 });

    const SQL = `SELECT id,title,cwd,updated_at,updated_at_ms,first_user_message,tokens_used,model,git_branch,git_sha,git_origin_url FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 200`;

    // No macOS quem lê é o `sqlite3` da linha de comando — comportamento em
    // produção há meses, não se mexe. O Windows não tem esse binário: lá
    // usamos o node:sqlite que o app JÁ usa para escrever (thread-rename,
    // thread-delete). Read-only para não esbarrar em DB travado por uma CLI viva.
    const lerThreads = (dbPath) => lerThreadsCached(dbPath, lerThreadsRaw);
    const lerThreadsRaw = (dbPath) => {
      if (!platform.isWin) {
        const raw = execFileSync('sqlite3', ['-json', dbPath, SQL], {
          encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(raw || '[]');
      }
      if (!DatabaseSync) throw new Error('node:sqlite indisponível');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return db.prepare(SQL).all(); }
      finally { try { db.close(); } catch {} }
    };

    const byId = new Map();
    threadsDbCacheSweep(dbEntries.map(e => e.path));
    for (const { path: dbPath, accountNum } of dbEntries) {
      try {
        const rows = lerThreads(dbPath);
        for (const r of rows) {
          r.accountNum = accountNum;
          r.provider = 'codex';
          if (!byId.has(r.id)) byId.set(r.id, r);
        }
      } catch {
        // Silently skip — likely empty/locked archived DB. Avoid log spam.
      }
    }

    // Rollout JSONL fallback for threads not yet written to any sqlite (active + archived).
    const rolloutDirs = [{ dir: path.join(REAL_HOME, '.codex', 'sessions'), accountNum: 0 }];
    for (const base of [ACCOUNTS_DIR, ARCHIVED_ACCOUNTS_DIR]) {
      if (!fs.existsSync(base)) continue;
      for (const n of fs.readdirSync(base).filter(x => !isNaN(x))) {
        rolloutDirs.push({ dir: path.join(base, n, '.codex', 'sessions'), accountNum: parseInt(n) });
      }
    }
    const rolloutSweep = beginRolloutMetaSweep();
    for (const { dir, accountNum } of rolloutDirs) {
      try {
        const files = listRolloutFilesInDir(dir).slice(0, 60);
        for (const f of files) {
          const info = readRolloutMeta(f.path);
          if (!info || !info.sessionId) continue;
          if (byId.has(info.sessionId)) continue;
          byId.set(info.sessionId, {
            id: info.sessionId,
            title: info.title || '(recent session)',
            cwd: info.cwd || '',
            first_user_message: info.firstUser || '',
            updated_at_ms: Math.round(f.mtime),
            updated_at: Math.round(f.mtime / 1000),
            accountNum,
            fromRollout: true,
            provider: 'codex',
          });
        }
      } catch (err) {
        logError(`list-threads rollout(${dir})`, err);
      }
    }
    endRolloutMetaSweep(rolloutSweep);

    // Merge aider threads (Norya-managed; not in any sqlite/sessions/)
    try {
      const aiderList = readAiderThreads();
      for (const t of aiderList) {
        if (byId.has(t.id)) continue;
        byId.set(t.id, {
          id: t.id,
          title: t.title || '(aider task)',
          cwd: t.cwd || '',
          first_user_message: t.firstUser || '',
          updated_at_ms: t.updatedAt ? new Date(t.updatedAt).getTime() : Date.now(),
          updated_at: t.updatedAt ? Math.round(new Date(t.updatedAt).getTime() / 1000) : Math.round(Date.now() / 1000),
          accountNum: t.accountNum,
          provider: 'aider',
        });
      }
    } catch (err) { logError('list-threads aider', err); }

    // Merge Claude threads — scan ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
    // claude uses HOME=REAL_HOME for OAuth (Keychain), so all profile-claude
    // threads share this directory. We pick the most recent UUID per file by
    // mtime; cwd is read from the first line that has a `cwd` field.
    // Threshold: only list sessions modified AFTER the user enabled this
    // feature (so the user's pre-existing claude history doesn't flood the
    // sidebar). The threshold timestamp is stored once and persists.
    try {
      loadClaudeMetaCache();
      // macOS: só o ~/.claude do HOME real. Windows: o de cada perfil também
      // (claudeProjectRoots) — lá cada perfil tem o seu USERPROFILE.
      const claudeRoots = claudeProjectRoots();
      const thresholdPath = path.join(NORYA_HOME, '.claude-threshold');
      let claudeThreshold = 0;
      try {
        if (fs.existsSync(thresholdPath)) {
          claudeThreshold = parseInt(fs.readFileSync(thresholdPath, 'utf8'), 10) || 0;
        } else {
          claudeThreshold = Date.now();
          fs.mkdirSync(path.dirname(thresholdPath), { recursive: true });
          fs.writeFileSync(thresholdPath, String(claudeThreshold));
        }
      } catch (e) { logError('claude threshold init', e); }
      for (const { dir: claudeProjectsDir, accountNum: claudeAccountNum } of claudeRoots) if (fs.existsSync(claudeProjectsDir)) {
        const sessionUuidRe = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
        const projects = fs.readdirSync(claudeProjectsDir);
        for (const projDir of projects) {
          const fullProjDir = path.join(claudeProjectsDir, projDir);
          let entries;
          try { entries = fs.readdirSync(fullProjDir); } catch { continue; }
          // Most-recent first, and consider more than before so real threads
          // aren't crowded out by Claude Code's many internal compaction
          // sessions (which get filtered out below).
          const sessions = entries.filter(f => sessionUuidRe.test(f))
            .map(f => { let mt = 0; try { mt = fs.statSync(path.join(fullProjDir, f)).mtimeMs; } catch {} return { f, mt }; })
            .sort((a, b) => b.mt - a.mt).slice(0, 80).map(x => x.f);
          for (const fname of sessions) {
            const m = fname.match(sessionUuidRe);
            if (!m) continue;
            const sessionId = m[1];
            if (byId.has(sessionId)) continue;
            const filePath = path.join(fullProjDir, fname);
            let stat;
            try { stat = fs.statSync(filePath); } catch { continue; }
            // Only include sessions modified after the threshold (= when the
            // feature was first enabled). Pre-existing history stays hidden.
            if (stat.mtimeMs < claudeThreshold) continue;
            // Resolve title/cwd/sidechain, cached by (sessionId, mtime) so we
            // only re-read changed files. Claude Code's own /resume title is an
            // `ai-title` line written ~60KB into the file (after the first turn),
            // so we read a 128KB head and prefer it over the raw first message —
            // that's why Norya used to show "Review this change…" 37x while
            // /resume shows distinct AI titles.
            let meta = claudeMetaCache.get(sessionId);
            if (!meta || meta.mtime !== stat.mtimeMs) {
              // 128 KB covers most ai-titles (~60 KB in). If it's missing and the
              // file is bigger, scan up to 2 MB — in large sessions the ai-title
              // lands hundreds of KB deep (and so does the "You are summarizing…"
              // prompt of deep compaction sessions, which we then hide).
              const ehChat = chatSessionIds().has(sessionId);
              let r = scanClaudeRollout(filePath, Math.min(stat.size, 128 * 1024), { keepSdk: ehChat });
              // Only chase a deep ai-title for sessions we'll actually SHOW
              // (interactive cli). SDK/sidechain tooling is hidden, so don't read
              // megabytes for it.
              // Sessão aberta em chat é do usuário apesar do entrypoint sdk-cli:
              // os hooks de SessionStart empurram o 1º prompt pra além de 128 KB.
              const looksHidden = (/^sdk/.test(r.entrypoint) || r.isSidechain) && !ehChat;
              if (!looksHidden && !r.aiTitle && !(ehChat && r.firstMsg) && stat.size > 128 * 1024) {
                r = scanClaudeRollout(filePath, Math.min(stat.size, 2 * 1024 * 1024), { keepSdk: ehChat });
              }
              // Hide non-interactive sessions: SDK entrypoints (code review,
              // compaction, /remember, …) and subagent sidechains — exactly what
              // Claude Code's own /resume omits. Keep cli + claude-desktop. The
              // prompt patterns catch the rare claude-desktop compaction/handoff.
              const isInternal = /^sdk/.test(r.entrypoint)
                              || r.isSidechain
                              || /^You are summarizing a Claude Code session/.test(r.firstMsg)
                              || /^You are a memory consolidation agent/.test(r.firstMsg);
              meta = { mtime: stat.mtimeMs, cwd: r.cwd, title: r.aiTitle || r.firstMsg || r.lastPrompt, firstMsg: r.firstMsg, isSidechain: r.isSidechain, isInternal };
              claudeMetaCache.set(sessionId, meta);
              claudeMetaDirty = true;
            }
            // Subagent + internal (compaction/handoff) sessions are hidden from
            // /resume — hide them here too.
            if (meta.isSidechain || (meta.isInternal && !chatSessionIds().has(sessionId))) continue;
            byId.set(sessionId, {
              id: sessionId,
              title: meta.title || '(claude session)',
              cwd: meta.cwd || '',
              first_user_message: meta.firstMsg || '',
              updated_at_ms: Math.round(stat.mtimeMs),
              updated_at: Math.round(stat.mtimeMs / 1000),
              accountNum: claudeAccountNum,
              provider: 'claude',
            });
          }
        }
      }
    } catch (err) { logError('list-threads claude', err); }
    saveClaudeMetaCache();

    let out = Array.from(byId.values());
    if (folder) {
      // Mesma pasta ou dentro dela. No Windows sem diferenciar maiúsculas e
      // aceitando `\` (platform.isSameOrInside); no macOS, a comparação de sempre.
      out = out.filter(r => platform.isSameOrInside(r.cwd || '', folder));
    }
    out.sort((a, b) => (b.updated_at_ms || b.updated_at * 1000) - (a.updated_at_ms || a.updated_at * 1000));
    return out.slice(0, 200);
  });

  function getAccountDbPath(accountNum) {
    if (!accountNum) return path.join(REAL_HOME, '.codex', 'state_5.sqlite');
    for (const base of [ACCOUNTS_DIR, ARCHIVED_ACCOUNTS_DIR]) {
      const p = path.join(base, String(accountNum), '.codex', 'state_5.sqlite');
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  ipcMain.handle('thread-rename', (_, { accountNum, sessionId, title }) => {
    if (!sessionId || !title) return { error: 'missing params' };
    const dbPath = getAccountDbPath(accountNum);
    if (!dbPath || !fs.existsSync(dbPath)) return { error: 'db not found' };
    try {
      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, sessionId);
      db.close();
      threadsDbCache.delete(dbPath);
      return { ok: true };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });

  ipcMain.handle('thread-delete', (_, { accountNum, sessionId }) => {
    if (!sessionId) return { error: 'missing sessionId' };
    const dbPath = getAccountDbPath(accountNum);
    if (!dbPath || !fs.existsSync(dbPath)) return { error: 'db not found' };
    try {
      const db = new DatabaseSync(dbPath);
      // Soft delete: mark archived in DB so it disappears from sidebar
      try { db.prepare('UPDATE threads SET archived = 1 WHERE id = ?').run(sessionId); }
      catch { db.prepare('DELETE FROM threads WHERE id = ?').run(sessionId); }
      db.close();
      threadsDbCache.delete(dbPath);
      // Hard delete: remove the session jsonl file too
      const sessFile = findSessionFile(sessionId);
      if (sessFile) { try { fs.unlinkSync(sessFile); } catch {} }
      return { ok: true };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });

  ipcMain.handle('pick-folder', async (event) => {
    try {
      const senderWin = BrowserWindow.fromWebContents(event.sender) || testWindow;
      const res = await dialog.showOpenDialog(senderWin, {
        title: 'Select project folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: REAL_HOME,
      });
      if (res.canceled || !res.filePaths.length) return null;
      return res.filePaths[0];
    } catch (err) {
      logError('pick-folder', err);
      return null;
    }
  });

  // Blocking variant of pick-folder. Used by launchTerminal when validating
  // a project cwd that vanished from disk — keeps the spawn flow synchronous
  // so the returned spawnId (and immediate state mutations at the call site)
  // stay coherent. Trade-off: renderer thread is blocked while the dialog
  // is open, but that's expected UX for a modal folder picker anyway.
  ipcMain.on('pick-folder-sync', (event) => {
    try {
      const senderWin = BrowserWindow.fromWebContents(event.sender) || testWindow;
      const res = dialog.showOpenDialogSync(senderWin, {
        title: 'Select new project folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: REAL_HOME,
      });
      event.returnValue = (res && res.length) ? res[0] : null;
    } catch (err) {
      logError('pick-folder-sync', err);
      event.returnValue = null;
    }
  });

  // ── Detecção de agentes ────────────────────────────────────────────────────
  // `command -v` num shell de LOGIN: sem `-l`, o PATH do processo Electron não
  // enxerga nvm nem brew, e `codex` (que vive no nvm) apareceria como ausente.
  //
  // UM spawn, ASSÍNCRONO, para as 5 CLIs. A primeira versão fazia
  // `execFileSync` cinco vezes — cada uma abrindo um shell de login que roda
  // `source nvm.sh` + `brew shellenv`. Síncrono no processo main significa
  // event loop congelado: nenhum IPC atendido, nenhuma janela responde. O
  // smoke do navegador reprovou porque o painel não abria a tempo — o main
  // estava travado detectando CLIs, todo boot.
  //
  // O shell imprime uma linha `id<TAB>caminho` por CLI encontrada.
  let _agentDetectCache = null;
  let _agentDetectEmVoo = null;

  const { ProviderUpdates } = require('./agents/updates');
  providerUpdates = new ProviderUpdates({
    stateDir: NORYA_HOME,
    sessions: id => Object.entries(terminalMeta).filter(([key, meta]) => terminals[key] && meta.agentId === id).length,
    pause: id => quotaManager?.pauseProvider(id),
    resume: id => quotaManager?.resumeProvider(id),
  });
  providerUpdates.on('change', snapshot => {
    if (testWindow && !testWindow.isDestroyed()) testWindow.webContents.send('provider-updates-changed', snapshot);
  });
  providerUpdates.on('installed', () => { _agentDetectCache = null; });
  ipcMain.handle('provider-updates-status', () => providerUpdates.snapshot());
  ipcMain.handle('provider-updates-check', (_, force) => providerUpdates.check(force === true));
  ipcMain.handle('provider-updates-install', (_, id) => providerUpdates.request(id));
  ipcMain.handle('provider-updates-cancel', (_, id) => providerUpdates.cancel(id));

  async function detectAgents() {
    const { paths } = await providerUpdates.resolve();
    return AGENTS.map(a => ({
      id: a.id, label: a.label, bin: a.bin,
      subscription: a.subscription, quota: a.quota,
      install: a.install, docs: a.docs, login: a.login,
      installed: Boolean(paths[a.id]), path: paths[a.id] || null,
    }));
  }

  ipcMain.handle('detect-agents', async (_, { force } = {}) => {
    if (_agentDetectCache && !force) return _agentDetectCache;
    // Coalesce: rail.js e agents.js chamam isto no boot, quase juntos.
    if (!_agentDetectEmVoo) {
      _agentDetectEmVoo = detectAgents()
        .then(r => {
          _agentDetectCache = r;
          logLine('agents', r.map(a => `${a.id}=${a.installed ? 'ok' : 'ausente'}`).join(' '));
          return r;
        })
        .finally(() => { _agentDetectEmVoo = null; });
    }
    return _agentDetectEmVoo;
  });

  ipcMain.on('kill-terminal', (_, id) => {
    if (chats[id]) {
      // Sai do mapa ANTES do kill: o onExit da sessão vê que foi substituída e
      // não repete o terminal-exit (que chegaria depois de um respawn no mesmo id).
      const c = chats[id];
      delete chats[id];
      delete terminalMeta[id];
      terminalSizes.delete(id);
      try { c.kill(); } catch (err) { logError(`kill-chat(${id})`, err); }
      if (testWindow && !testWindow.isDestroyed()) testWindow.webContents.send(`terminal-exit-${id}`);
      return;
    }
    if (!terminals[id]) {
      if (terminalSizes.delete(id) && testWindow && !testWindow.isDestroyed()) {
        testWindow.webContents.send(`terminal-exit-${id}`);
      }
      return;
    }
    try { terminals[id].kill(); } catch (err) { logError(`kill-terminal(${id})`, err); }
    finally {
      delete terminals[id];
      delete termBuffers[id];
      delete terminalMeta[id];
      terminalSizes.delete(id);
      forgetDevServer(id);
    }
  });

  ipcMain.handle('rename-account', (_, { num, name }) => {
    try {
      const dir = path.join(ACCOUNTS_DIR, String(num));
      if (!fs.existsSync(dir)) throw new Error(`account ${num} does not exist`);
      const clean = String(name || '').trim() || `Profile ${num}`;
      fs.writeFileSync(path.join(dir, 'name.txt'), clean);
      return { num, name: clean };
    } catch (err) {
      logError(`rename-account(${num})`, err);
      return { error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('delete-account', async (_, { num }) => {
    try {
      const dir = path.join(ACCOUNTS_DIR, String(num));
      if (!fs.existsSync(dir)) throw new Error(`profile ${num} does not exist`);
      // HARD delete: remove tudo da conta EXCETO o que preserva as threads.
      // Mantém só: .codex/sessions/ (rollouts), state_5.sqlite* (metadata
      // de threads), history.jsonl, e profile.json marcado como deleted.
      if (terminals[num]) { try { terminals[num].kill(); } catch {} delete terminals[num]; }

      const codexDir = path.join(dir, '.codex');
      // Conteúdo do user (threads + tudo que ele instalou/configurou via codex):
      const KEEP_IN_CODEX = new Set([
        'sessions',
        'state_5.sqlite', 'state_5.sqlite-shm', 'state_5.sqlite-wal',
        'history.jsonl',
        'skills',
        'plugins', 'plugins.sha',
        'memories',
        'goals_1.sqlite', 'goals_1.sqlite-shm', 'goals_1.sqlite-wal',
        'config.toml',
      ]);
      // Identidade git/ssh do user + marker de delete + .codex/ root:
      const KEEP_IN_ROOT = new Set([
        '.codex',
        'profile.json',
        '.gitconfig',
        '.ssh',
        '.docker',
        '.config',
      ]);

      let freedBytes = 0;
      const sizeOf = (p) => {
        try {
          const st = fs.statSync(p);
          if (st.isFile()) return st.size;
          if (st.isDirectory()) {
            let total = 0;
            for (const e of fs.readdirSync(p)) total += sizeOf(path.join(p, e));
            return total;
          }
        } catch {}
        return 0;
      };
      const rmEntry = (p) => {
        freedBytes += sizeOf(p);
        try { fs.rmSync(p, { recursive: true, force: true }); } catch (err) {
          logError(`hard-delete rm(${p})`, err);
        }
      };

      if (fs.existsSync(codexDir)) {
        for (const entry of fs.readdirSync(codexDir)) {
          if (KEEP_IN_CODEX.has(entry)) continue;
          rmEntry(path.join(codexDir, entry));
        }
      }
      for (const entry of fs.readdirSync(dir)) {
        if (KEEP_IN_ROOT.has(entry)) continue;
        rmEntry(path.join(dir, entry));
      }

      try {
        const profilePath = path.join(dir, 'profile.json');
        writeFileAtomic(profilePath, JSON.stringify({
          deleted: true,
          deletedAt: new Date().toISOString(),
        }, null, 2), { mode: 0o600 });
      } catch (err) { logError(`mark-deleted profile.json(${num})`, err); }

      try {
        const owners = JSON.parse(fs.readFileSync(THREAD_OWNERS_PATH, 'utf8')) || {};
        let changed = false;
        for (const sid of Object.keys(owners)) {
          if (owners[sid] === num) { delete owners[sid]; changed = true; }
        }
        if (changed) writeFileAtomic(THREAD_OWNERS_PATH, JSON.stringify(owners, null, 2));
      } catch {}

      // Perfil deletado leva junto os dados do browser — era o wipe do
      // closePanel que cobria isso até 2026-07-14; agora é explícito.
      try { if (browserManager) await browserManager.clearData(String(num)); }
      catch (err) { logError(`delete-account clearData(${num})`, err); }

      const freedMB = (freedBytes / (1024 * 1024)).toFixed(1);
      logLine('delete-account', `#${num} hard-delete: liberou ${freedMB} MB, threads preservadas`);
      return { num, deleted: true, hardDelete: true, freedBytes, freedMB };
    } catch (err) {
      logError(`delete-account(${num})`, err);
      return { error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('add-account', async (_, { name }) => {
    const entries = fs.existsSync(ACCOUNTS_DIR)
      ? fs.readdirSync(ACCOUNTS_DIR).filter(n => !isNaN(n)).map(Number)
      : [];
    let num = 1;
    while (entries.includes(num)) num++;
    const dir = path.join(ACCOUNTS_DIR, String(num));
    const finalName = name || `Profile ${num}`;
    try {
      fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'name.txt'), finalName);
      ensureConfig(dir);
      return { num, dir, name: finalName };
    } catch (err) {
      // Roll back a half-created account so the next add reuses this number and
      // no zombie dir lingers. Match the {error} contract of sibling handlers.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      logError(`add-account(${num})`, err);
      return { error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('profile-set-color', (_, { num, color }) => {
    if (!PROFILE_PALETTE.includes(color)) return { error: 'cor fora da paleta permitida' };
    try { return { ok: true, profile: writeProfile(num, { color }) }; }
    catch (err) { return { error: String(err.message || err) }; }
  });
  // Os authModes válidos vêm do REGISTRY. Uma lista à mão aqui teria ficado
  // desatualizada no instante em que grok e opencode ganharam perfil próprio.
  const AUTH_MODES_VALIDOS = new Set(AGENTS.flatMap(a => a.authModes));
  // Token de longa duração do `claude setup-token`. É o que permite VÁRIAS contas
  // Claude: o Keychain do macOS só guarda um login por usuário do sistema.
  // Guardado no profile.json (mode 600), como já é feito com openrouterKey.
  ipcMain.handle('profile-set-claude-token', (_, { num, token }) => {
    try {
      if (token == null || token === '') {
        writeProfile(num, { claudeOauthToken: null });
        return { ok: true, hasToken: false };
      }
      const t = String(token).trim();
      const { prefix } = AGENT_BY_ID.claude.creds;
      // Recusa qualquer coisa que não pareça um token do setup-token. Gravar
      // lixo aqui faria o claude falhar em auth a cada spawn, sem explicação.
      if (!t.startsWith(prefix)) return { error: `token deve começar com ${prefix}` };
      if (!/^[\w.-]+$/.test(t)) return { error: 'token com caractere inválido' };
      writeProfile(num, { claudeOauthToken: t });
      logLine('claude-auth', `perfil ${num}: token gravado (${t.slice(0, 16)}…)`);
      return { ok: true, hasToken: true };
    } catch (err) { return { error: String(err.message || err) }; }
  });

  ipcMain.handle('profile-set-auth-mode', (_, { num, mode }) => {
    if (mode !== null && !AUTH_MODES_VALIDOS.has(mode)) {
      return { error: `invalid mode: ${mode}` };
    }
    try {
      const saved = writeProfile(num, { authMode: mode });
      return { ok: true, profile: {
        authMode: saved.authMode,
        hasApiKey: !!saved.apiKey,
        hasOpenrouterKey: !!saved.openrouterKey,
        openrouterModel: saved.openrouterModel || null,
        claudeModel: saved.claudeModel || null,
      } };
    } catch (err) { return { error: String(err.message || err) }; }
  });
  ipcMain.handle('profile-set-apikey', (_, { num, apiKey }) => {
    const clean = apiKey == null ? null : String(apiKey).trim();
    if (clean && !clean.startsWith('sk-')) {
      return { error: 'Invalid API key (expected an sk- prefix).' };
    }
    try {
      const saved = writeProfile(num, { apiKey: clean || null });
      return { ok: true, hasApiKey: !!saved.apiKey };
    } catch (err) { return { error: String(err.message || err) }; }
  });
  // OpenRouter handlers
  ipcMain.handle('profile-set-openrouter-key', (_, { num, key }) => {
    const clean = key == null ? null : String(key).trim();
    if (clean && !clean.startsWith('sk-or-')) {
      return { error: 'Invalid key (expected an sk-or- prefix).' };
    }
    try {
      const saved = writeProfile(num, { openrouterKey: clean || null });
      return { ok: true, hasOpenrouterKey: !!saved.openrouterKey };
    } catch (err) { return { error: String(err.message || err) }; }
  });
  ipcMain.handle('profile-set-openrouter-model', (_, { num, model }) => {
    let clean = model == null ? null : String(model).trim();
    // Strip "openrouter/" prefix if user typed it — bridge always adds it back.
    if (clean && clean.startsWith('openrouter/')) clean = clean.slice('openrouter/'.length);
    // Accept any number of path segments (provider/model, provider/sub/model, etc.)
    // and the chars typically found in OpenRouter ids ([a-z0-9._-/]).
    if (clean && !/^[\w.-]+(?:\/[\w.-]+)+$/i.test(clean)) {
      return { error: 'Invalid model. Expected format: provider/model (e.g. xiaomi/mimo-v2.5-pro). See openrouter.ai/models.' };
    }
    try {
      const saved = writeProfile(num, { openrouterModel: clean || null });
      return { ok: true, openrouterModel: saved.openrouterModel };
    } catch (err) { return { error: String(err.message || err) }; }
  });
  // Claude handlers (added 2026-05-25): OAuth-only flow, no key field.
  // Model is optional (claude has a smart default).
  //
  // Accepts:
  //   - null / '' / 'auto'              → clear (let claude CLI choose default)
  //   - any [a-zA-Z0-9._-]+ id          → opaque pass-through to `claude --model`
  // We deliberately do NOT hard-code an allowlist of model ids — Anthropic
  // adds/renames models faster than we can ship updates. The renderer offers
  // a dropdown of well-known ids (Opus/Sonnet/Haiku) plus a free-text field.
  ipcMain.handle('profile-set-claude-model', (_, { num, model }) => {
    let clean = model == null ? null : String(model).trim();
    if (clean === '' || clean === 'auto') clean = null;
    if (clean && !/^[\w.-]+$/.test(clean)) {
      return { error: 'Invalid model. Use the id (e.g. claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5).' };
    }
    try {
      const saved = writeProfile(num, { claudeModel: clean || null });
      return { ok: true, claudeModel: saved.claudeModel };
    } catch (err) { return { error: String(err.message || err) }; }
  });

  // Re-expose Claude auth metadata on demand (e.g. when the renderer wants
  // to refresh the badge after a `claude /login` PTY finishes, without
  // re-running the full loadAccounts() pass).
  ipcMain.handle('claude-auth-meta', () => {
    invalidateClaudeAuthMemo(); // explicit refresh (e.g. after login) → re-read now
    const meta = readClaudeAuthMeta();
    if (!meta) return { hasAuth: false };
    return {
      hasAuth: true,
      expiresAt: meta.expiresAt,
      subscriptionType: meta.subscriptionType,
      rateLimitTier: meta.rateLimitTier,
      scopes: meta.scopes,
    };
  });

  ipcMain.handle('profile-palette', () => PROFILE_PALETTE.slice());

/**
 * Leva a linha de `threads` de um perfil para outro, apontando para o rollout
 * já copiado.
 *
 * BEST-EFFORT de propósito: quem decide se a adoção deu certo é o relatório do
 * `codex migrate-rollouts`, logo abaixo do chamador. Um perfil destino virgem
 * (sem thread-store) migra bem sem esta cópia, e uma origem sem a linha pode
 * ainda assim funcionar — abortar aqui trocaria uma mensagem precisa do codex
 * por um palpite nosso. O que não pode é falhar em silêncio: tudo vai pro log.
 *
 * Usa `node:sqlite` dos dois lados (e não o binário `sqlite3` do macOS) porque
 * aqui há ESCRITA: é o mesmo caminho de thread-rename/thread-delete, e é o
 * único que existe no Windows. A leitura é read-only para não esbarrar num DB
 * travado por uma CLI viva no perfil de origem.
 */
function copiarMetadataDaThread({ sessionId, destino, origemDb, destinoDb }) {
  const pular = (motivo) => { logLine('thread-adopt', `metadata não copiada: ${motivo}`); };
  if (!DatabaseSync) return pular('node:sqlite indisponível');
  if (!fs.existsSync(origemDb)) return pular(`origem sem state_5.sqlite (${origemDb})`);
  if (!fs.existsSync(destinoDb)) return pular('destino ainda sem thread-store — o migrate bootstrapa sozinho');

  let src, dst;
  try {
    src = new DatabaseSync(origemDb, { readOnly: true });
    const row = src.prepare('SELECT * FROM threads WHERE id = ?').get(sessionId);
    if (!row) return pular('a task não está na state_5.sqlite da origem');

    dst = new DatabaseSync(destinoDb);
    const destCols = dst.prepare('SELECT name FROM pragma_table_info(?)').all('threads').map(r => r.name);
    const { sql, values } = buildMetadataInsert(row, destCols, destino);
    dst.prepare(sql).run(...values);
    logLine('thread-adopt', `metadata de ${sessionId} copiada (${values.length} colunas)`);
  } catch (err) {
    logError('copiarMetadataDaThread', err);
  } finally {
    try { src && src.close(); } catch {}
    try { dst && dst.close(); } catch {}
  }
}

  // ── Thread ownership IPCs ───────────────────────────────────────────────
  ipcMain.handle('thread-owner-get', (_, sessionId) => ({
    sessionId,
    profileNum: getThreadOwner(sessionId),
  }));
  ipcMain.handle('thread-owner-set', (_, { sessionId, profileNum }) => {
    try {
      if (!sessionId) return { error: 'missing sessionId' };
      // Reject owners pointing at a non-existent profile so a stale/typo'd id
      // can't be persisted (would orphan the thread on next open).
      if (profileNum != null && !fs.existsSync(path.join(ACCOUNTS_DIR, String(profileNum)))) {
        return { error: `profile ${profileNum} does not exist` };
      }
      setThreadOwner(sessionId, profileNum);
      return { ok: true };
    } catch (err) { return { error: String(err.message || err) }; }
  });
  ipcMain.handle('thread-owners-all', () => readThreadOwners());

  // ── Adotar uma task em OUTRA conta (2026-09-09) ───────────────────────────
  //
  // Motivo: a conta dona estoura a quota no meio do trabalho e o usuário quer
  // continuar A MESMA conversa numa conta com quota sobrando. Trocar o dono não
  // bastava — `codex resume <id>` procura a sessão no $CODEX_HOME do perfil, e
  // cada perfil tem o seu. Ver agents/rollout-adopt.js para o porquê do
  // caminho (copiar o rollout + `codex migrate-rollouts --apply --thread`).
  //
  // Idempotente: se o rollout já está no destino, a cópia é um no-op e o
  // migrate devolve "already migrated" sem reprocessar bytes.
  ipcMain.handle('thread-adopt-profile', async (_, { sessionId, provider, fromAccount, toAccount }) => {
    try {
      if (!sessionId) return { error: 'missing sessionId' };
      const destDir = path.join(ACCOUNTS_DIR, String(toAccount));
      if (toAccount == null || !fs.existsSync(destDir)) {
        return { error: `perfil ${toAccount} não existe` };
      }

      // Onde mora o rollout desta task hoje. accountNum 0 = o ~/.codex real.
      let rolloutPath = null;
      if (provider === 'codex') {
        const origens = [];
        if (fromAccount != null) {
          origens.push(fromAccount === 0
            ? path.join(REAL_HOME, '.codex', 'sessions')
            : path.join(ACCOUNTS_DIR, String(fromAccount), '.codex', 'sessions'));
        } else {
          // Dono desconhecido: procura em todos os perfis. É barato — o walk já
          // roda a cada list-threads.
          for (const base of [ACCOUNTS_DIR, ARCHIVED_ACCOUNTS_DIR]) {
            if (!fs.existsSync(base)) continue;
            for (const n of fs.readdirSync(base).filter(x => !isNaN(x))) {
              origens.push(path.join(base, n, '.codex', 'sessions'));
            }
          }
          origens.push(path.join(REAL_HOME, '.codex', 'sessions'));
        }
        for (const dir of origens) {
          rolloutPath = findRollout(listRolloutFilesInDir(dir), sessionId);
          if (rolloutPath) break;
        }
      }

      const plano = planAdoption({ provider, fromAccount, toAccount, rolloutPath,
        claudeSharedHome: platform.claudeCredStore === 'keychain' });
      if (plano.action === 'fail') return { error: plano.reason };
      if (plano.action === 'none') {
        setThreadOwner(sessionId, toAccount);
        return { ok: true, moved: false, reason: plano.reason };
      }

      // copy-claude — Windows: cada perfil tem o seu <perfil>\.claude. O
      // transcript vai para a MESMA pasta de projeto no destino (o nome dela é
      // o cwd codificado, igual nos dois perfis) e o `claude --resume` acha.
      if (plano.action === 'copy-claude') {
        const origens = (fromAccount != null && fromAccount !== 0)
          ? [path.join(platform.claudeConfigDir(path.join(ACCOUNTS_DIR, String(fromAccount))), 'projects')]
          : claudeProjectRoots().map(r => r.dir);
        const src = findClaudeTranscript(sessionId, origens);
        if (!src) return { error: 'Não encontrei o transcript desta task no perfil de origem.' };
        const destino = path.join(platform.claudeConfigDir(destDir), 'projects',
          path.basename(path.dirname(src)), path.basename(src));
        if (platform.pathKey(destino) !== platform.pathKey(src)) {
          fs.mkdirSync(path.dirname(destino), { recursive: true });
          if (!fs.existsSync(destino)) fs.copyFileSync(src, destino);
        }
        setThreadOwner(sessionId, toAccount);
        logLine('thread-adopt', `${sessionId} ${fromAccount} → ${toAccount} (claude copiado)`);
        return { ok: true, moved: true, status: 'copied' };
      }

      // copy-and-migrate — Codex entre perfis.
      const destSessions = path.join(destDir, '.codex', 'sessions');
      const destino = path.join(destSessions, plano.relPath);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      if (!fs.existsSync(destino)) fs.copyFileSync(rolloutPath, destino);

      // A METADATA tem que ir junto. Num perfil que já tem thread-store — todo
      // perfil real — o `migrate-rollouts` recusa um rollout cuja linha não
      // existe na `state_5.sqlite` dele (failure_reason
      // "missing_sqlite_metadata"): ele migra do legado para o paginado uma
      // thread que o perfil JÁ conhece, não cria uma do nada. Medido em
      // test/smoke-adopt-thread.js — sem este passo a adoção falhava sempre
      // fora de um CODEX_HOME virgem.
      copiarMetadataDaThread({
        sessionId, destino,
        // O state_5.sqlite é irmão do sessions/ dentro do CODEX_HOME de origem.
        origemDb: path.join(codexHomeOf(rolloutPath), 'state_5.sqlite'),
        destinoDb: path.join(destDir, '.codex', 'state_5.sqlite'),
      });

      const account = loadAccounts().find(a => a.num === toAccount) || { num: toAccount, dir: destDir };
      const { env } = buildAccountEnv(account);
      const cmd = [
        platform.probePrelude({ nvmDir: NVM_DIR }),
        `codex migrate-rollouts --apply --json --thread ${platform.quote(sessionId)}`,
      ].filter(Boolean).join('; ');

      const saida = await new Promise((resolve) => {
        execFile(platform.shellBin(), platform.shellArgs(cmd),
          { env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
      });
      // O RELATÓRIO manda, não o código de saída: o `codex` sai != 0 sempre que
      // qualquer migração falha, mas é o JSON que diz QUAL e por quê. Ler o
      // código primeiro só devolveria "one or more rollout migrations failed",
      // que não ajuda ninguém a consertar nada.
      let rep = null;
      try { rep = JSON.parse(saida.stdout); } catch { /* sem relatório: cai no erro cru abaixo */ }
      const outcome = rep && (rep.outcomes || []).find(
        x => String(x.thread_id).toLowerCase() === String(sessionId).toLowerCase());

      if (!outcome) {
        logError('thread-adopt-profile migrate', saida.err || new Error('sem outcome no relatório'));
        const detalhe = saida.stderr.trim() || (saida.err && saida.err.message) || saida.stdout.slice(0, 400);
        return { error: `codex migrate-rollouts não reportou esta sessão: ${detalhe}` };
      }
      // Status de sucesso: migrou agora, ou já estava lá de uma adoção anterior
      // ("already_paginated" é o que volta ao adotar a mesma task duas vezes).
      const OK_STATUS = ['migrated', 'already_migrated', 'already_paginated'];
      if (!OK_STATUS.includes(outcome.status)) {
        return { error: `codex recusou a sessão (${outcome.status}): ${outcome.message || saida.stderr.trim() || 'sem detalhe'}` };
      }
      const status = outcome.status;

      setThreadOwner(sessionId, toAccount);
      logLine('thread-adopt', `${sessionId} ${fromAccount} → ${toAccount} (${status})`);
      return { ok: true, moved: true, status };
    } catch (err) {
      logError('thread-adopt-profile', err);
      return { error: String(err && err.message || err) };
    }
  });

  // ── Agente por thread ─────────────────────────────────────────────────────
  ipcMain.handle('thread-agents-all', () => readThreadAgents());
  ipcMain.handle('thread-agent-set', (_, { sessionId, agentId }) => {
    try {
      if (!sessionId) return { error: 'missing sessionId' };
      // Um agentId desconhecido gravado em disco voltaria a cada spawn desta
      // thread, para sempre. Recusa na porta.
      if (agentId != null && !AGENT_BY_ID[agentId]) {
        return { error: `agente desconhecido: ${agentId}` };
      }
      setThreadAgent(sessionId, agentId);
      return { ok: true };
    } catch (err) { return { error: String(err.message || err) }; }
  });

  // ── Fork lineage IPCs (Norya forks 2026-05-26) ──────────────────────────
  ipcMain.handle('fork-lineage-all', () => readForkLineage());
  ipcMain.handle('fork-lineage-set', (_, entry) => {
    try { return { ok: true, entry: setForkLineageEntry(entry) }; }
    catch (err) { return { error: String(err && err.message || err) }; }
  });

  // ── Norya-specific UI state (separate from panel-state to avoid coupling
  // with the Painel Operacional). Currently holds activeProfileNum + reserved
  // keys for future UI flags.
  ipcMain.handle('norya-state-get', () => {
    try { return JSON.parse(fs.readFileSync(NORYA_STATE_PATH, 'utf8')) || {}; }
    catch { return {}; }
  });
  ipcMain.handle('norya-state-save', (_, data) => {
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'invalid state payload' };
      let current = {};
      try { current = JSON.parse(fs.readFileSync(NORYA_STATE_PATH, 'utf8')) || {}; } catch {}
      // Whitelist accepted keys so a buggy/hostile caller can't write arbitrary
      // blobs into the persisted UI state.
      const ALLOWED = new Set(['activeProfileNum', 'glass', 'pet', 'petKind', 'petSize', 'petVisibility']);
      const clean = {};
      for (const k of Object.keys(data)) { if (ALLOWED.has(k)) clean[k] = data[k]; }
      // Chaves do Mini: valor fora do domínio é descartado (nunca grava lixo).
      const petClean = uiPrefs.normalizarPetPrefs(clean);
      for (const k of ['pet', 'petKind', 'petSize', 'petVisibility']) {
        if (k in clean) { if (k in petClean) clean[k] = petClean[k]; else delete clean[k]; }
      }
      const next = { ...current, ...clean };
      writeFileAtomic(NORYA_STATE_PATH, JSON.stringify(next, null, 2));
      // O Mini vale na hora (diferente do vidro, não depende do boot).
      if (petManager && Object.keys(petClean).length) petManager.setPrefs(petClean);
      return { ok: true, state: next };
    } catch (err) { return { error: String(err.message || err) }; }
  });

  ipcMain.handle('working-ptys', (_, payload) => {
    const projectId = payload && payload.projectId;
    const profileNum = payload && payload.profileNum;
    return {
      byProject: projectId ? workingPtysForProject(projectId) : null,
      byProfile: profileNum != null ? workingPtysForProfile(profileNum) : null,
      total: Object.keys(terminals).length,
    };
  });

  ipcMain.handle('project-list', () => readProjects());

  ipcMain.handle('git-detect', (_, dir) => {
    if (!dir) return { hasGit: false };
    return { hasGit: fs.existsSync(path.join(dir, '.git')) };
  });

  ipcMain.handle('git-list-branches', (_, dir) => {
    if (!dir) return { branches: [], current: null };
    if (!fs.existsSync(path.join(dir, '.git'))) return { branches: [], current: null };
    try {
      const raw = execFileSync('git', ['-C', dir, 'branch', '--format=%(refname:short)'],
        { encoding: 'utf8', stdio: 'pipe' });
      const branches = raw.trim().split('\n').filter(Boolean);
      let current = null;
      try {
        current = execFileSync('git', ['-C', dir, 'branch', '--show-current'],
          { encoding: 'utf8', stdio: 'pipe' }).trim();
      } catch {}
      return { branches, current };
    } catch {
      return { branches: [], current: null };
    }
  });

  // Slug derivation from arbitrary text (first prompt → folder name)
  function deriveSlugFromText(text, maxWords = 5, maxChars = 40) {
    if (!text) return 'thread';
    const cleaned = String(text)
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/[^a-z0-9\s-]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, maxWords)
      .join('-')
      .slice(0, maxChars)
      .replace(/^-+|-+$/g, '');
    return cleaned || 'thread';
  }

  // Resolve slug collisions inside the project's worktrees dir.
  function uniqueWorktreeSlug(projectId, slug) {
    const wtDir = path.join(NORYA_HOME, 'worktrees', projectId);
    fs.mkdirSync(wtDir, { recursive: true });
    let candidate = slug;
    let suffix = 2;
    while (fs.existsSync(path.join(wtDir, candidate))) {
      candidate = slug + '-' + suffix++;
      if (suffix > 99) break; // safety
    }
    return candidate;
  }

  // Fase 6: accepts EITHER `slug` (new) OR `slotIndex` (legacy from Painel
  // Operacional). When slug is given, path = .worktrees/<projectId>/<slug>,
  // branch = wt/<slug>. Legacy path stays as slot-N for back-compat.
  ipcMain.handle('git-worktree-add', (_, { projectId, slotIndex, slug, projectDir, branch: requestedBranch }) => {
    if (!projectId || !projectDir) return { error: 'missing params' };
    if (slug == null && slotIndex == null) return { error: 'need slug or slotIndex' };

    const wtDir = path.join(NORYA_HOME, 'worktrees', projectId);
    let wtName, defaultBranch;
    if (slug != null) {
      const resolved = uniqueWorktreeSlug(projectId, String(slug));
      wtName = resolved;
      defaultBranch = 'wt/' + resolved;
    } else {
      wtName = 'slot-' + slotIndex;
      defaultBranch = 'codex/slot-' + slotIndex;
    }
    const wtPath = path.join(wtDir, wtName);
    const branch = requestedBranch || defaultBranch;

    try {
      fs.mkdirSync(wtDir, { recursive: true });
      // Legacy slot path: remove existing first (matches old behavior).
      // Slug path: uniqueWorktreeSlug already guaranteed no collision.
      if (slug == null) {
        try { execFileSync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wtPath], { stdio: 'pipe' }); } catch {}
      }
      if (requestedBranch) {
        execFileSync('git', ['-C', projectDir, 'worktree', 'add', wtPath, branch], { stdio: 'pipe' });
      } else {
        let branchExists = false;
        try { execFileSync('git', ['-C', projectDir, 'rev-parse', '--verify', branch], { stdio: 'pipe' }); branchExists = true; } catch {}
        if (branchExists) {
          execFileSync('git', ['-C', projectDir, 'worktree', 'add', wtPath, branch], { stdio: 'pipe' });
        } else {
          execFileSync('git', ['-C', projectDir, 'worktree', 'add', '-b', branch, wtPath], { stdio: 'pipe' });
        }
      }
      return { ok: true, path: wtPath, branch, slug: slug != null ? wtName : null };
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  });

  // List existing worktrees for a project (for the Branch button dropdown).
  ipcMain.handle('git-worktree-list', (_, { projectDir }) => {
    if (!projectDir) return { worktrees: [] };
    if (!fs.existsSync(path.join(projectDir, '.git'))) return { worktrees: [] };
    try {
      const raw = execFileSync('git', ['-C', projectDir, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8', stdio: 'pipe' });
      const lines = raw.split('\n');
      const result = [];
      let current = null;
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          if (current) result.push(current);
          current = { path: line.slice(9), branch: null, isMain: false };
        } else if (line.startsWith('branch ')) {
          // "branch refs/heads/<name>"
          if (current) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
        } else if (line.startsWith('HEAD ') || line === 'bare') {
          // ignore
        }
      }
      if (current) result.push(current);
      // Mark the main worktree (the one matching projectDir)
      const normalize = p => p && p.replace(/\/+$/, '');
      result.forEach(w => { w.isMain = normalize(w.path) === normalize(projectDir); });
      return { worktrees: result };
    } catch (err) {
      return { worktrees: [], error: String(err.message || err) };
    }
  });

  // ── agent/branches: persisted branch-color overrides + last-commit lookup ──
  // Stored in <NORYA_HOME>/branch-colors.json as { "<projectId>::<branch>": "#hex" }.
  // Falls back to hashed BRANCH_PALETTE when no override exists.
  const BRANCH_COLORS_PATH = path.join(NORYA_HOME, 'branch-colors.json');
  function readBranchColors() {
    try { return JSON.parse(fs.readFileSync(BRANCH_COLORS_PATH, 'utf8')) || {}; }
    catch { return {}; }
  }
  ipcMain.handle('branch-colors-get', () => readBranchColors());

  // Last commit on a branch — short SHA + subject (used for branch indicator tooltip)
  ipcMain.handle('git-last-commit', (_, { dir, branch }) => {
    if (!dir) return { error: 'missing dir' };
    if (!fs.existsSync(path.join(dir, '.git'))) return { error: 'not a git repo' };
    const ref = branch || 'HEAD';
    try {
      const raw = execFileSync(
        'git', ['-C', dir, 'log', '-1', '--format=%h|%s|%cr|%an', ref],
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      const [sha, subject, when, author] = raw.split('|');
      return { sha, subject, when, author };
    } catch (err) {
      return { error: String(err.stderr || err.message || err) };
    }
  });

  // Helper IPC: derive a slug from arbitrary text (frontend can use this so
  // collision logic stays server-side).
  ipcMain.handle('derive-slug', (_, { text, projectId }) => {
    const base = deriveSlugFromText(text);
    if (!projectId) return { slug: base };
    return { slug: uniqueWorktreeSlug(projectId, base) };
  });

  // Fase 7: thread fork → create a fresh worktree from the source branch
  ipcMain.handle('thread-fork', (_, { sourceWorktreePath, sourceBranch, projectDir, projectId, slug }) => {
    if (!projectDir || !projectId) return { error: 'missing projectDir/projectId' };
    if (!fs.existsSync(path.join(projectDir, '.git'))) return { error: 'projectDir is not a git repo' };
    // Determine base branch
    let baseBranch = sourceBranch;
    if (!baseBranch && sourceWorktreePath && fs.existsSync(sourceWorktreePath)) {
      try {
        baseBranch = execFileSync('git', ['-C', sourceWorktreePath, 'branch', '--show-current'],
          { encoding: 'utf8', stdio: 'pipe', timeout: 1500 }).trim();
      } catch {}
    }
    if (!baseBranch) {
      try {
        baseBranch = execFileSync('git', ['-C', projectDir, 'branch', '--show-current'],
          { encoding: 'utf8', stdio: 'pipe', timeout: 1500 }).trim();
      } catch {}
    }
    baseBranch = baseBranch || 'main';

    const finalSlug = uniqueWorktreeSlug(projectId, slug || 'fork');
    const wtDir = path.join(NORYA_HOME, 'worktrees', projectId);
    const wtPath = path.join(wtDir, finalSlug);
    const newBranch = 'wt/' + finalSlug;
    try {
      fs.mkdirSync(wtDir, { recursive: true });
      // Create new branch from source + add worktree
      execFileSync('git', ['-C', projectDir, 'worktree', 'add', '-b', newBranch, wtPath, baseBranch],
        { stdio: 'pipe' });
      return { ok: true, path: wtPath, branch: newBranch, slug: finalSlug, sourceBranch: baseBranch };
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  });

  // Bulk: detect git + current branch for many cwds at once. Used by the
  // sidebar to enrich threads with their actual branch (codex's cached value
  // in state_5.sqlite is often stale).
  //
  // Handles subdirs inside a repo: tries fs.existsSync(.git) first (fast),
  // falls back to `git rev-parse --show-toplevel` (handles subpaths,
  // worktrees, submodules) when not found directly.
  ipcMain.handle('git-status-bulk', (_, { cwds }) => {
    const out = {};
    for (const cwd of (cwds || [])) {
      if (!cwd) continue;
      let gitRoot = null;
      // Fast path: .git in this exact dir
      if (fs.existsSync(path.join(cwd, '.git'))) {
        gitRoot = cwd;
      } else {
        // Slow path: ask git for the work tree root (covers subdirs/worktrees)
        try {
          const r = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
            { encoding: 'utf8', stdio: 'pipe', timeout: 1500 }).trim();
          if (r) gitRoot = r;
        } catch {}
      }
      if (!gitRoot) { out[cwd] = { hasGit: false }; continue; }
      let branch = null;
      try {
        branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'],
          { encoding: 'utf8', stdio: 'pipe', timeout: 1500 }).trim() || null;
      } catch {}
      out[cwd] = { hasGit: true, branch, gitRoot };
    }
    return out;
  });

  // ── git helper (Merge Queue) ─────────────────────────────────────────────────
  function gitOut(dir, args) {
    try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim(); }
    catch { return ''; }
  }

  // ── Merge Queue: non-destructive conflict analysis using git merge-tree ─────
  function analyzeBranchAgainst(dir, baseBranch, branch) {
    const result = { branch, ahead: 0, behind: 0, changedFiles: [], conflicts: [], lastCommit: '', lastCommitAt: '' };
    try {
      const counts = gitOut(dir, ['rev-list', '--left-right', '--count', `${baseBranch}...${branch}`]);
      const [behind, ahead] = counts.split(/\s+/).map(n => parseInt(n) || 0);
      result.behind = behind || 0;
      result.ahead = ahead || 0;
    } catch {}

    try {
      const files = gitOut(dir, ['diff', '--name-only', `${baseBranch}...${branch}`]).split('\n').filter(Boolean);
      result.changedFiles = files.slice(0, 50);
    } catch {}

    try {
      result.lastCommit = gitOut(dir, ['log', '-1', '--pretty=format:%s', branch]);
      result.lastCommitAt = gitOut(dir, ['log', '-1', '--pretty=format:%ci', branch]);
    } catch {}

    // Non-destructive conflict detection via merge-tree
    try {
      const mergeBase = gitOut(dir, ['merge-base', baseBranch, branch]);
      if (mergeBase) {
        const tree = execFileSync('git', ['-C', dir, 'merge-tree', mergeBase, baseBranch, branch],
          { encoding: 'utf8', stdio: 'pipe' });
        // Files with conflicts contain "<<<<<<<" markers in merge-tree output
        const conflictFiles = new Set();
        let currentFile = '';
        for (const line of tree.split('\n')) {
          const m = line.match(/^(?:changed|added|removed) in (?:both|.+)$/);
          if (m) continue;
          const fm = line.match(/^\s*(?:our|their|base|added|removed)\s+\d+\s+\w+\s+(.+)$/);
          if (fm) currentFile = fm[1];
          if (line.includes('<<<<<<<') && currentFile) conflictFiles.add(currentFile);
        }
        result.conflicts = Array.from(conflictFiles).slice(0, 50);
      }
    } catch {}

    return result;
  }

  ipcMain.handle('git-analyze-branches', (_, { projectDir, baseBranch }) => {
    if (!projectDir) return { error: 'missing projectDir' };
    if (!fs.existsSync(path.join(projectDir, '.git'))) return { error: 'not a git repo' };
    const base = baseBranch || gitOut(projectDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')
      || (gitOut(projectDir, ['rev-parse', '--verify', 'main']) ? 'main' : 'master');
    let branches = gitOut(projectDir, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean);
    branches = branches.filter(b => b !== base);
    const analyzed = branches.slice(0, 30).map(b => analyzeBranchAgainst(projectDir, base, b));
    return { base, branches: analyzed };
  });

  ipcMain.handle('git-queue-merge', (_, { projectDir, baseBranch, orderedBranches, failStop }) => {
    if (!projectDir || !Array.isArray(orderedBranches) || !orderedBranches.length) return { error: 'missing params' };
    const base = baseBranch || 'main';
    const safetyBranch = `norya/backup-${Date.now()}`;
    const log = [];
    const merged = [];
    const skipped = [];
    let conflictFiles = [];
    // Default behavior preserved: fail-stop on first conflict.
    const stopOnConflict = (failStop === undefined) ? true : !!failStop;
    try {
      execFileSync('git', ['-C', projectDir, 'branch', safetyBranch, base], { stdio: 'pipe' });
      log.push(`Created safety branch ${safetyBranch}`);
      execFileSync('git', ['-C', projectDir, 'checkout', base], { stdio: 'pipe' });
      for (const b of orderedBranches) {
        try {
          execFileSync('git', ['-C', projectDir, 'merge', '--no-ff', b, '-m', `Merge ${b} (via Norya queue)`], { stdio: 'pipe' });
          log.push(`✓ merged ${b}`);
          merged.push(b);
        } catch (err) {
          // Capture conflict files before aborting (when stopping)
          let unmerged = [];
          try {
            unmerged = (execFileSync('git', ['-C', projectDir, 'diff', '--name-only', '--diff-filter=U'],
              { encoding: 'utf8', stdio: 'pipe' }).trim() || '').split('\n').filter(Boolean);
          } catch {}
          if (stopOnConflict) {
            conflictFiles = unmerged;
            execFileSync('git', ['-C', projectDir, 'merge', '--abort'], { stdio: 'pipe' });
            log.push(`✗ conflict on ${b} — aborted. Resolve manually before retrying.`);
            try { appendMergeHistory(projectDir, base, merged, b, false, safetyBranch, conflictFiles); } catch {}
            return { ok: false, safetyBranch, log, stoppedAt: b, conflictFiles, merged };
          } else {
            // Continue: abort this one and keep going
            execFileSync('git', ['-C', projectDir, 'merge', '--abort'], { stdio: 'pipe' });
            log.push(`⚠ conflict on ${b} — skipped (${unmerged.length} file(s)); continuing.`);
            skipped.push({ branch: b, conflictFiles: unmerged });
          }
        }
      }
      try { appendMergeHistory(projectDir, base, merged, null, true, safetyBranch, []); } catch {}
      return { ok: true, safetyBranch, log, merged, skipped };
    } catch (err) {
      return { error: String(err.message || err), log, safetyBranch };
    }
  });

  // ── Merge history persistence ────────────────────────────────────────────
  const MERGE_HISTORY_PATH = path.join(NORYA_HOME, 'merge-history.json');
  const MERGE_HISTORY_MAX = 50;
  function readMergeHistory() {
    try { return JSON.parse(fs.readFileSync(MERGE_HISTORY_PATH, 'utf8')) || []; }
    catch { return []; }
  }
  function writeMergeHistory(arr) {
    try { writeFileAtomic(MERGE_HISTORY_PATH, JSON.stringify(arr, null, 2)); }
    catch {}
  }
  function appendMergeHistory(projectDir, baseBranch, mergedBranches, stoppedAt, ok, safetyBranch, conflictFiles) {
    const arr = readMergeHistory();
    arr.unshift({
      ts: Date.now(),
      projectDir,
      baseBranch,
      mergedBranches: Array.isArray(mergedBranches) ? mergedBranches.slice() : [],
      stoppedAt: stoppedAt || null,
      ok: !!ok,
      safetyBranch,
      conflictFiles: Array.isArray(conflictFiles) ? conflictFiles.slice(0, 50) : [],
      agentUsed: false,
    });
    writeMergeHistory(arr.slice(0, MERGE_HISTORY_MAX));
  }

  ipcMain.handle('merge-history-list', () => {
    return { records: readMergeHistory() };
  });

  ipcMain.handle('merge-history-mark-agent', (_, { ts, profileName }) => {
    const arr = readMergeHistory();
    const idx = arr.findIndex(r => r.ts === ts);
    if (idx >= 0) {
      arr[idx].agentUsed = true;
      arr[idx].agentProfile = profileName || arr[idx].agentProfile || '';
      writeMergeHistory(arr);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('merge-history-clear', () => {
    writeMergeHistory([]);
    return { ok: true };
  });

  // ── Conflict file content read (post-failed-merge inline preview) ────────
  // Returns the working-tree contents of a conflicted file (with markers),
  // plus a split into hunks for inline diff rendering.
  ipcMain.handle('git-conflict-file-read', (_, { projectDir, relPath }) => {
    if (!projectDir || !relPath) return { error: 'missing params' };
    // Prevent path traversal / absolute-path escape out of projectDir.
    const base = path.resolve(projectDir);
    const fullPath = path.resolve(base, relPath);
    if (path.isAbsolute(relPath) || (fullPath !== base && !fullPath.startsWith(base + path.sep))) {
      return { error: 'invalid path' };
    }
    let text;
    try { text = fs.readFileSync(fullPath, 'utf8'); }
    catch (err) { return { error: 'cannot read: ' + String(err.message || err) }; }
    const lines = text.split('\n');
    const hunks = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith('<<<<<<<')) {
        const ourLabel = lines[i].slice(7).trim();
        const ours = [];
        let j = i + 1;
        while (j < lines.length && !lines[j].startsWith('=======') && !lines[j].startsWith('>>>>>>>')) {
          ours.push(lines[j]); j++;
        }
        const theirs = [];
        let theirLabel = '';
        if (j < lines.length && lines[j].startsWith('=======')) {
          j++;
          while (j < lines.length && !lines[j].startsWith('>>>>>>>')) {
            theirs.push(lines[j]); j++;
          }
          if (j < lines.length && lines[j].startsWith('>>>>>>>')) {
            theirLabel = lines[j].slice(7).trim();
          }
        }
        hunks.push({ startLine: i, endLine: j, ourLabel, theirLabel, ours, theirs });
        i = j + 1;
      } else {
        i++;
      }
    }
    return { ok: true, text, hunks, lines: lines.length };
  });

  // ── Pre-merge quick check: returns total conflict count for current branch
  ipcMain.handle('git-merge-precheck', (_, { projectDir, baseBranch }) => {
    if (!projectDir) return { error: 'missing projectDir' };
    if (!fs.existsSync(path.join(projectDir, '.git'))) return { error: 'not a git repo' };
    const base = baseBranch || gitOut(projectDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')
      || (gitOut(projectDir, ['rev-parse', '--verify', 'main']) ? 'main' : 'master');
    let branches = gitOut(projectDir, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean);
    branches = branches.filter(b => b !== base);
    let conflictBranches = 0;
    let cleanBranches = 0;
    for (const b of branches.slice(0, 30)) {
      const a = analyzeBranchAgainst(projectDir, base, b);
      if (a.conflicts && a.conflicts.length) conflictBranches++;
      else if (a.ahead > 0) cleanBranches++;
    }
    return { base, conflictBranches, cleanBranches, totalBranches: branches.length };
  });

  // Tema do Norya manda no material do vidro (2026-09-07): sem isto o
  // NSVisualEffectView segue a aparência do SISTEMA, e a tinta escura do tema
  // dark sobre vidro claro (ou vice-versa) fica lamacenta.
  ipcMain.handle('set-native-theme', (_e, theme) => {
    const { nativeTheme } = require('electron');
    nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
    return nativeTheme.themeSource;
  });
  ipcMain.handle('quota-get', () => (quotaManager ? quotaManager.getAll() : readQuotaCache()));

  const { createTokenStatsService } = require('./token-stats');
  const tokenStats = createTokenStatsService({
    realHome: REAL_HOME, accountsDir: ACCOUNTS_DIR,
    cachePath: path.join(NORYA_HOME, 'token-usage-index.json'),
  });
  global.__invalidateTokenStats = tokenStats.invalidate;
  ipcMain.handle('get-token-stats', (_event, options) => tokenStats.read({ force: options?.force === true }));
  // Câmbio para mostrar o custo de API também em reais (PTAX/BCB, cache 12 h).
  const fx = require('./fx').createFx({ cachePath: path.join(NORYA_HOME, 'fx-usd-brl.json') });
  ipcMain.handle('get-fx-usd-brl', () => fx.get());
  app.once('before-quit', () => tokenStats.close());

  ipcMain.handle('quota-refresh', async (_, accountNum, provider) => {
    const account = loadAccounts().find(a => a.num === accountNum);
    if (!account) return { error: 'account not found' };
    try {
      // Com provider: só aquele. Sem: todos os providers do perfil, devolvendo
      // o do padrão — é o que os chamadores antigos (profiles.js) esperam.
      if (quotaManager) {
        if (provider) {
          const one = await quotaManager.refresh(accountNum, { provider, force: true });
          return one || { error: 'no output parsed' };
        }
        const all = await quotaManager.refreshProfile(accountNum, { force: true });
        const def = quotaManager.defaultProvider(accountNum);
        return (def && all[def]) || Object.values(all).find(Boolean) || { error: 'no output parsed' };
      }
      // force:true — this IPC is only ever triggered by an explicit user action
      // (manual refresh, re-login). It must bypass the logged-out circuit-breaker
      // so a freshly re-authenticated profile gets re-probed and its flags cleared.
      const parsed = await runQuotaBackground(account, { force: true });
      return parsed || { error: 'no output parsed' };
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('quota-refresh-all', async () => {
    const accounts = loadAccounts();

    // Run at most 5 account checks at a time to avoid exhausting shell/process resources.
    const CONCURRENCY = 5;
    let idx = 0;
    const sendProgress = (a, parsed, err) => {
      if (err) logError(`quota-refresh-all #${a.num}`, err);
    };
    async function worker() {
      while (idx < accounts.length) {
        const a = accounts[idx++];
        try {
          let parsed = null;
          if (quotaManager) {
            const all = await quotaManager.refreshProfile(a.num, { force: true });
            const def = quotaManager.defaultProvider(a.num);
            parsed = (def && all[def]) || Object.values(all).find(Boolean) || null;
          } else {
            parsed = await runQuotaBackground(a, { force: true });
          }
          sendProgress(a, parsed, null);
        } catch (err) {
          sendProgress(a, null, err);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker));
    return { ok: true };
  });

  ipcMain.handle('list-codex-models', async () => {
    const cachePath = path.join(REAL_HOME, '.codex', 'models_cache.json');
    try {
      if (!fs.existsSync(cachePath)) return [];
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const models = (data.models || [])
        .filter(m => m && m.visibility === 'list')
        .map(m => ({
          slug: m.slug,
          display_name: m.display_name || m.slug,
          default_effort: m.default_reasoning_level || 'medium',
          efforts: (m.supported_reasoning_levels || []).map(l => l.effort),
        }));
      return models;
    } catch { return []; }
  });

  // Build a single index of sessionId -> fullPath. Walks the tree once.
  let _sessionIndex = null;
  let _sessionIndexAt = 0;
  function buildSessionIndex() {
    const index = new Map();
    const roots = [];
    try {
      for (const acc of loadAccounts()) {
        roots.push(path.join(acc.dir, '.codex', 'sessions'));
        roots.push(path.join(acc.dir, '.codex', 'archived_sessions'));
      }
    } catch {}
    // Also include archived accounts dirs
    try {
      if (fs.existsSync(ARCHIVED_ACCOUNTS_DIR)) {
        for (const n of fs.readdirSync(ARCHIVED_ACCOUNTS_DIR)) {
          roots.push(path.join(ARCHIVED_ACCOUNTS_DIR, n, '.codex', 'sessions'));
          roots.push(path.join(ARCHIVED_ACCOUNTS_DIR, n, '.codex', 'archived_sessions'));
        }
      }
    } catch {}
    roots.push(path.join(REAL_HOME, '.codex', 'sessions'));
    roots.push(path.join(REAL_HOME, '.codex', 'archived_sessions'));

    // sessionId is a UUID like 019df975-70b0-7341-b787-4e8b2ed9de57.
    const idRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          const full = path.join(cur, ent.name);
          if (ent.isDirectory()) stack.push(full);
          else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
            const m = ent.name.match(idRe);
            if (m && !index.has(m[1])) index.set(m[1], full);
          }
        }
      }
    }
    return index;
  }

  function getSessionIndex() {
    const now = Date.now();
    if (!_sessionIndex || (now - _sessionIndexAt) > 30000) {
      _sessionIndex = buildSessionIndex();
      _sessionIndexAt = now;
    }
    return _sessionIndex;
  }

  function findSessionFile(sessionId) {
    if (!sessionId) return null;
    return getSessionIndex().get(sessionId) || null;
  }

  // Find the newest session JSONL for an account that was created after the given timestamp.
  // Codex creates the session file synchronously when it starts, so this is the fastest way
  // to learn the new thread's UUID for a freshly-spawned codex PTY.
  ipcMain.handle('find-latest-session', (_, { accountNum, sinceMs }) => {
    const acc = loadAccounts().find(a => a.num === accountNum);
    if (!acc) return { error: 'account not found' };
    const root = path.join(acc.dir, '.codex', 'sessions');
    if (!fs.existsSync(root)) return { error: 'sessions dir missing' };
    const cutoff = sinceMs || 0;
    let best = null;
    const idRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) { stack.push(full); continue; }
        if (!ent.name.endsWith('.jsonl')) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const mtime = st.mtimeMs;
        if (mtime < cutoff) continue;
        if (!best || mtime > best.mtime) {
          const m = ent.name.match(idRe);
          if (m) best = { mtime, sessionId: m[1], path: full };
        }
      }
    }
    return best ? { sessionId: best.sessionId, path: best.path } : { error: 'no recent session' };
  });

  ipcMain.handle('list-skills', (_, options) => skillsLibrary.list(options));
  ipcMain.handle('set-skill-enabled', async (_, { id, enabled } = {}) => {
    const snapshot = await skillsLibrary.setEnabled(id, enabled);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('skills-changed', snapshot);
    }
    return snapshot;
  });

  // NOTE: the old startup "force-refresh every account sequentially" loop was
  // REMOVED here (2026-06-17). It was the primary source of the boot quota storm:
  // force:true bypassed the in-flight guard AND re-probed the 5 dead logged-out
  // outlook profiles every 500ms, each spawning a codex app-server that auth-failed
  // (1256 error lines in panel.log). The QuotaManager boot fetch (refreshAll at
  // ~line 2403) already refreshes everyone once, and its circuit-breaker now skips
  // recently-confirmed-dead profiles — so healthy accounts still get fresh numbers
  // at boot without the storm.
});

app.on('window-all-closed', () => {
  Object.values(terminals).forEach(t => { try { t.kill(); } catch {} });
  stopCaffeinate();
  if (!platform.isMac) app.quit();
});

// Norya Browser cleanup: stop MCP/auth socket servers. Runs before app quits.
// Storage do browser NÃO é apagado aqui desde 2026-07-14 — logins persistem.
app.on('before-quit', async (ev) => {
  // Síncrono e primeiro: o Electron não espera handlers async de before-quit,
  // então um socket órfão em /tmp sobreviveria e o próximo boot falharia ao
  // fazer listen no mesmo caminho.
  stopOpenUrlServer();
  stopAgentEventServer();
  for (const id of Object.keys(chats)) { try { chats[id].kill(); } catch {} }
  if (petManager) petManager.stop();
  try { globalShortcut.unregisterAll(); } catch {}
  try {
    if (browserManager) {
      // Close all profile panels — só estado/eventos; desde 2026-07-14 o
      // storage NÃO é apagado no quit (logins do browser sobrevivem a restart).
      const profiles = Array.from(mcpStartedProfiles);
      for (const p of profiles) {
        try { if (browserManager.isPanelOpen(p)) await browserManager.closePanel(p); } catch {}
      }
    }
    if (mcpServer) {
      for (const p of Array.from(mcpStartedProfiles)) {
        try { await mcpServer.stop(p); } catch {}
      }
    }
    if (authFlowRouter) {
      for (const p of Array.from(authActiveProfiles)) {
        try { await authFlowRouter.stop(p); } catch {}
      }
    }
    logLine('before-quit', 'norya-browser cleanup done');
  } catch (e) { logError('before-quit cleanup', e); }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createTestWindow();
});
