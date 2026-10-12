'use strict';

/**
 * auth-flow-router.js
 *
 * Routes OAuth/auth URLs from CLI tools to the Norya browser, per profile.
 *
 * Usage:
 *   const AuthFlowRouter = require('./auth-flow-router');
 *   const router = new AuthFlowRouter({ browserManager });
 *
 *   const { socketPath, env } = await router.start(profileId);
 *   // Pass env to the PTY/child process so it uses norya-auth-open as BROWSER.
 *
 * Events emitted:
 *   'auth-url'       { profileId, url, ts }     – first auth URL captured
 *   'auth-complete'  { profileId }               – markComplete() called
 *   'auth-cancelled' { profileId }               – reserved for future use
 *   'auth-timeout'   { profileId }               – 5-minute TTL exceeded
 */

const EventEmitter = require('events');
const net = require('net');
const fs = require('fs');
const path = require('path');
const platform = require('../platform');

// 5 minutes in milliseconds
/**
 * Caminho do socket de auth deste perfil. Exportado porque o main.js precisa
 * injetar exatamente o MESMO caminho no env do PTY — duas pontas calculando o
 * caminho por conta própria foi o bug que deixou o fluxo de auth quebrado.
 */
function socketPathFor(profileId) {
  return platform.ipcEndpoint(`auth-${profileId}`);
}

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

// Regex to scrape auth-related URLs from PTY output (incl. device-auth + the
// OpenAI/ChatGPT/Google auth hosts). Captures up to whitespace or ANSI escape.
const AUTH_URL_RE = new RegExp(
  '(https?:\\/\\/[^\\s\\x1b]*?(?:' +
    'auth|login|oauth|sign[_-]?in|authorize|callback|device|verify|activate' +   // path keywords
    '|auth\\.openai\\.com|chatgpt\\.com|platform\\.openai\\.com|accounts\\.google\\.com' + // known hosts
  ')[^\\s\\x1b]*)', 'i');

// Hosts de login dos providers. A URL raspada da SAÍDA do terminal só abre na
// aba de login se o host (parseado, não por regex no texto) for um destes: sem
// isso, qualquer `https://x/login` impresso durante o login — um README, um log
// de dependência — abriria na aba que o usuário trata como a do provider.
const AUTH_HOSTS = [
  'openai.com', 'chatgpt.com', 'anthropic.com', 'claude.ai', 'claude.com',
  'x.ai', 'grok.com', 'google.com', 'openrouter.ai', 'opencode.ai', 'github.com',
];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** URL http(s) válida? (`fromPty`: também exige host de provider ou loopback.) */
function isAcceptableAuthUrl(raw, { fromPty = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!fromPty) return true;
  const h = u.hostname.toLowerCase();
  if (LOOPBACK.has(h)) return true;
  if (u.protocol !== 'https:') return false;
  return AUTH_HOSTS.some(d => h === d || h.endsWith('.' + d));
}

