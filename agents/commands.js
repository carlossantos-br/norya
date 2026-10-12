'use strict';

/**
 * agents/commands.js — monta a linha de comando de cada CLI de coding agent.
 *
 * PURO: sem electron, sem fs, sem estado. As duas dependências que existiam
 * (`logLine` e os caminhos de histórico do aider) entram por injeção. É o que
 * permite testar cada comando sem subir o app (test/agent-commands.test.js).
 *
 * Esta é a peça central da Fase 3: adicionar uma CLI passa a ser escrever um
 * builder aqui e uma entrada no registry — não editar seis pontos do main.js.
 *
 * Os builders de codex, claude e aider foram movidos de main.js VERBATIM.
 * Qualquer mudança de comportamento neles é regressão, e o golden test pega.
 */

const { byId } = require('./registry');
const platform = require('../platform');

/**
 * Aspas do shell da plataforma.
 *
 * POSIX: fecha, escapa a aspa, reabre.  PowerShell: dobra a aspa.
 * O estilo vem do `platform.js` — nunca de um `process.platform` aqui dentro.
 * Os builders recebem o quoter por `deps.quote`, e é assim que o teste prova o
 * comportamento Windows rodando no Mac.
 */
function shellQuote(s) {
  return platform.quote(s);
}

/**
 * Prompt inicial (Mini/pet, 2026-10-05): argumento posicional da CLI, só em
 * sessão NOVA (nunca em resume). Vai depois de `--` porque o Claude tem flags
 * variádicas (`--disallowedTools Skill`) que engoliriam o prompt, e porque um
 * prompt começando com "-" viraria opção. Verificado no claude 2.1 e no clap
 * do codex. Vazio/só espaço = nada.
 */
function initialPromptArg(opts, shellQuote, isWin) {
  const t = typeof opts.initialPrompt === 'string' ? opts.initialPrompt.trim() : '';
  if (!t) return '';
  // PowerShell trata um `--` NU como fim-de-parâmetros e o engole antes de
  // chegar ao shim `.ps1` do npm; entre aspas ele é só texto e passa adiante.
  return ` ${isWin ? shellQuote('--') : '--'} ${shellQuote(t.slice(0, 8000))}`;
}

const isWinDeps = deps => (deps.isWin != null ? deps.isWin : platform.isWin);

