'use strict';

/**
 * mcp-server.js
 *
 * In-process MCP server used by BrowserManager.
 * Listens on a Unix socket per profile, speaks newline-delimited JSON-RPC 2.0,
 * and dispatches tool calls to the injected BrowserManager instance.
 *
 * Usage:
 *   const MCPServer = require('./mcp-server');
 *   const server = new MCPServer({ browserManager });
 *   const { socketPath, env } = await server.start(profileId);
 *   // later...
 *   await server.stop(profileId);
 */

const net = require('net');
const platform = require('../platform');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Caminho do socket do MCP deste perfil.
 *
 * Fica na pasta privada de sockets do platform (<tmp>/norya-<uid>, 0700). Até 2026-07-10 o main.js injetava `/tmp/norya-browser-N.sock` no ambiente
 * do PTY enquanto o servidor escutava aqui — as duas pontas nunca se encontraram,
 * e a automação do navegador por agente nunca funcionou. Exportado para que exista
 * UMA fonte da verdade.
 */
function socketPathFor(profileId) {
  // Windows: `\\.\pipe\norya-browser-N`. O `net` do Node fala named pipe com o
  // MESMO listen()/connect() do socket Unix — só o caminho muda.
  return platform.ipcEndpoint(`browser-${profileId}`);
}

function unlinkIfExists(sockPath) {
  // Named pipe morre com o processo dono; não há inode para remover.
  platform.unlinkEndpoint(sockPath, fs);
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n';
}

function jsonRpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

// ---------------------------------------------------------------------------
// MCPServer
// ---------------------------------------------------------------------------

class MCPServer {
  /**
   * @param {{ browserManager: object }} opts
   */
  constructor({ browserManager }) {
    if (!browserManager) throw new Error('MCPServer requires a browserManager instance');
    this._bm = browserManager;
    /** @type {Map<string, net.Server>} profileId → net.Server */
    this._servers = new Map();
  }

