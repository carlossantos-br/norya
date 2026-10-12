'use strict';

/**
 * chat/chat-protocol.js — traduz o protocolo de cada CLI para os eventos do
 * pane de chat (renderer/chat.js).
 *
 * PURO: sem electron, sem fs, sem processo. Recebe mensagens já parseadas e
 * devolve eventos normalizados — é o que deixa test/chat-protocol.test.js
 * rodar sem subir nada.
 *
 *   Claude: `claude -p --input-format stream-json --output-format stream-json
 *            --verbose --include-partial-messages`  (1 JSON por linha)
 *   Codex:  `codex app-server`  (JSON-RPC 2.0 por linha — o mesmo protocolo
 *            que o app do Codex usa)
 *
 * Eventos que saem daqui (o renderer só conhece estes):
 *   { t:'session', sessionId, model }
 *   { t:'turn', state:'start' }
 *   { t:'turn', state:'end', durationMs, error }
 *   { t:'item', item }             upsert por item.id
 *   { t:'delta', id, kind, text }  acrescenta texto num item text/reasoning
 *   { t:'notice', level, text }
 *   { t:'usage', used, window, costUsd }   contexto em uso (tokens) / janela
 *
 * item = { id, kind:'user'|'text'|'reasoning'|'tool', text, final, images,
 *          icon, label, detail, status:'running'|'done'|'error' }
 *
 * Fora de propósito: TodoWrite / plan do Codex. O pane não tem lista de tarefas.
 */

const DETAIL_MAX = 6000;

function clip(s, n = DETAIL_MAX) {
  s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n) + '\n…' : s;
}

// Aceita `\` também: no Windows as tools do Claude/Codex mandam `C:\dev\x.js`.
function base(p) {
  if (!p) return '';
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function oneLine(s, n = 160) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Ferramentas que o pane não mostra (lista de tarefas).
const HIDDEN_TOOLS = new Set(['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ExitPlanMode', 'EnterPlanMode']);

// ─────────────────────────────────────────────────────────────────────────────
// Claude
// ─────────────────────────────────────────────────────────────────────────────

/** Rótulo de uma tool do Claude no estilo do app do Codex. */
function claudeToolView(name, input) {
  input = input || {};
  const n = String(name || '');
  if (n === 'Bash') return { icon: 'cmd', label: 'Comando executado: ' + oneLine(input.command, 200) };
  if (n === 'Read') return { icon: 'read', label: 'Leu ' + base(input.file_path || input.path) };
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return { icon: 'edit', label: 'Editou ' + base(input.file_path || input.notebook_path) };
  if (n === 'Write') return { icon: 'edit', label: 'Criou ' + base(input.file_path) };
  if (n === 'Grep') return { icon: 'search', label: 'Buscou por ' + oneLine(input.pattern, 120) };
  if (n === 'Glob') return { icon: 'list', label: 'Listou ' + oneLine(input.pattern, 120) };
  if (n === 'WebFetch') return { icon: 'web', label: 'Abriu ' + oneLine(input.url, 120) };
  if (n === 'WebSearch') return { icon: 'web', label: 'Pesquisou ' + oneLine(input.query, 120) };
  if (n === 'Task' || n === 'Agent') return { icon: 'agent', label: 'Subagente: ' + oneLine(input.description || input.prompt, 120) };
  if (n === 'Skill') return { icon: 'tool', label: 'Skill ' + oneLine(input.skill || input.name, 80) };
  const mcp = n.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return { icon: 'mcp', label: `Usou ${mcp[2]} (${mcp[1]})` };
  return { icon: 'tool', label: n };
}

function claudeEditDetail(name, input) {
  input = input || {};
  if (name === 'Edit') return clip(`- ${input.old_string || ''}\n+ ${input.new_string || ''}`);
  if (name === 'Write') return clip(input.content || '');
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return clip(input.edits.map(e => `- ${e.old_string || ''}\n+ ${e.new_string || ''}`).join('\n\n'));
  }
  return '';
}

function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (c && c.type === 'text') ? c.text : (c && c.type === 'image' ? '[imagem]' : '')).filter(Boolean).join('\n');
  }
  return '';
}

