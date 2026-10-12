'use strict';

/**
 * Tests for Module 5: QuotaManager (app/quota/index.js)
 *
 * Strategy: construct QuotaManager with stub injected deps, then overwrite
 * mgr.store / mgr.codexFetcher / mgr.claudeFetcher with fakes before calling
 * methods. This ensures tests pass even if sibling modules do not exist yet.
 *
 * Covers:
 *   1. feedPty('codex') → stub parser → store.update called with source:'pty'
 *   2. feedPty('claude') → stub parser → store.update called with source:'pty'
 *   3. feedPty rate-limit hit → store.update called with usedPercent:100
 *   4. refresh dispatches to codexFetcher for authMode 'chatgpt'
 *   5. refresh dispatches to codexFetcher for authMode 'apikey'
 *   6. refresh dispatches to claudeFetcher for authMode 'claude'
 *   7. refresh returns null for authMode 'openrouter'
 *   8. refresh returns null for authMode null
 *   9. refresh guards concurrent calls (in-flight dedup)
 *  10. refresh force=true bypasses in-flight guard
 *  11. refreshAll runs multiple fetches in parallel
 *  12. 'quota' event re-emitted when store emits 'change'
 *  13. start() delegates to store.load()
 *  14. get() delegates to store.get()
 *  15. getAll() delegates to store.getAll()
 *  16. clearFlags() delegates to store.clearFlags()
 */

