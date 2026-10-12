'use strict';

/**
 * smoke.js — Norya Browser Feature End-to-End Smoke Test Harness
 *
 * Two modes:
 *   --module   Unit-style tests, no Electron required.
 *   --running  Integration tests against a live Norya instance.
 *
 * Usage:
 *   node app/browser/test/smoke.js --module
 *   REAL_IP=<your-ip> node app/browser/test/smoke.js --running
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

// ---------------------------------------------------------------------------
// CLI args / env
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const MODE_MODULE  = args.includes('--module');
const MODE_RUNNING = args.includes('--running');

if (!MODE_MODULE && !MODE_RUNNING) {
  console.error('Usage: node smoke.js --module | --running');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const APP_DIR       = path.join(__dirname, '..', '..');
const BROWSER_DIR   = path.join(__dirname, '..');
const BIN_TOR       = path.join(APP_DIR, 'bin', 'tor', 'darwin-arm64', 'tor');
const ACCOUNTS_DIR  = path.join(os.tmpdir(), 'norya-smoke-' + process.pid);

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

/**
 * Record and print a single test result.
 * @param {boolean}  ok
 * @param {string}   name
 * @param {string}   [detail]
 */
function record(ok, name, detail) {
  const tag    = ok ? '[PASS]' : '[FAIL]';
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${tag} ${name}${suffix}`);
  if (ok) passed++; else failed++;
}

/**
 * Run a named test function, catching any thrown error and treating it as FAIL.
 */
async function test(name, fn) {
  try {
    const detail = await fn();
    record(true, name, detail);
  } catch (err) {
    record(false, name, err.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// Wait helper
// ---------------------------------------------------------------------------

/**
 * Poll fn() every 200ms until it returns a truthy value or timeoutMs elapses.
 * Resolves with the truthy return value; rejects on timeout.
 */
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tiny JSON-RPC client for --running mode
// ---------------------------------------------------------------------------

/**
 * Send one JSON-RPC 2.0 call over a Unix socket and resolve with the result.
 * @param {string} socketPath
 * @param {string} method
 * @param {object} params
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function rpcCall(socketPath, method, params, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`rpcCall "${method}" timed out`));
    }, timeoutMs);

    socket.once('error', (err) => { clearTimeout(timer); reject(err); });

    socket.once('connect', () => {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n';
      socket.write(payload);
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        socket.destroy();
        try {
          const resp = JSON.parse(buf.slice(0, nl));
          if (resp.error) reject(new Error(JSON.stringify(resp.error)));
          else resolve(resp.result);
        } catch (e) {
          reject(e);
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------

const cleanups = [];
function registerCleanup(fn) { cleanups.push(fn); }

async function runCleanups() {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* ignore */ }
  }
  // Remove temp accounts dir
  try { fs.rmSync(ACCOUNTS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// ============================================================
// MODE A: --module
// ============================================================
// ---------------------------------------------------------------------------

async function runModuleTests() {
  // ------------------------------------------------------------------
  // 1. TorManager
  // ------------------------------------------------------------------

  let torPresent = false;
  try {
    fs.accessSync(BIN_TOR, fs.constants.X_OK);
    torPresent = true;
  } catch {
    /* tor not present — skip gracefully */
  }

  if (torPresent) {
    let TorManager;
    try { TorManager = require('../tor-manager'); } catch (e) {
      record(false, 'tor.load_module', e.message);
      goto_tor_skip:
      TorManager = null;
    }

    if (TorManager) {
      const torAccountsDir = path.join(ACCOUNTS_DIR, 'tor-accounts');
      fs.mkdirSync(torAccountsDir, { recursive: true });

      const torManager = new TorManager({
        binaryDir : path.join(APP_DIR, 'bin', 'tor'),
        accountsDir: torAccountsDir,
      });
      const TOR_PROFILE = 999;

      await test('tor.spawn', async () => {
        await torManager.spawnForProfile(TOR_PROFILE);
        return 'spawned';
      });

      await test('tor.getStatus_initial', async () => {
        const status = await torManager.getStatus(TOR_PROFILE);
        assert.strictEqual(status.running, true, 'should be running');
        const ipOk = /^\d{1,3}(\.\d{1,3}){3}$/.test(status.exitIP) || (status.exitIP && status.exitIP.includes(':'));
        assert.ok(ipOk, `exitIP "${status.exitIP}" does not look like an IP`);
        const countryOk = !status.exitCountry || /^[A-Z]{2}$/.test(status.exitCountry);
        assert.ok(countryOk, `exitCountry "${status.exitCountry}" is not a 2-letter code`);
        return `exitIP=${status.exitIP} country=${status.exitCountry || '??'}`;
      });

      let firstIP;
      await test('tor.newCircuit', async () => {
        const before = await torManager.getStatus(TOR_PROFILE);
        firstIP = before.exitIP;
        await torManager.newCircuit(TOR_PROFILE);
        // After NEWNYM status should still report running and a valid IP
        const after = await torManager.getStatus(TOR_PROFILE);
        assert.strictEqual(after.running, true, 'still running after NEWNYM');
        const ipOk = /^\d{1,3}(\.\d{1,3}){3}$/.test(after.exitIP) || (after.exitIP && after.exitIP.includes(':'));
        assert.ok(ipOk, `exitIP "${after.exitIP}" not valid after NEWNYM`);
        return `before=${firstIP} after=${after.exitIP} (may differ)`;
      });

      await test('tor.killForProfile', async () => {
        await torManager.killForProfile(TOR_PROFILE);
        const status = await torManager.getStatus(TOR_PROFILE);
        assert.strictEqual(status.running, false, 'should not be running after kill');
        return 'killed, running=false';
      });

      // Cleanup DataDir
      registerCleanup(async () => {
        try { await torManager.killAll(); } catch { /* ignore */ }
        fs.rmSync(torAccountsDir, { recursive: true, force: true });
      });
    }
  } else {
    console.log('[SKIP] tor.* — binary not found at ' + BIN_TOR);
  }

  // ------------------------------------------------------------------
  // 3. PrivacyHardener
  // ------------------------------------------------------------------

  let hardener;
  try { hardener = require('../privacy-hardener'); } catch (e) {
    record(false, 'hardener.load_module', e.message);
    hardener = null;
  }

  if (hardener) {
    const { getNoiseSeed, getRandomUserAgent, getPreloadArgs } = hardener;

    await test('hardener.getNoiseSeed_deterministic', async () => {
      const opts = { profileId: 'test1', mode: 'normal', sessionStartTs: 1700000000000 };
      const s1 = getNoiseSeed(opts);
      const s2 = getNoiseSeed(opts);
      assert.strictEqual(s1, s2, 'seed must be deterministic');
      assert.match(s1, /^[0-9a-f]{16}$/, 'seed must be 16 hex chars');
      return `seed=${s1}`;
    });

    await test('hardener.getNoiseSeed_max_anon_differs_by_tab', async () => {
      const base = { profileId: 'test1', mode: 'max_anon', sessionStartTs: 1700000000000 };
      const s1 = getNoiseSeed({ ...base, tabId: 1 });
      const s2 = getNoiseSeed({ ...base, tabId: 2 });
      assert.notStrictEqual(s1, s2, 'max_anon seeds for different tabs must differ');
      return `tab1=${s1} tab2=${s2}`;
    });

    await test('hardener.getRandomUserAgent', async () => {
      const seed = getNoiseSeed({ profileId: 'p1', mode: 'normal', sessionStartTs: 1 });
      const ua = getRandomUserAgent(seed, 'normal');
      assert.ok(ua.includes('Chrome'), `UA must contain "Chrome": ${ua}`);
      assert.ok(ua.includes('Windows'), `UA must contain "Windows": ${ua}`);
      return `ua="${ua.slice(0, 60)}..."`;
    });

    await test('hardener.getPreloadArgs', async () => {
      const seed = getNoiseSeed({ profileId: 'p1', mode: 'normal', sessionStartTs: 1 });
      const argsList = getPreloadArgs({ mode: 'normal', profileId: 'p1', noiseSeed: seed, tabId: 42, sessionStartTs: 1 });
      assert.ok(Array.isArray(argsList), 'getPreloadArgs must return an array');
      assert.ok(argsList.length > 0, 'array must not be empty');
      for (const a of argsList) {
        assert.strictEqual(typeof a, 'string', `each arg must be a string, got: ${typeof a}`);
        assert.ok(a.startsWith('--'), `each arg must start with "--", got: ${a}`);
      }
      return `${argsList.length} args: ${argsList[0]}...`;
    });
  }

  // ------------------------------------------------------------------
  // 4. AuthFlowRouter
  // ------------------------------------------------------------------

  let AuthFlowRouter;
  try { AuthFlowRouter = require('../auth-flow-router'); } catch (e) {
    record(false, 'auth_router.load_module', e.message);
    AuthFlowRouter = null;
  }

  if (AuthFlowRouter) {
    const router = new AuthFlowRouter({});
    const RPID = 999;

    await test('auth_router.start', async () => {
      const { socketPath, env } = await router.start(RPID);
      assert.strictEqual(socketPath, `/tmp/norya-auth-${RPID}.sock`);
      assert.ok(env && env.BROWSER, 'env.BROWSER must be set');
      assert.strictEqual(env.NORYA_AUTH_SOCKET, socketPath);
      return `socket=${socketPath}`;
    });

    await test('auth_router.auth_url_event', async () => {
      const { socketPath } = await router.start(RPID);

      let receivedEvent = null;
      const eventPromise = new Promise((resolve) => {
        router.once('auth-url', (ev) => { receivedEvent = ev; resolve(); });
      });

      // Connect and send fake URL payload
      await new Promise((resolve, reject) => {
        const client = net.createConnection(socketPath, () => {
          client.write(JSON.stringify({ url: 'https://auth.example.com/oauth?code=abc', ts: Date.now() }));
          client.end();
        });
        client.on('close', resolve);
        client.on('error', reject);
      });

      await Promise.race([
        eventPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('auth-url event timed out')), 3000)),
      ]);

      assert.ok(receivedEvent, 'auth-url event must fire');
      assert.strictEqual(receivedEvent.profileId, RPID);
      assert.ok(receivedEvent.url.includes('oauth'), 'URL must contain "oauth"');
      return `profileId=${receivedEvent.profileId} url captured`;
    });

    await test('auth_router.stop_removes_socket', async () => {
      const sockPath = `/tmp/norya-auth-${RPID}.sock`;
      await router.stop(RPID);
      let exists = false;
      try { fs.accessSync(sockPath); exists = true; } catch { /* good — gone */ }
      assert.strictEqual(exists, false, 'socket file must be gone after stop()');
      return 'socket file removed';
    });
  }

  // ------------------------------------------------------------------
  // 6. ExtensionLoader.addExtension with synthetic manifest
  // ------------------------------------------------------------------

  let ExtensionLoader;
  try { ExtensionLoader = require('../extension-loader'); } catch (e) {
    record(false, 'ext_loader.load_module', e.message);
    ExtensionLoader = null;
  }

  if (ExtensionLoader) {
    const extAccountsDir = path.join(ACCOUNTS_DIR, 'ext-accounts');
    fs.mkdirSync(extAccountsDir, { recursive: true });

    const loader = new ExtensionLoader({ accountsDir: extAccountsDir });
    const EXT_PID = 'ext-smoke-p1';

    // Create a minimal synthetic extension in a temp dir
    const syntheticExtDir = path.join(os.tmpdir(), 'norya-smoke-ext-' + process.pid);
    fs.mkdirSync(syntheticExtDir, { recursive: true });
    fs.writeFileSync(path.join(syntheticExtDir, 'manifest.json'), JSON.stringify({
      manifest_version: 2,
      name: 'Smoke Test Extension',
      version: '1.0.0',
      description: 'Synthetic extension for smoke testing',
      background: { scripts: ['dummy.js'] },
    }), 'utf8');
    fs.writeFileSync(path.join(syntheticExtDir, 'dummy.js'), '// smoke test placeholder\n', 'utf8');

    registerCleanup(() => {
      try { fs.rmSync(syntheticExtDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(extAccountsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    await test('ext_loader.addExtension', async () => {
      const result = await loader.addExtension(EXT_PID, syntheticExtDir);
      assert.ok(result.id, 'result must have an id');
      assert.ok(result.path, 'result must have a path');
      assert.strictEqual(result.name, 'Smoke Test Extension');

      // Verify the files were copied to the expected destination
      const copiedManifest = path.join(result.path, 'manifest.json');
      assert.ok(fs.existsSync(copiedManifest), 'manifest.json must exist at dest');
      const copiedDummy = path.join(result.path, 'dummy.js');
      assert.ok(fs.existsSync(copiedDummy), 'dummy.js must exist at dest');

      // Verify meta file was updated
      const metaPath = path.join(extAccountsDir, EXT_PID, 'browser', 'extensions', '_meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      assert.ok(result.id in meta, 'extension id must appear in _meta.json');
      assert.strictEqual(meta[result.id].enabled, true, 'extension must be enabled by default');

      return `id=${result.id} name="${result.name}" files verified`;
    });

    await test('ext_loader.list', async () => {
      const list = await loader.list(EXT_PID);
      assert.ok(Array.isArray(list), 'list must return an array');
      assert.ok(list.length >= 1, 'list must contain at least one extension');
      const ext = list.find((e) => e.name === 'Smoke Test Extension');
      assert.ok(ext, 'Smoke Test Extension must appear in list');
      assert.strictEqual(ext.enabled, true, 'must be enabled');
      return `${list.length} extension(s) listed`;
    });
  }
}

// ---------------------------------------------------------------------------
// ============================================================
// MODE B: --running
// ============================================================
// ---------------------------------------------------------------------------

async function runLiveTests() {
  const profileId   = parseInt(process.env.NORYA_TEST_PROFILE || '1', 10);
  const socketPath  = `/tmp/norya-browser-${profileId}.sock`;
  const realIp      = process.env.REAL_IP || '';

  // Check socket exists
  await test('running.socket_exists', async () => {
    assert.ok(fs.existsSync(socketPath), `Socket ${socketPath} must exist. Is Norya running with profile ${profileId}?`);
    return `socket=${socketPath}`;
  });

  if (!fs.existsSync(socketPath)) {
    console.log('[ABORT] Cannot reach running Norya — socket missing. Remaining running.* tests skipped.');
    return;
  }

  // 1. browser_open + browser_get_text → IP address via Tor
  let openedTabId;
  await test('running.browser_open', async () => {
    const result = await rpcCall(socketPath, 'browser_open', { url: 'https://api.ipify.org' }, 15000);
    assert.ok(result, 'browser_open must return a result');
    openedTabId = result.tabId || result.id || null;
    return `tabId=${openedTabId}`;
  });

  await test('running.tor_exit_ip', async () => {
    // Poll up to 20 seconds for the page to load
    let bodyText;
    try {
      bodyText = await waitFor(async () => {
        try {
          const txt = await rpcCall(socketPath, 'browser_get_text', { selector: 'body' }, 5000);
          if (txt && /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(txt)) return txt;
        } catch { /* not ready yet */ }
        return null;
      }, 20000);
    } catch {
      throw new Error('body text did not resolve to an IP within 20s');
    }

    const ipMatch = bodyText.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    assert.ok(ipMatch, `body text "${bodyText}" does not contain an IP`);
    const exitIp = ipMatch[1];

    if (realIp) {
      assert.notStrictEqual(exitIp, realIp, `exit IP ${exitIp} must differ from real IP ${realIp}`);
    }
    return `exitIP=${exitIp}${realIp ? ` (differs from real ${realIp})` : ' (REAL_IP not set; anonymity check skipped)'}`;
  });

  // 2. browser_screenshot
  await test('running.screenshot', async () => {
    const result = await rpcCall(socketPath, 'browser_screenshot', {}, 10000);
    const filePath = (result && (result.path || result.file)) || null;
    assert.ok(filePath, 'browser_screenshot must return a file path');
    assert.ok(fs.existsSync(filePath), `screenshot file "${filePath}" must exist on disk`);
    const stat = fs.statSync(filePath);
    assert.ok(stat.size > 0, 'screenshot file must not be empty');
    return `path=${filePath} size=${stat.size}B`;
  });

  // 3. browser_evaluate — user-agent should not contain "electron"
  await test('running.ua_not_electron', async () => {
    const ua = await rpcCall(socketPath, 'browser_evaluate', { js: 'navigator.userAgent' }, 8000);
    assert.ok(typeof ua === 'string', 'UA must be a string');
    assert.ok(!ua.toLowerCase().includes('electron'), `UA must not contain "electron": ${ua}`);
    assert.ok(ua.includes('Chrome'), `UA must contain "Chrome": ${ua}`);
    return `ua="${ua.slice(0, 70)}..."`;
  });

  // 4. Canvas fingerprint hardening
  const canvasJs = '(()=>{const c=document.createElement("canvas");const ctx=c.getContext("2d");ctx.fillText("norya-smoke-test",0,20);return c.toDataURL();})()';

  let hash1, hash2;
  await test('running.canvas_stable_same_tab', async () => {
    const r1 = await rpcCall(socketPath, 'browser_evaluate', { js: canvasJs }, 8000);
    const r2 = await rpcCall(socketPath, 'browser_evaluate', { js: canvasJs }, 8000);
    assert.ok(typeof r1 === 'string' && r1.length > 0, 'canvas call 1 must return data');
    assert.ok(typeof r2 === 'string' && r2.length > 0, 'canvas call 2 must return data');
    assert.strictEqual(r1, r2, 'canvas output must be stable within same tab/session');
    hash1 = r1.slice(0, 40);
    return `stable hash prefix=${hash1}`;
  });

  // 5. browser_list_tabs
  await test('running.list_tabs', async () => {
    const tabs = await rpcCall(socketPath, 'browser_list_tabs', {}, 8000);
    assert.ok(Array.isArray(tabs), 'browser_list_tabs must return an array');
    assert.ok(tabs.length >= 1, 'at least 1 tab must be open');
    return `${tabs.length} tab(s) open`;
  });

  // 6. browser_close_tab
  await test('running.close_tab', async () => {
    // Close the tab we opened (or any tab if tabId is unknown)
    const params = openedTabId ? { tabId: openedTabId } : {};
    await rpcCall(socketPath, 'browser_close_tab', params, 8000);
    return openedTabId ? `closed tabId=${openedTabId}` : 'closed active tab';
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

(async () => {
  try {
    if (MODE_MODULE) {
      console.log('--- Mode A: Module tests ---\n');
      await runModuleTests();
    } else if (MODE_RUNNING) {
      console.log('--- Mode B: Live integration tests ---\n');
      await runLiveTests();
    }
  } catch (err) {
    console.error('\nUnexpected top-level error:', err.message || err);
    if (err.stack) console.error(err.stack);
    failed++;
  } finally {
    await runCleanups();
  }

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