/**
 * Tradutor com estado (blocos em streaming chegam por índice; tools por id).
 * `feed(msg)` → array de eventos.
 */
function createClaudeTranslator() {
  let sessionId = null;
  let turnOpen = false;
  let turnStart = 0;
  let msgId = null;                 // message.id em streaming
  const blockIds = new Map();       // index → item id (texto/raciocínio)
  const toolsById = new Map();      // tool_use id → { name, input }
  const emitted = new Set();        // itens de texto já emitidos (assistant completo repete)
  let ctxUsed = 0;                  // contexto da última chamada (tokens)
  let turnUsage = false;            // o turno teve chamada própria com usage?

  const out = [];
  const push = e => out.push(e);

  function openTurn() {
    if (turnOpen) return;
    turnOpen = true;
    turnStart = Date.now();
    turnUsage = false;
    push({ t: 'turn', state: 'start' });
  }

  function feed(m) {
    out.length = 0;
    if (!m || typeof m !== 'object') return [];
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          if (m.session_id && m.session_id !== sessionId) {
            sessionId = m.session_id;
            push({ t: 'session', sessionId, model: m.model || null });
          }
        } else if (m.subtype === 'compact_boundary') {
          ctxUsed = 0;   // o tamanho de antes não vale mais; o result do /compact diz o novo
          push({ t: 'notice', level: 'info', text: 'Contexto compactado' });
        } else if (m.subtype === 'status' && m.status === 'requesting') {
          openTurn();
        }
        break;

      case 'stream_event': {
        const ev = m.event || {};
        if (m.parent_tool_use_id) break;   // stream de subagente: só o resultado conta
        openTurn();
        if (ev.type === 'message_start') {
          msgId = (ev.message && ev.message.id) || ('m' + Date.now());
          blockIds.clear();
        } else if (ev.type === 'content_block_start') {
          const b = ev.content_block || {};
          const id = `${msgId}:${ev.index}`;
          if (b.type === 'text') {
            blockIds.set(ev.index, id);
            emitted.add(id);
            push({ t: 'item', item: { id, kind: 'text', text: b.text || '' } });
          } else if (b.type === 'thinking') {
            blockIds.set(ev.index, id);
            emitted.add(id);
            push({ t: 'item', item: { id, kind: 'reasoning', text: b.thinking || '' } });
          }
          // tool_use: só no `assistant` logo depois do bloco — aqui o input
          // ainda está vazio e o rótulo sairia "Comando executado: ".
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta || {};
          const id = blockIds.get(ev.index);
          if (!id) break;
          if (d.type === 'text_delta' && d.text) push({ t: 'delta', id, kind: 'text', text: d.text });
          else if (d.type === 'thinking_delta' && d.thinking) push({ t: 'delta', id, kind: 'reasoning', text: d.thinking });
        }
        break;
      }

      case 'assistant': {
        if (m.parent_tool_use_id) break;
        openTurn();
        const msg = m.message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        // Cada chamada traz o próprio usage: entrada (com cache) + saída = o
        // tamanho da conversa naquele momento.
        const u = msg.usage;
        if (u && typeof u.input_tokens === 'number') {
          ctxUsed = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
          turnUsage = true;
        }
        content.forEach((b, i) => {
          if (b.type === 'tool_use') {
            if (HIDDEN_TOOLS.has(b.name)) return;
            toolsById.set(b.id, { name: b.name, input: b.input || {} });
            const v = claudeToolView(b.name, b.input);
            push({ t: 'item', item: { id: b.id, kind: 'tool', icon: v.icon, label: v.label, detail: claudeEditDetail(b.name, b.input), status: 'running' } });
          } else if (b.type === 'text' || b.type === 'thinking') {
            // Sem --include-partial-messages (ou bloco que escapou do stream),
            // o texto chega só aqui. Com stream, o id já foi emitido: ignora.
            const id = `${msg.id}:${i}`;
            if (emitted.has(id)) return;
            const text = b.type === 'text' ? b.text : b.thinking;
            if (!text) return;
            emitted.add(id);
            push({ t: 'item', item: { id, kind: b.type === 'text' ? 'text' : 'reasoning', text } });
          }
        });
        break;
      }

      case 'user': {
        if (m.parent_tool_use_id) break;
        const msg = m.message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const t = toolsById.get(b.tool_use_id);
          if (!t) continue;
          const v = claudeToolView(t.name, t.input);
          const editDetail = claudeEditDetail(t.name, t.input);
          const result = toolResultText(b.content);
          push({ t: 'item', item: {
            id: b.tool_use_id, kind: 'tool', icon: v.icon, label: v.label,
            detail: clip(editDetail && !b.is_error ? editDetail : result),
            status: b.is_error ? 'error' : 'done',
          } });
        }
        break;
      }

      case 'result': {
        const durationMs = typeof m.duration_ms === 'number' ? m.duration_ms : (turnStart ? Date.now() - turnStart : 0);
        let error = null;
        if (m.is_error || (m.subtype && m.subtype !== 'success')) {
          error = (typeof m.result === 'string' && m.result) || (Array.isArray(m.errors) && m.errors.join('\n')) || m.subtype || 'erro';
          if (m.subtype === 'error_during_execution' && /interrupt/i.test(String(error))) error = null;
        }
        turnOpen = false;
        const usage = claudeResultUsage(m, turnUsage ? ctxUsed : 0);
        if (usage && usage.used) ctxUsed = usage.used;
        if (usage) push(usage);
        push({ t: 'turn', state: 'end', durationMs, error, interrupted: m.subtype === 'error_during_execution' });
        break;
      }

      default: break;
    }
    return out.slice();
  }

  return { feed, get sessionId() { return sessionId; } };
}

