'use strict';

/**
 * Module 2: ClaudeStatusFetcher
 *
 * Spawns a hidden interactive `claude` PTY, sends `/status`, captures output,
 * parses it via the injected parser, kills the PTY, and returns a QuotaSnapshot.
 *
 * Contract: app/quota/CONTRACT.md §Module 2
 *
 * Constructor injections:
 *   getAccountContext(profileNum) → { num, dir, env, authMode, shell, nvmScript }
 *   pty              — node-pty compatible module (must have .spawn())
 *   parser           — pty-parser module (must have .parseClaudeStatus())
 *   shellPrelude     — optional () => string with the CANONICAL PATH prelude
 *                      (main.js agentShellPrelude). Without it the probe only
 *                      sourced nvm+brew — but `claude` lives in ~/.local/bin,
 *                      so the hidden PTY died with exit 127 whenever the app
 *                      was opened from the Finder (minimal launchd PATH).
 *   logFn            — optional logging function, defaults to () => {}
 */

class ClaudeStatusFetcher {
  /**
   * @param {object} opts
   * @param {function} opts.getAccountContext
   * @param {object}   opts.pty        - node-pty (injected, not required directly)
   * @param {object}   opts.parser     - pty-parser module (parseClaudeStatus)
   * @param {function} [opts.shellPrelude] - () => string PATH prelude (see above)
   * @param {function} [opts.logFn]    - optional logger
   */
  constructor({ getAccountContext, pty, parser, shellPrelude, logFn }) {
    if (!getAccountContext) throw new Error('ClaudeStatusFetcher: getAccountContext is required');
    if (!pty) throw new Error('ClaudeStatusFetcher: pty is required');
    if (!parser) throw new Error('ClaudeStatusFetcher: parser is required');

    this._getAccountContext = getAccountContext;
    this._pty = pty;
    this._parser = parser;
    this._shellPrelude = typeof shellPrelude === 'function' ? shellPrelude : null;
    this._log = typeof logFn === 'function' ? logFn : () => {};
  }

