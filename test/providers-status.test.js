#!/usr/bin/env node
/**
 * providersStatusFor: status de credencial por provider num perfil.
 * Fixtures sintéticas num tmpdir — nada toca ~/.norya real.
 * Uso: node test/providers-status.test.js → exit 0 = PASS
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { providersStatusFor } = require('../agents/providers');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-prov-'));

// Perfil vazio: nada conectado
let s = providersStatusFor(dir, {}, { has: false, meta: null });
assert.strictEqual(s.codex.connected, false);
assert.strictEqual(s.codex.via, null);
assert.strictEqual(s.claude.connected, false);
assert.strictEqual(s.grok.connected, false);
assert.strictEqual(s.opencode.connected, false);
assert.strictEqual(s.openrouter.configured, false);

// Codex via ChatGPT: auth.json presente
fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
fs.writeFileSync(path.join(dir, '.codex', 'auth.json'), '{}');
s = providersStatusFor(dir, {}, { has: false, meta: null });
assert.strictEqual(s.codex.connected, true);
assert.strictEqual(s.codex.via, 'chatgpt');

// Codex via API key (sem auth.json): perfil com apiKey
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-prov-'));
s = providersStatusFor(dir2, { apiKey: 'sk-x' }, { has: false, meta: null });
assert.strictEqual(s.codex.connected, true);
assert.strictEqual(s.codex.via, 'apikey');

// Claude: token isolado vence o keychain global
s = providersStatusFor(dir2, { claudeOauthToken: 'sk-ant-oat01-abc' }, { has: false, meta: null });
assert.strictEqual(s.claude.connected, true);
assert.strictEqual(s.claude.isolated, true);
assert.strictEqual(s.claude.expiresAt, null); // token longo: validade desconhecida

// Claude: keychain global compartilhado
s = providersStatusFor(dir2, {}, { has: true, meta: { expiresAt: 123, subscriptionType: 'max' } });
assert.strictEqual(s.claude.connected, true);
assert.strictEqual(s.claude.isolated, false);
assert.strictEqual(s.claude.expiresAt, 123);
assert.strictEqual(s.claude.subscription, 'max');

// Grok: diretório .grok com conteúdo
fs.mkdirSync(path.join(dir2, '.grok'));
s = providersStatusFor(dir2, {}, { has: false, meta: null });
assert.strictEqual(s.grok.connected, false); // dir vazio ≠ logado
fs.writeFileSync(path.join(dir2, '.grok', 'cred.json'), '{}');
s = providersStatusFor(dir2, {}, { has: false, meta: null });
assert.strictEqual(s.grok.connected, true);

// OpenCode: auth.json no XDG data dir
fs.mkdirSync(path.join(dir2, '.local', 'share', 'opencode'), { recursive: true });
fs.writeFileSync(path.join(dir2, '.local', 'share', 'opencode', 'auth.json'), '{}');
s = providersStatusFor(dir2, {}, { has: false, meta: null });
assert.strictEqual(s.opencode.connected, true);

// OpenRouter: chave + modelo do profile.json
s = providersStatusFor(dir2, { openrouterKey: 'sk-or-1', openrouterModel: 'x/y' }, { has: false, meta: null });
assert.strictEqual(s.openrouter.configured, true);
assert.strictEqual(s.openrouter.model, 'x/y');

console.log('TUDO PASSOU');

// ── quotaProvidersFor: quais providers o painel Uso mostra para um perfil ────
// Regra: o provider PADRÃO (authMode) sempre aparece (mesmo deslogado — o cartão
// diz "faça login"); os demais só com credencial PRÓPRIA do perfil. O Claude do
// Keychain é global e só entra no perfil cujo padrão é claude.
{
  const { quotaProvidersFor } = require('../agents/providers');
  const shared = { has: true, meta: { subscriptionType: 'max' } };
  const none = { has: false, meta: null };

  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-qp-'));
  // padrão claude via Keychain
  assert.deepStrictEqual(quotaProvidersFor({ authMode: 'claude' }, providersStatusFor(d, { authMode: 'claude' }, shared)), ['claude']);
  // padrão chatgpt, Keychain global presente → Claude NÃO repete aqui
  assert.deepStrictEqual(quotaProvidersFor({ authMode: 'chatgpt' }, providersStatusFor(d, { authMode: 'chatgpt' }, shared)), ['codex']);
  // padrão chatgpt deslogado (sem auth.json) → ainda lista codex
  assert.deepStrictEqual(quotaProvidersFor({ authMode: 'chatgpt' }, providersStatusFor(d, { authMode: 'chatgpt' }, none)), ['codex']);
  // padrão chatgpt + token Claude isolado → os dois
  const p2 = { authMode: 'chatgpt', claudeOauthToken: 'sk-ant-oat01-x' };
  assert.deepStrictEqual(quotaProvidersFor(p2, providersStatusFor(d, p2, none)), ['codex', 'claude']);
  // padrão grok + auth.json do codex no mesmo HOME → codex e grok
  fs.mkdirSync(path.join(d, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(d, '.codex', 'auth.json'), '{}');
  assert.deepStrictEqual(quotaProvidersFor({ authMode: 'grok' }, providersStatusFor(d, { authMode: 'grok' }, none)), ['codex', 'grok']);
  // nada configurado → nada a medir
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-qp-'));
  assert.deepStrictEqual(quotaProvidersFor({}, providersStatusFor(d3, {}, none)), []);
  // openrouter (pré-pago) e opencode não têm assinatura a medir
  assert.deepStrictEqual(quotaProvidersFor({ authMode: 'openrouter', openrouterKey: 'k' }, providersStatusFor(d3, { openrouterKey: 'k' }, none)), []);
  console.log('PASS  quotaProvidersFor');
}