/**
 * Contexto em uso no fim do turno. A janela vem do modelUsage do `result`
 * (por modelo); sem chamada nova no turno (/context, comando local), vale o
 * total do próprio result.
 */
function claudeResultUsage(m, ctxUsed) {
  const mu = m && m.modelUsage && typeof m.modelUsage === 'object' ? Object.values(m.modelUsage) : [];
  const win = mu.reduce((a, x) => Math.max(a, (x && x.contextWindow) || 0), 0);
  let used = ctxUsed;
  const it = m && m.usage && Array.isArray(m.usage.iterations) ? m.usage.iterations[m.usage.iterations.length - 1] : null;
  if (!used && it) used = (it.input_tokens || 0) + (it.cache_read_input_tokens || 0) + (it.cache_creation_input_tokens || 0) + (it.output_tokens || 0);
  if (!used && !win && typeof m.total_cost_usd !== 'number') return null;
  return { t: 'usage', used: used || 0, window: win || 0, costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null };
}

/**
 * Mensagem de usuário no formato do --input-format stream-json. `images` =
 * [{ mediaType, data(base64) }] — vão antes do texto, como no app.
 */
function claudeUserLine(text, images) {
  const content = [];
  for (const im of Array.isArray(images) ? images : []) {
    if (im && im.data && im.mediaType) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } });
  }
  if (String(text || '').trim() || !content.length) content.push({ type: 'text', text: String(text || '') });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

/** Resposta ao can_use_tool (--permission-prompt-tool stdio). */
function claudePermissionLine(requestId, ok, input) {
  const response = ok ? { behavior: 'allow', updatedInput: input || {} } : { behavior: 'deny', message: 'Recusado pelo usuário no Norya.' };
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: String(requestId), response } }) + '\n';
}

/** Pedido de permissão do Claude (can_use_tool) → cartão de aprovação. */
function claudeApprovalView(req) {
  const r = req || {};
  const n = String(r.tool_name || '');
  const input = r.input || {};
  if (n === 'Bash') return { kind: 'cmd', label: 'Executar comando?', detail: String(input.command || '') + (r.description ? '\n\n' + r.description : '') };
  if (n === 'Edit' || n === 'MultiEdit' || n === 'Write' || n === 'NotebookEdit') {
    const file = input.file_path || input.notebook_path || '';
    return { kind: 'patch', label: (n === 'Write' ? 'Criar ' : 'Editar ') + base(file) + '?', detail: clip(file + '\n\n' + claudeEditDetail(n, input), 3000) };
  }
  const v = claudeToolView(n, input);
  let detail = '';
  try { detail = clip(JSON.stringify(input, null, 2), 2000); } catch {}
  return { kind: 'tool', label: v.label + '?', detail };
}

