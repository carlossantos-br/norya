#!/usr/bin/env node
/**
 * Guarda: todo botão de login de uma LINHA DE PROVIDER fixa o seu `agentId`.
 *
 * O bug que este teste prende (2026-09-08): os botões de login não passavam
 * agentId, e `launchTerminal` (renderer/threads.js) resolve por precedência —
 * `opts.agentId || threadAgents || st.selectedAgentId || authMode do perfil`.
 * Resultado: num perfil Claude (authMode 'claude'), clicar em "Fazer
 * login ChatGPT" na linha do Codex rodava `claude setup-token`. O auth.json do
 * Codex nunca nascia naquele perfil, e por isso o cartão de Uso do Codex nunca
 * aparecia lá — o sintoma que o Carlos relatou.
 *
 * Pior: com o seletor de agente mexido, o MESMO botão fazia coisas diferentes.
 *
 * Uso: node test/login-agent-id.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'profiles.js'), 'utf8');
let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

/** Extrai cada chamada launchTerminal(...) com o corpo dos argumentos. */
function chamadas() {
  const out = [];
  const marca = 'launchTerminal(';
  let i = SRC.indexOf(marca);
  while (i >= 0) {
    let prof = 0, j = i + marca.length - 1;
    do {
      if (SRC[j] === '(') prof++;
      else if (SRC[j] === ')') prof--;
      j++;
    } while (prof > 0 && j < SRC.length);
    out.push({ idx: i, texto: SRC.slice(i, j) });
    i = SRC.indexOf(marca, j);
  }
  return out;
}

const todas = chamadas();

t('profiles.js tem chamadas de launchTerminal para analisar', () => {
  assert.ok(todas.length >= 3, `esperava >=3, achei ${todas.length}`);
});

/** Tira comentários: um `// ...agentId...` explicativo NÃO satisfaz a regra. */
function semComentarios(txt) {
  return txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

t('TODA chamada de launchTerminal em profiles.js fixa agentId de VERDADE', () => {
  // `agentId:` como propriedade, ou `agentId` passado como identificador solto
  // (o repasse de loginDoAgente) — nunca a palavra dentro de um comentário.
  const sem = todas.filter(c => !/\bagentId\s*[:,}]/.test(semComentarios(c.texto)));
  assert.deepStrictEqual(sem.map(c => c.texto.replace(/\s+/g, ' ').slice(0, 90)), [],
    'chamada sem agentId — cairia no seletor/authMode e logaria a CLI errada');
});

t('a linha do Codex fixa agentId: \'codex\' literal', () => {
  assert.ok(/agentId:\s*'codex'/.test(SRC), "faltou agentId: 'codex' em buildCodexDetail");
});

t('a linha do Claude fixa agentId: \'claude\' literal', () => {
  assert.ok(/agentId:\s*'claude'/.test(SRC), "faltou agentId: 'claude' em buildClaudeDetail");
});

t('loginDoAgente recebe agentId como parâmetro e repassa', () => {
  assert.ok(/function loginDoAgente\(acc, rotulo, dica, agentId\)/.test(SRC),
    'assinatura de loginDoAgente sem agentId');
  assert.ok(/mode: 'login', profileNum: acc\.num, agentId/.test(SRC),
    'loginDoAgente não repassa o agentId pro spawn');
});

t('Grok e OpenCode passam os seus agentIds', () => {
  assert.ok(/'grok'\)\)/.test(SRC), 'buildGrokDetail não passa \'grok\'');
  assert.ok(/'opencode'\)\)/.test(SRC), 'buildOpencodeDetail não passa \'opencode\'');
});

t('os agentIds usados existem no registry', () => {
  const { byId } = require('../agents/registry');
  for (const m of SRC.matchAll(/agentId:\s*'([\w-]+)'/g)) {
    assert.ok(byId[m[1]], `agentId '${m[1]}' não existe no registry`);
  }
  for (const id of ['grok', 'opencode']) assert.ok(byId[id], `${id} sumiu do registry`);
});

t('todo agente usado num botão de login TEM fluxo de login no registry', () => {
  const { byId } = require('../agents/registry');
  // O Claude do buildClaudeDetail é mode:'default' + "/login" na TUI, não
  // mode:'login' — por isso a checagem é só dos que usam mode:'login'.
  for (const id of ['codex', 'grok', 'opencode']) {
    assert.ok(byId[id] && byId[id].login, `${id} não tem spec.login — o spawn lançaria`);
  }
});

console.log(`\nTUDO PASSOU (${n}/${n})`);
