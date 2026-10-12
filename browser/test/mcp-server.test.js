'use strict';

/**
 * mcp-server.test.js
 *
 * Plain Node.js smoke test for MCPServer (no external test framework).
 * Run:  node app/browser/test/mcp-server.test.js
 *
 * Exits 0 on PASS; exits 1 on FAIL.
 */

const assert = require('assert');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MCPServer = require('../mcp-server');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function log(...args) {
  process.stdout.write(args.join(' ') + '\n');
}

function ok(label) {
  passed++;
  log(`  PASS  ${label}`);
}

function fail(label, err) {
  failed++;
  log(`  FAIL  ${label}: ${err && err.message ? err.message : err}`);
}

/**
 * Connect to the Unix socket, send one JSON-RPC request, and resolve with
 * the parsed response object.
 * @param {string} sockPath
 * @param {object} rpc  — must include jsonrpc, id, method, params
 * @returns {Promise<object>}
 */
function sendRpc(sockPath, rpc) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath, () => {
      client.write(JSON.stringify(rpc) + '\n');
      // Half-close after sending; server closes fully after responding.
      client.end();
    });
    let buf = '';
    client.on('data', (d) => { buf += d; });
    client.on('end', () => {
      try {
        const lines = buf.split('\n').filter(Boolean);
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (e) { reject(e); }
    });
    client.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Stub BrowserManager
// ---------------------------------------------------------------------------

const FAKE_TABS = [
  { tabId: 'tab-1', url: 'https://example.com', title: 'Example', active: true },
  { tabId: 'tab-2', url: 'https://norya.app', title: 'Norya', active: false },
];

const FAKE_STATE = {
  tabs: FAKE_TABS,
  activeTabId: 'tab-1',
};

const calls = [];   // record every method call for assertions

const stubBrowserManager = {
  async listTabs(profileId) {
    calls.push({ method: 'listTabs', profileId });
    return FAKE_STATE;
  },
  async openTab(profileId, url, opts) {
    calls.push({ method: 'openTab', profileId, url, opts });
    return { tabId: 'tab-new' };
  },
  async closeTab(profileId, tabId) {
    calls.push({ method: 'closeTab', profileId, tabId });
    return { closed: tabId };
  },
  async finishAgent(profileId) {
    calls.push({ method: 'finishAgent', profileId });
    return { closed: 2 };
  },
  async navigateTab(profileId, tabId, action, extra) {
    calls.push({ method: 'navigateTab', profileId, tabId, action, extra });
    return { action, tabId, ok: true };
  },
  // Additional methods referenced but not deeply tested here
  async getTab(profileId, tabId) {
    return FAKE_TABS.find(t => t.tabId === tabId) || null;
  },
  async setActiveTab(profileId, tabId) {
    return { activeTabId: tabId };
  },
  async getState(profileId) {
    return FAKE_STATE;
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const PROFILE_ID = 999;
const SOCK_PATH = path.join(os.tmpdir(), `norya-browser-${PROFILE_ID}.sock`);

async function runTests() {
  log('\n=== MCPServer smoke test ===\n');

  // ---- 1. Construction --------------------------------------------------- //
  let server;
  try {
    server = new MCPServer({ browserManager: stubBrowserManager });
    ok('MCPServer constructs without error');
  } catch (e) {
    fail('MCPServer constructs without error', e);
    process.exit(1);
  }

  // ---- 2. Start ---------------------------------------------------------- //
  let startResult;
  try {
    startResult = await server.start(PROFILE_ID);
    assert.strictEqual(startResult.socketPath, SOCK_PATH, 'socketPath matches expected');
    assert.strictEqual(startResult.env.NORYA_BROWSER_MCP_SOCKET, SOCK_PATH);
    assert.strictEqual(startResult.env.NORYA_PROFILE_ID, String(PROFILE_ID));
    assert.ok(fs.existsSync(SOCK_PATH), 'socket file exists after start');
    ok('server.start() creates socket file and returns correct env');
  } catch (e) {
    fail('server.start() creates socket file and returns correct env', e);
    process.exit(1);
  }

  // ---- 3. browser_list_tabs ---------------------------------------------- //
  try {
    calls.length = 0;
    const resp = await sendRpc(SOCK_PATH, {
      jsonrpc: '2.0', id: 1, method: 'browser_list_tabs', params: {},
    });
    assert.strictEqual(resp.jsonrpc, '2.0', 'jsonrpc version');
    assert.strictEqual(resp.id, 1, 'id echoed');
    assert.ok(!resp.error, 'no error: ' + JSON.stringify(resp.error));
    assert.deepStrictEqual(resp.result, FAKE_STATE, 'result matches stub');
    assert.strictEqual(calls.length, 1, 'listTabs called once');
    assert.strictEqual(calls[0].method, 'listTabs');
    ok('browser_list_tabs returns stub data');
  } catch (e) {
    fail('browser_list_tabs returns stub data', e);
  }

  // ---- 4. browser_open (new tab) ----------------------------------------- //
  try {
    calls.length = 0;
    const resp = await sendRpc(SOCK_PATH, {
      jsonrpc: '2.0', id: 2, method: 'browser_open',
      params: { url: 'https://test.example', new_tab: true },
    });
    assert.ok(!resp.error, 'no error');
    assert.deepStrictEqual(resp.result, { tabId: 'tab-new' });
    assert.strictEqual(calls[0].method, 'openTab');
    assert.strictEqual(calls[0].url, 'https://test.example');
    assert.strictEqual(calls[0].opts.tor, 'auto');
    assert.ok(calls[0].opts.agentControlled === true);
    ok('browser_open opens new tab via openTab');
  } catch (e) {
    fail('browser_open opens new tab via openTab', e);
  }

  // ---- 5. browser_open (reuse active tab) --------------------------------- //
  try {
    calls.length = 0;
    const resp = await sendRpc(SOCK_PATH, {
      jsonrpc: '2.0', id: 3, method: 'browser_open',
      params: { url: 'https://reuse.example', new_tab: false },
    });
    assert.ok(!resp.error, 'no error');
    // Should call navigateTab on active tab with action='open'
    const navCall = calls.find(c => c.method === 'navigateTab');
    assert.ok(navCall, 'navigateTab called');
    assert.strictEqual(navCall.action, 'open');
    assert.strictEqual(navCall.extra.url, 'https://reuse.example');
    ok('browser_open reuses active tab when new_tab=false');
  } catch (e) {
    fail('browser_open reuses active tab when new_tab=false', e);
  }

  // ---- 6. browser_screenshot --------------------------------------------- //
  try {
    calls.length = 0;
    const resp = await sendRpc(SOCK_PATH, {
      jsonrpc: '2.0', id: 4, method: 'browser_screenshot',
      params: { full_page: true, format: 'png' },
    });
    assert.ok(!resp.error, 'no error: ' + JSON.stringify(resp.error));
    const navCall = calls.find(c => c.method === 'navigateTab');
    assert.ok(navCall);
    assert.strictEqual(navCall.action, 'screenshot');
    assert.strictEqual(navCall.extra.full_page, true);
    assert.strictEqual(navCall.extra.format, 'png');
    ok('browser_screenshot dispatches navigateTab with screenshot action');
  } catch (e) {
    fail('browser_screenshot dispatches navigateTab with screenshot action', e);
  }

  // ---- 7. browser_close_tab ---------------------------------------------- //
  try {
    calls.length = 0;
    const resp = await sendRpc(SOCK_PATH, {
      jsonrpc: '2.0', id: 5, method: 'browser_close_tab',
      params: { tab_id: 'tab-2' },
    });
    assert.ok(!resp.error, 'no error');
    assert.deepStrictEqual(resp.result, { closed: 'tab-2' });
    assert.strictEqual(calls[0].method, 'closeTab');
    assert.strictEqual(calls[0].tabId, 'tab-2');
    ok('browser_close_tab calls closeTab with correct tabId');
  } catch (e) {
    fail('browser_close_tab calls closeTab with correct tabId', e);
  }

  // ---- 7b. browser_finish -------------------------------------------------- //
  try {
    calls.length = 0;
    const resp = await sendRpc(SOCK_PATH, {
      jsonrpc: '2.0', id: 51, method: 'browser_finish', params: {},
    });
    assert.ok(!resp.error, 'no error: ' + JSON.stringify(resp.error));
    assert.deepStrictEqual(resp.result, { closed: 2 });
    assert.strictEqual(calls.length, 1, 'finishAgent called once');
    assert.strictEqual(calls[0].method, 'finishAgent');
    assert.strictEqual(calls[0].profileId, String(PROFILE_ID));
    // Não resolve aba nenhuma antes: finish não pode explodir com zero abas.
    assert.ok(!calls.find(c => c.method === 'listTabs'), 'finish does not resolve a tab first');
    ok('browser_finish closes the agent tabs via finishAgent');
  } catch (e) {
    fail('browser_finish closes the agent tabs via finishAgent', e);
  }

  // ---- 8. browser_navigate ----------------------------------------------- //
  try {
    calls.length = 0;
    const resp = await sendRpc(SOCK_PATH, {
      jsonrpc: '2.0', id: 6, method: 'browser_navigate',
      params: { action: 'reload' },
    });
    assert.ok(!resp.error, 'no error');
    const navCall = calls.find(c => c.method === 'navigateTab');
    assert.ok(navCall);
    assert.strictEqual(navCall.action, 'reload');
    ok('browser_navigate dispatches reload');
  } catch (e) {
    fail('browser_navigate dispatches reload', e);
  }

  // ---- 9. Unknown method returns error ------------------------------------ //
  try {
    calls.length = 0;
    const resp = await sendRpc(SOCK_PATH, {
      jsonrpc: '2.0', id: 7, method: 'browser_does_not_exist', params: {},
    });
    assert.ok(resp.error, 'error present');
    assert.ok(resp.error.message.includes('browser_does_not_exist'), 'error mentions method name');
    ok('unknown method returns JSON-RPC error');
  } catch (e) {
    fail('unknown method returns JSON-RPC error', e);
  }

  // ---- 10. Validate that missing required param triggers error ------------ //
  try {
    calls.length = 0;
    const resp = await sendRpc(SOCK_PATH, {
      jsonrpc: '2.0', id: 8, method: 'browser_open', params: {},
    });
    assert.ok(resp.error, 'error present for missing url');
    ok('browser_open without url returns error');
  } catch (e) {
    fail('browser_open without url returns error', e);
  }

  // ---- 11. Stop ----------------------------------------------------------- //
  try {
    await server.stop(PROFILE_ID);
    assert.ok(!fs.existsSync(SOCK_PATH), 'socket file removed after stop');
    ok('server.stop() removes socket file');
  } catch (e) {
    fail('server.stop() removes socket file', e);
  }

  // ---- Summary ------------------------------------------------------------ //
  log(`\n${'─'.repeat(50)}`);
  log(`Results: ${passed} passed, ${failed} failed`);
  log('');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Unexpected error in test runner:', e);
  process.exit(1);
});