/**
 * Modos de permissão do Claude no seletor de acesso. `full` = bypass (o padrão
 * de toda sessão do Norya); os outros fazem o claude pedir pelo stdio.
 */
const CLAUDE_ACCESS = [
  { value: 'bypassPermissions', label: 'Acesso total', desc: 'Edita e roda comandos sem pedir', full: true },
  { value: 'acceptEdits', label: 'Aceitar edições', desc: 'Edita sem pedir; pede pra rodar comandos' },
  { value: 'default', label: 'Pedir aprovação', desc: 'Pede antes de editar ou rodar comandos' },
  { value: 'plan', label: 'Planejar', desc: 'Só lê e planeja; não muda nada' },
];

/** Comandos do `initialize` do claude → lista do autocompletar de "/". */
function claudeCommandOptions(commands) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(commands) ? commands : []) {
    if (!c || !c.name || seen.has(c.name) || /^__/.test(c.name)) continue;
    seen.add(c.name);
    out.push({ name: String(c.name), desc: oneLine(c.description || '', 140), hint: c.argumentHint || '' });
  }
  return out;
}

/** Comandos que o Norya implementa por cima do app-server do Codex. */
const CODEX_COMMANDS = [
  { name: 'compact', desc: 'Resume a conversa pra liberar contexto', hint: '' },
  { name: 'review', desc: 'Revisa as mudanças não commitadas', hint: '' },
];

/** Interromper o turno: control_request do protocolo do SDK. */
function claudeInterruptLine(reqId) {
  return JSON.stringify({ type: 'control_request', request_id: String(reqId), request: { subtype: 'interrupt' } }) + '\n';
}

/** Qualquer control_request (initialize, set_model, apply_flag_settings, get_settings). */
function claudeControlLine(reqId, request) {
  return JSON.stringify({ type: 'control_request', request_id: String(reqId), request }) + '\n';
}

// ── Seletor de modelo / esforço / acesso (composer do chat) ─────────────────
// Forma única pro renderer: { value, label, desc, efforts:[...], defaultEffort }.

/**
 * Modelos do `initialize` do `claude -p` (resposta do control_request). Tira o
 * "default" (é um apelido de outro da lista) e ids datados repetidos.
 */
function claudeModelOptions(models) {
  const out = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || !m.value || m.value === 'default') continue;
    out.push({
      value: String(m.value),
      resolved: m.resolvedModel || null,
      label: m.displayName || String(m.value),
      desc: m.description || '',
      efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.slice() : [],
      defaultEffort: null,
    });
  }
  return out;
}

/** Modelos do `model/list` do `codex app-server` (sem os escondidos). */
function codexModelOptions(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || m.hidden || !(m.model || m.id)) continue;
    out.push({
      value: String(m.model || m.id),
      resolved: String(m.model || m.id),
      label: m.displayName || String(m.model || m.id),
      desc: m.description || '',
      efforts: (m.supportedReasoningEfforts || []).map(e => e && e.reasoningEffort).filter(Boolean),
      defaultEffort: m.defaultReasoningEffort || null,
      isDefault: !!m.isDefault,
    });
  }
  return out;
}

/**
 * Acesso do Codex: o app oferece "Acesso total" (sem sandbox, sem perguntar) e
 * "Padrão" (escreve só na pasta, pede aprovação pro resto). Vai por turno no
 * turn/start e vale pros seguintes.
 */
const CODEX_ACCESS = {
  full: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
  ask: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess: true } },
  readonly: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } },
};

/** Acesso atual a partir do que o thread/start|resume devolveu. */
function codexAccessOf(approvalPolicy, sandbox) {
  const t = sandbox && (sandbox.type || sandbox.mode || sandbox);
  if (t === 'dangerFullAccess' || t === 'danger-full-access') return 'full';
  if (t === 'readOnly' || t === 'read-only') return 'readonly';
  if (t) return 'ask';
  return approvalPolicy === 'never' ? 'full' : 'ask';
}

