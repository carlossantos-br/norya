#!/usr/bin/env node
/**
 * test/smoke-chat-session.js — sessão de chat REAL do Claude (sem Electron).
 *
 * Sobe `claude -p` em stream-json pelo chat/chat-session.js, manda uma
 * mensagem, confere sessão → turno → tool → texto → fim; interrompe um turno
 * longo; depois retoma a sessão e confere que o histórico volta.
 *
 * Gasta pouco (modelo haiku, prompts mínimos) mas gasta: não roda no CI.
 * Uso: node test/smoke-chat-session.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatSession } = require('../chat/chat-session');
const { buildChatCommand } = require('../agents/commands');
const { claudeHistoryEvents } = require('../chat/chat-protocol');

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-chat-smoke-'));
const shell = process.env.SHELL || '/bin/zsh';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function abrir(opts) {
  const events = [];
  let exited = null;
  const cmd = buildChatCommand('claude', Object.assign({ model: 'haiku' }, opts));
  const s = createChatSession({
    agentId: 'claude', shell, shellArgs: ['-l', '-c', cmd], spawnCwd: CWD, workCwd: CWD,
    env: Object.assign({}, process.env), resumeId: opts.mode === 'resume' ? opts.sessionId : null,
    loadClaudeHistory: sid => {
      const dir = path.join(os.homedir(), '.claude', 'projects');
      for (const d of fs.readdirSync(dir)) {
        const f = path.join(dir, d, sid + '.jsonl');
        if (fs.existsSync(f)) return claudeHistoryEvents(fs.readFileSync(f, 'utf8').split('\n'));
      }
      return [];
    },
    emit: ev => events.push(ev),
    onExit: info => { exited = info; },
  });
  const esperar = async (pred, ms = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred(events)) return;
      if (exited) throw new Error('processo saiu: ' + JSON.stringify(exited).slice(0, 400));
      await sleep(200);
    }
    throw new Error('timeout; eventos: ' + JSON.stringify(events.slice(-6)).slice(0, 600));
  };
  return { s, events, esperar, get exited() { return exited; } };
}

(async () => {
  // 1) turno simples com tool
  const a = abrir({});
  a.s.send('Rode o comando bash `echo norya-ok` e depois responda só: pronto');
  await a.esperar(ev => ev.some(e => e.t === 'turn' && e.state === 'end'));
  const sess = a.events.find(e => e.t === 'session');
  assert.ok(sess && sess.sessionId, 'sessão');
  const tool = a.events.filter(e => e.t === 'item' && e.item.kind === 'tool').pop();
  assert.ok(tool && /echo norya-ok/.test(tool.item.label) && tool.item.status === 'done', 'tool Bash concluída');
  const end = a.events.find(e => e.t === 'turn' && e.state === 'end');
  assert.strictEqual(end.error, null);
  console.log('  ok  turno com tool, sessão', sess.sessionId);

  // 1b) composer: seletor de acesso, uso do contexto, anexos
  const cfg = a.events.filter(e => e.t === 'config').pop();
  assert.strictEqual(cfg.access, 'bypassPermissions', 'sobe em acesso total');
  assert.ok(cfg.accessOptions.some(o => o.value === 'default'), 'opções de acesso do claude');
  assert.ok(cfg.commands.some(c => c.name === 'compact'), 'comandos do initialize (/compact)');
  const usage = a.events.filter(e => e.t === 'usage').pop();
  assert.ok(usage && usage.used > 1000 && usage.window >= 100000, 'uso do contexto: ' + JSON.stringify(usage));
  console.log('  ok  config com acesso/comandos e uso', usage.used, '/', usage.window);

  const turnoFim = from => ev => ev.slice(from).some(e => e.t === 'turn' && e.state === 'end');
  a.s.configure({ access: 'default' });
  await a.esperar(ev => ev.some(e => e.t === 'config' && e.access === 'default'), 10000);
  for (const [nome, ok] of [['aprovado.txt', true], ['recusado.txt', false]]) {
    const n = a.events.length;
    a.s.send(`Use a ferramenta Bash para rodar exatamente: touch ${path.join(CWD, nome)} . Se for recusado, não tente de novo; responda só: fim`);
    await a.esperar(ev => ev.slice(n).some(e => e.t === 'approval'));
    const ap = a.events.slice(n).find(e => e.t === 'approval');
    assert.ok(/touch/.test(ap.detail), 'cartão mostra o comando');
    a.s.approve(ap.reqId, ok);
    await a.esperar(turnoFim(n));
    assert.strictEqual(fs.existsSync(path.join(CWD, nome)), ok, nome);
  }
  console.log('  ok  acesso "pedir aprovação": aprovar roda, recusar não roda');
  a.s.configure({ access: 'bypassPermissions' });
  await a.esperar(ev => ev.filter(e => e.t === 'config').pop().access === 'bypassPermissions', 10000);

  // Imagem 8×8 vermelha + arquivo de texto anexados.
  const zlib = require('zlib');
  const crc = b => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (tipo, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(tipo), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(8).fill([255, 0, 0]).flat())])));
  const png = path.join(CWD, 'cor.png');
  fs.writeFileSync(png, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  let n = a.events.length;
  a.s.send('Qual é a cor desta imagem? Responda só a cor em português.', [{ path: png, image: true }]);
  await a.esperar(turnoFim(n));
  let resp = a.events.slice(n).filter(e => e.t === 'delta' && e.kind === 'text').map(e => e.text).join('');
  assert.ok(/vermelh/i.test(resp), 'leu a imagem: ' + resp);
  const nota = path.join(CWD, 'nota.txt');
  fs.writeFileSync(nota, 'a palavra secreta é girassol\n');
  n = a.events.length;
  a.s.send('Qual é a palavra secreta do arquivo anexado? Responda só a palavra.', [{ path: nota, image: false }]);
  await a.esperar(turnoFim(n));
  resp = a.events.slice(n).filter(e => e.t === 'delta' && e.kind === 'text').map(e => e.text).join('');
  assert.ok(/girassol/i.test(resp), 'leu o arquivo anexado: ' + resp);
  console.log('  ok  anexos: imagem e arquivo');

  // 2) interromper turno longo
  const n0 = a.events.length;
  a.s.send('Rode o comando bash `sleep 30` e depois diga fim.');
  await a.esperar(ev => ev.slice(n0).some(e => e.t === 'item' && e.item.kind === 'tool'));
  a.s.interrupt();
  await a.esperar(ev => ev.slice(n0).some(e => e.t === 'turn' && e.state === 'end'), 20000);
  console.log('  ok  interrupção encerra o turno');
  a.s.kill();
  await sleep(800);
  assert.ok(a.exited, 'kill encerra o processo');

  // 3) retomar: histórico volta antes de qualquer envio
  const b = abrir({ mode: 'resume', sessionId: sess.sessionId });
  await b.esperar(ev => ev.some(e => e.t === 'ready'), 15000);
  const hist = b.events.find(e => e.t === 'history');
  assert.ok(hist && hist.events.some(e => e.t === 'item' && e.item.kind === 'user' && /norya-ok/.test(e.item.text)), 'histórico tem o 1º prompt');
  b.s.send('Qual palavra o echo imprimiu? Responda só a palavra.');
  await b.esperar(ev => ev.some(e => e.t === 'turn' && e.state === 'end'));
  const txt = b.events.filter(e => e.t === 'delta').map(e => e.text).join('');
  assert.ok(/norya-ok/.test(txt), 'lembra da conversa: ' + txt);
  console.log('  ok  resume com histórico e memória');
  b.s.kill();
  await sleep(500);
  console.log('\nTUDO PASSOU');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
