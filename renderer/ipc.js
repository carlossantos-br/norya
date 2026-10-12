/**
 * renderer/ipc.js — única superfície que fala com o processo main.
 *
 * Script CLÁSSICO (ver renderer/state.js). O `require('electron')` fica dentro
 * de uma IIFE: declará-lo no topo colidiria com o `const { ipcRenderer }` do
 * script inline — scripts clássicos compartilham o escopo léxico global, e a
 * redeclaração seria um SyntaxError que mataria o arquivo inteiro.
 *
 * Extraído de test-window.html em 2026-07-09. Nenhum método renomeado: o script
 * inline ainda depende destes nomes em ~200 pontos de chamada.
 */
'use strict';

const api = (() => {
  const { ipcRenderer } = require('electron');
  return {
  getAccounts:     ()              => ipcRenderer.invoke('get-accounts'),
  addAccount:      (opts)          => ipcRenderer.invoke('add-account', opts),
  renameAccount:   (num, name)     => ipcRenderer.invoke('rename-account', { num, name }),
  deleteAccount:   (num)           => ipcRenderer.invoke('delete-account', { num }),
  listThreads:     (num, folder)   => ipcRenderer.invoke('list-threads', { accountNum: num, folder: folder || null }),
  detectAgents:    (opts)          => ipcRenderer.invoke('detect-agents', opts || {}),
  quotaGet:        ()              => ipcRenderer.invoke('quota-get'),
  setNativeTheme:  (theme)         => ipcRenderer.invoke('set-native-theme', theme),
  quotaRefresh:    (num, provider) => ipcRenderer.invoke('quota-refresh', num, provider),
  quotaRefreshAll: ()              => ipcRenderer.invoke('quota-refresh-all'),
  pickFolder:      ()              => ipcRenderer.invoke('pick-folder'),
  spawnTerminal:   (acc, opts)     => ipcRenderer.send('spawn-terminal', { account: acc, ...(opts || {}) }),
  killTerminal:    (id)            => ipcRenderer.send('kill-terminal', id),
  // Pane em chat não tem PTY: "texto + Enter" vira mensagem (renderer/chat.js).
  sendInput:       (id, data)      => (window.NoryaChat && window.NoryaChat.isChat(id))
                                        ? window.NoryaChat.input(id, data)
                                        : ipcRenderer.send('terminal-input', { id, data }),
  resize:          (id, cols, rows) => ipcRenderer.send('terminal-resize', { id, cols, rows }),
  // Grid state disk mirror (~/.codex-panel/grid-state.json). localStorage stays
  // source of truth; this is a portable backup the user can inspect.
  gridStateSave:   (data)          => ipcRenderer.invoke('grid-state-save', data),
  getTokenStats:   (options)       => ipcRenderer.invoke('get-token-stats', options),
  getFxUsdBrl:     ()              => ipcRenderer.invoke('get-fx-usd-brl'),
  listSkills:      (options = {})  => ipcRenderer.invoke('list-skills', options),
  setSkillEnabled: (id, enabled)   => ipcRenderer.invoke('set-skill-enabled', { id, enabled }),
  renameThread:    (acc, sid, t)   => ipcRenderer.invoke('thread-rename', { accountNum: acc, sessionId: sid, title: t }),
  deleteThread:    (acc, sid)      => ipcRenderer.invoke('thread-delete', { accountNum: acc, sessionId: sid }),
  gitAnalyzeBranches:(projectDir, baseBranch) => ipcRenderer.invoke('git-analyze-branches', { projectDir, baseBranch }),
  gitQueueMerge:   (projectDir, baseBranch, orderedBranches, opts) => ipcRenderer.invoke('git-queue-merge', { projectDir, baseBranch, orderedBranches, failStop: opts && opts.failStop !== undefined ? opts.failStop : true }),
  gitMergePrecheck:(projectDir, baseBranch) => ipcRenderer.invoke('git-merge-precheck', { projectDir, baseBranch }),
  gitConflictFileRead:(projectDir, relPath) => ipcRenderer.invoke('git-conflict-file-read', { projectDir, relPath }),
  mergeHistoryList:()              => ipcRenderer.invoke('merge-history-list'),
  mergeHistoryMarkAgent:(ts, profileName) => ipcRenderer.invoke('merge-history-mark-agent', { ts, profileName }),
  mergeHistoryClear:()             => ipcRenderer.invoke('merge-history-clear'),
  listCodexModels: ()                       => ipcRenderer.invoke('list-codex-models'),
  findLatestSession:(accountNum, sinceMs)   => ipcRenderer.invoke('find-latest-session', { accountNum, sinceMs }),
  // Fase 2: norya-state + profile IPCs
  noryaStateGet:   ()                       => ipcRenderer.invoke('norya-state-get'),
  noryaStateSave:  (data)                   => ipcRenderer.invoke('norya-state-save', data),
  profilePalette:  ()                       => ipcRenderer.invoke('profile-palette'),
  // Fase 3: profile config IPCs
  profileSetColor:    (num, color)          => ipcRenderer.invoke('profile-set-color', { num, color }),
  profileSetAuthMode: (num, mode)           => ipcRenderer.invoke('profile-set-auth-mode', { num, mode }),
  profileSetApiKey:   (num, apiKey)         => ipcRenderer.invoke('profile-set-apikey', { num, apiKey }),
  profileSetOpenrouterKey:   (num, key)     => ipcRenderer.invoke('profile-set-openrouter-key', { num, key }),
  profileSetOpenrouterModel: (num, model)   => ipcRenderer.invoke('profile-set-openrouter-model', { num, model }),
  profileSetClaudeModel:     (num, model)   => ipcRenderer.invoke('profile-set-claude-model', { num, model }),
  claudeAuthMeta:            ()             => ipcRenderer.invoke('claude-auth-meta'),
  // Fase 6: git + worktree IPCs (Norya Workspaces)
  gitDetect:          (dir)                 => ipcRenderer.invoke('git-detect', dir),
  gitListBranches:    (dir)                 => ipcRenderer.invoke('git-list-branches', dir),
  gitWorktreeAdd:     (opts)                => ipcRenderer.invoke('git-worktree-add', opts),
  gitWorktreeList:    (projectDir)          => ipcRenderer.invoke('git-worktree-list', { projectDir }),
  // agent/branches: persisted color overrides + last-commit lookup
  branchColorsGet:    ()                    => ipcRenderer.invoke('branch-colors-get'),
  gitLastCommit:      (dir, branch)         => ipcRenderer.invoke('git-last-commit', { dir, branch }),
  deriveSlug:         (text, projectId)     => ipcRenderer.invoke('derive-slug', { text, projectId }),
  threadOwnerSet:     (sessionId, profileNum) => ipcRenderer.invoke('thread-owner-set', { sessionId, profileNum }),
  // Adotar a task numa OUTRA conta, continuando a MESMA conversa. No Codex isso
  // move o rollout pro $CODEX_HOME do perfil destino; no Claude é só o dono.
  threadAdoptProfile: (o) => ipcRenderer.invoke('thread-adopt-profile', o),
  threadOwnersAll:    ()                    => ipcRenderer.invoke('thread-owners-all'),
  threadAgentsAll:    ()                    => ipcRenderer.invoke('thread-agents-all'),
  threadAgentSet:     (sessionId, agentId)  => ipcRenderer.invoke('thread-agent-set', { sessionId, agentId }),
  gitStatusBulk:      (cwds)                => ipcRenderer.invoke('git-status-bulk', { cwds }),
  threadFork:         (params)              => ipcRenderer.invoke('thread-fork', params),
  // Norya forks 2026-05-26: fork-lineage persistence (parent → child mapping)
  forkLineageAll:     ()                    => ipcRenderer.invoke('fork-lineage-all'),
  forkLineageSet:     (entry)               => ipcRenderer.invoke('fork-lineage-set', entry),
  };
})();
