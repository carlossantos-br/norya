'use strict';

/**
 * auth-flow-router.test.js
 *
 * Plain Node.js integration test (no test framework).
 * Run: node app/browser/test/auth-flow-router.test.js
 *
 * Exits 0 on PASS; exits 1 on FAIL.
 */

const assert = require('assert');
const net = require('net');
const fs = require('fs');
const AuthFlowRouter = require('../auth-flow-router');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
  process.stdout.write(args.join(' ') + '\n');
}

/**
 * Connect to a Unix socket and send a JSON payload, then disconnect.
 * Returns a Promise that resolves when the connection ends.
 */
function sendToSocket(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(payload));
      client.end();
    });
    client.on('finish', resolve);
    client.on('error', reject);
    // Resolve on 'close' as a fallback to cover all exit paths.
    client.on('close', resolve);
  });
}

/**
 * Wait for an event on an EventEmitter within a timeout.
 * Resolves with the event payload; rejects on timeout.
 */
function waitForEvent(emitter, eventName, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for event "${eventName}" after ${timeoutMs}ms`));
    }, timeoutMs);

    emitter.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Small sleep helper */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

(async () => {
  let failed = false;
  const router = new AuthFlowRouter({});

  try {
    // -----------------------------------------------------------------------
    // Test 1 – start() returns socketPath and env with correct keys
    // -----------------------------------------------------------------------
    log('[test 1] start() returns socketPath + env');
    const result999 = await router.start(999);

    assert.ok(result999.socketPath, 'socketPath must be truthy');
    assert.ok(result999.env, 'env object must be present');
    assert.ok(result999.env.BROWSER, 'env.BROWSER must be set');
    assert.strictEqual(result999.env.NORYA_AUTH_SOCKET, result999.socketPath,
      'env.NORYA_AUTH_SOCKET must equal socketPath');
    assert.strictEqual(result999.socketPath, AuthFlowRouter.socketPathFor(999),
      'socketPath must come from socketPathFor()');
    assert.ok(!result999.socketPath.startsWith('/tmp/norya-auth'), 'socket never in shared /tmp');
    const runDir = require('path').dirname(result999.socketPath);
    assert.strictEqual(fs.statSync(runDir).mode & 0o077, 0, 'socket dir must be private (0700)');

    log('  PASS – socketPath and env are correct');

    // -----------------------------------------------------------------------
    // Test 2 – auth-url event fires when client connects and sends URL
    // -----------------------------------------------------------------------
    log('[test 2] auth-url fires on socket message');

    const authUrlPromise = waitForEvent(router, 'auth-url');

    await sendToSocket(result999.socketPath, {
      url: 'https://chatgpt.com/oauth?x=1',
      ts: 1,
    });

    const authUrlEvent = await authUrlPromise;
    assert.strictEqual(authUrlEvent.profileId, 999, 'profileId must be 999');
    assert.strictEqual(authUrlEvent.url, 'https://chatgpt.com/oauth?x=1', 'URL must match');

    log('  PASS – auth-url fired with correct payload');

    // -----------------------------------------------------------------------
    // Test 3 – Dedupe: second socket message does NOT emit a new auth-url
    // -----------------------------------------------------------------------
    log('[test 3] dedupe – second socket send does not emit auth-url');

    let extraEvents = 0;
    router.on('auth-url', () => { extraEvents++; });

    await sendToSocket(result999.socketPath, {
      url: 'https://chatgpt.com/oauth?x=DIFFERENT',
      ts: 2,
    });

    // Give async I/O time to process.
    await sleep(200);

    assert.strictEqual(extraEvents, 0, 'No extra auth-url events should fire after first one');
    log('  PASS – dedupe working; no second auth-url event');

    // -----------------------------------------------------------------------
    // Test 4 – feedPtyChunk with URL does NOT fire when urlEmitted is true
    // -----------------------------------------------------------------------
    log('[test 4] feedPtyChunk ignores chunk when URL already emitted');

    let ptyExtraEvents = 0;
    const ptyListener = () => { ptyExtraEvents++; };
    router.on('auth-url', ptyListener);

    router.feedPtyChunk(999, 'open https://accounts.google.com/oauth/authorize?x=pty');

    await sleep(100);

    assert.strictEqual(ptyExtraEvents, 0, 'feedPtyChunk must not emit when URL already emitted');
    router.removeListener('auth-url', ptyListener);

    log('  PASS – feedPtyChunk is silent when URL already emitted');

    // -----------------------------------------------------------------------
    // Test 5 – New profile 998: feedPtyChunk emits auth-url
    // -----------------------------------------------------------------------
    log('[test 5] feedPtyChunk fires auth-url for fresh profile 998');

    await router.start(998);

    const ptyPromise = waitForEvent(router, 'auth-url');

    // Trailing newline (as codex always prints) so the URL token is complete —
    // the scraper only emits a URL followed by whitespace to avoid truncation.
    router.feedPtyChunk(998, 'open this https://accounts.google.com/oauth/authorize?code=abc123&state=xyz\r\n');

    const ptyEvent = await ptyPromise;
    assert.strictEqual(ptyEvent.profileId, 998, 'profileId must be 998');
    assert.ok(
      ptyEvent.url.startsWith('https://accounts.google.com/oauth/authorize'),
      `URL must start with the Google OAuth URL, got: ${ptyEvent.url}`
    );

    log(`  PASS – feedPtyChunk emitted auth-url for profile 998: ${ptyEvent.url}`);

    // -----------------------------------------------------------------------
    // Test 6 – markComplete emits auth-complete and cleans up
    // -----------------------------------------------------------------------
    log('[test 6] markComplete emits auth-complete');

    // Re-start a fresh session for profile 998 to test markComplete independently.
    await router.start(998);

    const completePromise = waitForEvent(router, 'auth-complete');
    router.markComplete(998);
    const completeEvent = await completePromise;

    assert.strictEqual(completeEvent.profileId, 998, 'auth-complete profileId must be 998');
    log('  PASS – auth-complete fired');

    // -----------------------------------------------------------------------
    // Test 7 – stop() deletes socket files
    // -----------------------------------------------------------------------
    log('[test 7] stop() removes socket files');

    const sock999 = AuthFlowRouter.socketPathFor(999);

    // Profile 999 is still active (we never stopped it).
    await router.stop(999);

    let sock999Exists = true;
    try {
      await fs.promises.access(sock999);
    } catch {
      sock999Exists = false;
    }
    assert.strictEqual(sock999Exists, false, 'Socket for profile 999 must be deleted after stop()');

    // Profile 998 was already stopped by markComplete — socket should be gone.
    const sock998 = AuthFlowRouter.socketPathFor(998);
    let sock998Exists = true;
    try {
      await fs.promises.access(sock998);
    } catch {
      sock998Exists = false;
    }
    assert.strictEqual(sock998Exists, false, 'Socket for profile 998 must be deleted after markComplete()');

    log('  PASS – socket files cleaned up');

    log('[test 8] only provider hosts from PTY output; only http(s) ever');
    const ok = AuthFlowRouter.isAcceptableAuthUrl;
    for (const u of ['https://auth.openai.com/oauth/authorize?x', 'https://claude.ai/oauth/authorize',
      'https://accounts.google.com/oauth/authorize', 'http://localhost:1455/auth/callback?code=1']) {
      assert.ok(ok(u, { fromPty: true }), `PTY must accept ${u}`);
    }
    for (const u of ['https://evil.com/login', 'https://evil.com/?r=auth.openai.com',
      'https://auth.openai.com.evil.com/x', 'https://evilchatgpt.com/oauth', 'http://chatgpt.com/oauth']) {
      assert.ok(!ok(u, { fromPty: true }), `PTY must reject ${u}`);
    }
    assert.ok(ok('https://any-provider.example/device'), 'socket (CLI $BROWSER) accepts any https host');
    for (const u of ['javascript:alert(1)//login', 'file:///etc/passwd?login', 'not a url']) {
      assert.ok(!ok(u), `never accept ${u}`);
    }
    log('  PASS – auth URL validation');

    // -----------------------------------------------------------------------
    // All tests passed
    // -----------------------------------------------------------------------
    log('\nPASS – all auth-flow-router tests passed');

  } catch (err) {
    log(`\nFAIL: ${err.message}`);
    if (err.stack) log(err.stack);
    failed = true;

    // Best-effort cleanup.
    try { await router.stop(999); } catch { /* ignore */ }
    try { await router.stop(998); } catch { /* ignore */ }
  }

  process.exit(failed ? 1 : 0);
})();
