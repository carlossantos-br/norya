'use strict';

/**
 * quota-store.js — Module 4 of the Norya quota subsystem.
 *
 * Single source of truth for current QuotaSnapshot per profile.
 * Holds an in-memory Map, persists to a JSON cache file (injected fs),
 * merges signals from multiple sources, and emits 'change' events.
 *
 * Merge rules (see CONTRACT.md §Module 4):
 *  - Authoritative sources: 'app-server' | 'http' | 'claude-status'
 *  - Supplemental source:   'pty'
 *  - If existing entry has an authoritative source updated < 30 s ago and
 *    incoming.source === 'pty', the pty update may ONLY touch the live number
 *    fields: primary, secondary, usedPercent, percentLeft.
 *    It must NOT change flags (loggedOut / noCredit / errorKind) or other fields.
 *  - Authoritative incoming always overrides everything.
 *  - 'manualReset' is a sticky field — preserved across updates unless the
 *    incoming partial explicitly sets it.
 *  - loggedOut:true clears noCredit (and vice-versa) — mutually exclusive.
 *  - updatedAt is always set to Date.now() on the merged result.
 *  - Disk writes are debounced 250 ms. In-memory is always immediately consistent.
 *  - flush() forces an immediate synchronous disk write (for tests / shutdown).
 */

const { EventEmitter } = require('events');
const path = require('path');

// 'claude-http' (endpoint do /usage) e 'grok-usage' (TUI sob demanda) entraram
// em 2026-09-08 — ambos são leituras completas, mandam sobre o parse de PTY.
const AUTHORITATIVE_SOURCES = new Set(['app-server', 'http', 'claude-status', 'claude-http', 'grok-usage']);

/**
 * Chaves do store (2026-09-08):
 *   "12"        legado — snapshot do provider PADRÃO do perfil (espelho; quem
 *               grava é o QuotaManager). Todo leitor antigo continua funcionando.
 *   "12:codex"  composta — um snapshot por (perfil, provider).
 * O evento 'change' carrega { key, num, provider, snapshot }.
 */
function parseKey(key) {
  const [numStr, provider] = String(key).split(':');
  return { num: Number(numStr), provider: provider || null };
}
const AUTHORITATIVE_WINDOW_MS = 30_000; // 30 s

// Fields that a pty update is allowed to change when an authoritative record
// is fresh (< 30 s old).
const PTY_ALLOWED_FIELDS = new Set(['primary', 'secondary', 'usedPercent', 'percentLeft']);

