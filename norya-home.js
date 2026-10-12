'use strict';

/**
 * norya-home.js — onde ficam os dados do Norya.
 *
 * UMA fonte da verdade, consumida pelo main, pelos testes e pelo shim `bin/norya`.
 * Antes, `path.join(REAL_HOME, '.codex-panel', …)` aparecia cravado 22 vezes.
 *
 * Resolução, nesta ordem:
 *   1. `$NORYA_HOME`, se definido (escape hatch, e o que os testes usam);
 *   2. `~/.norya`, se existir;
 *   3. `~/.codex-panel`, se existir (nome legado, pré-rebrand);
 *   4. `~/.norya` (primeira instalação).
 *
 * A migração de `~/.codex-panel` para `~/.norya` é feita por **rename + symlink**,
 * nunca por cópia: são ~3,7 GB, e há caminhos absolutos gravados DENTRO de
 * `accounts/N` (shell_snapshots, sessões .jsonl, logs de npm). O symlink deixa
 * esses caminhos continuarem resolvendo.
 *
 *   mv ~/.codex-panel ~/.norya && ln -s ~/.norya ~/.codex-panel
 *
 * Com o symlink no lugar, os dois caminhos existem — e por isso `.norya` vem
 * primeiro na lista: queremos o nome canônico, não o link.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const REAL_HOME = os.homedir();
const CANDIDATOS = [
  path.join(REAL_HOME, '.norya'),
  path.join(REAL_HOME, '.codex-panel'),
];

function resolverNoryaHome(env = process.env, existe = p => { try { return fs.existsSync(p); } catch { return false; } }) {
  if (env.NORYA_HOME) return env.NORYA_HOME;
  for (const c of CANDIDATOS) if (existe(c)) return c;
  return CANDIDATOS[0];
}

module.exports = {
  NORYA_HOME: resolverNoryaHome(),
  REAL_HOME,
  CANDIDATOS,
  resolverNoryaHome,   // exportado para teste
};