/**
 * Histórico de uma sessão do Claude a partir do transcript (.jsonl) — usado ao
 * reabrir uma task em chat. Devolve a mesma sequência de eventos que o
 * streaming produziria (user → turn start → itens → turn end).
 */
function claudeHistoryEvents(lines) {
  const ev = [];
  const tools = new Map();
  let turn = null;   // { start, last }
  const close = () => {
    if (!turn) return;
    ev.push({ t: 'turn', state: 'end', durationMs: Math.max(0, turn.last - turn.start), error: null, history: true });
    turn = null;
  };
  for (const l of lines) {
    let o;
    try { o = typeof l === 'string' ? JSON.parse(l) : l; } catch { continue; }
    if (!o || o.isSidechain || o.isMeta) continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    const msg = o.message || {};
    if (o.type === 'user') {
      const c = msg.content;
      // Prompt digitado: string, ou blocos de texto sem tool_result.
      const texts = typeof c === 'string' ? [c]
        : (Array.isArray(c) && !c.some(b => b && b.type === 'tool_result')
          ? c.filter(b => b && b.type === 'text').map(b => b.text) : null);
      if (texts) {
        const text = texts.join('\n').trim();
        const nImg = Array.isArray(c) ? c.filter(b => b && b.type === 'image').length : 0;
        if ((!text && !nImg) || /^<(command-|local-command|system-reminder|bash-)/.test(text)) continue;
        close();
        const item = { id: o.uuid || ('u' + ev.length), kind: 'user', text };
        if (nImg) item.images = Array.from({ length: nImg }, () => ({ label: 'Imagem' }));
        ev.push({ t: 'item', item });
        turn = { start: ts, last: ts };
        ev.push({ t: 'turn', state: 'start', history: true });
        continue;
      }
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || b.type !== 'tool_result') continue;
          const t = tools.get(b.tool_use_id);
          if (!t) continue;
          const v = claudeToolView(t.name, t.input);
          const editDetail = claudeEditDetail(t.name, t.input);
          ev.push({ t: 'item', item: { id: b.tool_use_id, kind: 'tool', icon: v.icon, label: v.label,
            detail: clip(editDetail && !b.is_error ? editDetail : toolResultText(b.content)),
            status: b.is_error ? 'error' : 'done' } });
        }
        if (turn && ts) turn.last = ts;
      }
    } else if (o.type === 'assistant') {
      if (!turn) continue;
      if (ts) turn.last = ts;
      const content = Array.isArray(msg.content) ? msg.content : [];
      content.forEach((b, i) => {
        const id = `${msg.id || o.uuid}:${i}`;
        if (b.type === 'text' && b.text) ev.push({ t: 'item', item: { id, kind: 'text', text: b.text } });
        else if (b.type === 'tool_use' && !HIDDEN_TOOLS.has(b.name)) {
          tools.set(b.id, { name: b.name, input: b.input || {} });
          const v = claudeToolView(b.name, b.input);
          ev.push({ t: 'item', item: { id: b.id, kind: 'tool', icon: v.icon, label: v.label, detail: claudeEditDetail(b.name, b.input), status: 'done' } });
        }
      });
    }
  }
  close();
  return ev;
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex (app-server)
// ─────────────────────────────────────────────────────────────────────────────

