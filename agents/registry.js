'use strict';

/**
 * agents/registry.js — registry declarativo das CLIs de coding agent.
 *
 * Semente da Fase 3 do refactor. Hoje serve à detecção ("está instalada?") e ao
 * painel Uso. A migração de `authMode` → `agentId` e a montagem do comando de
 * spawn a partir daqui vêm depois.
 *
 * Regra de honestidade: `install` só existe quando o comando foi verificado em
 * fonte primária. Sem verificação, o campo é null e a UI mostra `docs` em vez de
 * um comando inventado.
 *
 * Node builtins apenas — sem novas dependências npm (ver quota/CONTRACT.md).
 */

/**
 * Campos que o spawn consome:
 *   ptyCwd  'account' → o PTY nasce em account.dir (é onde mora o auth) e a CLI
 *                       recebe a pasta do projeto por flag.
 *           'project' → o PTY nasce na pasta do projeto; a CLI pega dali.
 *   quota   id do adapter em quota/ (null = não tem assinatura a medir)
 *   install só existe quando o comando foi verificado em fonte primária.
 *   login   comando que autentica ESTE perfil (mode: 'login'). null = sem login.
 *   creds   COMO a credencial é isolada por perfil — é o que permite ter várias
 *           contas do mesmo agente:
 *             { kind: 'home' }   a CLI grava sob $HOME; trocar HOME já isola.
 *             { kind: 'token', env, prefix }
 *                                a credencial vive fora do HOME (Keychain), e o
 *                                isolamento vem de injetar um token por perfil.
 *             { kind: 'key', field }  chave de API guardada no profile.json.
 */
const AGENTS = [
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    subscription: 'ChatGPT',
    authModes: ['chatgpt', 'apikey'],
    ptyCwd: 'account',           // auth.json vive em account.dir; usa --cd
    // Quota autoritativa e barata: `codex app-server` → account/rateLimits/read.
    quota: 'codex',
    login: 'codex login',
    // Grava em $HOME/.codex/auth.json → trocar HOME isola a conta. É por isso
    // que múltiplas contas de Codex sempre funcionaram.
    creds: { kind: 'home' },
    install: null,
    docs: 'https://developers.openai.com/codex/cli',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    subscription: 'Claude',
    authModes: ['claude'],
    ptyCwd: 'project',
    // Sem API pública de quota de assinatura (anthropics/claude-code#44328).
    // Só via /status dentro de uma sessão viva → PTY escondido, sob demanda.
    quota: 'claude',
    login: 'claude setup-token',
    // O OAuth vive no KEYCHAIN do macOS, chaveado pelo usuário do sistema —
    // trocar HOME não isola nada. O caminho oficial para várias contas é o
    // token de longa duração do `claude setup-token`, injetado por perfil.
    // Verificado no binário 2.1.206: CLAUDE_CODE_OAUTH_TOKEN é auth aceita.
    creds: { kind: 'token', env: 'CLAUDE_CODE_OAUTH_TOKEN', prefix: 'sk-ant-oat01' },
    install: null,
    docs: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
  {
    id: 'aider',
    label: 'OpenRouter (Aider)',
    bin: 'aider',
    subscription: null,          // pré-pago por token, não é assinatura
    authModes: ['openrouter'],
    ptyCwd: 'project',
    quota: null,
    login: null,                 // autentica por chave, não por fluxo de login
    creds: { kind: 'key', field: 'openrouterKey' },
    install: null,
    docs: 'https://aider.chat/docs/install.html',
  },
  {
    id: 'grok',
    label: 'Grok Build',
    bin: 'grok',
    subscription: 'SuperGrok',
    authModes: ['grok'],
    ptyCwd: 'project',
    // /usage é slash command interativo; sem caminho headless documentado.
    // Desde jun/2026 a SuperGrok é um POOL SEMANAL ÚNICO: sem janela de 5h.
    quota: 'grok',
    login: 'grok login',
    // Verificado: com HOME falso, o grok cria um ~/.grok novo lá dentro.
    // Trocar HOME isola a conta, como no Codex.
    creds: { kind: 'home' },
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',   // docs.x.ai/build/overview
    docs: 'https://docs.x.ai/build/overview',
    models: ['grok-build-0.1', 'grok-4.5'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    subscription: null,          // usa a assinatura do provider escolhido (ex: SuperGrok)
    authModes: ['opencode'],
    ptyCwd: 'project',
    quota: null,
    login: 'opencode auth login',   // verificado em `opencode auth --help`
    // Credencial em ~/.local/share/opencode/auth.json → HOME isola.
    creds: { kind: 'home' },
    install: 'brew install anomalyco/tap/opencode',             // opencode.ai/docs
    docs: 'https://opencode.ai/docs/',
  },
];

const byId = Object.fromEntries(AGENTS.map(a => [a.id, a]));

/** Qual agente roda um perfil com este authMode. */
function agentForAuthMode(authMode) {
  return AGENTS.find(a => a.authModes.includes(authMode)) || null;
}

/**
 * Resolve o agente de um spawn. Ordem de precedência:
 *   1. `agentId` explícito (thread escolheu OpenCode ou Grok);
 *   2. o authMode do perfil (comportamento histórico);
 *   3. codex — o `else` de sempre.
 *
 * Um `agentId` desconhecido NÃO cai silenciosamente em codex: isso spawnaria a
 * CLI errada com as flags erradas. Melhor tratar como ausente e avisar.
 */
function resolveAgentId(authMode, agentId, log) {
  if (agentId) {
    if (byId[agentId]) return agentId;
    if (log) log('registry', `agentId desconhecido "${agentId}" — usando o authMode do perfil`);
  }
  const porAuth = agentForAuthMode(authMode);
  return porAuth ? porAuth.id : 'codex';
}

module.exports = { AGENTS, byId, agentForAuthMode, resolveAgentId };
