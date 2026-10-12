#!/usr/bin/env node
'use strict';

/**
 * helpers/norya-claude-event.js — hook do Claude Code → Norya (2026-10-04).
 *
 * O main injeta este script como hook via `claude --settings '<json>'`
 * (agents/commands.js), SOMANDO aos hooks do usuário — não depende do
 * settings.json de cada perfil. Cada hook vira UMA linha JSON no socket
 * $NORYA_EVENT_SOCKET, com o $NORYA_SPAWN_ID do pane:
 *
 *   UserPromptSubmit           → turn-start
 *   PreToolUse                 → working (+ tool, files, q: atividade do Mini)
 *   Stop, sem background vivo  → turn-end (+ summary: 1ª linha da última fala)
 *   Stop, com background vivo  → bg-pending (o Claude vai retomar sozinho)
 *   Notification permission_prompt → needs-you  (idle_prompt é ignorado)
 *
 * Regras de convivência com o Claude: nunca falha (exit 0 sempre), nunca
 * escreve em stdout (stdout de hook altera comportamento), termina em
 * em ~100 ms (teto 1,5 s) e é no-op fora de um pane do Norya.
 *
 * Sem dependências: roda no node que o main achar (ou no próprio Electron com
 * ELECTRON_RUN_AS_NODE). A contagem de pendentes é exportada pros testes.
 */

const fs = require('fs');
const net = require('net');

// Transcript de sessão longa passa de dezenas de MB. Background esquecido lá
// no começo não segura turno de hoje, e ler tudo estouraria o orçamento.
const TAIL_BYTES = 24 * 1024 * 1024;
// Teto de segurança, não o tempo normal (~100 ms). Curto demais descartava o
// Stop com a máquina carregada — e Stop perdido = pane que nunca apita.
const DEADLINE_MS = 1500;

const RX_TASK_ID = /<task-id>([^<]+)<\/task-id>/g;
const RX_STATUS = /<status>(completed|failed|killed)<\/status>/;

/** Texto de uma <task-notification> ENTREGUE ao modelo, ou null. */
function notificationText(o) {
  if (o.type === 'user' && o.message) {
    const c = o.message.content;
    if (typeof c === 'string') return c.trimStart().startsWith('<task-notification>') ? c : null;
    if (Array.isArray(c)) {
      // Só bloco de texto do próprio usuário — tool_result que CITA a tag não conta.
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string'
            && b.text.trimStart().startsWith('<task-notification>')) return b.text;
      }
    }
    return null;
  }
  if (o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command') {
    const p = o.attachment.prompt;
    if (typeof p === 'string' && (o.attachment.commandMode === 'task-notification'
        || p.trimStart().startsWith('<task-notification>'))) return p;
  }
  return null;
}

/**
 * Quantas tarefas em background ainda não voltaram, a partir do transcript.
 *
 * Lançadas: toolUseResult com isAsync/status "async_launched" (Agent em
 * background, id = agentId). Bash em background (backgroundTaskId) NÃO conta:
 * servidor de dev e monitor nunca terminam, e o pane nunca apitaria — o turno
 * do Claude acabou de fato; se o bash acabar e acordá-lo, é um turno novo. Concluídas: <task-notification> ENTREGUE (mensagem user ou
 * attachment queued_command) com <status> completed|failed|killed.
 *
 * O `queue-operation enqueue` NÃO conta como concluída de propósito: a tarefa
 * acabou mas o Claude ainda vai acordar para ler o aviso — o pane não terminou.
 */
const MARCADORES = ['async_launched', 'isAsync', 'task-notification'];

/**
 * Só as linhas que citam algum marcador, buscadas direto no Buffer. Decodificar
 * e dar split('\n') num transcript de 70 MB comia ~100 ms do orçamento do hook
 * (medido 2026-10-04); o indexOf do Buffer é memmem e só as linhas achadas
 * viram string.
 */
function linhasComMarcador(buf) {
  const inicios = new Set();
  for (const mk of MARCADORES) {
    let i = buf.indexOf(mk);
    while (i >= 0) {
      inicios.add(buf.lastIndexOf(0x0a, i) + 1);
      const fim = buf.indexOf(0x0a, i);
      i = fim < 0 ? -1 : buf.indexOf(mk, fim);
    }
  }
  return [...inicios].sort((a, b) => a - b).map(ini => {
    const fim = buf.indexOf(0x0a, ini);
    return buf.toString('utf8', ini, fim < 0 ? buf.length : fim);
  });
}

function countPendingBackground(textOrBuffer) {
  const launched = new Set();
  const done = new Set();
  const buf = Buffer.isBuffer(textOrBuffer) ? textOrBuffer : Buffer.from(String(textOrBuffer || ''), 'utf8');
  for (const line of linhasComMarcador(buf)) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const r = o.toolUseResult;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      if ((r.isAsync === true || r.status === 'async_launched') && r.agentId) launched.add(String(r.agentId));
    }
    const txt = notificationText(o);
    if (txt && RX_STATUS.test(txt)) {
      RX_TASK_ID.lastIndex = 0;
      let m;
      while ((m = RX_TASK_ID.exec(txt))) done.add(m[1].trim());
    }
  }
  let pending = 0;
  for (const id of launched) if (!done.has(id)) pending++;
  return pending;
}

/** Lê o fim do transcript como Buffer (nada de decodificar 24 MB). */
function readTail(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    let buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, size - len);
    // Começou no meio de uma linha: descarta o pedaço.
    if (len < size) buf = buf.subarray(buf.indexOf(0x0a) + 1);
    return { text: buf, size };
  } finally { fs.closeSync(fd); }
}

