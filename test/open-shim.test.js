#!/usr/bin/env node
/**
 * Unitário do bin/open-shim/open.
 *
 * O shim substitui o `open` do macOS dentro dos PTYs do Norya. Ele precisa:
 *   1. mandar http(s) para o socket do Norya;
 *   2. dar precedência ao socket de AUTH quando ele existe (login flow);
 *   3. deixar passar tudo que não é URL (`open .`, `open -a App arquivo`);
 *   4. NUNCA engolir uma URL — sem socket, ou com socket morto, cai no
 *      navegador do sistema.
 *
 * `NORYA_REAL_OPEN` troca o /usr/bin/open por um espião, para o passthrough ser
 * observável sem abrir o Finder.
 *
 * Sem Electron. Uso: node test/open-shim.test.js
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SHIM = path.join(__dirname, '..', 'bin', 'open-shim', 'open');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-shim-'));
const ESPIAO = path.join(TMP, 'fake-open');           // grava os argv num arquivo
const ESPIAO_LOG = path.join(TMP, 'fake-open.log');

fs.writeFileSync(ESPIAO, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${ESPIAO_LOG}\n`, { mode: 0o755 });

/** Sobe um servidor unix-socket que resolve com a primeira mensagem recebida. */
function servidor(sockPath) {
  const recebidas = [];
  const srv = net.createServer(conn => {
    let buf = '';
    conn.on('data', d => (buf += d));
    conn.on('end', () => { try { recebidas.push(JSON.parse(buf)); } catch { /* lixo */ } });
  });
  srv.listen(sockPath);
  return { srv, recebidas, fechar: () => new Promise(r => srv.close(r)) };
}

/**
 * ASSÍNCRONO de propósito. `execFileSync` bloqueia o event loop deste processo,
 * o servidor de socket abaixo congela junto, e o shim — que tem timeout de 2s —
 * cai no fallback. O teste então via a URL chegar no socket E no open do
 * sistema, e acusava o shim de um bug que era do teste.
 */
function rodarShim(args, env = {}) {
  // Rodando dentro de um pane do Norya, o ambiente já traz os sockets reais;
  // sem limpar, o caso "sem socket" mandaria a URL para o Norya de verdade.
  const base = { ...process.env };
  delete base.NORYA_OPEN_SOCKET;
  delete base.NORYA_AUTH_SOCKET;
  return new Promise(resolve => {
    execFile(SHIM, args, {
      env: { ...base, NORYA_REAL_OPEN: ESPIAO, ...env },
      timeout: 8000,
    }, (err) => resolve(err ? (err.code ?? -1) : 0));
  });
}

const espiao = () => { try { return fs.readFileSync(ESPIAO_LOG, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const limparEspiao = () => { try { fs.unlinkSync(ESPIAO_LOG); } catch {} };
const esperar = ms => new Promise(r => setTimeout(r, ms));

let passou = 0;
const ok = (nome) => { console.log(`PASS  ${nome}`); passou++; };

(async () => {
  // ── 1. URL http vai para o socket do Norya, e o sistema NÃO é chamado ─────
  {
    const sock = path.join(TMP, 'open1.sock');
    const s = servidor(sock);
    await esperar(120);
    limparEspiao();
    await rodarShim(['https://example.com/foo?a=1'], { NORYA_OPEN_SOCKET: sock });
    await esperar(300);
    assert.strictEqual(s.recebidas.length, 1, 'socket deveria receber 1 mensagem');
    assert.strictEqual(s.recebidas[0].url, 'https://example.com/foo?a=1');
    assert.deepStrictEqual(espiao(), [], 'o open do sistema NÃO deveria ser chamado');
    await s.fechar();
    ok('URL http vai para o socket, sem tocar no navegador do sistema');
  }

  // ── 2. Socket de AUTH tem precedência sobre o de auto-open ────────────────
  {
    const sockAuth = path.join(TMP, 'auth.sock');
    const sockOpen = path.join(TMP, 'open2.sock');
    const a = servidor(sockAuth), o = servidor(sockOpen);
    await esperar(120);
    await rodarShim(['https://auth.openai.com/x'], { NORYA_AUTH_SOCKET: sockAuth, NORYA_OPEN_SOCKET: sockOpen });
    await esperar(300);
    assert.strictEqual(a.recebidas.length, 1, 'auth deveria receber');
    assert.strictEqual(o.recebidas.length, 0, 'auto-open NÃO deveria receber');
    await a.fechar(); await o.fechar();
    ok('socket de auth tem precedência (fluxo de login preservado)');
  }

  // ── 3. Passthrough: argumento que não é URL ───────────────────────────────
  {
    const sock = path.join(TMP, 'open3.sock');
    const s = servidor(sock);
    await esperar(120);
    limparEspiao();
    await rodarShim(['-a', 'Preview', '/tmp/arquivo.pdf'], { NORYA_OPEN_SOCKET: sock });
    await esperar(200);
    assert.strictEqual(s.recebidas.length, 0, 'socket não deveria receber nada');
    assert.deepStrictEqual(espiao(), ['-a', 'Preview', '/tmp/arquivo.pdf'], 'argv deveria passar intacto');
    await s.fechar();
    ok('`open -a Preview arquivo.pdf` passa direto, com argv intacto');
  }

  // ── 4. Sem socket nenhum: cai no navegador do sistema ─────────────────────
  {
    limparEspiao();
    await rodarShim(['https://example.com']);
    await esperar(200);
    assert.deepStrictEqual(espiao(), ['https://example.com'], 'deveria cair no open real');
    ok('sem socket, a URL cai no navegador do sistema (não é engolida)');
  }

  // ── 5. Socket configurado mas MORTO: também cai no sistema ────────────────
  {
    limparEspiao();
    await rodarShim(['https://example.com/z'], { NORYA_OPEN_SOCKET: path.join(TMP, 'nao-existe.sock') });
    await esperar(2600);   // o shim tem timeout interno de 2s
    assert.deepStrictEqual(espiao(), ['https://example.com/z'], 'deveria cair no open real');
    ok('socket morto → fallback para o sistema (URL nunca some)');
  }

  // ── 6. `open .` (caso mais comum de passthrough) ──────────────────────────
  {
    const sock = path.join(TMP, 'open6.sock');
    const s = servidor(sock);
    await esperar(120);
    limparEspiao();
    await rodarShim(['.'], { NORYA_OPEN_SOCKET: sock });
    await esperar(200);
    assert.strictEqual(s.recebidas.length, 0);
    assert.deepStrictEqual(espiao(), ['.']);
    await s.fechar();
    ok('`open .` passa direto');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nTUDO PASSOU (${passou}/6)`);
})().catch(err => {
  console.error('FAIL ', err.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
