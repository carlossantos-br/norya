/**
 * renderer/chat.js — pane em modo CHAT (2026-10-11).
 *
 * Script CLÁSSICO (ver renderer/state.js). Expõe `window.NoryaChat`.
 *
 * O pane pode abrir como TUI (xterm + PTY, o de sempre) ou como chat: a CLI
 * roda em modo protocolo (chat/chat-session.js no main) e este arquivo desenha a
 * conversa no estilo do app do Codex — bolha do usuário à direita, resposta
 * solta, "Trabalhou por Xm Ys" recolhendo o trabalho do turno, ferramentas em
 * grupos ("Leu arquivos e executou comandos"). Sem lista de tarefas/plano.
 *
 * Modelo × vista: o MODELO (st.chat[spawnId]) nasce no launchTerminal e recebe
 * todos os eventos, com ou sem pane na tela. A VISTA é montada/desmontada pelo
 * grid (buildGridCell / disposeGridCellXterm) e se redesenha a partir do modelo.
 */
'use strict';

(() => {
  const { ipcRenderer, webUtils } = require('electron');

  const models = {};   // spawnId → modelo
  const views = {};    // spawnId → vista montada

  // ── Modelo ────────────────────────────────────────────────────────────────
  function newModel(spawnId, agentId) {
    return {
      spawnId, agentId,
      sessionId: null, model: null,
      config: null,          // { models, model, effort, access, accessOptions, commands } — seletor do composer
      ready: false, busy: false, exited: false,
      blocks: [],            // { key, type:'user'|'turn'|'notice', ... }
      queue: [],             // mensagens na fila (turno rodando): { key, text, attachments }
      draft: '',             // texto do composer — sobrevive à remontagem da vista
      attachments: [],       // anexos do composer: { path, name, image }
      usage: null,           // { used, window, costUsd } — contexto em uso
      turn: null,            // turno aberto
      items: new Map(),      // id → item (texto/tool/raciocínio) — global ao pane
      itemTurn: new Map(),   // id → bloco de turno dono (o steer divide o turno na tela)
      approvals: new Map(),  // reqId → { label, detail, kind }
      pendingInput: '',      // api.sendInput em pedaços (Mini, composer antigo)
      onSession: [],         // callbacks do latch
      seq: 0,
      rev: 0,
    };
  }

  function attach(spawnId, agentId) {
    detach(spawnId);
    const m = newModel(spawnId, agentId);
    models[spawnId] = m;
    const ch = `chat-event-${spawnId}`;
    m.listener = (_, ev) => { try { onEvent(m, ev); } catch (e) { console.warn('[chat] evento', e, ev); } };
    ipcRenderer.on(ch, m.listener);
    m.exitListener = () => {
      m.exited = true; m.busy = false; closeTurnIfOpen(m, null);
      // Processo morto: aprovação não tem quem responda; a fila volta pro
      // rascunho (dá pra copiar ao reabrir a task) em vez de ficar clicável.
      m.approvals.clear();
      if (m.queue.length) { m.draft = m.queue.map(q => q.text).concat(m.draft ? [m.draft] : []).join('\n\n'); m.queue = []; }
      const v = views[spawnId];
      if (v) { v.ta.value = m.draft; v.autosize(); }
      touch(m);
    };
    ipcRenderer.on(`terminal-exit-${spawnId}`, m.exitListener);
    return m;
  }

  function detach(spawnId) {
    const m = models[spawnId];
    if (!m) return;
    try { ipcRenderer.removeListener(`chat-event-${spawnId}`, m.listener); } catch {}
    try { ipcRenderer.removeListener(`terminal-exit-${spawnId}`, m.exitListener); } catch {}
    delete models[spawnId];
  }

  function key(m, p) { return p + (++m.seq); }

  function touch(m, block) {
    m.rev++;
    if (block) block.rev = (block.rev || 0) + 1;
    const v = views[m.spawnId];
    if (v) v.schedule();
    if (typeof updateGridCellById === 'function') { try { updateGridCellById(m.spawnId); } catch {} }
  }

  function openTurn(m, history) {
    if (m.turn) return m.turn;
    const t = { key: key(m, 't'), type: 'turn', ids: [], startedAt: Date.now(), durationMs: null,
      running: !history, error: null, interrupted: false, open: false, groupsOpen: {}, rev: 0 };
    m.blocks.push(t);
    m.turn = t;
    return t;
  }

  function closeTurnIfOpen(m, ev) {
    const t = m.turn;
    if (!t) return;
    t.running = false;
    t.durationMs = ev && typeof ev.durationMs === 'number' ? ev.durationMs : (Date.now() - t.startedAt);
    t.error = ev && ev.error || null;
    t.interrupted = !!(ev && ev.interrupted);
    // Item que ficou "rodando" (processo morreu, interrompido) não gira pra sempre.
    // Inclui os do bloco que o steer fechou só na tela (dono diferente de t).
    for (const [id, it] of m.items) {
      if (it.status !== 'running') continue;
      it.status = t.error ? 'error' : 'done';
      const owner = m.itemTurn.get(id);
      if (owner && owner !== t) touch(m, owner);
    }
    m.turn = null;
    touch(m, t);
  }

  function addUser(m, text, history, images, files) {
    const b = { key: key(m, 'u'), type: 'user', text, rev: 0, history: !!history,
      images: images && images.length ? images : null, files: files && files.length ? files : null };
    m.blocks.push(b);
    touch(m, b);
    return b;
  }

  function upsertItem(m, item, history) {
    const owner = m.itemTurn.get(item.id);
    const t = owner || m.turn || openTurn(m, history);
    const cur = m.items.get(item.id);
    if (cur) {
      // Texto em streaming: o `item` final (Codex item/completed) traz o texto
      // inteiro — substitui. Vazio não apaga o que os deltas já escreveram.
      for (const k of Object.keys(item)) {
        if (k === 'text' && !item.text && cur.text) continue;
        cur[k] = item[k];
      }
      if (!t.ids.includes(item.id)) t.ids.push(item.id);
    } else {
      m.items.set(item.id, Object.assign({}, item));
      t.ids.push(item.id);
    }
    m.itemTurn.set(item.id, t);
    touch(m, t);
  }

  function onEvent(m, ev, history) {
    switch (ev.t) {
      case 'history':
        // Histórico ao reabrir: entra antes de qualquer coisa nova.
        for (const e of ev.events || []) onEvent(m, e, true);
        break;
      case 'config':
        m.config = { models: ev.models || [], model: ev.model || null, effort: ev.effort || null, access: ev.access || null,
          accessOptions: ev.accessOptions || null, commands: ev.commands || [] };
        touch(m);
        break;
      case 'usage':
        m.usage = { used: ev.used || 0, window: ev.window || 0, costUsd: ev.costUsd != null ? ev.costUsd : null };
        touch(m);
        break;
      case 'ready':
        m.ready = true; touch(m);
        break;
      case 'session':
        m.sessionId = ev.sessionId;
        if (ev.model) m.model = ev.model;
        touch(m);
        for (const fn of m.onSession.splice(0)) { try { fn(ev.sessionId, ev); } catch (e) { console.warn('[chat] latch', e); } }
        break;
      case 'turn':
        if (ev.state === 'start') { openTurn(m, history || ev.history); if (!history && !ev.history) m.busy = true; touch(m); }
        else {
          closeTurnIfOpen(m, ev);
          if (!history && !ev.history) { m.busy = false; refreshTitleSoon(m); drainQueueSoon(m); }
          touch(m);
        }
        break;
      case 'item':
        if (!ev.item || !ev.item.id) break;
        if (ev.item.kind === 'user') { if (m.turn && !history) break; closeTurnIfOpen(m, null); addUser(m, ev.item.text || '', true, ev.item.images); break; }
        upsertItem(m, ev.item, history || ev.history);
        break;
      case 'delta': {
        let it = m.items.get(ev.id);
        if (!it) { upsertItem(m, { id: ev.id, kind: ev.kind || 'text', text: '' }); it = m.items.get(ev.id); }
        it.text = (it.text || '') + (ev.text || '');
        touch(m, m.itemTurn.get(ev.id) || m.turn);
        break;
      }
      case 'notice': {
        const b = { key: key(m, 'n'), type: 'notice', level: ev.level || 'info', text: ev.text || '', rev: 0 };
        m.blocks.push(b);
        touch(m, b);
        break;
      }
      case 'approval':
        m.approvals.set(ev.reqId, { kind: ev.kind, label: ev.label, detail: ev.detail });
        touch(m);
        break;
      case 'approval-done':
        m.approvals.delete(ev.reqId);
        touch(m);
        break;
      default: break;
    }
  }

  // Fim de turno: o título da task (list-threads) só existe depois que a CLI
  // grava a sessão — pede uma releitura se a linha ainda não chegou.
  let titleTimer = null;
  function refreshTitleSoon(m) {
    if (!m.sessionId || (st.allThreads || []).some(t => t.id === m.sessionId)) return;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => { if (typeof refreshThreads === 'function') refreshThreads().catch(() => {}); }, 600);
  }

  // ── Ações ─────────────────────────────────────────────────────────────────
  /**
   * Envia (ou enfileira). Com turno rodando a mensagem espera na fila do pane,
   * como no app do Codex — dá pra editar, tirar ou mandar já ("Enviar agora" =
   * steer: entra no turno atual). A fila anda sozinha no fim de cada turno.
   */
  function send(spawnId, text, opts) {
    const m = models[spawnId];
    opts = opts || {};
    text = String(text || '').replace(/\s+$/, '');
    const att = Array.isArray(opts.attachments) ? opts.attachments.slice() : [];
    if (!m || (!text.trim() && !att.length) || m.exited) return false;
    rememberPrompt(text);
    if (m.busy && !opts.steer) {
      m.queue.push({ key: key(m, 'q'), text, attachments: att });
      touch(m);
    } else {
      dispatch(m, text, att, m.busy);
    }
    const v = views[spawnId];
    if (v) v.stickToBottom = true;
    return true;
  }

  function dispatch(m, text, att, steer) {
    const images = att.filter(a => a.image).map(a => ({ path: a.path }));
    const files = att.filter(a => !a.image).map(a => a.name || a.path);
    if (steer) {
      // A resposta ao steer tem que sair embaixo da bolha: o bloco do turno
      // corrente fecha só na tela (busy continua) e um novo abre depois dela.
      const t = m.turn;
      if (t) { t.running = false; t.durationMs = Date.now() - t.startedAt; m.turn = null; touch(m, t); }
      addUser(m, text, false, images, files);
      openTurn(m, false);
    } else {
      closeTurnIfOpen(m, null);
      addUser(m, text, false, images, files);
      // O turno nasce já: o pane mostra "Trabalhando…" sem esperar o 1º byte.
      openTurn(m, false);
      m.busy = true;
    }
    touch(m);
    ipcRenderer.send('chat-send', { id: m.spawnId, text, steer: !!steer,
      attachments: att.map(a => ({ path: a.path, image: !!a.image })) });
    try { if (typeof noteUserInput === 'function') noteUserInput(m.spawnId); } catch {}
  }

  function drainQueueSoon(m) {
    if (!m.queue.length) return;
    setTimeout(() => {
      if (models[m.spawnId] !== m || m.busy || m.exited || !m.queue.length) return;
      const q = m.queue.shift();
      dispatch(m, q.text, q.attachments, false);
    }, 0);
  }

  function queueAction(spawnId, qkey, action) {
    const m = models[spawnId];
    if (!m) return;
    const i = m.queue.findIndex(q => q.key === qkey);
    if (i < 0 || (m.exited && action === 'now')) return;
    const [q] = m.queue.splice(i, 1);
    if (action === 'now') {
      if (m.busy) dispatch(m, q.text, q.attachments, true);
      else dispatch(m, q.text, q.attachments, false);
    } else if (action === 'edit') {
      // Volta pro composer (na frente do que já estava escrito).
      m.draft = q.text + (m.draft ? '\n' + m.draft : '');
      m.attachments = q.attachments.concat(m.attachments);
      const v = views[spawnId];
      if (v) { v.ta.value = m.draft; v.autosize(); v.renderAttachments(); v.ta.focus(); }
    }
    touch(m);
  }

  // ── Histórico de prompts (↑/↓ no composer vazio) — global entre panes ─────
  const HIST_KEY = 'norya-chat-history';
  function promptHistory() {
    try { const a = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  function rememberPrompt(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const a = promptHistory().filter(x => x !== t);
    a.push(t);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(a.slice(-200))); } catch {}
  }

  // ── Anexos ────────────────────────────────────────────────────────────────
  const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
  function addAttachments(spawnId, paths) {
    const m = models[spawnId];
    if (!m || m.exited) return;
    for (const p of paths || []) {
      if (!p || m.attachments.some(a => a.path === p)) continue;
      m.attachments.push({ path: p, name: p.slice(p.lastIndexOf('/') + 1), image: IMAGE_RE.test(p) });
    }
    const v = views[spawnId];
    if (v) v.renderAttachments();
  }

  /** Arquivos de um paste/drop: com caminho (Finder) vão direto; sem caminho (print, imagem copiada) viram arquivo. */
  async function filesToPaths(fileList) {
    const out = [];
    for (const f of Array.from(fileList || [])) {
      let p = '';
      try { p = webUtils.getPathForFile(f) || ''; } catch {}
      if (p) { out.push(p); continue; }
      if (!/^image\//.test(f.type || '')) continue;
      try {
        const data = new Uint8Array(await f.arrayBuffer());
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const saved = await ipcRenderer.invoke('chat-save-attachment', { name: (f.name && f.name !== 'image.png' ? f.name : 'imagem.' + ext), data });
        if (saved) out.push(saved);
      } catch (e) { console.warn('[chat] anexo', e); }
    }
    return out;
  }

  // URL de arquivo pelo próprio Node do renderer: no Windows `C:\x\a.png` vira
  // `file:///C:/x/a.png` (o split('/') antigo gerava `file://C%3A%5Cx…`).
  const fileUrl = p => {
    try { return require('url').pathToFileURL(String(p)).href; }
    catch { return 'file://' + String(p).split('/').map(encodeURIComponent).join('/'); }
  };

  function interrupt(spawnId) {
    const m = models[spawnId];
    if (!m || !m.busy) return;
    ipcRenderer.send('chat-interrupt', spawnId);
  }

  /**
   * Ponte do api.sendInput (bytes de terminal) → chat. Quem escreve "texto +
   * Enter" num pane (Mini/pet, composer, agente de merge) continua funcionando
   * sem saber que o pane é chat. Esc = parar.
   */
  function input(spawnId, data) {
    const m = models[spawnId];
    if (!m) return;
    data = String(data || '');
    if (data === '\x1b' || data === '\x03') { interrupt(spawnId); return; }
    data = data.replace(/\x1b\[20[01]~/g, '');
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const t = m.pendingInput; m.pendingInput = '';
        if (t.trim()) send(spawnId, t);
      } else if (ch === '\x7f') {
        m.pendingInput = m.pendingInput.slice(0, -1);
      } else if (ch >= ' ' || ch === '\t') {
        m.pendingInput += ch;
      }
    }
  }

  /** Seletor do composer: troca modelo / esforço / acesso da sessão ao vivo. */
  function configure(spawnId, patch) {
    const m = models[spawnId];
    if (!m || m.exited || !patch) return;
    // Otimista: o rótulo muda na hora; o main confirma com um 'config' novo.
    m.config = Object.assign({ models: [], model: null, effort: null, access: null }, m.config);
    if (patch.model) {
      m.config.model = patch.model;
      const opt = findModel(m.config, patch.model);
      if (opt && opt.efforts.length && m.config.effort && !opt.efforts.includes(m.config.effort)) m.config.effort = opt.defaultEffort || null;
    }
    if (patch.effort) m.config.effort = patch.effort;
    if (patch.access) m.config.access = patch.access;
    touch(m);
    ipcRenderer.send('chat-config', Object.assign({ id: spawnId }, patch));
  }

  function findModel(cfg, id) {
    if (!cfg || !id) return null;
    return cfg.models.find(o => o.value === id || o.resolved === id) || null;
  }

  const EFFORT_LABEL = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo' };
  const effortLabel = e => EFFORT_LABEL[e] || (e ? e.charAt(0).toUpperCase() + e.slice(1) : '');
  const ACCESS = [
    { value: 'full', label: 'Acesso total', desc: 'Edita e roda comandos sem pedir', full: true },
    { value: 'ask', label: 'Padrão', desc: 'Escreve na pasta; pede aprovação pro resto' },
    { value: 'readonly', label: 'Só leitura', desc: 'Lê e pede aprovação pra qualquer mudança' },
  ];

  // ── Menu do seletor (um só, flutuando no body; fecha ao clicar fora/Esc) ──
  let menuEl = null;
  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    if (menuEl._trigger) menuEl._trigger.classList.remove('is-open');
    menuEl = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  }
  function onDocDown(e) { if (menuEl && !menuEl.contains(e.target) && !(menuEl._trigger && menuEl._trigger.contains(e.target))) closeMenu(); }
  function onDocKey(e) { if (e.key === 'Escape' && menuEl) { e.preventDefault(); e.stopPropagation(); closeMenu(); } }

  /** sections: [{ title, items:[{ label, desc, on, pick }] }] */
  function openMenu(trigger, sections) {
    const reopen = menuEl && menuEl._trigger === trigger;
    closeMenu();
    if (reopen) return;
    const menu = el('div', 'cm-menu');
    for (const sec of sections) {
      if (!sec.items.length) continue;
      if (sec.title) menu.appendChild(el('div', 'cm-menu-title', sec.title));
      for (const it of sec.items) {
        const row = el('button', 'cm-menu-item' + (it.on ? ' is-on' : ''));
        row.type = 'button';
        const txt = el('span', 'cm-menu-txt');
        txt.appendChild(el('span', 'cm-menu-label', it.label));
        if (it.desc) txt.appendChild(el('span', 'cm-menu-desc', it.desc));
        if (it.tip) row.title = it.tip;
        row.append(txt);
        if (it.on) row.appendChild(icon('check', 'cm-menu-check'));
        row.addEventListener('click', e => { e.stopPropagation(); closeMenu(); it.pick(); });
        menu.appendChild(row);
      }
    }
    menu._trigger = trigger;
    trigger.classList.add('is-open');
    document.body.appendChild(menu);
    // Acima do botão, alinhado pela borda direita (ou esquerda) do botão.
    const r = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = trigger.dataset.align === 'left' ? r.left : r.right - mw;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    let top = r.top - mh - 6;
    if (top < 8) top = Math.min(r.bottom + 6, window.innerHeight - mh - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menuEl = menu;
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }

  function openModelMenu(spawnId, trigger) {
    const m = models[spawnId];
    if (!m || !m.config) return;
    const cfg = m.config;
    const cur = findModel(cfg, cfg.model);
    // Esforço em cima (troca mais comum), modelos embaixo só com o nome — a
    // descrição vira tooltip, senão a lista do claude passa da altura do pane.
    const efforts = cur ? cur.efforts : [];
    openMenu(trigger, [{
      title: 'Esforço',
      items: efforts.map(e => ({
        label: effortLabel(e), on: cfg.effort === e,
        pick: () => configure(spawnId, { effort: e }),
      })),
    }, {
      title: 'Modelo',
      items: cfg.models.map(o => ({
        label: o.label, tip: o.desc, on: cur ? cur === o : false,
        pick: () => configure(spawnId, { model: o.value }),
      })),
    }]);
  }

  function openAccessMenu(spawnId, trigger) {
    const m = models[spawnId];
    if (!m || !m.config) return;
    openMenu(trigger, [{
      title: 'Acesso',
      items: accessOptions(m.config).map(a => ({ label: a.label, desc: a.desc, on: m.config.access === a.value,
        pick: () => configure(spawnId, { access: a.value }) })),
    }]);
  }

  const accessOptions = cfg => (cfg && cfg.accessOptions && cfg.accessOptions.length ? cfg.accessOptions : ACCESS);

  function approve(spawnId, reqId, ok) {
    ipcRenderer.send('chat-approve', { id: spawnId, reqId, ok: !!ok });
    const m = models[spawnId];
    if (m) { m.approvals.delete(reqId); touch(m); }
  }

  // ── Markdown (mínimo, sem innerHTML de conteúdo) ──────────────────────────
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  function openUrl(url) {
    if (/^https?:\/\//i.test(url)) ipcRenderer.send('chat-open-url', url);
  }

  function inline(parent, text) {
    // Ordem: código, link markdown, URL solta, negrito, itálico.
    const re = /(`+)([^`]+?)\1|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2] != null) parent.appendChild(el('code', 'cm-code', m[2]));
      else if (m[3] != null) {
        const a = el('a', 'cm-link', m[3]);
        const href = m[4];
        a.href = '#';
        a.title = href;
        a.addEventListener('click', e => { e.preventDefault(); openUrl(href); });
        parent.appendChild(a);
      } else if (m[5] != null) {
        const a = el('a', 'cm-link', m[5]);
        a.href = '#';
        a.addEventListener('click', e => { e.preventDefault(); openUrl(m[5]); });
        parent.appendChild(a);
      } else if (m[6] != null || m[7] != null) {
        const b = el('strong');
        inline(b, m[6] != null ? m[6] : m[7]);
        parent.appendChild(b);
      } else if (m[8] != null || m[9] != null) {
        const i = el('em');
        inline(i, m[8] != null ? m[8] : m[9]);
        parent.appendChild(i);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function codeBlock(lang, code) {
    const box = el('div', 'cm-pre');
    const head = el('div', 'cm-pre-head');
    head.appendChild(el('span', 'cm-pre-lang', lang || 'Texto simples'));
    const copy = el('button', 'cm-pre-copy', 'Copiar');
    copy.type = 'button';
    copy.addEventListener('click', e => {
      e.stopPropagation();
      try { require('electron').clipboard.writeText(code); copy.textContent = 'Copiado'; setTimeout(() => { copy.textContent = 'Copiar'; }, 1200); } catch {}
    });
    head.appendChild(copy);
    const pre = el('pre');
    pre.appendChild(el('code', null, code));
    box.append(head, pre);
    return box;
  }

  function renderMarkdown(text) {
    const root = el('div', 'cm-md');
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    let para = [];
    const flushPara = () => {
      if (!para.length) return;
      const p = el('p');
      para.forEach((l, k) => { if (k) p.appendChild(el('br')); inline(p, l); });
      root.appendChild(p);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
      if (fence) {
        flushPara();
        const close = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(close)) { buf.push(lines[i]); i++; }
        i++;
        root.appendChild(codeBlock(fence[2], buf.join('\n')));
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        const n = el('div', 'cm-h cm-h' + Math.min(h[1].length, 4));
        inline(n, h[2]);
        root.appendChild(n);
        i++; continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); root.appendChild(el('hr')); i++; continue; }
      if (/^\s*>/.test(line)) {
        flushPara();
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        const bq = el('blockquote');
        bq.appendChild(renderMarkdown(q.join('\n')));
        root.appendChild(bq);
        continue;
      }
      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flushPara();
        const ordered = /\d/.test(li[2]);
        const list = el(ordered ? 'ol' : 'ul');
        if (ordered) list.start = parseInt(li[2], 10) || 1;
        const baseIndent = li[1].length;
        while (i < lines.length) {
          const mm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (mm && mm[1].length <= baseIndent + 1) {
            const item = el('li');
            inline(item, mm[3]);
            list.appendChild(item);
            i++;
          } else if (mm || (lines[i].trim() && /^\s{2,}/.test(lines[i]))) {
            // Sub-item / continuação: entra no último item, recuado.
            const last = list.lastElementChild;
            const sub = el('div', 'cm-sub');
            inline(sub, lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, '• '));
            if (last) last.appendChild(sub);
            i++;
          } else break;
        }
        root.appendChild(list);
        continue;
      }
      // Tabela simples (| a | b |): vira bloco monoespaçado — legível e barato.
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        root.appendChild(renderTable(buf));
        continue;
      }
      if (!line.trim()) { flushPara(); i++; continue; }
      para.push(line);
      i++;
    }
    flushPara();
    return root;
  }

  function renderTable(rows) {
    const wrap = el('div', 'cm-table-wrap');
    const table = el('table', 'cm-table');
    const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    rows.forEach((r, k) => {
      if (k === 1) return;   // separador
      const tr = el('tr');
      for (const c of cells(r)) { const td = el(k === 0 ? 'th' : 'td'); inline(td, c); tr.appendChild(td); }
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    return wrap;
  }

  // ── Ícones (traço fino, como o app do Codex) ──────────────────────────────
  const ICONS = {
    cmd: ['M2.5 3.5h11v9h-11z', 'M5 7l1.8 1.5L5 10', 'M8.5 10h2.5'],
    read: ['M3 3.5h4.2c.9 0 .8.6.8 1.4V13c0-.7-.5-1.1-1.2-1.1H3z', 'M13 3.5H8.8C7.9 3.5 8 4.1 8 4.9V13c0-.7.5-1.1 1.2-1.1H13z'],
    edit: ['M10.5 3l2.5 2.5L6 12.5H3.5V10z', 'M9 4.5L11.5 7'],
    search: ['M7 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M10 10l3 3'],
    list: ['M2.5 5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z'],
    web: ['M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z', 'M2.5 8h11', 'M8 2.5c1.6 1.6 2.2 3.4 2.2 5.5S9.6 11.9 8 13.5C6.4 11.9 5.8 10.1 5.8 8S6.4 4.1 8 2.5z'],
    mcp: ['M6 2.5v3', 'M10 2.5v3', 'M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0z', 'M8 11.5v2'],
    agent: ['M8 3a2.2 2.2 0 1 1 0 4.4A2.2 2.2 0 0 1 8 3z', 'M3.5 13c.6-2.3 2.3-3.6 4.5-3.6s3.9 1.3 4.5 3.6'],
    image: ['M2.5 3.5h11v9h-11z', 'M2.5 10.5l3-3 3 3 2-2 3 3', 'M10.5 6a.5.5 0 1 1 0 .01'],
    tool: ['M9.8 2.8a3 3 0 0 0-3.4 4L3 10.2 4.8 12l3.4-3.4a3 3 0 0 0 4-3.4l-1.8 1.8-1.6-.4-.4-1.6z'],
    chevron: ['M6 4l4 4-4 4'],
    check: ['M3.5 8.5l3 3 6-7'],
    shield: ['M8 2.5l4.5 1.7v3.6c0 2.8-1.9 4.9-4.5 5.7-2.6-.8-4.5-2.9-4.5-5.7V4.2z'],
    clip: ['M10.8 4.6L5.9 9.5a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.3-4.3'],
    file: ['M4 2.5h5l3 3v8H4z', 'M9 2.5v3h3'],
    x: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
    slash: ['M10 3L6 13'],
  };
  function icon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.3');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'cm-ico' + (cls ? ' ' + cls : ''));
    for (const d of (ICONS[name] || ICONS.tool)) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  // ── Textos ────────────────────────────────────────────────────────────────
  function fmtDur(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  /** "Leu arquivos e executou comandos" — a partir dos tipos de tool do grupo. */
  function groupLabel(tools) {
    const c = {};
    for (const t of tools) c[t.icon] = (c[t.icon] || 0) + 1;
    const parts = [];
    if (c.read) parts.push(c.read > 1 ? 'leu arquivos' : 'leu um arquivo');
    if (c.edit) parts.push(c.edit > 1 ? 'editou arquivos' : 'editou um arquivo');
    if (c.cmd) parts.push(c.cmd > 1 ? 'executou comandos' : 'executou um comando');
    if (c.search) parts.push(c.search > 1 ? 'fez buscas' : 'fez uma busca');
    if (c.list) parts.push('listou arquivos');
    if (c.web) parts.push('pesquisou na web');
    if (c.image) parts.push(c.image > 1 ? `visualizou ${c.image} imagens` : 'visualizou uma imagem');
    if (c.agent) parts.push(c.agent > 1 ? 'usou subagentes' : 'usou um subagente');
    if (c.mcp || c.tool) parts.push('usou ferramentas');
    let s;
    if (parts.length <= 1) s = parts[0] || 'trabalhou';
    else s = parts.slice(0, -1).join(', ') + ' e ' + parts[parts.length - 1];
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function agentName(m) { return m.agentId === 'codex' ? 'Codex' : 'Claude'; }

  // ── Vista ─────────────────────────────────────────────────────────────────
  function mount(spawnId, container) {
    unmount(spawnId);
    const m = models[spawnId];
    container.textContent = '';
    container.classList.add('grid-cell-chat');
    const root = el('div', 'cm-root');
    const scroller = el('div', 'cm-scroll');
    const thread = el('div', 'cm-thread');
    scroller.appendChild(thread);
    const toBottom = el('button', 'cm-tobottom');
    toBottom.type = 'button';
    toBottom.title = 'Ir para o fim';
    toBottom.appendChild(icon('chevron', 'cm-ico-down'));
    toBottom.hidden = true;

    // Composer
    const composer = el('div', 'cm-composer');
    const attachRow = el('div', 'cm-attach');
    attachRow.hidden = true;
    const ac = el('div', 'cm-ac');   // autocompletar de "/" e "@"
    ac.hidden = true;
    const ta = el('textarea', 'cm-input');
    ta.rows = 1;
    ta.placeholder = m && m.agentId === 'codex' ? 'Trabalhe com o Codex' : 'Peça ao Claude';
    const bar = el('div', 'cm-bar');
    // Seletores no estilo do app do Codex: anexar e acesso à esquerda, uso do
    // contexto e modelo · esforço à direita. Desabilitados até a CLI mandar a lista.
    const clipBtn = el('button', 'cm-iconbtn cm-clip');
    clipBtn.type = 'button';
    clipBtn.title = 'Anexar arquivos ou imagens';
    clipBtn.appendChild(icon('clip'));
    const accessBtn = el('button', 'cm-pill cm-access');
    accessBtn.type = 'button';
    accessBtn.dataset.align = 'left';
    accessBtn.hidden = true;
    const accessLbl = el('span', 'cm-pill-label');
    accessBtn.append(icon('shield', 'cm-pill-ico'), accessLbl, icon('chevron', 'cm-pill-caret'));
    const usageEl = el('span', 'cm-usage');
    usageEl.hidden = true;
    const usageRing = el('span', 'cm-usage-ring');
    const usageLbl = el('span', 'cm-usage-label');
    usageEl.append(usageRing, usageLbl);
    const modelBtn = el('button', 'cm-pill cm-model');
    modelBtn.type = 'button';
    modelBtn.title = 'Modelo e esforço';
    const modelLbl = el('span', 'cm-pill-label');
    modelBtn.append(modelLbl, icon('chevron', 'cm-pill-caret'));
    const sendBtn = el('button', 'cm-send');
    sendBtn.type = 'button';
    bar.append(clipBtn, accessBtn, el('span', 'cm-bar-spacer'), usageEl, modelBtn, sendBtn);
    composer.append(ac, attachRow, ta, bar);

    root.append(scroller, toBottom, composer);
    container.appendChild(root);

    const v = {
      spawnId, container, root, scroller, thread, ta, sendBtn, modelBtn, modelLbl, accessBtn, accessLbl, toBottom,
      usageEl, usageRing, usageLbl, attachRow, ac,
      blockEls: new Map(),   // block.key → { el, rev }
      stickToBottom: true,
      raf: 0,
      hist: null,            // navegação ↑/↓: { list, idx, saved }
      acState: null,         // { kind:'cmd'|'file', items, idx, start, end }
      acSeq: 0,
      schedule() { if (!v.raf) v.raf = requestAnimationFrame(() => { v.raf = 0; render(v); }); },
    };
    views[spawnId] = v;

    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    };
    v.autosize = autosize;
    v.renderAttachments = () => renderAttachments(v);
    // Rascunho e anexos moram no modelo: a vista pode ser remontada a qualquer
    // hora (layout do grid, maximizar, TUI↔chat) sem perder o que foi escrito.
    if (m) ta.value = m.draft || '';
    const doSend = steer => {
      const mm = models[spawnId];
      if (!mm) return;
      if (send(spawnId, ta.value, { attachments: mm.attachments, steer })) {
        ta.value = ''; mm.draft = ''; mm.attachments = []; v.hist = null;
        autosize(); renderAttachments(v); closeAc(v);
      }
    };
    ta.addEventListener('input', () => {
      autosize();
      const mm = models[spawnId];
      if (mm) mm.draft = ta.value;
      v.hist = null;
      updateAc(v);
    });
    ta.addEventListener('click', () => updateAc(v));
    ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) closeAc(v); }, 120));
    modelBtn.addEventListener('click', e => { e.stopPropagation(); openModelMenu(spawnId, modelBtn); });
    accessBtn.addEventListener('click', e => { e.stopPropagation(); openAccessMenu(spawnId, accessBtn); });
    clipBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const paths = await ipcRenderer.invoke('chat-pick-files', { id: spawnId }).catch(() => []);
      addAttachments(spawnId, paths);
      ta.focus();
    });
    ta.addEventListener('keydown', e => {
      if (e.isComposing) return;
      // Autocompletar aberto: setas/Enter/Tab/Esc são dele.
      if (v.acState && v.acState.items.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); e.stopPropagation();
          const n = v.acState.items.length;
          v.acState.idx = (v.acState.idx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
          renderAc(v);
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); acceptAc(v); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAc(v); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        // ⌘Enter com turno rodando = "Enviar agora" (entra no turno atual).
        e.preventDefault(); e.stopPropagation(); doSend(e.metaKey || e.ctrlKey);
      } else if (e.key === 'Escape') {
        const mm = models[spawnId];
        if (mm && mm.busy) { e.preventDefault(); e.stopPropagation(); interrupt(spawnId); }
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (historyKey(v, e.key === 'ArrowUp' ? -1 : 1)) { e.preventDefault(); e.stopPropagation(); }
      } else if (e.key === 'Backspace' && !ta.value && models[spawnId] && models[spawnId].attachments.length) {
        // Composer vazio + ⌫ = tira o último anexo.
        e.preventDefault();
        models[spawnId].attachments.pop();
        renderAttachments(v);
      }
    });
    ta.addEventListener('paste', async e => {
      const files = e.clipboardData && e.clipboardData.files;
      if (!files || !files.length) return;
      // Excel/Word/Numbers copiam texto + um PNG da seleção: aí vale o texto.
      const temTexto = Array.from(e.clipboardData.types || []).includes('text/plain');
      const comCaminho = Array.from(files).some(f => { try { return !!webUtils.getPathForFile(f); } catch { return false; } });
      if (temTexto && !comCaminho) return;
      e.preventDefault();
      addAttachments(spawnId, await filesToPaths(files));
    });
    // Arrastar arquivos do Finder pra qualquer ponto do pane.
    root.addEventListener('dragover', e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      composer.classList.add('is-drop');
    });
    root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) composer.classList.remove('is-drop'); });
    root.addEventListener('drop', async e => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault(); e.stopPropagation();
      composer.classList.remove('is-drop');
      addAttachments(spawnId, await filesToPaths(e.dataTransfer.files));
      ta.focus();
    });
    sendBtn.addEventListener('click', e => {
      e.stopPropagation();
      const mm = models[spawnId];
      if (mm && mm.busy && !ta.value.trim() && !mm.attachments.length) interrupt(spawnId);
      else doSend(false);
      ta.focus();
    });
    scroller.addEventListener('scroll', () => {
      v.stickToBottom = gapToBottom(v) < 40;
      syncToBottom(v);
    }, { passive: true });
    toBottom.addEventListener('click', e => {
      e.stopPropagation();
      v.stickToBottom = true;
      scroller.scrollTop = scroller.scrollHeight;
      syncToBottom(v);
    });
    // Pane mudou de tamanho / conteúdo cresceu fora do render (bloco abriu):
    // segue no fim se estava no fim e recalcula o "↓" pela geometria real.
    if (typeof ResizeObserver === 'function') {
      v.ro = new ResizeObserver(() => {
        if (v.stickToBottom) scroller.scrollTop = scroller.scrollHeight;
        syncToBottom(v);
      });
      v.ro.observe(scroller);
      v.ro.observe(thread);
    }
    // Clique na conversa sem selecionar texto = foco no composer.
    scroller.addEventListener('mouseup', e => {
      if (e.target.closest('button, a, .cm-pre, details')) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length) return;
      ta.focus();
    });

    autosize();
    renderAttachments(v);
    render(v);
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; syncToBottom(v); });
    return v;
  }

  const gapToBottom = v => v.scroller.scrollHeight - v.scroller.scrollTop - v.scroller.clientHeight;
  // O "↓" depende só da geometria (havia rolagem pra baixo?), não do estado
  // guardado — antes ficava visível depois que o conteúdo encolhia.
  function syncToBottom(v) {
    const hide = v.scroller.scrollHeight <= v.scroller.clientHeight + 1 || gapToBottom(v) < 40;
    if (v.toBottom.hidden !== hide) v.toBottom.hidden = hide;
  }

  /** ↑/↓ no composer vazio (ou já navegando): prompts anteriores. */
  function historyKey(v, dir) {
    const ta = v.ta;
    if (!v.hist) {
      if (ta.value.trim() || dir > 0) return false;
      const list = promptHistory();
      if (!list.length) return false;
      v.hist = { list, idx: list.length, saved: ta.value };
    }
    const h = v.hist;
    // Só troca se o cursor está na 1ª linha (↑) / última linha (↓) do texto.
    const pos = ta.selectionStart;
    if (dir < 0 && ta.value.slice(0, pos).includes('\n')) return false;
    if (dir > 0 && ta.value.slice(ta.selectionEnd).includes('\n')) return false;
    const idx = h.idx + dir;
    if (idx < 0) return true;
    let val;
    if (idx >= h.list.length) { val = h.saved; v.hist = null; }
    else { h.idx = idx; val = h.list[idx]; }
    ta.value = val;
    const m = models[v.spawnId];
    if (m) m.draft = val;
    v.autosize();
    ta.setSelectionRange(val.length, val.length);
    return true;
  }

  function renderAttachments(v) {
    const m = models[v.spawnId];
    const row = v.attachRow;
    row.textContent = '';
    const list = (m && m.attachments) || [];
    row.hidden = !list.length;
    list.forEach((a, i) => {
      const chip = el('div', 'cm-chip' + (a.image ? ' is-image' : ''));
      chip.title = a.path;
      if (a.image) {
        const img = el('img', 'cm-chip-img');
        img.src = fileUrl(a.path);
        img.alt = a.name;
        chip.appendChild(img);
      } else {
        chip.append(icon('file', 'cm-chip-ico'), el('span', 'cm-chip-name', a.name));
      }
      const x = el('button', 'cm-chip-x');
      x.type = 'button';
      x.title = 'Remover';
      x.appendChild(icon('x'));
      x.addEventListener('click', e => { e.stopPropagation(); m.attachments.splice(i, 1); renderAttachments(v); v.ta.focus(); });
      chip.appendChild(x);
      row.appendChild(chip);
    });
    if (m) { const busy = m.busy && !m.exited; v.sendBtn.classList.toggle('is-stop', busy && !v.ta.value.trim() && !list.length); }
  }

  // ── Autocompletar: "/comando" no início, "@arquivo" em qualquer ponto ─────
  function closeAc(v) {
    v.acState = null;
    v.acSeq++;
    if (!v.ac.hidden) { v.ac.hidden = true; v.ac.textContent = ''; }
  }

  function updateAc(v) {
    const m = models[v.spawnId];
    const ta = v.ta;
    if (!m || ta.selectionStart !== ta.selectionEnd) return closeAc(v);
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const cmd = before.match(/^\/([^\s/]*)$/);
    if (cmd) {
      const q = cmd[1].toLowerCase();
      const all = (m.config && m.config.commands) || [];
      const starts = [], has = [];
      for (const c of all) {
        const n = c.name.toLowerCase();
        if (n.startsWith(q)) starts.push(c);
        else if (q && n.includes(q)) has.push(c);
      }
      const items = starts.concat(has).slice(0, 60).map(c => ({ value: c.name, label: '/' + c.name, desc: c.hint ? c.hint + ' — ' + c.desc : c.desc }));
      v.acState = { kind: 'cmd', items, idx: 0, start: 0, end: pos };
      return renderAc(v);
    }
    const at = before.match(/(^|\s)@([^\s@]*)$/);
    if (at) {
      const q = at[2];
      const start = pos - q.length - 1;
      const seq = ++v.acSeq;
      ipcRenderer.invoke('chat-files', { id: v.spawnId, query: q }).then(files => {
        if (seq !== v.acSeq || !views[v.spawnId]) return;
        const items = (files || []).map(f => {
          const i = f.lastIndexOf('/');
          return { value: f, label: i >= 0 ? f.slice(i + 1) : f, desc: i >= 0 ? f.slice(0, i) : '' };
        });
        v.acState = { kind: 'file', items, idx: 0, start, end: pos };
        renderAc(v);
      }).catch(() => {});
      return;
    }
    closeAc(v);
  }

  function renderAc(v) {
    const s = v.acState;
    v.ac.textContent = '';
    if (!s || !s.items.length) { v.ac.hidden = true; return; }
    v.ac.hidden = false;
    s.items.forEach((it, i) => {
      const row = el('div', 'cm-ac-item' + (i === s.idx ? ' is-on' : ''));
      row.appendChild(icon(s.kind === 'cmd' ? 'slash' : 'file', 'cm-ac-ico'));
      row.appendChild(el('span', 'cm-ac-label', it.label));
      if (it.desc) row.appendChild(el('span', 'cm-ac-desc', it.desc));
      row.addEventListener('mousedown', e => { e.preventDefault(); s.idx = i; acceptAc(v); });
      v.ac.appendChild(row);
    });
    const on = v.ac.children[s.idx];
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function acceptAc(v) {
    const s = v.acState;
    if (!s || !s.items[s.idx]) return closeAc(v);
    const it = s.items[s.idx];
    const ta = v.ta;
    const ins = (s.kind === 'cmd' ? '/' : '@') + it.value + ' ';
    ta.value = ta.value.slice(0, s.start) + ins + ta.value.slice(s.end);
    const caret = s.start + ins.length;
    ta.setSelectionRange(caret, caret);
    const m = models[v.spawnId];
    if (m) m.draft = ta.value;
    closeAc(v);
    v.autosize();
    ta.focus();
  }

  function unmount(spawnId) {
    const v = views[spawnId];
    if (!v) return;
    if (v.raf) cancelAnimationFrame(v.raf);
    if (v.ro) { try { v.ro.disconnect(); } catch {} }
    if (v.ticker) { clearInterval(v.ticker); v.ticker = null; }
    if (menuEl && v.root.contains(menuEl._trigger)) closeMenu();
    delete views[spawnId];
  }

  function focus(spawnId) {
    const v = views[spawnId];
    if (v) { try { v.ta.focus(); } catch {} }
  }

  function render(v) {
    const m = models[v.spawnId];
    const s = v.scroller;
    const wasAtBottom = v.stickToBottom;

    if (!m) {
      v.thread.textContent = '';
      v.thread.appendChild(el('div', 'cm-empty', 'Sessão encerrada.'));
      return;
    }

    // Estado vazio.
    let empty = v.thread.querySelector(':scope > .cm-empty');
    if (!m.blocks.length) {
      if (!empty) {
        v.thread.textContent = '';
        v.blockEls.clear();
        empty = el('div', 'cm-empty');
        v.thread.appendChild(empty);
      }
      empty.textContent = m.exited ? 'Sessão encerrada.' : (m.ready ? 'O que vamos fazer?' : `Iniciando ${agentName(m)}…`);
    } else if (empty) {
      empty.remove();
    }

    // Blocos: só redesenha o que mudou (rev); ordem = ordem do modelo.
    let prev = null;
    for (const b of m.blocks) {
      let rec = v.blockEls.get(b.key);
      if (!rec || rec.rev !== b.rev) {
        const node = renderBlock(v, m, b);
        if (rec) rec.el.replaceWith(node);
        rec = { el: node, rev: b.rev };
        v.blockEls.set(b.key, rec);
      }
      const want = prev ? prev.nextSibling : v.thread.firstChild;
      if (want !== rec.el) v.thread.insertBefore(rec.el, want);
      prev = rec.el;
    }

    // Aprovações pendentes (fora do "Acesso total").
    let ap = v.thread.querySelector(':scope > .cm-approvals');
    if (ap) ap.remove();
    if (m.approvals.size) {
      ap = el('div', 'cm-approvals');
      for (const [reqId, a] of m.approvals) {
        const card = el('div', 'cm-approval');
        card.appendChild(el('div', 'cm-approval-title', a.label));
        if (a.detail) { const pre = el('pre', 'cm-approval-detail'); pre.textContent = a.detail; card.appendChild(pre); }
        const row = el('div', 'cm-approval-row');
        const no = el('button', 'cm-btn', 'Recusar'); no.type = 'button';
        const yes = el('button', 'cm-btn cm-btn-primary', 'Aprovar'); yes.type = 'button';
        no.addEventListener('click', e => { e.stopPropagation(); approve(v.spawnId, reqId, false); });
        yes.addEventListener('click', e => { e.stopPropagation(); approve(v.spawnId, reqId, true); });
        row.append(no, yes);
        card.appendChild(row);
        ap.appendChild(card);
      }
      v.thread.appendChild(ap);
    }

    // Fila: mensagens esperando o turno acabar.
    let qEl = v.thread.querySelector(':scope > .cm-queue');
    if (qEl) qEl.remove();
    if (m.queue.length) {
      qEl = el('div', 'cm-queue');
      for (const q of m.queue) {
        const row = el('div', 'cm-user-row is-queued');
        const wrap = el('div', 'cm-queued');
        wrap.appendChild(renderUserBubble(q.text,
          q.attachments.filter(a => a.image).map(a => ({ path: a.path })),
          q.attachments.filter(a => !a.image).map(a => a.name)));
        const acts = el('div', 'cm-queued-acts');
        acts.appendChild(el('span', 'cm-queued-tag', 'Na fila'));
        const mk = (label, title, action) => {
          const b = el('button', 'cm-queued-btn', label);
          b.type = 'button'; b.title = title;
          b.addEventListener('click', e => { e.stopPropagation(); queueAction(v.spawnId, q.key, action); });
          return b;
        };
        acts.append(mk('Enviar agora', m.agentId === 'codex' ? kc('Entra no turno atual (⌘Enter)') : kc('Manda já pro Claude (⌘Enter)'), 'now'),
          mk('Editar', 'Volta pro composer', 'edit'), mk('Remover', 'Tira da fila', 'remove'));
        wrap.appendChild(acts);
        row.appendChild(wrap);
        qEl.appendChild(row);
      }
      v.thread.appendChild(qEl);
    }

    // Composer
    const busy = m.busy && !m.exited;
    v.sendBtn.classList.toggle('is-stop', busy && !v.ta.value.trim() && !m.attachments.length);
    v.sendBtn.title = busy ? 'Parar (Esc)' : 'Enviar (Enter)';
    v.sendBtn.disabled = m.exited;
    v.ta.disabled = m.exited;
    v.root.querySelector('.cm-clip').disabled = m.exited;
    if (m.exited) v.ta.placeholder = 'Sessão encerrada — clique no × e reabra a task';
    const cfg = m.config;
    const cur = findModel(cfg, cfg && cfg.model);
    const modelName = cur ? cur.label : (cfg && cfg.model ? prettyModel(cfg.model) : (m.model ? prettyModel(m.model) : agentName(m)));
    v.modelLbl.textContent = cfg && cfg.effort ? `${modelName} · ${effortLabel(cfg.effort)}` : modelName;
    v.modelBtn.disabled = m.exited || !cfg || !cfg.models.length;
    v.accessBtn.hidden = !(cfg && cfg.access);
    if (cfg && cfg.access) {
      const opts = accessOptions(cfg);
      const a = opts.find(o => o.value === cfg.access) || opts[0];
      v.accessLbl.textContent = a.label;
      v.accessBtn.classList.toggle('is-full', !!a.full);
      v.accessBtn.disabled = m.exited;
    }
    renderUsage(v, m);

    if (wasAtBottom) s.scrollTop = s.scrollHeight;
    syncToBottom(v);
  }

  const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' mi'
    : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace('.', ',') + ' mil' : String(n);

  /** Anel "quanto do contexto já foi" + custo (Claude) no tooltip. */
  function renderUsage(v, m) {
    const u = m.usage;
    v.usageEl.hidden = !u || !u.used;
    if (!u || !u.used) return;
    const pct = u.window ? Math.min(100, Math.round(u.used / u.window * 100)) : null;
    v.usageLbl.textContent = pct != null ? pct + '%' : fmtTok(u.used);
    v.usageRing.style.setProperty('--pct', String(pct != null ? pct : 0));
    v.usageEl.classList.toggle('is-high', pct != null && pct >= 80);
    let tip = 'Contexto: ' + fmtTok(u.used) + (u.window ? ' de ' + fmtTok(u.window) + ' tokens' : ' tokens');
    if (u.costUsd != null) tip += '\nCusto da sessão: US$ ' + u.costUsd.toFixed(u.costUsd < 1 ? 4 : 2).replace('.', ',');
    if (pct != null && pct >= 80) tip += '\n/compact libera espaço';
    v.usageEl.title = tip;
  }

  function prettyModel(id) {
    const s = String(id || '');
    const cm = s.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
    if (cm) return `${cm[1][0].toUpperCase()}${cm[1].slice(1)} ${cm[2]}.${cm[3]}`;
    return s.replace(/^gpt-/i, 'GPT-').replace(/-([a-z])/g, (_, c) => ' ' + c.toUpperCase());
  }

  function renderBlock(v, m, b) {
    if (b.type === 'user') {
      const row = el('div', 'cm-user-row');
      row.appendChild(renderUserBubble(b.text, b.images, b.files));
      return row;
    }
    if (b.type === 'notice') {
      return el('div', 'cm-notice cm-notice-' + b.level, b.text);
    }
    return renderTurn(v, m, b);
  }

  /** Bolha do usuário: miniaturas das imagens, chips dos arquivos, texto. */
  function renderUserBubble(text, images, files) {
    const box = el('div', 'cm-user-msg');
    if ((images && images.length) || (files && files.length)) {
      const att = el('div', 'cm-user-att');
      for (const im of images || []) {
        if (im.path) {
          const img = el('img', 'cm-user-img');
          img.src = fileUrl(im.path);
          img.title = im.path;
          img.addEventListener('click', e => { e.stopPropagation(); try { require('electron').shell.openPath(im.path); } catch {} });
          att.appendChild(img);
        } else {
          const c = el('span', 'cm-chip is-static');
          c.append(icon('image', 'cm-chip-ico'), el('span', 'cm-chip-name', im.label || 'Imagem'));
          att.appendChild(c);
        }
      }
      for (const f of files || []) {
        const c = el('span', 'cm-chip is-static');
        c.append(icon('file', 'cm-chip-ico'), el('span', 'cm-chip-name', f));
        att.appendChild(c);
      }
      box.appendChild(att);
    }
    if (String(text || '').trim()) box.appendChild(el('div', 'cm-user', text));
    return box;
  }

  function renderTurn(v, m, t) {
    const box = el('div', 'cm-turn' + (t.running ? ' is-running' : ''));
    const items = t.ids.map(id => m.items.get(id)).filter(Boolean)
      .filter(it => !(it.kind === 'reasoning' && !String(it.text || '').trim()));

    // Resposta final = último texto do turno (ou o marcado final pelo Codex),
    // só quando o turno acabou. Durante o turno tudo é "trabalho".
    let finalIdx = -1;
    if (!t.running) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === 'text' && String(items[i].text || '').trim()) { finalIdx = i; break; }
        if (items[i].kind === 'tool') break;
      }
    }
    const work = finalIdx >= 0 ? items.slice(0, finalIdx) : items;
    const final = finalIdx >= 0 ? items.slice(finalIdx) : [];

    if (t.running) {
      const head = el('div', 'cm-working');
      head.appendChild(el('span', 'cm-shimmer', 'Trabalhando'));
      head.appendChild(el('span', 'cm-working-time', fmtDur(Date.now() - t.startedAt)));
      box.appendChild(head);
      box.appendChild(renderWork(v, m, t, work, true));
      ensureTicker(v, m);
    } else if (work.length) {
      const head = el('button', 'cm-worked' + (t.open ? ' is-open' : ''));
      head.type = 'button';
      head.appendChild(el('span', null, (t.interrupted ? 'Interrompido após ' : 'Trabalhou por ') + fmtDur(t.durationMs)));
      head.appendChild(icon('chevron', 'cm-chev'));
      head.addEventListener('click', e => { e.stopPropagation(); t.open = !t.open; touch(m, t); });
      box.appendChild(head);
      if (t.open) box.appendChild(renderWork(v, m, t, work, false));
    } else if (t.interrupted) {
      box.appendChild(el('div', 'cm-worked-static', 'Interrompido'));
    }

    for (const it of final) box.appendChild(renderItem(v, m, t, it));
    if (t.error) box.appendChild(el('div', 'cm-notice cm-notice-error', t.error));
    return box;
  }

  // Trabalho do turno: textos intermediários + grupos de ferramentas seguidas.
  function renderWork(v, m, t, items, live) {
    const wrap = el('div', 'cm-work');
    let group = [];
    let gi = 0;
    const flush = () => {
      if (!group.length) return;
      wrap.appendChild(renderGroup(v, m, t, group, 'g' + gi++, live));
      group = [];
    };
    for (const it of items) {
      if (it.kind === 'tool') { group.push(it); continue; }
      flush();
      wrap.appendChild(renderItem(v, m, t, it));
    }
    flush();
    return wrap;
  }

  function renderGroup(v, m, t, tools, gkey, live) {
    const box = el('div', 'cm-group');
    // Ao vivo o grupo fica aberto (as linhas vão aparecendo); depois, recolhido.
    const open = t.groupsOpen[gkey] != null ? t.groupsOpen[gkey] : live;
    const head = el('button', 'cm-group-head' + (open ? ' is-open' : ''));
    head.type = 'button';
    const firstIcon = tools.some(x => x.icon === 'read') ? 'read' : tools[0].icon;
    head.appendChild(icon(firstIcon));
    head.appendChild(el('span', 'cm-group-label', groupLabel(tools)));
    head.appendChild(icon('chevron', 'cm-chev'));
    head.addEventListener('click', e => { e.stopPropagation(); t.groupsOpen[gkey] = !open; touch(m, t); });
    box.appendChild(head);
    if (open) for (const it of tools) box.appendChild(renderTool(m, t, it));
    return box;
  }

  function renderTool(m, t, it) {
    const row = el('div', 'cm-tool' + (it.status === 'error' ? ' is-error' : '') + (it.status === 'running' ? ' is-running' : ''));
    const line = el('button', 'cm-tool-line');
    line.type = 'button';
    line.appendChild(icon(it.icon));
    line.appendChild(el('span', 'cm-tool-label', it.label || ''));
    row.appendChild(line);
    if (it.detail) {
      line.classList.add('has-detail');
      line.addEventListener('click', e => { e.stopPropagation(); it.open = !it.open; touch(m, t); });
      if (it.open) {
        const pre = el('pre', 'cm-tool-detail');
        pre.textContent = it.detail;
        row.appendChild(pre);
      }
    }
    return row;
  }

  function renderItem(v, m, t, it) {
    if (it.kind === 'reasoning') {
      const r = el('div', 'cm-reasoning');
      r.appendChild(renderMarkdown(it.text));
      return r;
    }
    if (it.kind === 'tool') return renderTool(m, t, it);
    const box = el('div', 'cm-text');
    box.appendChild(renderMarkdown(it.text));
    return box;
  }

  // Relógio do "Trabalhando 12s": 1×/s enquanto houver turno aberto na vista.
  function ensureTicker(v, m) {
    if (v.ticker) return;
    v.ticker = setInterval(() => {
      const mm = models[v.spawnId];
      if (!views[v.spawnId] || !mm || !mm.turn || !mm.turn.running) { clearInterval(v.ticker); v.ticker = null; return; }
      const tEl = v.thread.querySelector('.cm-turn.is-running .cm-working-time');
      if (tEl) tEl.textContent = fmtDur(Date.now() - mm.turn.startedAt);
    }, 1000);
  }

  // O main tem a palavra final: pediu chat para uma CLI sem modo chat (ou o
  // "Automático" resolveu diferente) → o pane sobe em TUI e a vista acompanha.
  ipcRenderer.on('agent-event', (_, msg) => {
    if (!msg || msg.kind !== 'spawned' || msg.ui !== 'tui') return;
    const sid = msg.spawnId;
    if (!models[sid]) return;
    detach(sid);
    st.spawnUi[sid] = 'tui';
    if (typeof renderGrid === 'function') renderGrid();
  });

  // ── API ───────────────────────────────────────────────────────────────────
  window.NoryaChat = {
    attach, detach, mount, unmount, focus, send, interrupt, input, approve, addAttachments,
    isChat: spawnId => !!models[spawnId],
    isBusy: spawnId => !!(models[spawnId] && models[spawnId].busy),
    configure,
    onSession(spawnId, fn) { const m = models[spawnId]; if (m) m.onSession.push(fn); },
    sessionOf: spawnId => (models[spawnId] && models[spawnId].sessionId) || null,
    firstPrompt(spawnId) {
      const m = models[spawnId];
      const u = m && m.blocks.find(b => b.type === 'user');
      return u ? u.text.replace(/\s+/g, ' ').trim().slice(0, 80) : null;
    },
    _models: models, _views: views, _renderMarkdown: renderMarkdown, _groupLabel: groupLabel,
  };
})();
