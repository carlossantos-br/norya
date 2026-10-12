'use strict';

/**
 * Tests for app/quota/claude-status.js (Module 2)
 *
 * Approach:
 *   - Inject a FAKE `pty` whose .spawn() returns a stub proc.
 *   - Inject a STUB `parser` with a deterministic parseClaudeStatus.
 *   - Inject a STUB `getAccountContext` returning a safe fake context.
 *   - Run fetch() and assert the returned snapshot shape + side-effects.
 *
 * Test cases:
 *   1. Happy path — canned /status output emitted, parser returns known snapshot.
 *   2. Logged-out path — "not logged in" in output → loggedOut:true, errorKind:'auth'.
 *   3. Timeout path — PTY never emits anything → errorKind:'timeout', kill called.
 *   4. Parser-null path — status content found but parser returns null → errorKind:'error'.
 *   5. kill() is always called (verified inside each test).
 */

const assert = require('assert');
const ClaudeStatusFetcher = require('../claude-status');

// ─── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
    failed++;
  }
}

// ─── fake context ─────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    num: 1,
    dir: '/tmp/fake-home',
    env: { HOME: '/tmp/fake-home', PATH: '/usr/bin:/bin' },
    authMode: 'claude',
    shell: '/bin/sh',
    nvmScript: '/tmp/.nvm/nvm.sh',
    ...overrides,
  };
}

const fakeGetAccountContext = (profileNum) => makeCtx({ num: profileNum });

// ─── fake parser ──────────────────────────────────────────────────────────────

const KNOWN_SNAPSHOT = {
  primary: { used_percent: 45, percent_left: 55, resets_at: null, resets_at_ms: null },
  secondary: null,
  usedPercent: 45,
  percentLeft: 55,
  window: '5h',
  resetsAt: null,
  used: null,
  total: null,
  updatedAt: 0, // fetcher overwrites this
};

const happyParser = {
  parseClaudeStatus: (_buf) => ({ ...KNOWN_SNAPSHOT }),
};

const nullParser = {
  parseClaudeStatus: (_buf) => null,
};

// ─── fake PTY factory ─────────────────────────────────────────────────────────

/**
 * Build a fake `pty` module.
 *
 * @param {object} opts
 * @param {string|null} opts.statusOutput  - data to emit via onData after write('/status\r');
 *                                           null means never emit anything (timeout test).
 * @param {number}      [opts.emitDelayMs] - how long after write() to emit data (default 50ms)
 */
function makeFakePty({ statusOutput = null, emitDelayMs = 50 } = {}) {
  const state = {
    spawnCalled: false,
    spawnArgs: null,
    killCalled: false,
    writtenData: [],
    onDataCb: null,
    onExitCb: null,
  };

  const proc = {
    onData(cb) { state.onDataCb = cb; },
    onExit(cb) { state.onExitCb = cb; },
    write(data) {
      state.writtenData.push(data);
      // After receiving the usage command, emit the canned output (if any).
      // The fetcher sends `/usage` (the panel with real quota numbers).
      if (statusOutput !== null && (data.includes('/usage') || data.includes('/status'))) {
        setTimeout(() => {
          if (state.onDataCb) state.onDataCb(statusOutput);
        }, emitDelayMs);
      }
    },
    kill() { state.killCalled = true; },
  };

  const pty = {
    spawn(...args) {
      state.spawnCalled = true;
      state.spawnArgs = args;
      return proc;
    },
    _state: state,
  };

  return pty;
}