// Atividade pro Mini/pet (2026-10-05). Tools que editam arquivo: 1 arquivo por
// chamada (MultiEdit também é um arquivo só).
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SUMMARY_TAIL = 256 * 1024;   // só o fim do que o hook já leu

/** 1ª linha não vazia, sem marcação markdown de ênfase, ≤ max. */
function firstLine(text, max) {
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/^[#>\s*-]+/, '').replace(/\*\*/g, '').trim();
    if (l) return l.length > max ? l.slice(0, max - 1) + '…' : l;
  }
  return '';
}

/**
 * Resumo do último texto do assistente, no trecho do transcript que o hook JÁ
 * leu (nada de leitura nova): varre de trás pra frente só os últimos 256 KB e
 * para na mensagem do usuário que abriu o turno.
 */
function lastAssistantSummary(textOrBuffer) {
  if (!textOrBuffer) return '';
  const buf = Buffer.isBuffer(textOrBuffer) ? textOrBuffer : Buffer.from(String(textOrBuffer), 'utf8');
  let end = buf.length;
  const floor = Math.max(0, end - SUMMARY_TAIL);
  while (end > floor) {
    let ini = buf.lastIndexOf(0x0a, end - 2) + 1;
    if (ini < floor) ini = floor;
    const line = buf.toString('utf8', ini, end);
    end = ini - 1;
    if (end < 0) end = 0;
    if (line.indexOf('"tool_use_id"') >= 0) { if (ini === 0) break; continue; }   // tool_result
    if (line.indexOf('"type":"assistant"') >= 0) {
      let o; try { o = JSON.parse(line); } catch { o = null; }
      const c = o && o.message && o.message.content;
      const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : (Array.isArray(c) ? c : []);
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b && b.type === 'text' && typeof b.text === 'string') {
          const t = firstLine(b.text, 140);
          if (t) return t;
        }
      }
    } else if (line.indexOf('"type":"user"') >= 0) {
      break;   // chegou no prompt que abriu o turno
    }
    if (ini === 0) break;
  }
  return '';
}

/** Campos de atividade de um PreToolUse (tool, files, q). */
function activityFor(input) {
  const out = {};
  const tool = input && input.tool_name;
  if (typeof tool !== 'string' || !tool) return out;
  out.tool = tool.slice(0, 80);
  if (EDIT_TOOLS.has(tool)) out.files = 1;
  const ti = input.tool_input;
  if (tool === 'WebSearch' && ti && typeof ti.query === 'string' && ti.query) out.q = ti.query.slice(0, 120);
  return out;
}

/** hook do Claude (stdin JSON) → mensagem do canal, ou null. */
function eventFor(input, spawnId, readTranscript = readTail) {
  const ev = input && input.hook_event_name;
  switch (ev) {
    case 'UserPromptSubmit': return { spawnId, kind: 'turn-start' };
    case 'PreToolUse': return Object.assign({ spawnId, kind: 'working' }, activityFor(input));
    case 'Notification':
      return input.notification_type === 'permission_prompt' ? { spawnId, kind: 'needs-you' } : null;
    case 'Stop': {
      let pending = 0, transcriptSize, summary = '';
      const tp = input.transcript_path;
      if (typeof tp === 'string' && tp) {
        try {
          const t = readTranscript(tp);
          pending = countPendingBackground(t.text);
          transcriptSize = t.size;
          if (pending === 0 && typeof input.last_assistant_message !== 'string') summary = lastAssistantSummary(t.text);
        } catch { /* sem transcript: trata como sem background */ }
      }
      if (pending > 0) return { spawnId, kind: 'bg-pending', pending };
      const msg = { spawnId, kind: 'turn-end', pending: 0 };
      // O Claude Code recente já manda o último texto no próprio input do Stop.
      if (typeof input.last_assistant_message === 'string') summary = firstLine(input.last_assistant_message, 140);
      if (summary) msg.summary = summary;
      if (typeof tp === 'string' && transcriptSize != null) {
        msg.transcriptPath = tp;
        msg.transcriptSize = transcriptSize;
      }
      return msg;
    }
    default: return null;   // SubagentStop e o resto: ignorados
  }
}

function send(socketPath, msg, cb) {
  let finished = false;
  const fim = () => { if (!finished) { finished = true; cb(); } };
  try {
    const c = net.createConnection(socketPath, () => c.end(JSON.stringify(msg) + '\n'));
    c.on('close', fim);
    c.on('error', fim);
  } catch { fim(); }
}

function main() {
  // Teto duro: aconteça o que acontecer, o hook não segura o Claude.
  setTimeout(() => process.exit(0), DEADLINE_MS).unref();
  const socketPath = process.env.NORYA_EVENT_SOCKET;
  const spawnId = process.env.NORYA_SPAWN_ID;
  if (!socketPath || !spawnId) { process.exit(0); return; }
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; if (raw.length > 1e6) raw = raw.slice(0, 1e6); });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let msg = null;
    try { msg = eventFor(JSON.parse(raw), spawnId); } catch { msg = null; }
    if (!msg) { process.exit(0); return; }
    send(socketPath, msg, () => process.exit(0));
  });
}

if (require.main === module) {
  try { main(); } catch { process.exit(0); }
}

module.exports = { countPendingBackground, eventFor, notificationText, lastAssistantSummary, activityFor };
