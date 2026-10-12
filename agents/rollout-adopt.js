'use strict';

/**
 * agents/rollout-adopt.js — adotar uma task de outra conta.
 *
 * ## O problema
 *
 * A conta que roda uma task estoura a quota no meio do trabalho ("You've hit
 * your usage limit"). O usuário tem outra conta com quota sobrando e quer
 * CONTINUAR A MESMA conversa nela — não abrir uma sessão nova e recontar tudo.
 *
 * Trocar o dono em `thread-owners.json` não bastava: `codex resume <id>`
 * procura a sessão dentro do `$CODEX_HOME` do perfil, e cada perfil do Norya
 * tem o seu (`accounts/N/.codex`). Resumir na conta B uma sessão gravada na
 * conta A dava "No saved session found" — a task simplesmente não existe lá.
 *
 * ## O caminho, verificado no codex-cli 0.153.4
 *
 * O `codex migrate-rollouts` descobre rollouts pelo DIRETÓRIO `sessions/`, não
 * por um índice. Um `.jsonl` copiado para um `CODEX_HOME` virgem sai como
 * `"status": "eligible"`, e `--apply --thread <id>` o materializa na
 * `state_5.sqlite` daquele perfil, com título e cwd. Depois disso o
 * `codex resume <id>` funciona ali como se a sessão sempre tivesse sido dele.
 * `--thread` restringe a UM (medido: 2 elegíveis sem a flag, 1 com) — sem ela a
 * adoção migraria o histórico inteiro do perfil de brinde.
 *
 * O Claude no macOS é o caso fácil: ele roda com HOME real por causa do
 * Keychain, então todo perfil já enxerga `~/.claude/projects`. Adotar é só
 * trocar o dono. No Windows NÃO: cada perfil tem o seu USERPROFILE e o seu
 * `<perfil>\.claude` (platform.claudeCredStore === 'profile-file') — lá o
 * transcript precisa ser copiado para o perfil destino (`copy-claude`).
 *
 * PURO: só decide o plano. Quem copia arquivo e chama o codex é o main.js.
 */

// `sessions` entre separadores — `/` no POSIX, `\` (ou `/`) no Windows.
const SESSIONS_DIR = /[\\/]sessions[\\/]/;

/** Parte do caminho depois de `/sessions/` — o layout ano/mês/dia do codex. */
function sessionsRelPath(absPath) {
  if (!absPath) return null;
  const s = String(absPath);
  const m = SESSIONS_DIR.exec(s);
  if (!m) return null;
  const rel = s.slice(m.index + m[0].length);
  return rel || null;
}

/** O CODEX_HOME de um rollout: tudo antes de `/sessions/`. null se não houver. */
function codexHomeOf(absPath) {
  if (!absPath) return null;
  const m = SESSIONS_DIR.exec(String(absPath));
  return m ? String(absPath).slice(0, m.index) : null;
}

/** O rollout de um threadId: o id vai no NOME do arquivo, depois do timestamp. */
function findRollout(files, threadId) {
  if (!threadId) return null;
  const alvo = String(threadId).toLowerCase();
  const hit = (files || []).find(f => String(f.path).toLowerCase().includes(alvo));
  return hit ? hit.path : null;
}

/**
 * O que precisa acontecer para `toAccount` conseguir retomar esta task.
 *
 * @returns {{action:'none'|'copy-and-migrate'|'fail', reason?:string, relPath?:string}}
 */
function planAdoption({ provider, fromAccount, toAccount, rolloutPath, claudeSharedHome = true }) {
  if (toAccount == null) {
    return { action: 'fail', reason: 'Conta de destino não informada.' };
  }
  // Claude: HOME real compartilhado (Keychain), o resume atravessa contas.
  if (provider === 'claude' && claudeSharedHome) {
    return { action: 'none', reason: 'Claude compartilha o HOME real — o resume já enxerga a sessão.' };
  }
  // Claude com ~/.claude por perfil (Windows): copiar o transcript.
  if (provider === 'claude') {
    if (fromAccount != null && fromAccount === toAccount) {
      return { action: 'none', reason: 'A task já é desta conta.' };
    }
    return { action: 'copy-claude' };
  }
  if (provider !== 'codex') {
    return { action: 'fail', reason: `Sem caminho de adoção para ${provider}: a sessão não é um arquivo que dê para mover entre perfis.` };
  }
  if (fromAccount != null && fromAccount === toAccount) {
    return { action: 'none', reason: 'A task já é desta conta.' };
  }
  if (!rolloutPath) {
    return { action: 'fail', reason: 'Não encontrei o arquivo de sessão desta task no perfil de origem.' };
  }
  const relPath = sessionsRelPath(rolloutPath);
  if (!relPath) {
    return { action: 'fail', reason: `Arquivo de sessão fora de um diretório sessions/: ${rolloutPath}` };
  }
  return { action: 'copy-and-migrate', relPath };
}

/**
 * O INSERT que dá ao perfil destino a METADATA da thread.
 *
 * Descoberto rodando o codex de verdade: copiar o rollout basta apenas num
 * CODEX_HOME virgem. Num perfil que já tem thread-store — todo perfil real —
 * o `migrate-rollouts` recusa com `failure_reason: "missing_sqlite_metadata"`:
 * ele migra do formato legado para o paginado uma thread que a `state_5.sqlite`
 * do perfil JÁ conhece, e não inventa a linha a partir do arquivo.
 *
 * A linha é copiada da origem coluna a coluna, pela INTERSEÇÃO dos schemas: os
 * dois perfis podem estar em versões diferentes do codex, e uma coluna a mais
 * de um lado não pode derrubar a adoção. `rollout_path` é sempre reescrito para
 * o caminho no perfil destino — é por ele que o codex abre o arquivo.
 *
 * @param {object}   row       linha de `threads` lida da origem
 * @param {string[]} destCols  colunas que a tabela do destino tem
 * @param {string}   rolloutPath  caminho do rollout JÁ copiado para o destino
 */
function buildMetadataInsert(row, destCols, rolloutPath) {
  const disponiveis = new Set(destCols || []);
  const cols = Object.keys(row || {}).filter(c => disponiveis.has(c));
  if (!cols.includes('id')) {
    throw new Error('linha de origem sem a coluna id — nada a escrever');
  }
  const values = cols.map(c => (c === 'rollout_path' ? rolloutPath : row[c]));
  const sql = `INSERT OR REPLACE INTO threads (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return { sql, values, cols };
}

module.exports = { sessionsRelPath, codexHomeOf, findRollout, planAdoption, buildMetadataInsert };
