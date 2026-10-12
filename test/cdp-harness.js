/**
 * Infraestrutura comum dos testes de caracterização do Norya.
 *
 * Sobe o app a partir do fonte, anexa no renderer via Chrome DevTools Protocol,
 * entrega um `evaluate()` e garante que nada fica para trás.
 *
 * Armadilha que motivou este arquivo: `node_modules/.bin/electron` é um wrapper
 * Node que spawna o binário real como filho. Matar o wrapper órfana o Electron,
 * que no macOS nunca sai sozinho (main.js só chama app.quit() fora do darwin).
 * Por isso: binário real via require('electron'), spawn detached, kill no grupo.
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON = require('electron');
const DEFAULT_PORT = Number(process.env.NORYA_SMOKE_PORT || 9222);
const BOOT_TIMEOUT_MS = 45000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function portIsFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function strayElectrons() {
  // execFileSync (sem shell): APP_DIR vem de __dirname e pode conter espaços.
  // pgrep sai com 1 quando não há match, o que lança — daí o catch.
  try {
    const out = execFileSync('pgrep', ['-f', path.join(APP_DIR, 'node_modules', 'electron')], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch { return []; }
}

/** Duas instâncias do Norya disputam os arquivos de estado em ~/.norya/. */
async function preflight(port) {
  const strays = strayElectrons();
  if (strays.length) {
    throw new Error(
      `${strays.length} processo(s) Electron deste app já rodando (PIDs ${strays.join(', ')}). ` +
      `Feche o Norya, ou: pkill -9 -f "${path.join(APP_DIR, 'node_modules', 'electron')}"`
    );
  }
  if (!(await portIsFree(port))) {
    throw new Error(`porta ${port} ocupada. Use NORYA_SMOKE_PORT=<outra> ou libere a porta.`);
  }
}

function listTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list' }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForRenderer(port, deadline) {
  let lastErr = 'nenhum target';
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const page = targets.find(t => t.type === 'page' && /test-window\.html/.test(t.url || ''));
      if (page && page.webSocketDebuggerUrl) return page;
      lastErr = `${targets.length} target(s), nenhum é test-window.html`;
    } catch (e) { lastErr = e.message; }
    await sleep(500);
  }
  throw new Error(`renderer não apareceu em ${BOOT_TIMEOUT_MS}ms (${lastErr})`);
}

function attach(ws) {
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push(d.exception?.description || d.text || 'exceção sem descrição');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
    }
  });

  const send = (method, params = {}) => new Promise(resolve => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  /** Avalia no renderer. `timeoutMs` cobre promessas que nunca resolvem. */
  const evaluate = async (expression, { timeoutMs = 30000 } = {}) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) throw new Error(`evaluate excedeu ${timeoutMs}ms`);
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error(`evaluate lançou: ${d.exception?.description || d.text}`);
    }
    return r.result?.result?.value;
  };

  return { send, evaluate, exceptions, consoleErrors };
}

function killGroup(proc) {
  if (!proc || proc.pid == null) return;
  try { process.kill(-proc.pid, 'SIGKILL'); }
  catch { try { proc.kill('SIGKILL'); } catch {} }
}

/**
 * Sobe o app, entrega o client CDP para `fn`, e limpa tudo depois.
 * @param {(client) => Promise<void>} fn
 * @returns {Promise<{exceptions: string[], consoleErrors: string[], leaked: string[]}>}
 */
async function withApp(fn, { port = DEFAULT_PORT, settleMs = 4000 } = {}) {
  await preflight(port);

  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: APP_DIR, stdio: 'ignore', detached: true,
    env: { ...process.env, NORYA_SMOKE: '1' },
  });

  const cleanup = () => killGroup(proc);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  let ws = null;
  let client = { exceptions: [], consoleErrors: [] };
  try {
    const page = await waitForRenderer(port, Date.now() + BOOT_TIMEOUT_MS);
    ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
      setTimeout(() => rej(new Error('websocket do CDP não abriu em 10s')), 10000);
    });
    client = attach(ws);
    await client.send('Runtime.enable');
    await sleep(settleMs);
    await fn(client);
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    cleanup();
    await sleep(500);
  }

  return { exceptions: client.exceptions, consoleErrors: client.consoleErrors, leaked: strayElectrons() };
}

module.exports = { withApp, strayElectrons, APP_DIR, sleep };