// ─────────────────────────────────────────────────────────────────────────────
// Codex — OpenAI
// ─────────────────────────────────────────────────────────────────────────────
function buildCodex(opts = {}, deps = {}) {
  const shellQuote = deps.quote || platform.quote;
  const mode = opts.mode || 'default';
  const { model, reasoningEffort: effort, fastMode: fast, fullAccess, webSearch, authMode } = opts;
  // service_tier=fast, --search e reasoning_effort são só da OpenAI; via
  // OpenRouter os modelos de terceiros não os suportam.
  const isOpenRouter = authMode === 'openrouter';

  const parts = [];
  if (model) parts.push(`--model ${shellQuote(model)}`);
  if (effort && !isOpenRouter) parts.push(`-c model_reasoning_effort=${shellQuote(effort)}`);
  if (!isOpenRouter) parts.push(`-c service_tier=${fast ? 'fast' : 'default'}`);
  if (fullAccess) parts.push(`--dangerously-bypass-approvals-and-sandbox`);
  else parts.push(`-s workspace-write`, `-a on-request`);
  if (webSearch && !isOpenRouter) parts.push(`--search`);
  // Silencia erros de handshake do MCP remoto (o OAuth do codex_apps expira
  // toda hora e polui a TUI).
  parts.push(`-c features.rmcp_client=false`);
  // O atualizador do Norya usa o instalador real, fora do HOME de perfil.
  parts.push(`-c check_for_update_on_startup=false`);
  if (!isOpenRouter) {
    parts.push(`-c model_reasoning_summary=detailed`);
    parts.push(`-c show_raw_agent_reasoning=true`);
  }
  if (opts.skillsPrompt) parts.push(`-c ${shellQuote('developer_instructions=' + JSON.stringify(opts.skillsPrompt))}`);
  if (opts.disabledSkillPaths?.length) {
    const entries = opts.disabledSkillPaths.map(p => `{path=${JSON.stringify(p)},enabled=false}`).join(',');
    parts.push(`-c ${shellQuote('skills.config=[' + entries + ']')}`);
  }
  const flags = parts.length ? ' ' + parts.join(' ') : '';

  if (mode === 'resume' && opts.sessionId) {
    // O resume restaura o cwd gravado na sessão. Se o chamador passa um cwd
    // (a thread mudou de pasta), honramos.
    if (opts.cwd) return `codex${flags} --cd ${shellQuote(opts.cwd)} resume ${shellQuote(opts.sessionId)}`;
    return `codex${flags} resume ${shellQuote(opts.sessionId)}`;
  }
  // codex sempre sobe a partir de account.dir (é onde mora o auth.json) e usa
  // --cd para apontar o workspace na pasta da thread.
  const prompt = initialPromptArg(opts, shellQuote, isWinDeps(deps));
  if (opts.cwd) return `codex${flags} --cd ${shellQuote(opts.cwd)}${prompt}`;
  return `codex${flags}${prompt}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code — Anthropic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON do `--settings` que liga os hooks de evento do Norya (2026-10-04).
 *
 * Vai pela FLAG, não pelo settings.json de cada perfil: a flag é uma fonte a
 * mais e os hooks de todas as fontes somam — os do usuário (um Stop hook de notas,
 * etc.) continuam rodando. Verificado no claude 2.1.289 com `claude -p`.
 *
 * PreToolUse é async: dispara a cada tool e não pode atrasar nenhuma. Os
 * outros são síncronos para chegarem na ordem (turn-start antes do Stop).
 * O Notification já filtra no matcher: idle_prompt nem sobe processo.
 *
 * @param {string} hookCmd  linha de comando pronta (interpretador + helper)
 */
function claudeHookSettings(hookCmd) {
  const h = (extra) => [Object.assign({ type: 'command', command: hookCmd, timeout: 5 }, extra || {})];
  return JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: h() }],
      PreToolUse: [{ matcher: '*', hooks: h({ async: true }) }],
      Stop: [{ hooks: h() }],
      Notification: [{ matcher: 'permission_prompt', hooks: h() }],
    },
  });
}

function buildClaude(opts = {}, deps = {}) {
  const { log } = deps;
  const shellQuote = deps.quote || platform.quote;
  const mode = opts.mode || 'default';
  const model = opts.model == null ? null : String(opts.model).trim();

  const parts = [];
  if (model && /^[\w.-]+(?:\[1m\])?$/.test(model)) parts.push(`--model ${shellQuote(model)}`);
  // Bypass permissions em TODA sessão de Claude do painel — não é opcional e
  // NÃO depende do checkbox `fullAccess` (o pedido foi "todas as sessões").
  // As CLIs irmãs já sobem assim (codex --dangerously-bypass-approvals-and-sandbox,
  // grok --always-approve, aider --yes-always); o claude era o único que ainda
  // parava pedindo aprovação dentro do pane.
  // Verificado no binário 2.1.246: a flag existe, entra direto em "bypass
  // permissions on" e não abre tela de aceite em pasta já confiada. O `mode:
  // 'login'` nunca chega aqui — o login vem do registry (`claude setup-token`),
  // que não aceita esta flag.
  // Remote Control em TODA sessão de Claude (pedido do Carlos, 2026-10-10).
  // Vem ANTES do bypass de propósito: `--remote-control [name]` engole o token
  // seguinte se não for flag — o prompt inicial viraria nome da sessão.
  // Verificado no claude 2.1.295: sobe com "/remote-control is active".
  parts.push('--remote-control');
  parts.push('--dangerously-skip-permissions');
  if (opts.skillsPrompt) {
    parts.push(`--append-system-prompt ${shellQuote(opts.skillsPrompt)}`);
    parts.push('--system-prompt-snapshot off');
    // Keep built-in /model, /config, /usage and /rc available. Disabling all
    // slash commands also disables these controls, not just custom skills.
    // Portable skills are read through the catalog; block only the Skill tool.
    parts.push('--disallowedTools Skill');
  }
  // Eventos de turno pro Norya (som de fim de turno). Só quando o main injeta o
  // comando do hook — sem ele o comando fica idêntico ao golden antigo.
  // No Windows o JSON vai num ARQUIVO (platform.hookSettingsViaFile): inline,
  // as aspas duplas dele dependeriam de cada camada (PowerShell, shim do npm).
  if (opts.noryaHookSettingsFile) parts.push(`--settings ${shellQuote(opts.noryaHookSettingsFile)}`);
  else if (opts.noryaHookCmd) parts.push(`--settings ${shellQuote(claudeHookSettings(opts.noryaHookCmd))}`);
  const flags = parts.length ? ' ' + parts.join(' ') : '';

  if (mode === 'resume') {
    const sid = opts.sessionId == null ? '' : String(opts.sessionId).trim();
    if (sid && /^[A-Za-z0-9._-]+$/.test(sid)) return `claude${flags} --resume ${shellQuote(sid)}`;
    // sessionId inválido = bug do chamador. Sobe sessão nova em vez de matar o PTY.
    if (log) log('claude-cmd', `dropping --resume (invalid sessionId=${JSON.stringify(opts.sessionId)})`);
  }
  // claude pega o cwd do processo; não existe --cd.
  return `claude${flags}${mode === 'resume' ? '' : initialPromptArg(opts, shellQuote, isWinDeps(deps))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aider — OpenRouter
// ─────────────────────────────────────────────────────────────────────────────
function buildAider(opts = {}, deps = {}) {
  const shellQuote = deps.quote || platform.quote;
  const parts = [];
  if (opts.model) {
    const m = String(opts.model).includes('/') && !String(opts.model).startsWith('openrouter/')
      ? 'openrouter/' + opts.model
      : opts.model;
    parts.push(`--model ${shellQuote(m)}`);
  }
  // Histórico por thread. Os caminhos vêm de fora: este módulo não conhece disco.
  if (opts.chatHistoryFile && opts.inputHistoryFile) {
    parts.push(`--chat-history-file ${shellQuote(opts.chatHistoryFile)}`);
    parts.push(`--input-history-file ${shellQuote(opts.inputHistoryFile)}`);
    parts.push('--restore-chat-history');
  }
  parts.push('--no-auto-commits');
  parts.push('--no-show-model-warnings');
  parts.push('--no-show-release-notes');
  parts.push('--no-check-update');
  parts.push('--no-gitignore');
  parts.push(opts.fullAccess ? '--yes-always' : '--no-suggest-shell-commands');
  for (const file of opts.skillReadFiles || []) parts.push(`--read ${shellQuote(file)}`);
  return 'aider' + (parts.length ? ' ' + parts.join(' ') : '');
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode — multi-provider (fala com a assinatura SuperGrok por OAuth)
// Flags verificadas em opencode.ai/docs/cli (2026-07-09):
//   opencode [project]      sobe a TUI naquele diretório
//   -m/--model provider/model
//   -c/--continue           continua a última sessão
//   -s/--session <id>       continua uma sessão específica
// ─────────────────────────────────────────────────────────────────────────────
function buildOpenCode(opts = {}, deps = {}) {
  const shellQuote = deps.quote || platform.quote;
  const parts = [];
  if (opts.model) parts.push(`--model ${shellQuote(opts.model)}`);

  if (opts.mode === 'resume' && opts.sessionId) {
    const sid = String(opts.sessionId).trim();
    if (/^[A-Za-z0-9._-]+$/.test(sid)) parts.push(`--session ${shellQuote(sid)}`);
  }
  const flags = parts.length ? ' ' + parts.join(' ') : '';
  // O diretório é argumento POSICIONAL, não flag.
  return opts.cwd ? `opencode${flags} ${shellQuote(opts.cwd)}` : `opencode${flags}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grok Build — xAI
// Flags verificadas em docs.x.ai/build/cli/reference (2026-07-09):
//   --cwd <dir>   -m/--model   --effort   -r/--resume   --always-approve
// Modelos: grok-build-0.1 (coding), grok-4.5 (chat, 500k de contexto).
// ─────────────────────────────────────────────────────────────────────────────
function buildGrok(opts = {}, deps = {}) {
  const shellQuote = deps.quote || platform.quote;
  const parts = [];
  if (opts.model) parts.push(`--model ${shellQuote(opts.model)}`);
  if (opts.reasoningEffort) parts.push(`--effort ${shellQuote(opts.reasoningEffort)}`);
  if (opts.fullAccess) parts.push('--always-approve');
  if (opts.cwd) parts.push(`--cwd ${shellQuote(opts.cwd)}`);
  if (opts.skillsPrompt) parts.push(`--rules ${shellQuote(opts.skillsPrompt)}`);

  if (opts.mode === 'resume' && opts.sessionId) {
    const sid = String(opts.sessionId).trim();
    if (/^[A-Za-z0-9._-]+$/.test(sid)) parts.push(`--resume ${shellQuote(sid)}`);
  }
  return 'grok' + (parts.length ? ' ' + parts.join(' ') : '');
}

const BUILDERS = {
  codex: buildCodex,
  claude: buildClaude,
  aider: buildAider,
  opencode: buildOpenCode,
  grok: buildGrok,
};

/**
 * @param {string} agentId   id do registry (agents/registry.js)
 * @param {object} opts      { mode, model, cwd, sessionId, fullAccess, ... }
 * @param {object} deps      { log(tag, msg) }
 * @returns {string}         linha de comando pronta para o shell
 */
function buildCommand(agentId, opts = {}, deps = {}) {
  const builder = BUILDERS[agentId];
  if (!builder) throw new Error(`agents/commands: agente desconhecido "${agentId}"`);

  // O login é do REGISTRY, não do builder: cada CLI tem o seu, e nenhum aceita
  // as flags de sessão. Antes só o codex sabia fazer login, com a string
  // cravada dentro do buildCodex.
  if (opts.mode === 'login') {
    const spec = byId[agentId];
    if (!spec || !spec.login) {
      throw new Error(`agents/commands: "${agentId}" não tem fluxo de login`);
    }
    return spec.login;
  }

  return builder(opts, deps);
}

// ─────────────────────────────────────────────────────────────────────────────
// Modo CHAT (2026-10-11) — o pane desenha a conversa; a CLI fala protocolo.
// ─────────────────────────────────────────────────────────────────────────────

/** Agentes que abrem em chat. Os outros só têm TUI. */
const CHAT_AGENTS = new Set(['claude', 'codex']);

/**
 * Comando do modo chat. Mesmas escolhas do TUI (modelo, skills, bypass), menos
 * o que só existe na TUI: Remote Control e os hooks de som (no chat o fim de
 * turno vem do próprio protocolo). `exec` no POSIX: o kill do pane mata a CLI,
 * não só o shell que a chamou.
 */
function buildChatCommand(agentId, opts = {}, deps = {}) {
  const shellQuote = deps.quote || platform.quote;
  const exec = (deps.isWin != null ? deps.isWin : platform.isWin) ? '' : 'exec ';
  const { bin, toks } = chatTokens(agentId, opts);
  const str = toks.map(t => (typeof t === 'string' ? t : (t.pre || '') + shellQuote(t.v)));
  return `${exec}${bin} ${str.join(' ')}`;
}

/**
 * Mesmo comando do modo chat, como ARGV (sem shell, sem aspas) — é o que o
 * Windows usa para subir a CLI direto (platform.chatLaunch). Sai dos MESMOS
 * tokens do `buildChatCommand`: as duas formas não têm como divergir.
 * @returns {{bin:string, args:string[]}}
 */
function buildChatArgv(agentId, opts = {}) {
  const { bin, toks } = chatTokens(agentId, opts);
  const args = toks.flatMap(t => (typeof t === 'string' ? t.split(' ') : [(t.pre || '') + t.v]));
  return { bin, args };
}

/**
 * Tokens do modo chat. String = trecho literal (pode ter espaço = vários
 * argumentos); `{ pre, v }` = valor que precisa de aspas (`pre` fica colado,
 * fora delas: `-c model_reasoning_effort='high'`).
 */
function chatTokens(agentId, opts = {}) {
  if (agentId === 'claude') {
    const toks = ['-p', '--input-format stream-json', '--output-format stream-json',
      '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
      // Sobe em bypass, mas o seletor de acesso do composer pode trocar o modo
      // ao vivo (set_permission_mode); aí o claude pede permissão por aqui.
      '--permission-prompt-tool stdio'];
    const model = opts.model == null ? null : String(opts.model).trim();
    if (model && /^[\w.-]+(?:\[1m\])?$/.test(model)) toks.push('--model', { v: model });
    if (opts.skillsPrompt) {
      toks.push('--append-system-prompt', { v: opts.skillsPrompt });
      toks.push('--disallowedTools Skill');
    }
    const sid = opts.mode === 'resume' && opts.sessionId != null ? String(opts.sessionId).trim() : '';
    if (sid && /^[A-Za-z0-9._-]+$/.test(sid)) toks.push('--resume', { v: sid });
    return { bin: 'claude', toks };
  }
  if (agentId === 'codex') {
    const isOpenRouter = opts.authMode === 'openrouter';
    const toks = ['app-server'];
    if (opts.reasoningEffort && !isOpenRouter) toks.push('-c', { pre: 'model_reasoning_effort=', v: opts.reasoningEffort });
    if (!isOpenRouter) toks.push(`-c service_tier=${opts.fastMode ? 'fast' : 'default'}`);
    toks.push('-c check_for_update_on_startup=false');
    if (!isOpenRouter) toks.push('-c model_reasoning_summary=detailed');
    if (opts.webSearch && !isOpenRouter) toks.push('-c web_search=live');
    if (opts.skillsPrompt) toks.push('-c', { v: 'developer_instructions=' + JSON.stringify(opts.skillsPrompt) });
    if (opts.disabledSkillPaths?.length) {
      const entries = opts.disabledSkillPaths.map(p => `{path=${JSON.stringify(p)},enabled=false}`).join(',');
      toks.push('-c', { v: 'skills.config=[' + entries + ']' });
    }
    return { bin: 'codex', toks };
  }
  throw new Error(`agents/commands: "${agentId}" não tem modo chat`);
}

module.exports = { buildCommand, buildChatCommand, buildChatArgv, CHAT_AGENTS, shellQuote, BUILDERS, claudeHookSettings };
