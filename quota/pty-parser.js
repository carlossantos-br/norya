'use strict';

/**
 * pty-parser.js — Module 1 of Norya's quota subsystem.
 *
 * Pure, stateless parsing functions. No I/O, no side effects, no external deps.
 * Tolerant regex matching with multiple fallback patterns for each format because
 * CLI output varies across versions and platforms.
 *
 * All functions strip ANSI escape codes before matching.
 */

// ---------------------------------------------------------------------------
// ANSI / OSC stripping
// ---------------------------------------------------------------------------

/**
 * Strip ANSI CSI colour/attribute escapes (\x1b[...m) and OSC sequences
 * (\x1b]...\x07 or \x1b]...\x1b\\) from a string, then normalise whitespace.
 */
function stripAnsi(text) {
  if (typeof text !== 'string') return '';
  return text
    // OSC sequences:  ESC ] ... BEL  or  ESC ] ... ST (ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI sequences:  ESC [ ... <final byte 0x40-0x7E>
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    // Any remaining lone ESC sequences
    .replace(/\x1b[^[\]]/g, '');
}

// ---------------------------------------------------------------------------
// Shared helpers — EXPORTED so sibling modules can import them.
// These MUST match the contract exactly.
// ---------------------------------------------------------------------------

/**
 * Build a single rate-limit window object.
 * @param {number} usedPercent  0-100
 * @param {number|null} resetsAtSec  Unix seconds (or null)
 */
function buildWindow(usedPercent, resetsAtSec) {
  const up = typeof usedPercent === 'number' ? usedPercent : 0;
  return {
    used_percent: up,
    percent_left: Math.max(0, 100 - up),
    resets_at: resetsAtSec || null,
    resets_at_ms: resetsAtSec ? resetsAtSec * 1000 : null,
  };
}

/**
 * Roll up primary + secondary windows into a full QuotaSnapshot (minus source/cli/updatedAt —
 * callers add those).
 */