  /**
   * Start listening for the given profile.
   * @param {string|number} profileId
   * @returns {Promise<{ socketPath: string, env: { NORYA_BROWSER_MCP_SOCKET: string, NORYA_PROFILE_ID: string } }>}
   */
  async start(profileId) {
    const pid = String(profileId);
    if (this._servers.has(pid)) {
      throw new Error(`MCPServer already started for profile ${pid}`);
    }

    const sockPath = socketPathFor(pid);
    unlinkIfExists(sockPath);

    // allowHalfOpen: o CLI escreve o pedido e faz half-close (`client.end()`).
    // Com o padrão (false), o Node encerra o lado GRAVÁVEL do servidor assim que
    // recebe o FIN — e como `_handleMessage` é async (espera o renderer), a
    // resposta era escrita num socket já fechado. O EPIPE morria no
    // `socket.on('error')` e o cliente recebia zero bytes.
    //
    // Sintoma até 2026-07-10: a aba ABRIA, e o `norya-browser` respondia
    // "parse error: undefined is not valid JSON". Efeito colateral sem
    // confirmação — o agente não sabia se tinha funcionado.
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      this._handleConnection(socket, pid);
    });

    // Eliminate TOCTOU between listen() and chmod by tightening umask FIRST,
    // so the socket inode is created already with the restrictive mode.
    // Also: fail-closed on chmod error (don't silently expose a 0o666 socket).
    //
    // Nada disso existe no Windows: umask e modo de arquivo não se aplicam a um
    // named pipe. A proteção equivalente é a ACL default do pipe, que já limita
    // ao usuário que o criou. Fingir um chmod aqui só criaria um erro fixo.
    const prevUmask = platform.isWin ? null : process.umask(0o077);
    try {
      await new Promise((resolve, reject) => {
        server.listen(sockPath, () => {
          if (platform.isWin) return resolve();
          try {
            fs.chmodSync(sockPath, 0o600);
            resolve();
          } catch (e) {
            try { server.close(); } catch {}
            reject(new Error('MCPServer: failed to chmod socket to 0o600: ' + e.message));
          }
        });
        server.once('error', reject);
      });
    } finally {
      if (prevUmask !== null) process.umask(prevUmask);
    }

    this._servers.set(pid, server);

    return {
      socketPath: sockPath,
      env: {
        NORYA_BROWSER_MCP_SOCKET: sockPath,
        NORYA_PROFILE_ID: pid,
      },
    };
  }

  /**
   * Stop listening for the given profile and clean up the socket file.
   * @param {string|number} profileId
   */
  async stop(profileId) {
    const pid = String(profileId);
    const server = this._servers.get(pid);
    if (!server) return;

    await new Promise((resolve) => server.close(resolve));
    this._servers.delete(pid);
    unlinkIfExists(socketPathFor(pid));
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  _handleConnection(socket, profileId) {
    let buf = '';

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      // Process every complete line (newline-delimited JSON-RPC)
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this._handleMessage(socket, profileId, line);
      }
    });

    socket.on('error', () => { /* swallow per-connection errors */ });
  }

  async _handleMessage(socket, profileId, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      socket.write(jsonRpcError(null, -32700, 'Parse error'));
      return;
    }

    const { id, method, params = {} } = msg;

    try {
      const result = await this._dispatch(profileId, method, params);
      socket.write(jsonRpcResult(id, result));
    } catch (e) {
      socket.write(jsonRpcError(id, -32000, e.message));
    }
    // Single request-per-connection model: close after responding.
    socket.end();
  }

  // ---------------------------------------------------------------------------
  // Tab resolution helper
  // ---------------------------------------------------------------------------

  /**
   * Resolve a tab ID.  If tabIdParam is given and valid, use it.
   * Otherwise fall back to the profile's active tab.  Throws if no tabs open.
   * @param {string} profileId
   * @param {string|undefined} tabIdParam
   */
  async _resolveTab(profileId, tabIdParam) {
    if (tabIdParam != null) {
      // Let BrowserManager validate; if it explodes we propagate.
      return tabIdParam;
    }
    const state = await this._bm.listTabs(profileId);
    const tabs = Array.isArray(state) ? state : (state && state.tabs ? state.tabs : []);
    if (!tabs.length) throw new Error('No open tabs in profile ' + profileId);
    // Prefer activeTabId if exposed, else first tab
    const activeTabId = (state && state.activeTabId) || tabs[0].tabId || tabs[0].id;
    return activeTabId;
  }

  // ---------------------------------------------------------------------------
  // Method dispatcher
  // ---------------------------------------------------------------------------

  async _dispatch(profileId, method, params) {
    const bm = this._bm;

    switch (method) {
      // ---- browser_open -------------------------------------------------- //
      case 'browser_open': {
        const { url, new_tab, tor } = params;
        if (!url) throw new Error('url is required');

        // If caller explicitly wants to reuse existing active tab
        if (new_tab === false) {
          let activeTabId;
          try {
            activeTabId = await this._resolveTab(profileId, undefined);
          } catch (_) {
            activeTabId = null;
          }
          if (activeTabId != null) {
            const result = await bm.navigateTab(profileId, activeTabId, 'open', { url });
            return result;
          }
        }

        const torOpt = tor == null ? 'auto' : tor;
        const result = await bm.openTab(profileId, url, {
          mode: 'normal',
          tor: torOpt,
          agentControlled: true,
        });
        return result; // expected: { tabId }
      }

      // ---- browser_list_tabs --------------------------------------------- //
      case 'browser_list_tabs': {
        return bm.listTabs(profileId);
      }

      // ---- browser_close_tab --------------------------------------------- //
      case 'browser_close_tab': {
        const { tab_id } = params;
        if (!tab_id) throw new Error('tab_id is required');
        return bm.closeTab(profileId, tab_id);
      }

      // ---- browser_finish ------------------------------------------------ //
      // Fim de uso: fecha as abas que ESTE agente abriu. As do usuário ficam.
      // Cada aba é um processo de renderer; deixar acumular é CPU/RAM parados.
      case 'browser_finish': {
        return bm.finishAgent(profileId);
      }

      // ---- browser_screenshot -------------------------------------------- //
      case 'browser_screenshot': {
        const { tab_id, full_page, format } = params;
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'screenshot', { full_page, format });
      }

      // ---- browser_get_dom ----------------------------------------------- //
      case 'browser_get_dom': {
        const { tab_id, selector } = params;
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'get_dom', { selector });
      }

      // ---- browser_get_text ---------------------------------------------- //
      case 'browser_get_text': {
        const { tab_id, selector } = params;
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'get_text', { selector });
      }

      // ---- browser_click ------------------------------------------------- //
      case 'browser_click': {
        const { tab_id, selector } = params;
        if (!selector) throw new Error('selector is required');
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'click', { selector });
      }

      // ---- browser_type -------------------------------------------------- //
      case 'browser_type': {
        const { tab_id, selector, text, submit } = params;
        if (!selector) throw new Error('selector is required');
        if (text == null) throw new Error('text is required');
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'type', { selector, text, submit });
      }

      // ---- browser_evaluate ---------------------------------------------- //
      case 'browser_evaluate': {
        const { tab_id, js } = params;
        if (!js) throw new Error('js is required');
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'evaluate', { js });
      }

      // ---- browser_wait_for ---------------------------------------------- //
      case 'browser_wait_for': {
        const { tab_id, selector, timeout_ms } = params;
        if (!selector) throw new Error('selector is required');
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'wait_for', { selector, timeout_ms });
      }

      // ---- browser_console_logs ------------------------------------------ //
      case 'browser_console_logs': {
        const { tab_id, since_ts } = params;
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'console_logs', { since_ts });
      }

      // ---- browser_network_log ------------------------------------------- //
      case 'browser_network_log': {
        const { tab_id, since_ts } = params;
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'network_log', { since_ts });
      }

      // ---- browser_navigate ---------------------------------------------- //
      case 'browser_navigate': {
        const { tab_id, action } = params;
        const VALID = new Set(['back', 'forward', 'reload']);
        if (!action || !VALID.has(action)) throw new Error('action must be one of: back, forward, reload');
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, action, {});
      }

      // ---- browser_set_viewport ------------------------------------------ //
      case 'browser_set_viewport': {
        const { tab_id, w, h, dpr, mobile } = params;
        if (w == null || h == null) throw new Error('w and h are required');
        const tabId = await this._resolveTab(profileId, tab_id);
        return bm.navigateTab(profileId, tabId, 'set_viewport', { w, h, dpr, mobile });
      }

      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }
}

module.exports = MCPServer;
module.exports.socketPathFor = socketPathFor;
