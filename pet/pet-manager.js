'use strict';
/**
 * pet/pet-manager.js — Mini/pet do Norya (reescrito 2026-10-05). Node puro, sem Electron.
 *
 * Paridade com o Mini do app do Codex: o pet, uma pílula por sessão (rodando /
 * requer input / pronto / bloqueada) e uma barra de chat que abre sessão nova.
 *
 * Quem desenha é o helper Swift `helpers/norya-pet` (AppKit puro, sem
 * Chromium). Este módulo só REPASSA: o renderer (renderer/pet.js) calcula o
 * estado, o main liga os eventos do helper às ações. A visibilidade é intenção
 * do usuário (chave `pet`), não depende de tarefa rodando nem de foco.
 *
 * Leveza: o helper só existe com o Mini aberto (pet=true); pet=false = nenhum
 * processo. NENHUM timer aqui (o antigo idle-kill morreu): o processo vive
 * enquanto o Mini estiver aberto, e mensagens só saem quando mudam.
 *
 * Protocolo (uma linha JSON por mensagem; stdin/stdout do helper):
 *   → helper  {op:'config', petKind, size, visibility, badgeCorner, pillsVisible, greeted, positions}
 *             {op:'state', pet, sprite, pills:[{id,status,title,subtitle,canReply,canStop}]}
 *             {op:'show'} | {op:'hide'} | {op:'focusChat'} | {op:'blurChat'}
 *             {op:'pillError', id, text}
 *   ← helper  {ev:'ready'} {ev:'openApp'} {ev:'openPill',id} {ev:'dismissPill',id}
 *             {ev:'mutePill',id} {ev:'reply',id,text} {ev:'stop',id} {ev:'newChat',text}
 *             {ev:'close'} {ev:'hidden'} {ev:'settings'}
 *             {ev:'moved',displayId,w,h,x,y} {ev:'prefs',badgeCorner?,pillsVisible?,greeted?}
 *             {ev:'chatFocus',focused}
 *   stdin fechado = o helper sai.
 * pet.json (statePath): {positions:{"<displayId>":{x,y},"<L>x<A>":{x,y}}, badgeCorner,
 *   pillsVisible, greeted:[], muted:[threadId...]}.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_CRASHES = 3;            // por CRASH_WINDOW_MS; depois desiste até reabrir o Norya
const CRASH_WINDOW_MS = 60 * 1000;
const PERSIST_MIN_MS = 250;       // `moved` contínuo não vira escrita contínua
const MAX_PILLS = 12;
const MAX_MUTED = 200;
const KINDS = ['auto', 'codex', 'clawd', 'none'];
const SPRITES = ['idle', 'running', 'waiting', 'failed', 'review', 'waving'];
const STATUSES = ['running', 'waiting', 'failed', 'review', 'info', 'starting', 'error'];
const CORNERS = ['top-start', 'top-end', 'bottom-start', 'bottom-end'];
const SIZE = { min: 80, max: 224, def: 112 };

const str = (v, n) => String(v == null ? '' : v).slice(0, n);

class PetManager {
  /**
   * @param {object} o
   * @param {string} o.binPath     executável do helper
   * @param {string} o.assetsDir   assets/pet
   * @param {string} o.statePath   pet.json (posições, badge, saudações, mudos)
   * @param {() => void} [o.onOpenApp]            clique no mascote
   * @param {(id:string) => void} [o.onOpenPill]  clique numa pílula (id = threadId)
   * @param {(a:{kind:string,id?:string,text?:string}) => void} [o.onAction]
   *        dismiss | mute | reply | stop | newChat | settings  (o main repassa ao renderer)
   * @param {() => void} [o.onClose]   "Fechar Mini": o main grava pet:false
   * @param {() => void} [o.onOpen]    atalho com o Mini fechado: o main grava pet:true
   * @param {(msg:string) => void} [o.log]
   * @param {Function} [o.spawn]       injetável pros testes
   */
  constructor(o) {
    this.binPath = o.binPath;
    this.assetsDir = o.assetsDir;
    this.statePath = o.statePath;
    this.onOpenApp = o.onOpenApp || (() => {});
    this.onOpenPill = o.onOpenPill || (() => {});
    this.onAction = o.onAction || (() => {});
    this.onClose = o.onClose || (() => {});
    this.onOpen = o.onOpen || (() => {});
    this.log = o.log || (() => {});
    this._spawn = o.spawn || spawn;
    this.now = o.now || Date.now;
    this.prefs = { pet: true, petKind: 'auto', petSize: SIZE.def, petVisibility: 'always' };
    this.state = { pet: 'clawd', sprite: 'idle', pills: [] };
    this.proc = null;
    this.onDemandShown = false;     // onDemand: o usuário mostrou (atalho/menu) e ainda não clicou fora
    this.chatFocused = false;
    this.sent = {};                 // op → última linha enviada (dedupe)
    this.crashes = [];
    this.saved = this._load();
    this._dirty = false;
    this._lastWrite = 0;
  }

  // ── entradas ───────────────────────────────────────────────────────────────

  /** Preferências do norya-state.json (já normalizadas ou parciais). Vale na hora. */
  setPrefs(p) {
    p = p || {};
    const prev = this.prefs;
    const next = Object.assign({}, prev);
    if (typeof p.pet === 'boolean') next.pet = p.pet;
    if (KINDS.includes(p.petKind)) next.petKind = p.petKind;
    if (Number.isFinite(p.petSize)) next.petSize = Math.min(SIZE.max, Math.max(SIZE.min, Math.round(p.petSize)));
    if (p.petVisibility === 'always' || p.petVisibility === 'onDemand') next.petVisibility = p.petVisibility;
    this.prefs = next;
    // onDemand não volta sozinho: ao trocar de modo, o estado "mostrado" recomeça.
    if (prev.petVisibility !== next.petVisibility || (prev.pet && !next.pet)) this.onDemandShown = false;
    this._sync();
  }

  /** Compat: liga/desliga o Mini (chave `pet`). */
  setEnabled(on) { this.setPrefs({ pet: !!on }); }

  get enabled() { return this.prefs.pet; }

  /** Estado vindo do renderer (renderer/pet.js), só quando muda. */
  setState(s) {
    s = s || {};
    const pills = (Array.isArray(s.pills) ? s.pills : []).slice(0, MAX_PILLS)
      .filter(p => p && typeof p.id === 'string' && p.id && STATUSES.includes(p.status))
      .map(p => ({
        id: str(p.id, 200), status: p.status,
        title: str(p.title, 120), subtitle: str(p.subtitle, 140),
        canReply: typeof p.canReply === 'boolean' ? p.canReply : (p.status === 'running' || p.status === 'waiting' || p.status === 'review'),
        canStop: typeof p.canStop === 'boolean' ? p.canStop : p.status === 'running',
      }));
    this.state = {
      pet: s.pet === 'codex' ? 'codex' : 'clawd',
      sprite: SPRITES.includes(s.sprite) ? s.sprite : 'idle',
      pills,
    };
    if (this.proc) this._sendState();
  }

  /**
   * Atalho global ⌃⌥Space (spec §8):
   *   fechado            → abre e foca a barra
   *   barra focada       → solta o foco
   *   onDemand e visível → esconde
   *   aberto sem foco    → foca a barra
   * (Com a barra focada o foco vence o esconder; o 2º toque, já sem foco, esconde.)
   */
  hotkey() {
    if (!this.prefs.pet) {
      this.onOpen();
      this.prefs.pet = true;
      this.onDemandShown = true;
      this._sync();
      this._send({ op: 'focusChat' }, false);
      return 'open';
    }
    if (this.chatFocused) { this._send({ op: 'blurChat' }, false); return 'blur'; }
    if (this.prefs.petVisibility === 'onDemand') {
      if (this.onDemandShown) { this.onDemandShown = false; this._sync(); return 'hide'; }
      this.onDemandShown = true; this._sync();
      this._send({ op: 'focusChat' }, false);
      return 'show';
    }
    this._send({ op: 'focusChat' }, false);
    return 'focus';
  }

  /** Falha de responder/parar: mostra o erro na pílula. */
  pillError(id, text) {
    this._send({ op: 'pillError', id: str(id, 200), text: str(text, 120) }, false);
  }

  /** Threads silenciadas (o renderer aplica o filtro). */
  getMuted() { return (this.saved.muted || []).slice(); }

  // ── processo ───────────────────────────────────────────────────────────────

  _wantVisible() {
    return this.prefs.pet && (this.prefs.petVisibility === 'always' || this.onDemandShown);
  }

  _sync() {
    if (!this.prefs.pet) { this.stop(); return; }
    if (!this._ensureProc()) return;
    this._sendConfig();
    this._sendState();
    this._send({ op: this._wantVisible() ? 'show' : 'hide' }, true, 'vis');
  }

  _configMsg() {
    return {
      op: 'config',
      petKind: this.prefs.petKind,
      size: this.prefs.petSize,
      visibility: this.prefs.petVisibility,
      badgeCorner: this.saved.badgeCorner,
      pillsVisible: this.saved.pillsVisible,
      greeted: this.saved.greeted,
      positions: this.saved.positions,
    };
  }
  _sendConfig() { this._send(this._configMsg(), true, 'config'); }
  _sendState() { this._send(Object.assign({ op: 'state' }, this.state), true, 'state'); }

  _ensureProc() {
    if (this.proc) return true;
    const now = this.now();
    this.crashes = this.crashes.filter(t => now - t < CRASH_WINDOW_MS);
    if (this.crashes.length >= MAX_CRASHES) return false;
    if (!fs.existsSync(this.binPath)) { this.log(`helper ausente: ${this.binPath}`); this.prefs.pet = false; return false; }
    // Os sprites não vêm no repositório (são do Claude.app/ChatGPT.app): sem o
    // manifest gerado por tools/pet-assets.py, o Mini fica desligado.
    if (!fs.existsSync(path.join(this.assetsDir, 'manifest.json'))) { this.log(`sprites ausentes: ${this.assetsDir} (rode tools/pet-assets.py)`); this.prefs.pet = false; return false; }
    let p;
    try {
      p = this._spawn(this.binPath, [this.assetsDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { this.log(`spawn falhou: ${e.message}`); this.crashes.push(now); return false; }
    this.proc = p;
    this.sent = {};
    this.chatFocused = false;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        try { this._onHelper(m); } catch (e) { this.log(`evento: ${e.message}`); }
      }
    });
    p.stderr.on('data', (d) => this.log(String(d).trim()));
    p.stdin.on('error', () => {});   // EPIPE se ele morreu entre o check e a escrita
    p.on('error', (e) => this.log(`helper erro: ${e.message}`));
    p.on('exit', (code, sig) => {
      if (p._stopping || this.proc !== p) return;   // saída pedida por nós (stop)
      this.proc = null;
      this.chatFocused = false;
      this._flush();
      this.crashes.push(this.now());
      this.log(`helper saiu (code=${code} sig=${sig})`);
      this._sync();   // religa (limitado por MAX_CRASHES) enquanto o Mini estiver aberto
    });
    return true;
  }

  _onHelper(m) {
    if (!m || typeof m.ev !== 'string') return;
    switch (m.ev) {
      case 'openApp': this.onOpenApp(); break;
      case 'openPill': if (typeof m.id === 'string') this.onOpenPill(m.id); break;
      case 'dismissPill': if (typeof m.id === 'string') this.onAction({ kind: 'dismiss', id: m.id }); break;
      case 'mutePill':
        if (typeof m.id === 'string' && m.id) {
          const muted = this.saved.muted.filter(x => x !== m.id);
          muted.push(m.id);
          this.saved.muted = muted.slice(-MAX_MUTED);
          this._persist();
          this.onAction({ kind: 'mute', id: m.id });
        }
        break;
      case 'reply':
        if (typeof m.id === 'string' && typeof m.text === 'string' && m.text.trim()) {
          this.onAction({ kind: 'reply', id: m.id, text: m.text.slice(0, 20000) });
        }
        break;
      case 'stop': if (typeof m.id === 'string') this.onAction({ kind: 'stop', id: m.id }); break;
      case 'newChat':
        if (typeof m.text === 'string' && m.text.trim()) this.onAction({ kind: 'newChat', text: m.text.slice(0, 20000) });
        break;
      case 'settings': this.onAction({ kind: 'settings' }); break;
      case 'close':
        // "Fechar Mini": mesma chave do Settings (o main grava pet:false).
        this.prefs.pet = false;
        this.onDemandShown = false;
        this.onClose();
        this.stop();
        break;
      case 'hidden': this.onDemandShown = false; this.sent.vis = JSON.stringify({ op: 'hide' }); break;   // clique fora (onDemand)
      case 'chatFocus': this.chatFocused = !!m.focused; break;
      case 'moved': this._onMoved(m); break;
      case 'prefs': this._onPrefs(m); break;
      default: break;   // ready e o resto: nada a fazer (config já foi na subida)
    }
  }

  _onMoved(m) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    const pos = { x: Math.round(m.x), y: Math.round(m.y) };
    const keys = [];
    if (m.displayId != null && m.displayId !== '') keys.push(String(m.displayId));
    if (Number.isFinite(m.w) && Number.isFinite(m.h)) keys.push(`${Math.round(m.w)}x${Math.round(m.h)}`);
    if (!keys.length) return;
    let changed = false;
    for (const k of keys) {
      const cur = this.saved.positions[k];
      if (!cur || cur.x !== pos.x || cur.y !== pos.y) { this.saved.positions[k] = pos; changed = true; }
    }
    if (changed) this._persist();
    this._resyncConfigQuietly();
  }

  _onPrefs(m) {
    let changed = false;
    if (CORNERS.includes(m.badgeCorner) && this.saved.badgeCorner !== m.badgeCorner) { this.saved.badgeCorner = m.badgeCorner; changed = true; }
    if (typeof m.pillsVisible === 'boolean' && this.saved.pillsVisible !== m.pillsVisible) { this.saved.pillsVisible = m.pillsVisible; changed = true; }
    if (Array.isArray(m.greeted)) {
      const g = [...new Set(m.greeted.filter(x => typeof x === 'string').map(x => x.slice(0, 40)))].slice(0, 20);
      if (JSON.stringify(g) !== JSON.stringify(this.saved.greeted)) { this.saved.greeted = g; changed = true; }
    }
    if (changed) { this._persist(); this._resyncConfigQuietly(); }
  }

  /** O helper já conhece o que acabou de mandar: atualiza o dedupe do config sem reenviar. */
  _resyncConfigQuietly() {
    if (this.sent.config) this.sent.config = JSON.stringify(this._configMsg());
  }

  /** @param {boolean} dedupe  só envia se mudou desde o último envio da mesma `key` */
  _send(msg, dedupe = true, key = msg.op) {
    if (!this.proc) return;
    const line = JSON.stringify(msg);
    if (dedupe) {
      if (this.sent[key] === line) return;
      this.sent[key] = line;
    }
    try { this.proc.stdin.write(line + '\n'); } catch {}
  }

  // ── persistência (pet.json) ────────────────────────────────────────────────

  _load() {
    const out = { positions: {}, badgeCorner: 'top-end', pillsVisible: true, greeted: [], muted: [] };
    let p;
    try { p = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { return out; }
    if (!p || typeof p !== 'object') return out;
    if (p.positions && typeof p.positions === 'object' && !Array.isArray(p.positions)) {
      for (const [k, v] of Object.entries(p.positions)) {
        if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) out.positions[String(k).slice(0, 40)] = { x: v.x, y: v.y };
      }
    }
    if (CORNERS.includes(p.badgeCorner)) out.badgeCorner = p.badgeCorner;
    if (p.pillsVisible === false) out.pillsVisible = false;
    if (Array.isArray(p.greeted)) out.greeted = p.greeted.filter(x => typeof x === 'string').slice(0, 20);
    if (Array.isArray(p.muted)) out.muted = p.muted.filter(x => typeof x === 'string').slice(-MAX_MUTED);
    return out;
  }

  /** Escreve já se faz ≥ 250 ms da última; senão fica sujo e sai na próxima/ao parar. Sem timer. */
  _persist() {
    this._dirty = true;
    if (this.now() - this._lastWrite >= PERSIST_MIN_MS) this._flush();
  }
  _flush() {
    if (!this._dirty) return;
    this._dirty = false;
    this._lastWrite = this.now();
    try { fs.writeFileSync(this.statePath, JSON.stringify(this.saved)); } catch (e) { this.log(`pet.json: ${e.message}`); }
  }

  /** Mata o helper (fechar o stdin já basta; o kill é o cinto de segurança). */
  stop() {
    this._flush();
    const p = this.proc;
    this.chatFocused = false;
    this.sent = {};
    if (!p) return;
    p._stopping = true;
    this.proc = null;   // reabrir já sobe um helper novo; este só termina de sair
    try { p.stdin.end(); } catch {}
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 1500);
    if (t.unref) t.unref();
  }
}

module.exports = { PetManager, SIZE, KINDS };