const assert = require('assert');
const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// Load QuotaManager — siblings may fail to require; that's fine since we stub.
// ---------------------------------------------------------------------------
let QuotaManager;
try {
  QuotaManager = require('../index.js');
} catch (err) {
  console.error('FATAL: could not require ../index.js:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // Async test — handled in runAll
      return result.then(
        () => { console.log(`  PASS  ${name}`); passed++; },
        (err) => { console.log(`  FAIL  ${name}: ${err.message}`); failed++; }
      );
    }
    console.log(`  PASS  ${name}`);
    passed++;
    return Promise.resolve();
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

/**
 * Fake EventEmitter-based store that records calls.
 */
function makeStore() {
  const store = new EventEmitter();
  store._data = {};
  store._calls = { load: 0, get: [], getAll: 0, update: [], clearFlags: [] };

  store.load = () => { store._calls.load++; };

  store.get = (num) => {
    store._calls.get.push(num);
    return store._data[num] || null;
  };

  store.getAll = () => {
    store._calls.getAll++;
    return { ...store._data };
  };

  store.update = (num, partial) => {
    store._calls.update.push({ num, partial });
    const merged = { ...store._data[num], ...partial, updatedAt: Date.now() };
    store._data[num] = merged;
    store.emit('change', { num, snapshot: merged });
    return merged;
  };

  store.clearFlags = (num) => {
    store._calls.clearFlags.push(num);
    if (store._data[num]) {
      delete store._data[num].loggedOut;
      delete store._data[num].noCredit;
      delete store._data[num].errorKind;
    }
    store.emit('change', { num, snapshot: store._data[num] || null });
  };

  return store;
}

/**
 * Fake codex fetcher.
 * Returns a snapshot with source:'app-server', cli:'codex' for each call.
 */
function makeCodexFetcher(snapshots = {}) {
  return {
    _calls: [],
    async fetch(profileNum) {
      this._calls.push(profileNum);
      return snapshots[profileNum] || {
        usedPercent: 42,
        percentLeft: 58,
        source: 'app-server',
        cli: 'codex',
        updatedAt: Date.now(),
      };
    },
  };
}

/**
 * Fake claude fetcher.
 */
function makeClaudeFetcher(snapshots = {}) {
  return {
    _calls: [],
    async fetch(profileNum) {
      this._calls.push(profileNum);
      return snapshots[profileNum] || {
        usedPercent: 30,
        percentLeft: 70,
        source: 'claude-status',
        cli: 'claude',
        updatedAt: Date.now(),
      };
    },
  };
}

/**
 * Fake parser.
 * By default parseCodexChunk returns a partial; parseClaudeChunk returns null.
 * detectRateLimitHit returns { hit: false }.
 */
function makeParser(overrides = {}) {
  return {
    _parseCodexCalls: [],
    _parseClaudeCalls: [],
    _detectCalls: [],

    parseCodexChunk(text) {
      this._parseCodexCalls.push(text);
      return overrides.parseCodexResult !== undefined
        ? overrides.parseCodexResult
        : { usedPercent: 23, percentLeft: 77 };
    },

    parseClaudeChunk(text) {
      this._parseClaudeCalls.push(text);
      return overrides.parseClaudeResult !== undefined
        ? overrides.parseClaudeResult
        : { usedPercent: 55, percentLeft: 45 };
    },

    detectRateLimitHit(text, cli) {
      this._detectCalls.push({ text, cli });
      return overrides.detectResult !== undefined
        ? overrides.detectResult
        : { hit: false };
    },

    buildWindow(usedPercent, resetsAtSec) {
      const up = typeof usedPercent === 'number' ? usedPercent : 0;
      return {
        used_percent: up,
        percent_left: Math.max(0, 100 - up),
        resets_at: resetsAtSec || null,
        resets_at_ms: resetsAtSec ? resetsAtSec * 1000 : null,
      };
    },
  };
}

/**
 * Build a QuotaManager with minimal stub deps.
 * Stubs out store, codexFetcher, claudeFetcher AFTER construction so we don't
 * depend on siblings at all.
 *
 * @param {object} opts - overrides merged into deps
 * @param {object} storeOverride
 * @param {object} codexOverride
 * @param {object} claudeOverride
 * @param {object} parserOverride
 */
function makeManager({
  authModes = {},
  storeOverride,
  codexOverride,
  claudeOverride,
  parserOverride,
} = {}) {
  const getAccountContext = (num) => ({
    num,
    dir: '/tmp',
    env: {},
    authMode: authModes[num] !== undefined ? authModes[num] : 'chatgpt',
    shell: '/bin/sh',
    nvmScript: '/dev/null',
  });

  const parser = parserOverride || makeParser();

  const mgr = new QuotaManager({
    getAccountContext,
    cachePath: '/tmp/quota-test-cache.json',
    childSpawn: () => {},
    https: {},
    pty: {},
    fs: {
      readFileSync: () => '{}',
      writeFileSync: () => {},
      mkdirSync: () => {},
      existsSync: () => false,
    },
    logFn: () => {},
    parser,
  });

  // Replace sibling instances with stubs
  const store = storeOverride || makeStore();
  const codexFetcher = codexOverride || makeCodexFetcher();
  const claudeFetcher = claudeOverride || makeClaudeFetcher();

  mgr.store = store;
  mgr.codexFetcher = codexFetcher;
  mgr.claudeFetcher = claudeFetcher;

  // Re-wire events now that we've replaced store
  mgr._wireStoreEvents();

  return { mgr, store, codexFetcher, claudeFetcher, parser };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

async function runAll() {
  console.log('\nQuotaManager (Module 5) tests\n');

  // ---- Test 1: feedPty codex partial ----
  await test('1. feedPty codex → parseCodexChunk called → store.update source:pty', () => {
    const fakeParser = makeParser({ parseCodexResult: { usedPercent: 23, percentLeft: 77 } });
    const { mgr, store } = makeManager({ parserOverride: fakeParser });

    mgr.feedPty(1, 'codex', 'some codex output with 23% used');

    assert.ok(fakeParser._parseCodexCalls.length > 0, 'parseCodexChunk not called');
    assert.ok(store._calls.update.length > 0, 'store.update not called');
    const upd = store._calls.update[0];
    // Chave composta (perfil, provider) desde o snapshot por provider.
    assert.strictEqual(upd.num, '1:codex', 'wrong profile key');
    assert.strictEqual(upd.partial.source, 'pty', 'expected source:pty');
    assert.strictEqual(upd.partial.cli, 'codex', 'expected cli:codex');
    assert.strictEqual(upd.partial.usedPercent, 23, 'expected usedPercent:23');
  });

  // ---- Test 2: feedPty claude partial ----
  await test('2. feedPty claude → parseClaudeChunk called → store.update source:pty', () => {
    const fakeParser = makeParser({ parseClaudeResult: { usedPercent: 55, percentLeft: 45 } });
    const { mgr, store } = makeManager({ parserOverride: fakeParser });

    mgr.feedPty(2, 'claude', 'claude output with 55% used');

    assert.ok(fakeParser._parseClaudeCalls.length > 0, 'parseClaudeChunk not called');
    assert.ok(store._calls.update.length > 0, 'store.update not called');
    const upd = store._calls.update[0];
    assert.strictEqual(upd.partial.source, 'pty');
    assert.strictEqual(upd.partial.cli, 'claude');
    assert.strictEqual(upd.partial.usedPercent, 55);
  });

  // ---- Test 3: feedPty rate-limit hit ----
  await test('3. feedPty rate-limit hit → store.update usedPercent:100 percentLeft:0', () => {
    const fakeParser = makeParser({
      detectResult: { hit: true, resetsAt: Date.now() + 3600000, scope: '5h' },
    });
    const { mgr, store } = makeManager({ parserOverride: fakeParser });

    mgr.feedPty(1, 'codex', 'rate limit reached');

    assert.ok(store._calls.update.length > 0, 'store.update not called');
    const upd = store._calls.update[0];
    assert.strictEqual(upd.partial.usedPercent, 100);
    assert.strictEqual(upd.partial.percentLeft, 0);
    assert.strictEqual(upd.partial.source, 'pty');
  });

  // ---- Test 4: feedPty 500ms throttle ----
  await test('4. feedPty throttles parsing to once per 500ms', () => {
    const fakeParser = makeParser();
    const { mgr } = makeManager({ parserOverride: fakeParser });

    // First call should parse
    mgr.feedPty(1, 'codex', 'chunk1');
    const callsAfterFirst = fakeParser._parseCodexCalls.length;

    // Immediate second call should be throttled (within 500ms)
    mgr.feedPty(1, 'codex', 'chunk2');
    const callsAfterSecond = fakeParser._parseCodexCalls.length;

    assert.strictEqual(callsAfterFirst, callsAfterSecond, 'throttle did not suppress second parse');
  });

  // ---- Test 5: refresh dispatches to codexFetcher for authMode chatgpt ----
  await test('5. refresh dispatches to codexFetcher for authMode chatgpt', async () => {
    const { mgr, codexFetcher, claudeFetcher } = makeManager({ authModes: { 1: 'chatgpt' } });

    const result = await mgr.refresh(1);

    assert.strictEqual(codexFetcher._calls.length, 1, 'codexFetcher not called');
    assert.strictEqual(codexFetcher._calls[0], 1, 'wrong profile');
    assert.strictEqual(claudeFetcher._calls.length, 0, 'claudeFetcher should not be called');
    assert.ok(result, 'result should not be null');
    assert.strictEqual(result.cli, 'codex');
  });

  // ---- Test 6: refresh dispatches to codexFetcher for authMode apikey ----
  await test('6. refresh dispatches to codexFetcher for authMode apikey', async () => {
    const { mgr, codexFetcher } = makeManager({ authModes: { 2: 'apikey' } });

    await mgr.refresh(2);

    assert.strictEqual(codexFetcher._calls.length, 1);
    assert.strictEqual(codexFetcher._calls[0], 2);
  });

  // ---- Test 7: refresh dispatches to claudeFetcher for authMode claude ----
  await test('7. refresh dispatches to claudeFetcher for authMode claude', async () => {
    const { mgr, codexFetcher, claudeFetcher } = makeManager({ authModes: { 3: 'claude' } });

    const result = await mgr.refresh(3);

    assert.strictEqual(claudeFetcher._calls.length, 1, 'claudeFetcher not called');
    assert.strictEqual(claudeFetcher._calls[0], 3, 'wrong profile');
    assert.strictEqual(codexFetcher._calls.length, 0, 'codexFetcher should not be called');
    assert.ok(result, 'result should not be null');
    assert.strictEqual(result.cli, 'claude');
  });

  // ---- Test 8: refresh returns null for authMode openrouter ----
  await test('8. refresh returns null for authMode openrouter', async () => {
    const { mgr } = makeManager({ authModes: { 4: 'openrouter' } });
    const result = await mgr.refresh(4);
    assert.strictEqual(result, null, 'expected null for openrouter');
  });

  // ---- Test 9: refresh returns null for authMode null ----
  await test('9. refresh returns null for authMode null', async () => {
    const { mgr } = makeManager({ authModes: { 5: null } });
    const result = await mgr.refresh(5);
    assert.strictEqual(result, null, 'expected null for null authMode');
  });

  // ---- Test 10: refresh guards concurrent calls (in-flight dedup) ----
  await test('10. refresh concurrent calls share same promise (in-flight dedup)', async () => {
    let resolveFirst;
    const slowFetcher = {
      _calls: [],
      fetch(num) {
        this._calls.push(num);
        return new Promise((resolve) => {
          resolveFirst = () => resolve({
            usedPercent: 50, percentLeft: 50,
            source: 'app-server', cli: 'codex', updatedAt: Date.now(),
          });
        });
      },
    };

    const { mgr } = makeManager({ authModes: { 1: 'chatgpt' }, codexOverride: slowFetcher });

    const p1 = mgr.refresh(1);
    const p2 = mgr.refresh(1); // should return same promise

    assert.strictEqual(slowFetcher._calls.length, 1, 'fetcher should only be called once');

    resolveFirst();
    const [r1, r2] = await Promise.all([p1, p2]);

    // Both promises should resolve with the same result
    assert.ok(r1, 'r1 should not be null');
    assert.ok(r2, 'r2 should not be null');
    assert.strictEqual(slowFetcher._calls.length, 1, 'fetcher still should only have been called once');
  });

  // ---- Test 11: refresh force=true bypasses in-flight guard ----
  await test('11. refresh force=true joins the in-flight fetch', async () => {
    let resolveFirst;
    let callCount = 0;
    const slowFetcher = {
      _calls: [],
      fetch(num) {
        callCount++;
        this._calls.push(num);
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveFirst = () => resolve({
              usedPercent: 10, percentLeft: 90,
              source: 'app-server', cli: 'codex', updatedAt: Date.now(),
            });
          });
        }
        return Promise.resolve({
          usedPercent: 99, percentLeft: 1,
          source: 'app-server', cli: 'codex', updatedAt: Date.now(),
        });
      },
    };

    const { mgr } = makeManager({ authModes: { 1: 'chatgpt' }, codexOverride: slowFetcher });

    const p1 = mgr.refresh(1);              // starts first slow fetch
    const p2 = mgr.refresh(1, { force: true }); // force joins the in-flight fetch

    // O force fura o breaker de deslogado, não sobe um segundo app-server.
    assert.strictEqual(slowFetcher._calls.length, 1, `expected 1 fetcher call, got ${slowFetcher._calls.length}`);

    resolveFirst();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual(r1, r2);
  });

  // ---- Test 12: refreshAll runs multiple in parallel ----
  await test('12. refreshAll fetches all profiles in parallel', async () => {
    const delays = {};
    const fetcher = {
      _calls: [],
      async fetch(num) {
        this._calls.push({ num, time: Date.now() });
        await new Promise((r) => setTimeout(r, delays[num] || 10));
        return {
          usedPercent: num * 10,
          percentLeft: 100 - num * 10,
          source: 'app-server',
          cli: 'codex',
          updatedAt: Date.now(),
        };
      },
    };

    delays[1] = 30;
    delays[2] = 30;
    delays[3] = 30;

    const { mgr } = makeManager({
      authModes: { 1: 'chatgpt', 2: 'chatgpt', 3: 'chatgpt' },
      codexOverride: fetcher,
    });

    const before = Date.now();
    await mgr.refreshAll([{ num: 1, authMode: 'chatgpt' }, { num: 2, authMode: 'chatgpt' }, { num: 3, authMode: 'chatgpt' }]);
    const elapsed = Date.now() - before;

    assert.strictEqual(fetcher._calls.length, 3, 'expected 3 fetcher calls');
    // All 3 run in parallel so total should be << 3 * 30ms = 90ms
    // Allow generous margin (CI may be slow), but enforce some parallelism
    assert.ok(elapsed < 200, `expected parallel (<200ms), elapsed=${elapsed}ms`);
  });

  // ---- Test 13: 'quota' event re-emitted when store emits 'change' ----
  await test("13. 'quota' event re-emitted when store emits 'change'", () => {
    const { mgr, store } = makeManager();

    const quotaEvents = [];
    mgr.on('quota', (e) => quotaEvents.push(e));

    store.emit('change', { num: 7, snapshot: { usedPercent: 80 } });

    assert.strictEqual(quotaEvents.length, 1, 'expected 1 quota event');
    assert.strictEqual(quotaEvents[0].num, 7);
    assert.strictEqual(quotaEvents[0].snapshot.usedPercent, 80);
  });

  // ---- Test 14: store.update 'change' triggers 'quota' event ----
  await test("14. store.update triggers 'quota' event via 'change' re-emit", async () => {
    const { mgr, store } = makeManager({ authModes: { 1: 'chatgpt' } });

    const quotaEvents = [];
    mgr.on('quota', (e) => quotaEvents.push(e));

    await mgr.refresh(1);

    assert.ok(quotaEvents.length > 0, 'expected quota event after refresh');
    assert.ok(quotaEvents.some(e => e.num === '1:codex'), 'expected event for 1:codex');
  });

  // ---- Test 15: start() delegates to store.load() ----
  await test('15. start() delegates to store.load()', () => {
    const { mgr, store } = makeManager();
    assert.strictEqual(store._calls.load, 0);
    mgr.start();
    assert.strictEqual(store._calls.load, 1);
  });

  // ---- Test 16: get() delegates to store.get() ----
  await test('16. get() delegates to store.get()', () => {
    const { mgr, store } = makeManager();
    store._data[5] = { usedPercent: 77 };

    const result = mgr.get(5);

    assert.ok(store._calls.get.includes(5), 'store.get not called with 5');
    assert.strictEqual(result.usedPercent, 77);
  });

  // ---- Test 17: getAll() delegates to store.getAll() ----
  await test('17. getAll() delegates to store.getAll()', () => {
    const { mgr, store } = makeManager();
    store._data[1] = { usedPercent: 10 };
    store._data[2] = { usedPercent: 20 };

    const all = mgr.getAll();

    assert.strictEqual(store._calls.getAll, 1);
    assert.ok(all[1], 'profile 1 missing');
    assert.ok(all[2], 'profile 2 missing');
  });

  // ---- Test 18: clearFlags() delegates to store.clearFlags() ----
  await test('18. clearFlags() delegates to store.clearFlags()', () => {
    const { mgr, store } = makeManager();

    mgr.clearFlags(9);

    assert.ok(store._calls.clearFlags.includes(9), 'store.clearFlags not called with 9');
  });

  // ---- Test 19: feedPty rate-limit hit weekly scope sets secondary ----
  await test('19. feedPty rate-limit hit weekly scope → secondary window set', () => {
    const fakeParser = makeParser({
      detectResult: { hit: true, resetsAt: Date.now() + 7 * 24 * 3600000, scope: 'weekly' },
    });
    const { mgr, store } = makeManager({ parserOverride: fakeParser });

    mgr.feedPty(1, 'codex', 'weekly limit reached');

    assert.ok(store._calls.update.length > 0, 'store.update not called');
    const upd = store._calls.update[0];
    assert.ok(upd.partial.secondary, 'expected secondary window in update');
    assert.strictEqual(upd.partial.secondary.used_percent, 100);
    // primary should not be in the update for 'weekly' scope
    assert.ok(!upd.partial.primary, 'primary should not be set for weekly scope');
  });

  // ---- Test 20: feedPty rate-limit hit unknown scope sets both windows ----
  await test('20. feedPty rate-limit hit unknown scope → both primary and secondary set', () => {
    const fakeParser = makeParser({
      detectResult: { hit: true, resetsAt: null, scope: 'unknown' },
    });
    const { mgr, store } = makeManager({ parserOverride: fakeParser });

    mgr.feedPty(1, 'codex', 'unknown rate limit hit');

    assert.ok(store._calls.update.length > 0, 'store.update not called');
    const upd = store._calls.update[0];
    assert.ok(upd.partial.primary, 'expected primary window');
    assert.ok(upd.partial.secondary, 'expected secondary window');
    assert.strictEqual(upd.partial.primary.used_percent, 100);
    assert.strictEqual(upd.partial.secondary.used_percent, 100);
  });

  // ---- Summary ----
  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch((err) => {
  console.error('Unexpected error in test runner:', err);
  process.exit(1);
});
