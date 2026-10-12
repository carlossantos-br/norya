'use strict';

/**
 * agents/providers.js — status de credencial POR PROVIDER dentro de um perfil.
 *
 * O modelo "1 authMode por perfil" morreu em 2026-07-10: o disco sempre
 * suportou credenciais convivendo (HOME=accounts/N isola tudo junto), só a UI
 * impunha exclusividade. Esta função lê o que EXISTE, sem inventar estado:
 * cada provider responde "estou conectado neste perfil?" a partir do
 * artefato real de credencial (ver agents/registry.js, campo `creds`).
 *
 * Node builtins apenas — sem novas dependências npm (quota/CONTRACT.md).
 */
const fs = require('fs');
const path = require('path');

function providersStatusFor(accountDir, profile, claudeGlobal) {
  profile = profile || {};

  // Codex: auth.json (login ChatGPT) OU apiKey no profile.json.
  const codexOauth = fs.existsSync(path.join(accountDir, '.codex', 'auth.json'));
  const codexVia = codexOauth ? 'chatgpt' : (profile.apiKey ? 'apikey' : null);

  // Claude: token isolado por perfil (setup-token) vence; senão, o OAuth do
  // Keychain — que é GLOBAL do usuário do Mac, compartilhado entre perfis.
  const claudeIsolated = !!profile.claudeOauthToken;
  const claudeShared = !!(claudeGlobal && claudeGlobal.has);
  const claudeMeta = (claudeGlobal && claudeGlobal.meta) || null;

  // Grok: `grok login` cria accounts/N/.grok com a credencial dentro.
  // Dir vazio não é login — o grok cria o dir só de rodar.
  let grokConnected = false;
  try {
    const g = path.join(accountDir, '.grok');
    grokConnected = fs.existsSync(g) && fs.readdirSync(g).length > 0;
  } catch {}

  return {
    codex: { connected: !!codexVia, via: codexVia },
    claude: {
      connected: claudeIsolated || claudeShared,
      isolated: claudeIsolated,
      // Validade só é conhecida no OAuth global; o token longo não expõe.
      expiresAt: (!claudeIsolated && claudeMeta && claudeMeta.expiresAt) || null,
      subscription: (claudeMeta && claudeMeta.subscriptionType) || null,
    },
    grok: { connected: grokConnected },
    opencode: {
      connected: fs.existsSync(path.join(accountDir, '.local', 'share', 'opencode', 'auth.json')),
    },
    openrouter: {
      configured: !!profile.openrouterKey,
      model: profile.openrouterModel || null,
    },
  };
}

module.exports = { providersStatusFor };

/**
 * Quais providers o painel "Uso das assinaturas" mostra para um perfil.
 *
 * Regra: o provider PADRÃO (`authMode`) sempre entra — mesmo deslogado, o cartão
 * precisa dizer "faça login". Os demais só com credencial PRÓPRIA do perfil
 * (`.codex/auth.json` ou apiKey, `claudeOauthToken`, `.grok` não-vazio).
 *
 * O OAuth do Claude no Keychain é GLOBAL do usuário do Mac: todo perfil o "vê".
 * Listá-lo em todos seria N cartões idênticos fingindo ser N contas. Ele só
 * entra no perfil cujo padrão é claude. OpenRouter (pré-pago) e OpenCode (usa a
 * assinatura de outro provider) não têm assinatura a medir.
 *
 * @param {object} profile  profile.json
 * @param {object} status   providersStatusFor(...)
 * @returns {Array<'codex'|'claude'|'grok'>} ordem fixa de exibição
 */
function quotaProvidersFor(profile, status) {
  profile = profile || {};
  status = status || {};
  const { agentForAuthMode } = require('./registry');
  const padrao = agentForAuthMode(profile.authMode);
  const padraoId = padrao && padrao.quota ? padrao.id : null;
  const propria = {
    codex: !!(status.codex && status.codex.connected),
    claude: !!(status.claude && status.claude.isolated),
    grok: !!(status.grok && status.grok.connected),
  };
  return ['codex', 'claude', 'grok'].filter(id => id === padraoId || propria[id]);
}

module.exports.quotaProvidersFor = quotaProvidersFor;
