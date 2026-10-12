/**
 * renderer/state.js — objeto de estado global do renderer.
 *
 * Script CLÁSSICO, não módulo ES: um `const` de topo aqui entra no global
 * lexical environment, compartilhado com os demais scripts da página. É assim
 * que o script inline restante continua enxergando `st` sem uma única mudança.
 * Convertido para módulo ES quando o inline tiver sido totalmente dissolvido.
 *
 * Extraído de test-window.html em 2026-07-09. Nenhum campo alterado.
 */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const st = {
  accounts: [],
  quota: {},
  allThreads: [],
  selectedThreadId: null,
  selectedAccountNum: null,
  activeProfileNum: null,         // Fase 2: perfil ativo no canto inferior
  profileDropdownOpen: false,
  initDone: false,                // true once init() finished (accounts/threads loaded)
  threadOwners: {},               // Fase 7: { sessionId: profileNum }
  // Norya Grid (orchestration mode) — A
  gridMode: {
    enabled: false,
    threadIds: [],                // ordered list of thread sessionIds in the grid
    lastInteracted: null,         // sessionId of last thread user interacted with
    focusedThreadId: null,        // visually highlighted pane (target of ⌘Enter)
    maximizedThreadId: null,      // pane currently zoomed to fill the grid area
  },
  termBuffers: {},
  // Latest requested PTY size. termHistory retains earlier geometry changes.
  termSizes: {},
  termHistory: {}, // bounded output with ordered geometry changes for replay
  termRunning: {},
  termListeners: {},
  // { [spawnId]: true } — task encerrada pelo ×: no onExit, libera os buffers do PTY.
  releaseOnExit: {},
  lastOutputTime: {},
  // { [id]: ts } — última TECLA que o usuário mandou pro PTY (não output). É o
  // que separa "o agente está trabalhando" de "o usuário está digitando": as
  // duas coisas produzem bytes no mesmo canal, então só o teclado desempata.
  // Consumido por renderer/attention.js.
  lastInputTime: {},
  exitedAt: {},
  exitedWithError: {},
  userKilled: {},
  collapsedProjects: {},
  attachments: [],          // { dataUrl, file }
  activeMode: 'auto',
  selectedModel: '',
  reasoningEffort: 'xhigh',
  fastMode: false,
  fullAccess: true,
  webSearch: false,
  selectedAccountOverride: null,
  lastRunThreadId: {},
  // ── Multi-PTY per account ──
  spawnAccount: {},   // { [spawnId]: accountNum } — back-pointer
  spawnCwd: {},       // { [spawnId]: cwd } — current working dir of the PTY
  outputWindow: {},   // { [spawnId]: [{ ts, bytes }] } — rolling 3s output window
  spawnByThread: {},  // { [threadId]: spawnId } — which PTY belongs to which thread
  settings: { theme: localStorage.getItem('norya-theme') || 'light' },
  // Agente escolhido para os PRÓXIMOS spawns. null = "automático": segue o
  // authMode do perfil ativo, que era o único comportamento antes da Fase 3.
  selectedAgentId: localStorage.getItem('norya-agent-id') || null,
  // { threadId: agentId } — só threads cujo agente foi escolhido a dedo.
  // Uma thread não troca de CLI depois de criada (formato de sessão difere).
  threadAgents: {},
  // { spawnId: agentId } em memória: o id real da thread só chega no latch.
  spawnAgent: {},
  // Como o PRÓXIMO pane abre: 'tui' (xterm) ou 'chat' (renderer/chat.js).
  paneUi: localStorage.getItem('norya-pane-ui') === 'chat' ? 'chat' : 'tui',
  // { spawnId: 'tui'|'chat' } — como cada pane vivo está aberto.
  spawnUi: {},
  // { threadId: 'tui'|'chat' } — reabrir a task volta do mesmo jeito.
  threadUi: (() => { try { return JSON.parse(localStorage.getItem('norya-thread-ui') || '{}') || {}; } catch { return {}; } })(),
};

// Apply saved theme
if (st.settings.theme === 'dark') document.documentElement.dataset.theme = 'dark';
