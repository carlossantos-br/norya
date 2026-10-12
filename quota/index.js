'use strict';

/**
 * Module 5: QuotaManager — Orchestrator
 *
 * Ties together QuotaStore, CodexQuotaFetcher, ClaudeUsageHttpFetcher (primário
 * do Claude), ClaudeStatusFetcher (fallback por TUI) and pty-parser into the
 * single object that main.js talks to.
 *
 * Contract: app/quota/CONTRACT.md §Module 5
 *
 * ── Um snapshot por (perfil, provider) — 2026-09-08 ─────────────────────────
 * Chave composta "12:codex" no store. A chave legada "12" continua sendo gravada
 * como ESPELHO do provider padrão do perfil (authMode): é ela que health badge,
 * cartão de perfil e pickers leem, e nenhum deles precisou mudar. Este módulo é
 * o único que escreve as duas.
 *
 * Constructor injections:
 *   getAccountContext(profileNum, provider?) → { num, dir, env, authMode, shell,
 *        nvmScript, quotaProviders?, defaultProvider? }
 *   getClaudeCredential(profileNum) → { token, kind, identity, meta } | null
 *   grokFetch(profileNum) → Promise<{ state, snapshot?, error? }>
 *   cachePath, childSpawn, https, pty, fs, logFn, shellPrelude
 *   parser — optional parser override (defaults to require('./pty-parser'))
 */

const { EventEmitter } = require('events');

// Siblings are required lazily via try/catch so the module can still be constructed
// (and tested with stubs) even if the sibling files haven't been written yet.
function tryRequire(path) {
  try {
    return require(path);
  } catch (_) {
    return null;
  }
}

// authMode → provider que se mede. Espelha agents/registry.js (campo `quota`).
const PROVIDER_BY_AUTH = { chatgpt: 'codex', apikey: 'codex', claude: 'claude', grok: 'grok' };
const QUOTA_PROVIDERS = new Set(['codex', 'claude', 'grok']);
const keyOf = (num, provider) => `${num}:${provider}`;

class QuotaManager extends EventEmitter {
  constructor(opts = {}) {
    super();

    const {
      getAccountContext,
      getClaudeCredential,
      grokFetch,
      cachePath,
      childSpawn,
      https,
      pty,
      fs,
      logFn,
      // PATH canônico do spawn (main.js agentShellPrelude) — repassado ao probe
      // do Claude; sem ele o PTY escondido morria com exit 127 (claude fora do PATH).
      shellPrelude,
      // Optional override so tests can inject a fake parser without the sibling file existing.
      parser: parserOverride,
    } = opts;

    this._getAccountContext = getAccountContext;
    this._log = typeof logFn === 'function' ? logFn : () => {};

    // Resolve parser: use override if provided, else try to require the sibling.
    this._parser = parserOverride || tryRequire('./pty-parser');

    const QuotaStore = tryRequire('./quota-store');
    this.store = QuotaStore ? new QuotaStore({ cachePath, fs }) : null;

    const CodexQuotaFetcher = tryRequire('./codex-http');
    this.codexFetcher = CodexQuotaFetcher
      ? new CodexQuotaFetcher({ getAccountContext, childSpawn, https, logFn })
      : null;

    // Claude — fonte PRIMÁRIA: o endpoint do próprio /usage (barato, exato).
    const claudeHttp = tryRequire('./claude-http');
    this.claudeHttpFetcher = null;
    if (claudeHttp && typeof getClaudeCredential === 'function' && https) {
      try {
        this.claudeHttpFetcher = new claudeHttp.ClaudeUsageHttpFetcher({ getClaudeCredential, https, logFn });
      } catch (_) { this.claudeHttpFetcher = null; }
    }

    // Claude — FALLBACK: TUI escondida, só quando o HTTP recusa o token (o CLI
    // renova o OAuth ao abrir). O contexto pede o env do Claude explicitamente:
    // num perfil cujo padrão é Codex, o HOME/USER precisam ser os do Claude.
    const ClaudeStatusFetcher = tryRequire('./claude-status');
    this.claudeFetcher = null;
    if (ClaudeStatusFetcher) {
      try {
        this.claudeFetcher = new ClaudeStatusFetcher({
          getAccountContext: (n) => getAccountContext(n, 'claude'),
          pty,
          parser: this._parser || {},
          shellPrelude,
          logFn,
        });
      } catch (_) { this.claudeFetcher = null; }
    }

    // Grok — sob demanda, injetado pelo main.js (precisa do env do perfil).
    this._grokFetch = typeof grokFetch === 'function' ? grokFetch : null;

    // Rolling PTY text buffers / throttle / in-flight — todos por chave composta.
    this._buffers = new Map();
    this._lastParse = new Map();
    this._inflight = new Map();
    this._pausedProviders = new Set();

    this._wireStoreEvents();
  }

