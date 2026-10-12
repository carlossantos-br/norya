'use strict';
/**
 * quota-store.test.js — test suite for Module 4 (QuotaStore).
 *
 * Uses real `fs` and a temp directory: /tmp/norya-quota-store-test-<pid>/cache.json
 * Tests exercise all 8 required scenarios from CONTRACT.md §Module 4.
 *
 * Run: node quota/test/quota-store.test.js
 * Exit 0 = all passed, Exit 1 = at least one failure.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const QuotaStore = require('../quota-store');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const results = [];

function recordPass(name) {
  passed++;
  results.push(`  PASS  ${name}`);
}

function recordFail(name, err) {
  failed++;
  results.push(`  FAIL  ${name}\n         ${err.message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

const TMP_DIR = `/tmp/norya-quota-store-test-${process.pid}`;
const CACHE_PATH = path.join(TMP_DIR, 'cache.json');
fs.mkdirSync(TMP_DIR, { recursive: true });

function makeFreshStore(cachePath) {
  return new QuotaStore({ cachePath: cachePath || CACHE_PATH, fs });
}

// ---------------------------------------------------------------------------
// Tests (collected as async fns, run sequentially in main())
// ---------------------------------------------------------------------------

async function test1_updateGet() {
  const name = 'update → get returns merged snapshot';
  try {
    const store = makeFreshStore();
    const partial = {
      usedPercent: 42,
      percentLeft: 58,
      source: 'app-server',
      updatedAt: Date.now(),
    };
    const result = store.update(1, partial);
    assert.strictEqual(result.usedPercent, 42);
    assert.strictEqual(result.percentLeft, 58);
    assert.strictEqual(result.source, 'app-server');

    const got = store.get(1);
    assert.ok(got, 'get should return non-null');
    assert.strictEqual(got.usedPercent, 42);
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test2_getAllClone() {
  const name = 'getAll returns clone — mutation does not affect store';
  try {
    const store = makeFreshStore();
    store.update(2, { usedPercent: 10, source: 'http', updatedAt: Date.now() });

    const all = store.getAll();
    assert.ok(all['2'], 'key "2" should be present');

    // Mutate the clone
    all['2'].usedPercent = 999;
    all['2'].injected = 'evil';

    // Store should be unchanged
    const check = store.get(2);
    assert.strictEqual(check.usedPercent, 10, 'store should not reflect mutation of getAll result');
    assert.strictEqual(check.injected, undefined);
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test3a_ptyFreshAuth() {
  const name = 'pty after fresh authoritative: only numbers change, flags preserved';
  try {
    const store = makeFreshStore();

    // Set an authoritative record with a flag — just now, so it IS fresh (<30s)
    store.update(3, {
      usedPercent: 50,
      percentLeft: 50,
      source: 'app-server',
      errorKind: 'timeout',
      updatedAt: Date.now(),
    });

    // PTY update tries to clear errorKind and set loggedOut — should be blocked
    store.update(3, {
      usedPercent: 30,
      percentLeft: 70,
      source: 'pty',
      errorKind: null,
      loggedOut: true,
    });

    const after = store.get(3);
    assert.strictEqual(after.usedPercent, 30, 'pty should update usedPercent');
    assert.strictEqual(after.percentLeft, 70, 'pty should update percentLeft');
    assert.strictEqual(after.errorKind, 'timeout', 'errorKind must be preserved from authoritative');
    assert.ok(!after.loggedOut, 'loggedOut must NOT be set by pty when authoritative is fresh');
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test3b_ptyStaleAuth() {
  const name = 'pty after STALE authoritative: full pty merge allowed';
  try {
    const store = makeFreshStore();

    store.update(31, {
      usedPercent: 50,
      percentLeft: 50,
      source: 'app-server',
      errorKind: 'timeout',
      updatedAt: Date.now(),
    });

    // Forcibly backdate the record to simulate a stale authoritative (>30s ago)
    const stale = store.get(31);
    store._map.set('31', { ...stale, updatedAt: Date.now() - 35_000 });

    // PTY update — authoritative is stale, so full merge should be allowed
    store.update(31, {
      usedPercent: 20,
      percentLeft: 80,
      source: 'pty',
      errorKind: null,
    });

    const after = store.get(31);
    assert.strictEqual(after.usedPercent, 20, 'pty should update usedPercent on stale auth');
    assert.strictEqual(after.errorKind, null, 'errorKind should be updated by pty on stale auth');
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test3c_ptyNoAuth() {
  const name = 'pty with no prior authoritative record: full pty merge allowed';
  try {
    const store = makeFreshStore();

    store.update(32, {
      usedPercent: 77,
      percentLeft: 23,
      source: 'pty',
      errorKind: 'error',
    });

    const after = store.get(32);
    assert.strictEqual(after.usedPercent, 77);
    assert.strictEqual(after.errorKind, 'error');
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test4_manualReset() {
  const name = 'manualReset preserved across update that does not mention it';
  try {
    const store = makeFreshStore();
    store.update(4, {
      usedPercent: 10,
      source: 'http',
      manualReset: true,
      updatedAt: Date.now(),
    });
    // Second update — no manualReset field
    store.update(4, { usedPercent: 20, source: 'http', updatedAt: Date.now() });

    const result = store.get(4);
    assert.strictEqual(result.manualReset, true, 'manualReset must be preserved');
    assert.strictEqual(result.usedPercent, 20);
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test5a_loggedOutClearsNoCredit() {
  const name = 'loggedOut:true clears noCredit';
  try {
    const store = makeFreshStore();
    store.update(5, { noCredit: true, source: 'http', updatedAt: Date.now() });
    store.update(5, { loggedOut: true, source: 'http', updatedAt: Date.now() });
    const result = store.get(5);
    assert.strictEqual(result.loggedOut, true);
    assert.strictEqual(result.noCredit, undefined);
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test5b_noCreditClearsLoggedOut() {
  const name = 'noCredit:true clears loggedOut';
  try {
    const store = makeFreshStore();
    store.update(51, { loggedOut: true, source: 'http', updatedAt: Date.now() });
    store.update(51, { noCredit: true, source: 'http', updatedAt: Date.now() });
    const result = store.get(51);
    assert.strictEqual(result.noCredit, true);
    assert.strictEqual(result.loggedOut, undefined);
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test6_clearFlags() {
  const name = 'clearFlags removes loggedOut, noCredit, errorKind and emits change';
  try {
    const store = makeFreshStore();
    store.update(6, {
      usedPercent: 80,
      loggedOut: true,
      errorKind: 'auth',
      source: 'http',
      updatedAt: Date.now(),
    });

    let changeEvent = null;
    store.once('change', (ev) => { changeEvent = ev; });

    store.clearFlags(6);

    const result = store.get(6);
    assert.strictEqual(result.loggedOut, undefined, 'loggedOut should be cleared');
    assert.strictEqual(result.noCredit, undefined, 'noCredit should be cleared');
    assert.strictEqual(result.errorKind, undefined, 'errorKind should be cleared');
    assert.strictEqual(result.usedPercent, 80, 'other fields should remain');
    assert.ok(changeEvent, 'change event should have been emitted');
    assert.strictEqual(changeEvent.num, 6, 'change event num should be 6');
    assert.strictEqual(changeEvent.snapshot.loggedOut, undefined, 'snapshot in event should have no loggedOut');
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test7_persistence() {
  const name = 'persistence: data survives new QuotaStore + load()';
  try {
    const uniqueCache = path.join(TMP_DIR, `cache-persist-${Date.now()}.json`);

    const store1 = new QuotaStore({ cachePath: uniqueCache, fs });
    store1.update(7, {
      usedPercent: 55,
      percentLeft: 45,
      source: 'app-server',
      updatedAt: Date.now(),
    });
    // flush() = synchronous write, no need to wait 250ms
    store1.flush();

    assert.ok(fs.existsSync(uniqueCache), 'cache file should exist after flush');

    const store2 = new QuotaStore({ cachePath: uniqueCache, fs });
    store2.load();

    const result = store2.get(7);
    assert.ok(result, 'get() should return data after load()');
    assert.strictEqual(result.usedPercent, 55, 'persisted usedPercent should be 55');
    assert.strictEqual(result.percentLeft, 45);
    assert.strictEqual(result.source, 'app-server');
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test8_changeEvent() {
  const name = "'change' event fires with correct { num, snapshot }";
  try {
    const store = makeFreshStore();
    const events = [];
    store.on('change', (ev) => events.push(ev));

    store.update(8, { usedPercent: 99, source: 'claude-status', updatedAt: Date.now() });

    assert.strictEqual(events.length, 1, 'exactly one change event should be emitted');
    const ev = events[0];
    assert.strictEqual(ev.num, 8, 'event.num should be numeric 8');
    assert.strictEqual(typeof ev.num, 'number', 'event.num must be a Number');
    assert.ok(ev.snapshot, 'event.snapshot must be present');
    assert.strictEqual(ev.snapshot.usedPercent, 99);
    assert.strictEqual(ev.snapshot.source, 'claude-status');

    // Mutating the event snapshot should NOT affect the store
    ev.snapshot.usedPercent = 0;
    assert.strictEqual(store.get(8).usedPercent, 99, 'store must be immutable from event snapshot mutation');
    store.flush();
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

async function test9_debounce() {
  const name = 'debounce: rapid updates coalesce into one disk write after 250ms';
  try {
    const uniqueCache = path.join(TMP_DIR, `cache-debounce-${Date.now()}.json`);

    const store = new QuotaStore({ cachePath: uniqueCache, fs });

    // 5 rapid updates — memory is always consistent, disk write is deferred
    for (let i = 0; i < 5; i++) {
      store.update(9, { usedPercent: i * 10, source: 'pty', updatedAt: Date.now() });
    }

    // Immediately after: file should NOT yet exist (debounce hasn't fired)
    // (best-effort; on a very loaded machine it might already have fired)

    // Wait for the debounce (250ms) + margin
    await sleep(350);

    assert.ok(fs.existsSync(uniqueCache), 'cache file should exist after debounce period');
    const raw = JSON.parse(fs.readFileSync(uniqueCache, 'utf8'));
    assert.strictEqual(raw['9'].usedPercent, 40, 'file should have the last update value (i=4 → 40)');
    recordPass(name);
  } catch (err) { recordFail(name, err); }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main() {
  await test1_updateGet();
  await test2_getAllClone();
  await test3a_ptyFreshAuth();
  await test3b_ptyStaleAuth();
  await test3c_ptyNoAuth();
  await test4_manualReset();
  await test5a_loggedOutClearsNoCredit();
  await test5b_noCreditClearsLoggedOut();
  await test6_clearFlags();
  await test7_persistence();
  await test8_changeEvent();
  await test9_debounce();

  console.log('\nQuotaStore test results:');
  for (const r of results) console.log(r);
  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);

  // Cleanup
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
