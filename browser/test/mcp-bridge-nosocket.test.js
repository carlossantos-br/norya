'use strict';

/**
 * mcp-bridge-nosocket.test.js — fora do Norya (sem env), o bridge MCP deve
 * responder o handshake com zero tools e ficar vivo, em vez de exit(1).
 *
 * Por quê: desde 2026-07-14 ele é registrado user-scope no Claude Code, então
 * também sobe em sessões FORA do Norya — morrer no boot viraria um erro de MCP
 * visível em toda sessão. Dentro do Norya (com socket no env), nada muda.
 *
 * Run:  node browser/test/mcp-bridge-nosocket.test.js
 * Exits 0 on PASS; exits 1 on FAIL.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const BRIDGE = path.join(__dirname, '..', '..', 'bin', 'norya-browser-mcp.js');

function rpc(child, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout esperando resposta')), 4000);
    const onData = (buf) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === msg.id) { clearTimeout(t); child.stdout.off('data', onData); return resolve(m); }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
}

(async () => {
  const env = { ...process.env };
  delete env.NORYA_BROWSER_MCP_SOCKET;
  const child = spawn(process.execPath, [BRIDGE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let died = false;
  child.on('exit', () => { died = true; });

  let failed = 0;
  try {
    const init = await rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.strictEqual(init.result.serverInfo.name, 'norya-browser');
    console.log('PASS  initialize responde sem socket');

    const list = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepStrictEqual(list.result.tools, []);
    console.log('PASS  tools/list devolve [] fora do Norya');

    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(died, false, 'processo morreu');
    console.log('PASS  processo segue vivo');
  } catch (e) {
    console.log('FAIL  ' + e.message);
    failed = 1;
  } finally {
    child.kill();
  }

  // Dentro do Norya (env presente, mesmo que o socket não exista ainda) as
  // 13 tools continuam anunciadas — o erro só aparece na CHAMADA, como antes.
  const child2 = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, NORYA_BROWSER_MCP_SOCKET: '/tmp/nao-existe.sock' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const list2 = await rpc(child2, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    assert.ok(list2.result.tools.length >= 10, 'tools sumiram com socket no env');
    console.log(`PASS  com env, tools/list anuncia ${list2.result.tools.length} tools`);
  } catch (e) {
    console.log('FAIL  ' + e.message);
    failed = 1;
  } finally {
    child2.kill();
  }

  console.log('\n' + (failed ? 'FALHOU' : 'TUDO PASSOU'));
  process.exit(failed);
})();
