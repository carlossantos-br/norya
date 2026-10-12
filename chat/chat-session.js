'use strict';

/**
 * chat/chat-session.js — o processo por trás de um pane em modo CHAT.
 *
 * Um pane de chat não tem PTY: a CLI roda em modo de protocolo (stdin/stdout
 * por linha JSON) e o renderer desenha a conversa (renderer/chat.js).
 *
 *   Claude → `claude -p --input-format stream-json --output-format stream-json`
 *            Um processo por pane; cada mensagem do usuário é uma linha no stdin.
 *   Codex  → `codex app-server` (JSON-RPC). initialize → thread/start|resume →
 *            turn/start a cada mensagem. É o mesmo servidor que o app do Codex usa.
 *
 * O ambiente (conta, MCP do navegador, skills, shim de `open`) é o MESMO do
 * PTY: main.js monta env + comando e entrega aqui. Este módulo só cuida do
 * processo e da conversa com ele.
 */

const { spawn: nodeSpawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const P = require('./chat-protocol');
const defaultPlatform = require('../platform');

const STDERR_TAIL = 4000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const IMAGE_MAX = 3.7 * 1024 * 1024;   // 5 MB em base64 (limite da API por imagem)

/**
 * Anexos do composer → imagens + texto. `attachments` = [{ path, image }].
 * Imagem que a CLI aceita vai como imagem; o resto (PDF, código, imagem
 * grande demais) vira caminho no fim do texto — o agente lê pelo disco.
 */
function splitAttachments(text, attachments) {
  const images = [];
  const files = [];
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (!a || typeof a.path !== 'string' || !path.isAbsolute(a.path)) continue;
    let size = -1;
    let isFile = false;
    try { const st = fs.statSync(a.path); isFile = st.isFile(); size = st.size; }
    catch { files.push(a.path + ' (não encontrado)'); continue; }
    const mediaType = isFile && IMAGE_TYPES[path.extname(a.path).toLowerCase()];
    if (mediaType && size <= IMAGE_MAX) images.push({ path: a.path, mediaType });
    else files.push(a.path);   // pasta, PDF, código, imagem grande: o agente lê do disco
  }
  let out = String(text || '');
  if (files.length) out = (out.trim() ? out + '\n\n' : '') + 'Arquivos anexados:\n' + files.map(f => '- ' + f).join('\n');
  return { text: out, images };
}

/**
 * @param {object} o
 * @param {'claude'|'codex'} o.agentId
 * @param {string} o.shell, o.cmd   — shell + linha de comando completa (prelúdio incluso)
 * @param {string[]} o.shellArgs
 * @param {string} o.spawnCwd       — onde o processo nasce
 * @param {string} o.workCwd        — pasta da thread (Codex: vai no thread/start)
 * @param {object} o.env
 * @param {string|null} o.resumeId  — sessão a retomar
 * @param {object} o.codex          — { approvalPolicy, sandbox, model, effort }
 * @param {(ev:object)=>void} o.emit
 * @param {(info:{code:number|null, stderr:string})=>void} o.onExit
 * @param {(sid:string)=>Array} [o.loadClaudeHistory]
 * @param {(tag:string,msg:string)=>void} [o.log]
 * @param {object} [o.platform]     — platform.js (testes injetam o do Windows)
 * @param {Function} [o.spawn]      — child_process.spawn (testes injetam um falso)
 */