function stripShell(cmd) {
  const s = String(cmd || '');
  const m = s.match(/^\/bin\/(?:ba|z)?sh -lc (.*)$/s);
  if (!m) return s;
  let inner = m[1].trim();
  return inner.replace(/^['"]/, '').replace(/['"]$/, '');
}

/** Item do Codex → item do pane (ou null quando não é mostrado). */
function codexItemView(it, done) {
  if (!it || !it.type) return null;
  const st = (s) => (s === 'failed' || s === 'declined') ? 'error' : (done ? 'done' : 'running');
  switch (it.type) {
    case 'userMessage': {
      const content = it.content || [];
      const text = content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
      const images = content.filter(c => c && (c.type === 'localImage' || c.type === 'image'))
        .map(c => c.type === 'localImage' ? { path: c.path } : { label: 'Imagem' });
      return images.length ? { id: it.id, kind: 'user', text, images } : { id: it.id, kind: 'user', text };
    }
    case 'agentMessage':
      return { id: it.id, kind: 'text', text: it.text || '', final: it.phase === 'final_answer' };
    case 'reasoning': {
      const text = [].concat(it.summary || []).join('\n\n');
      return { id: it.id, kind: 'reasoning', text };
    }
    case 'commandExecution': {
      const acts = Array.isArray(it.commandActions) ? it.commandActions : [];
      const cmd = stripShell(it.command);
      let icon = 'cmd';
      let label = 'Comando executado: ' + oneLine(cmd, 200);
      if (acts.length && acts.every(a => a.type === 'read')) {
        icon = 'read';
        label = 'Leu ' + acts.map(a => a.name || base(a.path)).join(', ');
      } else if (acts.length === 1 && acts[0].type === 'listFiles') {
        icon = 'list';
        label = 'Arquivos listados' + (acts[0].path ? ' em ' + base(acts[0].path) : '');
      } else if (acts.length === 1 && acts[0].type === 'search') {
        icon = 'search';
        label = 'Buscou por ' + oneLine(acts[0].query || cmd, 120);
      }
      if (!done) label = label.replace(/^Comando executado:/, 'Executando:');
      return { id: it.id, kind: 'tool', icon, label, detail: clip(it.aggregatedOutput || ''), status: st(it.status) };
    }
    case 'fileChange': {
      const ch = Array.isArray(it.changes) ? it.changes : [];
      const verb = ch.length && ch.every(c => c.kind && c.kind.type === 'add') ? 'Criou ' : 'Editou ';
      return { id: it.id, kind: 'tool', icon: 'edit', label: verb + ch.map(c => base(c.path)).join(', '),
        detail: clip(ch.map(c => c.diff || '').join('\n')), status: st(it.status) };
    }
    case 'mcpToolCall': {
      const res = it.result && Array.isArray(it.result.content) ? toolResultText(it.result.content) : '';
      const err = it.error && it.error.message;
      return { id: it.id, kind: 'tool', icon: 'mcp', label: `Usou ${it.tool} (${it.server})`,
        detail: clip(err || res), status: err ? 'error' : st(it.status) };
    }
    case 'webSearch':
      return { id: it.id, kind: 'tool', icon: 'web', label: 'Pesquisou ' + oneLine(it.query || '', 120), detail: '', status: done ? 'done' : 'running' };
    case 'imageView':
      return { id: it.id, kind: 'tool', icon: 'image', label: 'Visualizou ' + base(it.path), detail: '', status: done ? 'done' : 'running' };
    case 'dynamicToolCall':
      return { id: it.id, kind: 'tool', icon: 'tool', label: String(it.tool || it.name || 'ferramenta'), detail: '', status: st(it.status) };
    case 'collabAgentToolCall':
      return { id: it.id, kind: 'tool', icon: 'agent', label: 'Subagente', detail: '', status: done ? 'done' : 'running' };
    case 'contextCompaction':
      return { id: it.id, kind: 'notice', text: 'Contexto compactado' };
    default:
      return null;   // plan, hookPrompt, sleep, review… não aparecem no pane
  }
}

function createCodexTranslator() {
  let threadId = null;
  let turnStart = 0;

  /** Notificação JSON-RPC (sem id) → eventos. */
  function feed(m) {
    const out = [];
    if (!m || !m.method) return out;
    const p = m.params || {};
    if (threadId && p.threadId && p.threadId !== threadId) return out; // subagente / outra thread
    switch (m.method) {
      case 'thread/started':
        if (p.thread && p.thread.id && !threadId) {
          threadId = p.thread.id;
          out.push({ t: 'session', sessionId: threadId, model: p.thread.model || null });
        }
        break;
      case 'turn/started':
        turnStart = Date.now();
        out.push({ t: 'turn', state: 'start' });
        break;
      case 'turn/completed': {
        const turn = p.turn || {};
        const durationMs = typeof turn.durationMs === 'number' ? turn.durationMs : (turnStart ? Date.now() - turnStart : 0);
        const interrupted = turn.status === 'interrupted';
        const error = turn.status === 'failed' ? ((turn.error && turn.error.message) || 'falhou') : null;
        out.push({ t: 'turn', state: 'end', durationMs, error, interrupted });
        break;
      }
      case 'item/started':
      case 'item/completed': {
        // O prompt já está na tela (o pane desenha ao enviar); o eco não entra.
        if (p.item && p.item.type === 'userMessage') break;
        const v = codexItemView(p.item, m.method === 'item/completed');
        if (v && v.kind === 'notice') out.push({ t: 'notice', level: 'info', text: v.text });
        else if (v) out.push({ t: 'item', item: v });
        break;
      }
      case 'item/agentMessage/delta':
        if (p.itemId && p.delta) out.push({ t: 'delta', id: p.itemId, kind: 'text', text: p.delta });
        break;
      case 'item/reasoning/summaryTextDelta':
        if (p.itemId && p.delta) out.push({ t: 'delta', id: p.itemId, kind: 'reasoning', text: p.delta });
        break;
      case 'item/reasoning/summaryPartAdded':
        if (p.itemId) out.push({ t: 'delta', id: p.itemId, kind: 'reasoning', text: '\n\n' });
        break;
      case 'error':
        if (p.error && p.error.message && !p.willRetry) out.push({ t: 'notice', level: 'error', text: p.error.message });
        break;
      case 'thread/tokenUsage/updated': {
        const tu = p.tokenUsage || {};
        const last = tu.last || {};
        if (typeof last.totalTokens === 'number') out.push({ t: 'usage', used: last.totalTokens, window: tu.modelContextWindow || 0, costUsd: null });
        break;
      }
      case 'model/rerouted':
        if (p.toModel) out.push({ t: 'notice', level: 'info', text: 'Modelo trocado para ' + p.toModel });
        break;
      default: break;
    }
    return out;
  }

  return {
    feed,
    setThread(id) { threadId = id; },
    get threadId() { return threadId; },
  };
}

/** Turnos de `thread/turns/list` (itemsView full, ordem crescente) → eventos. */
function codexHistoryEvents(turns) {
  const ev = [];
  for (const turn of turns || []) {
    const items = Array.isArray(turn.items) ? turn.items : [];
    let opened = false;
    for (const it of items) {
      const v = codexItemView(it, true);
      if (!v) continue;
      if (v.kind === 'user') {
        ev.push({ t: 'item', item: v });
        if (!opened) { ev.push({ t: 'turn', state: 'start', history: true }); opened = true; }
        continue;
      }
      if (!opened) { ev.push({ t: 'turn', state: 'start', history: true }); opened = true; }
      if (v.kind === 'notice') ev.push({ t: 'notice', level: 'info', text: v.text });
      else ev.push({ t: 'item', item: v });
    }
    if (opened) {
      ev.push({ t: 'turn', state: 'end', history: true,
        durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : 0,
        error: turn.status === 'failed' ? ((turn.error && turn.error.message) || 'falhou') : null,
        interrupted: turn.status === 'interrupted' });
    }
  }
  return ev;
}

/** Pedido de aprovação do app-server → evento do pane (null = não tratado). */
function codexApprovalView(method, params) {
  const p = params || {};
  if (method === 'item/commandExecution/requestApproval') {
    return { kind: 'cmd', label: 'Executar comando?', detail: stripShell(p.command || '') + (p.reason ? '\n\n' + p.reason : '') };
  }
  if (method === 'item/fileChange/requestApproval') {
    return { kind: 'patch', label: 'Aplicar alteração em arquivos?', detail: p.reason || '' };
  }
  return null;
}

module.exports = {
  createClaudeTranslator,
  claudeUserLine,
  claudePermissionLine,
  claudeApprovalView,
  claudeResultUsage,
  claudeCommandOptions,
  CLAUDE_ACCESS,
  CODEX_COMMANDS,
  claudeInterruptLine,
  claudeControlLine,
  claudeModelOptions,
  codexModelOptions,
  CODEX_ACCESS,
  codexAccessOf,
  claudeHistoryEvents,
  claudeToolView,
  createCodexTranslator,
  codexItemView,
  codexHistoryEvents,
  codexApprovalView,
  stripShell,
};
