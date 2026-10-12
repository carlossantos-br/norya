'use strict';

/**
 * renderer/latch-filter.js — quem pode ser a thread de um spawn recém-criado.
 *
 * ## O bug que este módulo existe para impedir
 *
 * Uma task nova nasce com um id provisório (`new-…`): a CLI só grava a sessão
 * de verdade depois do primeiro turno. O "latch" é o poll que troca o id
 * provisório pelo real, escolhendo entre as threads que apareceram DEPOIS do
 * spawn. O filtro antigo era:
 *
 *     t.accountNum === accNum || t.accountNum == null
 *
 * O `|| null` existia por um motivo legítimo: toda thread do Claude tem
 * `accountNum: null` (o `claude` roda com HOME real por causa do Keychain, ver
 * decisão 2026-06-14), então sem ele o pane de Claude ficava "(new thread)"
 * para sempre. Só que ele valia para QUALQUER spawn — inclusive um de Codex.
 *
 * Resultado (print do Carlos, 2026-09-09): basta uma sessão de Claude Code
 * aparecer em `~/.claude/projects` na janela entre o spawn e o poll — e ela
 * aparece o tempo todo, porque OUTROS panes estão rodando — para o spawn de
 * Codex reivindicá-la. O pane passa a exibir "(claude session)" sobre uma TUI
 * de `gpt-6-astra`, a linha da sidebar diz "Claude", e a fila "Needs attention"
 * (que rotula por `st.allThreads[threadId]`) passa a mostrar o nome errado.
 *
 * A correção é filtrar por PROVIDER, não por conta: um spawn de `codex` só pode
 * latchar numa thread de Codex. O `|| null` continua, agora inofensivo — a
 * única família de threads com conta nula é a do Claude, e ela só é alcançável
 * por um spawn de Claude.
 *
 * PURO e UMD (como `renderer/term-replay.js`): dá `module.exports` no teste e
 * `window.NoryaLatchFilter` no renderer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NoryaLatchFilter = api;
})(typeof window !== 'undefined' ? window : null, function () {

  /**
   * Providers que uma thread pode declarar. É a mesma lista de ids do
   * `agents/registry.js` — o id do agente É o nome do provider. Manter a lista
   * aqui em vez de importar o registry é o que mantém o módulo puro (o registry
   * puxa `platform.js`, que olha `process.platform`).
   */
  const PROVIDERS = ['codex', 'claude', 'aider', 'grok', 'opencode'];

  /**
   * Provider da CLI que um spawn está rodando. `null` quando o chamador não
   * sabe (agente "Automático" antes do main resolver): nesse caso o filtro de
   * provider é DESLIGADO, preservando o comportamento antigo em vez de nunca
   * latchar.
   */
  function providerOfAgent(agentId) {
    return PROVIDERS.includes(agentId) ? agentId : null;
  }

  /**
   * Provider de uma linha de thread. O `list-threads` carimba `provider` em
   * todos os caminhos (sqlite, rollout, aider, claude) desde 2026-06-13; o
   * fallback cobre só cache antigo em memória, onde tudo era Codex.
   */
  function providerOfThread(thread) {
    const p = thread && thread.provider;
    return PROVIDERS.includes(p) ? p : 'codex';
  }

  /**
   * Candidatos ao latch, do mais provável ao menos.
   *
   * @param {object}  o
   * @param {Array}   o.threads     `st.allThreads` (+ provisórias)
   * @param {Set}     o.beforeIds   ids que JÁ existiam no instante do spawn
   * @param {Set}     o.claimedIds  ids já reivindicados por outro spawn em voo
   * @param {number}  o.accNum      conta do spawn
   * @param {?string} o.cwd         pasta do spawn (desempata criações paralelas)
   * @param {?string} o.provider    provider do spawn; `null` desliga o filtro
   */
  function latchCandidates(o) {
    const { threads, beforeIds, claimedIds, accNum, cwd, provider } = o;
    const novas = (threads || []).filter(t =>
         !beforeIds.has(t.id)
      && !claimedIds.has(t.id)
      && (t.accountNum === accNum || t.accountNum == null)
      && (!provider || providerOfThread(t) === provider));
    // Preferência por cwd: dois panes criando task ao mesmo tempo veem as
    // MESMAS linhas novas; a pasta é o que os separa.
    const doCwd = cwd ? novas.filter(t => t.cwd === cwd) : [];
    const pool = doCwd.length ? doCwd : novas;
    return pool.slice().sort((a, b) => (b.updated_at_ms || 0) - (a.updated_at_ms || 0));
  }

  return { PROVIDERS, providerOfAgent, providerOfThread, latchCandidates };
});