function rollupSnapshot(primary, secondary, extra = {}) {
  const lefts = [primary, secondary].filter(Boolean).map(w => w.percent_left);
  const useds  = [primary, secondary].filter(Boolean).map(w => w.used_percent);
  return {
    primary:   primary   || null,
    secondary: secondary || null,
    usedPercent: useds.length  ? Math.max(...useds)  : 0,
    percentLeft: lefts.length  ? Math.min(...lefts)  : 100,
    window: primary && secondary ? 'both' : (primary ? '5h' : (secondary ? 'weekly' : '5h')),
    resetsAt: primary ? primary.resets_at_ms : (secondary ? secondary.resets_at_ms : null),
    used: null, total: null,
    updatedAt: Date.now(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a reset-time expression and return Unix seconds (or null).
 * Handles:
 *   - ISO timestamps:           "2026-05-28T18:00:00Z"
 *   - "resets at HH:MM"        (today/tomorrow wall-clock, local time)
 *   - "resets in 2h 30m"
 *   - "in 45 minutes"
 *   - "in 2 hours"
 *   - "in 2h"
 */
function parseResetTime(str) {
  if (!str) return null;

  // ---- Absolute ISO timestamp  e.g. "2026-05-28T18:00:00Z" ----------------
  // Matches: full ISO 8601 with optional fractional seconds and Z or +offset
  const isoMatch = str.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/i);
  if (isoMatch) {
    const ms = Date.parse(isoMatch[0]);
    if (!isNaN(ms)) return Math.floor(ms / 1000);
  }

  // ---- Month-name date ANTES do "at HH:MM": "Sep 9 at 3:59pm" contém "at 3:59"
  // e a regex de relógio a engoliria como "hoje às 15:59". Mês válido é mais
  // específico, então decide primeiro.
  // ---- Month-name date: "Resets Jun 3 at 4pm" / "JJune 3 at 16:00" --------
  // This is the format Claude Code's `/usage` panel prints for the weekly reset.
  const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  // \s* (not \s+) because Claude's TUI output, once ANSI-stripped, glues words
  // together ("Jun3at4pm"). The literal "at" + MONTHS lookup guard against false
  // positives. Non-month captures are rejected by the MONTHS table below.
  const monMatch = str.match(/([a-z]{3,9})\s*(\d{1,2})\s*at\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (monMatch) {
    const mon = MONTHS[monMatch[1].slice(0, 3).toLowerCase()];
    if (mon != null) {
      const day = parseInt(monMatch[2], 10);
      let hours = parseInt(monMatch[3], 10);
      const mins = monMatch[4] ? parseInt(monMatch[4], 10) : 0;
      const ampm = monMatch[5] ? monMatch[5].toLowerCase() : null;
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;
      const now = new Date();
      let year = now.getFullYear();
      let candidate = new Date(year, mon, day, hours, mins, 0, 0);
      // If the date already passed (e.g., Jan reset seen in Dec), roll to next year.
      if (candidate.getTime() < Date.now() - 86400000) {
        candidate = new Date(year + 1, mon, day, hours, mins, 0, 0);
      }
      return Math.floor(candidate.getTime() / 1000);
    }
  }

  // ---- "resets at HH:MM" / "reset at 18:00" / "at 18:00" -----------------
  // Matches: "resets at 18:00", "reset at 6:30 PM", "at 18:00"
  const wallMatch = str.match(/(?:resets?\s+at|at)\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
  if (wallMatch) {
    let hours   = parseInt(wallMatch[1], 10);
    const mins  = parseInt(wallMatch[2], 10);
    const ampm  = wallMatch[3] ? wallMatch[3].toLowerCase() : null;
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    const now = new Date();
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
    // If that time has already passed today, assume tomorrow
    if (candidate.getTime() <= Date.now()) candidate.setDate(candidate.getDate() + 1);
    return Math.floor(candidate.getTime() / 1000);
  }

  // ---- Wall-clock with am/pm and NO "at": "Resets4:50pm(America/Manaus)" ---
  // É o formato do `/usage` do Claude Code 2.1.263 para a janela de 5h, como
  // chega pelo PTY (palavras coladas). am/pm obrigatório: sem ele, "resets 4"
  // dentro de qualquer frase viraria horário.
  const ampmMatch = str.match(/resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const mins = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const ampm = ampmMatch[3].toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    const now = new Date();
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
    if (candidate.getTime() <= Date.now()) candidate.setDate(candidate.getDate() + 1);
    return Math.floor(candidate.getTime() / 1000);
  }

  // ---- Relative: "in 2h 30m" / "in 2 hours 30 minutes" / "in 45 minutes" -
  // Matches: "resets in 2h 30m", "in 2 hours", "in 45 minutes", "in 1h"
  const relMatch = str.match(/in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (relMatch && (relMatch[1] || relMatch[2])) {
    const h = parseInt(relMatch[1] || '0', 10);
    const m = parseInt(relMatch[2] || '0', 10);
    if (h || m) {
      const ms = Date.now() + (h * 3600 + m * 60) * 1000;
      return Math.floor(ms / 1000);
    }
  }

  return null;
}

/**
 * Parse a percentage value and clamp to [0, 100].
 */
function clampPct(n) {
  return Math.min(100, Math.max(0, n));
}

/**
 * Try to extract a used-percent from a text fragment.
 * Returns { usedPercent, _raw } or null.
 *
 * Patterns:
 *   "23% used"               → usedPercent = 23
 *   "usage: 23%"             → usedPercent = 23
 *   "usage limit: 23%"       → usedPercent = 23
 *   "77% left"  or
 *   "77% remaining"          → usedPercent = 100 - 77 = 23
 *   "5h limit: 77% remaining"→ usedPercent = 23  (short window, from "% remaining")
 *   "weekly: 100%"           → usedPercent = 100 (weekly window, raw percent treated as used)
 *   "limit: 77%"             → usedPercent = 23 (treated as remaining)
 */
function extractPercent(text) {
  // Pattern A: "NN% used"  — percent already = used
  // Example:  "23% used"
  let m = text.match(/(\d{1,3})%\s+used/i);
  if (m) return { usedPercent: clampPct(parseInt(m[1], 10)), _raw: m[0] };

  // Pattern B: "usage[: ] NN%"  — percent = used
  // Example:  "usage: 23%"  "usage limit: 23%"
  m = text.match(/usage(?:\s+limit)?[:\s]+(\d{1,3})%/i);
  if (m) return { usedPercent: clampPct(parseInt(m[1], 10)), _raw: m[0] };

  // Pattern C: "NN% left" / "NN% remaining"  — percent = remaining → used = 100 - N
  // Example:  "77% left"  "77% remaining"  "5h limit: 77% remaining"
  m = text.match(/(\d{1,3})%\s+(?:left|remaining)/i);
  if (m) return { usedPercent: clampPct(100 - parseInt(m[1], 10)), _raw: m[0] };

  // Pattern D: "5h limit: NN% remaining" (full phrase already caught above by C, but also
  //            catch just "5h limit: NN%" where no trailing word — treat as remaining)
  // Example:  "5h limit: 77%"
  m = text.match(/5h\s+limit[:\s]+(\d{1,3})%/i);
  if (m) return { usedPercent: clampPct(100 - parseInt(m[1], 10)), _raw: m[0] };

  // Pattern E: "weekly: NN%"  — treat as used-percent for the weekly window
  // Example:  "weekly: 100%"
  m = text.match(/weekly[:\s]+(\d{1,3})%/i);
  if (m) return { usedPercent: clampPct(parseInt(m[1], 10)), _raw: m[0] };

  // Pattern F: "limit: NN%" (generic, treat as remaining if no keyword)
  // Example:  "limit: 77%"
  m = text.match(/limit[:\s]+(\d{1,3})%/i);
  if (m) return { usedPercent: clampPct(100 - parseInt(m[1], 10)), _raw: m[0] };

  // Pattern G: bare "NN%" appearing near quota-flavoured words within 40 chars
  // Example:  "quota 23%"  "rate 77%"
  m = text.match(/(?:quota|rate|allowance|budget)\s+(\d{1,3})%/i);
  if (m) return { usedPercent: clampPct(parseInt(m[1], 10)), _raw: m[0] };

  return null;
}

// ---------------------------------------------------------------------------
// Rate-limit-hit detection patterns
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERNS = [
  // "reached your [daily/hourly/weekly/...] limit"
  // Example: "You have reached your 5-hour usage limit."
  /reached\s+your\s+(?:[\w-]+\s+)*limit/i,

  // "rate limit" (generic)
  // Example: "rate limit exceeded"  "rate limited"
  /rate[\s_-]limit(?:ed|s)?/i,

  // "usage limit reached"
  // Example: "Usage limit reached. Resets in 2h."
  /usage\s+limit\s+reached/i,

  // "out of [tokens/requests/quota/...]"
  // Example: "out of tokens"  "out of requests"
  /out\s+of\s+(?:tokens?|requests?|quota|credits?|messages?)/i,

  // HTTP 429
  // Example: "Error 429"  "HTTP 429"  "status: 429"
  /\b429\b/,

  // "too many requests"
  // Example: "Too many requests, please slow down."
  /too\s+many\s+requests/i,

  // "limit will reset"
  // Example: "Your limit will reset in 2 hours."
  /limit\s+will\s+reset/i,

  // "you've exceeded"
  // Example: "You've exceeded your usage limit."
  /(?:you(?:'ve)?|account)\s+(?:has\s+)?exceeded/i,

  // "temporarily blocked" / "temporarily unavailable" (common platform phrasing)
  // Example: "temporarily blocked due to high usage"
  /temporarily\s+(?:blocked|unavailable|limited)/i,

  // "quota exceeded"
  // Example: "Quota exceeded for project."
  /quota\s+exceeded/i,
];

/**
 * Detect whether a text chunk is announcing a hard rate-limit hit.
 * @param {string} text
 * @param {'codex'|'claude'} cli
 * @returns {{ hit: boolean, resetsAt: number|null, scope: '5h'|'weekly'|'unknown' } | null}
 */
function detectRateLimitHit(text, cli) {
  if (typeof text !== 'string') return null;
  const clean = stripAnsi(text);

  const matched = RATE_LIMIT_PATTERNS.find(re => re.test(clean));
  if (!matched) return null;

  // Try to extract a reset time from the same chunk
  const resetsAt = parseResetTime(clean);

  // Determine scope from contextual keywords
  let scope = 'unknown';
  if (/weekly|week/i.test(clean)) scope = 'weekly';
  else if (/5[\s-]?h(?:our)?|short|hourly|daily/i.test(clean)) scope = '5h';

  return { hit: true, resetsAt: resetsAt ? resetsAt * 1000 : null, scope };
}

// ---------------------------------------------------------------------------
// parseCodexChunk
// ---------------------------------------------------------------------------

/**
 * Parse a chunk of accumulated codex TUI/stdout text.
 * Returns a partial QuotaSnapshot or null.
 *
 * Codex typically prints things like:
 *   "Usage: 23% (resets in 2h 30m)"
 *   "5h limit: 77% remaining"
 *   "Rate limit reached. Resets at 18:00."
 *   "weekly: 100%"
 */
function parseCodexChunk(text) {
  if (typeof text !== 'string') return null;
  const clean = stripAnsi(text);

  // Check for a rate-limit hit first — return early with maxed-out values
  const hitResult = detectRateLimitHit(clean, 'codex');
  if (hitResult && hitResult.hit) {
    const scope = hitResult.scope;
    const w = buildWindow(100, hitResult.resetsAt ? Math.floor(hitResult.resetsAt / 1000) : null);
    const primary   = scope !== 'weekly' ? w : null;
    const secondary = scope === 'weekly'  ? w : null;
    return {
      ...rollupSnapshot(primary, secondary),
      source: 'pty',
      cli: 'codex',
      _raw: clean.slice(0, 200),
    };
  }

  // Look for weekly window first (it has an explicit "weekly:" label)
  let secondary = null;
  const weeklyMatch = clean.match(/weekly[:\s]+(\d{1,3})%/i);
  if (weeklyMatch) {
    const usedPercent = clampPct(parseInt(weeklyMatch[1], 10));
    secondary = buildWindow(usedPercent, null);
  }

  // Look for short-window percent
  let primary = null;
  const pctInfo = extractPercent(clean);
  if (pctInfo && !weeklyMatch) {
    // Only one percent found — treat as primary (short window)
    primary = buildWindow(pctInfo.usedPercent, null);
  } else if (pctInfo && weeklyMatch) {
    // Both windows present — the non-weekly one is primary
    if (!clean.match(/weekly/i) || clean.indexOf(pctInfo._raw) !== clean.search(/weekly/i)) {
      primary = buildWindow(pctInfo.usedPercent, null);
    }
  }

  // Try to extract reset time and attach to whichever window we have
  const resetsAtSec = parseResetTime(clean);
  if (resetsAtSec) {
    if (primary)   { primary.resets_at = resetsAtSec; primary.resets_at_ms = resetsAtSec * 1000; }
    else if (secondary) { secondary.resets_at = resetsAtSec; secondary.resets_at_ms = resetsAtSec * 1000; }
  }

  if (!primary && !secondary) return null;

  return {
    ...rollupSnapshot(primary, secondary),
    source: 'pty',
    cli: 'codex',
    _raw: pctInfo ? pctInfo._raw : (weeklyMatch ? weeklyMatch[0] : ''),
  };
}

// ---------------------------------------------------------------------------
// parseClaudeChunk
// ---------------------------------------------------------------------------

/**
 * Parse accumulated claude CLI stdout during a session (warnings, hints).
 * Returns a partial QuotaSnapshot or null.
 *
 * Claude session output may include things like:
 *   "You're approaching your usage limit (77% used)"
 *   "usage: 23% — resets in 2h 30m"
 *   "Rate limit exceeded. Limit will reset in 45 minutes."
 *   "weekly limit: 100%"
 */
function parseClaudeChunk(text) {
  if (typeof text !== 'string') return null;
  const clean = stripAnsi(text);

  // Rate-limit hit?
  const hitResult = detectRateLimitHit(clean, 'claude');
  if (hitResult && hitResult.hit) {
    const scope = hitResult.scope;
    const w = buildWindow(100, hitResult.resetsAt ? Math.floor(hitResult.resetsAt / 1000) : null);
    const primary   = scope !== 'weekly' ? w : null;
    const secondary = scope === 'weekly'  ? w : null;
    return {
      ...rollupSnapshot(primary, secondary),
      source: 'pty',
      cli: 'claude',
      _raw: clean.slice(0, 200),
    };
  }

  const pctInfo = extractPercent(clean);
  if (!pctInfo) return null;

  const resetsAtSec = parseResetTime(clean);
  const primary = buildWindow(pctInfo.usedPercent, resetsAtSec);

  return {
    ...rollupSnapshot(primary, null),
    source: 'pty',
    cli: 'claude',
    _raw: pctInfo._raw,
  };
}

// ---------------------------------------------------------------------------
// Janelas de uso — forma canônica compartilhada (Claude TUI, Claude HTTP)
// ---------------------------------------------------------------------------

/** Rótulos das janelas do Claude, como o painel Uso as mostra. */
const CLAUDE_WINDOW_LABELS = {
  session: 'Sessão (5h)',
  weekly: 'Semana · todos os modelos',
  extra: 'Uso extra',
};

/**
 * Monta um QuotaSnapshot completo a partir de uma lista de janelas
 * `{ id, label, used_percent, percent_left, resets_at, resets_at_ms }`.
 *
 *   • `primary`   = janela `session` (5h);  `secondary` = janela `weekly` (todos)
 *   • `windows`   = TODAS, na ordem de exibição (inclui as semanais por modelo)
 *   • `usedPercent`/`percentLeft` consideram todas as janelas — uma janela
 *     por modelo esgotada (Fable 100 %) É um limite real, não pode sumir no rollup.
 *
 * `extra` é mesclado por último (source, cli, provider, plan, flags…).
 */
function snapshotFromWindows(windows, extra = {}) {
  const list = (windows || []).filter(Boolean);
  const primary = list.find(w => w.id === 'session') || null;
  const secondary = list.find(w => w.id === 'weekly') || null;
  const snap = rollupSnapshot(primary, secondary, extra);
  if (list.length) {
    snap.usedPercent = Math.max(...list.map(w => w.used_percent));
    snap.percentLeft = Math.min(...list.map(w => w.percent_left));
    const soonest = list.map(w => w.resets_at_ms).filter(Boolean).sort((a, b) => a - b)[0];
    snap.resetsAt = soonest || snap.resetsAt || null;
  }
  snap.windows = list;
  return snap;
}

/**
 * Lê as janelas do `/usage` do Claude Code (2.1.x) por CABEÇALHO:
 *
 *   Currentsession                        ← colado, como chega pelo PTY
 *   ██▌        5%used
 *   Resets4:50pm(America/Manaus)
 *   Currentweek(allmodels) …  ResetsSep9at4pm(…)
 *   Current week (Fable)████  24% usedResets Sep 9 at 3:59pm (…)   ← redraw, 1 linha
 *
 * Cada cabeçalho abre um segmento que vai até o próximo cabeçalho (ou 220
 * chars). Percentual e reset são procurados SÓ dentro do segmento. A TUI
 * repinta partes da tela, então a mesma janela pode aparecer 2×: a última
 * ocorrência vence. Devolve [] quando não reconhece nada — nunca chuta.
 */
function claudeWindowsFrom(clean) {
  const heads = [];
  const re = /current\s*(session|week)\s*(?:\(([^)]*)\))?/ig;
  let m;
  while ((m = re.exec(clean))) {
    heads.push({
      index: m.index,
      end: m.index + m[0].length,
      kind: m[1].toLowerCase(),
      scope: (m[2] || '').replace(/\s+/g, ' ').trim(),
    });
  }

  const byId = new Map();
  heads.forEach((h, i) => {
    const nextIdx = heads[i + 1] ? heads[i + 1].index : clean.length;
    const seg = clean.slice(h.end, Math.min(nextIdx, h.end + 220));
    const pm = seg.match(/(\d{1,3})\s*%\s*used/i);
    if (!pm) return;

    let id, label;
    if (h.kind === 'session') { id = 'session'; label = CLAUDE_WINDOW_LABELS.session; }
    else if (!h.scope || /all\s*models/i.test(h.scope)) { id = 'weekly'; label = CLAUDE_WINDOW_LABELS.weekly; }
    else { id = `weekly:${h.scope}`; label = `Semana · ${h.scope}`; }

    // "Resets…" do segmento. Prefixo "resets " com espaço: a forma colada
    // ("ResetsSep9at4pm") faria a regex de mês engolir "ResetsSep" como mês.
    const rm = seg.match(/resets?\s*([^\n]{0,60})/i);
    const resetSec = rm ? parseResetTime('resets ' + rm[1]) : null;

    const w = buildWindow(clampPct(parseInt(pm[1], 10)), resetSec);
    w.id = id;
    w.label = label;
    w._raw = seg.slice(0, 96).replace(/\s+/g, ' ').trim();
    byId.delete(id);       // reinsere no fim: última ocorrência vence, ordem = último redraw
    byId.set(id, w);
  });

  // Ordem estável de exibição: sessão, semana (todos), depois as por modelo.
  const rank = id => id === 'session' ? 0 : id === 'weekly' ? 1 : 2;
  return Array.from(byId.values()).sort((a, b) => rank(a.id) - rank(b.id));
}

// ---------------------------------------------------------------------------
// parseClaudeStatus
// ---------------------------------------------------------------------------

/**
 * Parse the FULL output of `claude /status`.
 *
 * Example status output (various claude versions):
 *
 *   Account: user@example.com
 *   Subscription: Pro (claude.ai)
 *   Usage limits:
 *     5h window:    23% used   resets at 18:00
 *     weekly:       45% used   resets 2026-05-28T18:00:00Z
 *
 * Also handles single-window output and plain-text variants.
 *
 * Returns a full QuotaSnapshot or null.
 */
function parseClaudeStatus(text) {
  if (typeof text !== 'string') return null;
  const clean = stripAnsi(text);

  // Detect logged-out state. Tightened: must be an explicit logged-out signal.
  // NOT bare "log in"/"login" — Claude's /status panel prints "Login method:
  // Claude Pro account" for LOGGED-IN users, which previously false-positived.
  if (/not\s+logged\s+in|please\s+log\s+in|please\s+run\s+\/login|not\s+authenticated|run\s+\/login\s+to/i.test(clean)) {
    return {
      ...rollupSnapshot(null, null, {
        loggedOut: true,
        errorKind: 'auth',
        source: 'claude-status',
        cli: 'claude',
      }),
    };
  }

  // ---- Extract subscription tier (optional, informational) ----------------
  // Example: "Subscription: Pro (claude.ai)"  "Plan: Free"
  let plan = null;
  const planMatch = clean.match(/(?:subscription|plan)[:\s]+([^\n\r(]+)/i);
  if (planMatch) plan = planMatch[1].trim();

  // ---- Formato real do `/usage` do Claude Code (2.1.x): cabeçalho por janela
  // ("Current session", "Current week (all models)", "Current week (Fable)"),
  // barra, "NN% used" e uma linha "Resets …" logo abaixo. Cada janela é lida no
  // SEU segmento — o reset pertence à janela que o precede, não ao texto todo.
  const windows = claudeWindowsFrom(clean);
  if (windows.length) {
    return snapshotFromWindows(windows, { plan, source: 'claude-status', cli: 'claude' });
  }

  // ---- Fallback: formatos antigos / genéricos ("5h window: 23% used") --------
  let primary = null;

  const shortWindowPatterns = [
    /5[\s-]?h(?:our)?[^%\n]*?(\d{1,3})%\s+used[^\n]*/i,
    /5[\s-]?h(?:our)?[^%\n]*?(\d{1,3})%\s+(?:left|remaining)[^\n]*/i,
    /short[^%\n]*?(\d{1,3})%\s+used[^\n]*/i,
    /primary[^%\n]*?(\d{1,3})%\s+used[^\n]*/i,
    /hourly[^%\n]*?(\d{1,3})%\s+used[^\n]*/i,
  ];

  for (const re of shortWindowPatterns) {
    const m = clean.match(re);
    if (m) {
      const usedPercent = /left|remaining/i.test(m[0])
        ? clampPct(100 - parseInt(m[1], 10))
        : clampPct(parseInt(m[1], 10));
      const resetsAtSec = parseResetTime(m[0]);
      primary = buildWindow(usedPercent, resetsAtSec);
      primary.id = 'session'; primary.label = CLAUDE_WINDOW_LABELS.session;
      primary._raw = m[0].trim();
      break;
    }
  }

  let secondary = null;

  const weeklyPatterns = [
    /weekly[^%\n]*?(\d{1,3})%\s+used[^\n]*/i,
    /weekly[^%\n]*?(\d{1,3})%\s+(?:left|remaining)[^\n]*/i,
    /weekly[:\s]+(\d{1,3})%[^\n]*/i,
    /secondary[^%\n]*?(\d{1,3})%\s+used[^\n]*/i,
  ];

  for (const re of weeklyPatterns) {
    const m = clean.match(re);
    if (m) {
      const usedPercent = /left|remaining/i.test(m[0])
        ? clampPct(100 - parseInt(m[1], 10))
        : clampPct(parseInt(m[1], 10));
      const resetsAtSec = parseResetTime(m[0]);
      secondary = buildWindow(usedPercent, resetsAtSec);
      secondary.id = 'weekly'; secondary.label = CLAUDE_WINDOW_LABELS.weekly;
      secondary._raw = m[0].trim();
      break;
    }
  }

  // ---- Fallback: single generic percent if no window-specific match -------
  if (!primary && !secondary) {
    const pctInfo = extractPercent(clean);
    if (pctInfo) {
      const resetsAtSec = parseResetTime(clean);
      primary = buildWindow(pctInfo.usedPercent, resetsAtSec);
      primary.id = 'session'; primary.label = CLAUDE_WINDOW_LABELS.session;
      primary._raw = pctInfo._raw;
    }
  }

  if (!primary && !secondary) return null;

  // ---- Extract absolute token counts (optional) ---------------------------
  // Example: "Used: 12,500 / 50,000 tokens"
  let used = null, total = null;
  const tokenMatch = clean.match(/used[:\s]+([\d,]+)\s*\/\s*([\d,]+)/i);
  if (tokenMatch) {
    used  = parseInt(tokenMatch[1].replace(/,/g, ''), 10);
    total = parseInt(tokenMatch[2].replace(/,/g, ''), 10);
  }

  return snapshotFromWindows([primary, secondary].filter(Boolean), {
    plan, used, total, source: 'claude-status', cli: 'claude',
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  snapshotFromWindows,
  claudeWindowsFrom,
  CLAUDE_WINDOW_LABELS,
  parseResetTime,
  parseCodexChunk,
  parseClaudeChunk,
  parseClaudeStatus,
  detectRateLimitHit,
  buildWindow,
  rollupSnapshot,
};
