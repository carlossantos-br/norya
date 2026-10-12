'use strict';

// Module 3: CodexQuotaFetcher
// Spawns `codex app-server --listen stdio://`, performs JSON-RPC initialize + account/rateLimits/read,
// parses the result into a QuotaSnapshot, and handles auth/timeout failures.
//
// Replicates the exact logic of main.js parseRateLimitsResponse + runQuotaBackground.

// ---------------------------------------------------------------------------
// Local copies of buildWindow / rollupSnapshot (also exported by pty-parser.js,
// copied here so this module has zero coupling to sibling agents at runtime).
// ---------------------------------------------------------------------------

/**
 * Build a single rate-limit window object.
 * Matches CONTRACT §Canonical shape and main.js parseRateLimitsResponse.
 * @param {number} usedPercent
 * @param {number|null} resetsAtSec  – unix SECONDS (from API)
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
 * Roll up primary + secondary windows into a top-level QuotaSnapshot.
 * `extra` is merged last (source, cli, flags, etc.).
 */
function rollupSnapshot(primary, secondary, extra = {}) {
  const lefts = [primary, secondary].filter(Boolean).map(w => w.percent_left);
  const useds  = [primary, secondary].filter(Boolean).map(w => w.used_percent);
  return {
    primary:     primary   || null,
    secondary:   secondary || null,
    usedPercent: useds.length  ? Math.max(...useds)  : 0,
    percentLeft: lefts.length  ? Math.min(...lefts)  : 100,
    window:      primary && secondary ? 'both' : (primary ? '5h' : (secondary ? 'weekly' : '5h')),
    resetsAt:    primary ? primary.resets_at_ms : (secondary ? secondary.resets_at_ms : null),
    used:  null,
    total: null,
    updatedAt: Date.now(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// parseRateLimitsResponse — replicated from main.js lines 1523-1563 exactly.
// Takes msg.result and returns a partial QuotaSnapshot (no source/cli tags).
// ---------------------------------------------------------------------------
function parseRateLimitsResponse(result) {
  const snap = result && result.rateLimits;
  if (!snap) return null;

  let primary   = null;
  let secondary = null;

  if (snap.primary && snap.secondary) {
    // Identify the short window (≤360 min = 6 h) vs. the long window.
    const isShortPrimary = (snap.primary.windowDurationMins || 0) <= 360;
    const short = isShortPrimary ? snap.primary   : snap.secondary;
    const long  = isShortPrimary ? snap.secondary : snap.primary;
    primary   = buildWindow(short.usedPercent, short.resetsAt);
    secondary = buildWindow(long.usedPercent,  long.resetsAt);
  } else if (snap.primary) {
    const w = snap.primary;
    if ((w.windowDurationMins || 0) <= 360) {
      primary = buildWindow(w.usedPercent, w.resetsAt);
    } else {
      secondary = buildWindow(w.usedPercent, w.resetsAt);
    }
  }

  // Rótulos/ids das janelas — o painel Uso desenha a partir de `windows`.
  if (primary)   { primary.id = 'session';  primary.label = 'Janela de 5h'; }
  if (secondary) { secondary.id = 'weekly'; secondary.label = 'Semanal'; }
  const windows = [primary, secondary].filter(Boolean);

  // Plano, créditos e resets grátis: a API já manda, o painel passa a mostrar.
  const planType = snap.planType || null;
  const credits = snap.credits
    ? { hasCredits: !!snap.credits.hasCredits, unlimited: !!snap.credits.unlimited, balance: snap.credits.balance ?? null }
    : null;
  const rrc = result.rateLimitResetCredits;
  const resetCredits = rrc && typeof rrc.availableCount === 'number' ? rrc.availableCount : null;

  // Rollup — replicate main.js exactly (percentLeft fallback is 0, not 100, matching main.js lines 1549-1552).
  const lefts        = [primary, secondary].filter(Boolean).map(w => w.percent_left);
  const usedPercents = [primary, secondary].filter(Boolean).map(w => w.used_percent);
  const percentLeft  = lefts.length        ? Math.min(...lefts)        : 0;
  const usedPercent  = usedPercents.length ? Math.max(...usedPercents) : 0;

  return {
    primary,
    secondary,
    windows,
    usedPercent,
    percentLeft,
    window:   primary && secondary ? 'both' : (primary ? '5h' : 'weekly'),
    resetsAt: primary ? primary.resets_at_ms : (secondary ? secondary.resets_at_ms : null),
    used:  null,
    total: null,
    plan: planType,
    planLabel: planType ? planType.charAt(0).toUpperCase() + planType.slice(1) : null,
    credits,
    resetCredits,
  };
}

// Quanto esperar pelo account/read (id 3) depois que o rateLimits (id 2) já
// respondeu. Curto: e-mail é enfeite, o número é o que importa.
const ACCOUNT_GRACE_MS = 800;

// ---------------------------------------------------------------------------
// CodexQuotaFetcher
// ---------------------------------------------------------------------------

class CodexQuotaFetcher {
  /**
   * @param {object} opts
   * @param {function(number): object} opts.getAccountContext  – returns { num, dir, env, authMode, shell, nvmScript }
   * @param {function} opts.childSpawn   – injected child_process.spawn (for testability)
   * @param {object}   opts.https        – injected https module (for testability)
   * @param {function} [opts.logFn]      – optional log function (string) => void
   */
  constructor({ getAccountContext, childSpawn, https, logFn }) {
    this._getAccountContext = getAccountContext;
    this._childSpawn        = childSpawn;
    this._https             = https;
    this._log = logFn || (() => {});
  }

  /**
   * Fetch the codex quota for a profile.
   * @param {number} profileNum
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=20000]
   * @returns {Promise<QuotaSnapshot>}  – never rejects; returns a flagged snapshot on error.
   */
  async fetch(profileNum, { timeoutMs = 20000 } = {}) {
    const baseSnap = { source: 'app-server', cli: 'codex', provider: 'codex', updatedAt: Date.now() };

    // ── 1. Resolve account context ──────────────────────────────────────────
    let ctx;
    try {
      ctx = this._getAccountContext(profileNum, 'codex');
    } catch (err) {
      this._log(`codex-http #${profileNum} getAccountContext failed: ${err.message}`);
      return { ...baseSnap, errorKind: 'error', updatedAt: Date.now() };
    }

    // Build the shell command that sources nvm + brew then launches codex app-server.
    //
    // Quando o chamador injeta `ctx.prelude` (o main.js sempre injeta), ele
    // manda: é a MESMA fonte de PATH do spawn de PTY. O par nvm+brew abaixo é o
    // fallback histórico, mantido para os testes que montam um ctx mínimo — e
    // ele é POSIX, então nunca deve ser usado no Windows.
    const prelude = ctx.prelude != null
      ? ctx.prelude
      : [
          `[ -s "${ctx.nvmScript}" ] && . "${ctx.nvmScript}"`,
          'eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null',
        ].join('; ');
    // `exec` (substituir o shell pelo filho) não existe no PowerShell. Sem ele
    // sobra um shell pai vivo — que o `proc.kill()` derruba junto, porque o
    // node-pty mata o job inteiro.
    const exec = ctx.execPrefix != null ? ctx.execPrefix : 'exec ';
    const initCmd = [prelude, `${exec}codex app-server --listen stdio://`]
      .filter(Boolean).join('; ');

    return new Promise(resolve => {
      let buf       = '';
      let stderrBuf = '';
      let done      = false;
      let apiErrorObj = null;
      let parsedRate  = null;   // resultado do id 2, à espera do id 3
      let accountDone = false;  // id 3 respondeu (ou falhou)
      let identity    = null;   // e-mail da conta (account/read)
      let graceTimer  = null;
      let proc;

      // ── finish: called exactly once ─────────────────────────────────────
      const finish = (parsed, reason) => {
        if (done) return;
        done = true;
        clearTimeout(graceTimer);

        // Always kill the child process.
        try { proc && proc.kill(); } catch (_) {}

        if (parsed) {
          // Success path — tag with provenance.
          const snapshot = {
            ...parsed,
            identity,
            source: 'app-server',
            cli: 'codex',
            provider: 'codex',
            updatedAt: Date.now(),
          };
          const pLog = snapshot.primary   ? `5h ${snapshot.primary.percent_left}%`   : '5h —';
          const sLog = snapshot.secondary ? `7d ${snapshot.secondary.percent_left}%` : '7d —';
          this._log(`codex-http #${profileNum} parsed ${pLog} · ${sLog} via ${reason || 'unknown'}`);
          resolve(snapshot);
          return;
        }

        // ── Failure path: derive error kind then verify token ──────────────
        let kind = reason === 'timeout' ? 'timeout' : 'error';
        if (kind !== 'timeout') {
          const hay = (stderrBuf + JSON.stringify(apiErrorObj || '')).toLowerCase();
          if (/auth|token|unauthorized|401|api.?key|invalid.?key|credentials/.test(hay)) {
            kind = 'auth';
          } else if (reason === 'exit') {
            kind = 'timeout';
          }
        }

        this._log(`codex-http #${profileNum} gave up (${reason || 'unknown'}, kind=${kind}) — buf ${buf.length} stderr ${stderrBuf.length}`);

        // Verify token via HTTPS to set loggedOut / noCredit flags.
        this._verifyToken(ctx, kind)
          .then(flags => {
            resolve({
              ...baseSnap,
              errorKind: kind,
              ...flags,
              updatedAt: Date.now(),
            });
          })
          .catch(() => {
            resolve({ ...baseSnap, errorKind: kind, updatedAt: Date.now() });
          });
      };

      // ── 2. Spawn the process ────────────────────────────────────────────
      try {
        const shellArgs = ctx.shellArgs ? ctx.shellArgs(initCmd) : ['-l', '-c', initCmd];
        proc = this._childSpawn(ctx.shell, shellArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd:   ctx.dir,
          env:   ctx.env,
        });
      } catch (err) {
        this._log(`codex-http #${profileNum} spawn failed: ${err.message}`);
        resolve({ ...baseSnap, errorKind: 'error', updatedAt: Date.now() });
        return;
      }

      // Swallow stdin EPIPE: if the app-server exits/closes its stdin before we
      // write, the write emits an 'error' on the stream which — if unhandled —
      // crashes the whole app with "write EPIPE". A safe no-op handler + guarded
      // writes below prevent that.
      try { proc.stdin.on('error', () => {}); } catch {}
      const safeWrite = (s) => {
        // writable !== false: a real closed stdin reports writable=false (skip);
        // an open one (or a test stub without the prop) writes.
        try { if (proc.stdin && proc.stdin.writable !== false && !done) proc.stdin.write(s); } catch {}
      };

      // ── 3. Collect stderr ───────────────────────────────────────────────
      proc.stderr.on('data', d => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 3000) stderrBuf = stderrBuf.slice(-3000);
      });

      // ── 4. Parse stdout line-by-line as JSON-RPC ────────────────────────
      proc.stdout.on('data', data => {
        buf += data.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete last line in buffer

        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let msg;
          try { msg = JSON.parse(t); } catch { continue; }

          if (msg.id === 1 && !msg.error) {
            // initialize succeeded → rateLimits + account/read na MESMA sessão
            // (e-mail e plano sem subir outro app-server).
            safeWrite(
              JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n'
            );
            safeWrite(
              JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'account/read', params: {} }) + '\n'
            );
          } else if (msg.id === 2) {
            if (msg.error) {
              apiErrorObj = msg.error;
              finish(null, 'api-error');
            } else {
              parsedRate = parseRateLimitsResponse(msg.result);
              if (accountDone) finish(parsedRate, 'api');
              else graceTimer = setTimeout(() => finish(parsedRate, 'api'), ACCOUNT_GRACE_MS);
            }
          } else if (msg.id === 3) {
            accountDone = true;
            const acc = !msg.error && msg.result && msg.result.account;
            if (acc && acc.email) identity = String(acc.email);
            if (parsedRate) finish(parsedRate, 'api');
          }
        }
      });

      // ── 5. Process lifecycle ────────────────────────────────────────────
      proc.on('exit', () => { if (!done) finish(parsedRate, parsedRate ? 'api' : 'exit'); });
      proc.on('error', err => {
        this._log(`codex-http #${profileNum} proc error: ${err.message}`);
        if (!done) finish(null, 'error');
      });

      // ── 6. Send initialize after 500 ms ────────────────────────────────
      setTimeout(() => {
        if (!done) {
          safeWrite(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: { clientInfo: { name: 'codex-panel', version: '1.0' } },
            }) + '\n'
          );
          this._log(`codex-http #${profileNum} initialize sent`);
        }
      }, 500);

      // ── 7. Hard timeout ─────────────────────────────────────────────────
      setTimeout(() => {
        if (!done) finish(parsedRate, parsedRate ? 'api' : 'timeout');
      }, timeoutMs);
    });
  }

  // ---------------------------------------------------------------------------
  // _verifyToken — mirrors main.js verifyTokenAndMark logic exactly.
  // Reads ${ctx.dir}/.codex/auth.json, makes an HTTPS GET to the models endpoint,
  // and returns { loggedOut, noCredit } flags (or empty object if inconclusive).
  // ---------------------------------------------------------------------------
  async _verifyToken(ctx, kind) {
    const fs = require('fs');

    // If the error was already classified as auth, skip the HTTP check — we know.
    if (kind === 'auth') {
      return { loggedOut: true };
    }

    // Try to read the token from auth.json.
    let token;
    try {
      const authPath = require('path').join(ctx.dir, '.codex', 'auth.json');
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      token = auth && auth.tokens && auth.tokens.access_token;
    } catch (_) {
      // auth.json missing or unreadable → treat as logged out.
      return { loggedOut: true };
    }

    if (!token) {
      return { loggedOut: true };
    }

    // Make the HTTPS GET request.
    const code = await new Promise(res => {
      try {
        const u = new URL('https://chatgpt.com/backend-api/codex/models?client_version=0.133.0');
        const req = this._https.request(
          {
            hostname: u.hostname,
            path:     u.pathname + u.search,
            method:   'GET',
            headers:  { Authorization: 'Bearer ' + token },
            timeout:  4000,
          },
          r => {
            res(r.statusCode || 0);
            r.resume(); // drain to free the socket
          }
        );
        req.on('error',   ()  => res(0));
        req.on('timeout', ()  => { try { req.destroy(); } catch (_) {} res(0); });
        req.end();
      } catch (_) {
        res(0);
      }
    });

    const tag = code === 401 ? ' (logged out)' : code === 402 ? ' (no credit)' : '';
    this._log(`codex-http #${ctx.num} token verify → HTTP ${code}${tag}`);

    if (code === 401) return { loggedOut: true };
    if (code === 402) return { noCredit:  true };
    return {};
  }
}

module.exports = CodexQuotaFetcher;