  /**
   * Spawn an interactive `claude` PTY for the given profile, send `/status`,
   * capture output until it "settles", parse, kill, return a QuotaSnapshot.
   *
   * "Settled" means: we have seen at least one status-like keyword
   * ('%' | 'limit' | 'reset' | 'subscription' | 'plan', case-insensitive)
   * AND 1.2 s have passed with no new data arriving.
   *
   * @param {number} profileNum
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=15000]
   * @returns {Promise<QuotaSnapshot>}
   */
  async fetch(profileNum, { timeoutMs = 15000 } = {}) {
    const ctx = this._getAccountContext(profileNum);

    // Build initCmd: canonical PATH prelude (same one the main spawn uses) +
    // launch claude interactively (no -p flag). Fallback to the old nvm+brew
    // pair only when no prelude was injected (tests).
    const prelude = this._shellPrelude
      ? this._shellPrelude()
      : [
          `[ -s "${ctx.nvmScript}" ] && . "${ctx.nvmScript}"`,
          `eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null`,
        ].join('; ');
    // `${prelude}; claude` produziria `; claude` quando não há prelúdio (é o
    // caso do Windows, onde o PATH vem pelo env). Ponto-e-vírgula solto é erro
    // de sintaxe no PowerShell e a sonda morria antes de subir a CLI.
    const initCmd = [prelude, 'claude'].filter(Boolean).join('; ');

    this._log(`[claude-status] profile=${profileNum} spawning claude PTY`);

    // O argv do shell vem do contexto (platform.shellArgs). O default POSIX
    // fica aqui para os testes que montam um ctx mínimo.
    const shellArgs = ctx.shellArgs ? ctx.shellArgs(initCmd) : ['-l', '-c', initCmd];
    const proc = this._pty.spawn(ctx.shell, shellArgs, {
      cwd: ctx.dir,
      env: ctx.env,
      cols: 120,
      rows: 40,
      name: 'xterm-256color',
    });

    return new Promise((resolve) => {
      let buf = '';
      let done = false;
      let settleTimer = null;    // fires 1.2 s after first status-like content
      let hardTimer = null;      // fires at timeoutMs

      // ------------------------------------------------------------------ helpers

      /**
       * Strip ANSI escape codes (colour + CSI sequences) for keyword matching.
       * We keep the raw buf for the parser (it strips internally too).
       */
      function stripAnsi(s) {
        // eslint-disable-next-line no-control-regex
        return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b[^[]/g, '');
      }

      /**
       * Resolve once, killing the PTY and clearing timers.
       */
      const finish = (snapshot) => {
        if (done) return;
        done = true;

        clearTimeout(settleTimer);
        clearTimeout(hardTimer);

        try { proc.kill(); } catch (_) { /* ignore – PTY may already be dead */ }

        this._log(`[claude-status] profile=${profileNum} done — source=${snapshot.source || '?'} errorKind=${snapshot.errorKind || 'none'}`);
        resolve(snapshot);
      };

      // ------------------------------------------------------------------ hard timeout

      // Try to parse the buffer; finish with the snapshot if it has real
      // window data. Returns true if it finished. Used both eagerly (as soon as
      // the numbers appear) and as a last resort on hard timeout — claude's TUI
      // redraws continuously (spinners), so waiting for "quiet" often never
      // settles before the timeout.
      const tryParseAndFinish = () => {
        if (done) return false;
        const snap = this._parser.parseClaudeStatus(buf);
        if (snap && (snap.primary || snap.secondary)) {
          finish({ ...snap, source: 'claude-status', cli: 'claude', updatedAt: Date.now() });
          return true;
        }
        return false;
      };

      hardTimer = setTimeout(() => {
        // Last-resort parse of whatever we captured before giving up.
        if (tryParseAndFinish()) {
          this._log(`[claude-status] profile=${profileNum} parsed at timeout`);
          return;
        }
        this._log(`[claude-status] profile=${profileNum} TIMEOUT after ${timeoutMs}ms`);
        finish({
          errorKind: 'timeout',
          source: 'claude-status',
          cli: 'claude',
          updatedAt: Date.now(),
        });
      }, timeoutMs);

      // ------------------------------------------------------------------ data accumulation

      /**
       * Status-like content detector.
       * Matches: '%', 'limit', 'reset', 'subscription', 'plan' (case-insensitive).
       */
      const STATUS_KEYWORDS = /(%|limit|reset|subscription|plan)/i;

      /**
       * Logged-out signal patterns.
       * Matches: "not logged in" / "/login" / "please log in" / "log in to".
       */
      const LOGGED_OUT_PATTERNS = /not logged in|\/login|please log in|log in to/i;

      proc.onData((chunk) => {
        if (done) return;
        buf += chunk;

        const plain = stripAnsi(buf);

        // ---- logged-out detection (highest priority) ----
        if (LOGGED_OUT_PATTERNS.test(plain)) {
          this._log(`[claude-status] profile=${profileNum} detected logged-out`);
          finish({
            loggedOut: true,
            errorKind: 'auth',
            source: 'claude-status',
            cli: 'claude',
            updatedAt: Date.now(),
          });
          return;
        }

        // ---- Eager parse: as soon as the usage numbers are present, finish.
        // Claude's /usage panel streams in "NN% used" lines; once we can parse a
        // window we don't need to wait for the (never-quiet) TUI to settle.
        if (/\d{1,3}\s*%\s*used/i.test(plain)) {
          if (tryParseAndFinish()) {
            this._log(`[claude-status] profile=${profileNum} parsed eagerly`);
            return;
          }
        }

        // ---- Fallback settle timer: if we saw status-y content but couldn't
        // parse a window yet, parse after a short quiet window as a backstop.
        if (STATUS_KEYWORDS.test(plain)) {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            if (done) return;
            if (tryParseAndFinish()) {
              this._log(`[claude-status] profile=${profileNum} parsed after settle`);
              return;
            }
            // Saw status-like content but couldn't extract a usage window even
            // after the output went quiet → give up early (don't hold the PTY
            // for the full hard timeout).
            this._log(`[claude-status] profile=${profileNum} unparseable after settle`);
            finish({ errorKind: 'error', source: 'claude-status', cli: 'claude', updatedAt: Date.now() });
          }, 1500 /* settle window ms */);
        }
      });

      // ------------------------------------------------------------------ PTY exit
      // If the process exits unexpectedly before we got a result, treat as error.
      if (typeof proc.onExit === 'function') {
        proc.onExit(({ exitCode }) => {
          if (done) return;
          this._log(`[claude-status] profile=${profileNum} PTY exited early code=${exitCode}`);
          // Give the settle timer a last chance if we already have status content.
          // If settle timer is not armed this was a premature exit with no useful data.
          if (!settleTimer) {
            finish({
              errorKind: 'error',
              source: 'claude-status',
              cli: 'claude',
              updatedAt: Date.now(),
            });
          }
          // else: settle timer will fire after 1.2 s and call finish().
        });
      }

      // ------------------------------------------------------------------ boot delay
      // Wait ~2.5 s for the claude TUI to fully boot before sending /status.
      setTimeout(() => {
        if (done) return;
        this._log(`[claude-status] profile=${profileNum} sending /usage`);
        // `/usage` opens the panel with the real quota numbers (Current session
        // / Current week % used + reset). `/status` only shows session/model.
        proc.write('/usage\r');
      }, 2500);
    });
  }
}

module.exports = ClaudeStatusFetcher;