class AuthFlowRouter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.browserManager  Reference to BrowserManager (not used internally yet,
   *                                      but kept for forward-compatibility / injection).
   */
  constructor({ browserManager } = {}) {
    super();
    this._browserManager = browserManager;
    // Map<profileId, { server, socketPath, timeoutHandle, urlEmitted, startedAt }>
    this._sessions = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start an auth-flow session for the given profile.
   *
   * @param {number|string} profileId
   * @returns {Promise<{ socketPath: string, env: { BROWSER: string, NORYA_AUTH_SOCKET: string } }>}
   */
  async start(profileId) {
    // If a session is already active, stop it first to get a clean slate.
    if (this._sessions.has(profileId)) {
      await this.stop(profileId);
    }

    const socketPath = socketPathFor(profileId);

    // Remove stale socket file if present. (Named pipe não deixa resto.)
    if (!platform.isWin) {
      try {
        await fs.promises.unlink(socketPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }

    // Resolve helper binary path. No Windows o alvo do $BROWSER é um .cmd — o
    // bit de execução não existe lá, então checamos só a leitura.
    const helperPath = path.join(__dirname, '..', 'bin', platform.authOpenBinName());
    try {
      await fs.promises.access(helperPath, platform.isWin ? fs.constants.R_OK : fs.constants.X_OK);
    } catch {
      throw new Error(
        `AuthFlowRouter: helper not found or not executable at ${helperPath}. ` +
        (platform.isWin ? 'Reinstale o Norya.' : `Run: chmod +x ${helperPath}`)
      );
    }

    // Create Unix socket server.
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => { buf += d; });
      conn.on('end', () => {
        try {
          const { url, ts } = JSON.parse(buf);
          this._handleUrl(profileId, url, ts);
        } catch (e) {
          // Malformed payload — ignore silently.
        }
      });
    });

    // Tighten umask BEFORE listen() so the socket inode is created with the
    // restrictive mode — eliminates the TOCTOU window between bind and chmod.
    // Fail-closed on chmod error.
    // No Windows não há umask nem modo: a ACL default do named pipe já limita
    // ao usuário da sessão (mesma decisão do MCPServer).
    const prevUmask = platform.isWin ? null : process.umask(0o077);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      if (!platform.isWin) {
        try {
          await fs.promises.chmod(socketPath, 0o600);
        } catch (e) {
          try { server.close(); } catch {}
          throw new Error('AuthFlowRouter: failed to chmod socket to 0o600: ' + e.message);
        }
      }
    } finally {
      if (prevUmask !== null) process.umask(prevUmask);
    }

    // 5-minute timeout.
    const timeoutHandle = setTimeout(() => {
      this._timeout(profileId);
    }, AUTH_TIMEOUT_MS);

    // Allow the Node process to exit even if the timeout is still pending.
    if (timeoutHandle.unref) timeoutHandle.unref();

    this._sessions.set(profileId, {
      server,
      socketPath,
      timeoutHandle,
      urlEmitted: false,
      startedAt: Date.now(),
    });

    return {
      socketPath,
      env: {
        BROWSER: helperPath,
        NORYA_AUTH_SOCKET: socketPath,
      },
    };
  }

  /**
   * Stop and clean up the auth-flow session for the given profile.
   *
   * @param {number|string} profileId
   */
  async stop(profileId) {
    const state = this._sessions.get(profileId);
    if (!state) return;

    this._sessions.delete(profileId);

    // Clear timeout.
    clearTimeout(state.timeoutHandle);

    // Close the server.
    await new Promise((resolve) => {
      state.server.close(resolve);
    });

    // Remove socket file.
    try {
      if (!platform.isWin) await fs.promises.unlink(state.socketPath);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Non-fatal: log but don't throw.
        // (The session is already removed from the map.)
      }
    }
  }

  /**
   * Feed a chunk of PTY stdout to the router.
   * If a relevant auth URL is found (and none has been emitted yet), emit 'auth-url'.
   *
   * @param {number|string} profileId
   * @param {string|Buffer} chunk
   */
  feedPtyChunk(profileId, chunk) {
    const state = this._sessions.get(profileId);
    if (!state) return;        // profile not active
    if (state.urlEmitted) return; // already have a URL — no need to scrape

    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    // `codex login` is a full TUI: the auth URL can be split across PTY chunks
    // and interleaved with ANSI cursor/box-drawing sequences. Accumulate a
    // rolling buffer and strip control sequences before matching so the URL
    // rejoins into a clean token.
    state.buf = ((state.buf || '') + text).slice(-16384);
    const clean = state.buf
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')          // CSI (colors, cursor moves)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC (e.g. window title)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');      // other control chars
    // Only accept a URL token that is FOLLOWED by whitespace — i.e. it finished
    // streaming. Matching a bare prefix would emit a TRUNCATED URL while the TUI
    // is still printing it. The rolling buffer + next chunk completes it.
    const tokens = clean.match(/https?:\/\/[^\s]+(?=\s)/g) || [];
    const full = tokens.find((u) => AUTH_URL_RE.test(u) && isAcceptableAuthUrl(u, { fromPty: true }));
    if (full) {
      this._handleUrl(profileId, full, Date.now());
    }
  }

  /**
   * Call when the codex login PTY exits successfully.
   * Emits 'auth-complete' and stops the session.
   *
   * @param {number|string} profileId
   */
  markComplete(profileId) {
    this.emit('auth-complete', { profileId });
    this.stop(profileId);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Handle a captured auth URL (from socket or PTY scraping).
   * Deduplicates: only the first URL per session is emitted.
   *
   * @param {number|string} profileId
   * @param {string} url
   * @param {number} ts
   */
  _handleUrl(profileId, url, ts) {
    const state = this._sessions.get(profileId);
    if (!state) return;
    if (state.urlEmitted) return; // dedupe
    // Pelo socket chega o que a própria CLI passou ao $BROWSER: aceita qualquer
    // host, mas só http(s) — nunca file:, javascript: ou esquema de app.
    if (!isAcceptableAuthUrl(url)) return;

    state.urlEmitted = true;
    this.emit('auth-url', { profileId, url, ts });
  }

  /**
   * Called when the per-profile timeout fires.
   *
   * @param {number|string} profileId
   */
  _timeout(profileId) {
    if (!this._sessions.has(profileId)) return; // already stopped
    this.emit('auth-timeout', { profileId });
    this.stop(profileId);
  }
}

module.exports = AuthFlowRouter;
module.exports.socketPathFor = socketPathFor;
module.exports.isAcceptableAuthUrl = isAcceptableAuthUrl;
