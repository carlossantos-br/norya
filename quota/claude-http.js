'use strict';

/**
 * quota/claude-http.js — uso da assinatura Claude pelo endpoint que o PRÓPRIO
 * `/usage` do Claude Code consulta: `GET https://api.anthropic.com/api/oauth/usage`
 * com o accessToken OAuth do usuário (Keychain) ou o token do `setup-token`.
 *
 * Verificado em 2026-09-08 (Claude Code 2.1.263, conta Max 5x): HTTP 200 em
 * ~300 ms, JSON com `limits[]` (session / weekly_all / weekly_scoped por modelo,
 * cada um com percent, resets_at ISO e severity), `five_hour`, `seven_day`,
 * `extra_usage` e `spend`. Fixture real em test/fixtures/claude-oauth-usage.json.
 *
 * Substitui a sonda por TUI escondida (claude-status.js) como fonte PRIMÁRIA:
 * ela custava 3-10 s subindo um Claude inteiro e perdia janelas no parse. A TUI
 * fica como fallback só quando este endpoint recusa o token (401/403) — nesse
 * caso é o próprio CLI que renova o OAuth ao abrir, e a leitura seguinte volta
 * a ser por aqui.
 *
 * Regras:
 *   • o token NUNCA vai para log — só `kind` (keychain|isolated) e o status HTTP;
 *   • sem janela reconhecida → null (nunca inventa 0 %);
 *   • Node builtins + deps injetadas (https) — ver quota/CONTRACT.md.
 */

const { buildWindow, snapshotFromWindows, CLAUDE_WINDOW_LABELS } = require('./pty-parser');

const HOST = 'api.anthropic.com';
const PATH = '/api/oauth/usage';
const BETA = 'oauth-2025-04-20';   // mesmo header que o Claude Code manda
const DEFAULT_TIMEOUT_MS = 8000;

const clamp = n => Math.min(100, Math.max(0, n));
const cap = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : null);

/**
 * "Max 5x" a partir de rateLimitTier `default_claude_max_5x`; sem tier, o tipo
 * da assinatura capitalizado (Pro, Max, Team…). null quando não se sabe.
 */
function planLabelFrom(meta) {
  if (!meta) return null;
  const m = String(meta.rateLimitTier || '').match(/max_(\d+)x/i);
  if (m) return `Max ${m[1]}x`;
  return meta.subscriptionType ? cap(meta.subscriptionType) : null;
}

/** Janela a partir de (percent, ISO). Guarda o ms exato — a API dá sub-segundo. */
function windowFrom(id, label, percent, resetsAtIso, severity) {
  const ms = resetsAtIso ? Date.parse(resetsAtIso) : NaN;
  const w = buildWindow(clamp(Math.round(Number(percent))), Number.isFinite(ms) ? Math.floor(ms / 1000) : null);
  if (Number.isFinite(ms)) w.resets_at_ms = ms;
  w.id = id;
  w.label = label;
  if (severity) w.severity = severity;
  return w;
}

function scopedId(scope) {
  const model = scope && scope.model && scope.model.display_name;
  const name = model || (scope && scope.surface) || 'modelo';
  return { id: `weekly:${name}`, label: `Semana · ${name}` };
}

/**
 * Converte a resposta do endpoint num QuotaSnapshot (sem updatedAt de rede —
 * o chamador carimba). `cred` = { kind, identity, meta } — o token não entra.
 *
 * `limits[]` é a lista que o Claude Code exibe, na ordem dele; quando não vem,
 * cai nos campos fixos (`five_hour`, `seven_day`, `seven_day_<modelo>`).
 */
function parseOauthUsage(json, cred = {}) {
  if (!json || typeof json !== 'object') return null;
  const windows = [];

  if (Array.isArray(json.limits) && json.limits.length) {
    for (const l of json.limits) {
      if (!l || typeof l.percent !== 'number') continue;
      if (l.kind === 'session') windows.push(windowFrom('session', CLAUDE_WINDOW_LABELS.session, l.percent, l.resets_at, l.severity));
      else if (l.kind === 'weekly_all') windows.push(windowFrom('weekly', CLAUDE_WINDOW_LABELS.weekly, l.percent, l.resets_at, l.severity));
      else if (l.kind === 'weekly_scoped') { const s = scopedId(l.scope); windows.push(windowFrom(s.id, s.label, l.percent, l.resets_at, l.severity)); }
      else windows.push(windowFrom(String(l.kind), cap(String(l.kind).replace(/_/g, ' ')), l.percent, l.resets_at, l.severity));
    }
  } else {
    const fixed = [
      ['five_hour', 'session', CLAUDE_WINDOW_LABELS.session],
      ['seven_day', 'weekly', CLAUDE_WINDOW_LABELS.weekly],
      ['seven_day_opus', 'weekly:Opus', 'Semana · Opus'],
      ['seven_day_sonnet', 'weekly:Sonnet', 'Semana · Sonnet'],
    ];
    for (const [field, id, label] of fixed) {
      const v = json[field];
      if (v && typeof v.utilization === 'number') windows.push(windowFrom(id, label, v.utilization, v.resets_at, null));
    }
  }

  // Uso extra (pós-pago, em dinheiro) — só aparece quando o usuário ligou.
  const eu = json.extra_usage;
  let extraUsage = { enabled: false };
  if (eu && eu.is_enabled) {
    extraUsage = {
      enabled: true,
      utilization: typeof eu.utilization === 'number' ? eu.utilization : null,
      used: eu.used_credits ?? null,
      limit: eu.monthly_limit ?? null,
      currency: eu.currency || null,
      decimals: typeof eu.decimal_places === 'number' ? eu.decimal_places : null,
    };
    if (extraUsage.utilization != null) windows.push(windowFrom('extra', CLAUDE_WINDOW_LABELS.extra, extraUsage.utilization, null, null));
  }

  // "Usage credits" (spend) — cobre quando o plano estoura; off por padrão.
  const sp = json.spend;
  const usageCredits = sp && sp.enabled
    ? { enabled: true, percent: sp.percent ?? null, used: sp.used ?? null, limit: sp.limit ?? null, balance: sp.balance ?? null }
    : null;

  if (!windows.length) return null;

  const meta = cred.meta || null;
  return snapshotFromWindows(windows, {
    plan: (meta && meta.subscriptionType) || null,
    planLabel: planLabelFrom(meta),
    identity: cred.identity || null,
    extraUsage,
    usageCredits,
    source: 'claude-http',
    cli: 'claude',
    provider: 'claude',
  });
}

