'use strict';

// Tests for app/quota/codex-http.js
// Run with: node quota/test/codex-http.test.js
//
// Strategy: inject fake childSpawn + fake https. Drive each path using
// EventEmitter stubs so we do not need real processes or network.

const assert = require('assert');
const { EventEmitter } = require('events');

const CodexQuotaFetcher = require('../codex-http');

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const results = [];
let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    results.push(`  FAIL  ${name}\n         ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake proc that behaves like a child_process.ChildProcess.
 * Returns the proc itself (an EventEmitter) with helper methods attached directly.
 * The proc also has .stdinWrites, .emitStdout(), .emitStderr(), .emitExit(), .emitError().
 */
function makeFakeProc() {
  const stdinWrites = [];
  const stdin  = { write: (data) => stdinWrites.push(data) };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc   = new EventEmitter();

  proc.stdin       = stdin;
  proc.stdout      = stdout;
  proc.stderr      = stderr;
  proc._killed     = false;
  proc._spawnArgs  = null;
  proc.kill        = () => { proc._killed = true; };

  // Convenience helpers for driving tests.
  proc.stdinWrites = stdinWrites;
  proc.emitStdout  = (data) => stdout.emit('data', Buffer.from(data));
  proc.emitStderr  = (data) => stderr.emit('data', Buffer.from(data));
  proc.emitExit    = (code) => proc.emit('exit', code);
  proc.emitError   = (err)  => proc.emit('error', err);

  return proc;
}

/** Build a fake childSpawn that records args and returns the given proc. */
function makeChildSpawn(proc) {
  return (...args) => { proc._spawnArgs = args; return proc; };
}

/** Fake https that responds with the given statusCode. */
function makeFakeHttps(statusCode) {
  return {
    request: (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.resume = () => {};
      setImmediate(() => cb(res));
      const req = new EventEmitter();
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    },
  };
}

/** Standard fake account context. */
function makeCtx() {
  return {
    num:       1,
    dir:       '/fake/home',
    env:       { HOME: '/fake/home' },
    authMode:  'chatgpt',
    shell:     '/bin/zsh',
    nvmScript: '/fake/.nvm/nvm.sh',
  };
}

/** Monkey-patch fs.readFileSync to return a fake auth.json for paths containing 'auth.json'. */
function withFakeAuthJson(token, fn) {
  const origFs = require('fs');
  const origRead = origFs.readFileSync;
  origFs.readFileSync = (p, enc) => {
    if (typeof p === 'string' && p.includes('auth.json')) {
      if (token === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return JSON.stringify({ tokens: { access_token: token } });
    }
    return origRead(p, enc);
  };
  const restore = () => { origFs.readFileSync = origRead; };
  return restore;
}

/** Canned rateLimits payload for happy-path tests. */
const CANNED_RATE_LIMITS = {
  primary:   { usedPercent: 23, resetsAt: 1700000000, windowDurationMins: 300   },  // 5 h
  secondary: { usedPercent: 0,  resetsAt: 1700100000, windowDurationMins: 10080 },  // weekly
};

// ============================================================================
// All tests collected here; run sequentially.
// ============================================================================

async function main() {

  // ─── Test 1: Happy path ────────────────────────────────────────────────────
  await runTest('happy path: correct primary/secondary/percentLeft', async () => {
    const fp = makeFakeProc();
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: makeFakeHttps(200),
      logFn: () => {},
    });

    const fetchPromise = fetcher.fetch(1, { timeoutMs: 5000 });

    // Wait for the 500ms initialize timer.
    await new Promise(res => setTimeout(res, 600));

    assert.ok(fp.stdinWrites.some(w => w.includes('"method":"initialize"')),
      'should have written initialize to stdin');

    // Server → id:1 success.
    fp.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(res => setImmediate(res));

    assert.ok(fp.stdinWrites.some(w => w.includes('account/rateLimits/read')),
      'should have written account/rateLimits/read after id:1 ok');

    // Server → id:2 with rateLimits.
    fp.emitStdout(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { rateLimits: CANNED_RATE_LIMITS },
    }) + '\n');

    const snap = await fetchPromise;

    assert.strictEqual(snap.source, 'app-server');
    assert.strictEqual(snap.cli,    'codex');
    assert.ok(snap.primary,   'primary window must be present');
    assert.ok(snap.secondary, 'secondary window must be present');

    // primary = 5h window (windowDurationMins:300 ≤ 360), usedPercent:23 → percent_left:77
    assert.strictEqual(snap.primary.used_percent,   23);
    assert.strictEqual(snap.primary.percent_left,   77,  'primary.percent_left should be 77');

    // secondary = weekly window, usedPercent:0 → percent_left:100
    assert.strictEqual(snap.secondary.used_percent,  0);
    assert.strictEqual(snap.secondary.percent_left, 100, 'secondary.percent_left should be 100');

    // Rollup: percentLeft = min(77,100)=77; usedPercent = max(23,0)=23
    assert.strictEqual(snap.percentLeft, 77,  'percentLeft should be min(77,100)=77');
    assert.strictEqual(snap.usedPercent, 23,  'usedPercent should be max(23,0)=23');
    assert.strictEqual(snap.window,  'both');

    // resetsAt from primary (soonest).
    assert.strictEqual(snap.resetsAt, CANNED_RATE_LIMITS.primary.resetsAt * 1000,
      'resetsAt should be primary.resets_at_ms');

    assert.ok(fp._killed, 'proc.kill() should have been called');
  });

  // ─── Test 2: Single window with windowDurationMins > 360 → secondary ───────
  await runTest('single long window (>360 min) → secondary, primary null', async () => {
    const fp = makeFakeProc();
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: makeFakeHttps(200),
      logFn: () => {},
    });

    const fetchPromise = fetcher.fetch(1, { timeoutMs: 5000 });
    await new Promise(res => setTimeout(res, 600));

    fp.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(res => setImmediate(res));

    fp.emitStdout(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        rateLimits: {
          primary: { usedPercent: 50, resetsAt: 1700000000, windowDurationMins: 10080 },
        },
      },
    }) + '\n');

    const snap = await fetchPromise;
    assert.strictEqual(snap.primary,   null, 'primary should be null for weekly-only');
    assert.ok(snap.secondary,               'secondary should be set');
    assert.strictEqual(snap.secondary.used_percent, 50);
    assert.strictEqual(snap.secondary.percent_left, 50);
    assert.strictEqual(snap.window, 'weekly');
  });

  // ─── Test 3: id:2 error + HTTPS 401 → loggedOut:true ─────────────────────
  await runTest('id:2 error + https 401 → loggedOut:true', async () => {
    const fp = makeFakeProc();
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: makeFakeHttps(401),
      logFn: () => {},
    });

    const restore = withFakeAuthJson('fake-token-abc');

    const fetchPromise = fetcher.fetch(1, { timeoutMs: 5000 });
    await new Promise(res => setTimeout(res, 600));

    fp.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(res => setImmediate(res));

    fp.emitStdout(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32000, message: 'unauthorized' },
    }) + '\n');

    const snap = await fetchPromise;
    restore();

    assert.strictEqual(snap.loggedOut, true, 'loggedOut should be true on 401');
    assert.strictEqual(snap.source, 'app-server');
    assert.strictEqual(snap.cli,    'codex');
    assert.ok(fp._killed, 'proc.kill() should have been called');
  });

  // ─── Test 4: id:2 error + HTTPS 402 → noCredit:true ──────────────────────
  await runTest('id:2 error + https 402 → noCredit:true', async () => {
    const fp = makeFakeProc();
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: makeFakeHttps(402),
      logFn: () => {},
    });

    const restore = withFakeAuthJson('fake-token-abc');

    const fetchPromise = fetcher.fetch(1, { timeoutMs: 5000 });
    await new Promise(res => setTimeout(res, 600));

    fp.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(res => setImmediate(res));

    fp.emitStdout(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32000, message: 'payment required' },
    }) + '\n');

    const snap = await fetchPromise;
    restore();

    assert.strictEqual(snap.noCredit,  true,      'noCredit should be true on 402');
    assert.strictEqual(snap.loggedOut, undefined,  'loggedOut should not be set on 402');
    assert.ok(fp._killed);
  });

  // ─── Test 5: Timeout → errorKind:'timeout' ────────────────────────────────
  await runTest('timeout: proc never emits → errorKind:timeout', async () => {
    const fp = makeFakeProc();
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: makeFakeHttps(200),
      logFn: () => {},
    });

    // auth.json missing → loggedOut path inside _verifyToken.
    const restore = withFakeAuthJson(null);

    // Very short timeout so the test is fast.
    const fetchPromise = fetcher.fetch(1, { timeoutMs: 700 });

    // Proc never emits anything.
    const snap = await fetchPromise;
    restore();

    assert.strictEqual(snap.errorKind, 'timeout', 'errorKind should be timeout');
    assert.strictEqual(snap.source,    'app-server');
    assert.strictEqual(snap.cli,       'codex');
    assert.ok(fp._killed, 'proc.kill() should have been called on timeout');
  });

  // ─── Test 6: proc exits before data ───────────────────────────────────────
  await runTest('proc exit before data → snapshot with errorKind', async () => {
    const fp = makeFakeProc();
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: makeFakeHttps(200),
      logFn: () => {},
    });

    const restore = withFakeAuthJson('valid-token');
    const fetchPromise = fetcher.fetch(1, { timeoutMs: 5000 });

    // Exit immediately without sending any data.
    await new Promise(res => setImmediate(res));
    fp.emitExit(1);

    const snap = await fetchPromise;
    restore();

    // exit → reason 'exit' → kind becomes 'timeout' matching main.js line 1629
    assert.ok(['timeout', 'error'].includes(snap.errorKind),
      `errorKind should be timeout or error, got ${snap.errorKind}`);
    assert.strictEqual(snap.source, 'app-server');
    assert.strictEqual(snap.cli,    'codex');
  });

  // ─── Test 7: stderr auth keyword → skip HTTP, loggedOut:true ─────────────
  await runTest('stderr auth keyword → loggedOut without HTTP call', async () => {
    const fp = makeFakeProc();
    let httpsCalled = false;
    const fakeHttps = {
      request: (...args) => { httpsCalled = true; return makeFakeHttps(200).request(...args); },
    };

    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: fakeHttps,
      logFn: () => {},
    });

    const fetchPromise = fetcher.fetch(1, { timeoutMs: 5000 });
    await new Promise(res => setImmediate(res));

    // Emit auth-keyword in stderr then proc exits.
    fp.emitStderr('Error: unauthorized — please re-authenticate\n');
    fp.emitExit(1);

    const snap = await fetchPromise;

    // kind === 'auth' → _verifyToken short-circuits → loggedOut:true without HTTP.
    assert.strictEqual(snap.loggedOut, true,  'loggedOut should be true when stderr has auth keyword');
    assert.strictEqual(httpsCalled,    false,  'https.request should NOT be called when kind===auth');
  });

  // ─── Test 8: missing auth.json → loggedOut:true ───────────────────────────
  await runTest('missing auth.json → loggedOut:true', async () => {
    const fp = makeFakeProc();
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: makeFakeHttps(200),
      logFn: () => {},
    });

    const restore = withFakeAuthJson(null); // throws ENOENT

    const fetchPromise = fetcher.fetch(1, { timeoutMs: 5000 });
    await new Promise(res => setImmediate(res));
    fp.emitExit(1);

    const snap = await fetchPromise;
    restore();

    assert.strictEqual(snap.loggedOut, true, 'loggedOut should be true when auth.json is missing');
  });

  // ─── Test 9: getAccountContext throws → immediate error snapshot ──────────
  await runTest('getAccountContext throws → returns error snapshot immediately', async () => {
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => { throw new Error('no such profile'); },
      childSpawn: () => { throw new Error('should not be called'); },
      https: makeFakeHttps(200),
      logFn: () => {},
    });

    const snap = await fetcher.fetch(99);
    assert.strictEqual(snap.errorKind, 'error');
    assert.strictEqual(snap.source,    'app-server');
    assert.strictEqual(snap.cli,       'codex');
  });

  // ─── Test 10: Split stdout chunks ─────────────────────────────────────────
  await runTest('split stdout chunks: id:1 response split across two data events', async () => {
    const fp = makeFakeProc();
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: makeFakeHttps(200),
      logFn: () => {},
    });

    const fetchPromise = fetcher.fetch(1, { timeoutMs: 5000 });
    await new Promise(res => setTimeout(res, 600));

    const id1Resp = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n';
    fp.emitStdout(id1Resp.slice(0, 10));
    fp.emitStdout(id1Resp.slice(10));
    await new Promise(res => setImmediate(res));

    fp.emitStdout(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { rateLimits: CANNED_RATE_LIMITS },
    }) + '\n');

    const snap = await fetchPromise;
    assert.strictEqual(snap.source, 'app-server');
    assert.strictEqual(snap.primary.percent_left, 77,
      'should correctly parse after split chunks');
  });

  // ─── Test 11: percent math parity with main.js ────────────────────────────
  await runTest('percent math: usedPercent:100 → percent_left:0 (max 0 floor)', async () => {
    const fp = makeFakeProc();
    const fetcher = new CodexQuotaFetcher({
      getAccountContext: () => makeCtx(),
      childSpawn: makeChildSpawn(fp),
      https: makeFakeHttps(200),
      logFn: () => {},
    });

    const fetchPromise = fetcher.fetch(1, { timeoutMs: 5000 });
    await new Promise(res => setTimeout(res, 600));

    fp.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(res => setImmediate(res));

    fp.emitStdout(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        rateLimits: {
          primary:   { usedPercent: 100, resetsAt: 1700000000, windowDurationMins: 300   },
          secondary: { usedPercent: 0,   resetsAt: 1700100000, windowDurationMins: 10080 },
        },
      },
    }) + '\n');

    const snap = await fetchPromise;
    assert.strictEqual(snap.primary.percent_left,   0,   'percent_left floored at 0');
    assert.strictEqual(snap.primary.used_percent,   100, 'used_percent should be 100');
    assert.strictEqual(snap.percentLeft,            0,   'top-level percentLeft = min(0,100) = 0');
    assert.strictEqual(snap.usedPercent,            100, 'top-level usedPercent = max(100,0) = 100');
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + results.join('\n'));
  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unexpected error in test runner:', err);
  process.exit(1);
});
