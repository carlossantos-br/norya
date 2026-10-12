'use strict';
/**
 * test/win-argv-sim.js — o caminho que um argumento percorre no Windows, para
 * os testes provarem do Mac o que a CLI RECEBE:
 *
 *   1. o PowerShell lê o comando (palavras soltas e literais '...' colados,
 *      `''` = aspa simples);
 *   2. em modo Legacy (o que o Norya fixa — platform.PS_NATIVE_LEGACY, e o
 *      único que o 5.1 conhece) ele monta a linha do processo envolvendo em
 *      aspas duplas só o argumento que tem espaço, sem escapar nada;
 *   3. o programa (node, claude.exe, codex) parte a linha pelas regras do
 *      CommandLineToArgvW.
 *
 * Não é o PowerShell inteiro: cobre a gramática que agents/commands.js emite.
 */
const assert = require('assert');

/** Lê um literal de aspas simples do PowerShell ('' = '). */
function pwshLiteral(lit) {
  assert.ok(lit.startsWith("'") && lit.endsWith("'"), `não é literal: ${lit}`);
  return lit.slice(1, -1).replace(/''/g, "'");
}

/** PowerShell (Legacy, = 5.1): envolve em aspas se há espaço fora de aspas não-escapadas. */
function legacyArg(s) {
  let precisa = false, aspas = 0, aposBarra = false;
  for (const ch of s) {
    if (ch === '"' && !aposBarra) aspas++;
    else if (/\s/.test(ch) && aspas % 2 === 0) precisa = true;
    aposBarra = ch === '\\';
  }
  return precisa ? `"${s}"` : s;
}

/** CommandLineToArgvW / MSVCRT. */
function argvDe(linha) {
  const out = [];
  let i = 0;
  while (i < linha.length) {
    while (linha[i] === ' ' || linha[i] === '\t') i++;
    if (i >= linha.length) break;
    let arg = '', dentro = false;
    for (; i < linha.length; i++) {
      const c = linha[i];
      if (c === '\\') {
        let k = 0; while (linha[i] === '\\') { k++; i++; }
        if (linha[i] === '"') { arg += '\\'.repeat(k >> 1); if (k & 1) { arg += '"'; continue; } i--; continue; }
        arg += '\\'.repeat(k); i--; continue;
      }
      if (c === '"') { dentro = !dentro; continue; }
      if (!dentro && (c === ' ' || c === '\t')) break;
      arg += c;
    }
    out.push(arg);
  }
  return out;
}

/** O que o programa nativo recebe de um `platform.quote(s)` passado pelo PowerShell. */
const recebido = q => argvDe(legacyArg(pwshLiteral(q)));

/** Palavras de um comando do PowerShell como o Norya monta (soltas + 'literais' colados). */
function pwshWords(cmd) {
  const out = [];
  let cur = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === ' ') { if (cur !== null) out.push(cur); cur = null; continue; }
    if (c === "'") {
      let j = i + 1, lit = '';
      for (;;) {
        assert.ok(j < cmd.length, `literal sem fechar em: ${cmd}`);
        if (cmd[j] === "'" && cmd[j + 1] === "'") { lit += "'"; j += 2; continue; }
        if (cmd[j] === "'") break;
        lit += cmd[j++];
      }
      cur = (cur || '') + lit; i = j; continue;
    }
    assert.ok(c !== '"' && c !== '$' && c !== '`', `caractere que o PowerShell interpretaria fora de aspas: ${c} em ${cmd}`);
    cur = (cur || '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** argv que o programa recebe de uma linha `prog arg1 arg2…` emitida para o PowerShell. */
function nativeArgv(cmd) {
  const [prog, ...words] = pwshWords(cmd);
  return { prog, argv: argvDe(words.map(legacyArg).join(' ')) };
}

module.exports = { pwshLiteral, legacyArg, argvDe, recebido, pwshWords, nativeArgv };