  _wireStoreEvents() {
    if (this.store && typeof this.store.on === 'function') {
      this.store.on('change', (e) => this.emit('quota', e));
    }
  }

  // ---------------------------------------------------------------------------
  // Contexto do perfil
  // ---------------------------------------------------------------------------

  _ctx(num, provider) {
    try { return this._getAccountContext(num, provider) || null; } catch (_) { return null; }
  }

  /** Provider padrão do perfil (o que a chave legada espelha). null = nada a medir. */
  defaultProvider(num) {
    const ctx = this._ctx(num);
    if (!ctx) return null;
    if (ctx.defaultProvider !== undefined) return ctx.defaultProvider;
    return PROVIDER_BY_AUTH[ctx.authMode] || null;
  }

  /** Providers que o painel Uso mostra para o perfil (main.js: quotaProvidersFor). */
  providersOf(num) {
    const ctx = this._ctx(num);
    if (ctx && Array.isArray(ctx.quotaProviders)) return ctx.quotaProviders.filter(p => QUOTA_PROVIDERS.has(p));
    const d = this.defaultProvider(num);
    return d ? [d] : [];
  }

  // ---------------------------------------------------------------------------
  // Public API — delegating to store
  // ---------------------------------------------------------------------------

  start() {
    if (this.store && typeof this.store.load === 'function') this.store.load();
  }

  /**
   * @param {number} profileNum
   * @param {string} [provider] — com provider: chave composta; sem: espelho legado
   */
  get(profileNum, provider) {
    if (!this.store) return null;
    return provider ? this.store.get(keyOf(profileNum, provider)) : this.store.get(profileNum);
  }

  getAll() {
    return this.store ? this.store.getAll() : {};
  }

  /** Clear status flags (after re-login). Sem provider: legado + todas as compostas do perfil. */
  clearFlags(profileNum, provider) {
    if (!this.store || typeof this.store.clearFlags !== 'function') return;
    if (provider) { this.store.clearFlags(keyOf(profileNum, provider)); return; }
    this.store.clearFlags(profileNum);
    const prefix = `${profileNum}:`;
    for (const key of Object.keys(this.store.getAll())) {
      if (key.startsWith(prefix)) this.store.clearFlags(key);
    }
  }

  /** Grava na chave composta e, se for o provider padrão, também no espelho legado. */
  _commit(num, provider, partial) {
    if (!this.store || typeof this.store.update !== 'function') return partial || null;
    const merged = this.store.update(keyOf(num, provider), partial);
    if (provider === this.defaultProvider(num)) this.store.update(String(num), partial);
    return merged;
  }

  // ---------------------------------------------------------------------------
  // feedPty — live PTY data hook
  // ---------------------------------------------------------------------------

  /**
   * Called from main.js inside ptyProcess.onData for codex/claude PTYs.
   * Accumulates a rolling ~8KB buffer per (profile, cli), throttles parsing to
   * once/500ms, and if quota signals or a rate-limit hit are found, updates the store.
   *
   * @param {number} profileNum
   * @param {'codex'|'claude'} cli
   * @param {string} chunk
   */
  feedPty(profileNum, cli, chunk) {
    if (!QUOTA_PROVIDERS.has(cli)) return;
    const key = keyOf(profileNum, cli);
    const prev = this._buffers.get(key) || '';
    // Corte amortizado: só passa do teto em 25% e corta de uma vez (o slice a
    // cada chunk copiava ~8K chars dezenas de vezes por segundo por pane). O
    // corte exato nos últimos 8192 acontece só na hora de parsear (a cada 500 ms),
    // então o parser vê exatamente o que via antes.
    let buf = prev + chunk;
    this._buffers.set(key, buf.length > 8192 * 1.25 ? buf.slice(-8192) : buf);

    const now = Date.now();
    const lastParse = this._lastParse.get(key) || 0;
    if (now - lastParse < 500) return;
    this._lastParse.set(key, now);
    if (buf.length > 8192) { buf = buf.slice(-8192); this._buffers.set(key, buf); }

    const parser = this._parser;
    if (!parser) return;

    let hitResult = null;
    if (typeof parser.detectRateLimitHit === 'function') {
      hitResult = parser.detectRateLimitHit(buf, cli);
    }

    if (hitResult && hitResult.hit) {
      const { resetsAt, scope } = hitResult;
      const resetsAtSec = resetsAt ? Math.round(resetsAt / 1000) : null;
      const bw = typeof parser.buildWindow === 'function' ? parser.buildWindow : _buildWindow;

      let primary = null;
      let secondary = null;
      if (scope === '5h') primary = bw(100, resetsAtSec);
      else if (scope === 'weekly') secondary = bw(100, resetsAtSec);
      else { primary = bw(100, resetsAtSec); secondary = bw(100, resetsAtSec); }

      this._commit(profileNum, cli, {
        ...(primary ? { primary } : {}),
        ...(secondary ? { secondary } : {}),
        usedPercent: 100,
        percentLeft: 0,
        resetsAt,
        source: 'pty',
        cli,
        provider: cli,
      });
      return;
    }

    let partial = null;
    if (cli === 'codex' && typeof parser.parseCodexChunk === 'function') partial = parser.parseCodexChunk(buf);
    else if (cli === 'claude' && typeof parser.parseClaudeChunk === 'function') partial = parser.parseClaudeChunk(buf);

    if (partial) this._commit(profileNum, cli, { ...partial, source: 'pty', cli, provider: cli });
  }