// ─── tests ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\nclause-status.js tests\n');

  // ── Test 1: Happy path ────────────────────────────────────────────────────
  await runTest('happy path: returns parsed snapshot and calls kill()', async () => {
    // Canned output that contains '%' (triggers status-like detection) plus real-ish content.
    const cannedOutput = `
╭─────────────────────────────────────────────╮
│          /status output                     │
│  API usage: 45% used                        │
│  5h limit: 55% remaining                    │
│  Subscription: Pro                          │
╰─────────────────────────────────────────────╯
`;

    const fakePty = makeFakePty({ statusOutput: cannedOutput, emitDelayMs: 50 });

    const fetcher = new ClaudeStatusFetcher({
      getAccountContext: fakeGetAccountContext,
      pty: fakePty,
      parser: happyParser,
      logFn: () => {}, // suppress output
    });

    const snapshot = await fetcher.fetch(1, { timeoutMs: 10000 });

    assert.strictEqual(snapshot.source, 'claude-status', 'source should be claude-status');
    assert.strictEqual(snapshot.cli, 'claude', 'cli should be claude');
    assert.strictEqual(typeof snapshot.updatedAt, 'number', 'updatedAt should be a number');
    assert.ok(snapshot.updatedAt > 0, 'updatedAt should be > 0');
    assert.strictEqual(snapshot.usedPercent, 45, 'usedPercent should be 45');
    assert.strictEqual(snapshot.percentLeft, 55, 'percentLeft should be 55');
    assert.strictEqual(fakePty._state.killCalled, true, 'kill() should have been called');
    assert.ok(fakePty._state.writtenData.some(d => d.includes('/usage')),
      'should have written /usage to the PTY');
    assert.strictEqual(fakePty._state.spawnCalled, true, 'spawn() should have been called');

    // Verify spawn was called with correct shell and flags
    const [shell, args] = fakePty._state.spawnArgs;
    assert.strictEqual(shell, '/bin/sh', 'spawn shell should match ctx.shell');
    assert.deepStrictEqual(args.slice(0, 2), ['-l', '-c'], 'spawn args should start with -l -c');
    // initCmd should include nvm source, brew shellenv, and `claude` (no -p)
    const initCmd = args[2];
    assert.ok(initCmd.includes('nvm.sh'), 'initCmd should source nvm');
    assert.ok(initCmd.includes('brew shellenv'), 'initCmd should eval brew shellenv');
    assert.ok(/\bclaude\b/.test(initCmd), 'initCmd should run claude');
    assert.ok(!initCmd.includes('-p'), 'initCmd must NOT include -p flag');
  });

  // ── Test 2: Logged-out path ───────────────────────────────────────────────
  await runTest('logged-out: "not logged in" output → loggedOut:true, errorKind:auth', async () => {
    const loggedOutOutput = 'You are not logged in. Run /login to authenticate.';
    const fakePty = makeFakePty({ statusOutput: loggedOutOutput, emitDelayMs: 30 });

    const fetcher = new ClaudeStatusFetcher({
      getAccountContext: fakeGetAccountContext,
      pty: fakePty,
      parser: happyParser, // parser should NOT be called
      logFn: () => {},
    });

    const snapshot = await fetcher.fetch(1, { timeoutMs: 10000 });

    assert.strictEqual(snapshot.loggedOut, true, 'loggedOut should be true');
    assert.strictEqual(snapshot.errorKind, 'auth', 'errorKind should be auth');
    assert.strictEqual(snapshot.source, 'claude-status', 'source should be claude-status');
    assert.strictEqual(snapshot.cli, 'claude', 'cli should be claude');
    assert.strictEqual(fakePty._state.killCalled, true, 'kill() should have been called even on logged-out');
  });

  // ── Test 2b: Logged-out variant — "/login" ────────────────────────────────
  await runTest('logged-out: "/login" substring triggers auth detection', async () => {
    const loggedOutOutput = 'Please visit /login to continue.';
    const fakePty = makeFakePty({ statusOutput: loggedOutOutput, emitDelayMs: 30 });

    const fetcher = new ClaudeStatusFetcher({
      getAccountContext: fakeGetAccountContext,
      pty: fakePty,
      parser: happyParser,
      logFn: () => {},
    });

    const snapshot = await fetcher.fetch(1, { timeoutMs: 10000 });

    assert.strictEqual(snapshot.loggedOut, true, 'loggedOut should be true');
    assert.strictEqual(snapshot.errorKind, 'auth', 'errorKind should be auth');
    assert.strictEqual(fakePty._state.killCalled, true, 'kill() should be called');
  });

  // ── Test 2c: Logged-out variant — "log in to" ────────────────────────────
  await runTest('logged-out: "log in to" substring triggers auth detection', async () => {
    const loggedOutOutput = 'Please log in to use claude.';
    const fakePty = makeFakePty({ statusOutput: loggedOutOutput, emitDelayMs: 30 });

    const fetcher = new ClaudeStatusFetcher({
      getAccountContext: fakeGetAccountContext,
      pty: fakePty,
      parser: happyParser,
      logFn: () => {},
    });

    const snapshot = await fetcher.fetch(1, { timeoutMs: 10000 });

    assert.strictEqual(snapshot.loggedOut, true, 'loggedOut should be true');
    assert.strictEqual(snapshot.errorKind, 'auth', 'errorKind should be auth');
    assert.strictEqual(fakePty._state.killCalled, true, 'kill() should be called');
  });

  // ── Test 3: Timeout path ──────────────────────────────────────────────────
  await runTest('timeout: PTY never emits → errorKind:timeout, kill() called', async () => {
    // statusOutput: null means no data is ever emitted. Use nullParser so the
    // last-resort parse-on-timeout finds nothing and the timeout path is taken.
    const fakePty = makeFakePty({ statusOutput: null });

    const fetcher = new ClaudeStatusFetcher({
      getAccountContext: fakeGetAccountContext,
      pty: fakePty,
      parser: nullParser,
      logFn: () => {},
    });

    const t0 = Date.now();
    const snapshot = await fetcher.fetch(1, { timeoutMs: 500 /* short for tests */ });
    const elapsed = Date.now() - t0;

    assert.strictEqual(snapshot.errorKind, 'timeout', 'errorKind should be timeout');
    assert.strictEqual(snapshot.source, 'claude-status', 'source should be claude-status');
    assert.strictEqual(snapshot.cli, 'claude', 'cli should be claude');
    assert.strictEqual(typeof snapshot.updatedAt, 'number', 'updatedAt should be a number');
    assert.ok(elapsed >= 490, `should have waited at least ~500ms, got ${elapsed}ms`);
    assert.strictEqual(fakePty._state.killCalled, true, 'kill() should have been called on timeout');
  });

  // ── Test 4: Parser returns null ───────────────────────────────────────────
  await runTest('parser-null: status content but parser returns null → errorKind:error', async () => {
    // Output contains '%' so the settle timer arms, but parser returns null
    const cannedOutput = '5h limit: 45% used, resets at 18:00';
    const fakePty = makeFakePty({ statusOutput: cannedOutput, emitDelayMs: 50 });

    const fetcher = new ClaudeStatusFetcher({
      getAccountContext: fakeGetAccountContext,
      pty: fakePty,
      parser: nullParser,  // always returns null
      logFn: () => {},
    });

    const snapshot = await fetcher.fetch(1, { timeoutMs: 10000 });

    assert.strictEqual(snapshot.errorKind, 'error', 'errorKind should be error when parser returns null');
    assert.strictEqual(snapshot.source, 'claude-status', 'source should be claude-status');
    assert.strictEqual(snapshot.cli, 'claude', 'cli should be claude');
    assert.strictEqual(fakePty._state.killCalled, true, 'kill() should be called even when parser fails');
  });

  // ── Test 5: Constructor validation ───────────────────────────────────────
  await runTest('constructor: throws if required injection missing', () => {
    assert.throws(
      () => new ClaudeStatusFetcher({ pty: {}, parser: {} }),
      /getAccountContext/,
      'should throw when getAccountContext is missing',
    );
    assert.throws(
      () => new ClaudeStatusFetcher({ getAccountContext: () => {}, parser: {} }),
      /pty/,
      'should throw when pty is missing',
    );
    assert.throws(
      () => new ClaudeStatusFetcher({ getAccountContext: () => {}, pty: {} }),
      /parser/,
      'should throw when parser is missing',
    );
  });

  // ── Test 6: kill() not called twice (done guard) ──────────────────────────
  await runTest('done guard: fetch resolves only once even if onData fires multiple times', async () => {
    let killCount = 0;
    let dataCb = null;

    const proc = {
      onData(cb) { dataCb = cb; },
      onExit() {},
      write(data) {
        if (data.includes('/usage') || data.includes('/status')) {
          // Fire onData multiple times rapidly
          setTimeout(() => {
            dataCb && dataCb('45% used limit subscription plan');
            dataCb && dataCb('45% used limit subscription plan again');
            dataCb && dataCb('45% used limit subscription plan again again');
          }, 50);
        }
      },
      kill() { killCount++; },
    };

    const pty = { spawn: () => proc };

    const fetcher = new ClaudeStatusFetcher({
      getAccountContext: fakeGetAccountContext,
      pty,
      parser: happyParser,
      logFn: () => {},
    });

    const snapshot = await fetcher.fetch(1, { timeoutMs: 10000 });

    // Give extra time for spurious re-fires
    await new Promise(r => setTimeout(r, 100));

    assert.strictEqual(snapshot.source, 'claude-status', 'source should be claude-status');
    assert.strictEqual(killCount, 1, 'kill() should be called exactly once');
  });

  // ── Test 7: ANSI stripping does not break logged-out detection ────────────
  await runTest('ANSI codes in output do not break logged-out detection', async () => {
    // Wrap "not logged in" in ANSI colour codes
    const ansiOutput = '\x1b[31mError:\x1b[0m You are not logged in. Please run /login.';
    const fakePty = makeFakePty({ statusOutput: ansiOutput, emitDelayMs: 30 });

    const fetcher = new ClaudeStatusFetcher({
      getAccountContext: fakeGetAccountContext,
      pty: fakePty,
      parser: happyParser,
      logFn: () => {},
    });

    const snapshot = await fetcher.fetch(1, { timeoutMs: 10000 });

    assert.strictEqual(snapshot.loggedOut, true, 'loggedOut should be true with ANSI output');
    assert.strictEqual(snapshot.errorKind, 'auth', 'errorKind should be auth');
    assert.strictEqual(fakePty._state.killCalled, true, 'kill() should be called');
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
