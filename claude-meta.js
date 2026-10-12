/**
 * claude-meta.js — scanner puro de rollouts do Claude Code (~/.claude/projects).
 *
 * Extraído de main.js em 2026-07-22 para ser testável sem Electron
 * (test/claude-meta.test.js). Só builtins Node. Consumido pelo main
 * (list-threads) e, defensivamente, pelo renderer (cleanThreadTitle).
 *
 * Por que existe: o título de uma thread na sidebar vem daqui. O scanner
 * antigo congelava os primeiros 80 chars da 1ª linha `user` — que em sessão
 * iniciada por comando local é só o bloco <local-command-caveat>, e em prompt
 * com imagem é um ARRAY que nem era parseado. Resultado: "Session · hh:mm".
 */
'use strict';

const fs = require('fs');

// Remove os wrappers de harness (caveat/comando local) e marcadores de imagem
// que o Claude Code injeta na mensagem do usuário. O que sobrar é o texto que
// o usuário realmente digitou; vazio ⇒ a linha era só wrapper.
function cleanUserText(s) {
  if (!s) return '';
  let out = String(s)
    // Blocos pareados de wrapper
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, ' ')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, ' ')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, ' ');
  // Abertura sem fechamento (a janela de leitura pode truncar o bloco no meio):
  // do tag em diante é conteúdo de wrapper, não do usuário.
  out = out.replace(/<(?:local-command-[a-z-]+|command-(?:name|message|args))>[\s\S]*$/i, ' ');
  // Tags soltas que escaparam dos casos acima
  out = out.replace(/<\/?(?:local-command-[a-z-]*|command-name|command-message|command-args)>/gi, ' ');
  // Marcadores de imagem do harness ("[Image #1] …", "[Image: source: /path]")
  out = out.replace(/\[Image #\d+\]/gi, ' ');
  out = out.replace(/\[Image: source: [^\]]*\]/gi, ' ');
  // Linha "Caveat:" sem tags (formato antigo)
  out = out.replace(/^\s*Caveat:\s.*$/im, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

// Texto de usuário de uma linha do rollout, já limpo. '' quando a linha não
// tem texto aproveitável (wrapper puro, tool_result, attachment…).
function _userTextFromRow(row) {
  let txt = null;
  if (row.content && typeof row.content === 'string') txt = row.content;
  else if (row.message && row.message.role === 'user') {
    const c = row.message.content;
    if (typeof c === 'string') txt = c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') { txt = b.text; break; }
        if (typeof b === 'string') { txt = b; break; }
      }
    }
  }
  if (!txt || txt.startsWith('<environment_context>')) return '';
  return cleanUserText(txt);
}

// Scan the first `bytes` of a Claude rollout for cwd / ai-title / first REAL
// user message / lastPrompt / sidechain / entrypoint. `entrypoint` is the key
// signal: "cli" = the user's interactive terminal session (what /resume
// lists), "sdk-*" = non-interactive tooling (code review, compaction,
// /remember handoffs, …) which the caller hides. It's stamped on every row
// (incl. early attachment rows) so we detect it cheaply and stop before
// chasing a deep ai-title.
//
// Título no caller: aiTitle > firstMsg > lastPrompt.
//
// `opts.keepSdk`: sessão aberta em chat no Norya (`claude -p`, entrypoint
// sdk-cli) é do usuário — não para no 1º sinal de sdk.
function scanClaudeRollout(filePath, bytes, opts) {
  const keepSdk = !!(opts && opts.keepSdk);
  let cwd = '', aiTitle = '', firstMsg = '', lastPrompt = '',
      isSidechain = false, gotUser = false, gotSide = false, entrypoint = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    const lines = buf.toString('utf8', 0, n).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (!cwd && row.cwd) cwd = row.cwd;
      if (!entrypoint && typeof row.entrypoint === 'string') entrypoint = row.entrypoint;
      if (!gotSide && typeof row.isSidechain === 'boolean') { gotSide = true; isSidechain = row.isSidechain; }
      if (row.type === 'user') gotUser = true;
      if (!aiTitle && row.type === 'ai-title' && row.aiTitle) aiTitle = String(row.aiTitle).slice(0, 80);
      // last-prompt é reescrito ao longo da sessão — a ocorrência mais recente
      // na janela ganha. Serve de fallback quando nenhum user row tem texto.
      if (row.type === 'last-prompt' && typeof row.lastPrompt === 'string') {
        const lp = cleanUserText(row.lastPrompt);
        if (lp) lastPrompt = lp.slice(0, 80);
      }
      if (!firstMsg) {
        const txt = _userTextFromRow(row);
        if (txt) firstMsg = txt.slice(0, 80);
      }
      // SDK / sidechain = hidden tooling — once we know that, stop (no point
      // reading megabytes for an ai-title we'll never show).
      if ((/^sdk/.test(entrypoint) && !keepSdk) || isSidechain) break;
      if (keepSdk && cwd && firstMsg && gotUser && (aiTitle || /^sdk/.test(entrypoint))) break;
      if (cwd && aiTitle && gotUser) break;
    }
  } catch {}
  return { cwd, aiTitle, firstMsg, lastPrompt, isSidechain, gotUser, entrypoint };
}

module.exports = { scanClaudeRollout, cleanUserText };