  // ---------------------------------------------------------------------------
  // refresh — authoritative fetch for one (profile, provider)
  // ---------------------------------------------------------------------------

  /**
   * @param {number} profileNum
   * @param {object} [opts]
   * @param {string} [opts.provider] — 'codex'|'claude'|'grok'; default = provider padrão
   * @param {string} [opts.cli]      — alias antigo de provider
   * @param {boolean} [opts.force]   — ação explícita: ignora breaker e in-flight
   * @returns {Promise<QuotaSnapshot|null>}
   */
  async pauseProvider(provider) {
    this._pausedProviders.add(provider);
    await Promise.allSettled([...this._inflight].filter(([key]) => key.endsWith(`:${provider}`)).map(([, promise]) => promise));
  }

  resumeProvider(provider) { this._pausedProviders.delete(provider); }

  async refresh(profileNum, { provider, cli, force } = {}) {
    const p = provider || cli || this.defaultProvider(profileNum);
    if (!p || !QUOTA_PROVIDERS.has(p)) return null;
    const key = keyOf(profileNum, p);
    if (this._pausedProviders.has(p)) return this.store?.get(key) || null;

    // ── Circuit-breaker por chave: perfil deslogado NUM provider não trava os
    // outros. Explicit user actions pass {force:true} and bypass; a successful
    // forced fetch clears the flags (see _doRefresh) → self-healing.
    if (!force && this.store && typeof this.store.get === 'function') {
      const cached = this.store.get(key);
      if (cached && (cached.loggedOut || cached.errorKind === 'auth')) {
        const age = Date.now() - (cached.updatedAt || 0);
        if (age < QuotaManager.AUTH_RECHECK_MS) {
          this._log(`[quota] ${key} skipped (circuit-breaker: logged-out, age ${Math.round(age / 1000)}s)`);
          return cached;
        }
      }
    }

    // Já em voo → junta-se a ele, MESMO com force. O force existe para furar o
    // breaker de deslogado, não para subir um segundo app-server (o ↻ do
    // painel durante o boot fazia exatamente isso).
    if (this._inflight.has(key)) return this._inflight.get(key);

    const promise = this._doRefresh(profileNum, p);
    this._inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this._inflight.get(key) === promise) this._inflight.delete(key);
    }
  }

  async _doRefresh(profileNum, provider) {
    let result = null;
    if (provider === 'codex') {
      if (!this.codexFetcher || typeof this.codexFetcher.fetch !== 'function') {
        this._log(`[quota] codexFetcher not available for profile=${profileNum}`);
        return null;
      }
      result = await this.codexFetcher.fetch(profileNum);
    } else if (provider === 'claude') {
      result = await this._fetchClaude(profileNum);
    } else if (provider === 'grok') {
      result = await this._fetchGrok(profileNum);
    }
    if (!result) return null;

    result.provider = provider;
    // On a SUCCESSFUL reading (real window data, no error), explicitly clear
    // any stale error flags from a previous failed fetch. Without this the
    // store's field-by-field merge would preserve an old loggedOut/errorKind
    // alongside the fresh percentages.
    const hasData = !!(result.primary || result.secondary || (result.windows && result.windows.length));
    if (hasData && !result.errorKind && !result.loggedOut && !result.noCredit) {
      result.loggedOut = false;
      result.noCredit = false;
      result.errorKind = null;
      result.tokenRejected = false;
      // updatedAt é carimbado em TODO merge (inclusive erro); readAt só aqui.
      // É o que o painel usa para dizer "há 3min" sem mentir após uma falha.
      result.readAt = Date.now();
    }
    return this._commit(profileNum, provider, result);
  }

  /** HTTP primeiro; TUI só quando o HTTP recusou o token (o CLI renova o OAuth). */
  async _fetchClaude(profileNum) {
    if (this.claudeHttpFetcher) {
      const r = await this.claudeHttpFetcher.fetch(profileNum);
      if (!(r && r.tokenRejected)) return r;   // 200, deslogado ou rede: decidido aqui
      if (this.claudeFetcher && typeof this.claudeFetcher.fetch === 'function') {
        this._log(`[quota] #${profileNum} claude: token recusado → sonda TUI (renova o OAuth)`);
        const t = await this.claudeFetcher.fetch(profileNum);
        return t || r;
      }
      return r;
    }
    if (this.claudeFetcher && typeof this.claudeFetcher.fetch === 'function') {
      return this.claudeFetcher.fetch(profileNum);
    }
    this._log(`[quota] claudeFetcher not available for profile=${profileNum}`);
    return null;
  }

  /** Grok: { state, snapshot } do GrokUsageFetcher → QuotaSnapshot honesto. */
  async _fetchGrok(profileNum) {
    if (!this._grokFetch) return null;
    let r;
    try { r = await this._grokFetch(profileNum); }
    catch (e) { r = { state: 'error', error: String((e && e.message) || e) }; }
    const base = { source: 'grok-usage', cli: 'grok', provider: 'grok', updatedAt: Date.now() };
    if (!r) return { ...base, errorKind: 'error' };
    if (r.state === 'ok' && r.snapshot) {
      const s = { ...r.snapshot, ...base };
      if (!Array.isArray(s.windows)) {
        s.windows = [
          s.primary && { ...s.primary, id: 'session', label: 'Janela de 5h' },
          s.secondary && { ...s.secondary, id: 'weekly', label: 'Semanal · pool SuperGrok' },
        ].filter(Boolean);
      }
      return s;
    }
    if (r.state === 'logged-out') return { ...base, loggedOut: true, errorKind: 'auth' };
    return {
      ...base,
      errorKind: 'error',
      errorDetail: r.error || (r.state === 'unknown' ? 'saída do /usage não reconhecida' : null),
    };
  }

  // ---------------------------------------------------------------------------
  // refreshProfile / refreshAll
  // ---------------------------------------------------------------------------

  /** Todos os providers do perfil. @returns {{ [provider]: QuotaSnapshot|null }} */
  async refreshProfile(profileNum, { force } = {}) {
    const out = {};
    for (const p of this.providersOf(profileNum)) {
      try { out[p] = await this.refresh(profileNum, { provider: p, force }); }
      catch (_) { out[p] = null; }
    }
    return out;
  }

  /**
   * Fetch quota for all given profiles × providers, bounded concurrency.
   * Errors are swallowed (each job is independent).
   * @param {Array<{num: number}>} profiles
   */
  async refreshAll(profiles) {
    const jobs = [];
    for (const p of profiles || []) {
      for (const provider of this.providersOf(p.num)) jobs.push({ num: p.num, provider });
    }
    // A small worker pool keeps the boot fetch in waves of ~4 (a codex
    // app-server per job; the breaker still skips dead profiles instantly).
    const CONCURRENCY = 4;
    let idx = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        const j = jobs[idx++];
        try { await this.refresh(j.num, { provider: j.provider }); } catch (_) {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  }
}

// Inline fallback buildWindow (used if parser sibling not available yet)
function _buildWindow(usedPercent, resetsAtSec) {
  const up = typeof usedPercent === 'number' ? usedPercent : 0;
  return {
    used_percent: up,
    percent_left: Math.max(0, 100 - up),
    resets_at: resetsAtSec || null,
    resets_at_ms: resetsAtSec ? resetsAtSec * 1000 : null,
  };
}

// How long to trust a persisted logged-out/auth-failure verdict before an
// AUTOMATIC sweep is allowed to re-probe that key again (6h). Explicit
// {force:true} refreshes always bypass this.
QuotaManager.AUTH_RECHECK_MS = 6 * 60 * 60 * 1000;
QuotaManager.PROVIDER_BY_AUTH = PROVIDER_BY_AUTH;
QuotaManager.keyOf = keyOf;

module.exports = QuotaManager;