class QuotaStore extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cachePath  – path to the JSON cache file
   * @param {object} opts.fs         – injected fs (real or stub); must expose
   *                                   existsSync, mkdirSync, readFileSync, writeFileSync
   */
  constructor({ cachePath, fs }) {
    super();
    this._cachePath = cachePath;
    this._fs = fs;
    // Map<String(num), QuotaSnapshot>
    this._map = new Map();
    // Debounce state
    this._writeTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Read the cache file from disk into memory.
   * Call once at startup. Safe to call again (re-loads).
   */
  load() {
    try {
      if (!this._fs.existsSync(this._cachePath)) return;
      const raw = this._fs.readFileSync(this._cachePath, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const [key, val] of Object.entries(obj)) {
          if (val && typeof val === 'object') {
            this._map.set(String(key), val);
          }
        }
      }
    } catch (_) {
      // Corrupt or missing cache — start fresh.
    }
  }

  /**
   * Get the current snapshot for a profile.
   * @param {number|string} profileNum
   * @returns {QuotaSnapshot|null}
   */
  get(profileNum) {
    return this._map.get(String(profileNum)) ?? null;
  }

  /**
   * Get a deep clone of ALL snapshots (keyed by String(num)).
   * Callers cannot mutate internal state through the returned object.
   * @returns {{ [num: string]: QuotaSnapshot }}
   */
  getAll() {
    const out = {};
    for (const [key, val] of this._map.entries()) {
      out[key] = _deepClone(val);
    }
    return out;
  }

  /**
   * Merge a (possibly partial) snapshot for a profile.
   * Applies source-priority rules, preserves sticky fields, persists and emits.
   *
   * @param {number|string} profileNum
   * @param {Partial<QuotaSnapshot>} partial
   * @returns {QuotaSnapshot} – the fully merged snapshot stored in memory
   */
  update(profileNum, partial) {
    const key = String(profileNum);
    const existing = this._map.get(key) ?? {};
    const merged = _merge(existing, partial);
    this._map.set(key, merged);

    // Schedule debounced disk write (250 ms).
    this._schedulePersist();

    // Emit synchronously AFTER updating memory, BEFORE the disk write.
    this.emit('change', { key, ...parseKey(key), snapshot: _deepClone(merged) });

    return merged;
  }

  /**
   * Clear status flags (loggedOut, noCredit, errorKind) for a profile.
   * Used after a successful re-login. Emits 'change'.
   * @param {number|string} profileNum
   */
  clearFlags(profileNum) {
    const key = String(profileNum);
    const existing = this._map.get(key);
    if (!existing) return;

    const updated = { ...existing };
    delete updated.loggedOut;
    delete updated.noCredit;
    delete updated.errorKind;
    updated.updatedAt = Date.now();

    this._map.set(key, updated);
    this._schedulePersist();
    this.emit('change', { key, ...parseKey(key), snapshot: _deepClone(updated) });
  }

  /**
   * Force an immediate synchronous write of the cache to disk.
   * Use in tests (to avoid waiting for the 250 ms debounce) or at shutdown.
   */
  flush() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this._writeToDisk();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  _schedulePersist() {
    if (this._writeTimer) return; // already queued
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this._writeToDisk();
    }, 250);
    // Don't block Node exit for this timer.
    if (this._writeTimer.unref) this._writeTimer.unref();
  }

  _writeToDisk() {
    try {
      const dir = path.dirname(this._cachePath);
      this._fs.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [key, val] of this._map.entries()) {
        obj[key] = val;
      }
      this._fs.writeFileSync(this._cachePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (_) {
      // Best-effort — never crash the app for a failed cache write.
    }
  }
}

// ---------------------------------------------------------------------------
// Pure merge logic (module-private)
// ---------------------------------------------------------------------------

/**
 * Merge `partial` into `existing`, applying all contract rules.
 * Returns a new object; does NOT mutate either argument.
 */
function _merge(existing, partial) {
  // Determine whether the incoming update is pty-supplemental and whether
  // the existing record is within the authoritative freshness window.
  const incomingIsPty = partial.source === 'pty';
  const existingIsAuthoritative =
    existing.source && AUTHORITATIVE_SOURCES.has(existing.source);
  const existingIsFresh =
    typeof existing.updatedAt === 'number' &&
    existing.updatedAt > Date.now() - AUTHORITATIVE_WINDOW_MS;

  const ptyRestricted = incomingIsPty && existingIsAuthoritative && existingIsFresh;

  let merged;

  if (ptyRestricted) {
    // PTY can only update the live number fields; everything else stays from existing.
    merged = { ...existing };
    for (const field of PTY_ALLOWED_FIELDS) {
      if (field in partial) {
        merged[field] = partial[field];
      }
    }
  } else {
    // Authoritative (or no existing authoritative record) — full merge.
    merged = { ...existing, ...partial };
  }

  // Always preserve manualReset from existing unless partial explicitly sets it.
  if ('manualReset' in existing && !('manualReset' in partial)) {
    merged.manualReset = existing.manualReset;
  }

  // Mutual exclusion: loggedOut and noCredit cannot both be true.
  // The incoming partial's flag wins — if partial explicitly sets one, clear the other.
  // If neither comes from partial (e.g. both were already set), loggedOut takes priority.
  if (partial.loggedOut === true) {
    delete merged.noCredit;
  } else if (partial.noCredit === true) {
    delete merged.loggedOut;
  } else if (merged.loggedOut === true && merged.noCredit === true) {
    // Shouldn't normally happen, but if both somehow ended up set, loggedOut wins.
    delete merged.noCredit;
  }

  // Always stamp updatedAt.
  merged.updatedAt = Date.now();

  return merged;
}

/**
 * Deep clone via JSON round-trip (sufficient for QuotaSnapshot which is plain JSON).
 */
function _deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

QuotaStore.parseKey = parseKey;
module.exports = QuotaStore;