function createChatSession(o) {
  const log = o.log || (() => {});
  const emit = ev => { try { o.emit(ev); } catch (e) { log('chat-emit', String(e && e.stack || e)); } };
  let stderrTail = '';
  let dead = false;

  const plat = o.platform || defaultPlatform;
  const spawn = o.spawn || nodeSpawn;
  const proc = spawn(o.shell, o.shellArgs, plat.spawnOpts({
    cwd: o.spawnCwd,
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Grupo próprio: kill(-pid) leva junto qualquer filho que o shell deixar.
    // No Windows não há grupo (e `detached` abriria um console): lá é taskkill /T.
    detached: plat.detachGroup,
  }));

  proc.stdin.on('error', () => {});   // EPIPE depois que o processo morreu
  proc.stderr.on('data', d => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-STDERR_TAIL);
  });

  let outBuf = '';
  let onLine = () => {};
  proc.stdout.on('data', d => {
    outBuf += d.toString('utf8');
    let k;
    while ((k = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, k).trim();
      outBuf = outBuf.slice(k + 1);
      // O shell de login pode imprimir banner antes da CLI: só JSON interessa.
      if (!line || line[0] !== '{') continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try { onLine(msg); } catch (e) { log('chat-line', String(e && e.stack || e)); }
    }
  });

  proc.on('error', err => {
    stderrTail += '\n' + String(err && err.message || err);
  });
  proc.on('exit', code => {
    dead = true;
    try { o.onExit({ code, stderr: stderrTail }); } catch (e) { log('chat-exit', String(e && e.stack || e)); }
  });

  const write = s => { if (!dead) try { proc.stdin.write(s); } catch {} };

  function kill() {
    if (dead) return;
    try { proc.stdin.end(); } catch {}
    try { plat.killTree(proc.pid, 'SIGTERM'); } catch { try { proc.kill(); } catch {} }
    // Quem ignorar o SIGTERM sai no SIGKILL.
    setTimeout(() => {
      if (dead) return;
      try { plat.killTree(proc.pid, 'SIGKILL'); } catch {}
    }, 3000).unref?.();
  }

  // ── Claude ────────────────────────────────────────────────────────────────
  if (o.agentId === 'claude') {
    const tr = P.createClaudeTranslator();
    let reqSeq = 0;
    // Seletor do composer: lista de modelos vem do `initialize`, modelo/esforço
    // em vigor do `get_settings` (applied). Trocar é control_request ao vivo
    // (set_model / apply_flag_settings) — a conversa continua no mesmo processo.
    const ctl = new Map();   // request_id → callback(response)
    const control = (request, cb) => {
      const rid = 'ctl-' + (++reqSeq);
      if (cb) ctl.set(rid, cb);
      write(P.claudeControlLine(rid, request));
    };
    const cfg = { models: [], model: null, effort: null, access: null, commands: [] };
    const emitConfig = () => emit({ t: 'config', models: cfg.models, model: cfg.model, effort: cfg.effort,
      access: cfg.access, accessOptions: P.CLAUDE_ACCESS, commands: cfg.commands });
    // Permissão: o claude sobe em bypass e pergunta pelo stdio
    // (--permission-prompt-tool stdio) quando o seletor sai do "Acesso total".
    const perms = new Map();   // reqId do pane → { requestId, input }
    let refreshAfterTurn = false;   // /model, /effort… mexem no que o seletor mostra
    const refreshApplied = () => control({ subtype: 'get_settings' }, r => {
      const a = r && r.applied;
      if (a) { cfg.model = a.model || cfg.model; cfg.effort = a.effort || null; }
      emitConfig();
    });
    onLine = msg => {
      if (msg.type === 'control_response') {
        const res = msg.response || {};
        const cb = ctl.get(res.request_id);
        if (cb) {
          ctl.delete(res.request_id);
          if (res.subtype === 'error') log('chat-ctl', String(res.error || 'erro'));
          cb(res.subtype === 'error' ? null : (res.response || {}));
        }
        return;
      }
      if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'can_use_tool') {
        const reqId = 'cl-' + msg.request_id;
        perms.set(reqId, { requestId: msg.request_id, input: msg.request.input || {} });
        const v = P.claudeApprovalView(msg.request);
        emit({ t: 'approval', reqId, kind: v.kind, label: v.label, detail: v.detail });
        return;
      }
      if (msg.type === 'control_request') {
        // Pedido que o Norya não atende (hook_callback, mcp_message…): responde
        // erro em vez de deixar o claude esperando.
        write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'não suportado pelo Norya' } }) + '\n');
        return;
      }
      if (msg.type === 'control_cancel_request') {
        const reqId = 'cl-' + msg.request_id;
        if (perms.delete(reqId)) emit({ t: 'approval-done', reqId });
        return;
      }
      const evs = tr.feed(msg);
      for (const ev of evs) emit(ev);
      if (refreshAfterTurn && msg.type === 'result') { refreshAfterTurn = false; refreshApplied(); }
    };
    control({ subtype: 'initialize' }, r => {
      cfg.models = P.claudeModelOptions(r && r.models);
      cfg.commands = P.claudeCommandOptions(r && r.commands);
      cfg.access = (r && r.current_permission_mode) || 'bypassPermissions';
      refreshApplied();
    });

    // Próximo tick: quem chamou ainda não guardou a sessão devolvida, e o main
    // descarta evento de sessão que não é a dele.
    setImmediate(() => {
      if (o.resumeId && o.loadClaudeHistory) {
        try {
          const events = o.loadClaudeHistory(o.resumeId) || [];
          if (events.length) emit({ t: 'history', events });
        } catch (e) { log('chat-history', String(e && e.message || e)); }
      }
      // A sessão só existe no 1º envio; no resume o id já é conhecido.
      if (o.resumeId) emit({ t: 'session', sessionId: o.resumeId, model: null, resumed: true });
      emit({ t: 'ready' });
    });

    return {
      pid: proc.pid,
      send(text, attachments) {
        const a = splitAttachments(text, attachments);
        const images = [];
        for (const im of a.images) {
          try { images.push({ mediaType: im.mediaType, data: fs.readFileSync(im.path).toString('base64') }); }
          catch (e) { log('chat-attach', String(e && e.message || e)); }
        }
        if (!a.text.trim() && !images.length) {
          // Nada sobrou pra mandar (anexo sumiu): bloco de texto vazio a API recusa.
          emit({ t: 'turn', state: 'end', durationMs: 0, error: 'Nada para enviar: o anexo não pôde ser lido.' });
          return;
        }
        if (/^\s*\/(model|effort|fast|config|permissions)\b/.test(a.text)) refreshAfterTurn = true;
        write(P.claudeUserLine(a.text, images));
      },
      interrupt() {
        write(P.claudeInterruptLine('int-' + (++reqSeq)));
        // Pedido de permissão aberto morre com o turno.
        for (const [reqId, p] of perms) { write(P.claudePermissionLine(p.requestId, false)); emit({ t: 'approval-done', reqId }); }
        perms.clear();
      },
      approve(reqId, ok) {
        const p = perms.get(reqId);
        if (!p) return;
        perms.delete(reqId);
        write(P.claudePermissionLine(p.requestId, ok, p.input));
        emit({ t: 'approval-done', reqId });
      },
      configure({ model, effort, access } = {}) {
        // O claude atende control_request em paralelo: um get_settings mandado
        // junto pode responder antes do set_model e devolver o modelo antigo.
        // Confirma só depois que todas as trocas responderem.
        const reqs = [];
        if (model && /^[\w.\[\]-]+$/.test(model)) reqs.push({ subtype: 'set_model', model });
        if (effort && /^[a-z]+$/.test(effort)) reqs.push({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
        if (access && P.CLAUDE_ACCESS.some(a => a.value === access)) {
          control({ subtype: 'set_permission_mode', mode: access }, r => {
            cfg.access = (r && r.mode) || cfg.access;
            emitConfig();
          });
          if (!reqs.length) return;
        }
        let left = reqs.length;
        if (!left) return refreshApplied();
        for (const r of reqs) control(r, () => { if (--left === 0) refreshApplied(); });
      },
      kill,
      get dead() { return dead; },
    };
  }

  // ── Codex (app-server, JSON-RPC) ──────────────────────────────────────────
  const tr = P.createCodexTranslator();
  const c = o.codex || {};
  let rpcSeq = 0;
  const pending = new Map();
  let threadId = null;
  let turnId = null;
  const queue = [];         // mensagens enviadas antes da thread existir
  const approvals = new Map();   // reqId (string) → id JSON-RPC original

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pending.set(id, { resolve, reject, method });
    write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => write(JSON.stringify(params === undefined
    ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }) + '\n');
  const respond = (id, result) => write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const respondError = (id, message) => write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n');

  onLine = msg => {
    // Resposta a pedido nosso.
    if (msg.id != null && !msg.method) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Pedido do servidor (aprovação etc.).
    if (msg.id != null && msg.method) {
      const v = P.codexApprovalView(msg.method, msg.params);
      if (v) {
        const reqId = 'ap-' + msg.id;
        approvals.set(reqId, msg.id);
        emit({ t: 'approval', reqId, kind: v.kind, label: v.label, detail: v.detail });
      } else {
        respondError(msg.id, 'não suportado pelo Norya');
      }
      return;
    }
    if (msg.method === 'turn/started') turnId = (msg.params && msg.params.turn && msg.params.turn.id) || turnId;
    if (msg.method === 'turn/completed') turnId = null;
    if (msg.method === 'serverRequest/resolved' && msg.params) {
      // Resolvido por outro caminho (turno interrompido): some o cartão.
      const reqId = 'ap-' + msg.params.requestId;
      if (approvals.delete(reqId)) emit({ t: 'approval-done', reqId });
    }
    for (const ev of tr.feed(msg)) emit(ev);
  };

  // Seletor do composer. A troca vale a partir do próximo turn/start (o
  // app-server guarda o override pros turnos seguintes), igual ao app do Codex.
  const cfg = { models: [], model: c.model || null, effort: c.effort || null,
    access: c.sandbox === 'workspace-write' ? 'ask' : 'full' };
  const over = {};   // overrides pendentes pro próximo turn/start
  const emitConfig = () => emit({ t: 'config', models: cfg.models, model: cfg.model, effort: cfg.effort, access: cfg.access,
    accessOptions: null, commands: P.CODEX_COMMANDS });
  const fillDefaults = () => {
    const cur = cfg.models.find(m => m.value === cfg.model) || cfg.models.find(m => m.isDefault);
    if (!cfg.model && cur) cfg.model = cur.value;
    if (!cfg.effort && cur) cfg.effort = cur.defaultEffort;
  };

  const codexInput = (text, attachments) => {
    const a = splitAttachments(text, attachments);
    const input = a.images.map(im => ({ type: 'localImage', path: im.path }));
    if (a.text.trim() || !input.length) input.push({ type: 'text', text: a.text, text_elements: [] });
    return input;
  };

  // /compact e /review: o app-server tem método próprio (o turno sai pelas
  // mesmas notificações turn/* e item/*). Devolve true se tratou.
  const slashCommand = text => {
    const m = String(text).trim().match(/^\/(compact|review)\b/);
    if (!m) return false;
    const fail = err => emit({ t: 'turn', state: 'end', durationMs: 0, error: '/' + m[1] + ' falhou: ' + err.message });
    if (m[1] === 'compact') request('thread/compact/start', { threadId }).catch(fail);
    else request('review/start', { threadId, target: { type: 'uncommittedChanges' } }).catch(fail);
    return true;
  };

  const startTurn = ({ text, attachments }) => {
    if (!attachments && slashCommand(text)) return Promise.resolve();
    const extra = Object.assign({}, over);
    for (const k of Object.keys(over)) delete over[k];
    return request('turn/start', {
      threadId,
      input: codexInput(text, attachments),
      // Sempre o esforço em vigor (o do seletor) — senão o da criação do pane
      // voltaria a cada turno por cima da troca.
      ...(cfg.effort ? { effort: cfg.effort } : {}),
      ...extra,
    }).catch(err => {
      emit({ t: 'notice', level: 'error', text: 'Falha ao enviar: ' + err.message });
      // Sem turno nenhum, o pane ficaria em "Trabalhando" pra sempre.
      if (!turnId) emit({ t: 'turn', state: 'end', durationMs: 0, error: null });
    });
  };

  // "Enviar agora" com turno rodando: entra no turno atual (turn/steer), como
  // no app do Codex. Se o turno acabou no meio do caminho, vira turno novo.
  const steer = msg => request('turn/steer', { threadId, expectedTurnId: turnId, input: codexInput(msg.text, msg.attachments) })
    .catch(() => startTurn(msg));

  const noteThread = r => {
    if (!r) return;
    if (r.model) cfg.model = r.model;
    if (r.reasoningEffort) cfg.effort = r.reasoningEffort;
    if (r.sandbox || r.approvalPolicy) cfg.access = P.codexAccessOf(r.approvalPolicy, r.sandbox);
  };

  (async () => {
    try {
      await request('initialize', { clientInfo: { name: 'norya', title: 'Norya', version: '1' } });
      notify('initialized');
      const policy = { approvalPolicy: c.approvalPolicy || 'never', sandbox: c.sandbox || 'danger-full-access' };
      if (o.resumeId) {
        const r = await request('thread/resume', {
          threadId: o.resumeId,
          ...(o.workCwd ? { cwd: o.workCwd } : {}),
          ...(c.model ? { model: c.model } : {}),
          ...policy,
        });
        threadId = (r && r.thread && r.thread.id) || o.resumeId;
        tr.setThread(threadId);
        try {
          const page = await request('thread/turns/list', { threadId, limit: 40, sortDirection: 'desc', itemsView: 'full' });
          const turns = (page && page.data || []).slice().reverse();
          const events = P.codexHistoryEvents(turns);
          if (events.length) emit({ t: 'history', events });
        } catch (e) { log('chat-history', String(e && e.message || e)); }
        noteThread(r);
        emit({ t: 'session', sessionId: threadId, model: (r && r.model) || null, resumed: true });
      } else {
        const r = await request('thread/start', {
          ...(o.workCwd ? { cwd: o.workCwd } : {}),
          ...(c.model ? { model: c.model } : {}),
          ...(c.developerInstructions ? { developerInstructions: c.developerInstructions } : {}),
          ...policy,
        });
        threadId = r && r.thread && r.thread.id;
        if (!threadId) throw new Error('thread/start sem id');
        tr.setThread(threadId);
        noteThread(r);
        emit({ t: 'session', sessionId: threadId, model: (r && r.model) || null });
      }
      try {
        const ml = await request('model/list', { limit: 100 });
        cfg.models = P.codexModelOptions(ml && ml.data);
      } catch (e) { log('chat-models', String(e && e.message || e)); }
      fillDefaults();
      emitConfig();
      emit({ t: 'ready' });
      while (queue.length) startTurn(queue.shift());
    } catch (err) {
      emit({ t: 'notice', level: 'error', text: 'Codex não iniciou: ' + (err && err.message || err) });
      log('chat-codex-start', String(err && err.message || err));
    }
  })();

  return {
    pid: proc.pid,
    send(text, attachments, opts) {
      const msg = { text, attachments: attachments && attachments.length ? attachments : null };
      if (!threadId) queue.push(msg);
      else if (opts && opts.steer && turnId) steer(msg);
      else startTurn(msg);
    },
    interrupt() {
      if (threadId && turnId) request('turn/interrupt', { threadId, turnId }).catch(() => {});
    },
    approve(reqId, ok) {
      const rpcId = approvals.get(reqId);
      if (rpcId == null) return;
      approvals.delete(reqId);
      respond(rpcId, { decision: ok ? 'accept' : 'decline' });
      emit({ t: 'approval-done', reqId });
    },
    configure({ model, effort, access } = {}) {
      if (model && typeof model === 'string') {
        over.model = cfg.model = model;
        // Esforço que o modelo novo não suporta cai no padrão dele.
        const m = cfg.models.find(x => x.value === model);
        if (m && m.efforts.length && !m.efforts.includes(cfg.effort)) over.effort = cfg.effort = m.defaultEffort || m.efforts[0];
      }
      if (effort && typeof effort === 'string') { over.effort = cfg.effort = effort; }
      if (access && P.CODEX_ACCESS[access]) { Object.assign(over, P.CODEX_ACCESS[access]); cfg.access = access; }
      emitConfig();
    },
    kill,
    get dead() { return dead; },
  };
}

module.exports = { createChatSession };
