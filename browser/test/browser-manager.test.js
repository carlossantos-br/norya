'use strict';

/**
 * browser-manager.test.js — Node puro, sem Electron de verdade.
 *
 * O módulo `electron` é stubado via require.cache ANTES do require do manager,
 * então dá pra exercitar closePanel/clearData sem subir o app.
 *
 * O que este teste protege (2026-07-14): fechar o painel NÃO pode mais apagar
 * storage — cookies/logins persistem sempre; o wipe é só via clearData().
 *
 * Run:  node browser/test/browser-manager.test.js
 * Exits 0 on PASS; exits 1 on FAIL.
 */

const assert = require('assert');

// Stub de electron: registra chamadas a session.fromPartition/clearStorageData.
const calls = { fromPartition: [], cleared: [] };
const fakeSession = {
  fromPartition(p) {
    calls.fromPartition.push(p);
    return {
      clearStorageData(opts) { calls.cleared.push({ partition: p, opts }); return Promise.resolve(); },
      webRequest: {
        onBeforeRequest() {},
        onBeforeSendHeaders() {},
        onHeadersReceived() {},
      },
      setPermissionRequestHandler() {},
    };
  },
};
require.cache[require.resolve('electron')] = { exports: { session: fakeSession } };

const BrowserManager = require('../browser-manager');

let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log('PASS  ' + name); passed++; },
    (e) => { console.log('FAIL  ' + name + ' — ' + e.message); failed++; }
  );
}

(async () => {
  const bm = new BrowserManager({ mainWindow: {} });

  await check('closePanel NÃO limpa storage e emite panel-close', async () => {
    await bm.openPanel('7');
    let closed = null;
    bm.on('panel-close', (p) => { closed = p; });
    calls.cleared.length = 0;
    await bm.closePanel('7');
    assert.strictEqual(calls.cleared.length, 0, 'clearStorageData foi chamado no closePanel');
    assert.deepStrictEqual(closed, { profileId: '7' });
    assert.strictEqual(bm.isPanelOpen('7'), false);
  });

  await check('teardownSession também preserva storage', async () => {
    await bm.openPanel('7');
    calls.cleared.length = 0;
    await bm.teardownSession('7');
    assert.strictEqual(calls.cleared.length, 0, 'teardownSession apagou storage');
    assert.strictEqual(bm.isPanelOpen('7'), false);
  });

  await check('clearData limpa a partition certa, mesmo sem painel aberto', async () => {
    calls.cleared.length = 0;
    const r = await bm.clearData('9');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.partition, 'persist:browser-profile-9');
    assert.strictEqual(calls.cleared.length, 1);
    assert.strictEqual(calls.cleared[0].partition, 'persist:browser-profile-9');
    assert.ok(calls.cleared[0].opts.storages.includes('cookies'), 'cookies fora da lista');
    assert.ok(calls.cleared[0].opts.storages.includes('indexdb'), 'indexdb fora da lista');
  });

  console.log(`\n${failed ? 'FALHOU' : 'TUDO PASSOU'} (${passed} pass, ${failed} fail)`);
  process.exit(failed ? 1 : 0);
})();
