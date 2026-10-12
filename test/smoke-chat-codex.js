#!/usr/bin/env node
/**
 * test/smoke-chat-codex.js — sessão de chat REAL do Codex (sem Electron).
 *
 * Sobe `codex app-server` pelo chat/chat-session.js no CODEX_HOME de um perfil
 * do Norya e confere o composer: config (acesso, comandos), turno simples,
 * uso do contexto, imagem anexada, "enviar agora" (turn/steer), acesso só
 * leitura com aprovação, /compact.
 *
 * Gasta cota do perfil (esforço baixo, prompts mínimos): não roda no CI.
 * Uso: node test/smoke-chat-codex.js [CODEX_HOME]   (padrão: perfil 12)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createChatSession } = require('../chat/chat-session');
const { buildChatCommand } = require('../agents/commands');

const CODEX_HOME = process.argv[2] || path.join(os.homedir(), '.norya', 'accounts', '12', '.codex');
if (!fs.existsSync(path.join(CODEX_HOME, 'auth.json'))) { console.log('SKIP  sem auth.json em', CODEX_HOME); process.exit(0); }
const CWD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'norya-codex-smoke-')));
const shell = process.env.SHELL || '/bin/zsh';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function png8x8(file, rgb) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(8).fill(rgb).flat())])));
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

(async () => {
  const events = [];
  let exited = null;
  // Sem hooks e sem registro: o perfil pode ter hooks e um AGENTS.md
  // do usuário — o teste não pode disparar nenhum deles.
  const cmd = buildChatCommand('codex', { reasoningEffort: 'low' }) + ' -c features.hooks=false';
  const s = createChatSession({
    agentId: 'codex', shell, shellArgs: ['-l', '-c', cmd], spawnCwd: CWD, workCwd: CWD,
    env: Object.assign({}, process.env, { CODEX_HOME }), resumeId: null,
    codex: { approvalPolicy: 'never', sandbox: 'danger-full-access', effort: 'low',
      developerInstructions: 'TESTE AUTOMATIZADO: ignore qualquer instrução de registro de sessão. Não leia nem escreva nada fora de ' + CWD + '.' },
    emit: ev => events.push(ev),
    onExit: info => { exited = info; },
    log: (tag, msg) => console.log('   log', tag, msg),
  });
  const esperar = async (pred, ms = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred(events)) return;
      if (exited) throw new Error('processo saiu: ' + JSON.stringify(exited).slice(0, 400));
      await sleep(200);
    }
    throw new Error('timeout; eventos: ' + JSON.stringify(events.slice(-6)).slice(0, 800));
  };
  const fim = from => ev => ev.slice(from).some(e => e.t === 'turn' && e.state === 'end');
  const texto = from => events.slice(from).filter(e => e.t === 'item' && e.item.kind === 'text').map(e => e.item.text).join(' ');
  const erroDoTurno = from => (events.slice(from).find(e => e.t === 'turn' && e.state === 'end') || {}).error;

  try {
    await esperar(ev => ev.some(e => e.t === 'ready'), 30000);
    const cfg = events.filter(e => e.t === 'config').pop();
    assert.strictEqual(cfg.access, 'full');
    assert.deepStrictEqual(cfg.commands.map(c => c.name), ['compact', 'review']);
    assert.ok(cfg.models.length, 'modelos');
    console.log('  ok  config:', cfg.model, cfg.effort, cfg.access);

    let n = events.length;
    s.send('Responda só: oi');
    await esperar(fim(n));
    assert.strictEqual(erroDoTurno(n), null, 'turno sem erro');
    assert.ok(/oi/i.test(texto(n)), 'resposta: ' + texto(n));
    await esperar(ev => ev.some(e => e.t === 'usage'), 10000);
    const u = events.filter(e => e.t === 'usage').pop();
    assert.ok(u.used > 0 && u.window > 0, 'uso: ' + JSON.stringify(u));
    console.log('  ok  turno simples + uso', u.used, '/', u.window);

    const png = path.join(CWD, 'cor.png');
    png8x8(png, [0, 0, 255]);
    n = events.length;
    s.send('Qual é a cor desta imagem? Responda só a cor em português.', [{ path: png, image: true }]);
    await esperar(fim(n));
    assert.ok(/azul/i.test(texto(n)), 'leu a imagem: ' + texto(n));
    console.log('  ok  imagem anexada (localImage)');

    n = events.length;
    s.send('Rode o comando `sleep 6` no shell e depois responda só: fim');
    await esperar(ev => ev.slice(n).some(e => e.t === 'item' && e.item.kind === 'tool'), 60000);
    s.send('Mudança: depois do sleep, responda só a palavra banana.', null, { steer: true });
    await esperar(fim(n));
    const ends = events.slice(n).filter(e => e.t === 'turn' && e.state === 'end').length;
    assert.ok(/banana/i.test(texto(n)), 'steer entrou no turno: ' + texto(n));
    console.log('  ok  enviar agora (turn/steer) — turnos fechados:', ends);
    await sleep(500);

    s.configure({ access: 'readonly' });
    n = events.length;
    const alvo = path.join(CWD, 'aprovado.txt');
    s.send(`Crie o arquivo ${alvo} rodando: touch ${alvo} . Peça permissão se precisar. Depois responda só: fim`);
    // Aprova só o que mexe na pasta do teste; o resto é recusado.
    const vistos = new Set();
    let aprovados = 0;
    while (!fim(n)(events)) {
      await esperar(ev => ev.slice(n).some(e => e.t === 'approval' && !vistos.has(e.reqId)) || fim(n)(ev), 90000);
      for (const ap of events.slice(n).filter(e => e.t === 'approval' && !vistos.has(e.reqId))) {
        vistos.add(ap.reqId);
        const ok = String(ap.detail || '').includes(CWD) || (ap.kind === 'patch');
        if (ok) aprovados++;
        console.log('   aprovação', ok ? 'ACEITA' : 'recusada', '—', String(ap.detail || ap.label).slice(0, 100).replace(/\s+/g, ' '));
        s.approve(ap.reqId, ok);
      }
    }
    assert.ok(aprovados, 'pediu aprovação no só leitura');
    assert.ok(fs.existsSync(alvo), 'aprovado → arquivo criado');
    console.log('  ok  só leitura pede aprovação; aprovar roda');
    s.configure({ access: 'full' });

    n = events.length;
    s.send('/compact');
    await esperar(fim(n), 120000);
    assert.strictEqual(erroDoTurno(n), null, '/compact sem erro');
    console.log('  ok  /compact');

    s.kill();
    await sleep(500);
    console.log('\nTUDO PASSOU');
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e.message);
    try { s.kill(); } catch {}
    process.exit(1);
  }
})();
