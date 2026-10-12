#!/usr/bin/env node
/**
 * Smoke do painel "Uso das assinaturas": seção por conta, cartão por provider.
 *
 * Instância ISOLADA (NORYA_HOME/USER_DATA próprios, socket com sufixo) — roda
 * com o Norya aberto. Sem rede: `api.quotaRefresh` é stub e os snapshots são
 * injetados em `st.quota` com a forma que quota/claude-http.js e
 * quota/codex-http.js produzem. O que se prova aqui é o RENDER e a política
 * de "reler ao abrir".
 *
 * Uso: node test/smoke-uso.js → exit 0 = PASS, 1 = FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-uso-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke-uso';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9225';
fs.mkdirSync(process.env.NORYA_HOME, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });

const { withApp } = require('./cdp-harness');

const SETUP = `
(async () => {
  const chamadas = [];
  api.quotaRefresh = async (num, provider) => { chamadas.push([num, provider || null]); return {}; };
  api.quotaRefreshAll = async () => ({ ok: true });
  st.accounts = [
    { num: 12, name: 'trabalho', color: '#00BCD4', authMode: 'chatgpt', quotaProviders: ['codex'] },
    { num: 14, name: 'pessoal', color: '#E74C3C', authMode: 'claude', quotaProviders: ['claude'], hasClaudeToken: false },
    { num: 15, name: 'dupla', color: '#8e44ad', authMode: 'chatgpt', quotaProviders: ['codex', 'claude'], hasClaudeToken: true },
    { num: 16, name: 'vazio', authMode: null, quotaProviders: [] },
  ];
  const now = Date.now();
  const w = (id, label, pct, ms, sev) => ({ id, label, used_percent: pct, percent_left: 100 - pct,
    resets_at: Math.floor(ms / 1000), resets_at_ms: ms, severity: sev || null });
  st.quota['12:codex'] = { provider: 'codex', cli: 'codex', source: 'app-server', plan: 'plus', planLabel: 'Plus',
    identity: 'conta@example.com', resetCredits: 3, credits: { hasCredits: false },
    windows: [w('session', 'Janela de 5h', 12, now + 3600e3), w('weekly', 'Semanal', 3, now + 6 * 86400e3)],
    updatedAt: now, readAt: now };
  st.quota['14:claude'] = { provider: 'claude', cli: 'claude', source: 'claude-http', plan: 'max', planLabel: 'Max 5x',
    identity: 'conta do Mac',
    windows: [w('session', 'Sessão (5h)', 5, now + 4 * 3600e3), w('weekly', 'Semana · todos os modelos', 17, now + 26 * 3600e3),
              w('weekly:Fable', 'Semana · Fable', 92, now + 26 * 3600e3, 'critical')],
    extraUsage: { enabled: true, used: 1250, limit: 5000, currency: 'USD', decimals: 2 },
    updatedAt: now, readAt: now };
  st.quota['15:codex'] = { provider: 'codex', cli: 'codex', source: 'app-server', loggedOut: true, errorKind: 'auth', updatedAt: now };
  // 15:claude sem snapshot → "ainda não lido" + relido ao abrir

  document.getElementById('railUso').click();
  await new Promise(r => setTimeout(r, 700));

  const lista = document.getElementById('usoList');
  const secoes = [...lista.querySelectorAll('.uso-account')];
  const out = {
    painelVisivel: !document.getElementById('panelUso').hidden,
    nomes: secoes.map(s => s.querySelector('.uso-account-name').textContent),
    cartoesPorSecao: secoes.map(s => s.querySelectorAll('.uso-card').length),
    titulos: [...lista.querySelectorAll('.uso-account .uso-card .uso-agent')].map(e => e.textContent),
    identidades: [...lista.querySelectorAll('.uso-card .uso-meta')].map(e => e.textContent),
    barras14: [...secoes[1].querySelectorAll('.uso-window-label')].map(e => e.textContent),
    classes14: [...secoes[1].querySelectorAll('.uso-bar > i')].map(e => e.className),
    resets: [...lista.querySelectorAll('.uso-window .uso-sub')].map(e => e.textContent),
    linhas: [...lista.querySelectorAll('.uso-line')].map(e => e.textContent),
    vazios: [...lista.querySelectorAll('.uso-empty')].map(e => e.textContent),
    ausentes: [...lista.querySelectorAll('.uso-card.is-missing .uso-agent')].map(e => e.textContent),
    alerta: !document.getElementById('railUsoDot').hidden,
    chamadasAoAbrir: chamadas.slice(),
  };
  // ↻ do cartão Codex do perfil trabalho → só aquele provider
  secoes[0].querySelector('.uso-card .uso-refresh').click();
  await new Promise(r => setTimeout(r, 100));
  out.chamadaCartao = chamadas[chamadas.length - 1];
  // ↻ da conta → todos os providers (provider null)
  secoes[2].querySelector('.uso-account-head .uso-refresh').click();
  await new Promise(r => setTimeout(r, 100));
  out.chamadaConta = chamadas[chamadas.length - 1];
  return out;
})()`;

(async () => {
  const falhas = [];
  const check = (nome, fn) => { try { fn(); console.log(`PASS  ${nome}`); } catch (e) { console.log(`FAIL  ${nome}\n      ${e.message}`); falhas.push(nome); } };

  const r = await withApp(async (c) => {
    const o = await c.evaluate(SETUP);
    check('painel Uso abre pelo rail', () => assert.strictEqual(o.painelVisivel, true));
    check('uma seção por conta com algo a medir (conta vazia some)', () =>
      assert.deepStrictEqual(o.nomes, ['trabalho', 'pessoal', 'dupla']));
    check('um cartão por provider da conta', () => assert.deepStrictEqual(o.cartoesPorSecao, [1, 1, 2]));
    check('título = provider · plano; identidade (e-mail/conta) em linha própria', () => {
      assert.deepStrictEqual(o.titulos, ['Codex · Plus', 'Claude · Max 5x', 'Codex', 'Claude']);
      assert.deepStrictEqual(o.identidades, ['conta@example.com', 'conta do Mac']);
    });
    check('Claude: 3 janelas com rótulo e percentual (sessão, semana, semana por modelo)', () =>
      assert.deepStrictEqual(o.barras14, ['Sessão (5h)5%', 'Semana · todos os modelos17%', 'Semana · Fable92%']));
    check('severidade da API pinta a barra (critical → danger)', () =>
      assert.deepStrictEqual(o.classes14, ['', '', 'danger']));
    check('reset exato em cada janela', () => {
      assert.ok(o.resets.length >= 5, `só ${o.resets.length} resets`);
      assert.ok(o.resets.every(t => /^reseta /.test(t)), o.resets.join(' | '));
    });
    check('extras: resets grátis do Codex e uso extra do Claude', () => {
      assert.ok(o.linhas.includes('3 resets grátis disponíveis (semanal + 5h)'), o.linhas.join(' | '));
      assert.ok(o.linhas.includes('Uso extra: USD 12.50 de USD 50.00 no mês'), o.linhas.join(' | '));
    });
    check('deslogado e não-lido são ditos, nunca 0%', () => {
      assert.ok(o.vazios.includes('Sessão expirada — faça login neste perfil.'), o.vazios.join(' | '));
      assert.ok(o.vazios.includes('Ainda não lido. Atualiza sozinho em instantes.'), o.vazios.join(' | '));
    });
    check('agente com assinatura e sem perfil aparece como ausente (Grok)', () =>
      assert.ok(o.ausentes.some(t => /Grok/.test(t)), o.ausentes.join(' | ')));
    check('ponto de alerta acende com janela ≥ 90%', () => assert.strictEqual(o.alerta, true));
    check('ao abrir, relê só o que falta/está velho (não o deslogado, não o fresco)', () =>
      assert.deepStrictEqual(o.chamadasAoAbrir, [[15, 'claude']]));
    check('↻ do cartão lê só aquele provider; ↻ da conta lê todos', () => {
      assert.deepStrictEqual(o.chamadaCartao, [12, 'codex']);
      assert.deepStrictEqual(o.chamadaConta, [15, null]);
    });
  }, { port: Number(process.env.NORYA_SMOKE_PORT) });

  check('sem exceção não capturada no renderer', () => assert.deepStrictEqual(r.exceptions, []));
  if (r.leaked.length) console.log(`AVISO  electrons órfãos: ${r.leaked.join(', ')}`);
  console.log(falhas.length ? `\nFAIL (${falhas.length})` : '\nTUDO PASSOU');
  process.exit(falhas.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