class ClaudeUsageHttpFetcher {
  /**
   * @param {object} opts
   * @param {function(number): (object|Promise<object>|null)} opts.getClaudeCredential
   *        → { token, kind: 'keychain'|'isolated', identity, meta } | null
   * @param {object}   opts.https   — módulo https (injetado, testável)
   * @param {function} [opts.logFn]
   */
  constructor({ getClaudeCredential, https, logFn } = {}) {
    if (!getClaudeCredential) throw new Error('ClaudeUsageHttpFetcher: getClaudeCredential é obrigatório');
    if (!https) throw new Error('ClaudeUsageHttpFetcher: https é obrigatório');
    this._getCred = getClaudeCredential;
    this._https = https;
    this._log = typeof logFn === 'function' ? logFn : () => {};
  }

  /** @returns {Promise<QuotaSnapshot>} — nunca rejeita; falha vira snapshot com errorKind. */
  async fetch(profileNum, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const base = { source: 'claude-http', cli: 'claude', provider: 'claude' };
    const fail = (errorKind, extra = {}) => ({ ...base, errorKind, ...extra, updatedAt: Date.now() });

    let cred = null;
    try { cred = await this._getCred(profileNum); }
    catch (err) { this._log(`[claude-http] #${profileNum} credencial indisponível: ${err.message}`); }
    if (!cred || !cred.token) {
      this._log(`[claude-http] #${profileNum} sem credencial → deslogado`);
      return fail('auth', { loggedOut: true });
    }

    const r = await this._get(cred.token, timeoutMs);
    const tag = `[claude-http] #${profileNum} kind=${cred.kind || '?'}`;
    if (r.error === 'timeout') { this._log(`${tag} timeout ${timeoutMs}ms`); return fail('timeout'); }
    if (r.error) { this._log(`${tag} rede: ${r.error}`); return fail('error'); }
    if (r.status === 401 || r.status === 403) {
      // Token vencido/recusado ≠ deslogado: o Claude Code renova o OAuth ao abrir.
      this._log(`${tag} HTTP ${r.status} → token recusado (fallback TUI)`);
      return fail('auth', { tokenRejected: true });
    }
    if (r.status !== 200) { this._log(`${tag} HTTP ${r.status}`); return fail('error'); }

    let json = null;
    try { json = JSON.parse(r.body); } catch { this._log(`${tag} corpo não é JSON`); return fail('error'); }
    const snap = parseOauthUsage(json, cred);
    if (!snap) { this._log(`${tag} HTTP 200 sem janelas reconhecidas`); return fail('error'); }
    snap.updatedAt = Date.now();
    this._log(`${tag} HTTP 200 · ${snap.windows.map(w => `${w.id} ${w.used_percent}%`).join(' · ')}`);
    return snap;
  }

  /** GET com timer próprio: não confia só no evento 'timeout' do socket. */
  _get(token, timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const settle = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      let req = null;
      const timer = setTimeout(() => { try { req && req.destroy(); } catch {} settle({ error: 'timeout' }); }, timeoutMs);
      try {
        req = this._https.request({
          hostname: HOST,
          path: PATH,
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + token,
            'anthropic-beta': BETA,
            Accept: 'application/json',
            'User-Agent': 'norya-quota',
          },
          timeout: timeoutMs,
        }, res => {
          let body = '';
          try { res.setEncoding('utf8'); } catch {}
          res.on('data', d => { body += d; });
          res.on('end', () => settle({ status: res.statusCode || 0, body }));
          res.on('error', err => settle({ error: (err && err.message) || 'res' }));
        });
        req.on('error', err => settle({ error: (err && err.message) || 'req' }));
        req.on('timeout', () => { try { req.destroy(); } catch {} settle({ error: 'timeout' }); });
        req.end();
      } catch (err) {
        settle({ error: (err && err.message) || 'request' });
      }
    });
  }
}

module.exports = { ClaudeUsageHttpFetcher, parseOauthUsage, planLabelFrom };
