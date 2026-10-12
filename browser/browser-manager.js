'use strict';

/**
 * browser-manager.js
 * Core orchestrator for the per-profile anonymous browser feature in Norya.
 *
 * Ciclo de vida da SESSÃO de navegação, um por perfil. Não renderiza nada:
 * as abas são <webview> no DOM, criadas por renderer/browser.js.
 *
 * Até 2026-07-10 existiam DUAS engines aqui: esta classe mantinha abas em
 * `WebContentsView` (openTab/navigateTab/screenshot/bounds) e o renderer mantinha
 * as suas em `<webview>`. A UI usava as do renderer; a automação por MCP também
 * (main.js encaminha para o renderer via `_agentExec`). O caminho WebContentsView
 * era inalcançável — 600 linhas de código morto que pareciam vivas.
 *
 * Sem Tor, sem proxy, sem spoofing (removidos em 2026-07-09). O isolamento entre
 * perfis vem da `partition`; o bloqueio de trackers, de ./blocker.
 *
 * Public interface:
 *   class BrowserManager extends EventEmitter
 *     constructor({ mainWindow })
 *     async openPanel(profileId, { width })
 *     async closePanel(profileId)          — só estado/evento; storage persiste
 *     async prepareSession(profileId, { width })   → { profileId, partition }
 *     async teardownSession(profileId)
 *     async clearData(profileId)           — wipe explícito de cookies/storage
 *     isPanelOpen(profileId)
 *
 * Events: 'panel-open' e 'panel-close', ambos { profileId }.
 */

const { EventEmitter } = require('events');
const { session } = require('electron');
const { applyBlocker } = require('./blocker');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Default panel width when openPanel is called without an explicit width.
const DEFAULT_PANEL_WIDTH = 720;

// ---------------------------------------------------------------------------
// Internal state shapes (documented here for clarity)
// ---------------------------------------------------------------------------
//
// ProfileBrowserState:
//   { panelOpen: boolean, panelWidth: number, sessionStartTs: number }
//
// As abas vivem no renderer (renderer/browser.js), não aqui.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp `value` to [min, max].
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// BrowserManager
// ---------------------------------------------------------------------------

class BrowserManager extends EventEmitter {
  /**
   * @param {{ mainWindow: Electron.BrowserWindow }} opts
   */
  constructor({ mainWindow }) {
    super();

    if (!mainWindow) throw new Error('BrowserManager: mainWindow is required');

    /** @type {Electron.BrowserWindow} */
    this._mainWindow = mainWindow;

    /**
     * Master state map.
     * @type {Map<string, ProfileBrowserState>}
     */
    this._profiles = new Map();
  }

  // -------------------------------------------------------------------------
  // Panel lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open the browser panel for `profileId`.  Idempotent: if already open,
   * resolves immediately.
   *
   * @param {string} profileId
   * @param {{ width?: number }} [opts]
   */
  async openPanel(profileId, { width = DEFAULT_PANEL_WIDTH } = {}) {
    if (this.isPanelOpen(profileId)) return;

    /** @type {ProfileBrowserState} */
    const state = {
      panelOpen: true,
      panelWidth: clamp(width, 100, 4000),
      sessionStartTs: Date.now(),
    };

    this._profiles.set(profileId, state);
    this.emit('panel-open', { profileId });
  }

  /**
   * Fecha o painel do perfil (estado + evento). NÃO toca no storage: desde
   * 2026-07-14 cookies/logins persistem sempre — limpar é ação explícita do
   * usuário via clearData(). Antes, fechar o painel apagava tudo (e o
   * before-quit também): qualquer login do browser morria junto com a sessão.
   *
   * @param {string} profileId
   */
  async closePanel(profileId) {
    const state = this._profiles.get(profileId);
    if (!state) return;
    this._profiles.delete(profileId);
    this.emit('panel-close', { profileId });
  }

  /**
   * Prepara a sessão Electron para um painel renderizado com <webview>.
   * Aplica o bloqueador de trackers à partition persistente do perfil e devolve
   * o que o renderer precisa para montar a <webview>.
   *
   * A renderização vive no renderer (DOM <webview>); aqui só o ciclo de sessão.
   *
   * @param {string} profileId
   * @returns {Promise<{partition, profileId}>}
   */
  async prepareSession(profileId, { width = DEFAULT_PANEL_WIDTH } = {}) {
    if (!this.isPanelOpen(profileId)) {
      await this.openPanel(profileId, { width });
    }
    const partition = `persist:browser-profile-${profileId}`;

    // Bloqueia trackers no nível da sessão. A <webview> herda via partition=.
    //
    // Esta é a ÚNICA camada de privacidade que resta, junto com o isolamento
    // por partition. Removidos em 2026-07-09: Tor por perfil, proxy SOCKS,
    // reescrita de headers e spoofing de fingerprint — quebravam login e
    // Cloudflare sem entregar anonimato real, e custavam um processo por perfil.
    try {
      applyBlocker(session.fromPartition(partition), { enabled: true });
    } catch (err) {
      console.warn(`[BrowserManager] applyBlocker failed for ${profileId}:`, err.message);
    }

    return { profileId, partition };
  }

  /**
   * Tear down a webview-rendered panel (estado apenas; storage persiste).
   * @param {string} profileId
   */
  async teardownSession(profileId) {
    return this.closePanel(profileId);
  }

  /**
   * Apaga cookies/storage da partition persistente do perfil. Único caminho
   * de wipe desde 2026-07-14 (botão "Limpar dados" nas settings do browser e
   * deleção de perfil). Funciona com painel aberto ou fechado.
   *
   * @param {string} profileId
   * @returns {Promise<{ok: true, partition: string}>}
   */
  async clearData(profileId) {
    const partition = `persist:browser-profile-${profileId}`;
    await session.fromPartition(partition).clearStorageData({
      storages: [
        'cookies',
        'localstorage',
        'cachestorage',
        'indexdb',
        'shadercache',
        'websql',
        'serviceworkers',
      ],
    });
    return { ok: true, partition };
  }

  /**
   * @param {string} profileId
   * @returns {boolean}
   */
  isPanelOpen(profileId) {
    return this._profiles.has(profileId) && this._profiles.get(profileId).panelOpen === true;
  }

  // -------------------------------------------------------------------------
  // Tab lifecycle
  // -------------------------------------------------------------------------




  // -------------------------------------------------------------------------
  // Tab management
  // -------------------------------------------------------------------------




  // -------------------------------------------------------------------------
  // Navigation / action dispatcher
  // -------------------------------------------------------------------------


  // -------------------------------------------------------------------------
  // Private action helpers
  // -------------------------------------------------------------------------



  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------


}

module.exports = BrowserManager;
